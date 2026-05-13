import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Orgo API base URL (matches OrgoHTTPClient.swift defaultBaseURL)
// ---------------------------------------------------------------------------
const ORGO_API_BASE = 'https://www.orgo.ai/api';
const INSTALL_SCRIPT_RELATIVE_PATH = 'scripts/install-cortextos-on-orgo.sh';

export function resolveInstallScriptPath(baseDir = __dirname, cwd = process.cwd()): string {
  const candidates = [
    // Built CLI: dist/cli.js -> repo root is one level up.
    join(baseDir, '..', INSTALL_SCRIPT_RELATIVE_PATH),
    // Source/test runtime: src/cli/provision-orgo.ts -> repo root is two levels up.
    join(baseDir, '..', '..', INSTALL_SCRIPT_RELATIVE_PATH),
    // Last resort for local development when the CLI is launched from repo root.
    join(cwd, INSTALL_SCRIPT_RELATIVE_PATH),
  ];

  const installScriptPath = candidates.find(candidate => existsSync(candidate));
  if (!installScriptPath) {
    throw new Error(
      `Cannot read install script. Tried: ${candidates.join(', ')}. Ensure ${INSTALL_SCRIPT_RELATIVE_PATH} is present.`
    );
  }
  return installScriptPath;
}

// ---------------------------------------------------------------------------
// Wire types (mirror OrgoCatalogService.swift + OrgoHermesInstaller.swift)
// ---------------------------------------------------------------------------

interface OrgoProject {
  id: string;
  name: string;
  desktops?: Array<{ id: string; name?: string; status?: string }>;
}

interface ProjectsListResponse {
  projects: OrgoProject[];
}

interface CreateComputerResponse {
  id: string;
  name?: string;
  status?: string;
}

interface ExecResponse {
  success: boolean;
  output: string;
}

interface InstallScriptResponse {
  exit_code: number;
  stdout_tail: string;
  stderr_tail: string;
}

// ---------------------------------------------------------------------------
// Orgo HTTP helpers
// ---------------------------------------------------------------------------

async function orgoGet<T>(path: string, apiKey: string): Promise<T> {
  const res = await fetch(`${ORGO_API_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Orgo GET /${path} failed: HTTP ${res.status} — ${body}`);
  }
  return res.json() as Promise<T>;
}

async function orgoPost<T>(
  path: string,
  apiKey: string,
  body: unknown,
  timeoutMs = 30_000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${ORGO_API_BASE}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Orgo POST /${path} failed: HTTP ${res.status} — ${errBody}`);
    }
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Resolve workspace ID: accepts workspace name or ID
// ---------------------------------------------------------------------------

async function resolveWorkspace(
  workspaceArg: string,
  apiKey: string
): Promise<{ id: string; name: string }> {
  const data = await orgoGet<ProjectsListResponse>('projects', apiKey);
  const projects = data.projects ?? [];

  // Exact ID match first, then name match (case-insensitive)
  const match =
    projects.find(p => p.id === workspaceArg) ??
    projects.find(p => p.name.toLowerCase() === workspaceArg.toLowerCase());

  if (!match) {
    const names = projects.map(p => `${p.name} (${p.id})`).join(', ');
    throw new Error(
      `Workspace '${workspaceArg}' not found. Available: ${names || '(none)'}`
    );
  }
  return { id: match.id, name: match.name };
}

// ---------------------------------------------------------------------------
// Create a new Orgo computer
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Free-tier limits (Orgo documented maximums)
// ---------------------------------------------------------------------------

const FREE_TIER_MAX_RAM_GB = 4;
const FREE_TIER_MAX_CPU = 1;
const FREE_TIER_MAX_DISK_GB = 50;

function assertFreeTierLimits(ram: number, cpu: number, disk: number): void {
  const errors: string[] = [];
  if (ram > FREE_TIER_MAX_RAM_GB)
    errors.push(`--ram ${ram} exceeds free-tier max ${FREE_TIER_MAX_RAM_GB} GB`);
  if (cpu > FREE_TIER_MAX_CPU)
    errors.push(`--cpu ${cpu} exceeds free-tier max ${FREE_TIER_MAX_CPU} core(s)`);
  if (disk > FREE_TIER_MAX_DISK_GB)
    errors.push(`--disk ${disk} exceeds free-tier max ${FREE_TIER_MAX_DISK_GB} GB`);
  if (errors.length > 0) {
    console.error('Error: free-tier limit exceeded:');
    errors.forEach(e => console.error(`  ${e}`));
    console.error('Use a paid Orgo plan or lower the values.');
    process.exit(1);
  }
}

async function createComputer(
  workspaceId: string,
  computerName: string,
  apiKey: string,
  ram = 4,
  cpu = 1,
  disk = 50
): Promise<{ id: string; name: string; status: string }> {
  const response = await orgoPost<CreateComputerResponse>(
    'computers',
    apiKey,
    {
      workspace_id: workspaceId,
      name: computerName,
      os: 'linux',
      ram,
      cpu,
      gpu: 'none',
      disk_size_gb: disk,
      resolution: '1280x720x24',
    },
    90_000
  );
  return {
    id: response.id,
    name: response.name ?? computerName,
    status: response.status ?? 'creating',
  };
}

// ---------------------------------------------------------------------------
// Build the Python exec wrapper that runs install-cortextos-on-orgo.sh
// Both the bash source and the agent-name arg are base64-encoded so no
// quoting or escaping can break the generated Python string literal.
// Mirrors the OrgoHermesInstaller pattern exactly.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Run the installer on the target computer via /exec
// Orgo /exec has a hard ~30s HTTP timeout; the installer takes 2-4 minutes.
// We launch it in background and poll every 15s until it exits (max 300s).
// ---------------------------------------------------------------------------

async function runInstaller(
  computerId: string,
  agentName: string,
  apiKey: string
): Promise<InstallScriptResponse> {
  // Load the install script bundled alongside this CLI
  const installShPath = resolveInstallScriptPath();
  let installShSource: string;
  try {
    installShSource = readFileSync(installShPath, 'utf-8');
  } catch {
    throw new Error(
      `Cannot read install script at ${installShPath}. Ensure scripts/install-cortextos-on-orgo.sh is present.`
    );
  }

  // Resolve GH_TOKEN and GitHub release asset ID so the installer can download the tarball.
  const ghToken = process.env['GH_TOKEN'] ?? '';
  let assetId = '';
  if (ghToken) {
    try {
      const releaseRes = await fetch(
        'https://api.github.com/repos/RevOps-Global-GIT/cortextos/releases/tags/v0.1.1',
        { headers: { Authorization: `token ${ghToken}`, Accept: 'application/vnd.github+json' } }
      );
      if (releaseRes.ok) {
        const releaseData = await releaseRes.json() as { assets?: Array<{ id: number; name: string }> };
        const asset = (releaseData.assets ?? []).find(a => a.name.endsWith('.tgz'));
        if (asset) {
          assetId = String(asset.id);
          console.log(`  GitHub release asset: ${asset.name} (id: ${assetId})`);
        }
      }
    } catch { /* non-fatal — installer will fail if asset not found */ }
  }

  // Orgo /exec has a hard ~30s HTTP timeout, but the installer takes 2-4 minutes.
  // Strategy: launch installer in background (writes to /tmp/ctx-install.log),
  // then poll every 15s until process exits or 300s elapses.
  const pollCodeTemplate = `
import json, os, subprocess

pid = $PID$
try:
    os.kill(pid, 0)
    still_running = True
except ProcessLookupError:
    still_running = False

try:
    log = open("/tmp/ctx-install.log").read()
except Exception:
    log = ""

exit_code = -99
if not still_running:
    # Read exit code from sentinel file
    try:
        exit_code = int(open("/tmp/ctx-install.exit").read().strip())
    except Exception:
        exit_code = -1 if "install complete" not in log.lower() else 0

print(json.dumps({"still_running": still_running, "exit_code": exit_code, "log_tail": log[-4000:]}))
`.trim();

  // Step 1: launch the installer as a background process
  const launchPythonCode = `
import base64, json, os, subprocess

bash_cmd = base64.b64decode("${Buffer.from(installShSource, 'utf-8').toString('base64')}").decode("utf-8")
agent_name = base64.b64decode("${Buffer.from(agentName, 'utf-8').toString('base64')}").decode("utf-8")

proc = subprocess.Popen(
    ["bash", "-c", bash_cmd, "--", agent_name],
    stdout=open("/tmp/ctx-install.log", "w"),
    stderr=subprocess.STDOUT,
    env={**os.environ, "DEBIAN_FRONTEND": "noninteractive", "GH_TOKEN": "${ghToken}", "CORTEXTOS_ASSET_ID": "${assetId}"},
)

# Write PID for polling
with open("/tmp/ctx-install.pid", "w") as f:
    f.write(str(proc.pid))

print(json.dumps({"pid": proc.pid, "status": "launched"}))
`.trim();

  const launchResp = await orgoPost<ExecResponse>(
    `computers/${computerId}/exec`,
    apiKey,
    { code: launchPythonCode, timeout: 20 },
    30_000
  );
  if (!launchResp.success) {
    throw new Error(`Installer launch failed: ${launchResp.output}`);
  }
  const launchOut = JSON.parse(launchResp.output?.trim() ?? '{}') as { pid?: number; status?: string };
  const pid = launchOut.pid;
  if (!pid) throw new Error(`Installer did not return a PID: ${launchResp.output}`);
  console.log(`  Installer launched (PID ${pid}) — polling every 15s (max 300s)...`);

  // Step 2: poll until process exits or timeout
  const maxWaitMs = 300_000;
  const pollIntervalMs = 15_000;
  const pollStart = Date.now();

  const pollCode = pollCodeTemplate.replace('$PID$', String(pid));

  let lastLog = '';
  while (Date.now() - pollStart < maxWaitMs) {
    await new Promise(r => setTimeout(r, pollIntervalMs));
    const elapsed = Math.round((Date.now() - pollStart) / 1000);

    let pollResp: ExecResponse;
    try {
      pollResp = await orgoPost<ExecResponse>(
        `computers/${computerId}/exec`,
        apiKey,
        { code: pollCode, timeout: 20 },
        30_000
      );
    } catch {
      console.log(`  [${elapsed}s] Poll exec failed — retrying...`);
      continue;
    }

    const pollOut = JSON.parse(pollResp.output?.trim() ?? '{}') as {
      still_running?: boolean; exit_code?: number; log_tail?: string;
    };
    lastLog = pollOut.log_tail ?? '';
    const lines = lastLog.split('\n');
    const lastLine = lines.filter(l => l.trim()).slice(-1)[0] ?? '';
    console.log(`  [${elapsed}s] running=${pollOut.still_running}  last: ${lastLine.slice(0, 80)}`);

    if (!pollOut.still_running) {
      const exitCode = pollOut.exit_code ?? -1;
      return {
        exit_code: exitCode,
        stdout_tail: lastLog,
        stderr_tail: '',
      };
    }
  }

  throw new Error(`Installer timed out after ${maxWaitMs / 1000}s. Last log:\n${lastLog.slice(-500)}`);
}

// ---------------------------------------------------------------------------
// CLI command
// ---------------------------------------------------------------------------

export const provisionOrgoCommand = new Command('provision-orgo')
  .description('Provision a cortextos agent on an Orgo VM')
  .requiredOption('--api-key <key>', 'Orgo API key (or set ORGO_API_KEY env var)')
  .option('--workspace <id-or-name>', 'Orgo workspace ID or name')
  .option('--computer <id>', 'Existing Orgo computer ID to provision onto')
  .option('--create [name]', 'Create a new Orgo computer (optionally named)')
  .option('--agent-name <name>', 'Name for the cortextos agent on the VM', 'cortextos-agent')
  .option('--ram <gb>', 'RAM in GB for new computer (default: 4, free tier max: 4)', parseInt)
  .option('--cpu <cores>', 'CPU cores for new computer (default: 1, free tier max: 1)', parseInt)
  .option('--disk <gb>', 'Disk size in GB for new computer (default: 50, free tier max: 50)', parseInt)
  .action(
    async (options: {
      apiKey: string;
      workspace?: string;
      computer?: string;
      create?: boolean | string;
      agentName: string;
      ram?: number;
      cpu?: number;
      disk?: number;
    }) => {
      const apiKey = options.apiKey || process.env['ORGO_API_KEY'] || '';
      if (!apiKey) {
        console.error('Error: --api-key or ORGO_API_KEY is required');
        process.exit(1);
      }

      const creating = options.create !== undefined;
      if (!options.computer && !creating) {
        console.error('Error: provide either --computer <id> or --create [name]');
        process.exit(1);
      }
      if (options.computer && creating) {
        console.error('Error: --computer and --create are mutually exclusive');
        process.exit(1);
      }
      if (creating && !options.workspace) {
        console.error('Error: --workspace is required when using --create');
        process.exit(1);
      }

      let computerId: string;
      let computerName: string;
      let failed = false;

      try {
        if (creating) {
          // Resolve workspace (accepts name or ID)
          const workspace = await resolveWorkspace(options.workspace!, apiKey);
          const desiredName =
            typeof options.create === 'string' && options.create.length > 0
              ? options.create
              : `${options.agentName}-vm`;

          const ramGb = options.ram ?? 4;
          const cpuCores = options.cpu ?? 1;
          const diskGb = options.disk ?? 50;
          assertFreeTierLimits(ramGb, cpuCores, diskGb);
          console.log(`Creating Orgo computer '${desiredName}' in workspace '${workspace.name}' (ram:${ramGb}GB cpu:${cpuCores} disk:${diskGb}GB)...`);
          const computer = await createComputer(workspace.id, desiredName, apiKey, ramGb, cpuCores, diskGb);
          computerId = computer.id;
          computerName = computer.name;
          console.log(`  Computer created: ${computerName} (${computerId}) — status: ${computer.status}`);
          console.log('  Waiting 15s for VM to reach ready state...');
          await new Promise(r => setTimeout(r, 15_000));
        } else {
          computerId = options.computer!;
          computerName = computerId;
          console.log(`Provisioning existing computer: ${computerId}`);
        }

        console.log(`Running cortextos installer on ${computerName}...`);
        const result = await runInstaller(computerId, options.agentName, apiKey);

        if (result.exit_code === 0) {
          console.log('\nInstall succeeded.');
          if (result.stdout_tail) {
            console.log('\n--- stdout (tail) ---');
            console.log(result.stdout_tail);
          }
          console.log(`\nNext steps:`);
          console.log(`  1. Write /opt/cortextos-agents/${options.agentName}/.env`);
          console.log(`     Required: BOT_TOKEN, CHAT_ID, CTX_ORG, CTX_AGENT_NAME`);
          console.log(`  2. systemctl start cortextos-${options.agentName}`);
        } else {
          console.error(`\nInstall FAILED (exit ${result.exit_code}).`);
          if (result.stdout_tail) {
            console.error('\n--- stdout (tail) ---');
            console.error(result.stdout_tail);
          }
          if (result.stderr_tail) {
            console.error('\n--- stderr (tail) ---');
            console.error(result.stderr_tail);
          }
          failed = true;
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        failed = true;
      }
      if (failed) process.exit(1);
    }
  );
