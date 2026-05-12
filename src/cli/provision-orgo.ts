import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Orgo API base URL (matches OrgoHTTPClient.swift defaultBaseURL)
// ---------------------------------------------------------------------------
const ORGO_API_BASE = 'https://www.orgo.ai/api';

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

function buildPythonInstallScript(
  installShSource: string,
  agentName: string
): string {
  const bashBase64 = Buffer.from(installShSource, 'utf-8').toString('base64');
  const agentNameBase64 = Buffer.from(agentName, 'utf-8').toString('base64');

  return `
import base64
import json
import os
import subprocess

bash_cmd = base64.b64decode("${bashBase64}").decode("utf-8")
agent_name = base64.b64decode("${agentNameBase64}").decode("utf-8")

try:
    result = subprocess.run(
        ["bash", "-c", bash_cmd, "--", agent_name],
        capture_output=True,
        text=True,
        timeout=250,
        env={**os.environ, "DEBIAN_FRONTEND": "noninteractive"},
    )
    exit_code = result.returncode
    stdout_tail = result.stdout[-4000:]
    stderr_tail = result.stderr[-4000:]
except subprocess.TimeoutExpired as exc:
    exit_code = -1
    stdout_tail = (exc.stdout or "")[-4000:] if isinstance(getattr(exc, "stdout", None), str) else ""
    stderr_tail = "cortextos installer exceeded 250s and was aborted."
except Exception as exc:
    exit_code = -1
    stdout_tail = ""
    stderr_tail = f"Installer raised: {exc}"

print(json.dumps({
    "exit_code": exit_code,
    "stdout_tail": stdout_tail,
    "stderr_tail": stderr_tail,
}))
`.trim();
}

// ---------------------------------------------------------------------------
// Run the installer on the target computer via /exec
// ---------------------------------------------------------------------------

async function runInstaller(
  computerId: string,
  agentName: string,
  apiKey: string
): Promise<InstallScriptResponse> {
  // Load the install script bundled alongside this CLI
  const installShPath = join(__dirname, '../../scripts/install-cortextos-on-orgo.sh');
  let installShSource: string;
  try {
    installShSource = readFileSync(installShPath, 'utf-8');
  } catch {
    throw new Error(
      `Cannot read install script at ${installShPath}. Ensure scripts/install-cortextos-on-orgo.sh is present.`
    );
  }

  const pythonCode = buildPythonInstallScript(installShSource, agentName);

  // 270s client-side timeout; server-side script timeout is 250s
  const execResponse = await orgoPost<ExecResponse>(
    `computers/${computerId}/exec`,
    apiKey,
    { code: pythonCode, timeout: 265 },
    270_000
  );

  if (!execResponse.success && !execResponse.output) {
    throw new Error('Orgo /exec returned failure with no output');
  }

  // The Python script prints a single JSON line to stdout
  const raw = (execResponse.output ?? '').trim();
  const jsonLine = raw.split('\n').reverse().find(l => l.startsWith('{'));
  if (!jsonLine) {
    throw new Error(`Unexpected /exec output (no JSON line found):\n${raw.slice(-500)}`);
  }

  return JSON.parse(jsonLine) as InstallScriptResponse;
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
          process.exit(1);
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    }
  );
