import { Command } from 'commander';
import { execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadProfileRegistry, findDanglingReferences } from '../utils/profiles.js';
import { ensureSpawnHelperExecutable } from '../utils/node-pty-perms.js';

interface Check {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
  fix?: string;
}

export const doctorCommand = new Command('doctor')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Diagnose common issues')
  .action(async (options: { instance: string }) => {
    console.log('\ncortextOS Doctor\n');

    const checks: Check[] = [];

    // Check Node.js version
    const nodeVersion = process.version;
    const major = parseInt(nodeVersion.slice(1).split('.')[0], 10);
    checks.push({
      name: 'Node.js version',
      status: major >= 20 ? 'pass' : 'fail',
      message: `${nodeVersion} ${major >= 20 ? '(OK)' : '(requires 20+)'}`,
      fix: major < 20 ? 'Install Node.js 20+ from https://nodejs.org' : undefined,
    });

    // Check PM2
    try {
      const pm2Version = execSync('pm2 --version', { encoding: 'utf-8' }).trim();
      checks.push({
        name: 'PM2',
        status: 'pass',
        message: `v${pm2Version}`,
      });
    } catch {
      checks.push({
        name: 'PM2',
        status: 'warn',
        message: 'Not installed',
        fix: 'Install with: npm install -g pm2',
      });
    }

    // Check Claude Code CLI
    try {
      const claudeVersion = execSync('claude --version', { encoding: 'utf-8', timeout: 5000 }).trim();
      checks.push({
        name: 'Claude Code CLI',
        status: 'pass',
        message: claudeVersion,
      });
    } catch {
      checks.push({
        name: 'Claude Code CLI',
        status: 'fail',
        message: 'Not found',
        fix: 'Install Claude Code: npm install -g @anthropic-ai/claude-code',
      });
    }

    // Check node-pty
    try {
      require('node-pty');
      checks.push({
        name: 'node-pty',
        status: 'pass',
        message: 'Native module loaded',
      });
    } catch {
      checks.push({
        name: 'node-pty',
        status: 'fail',
        message: 'Failed to load native module',
        fix: process.platform === 'win32'
          ? 'Install "Desktop development with C++" workload from Visual Studio Build Tools (https://visualstudio.microsoft.com/visual-cpp-build-tools/), then run: npm rebuild node-pty'
          : 'Install build tools: xcode-select --install (macOS) or apt install build-essential (Linux)',
      });
    }

    // Fix spawn-helper permissions (Unix only). Shared implementation in
    // utils/node-pty-perms — same helper the daemon and postinstall use.
    const permResult = ensureSpawnHelperExecutable(process.cwd());
    if (permResult.fixed.length > 0) {
      checks.push({
        name: 'node-pty spawn-helper',
        status: 'warn',
        message: `Permissions were missing on ${permResult.fixed.length} binary(s) - fixed automatically`,
      });
    }
    if (permResult.errors.length > 0) {
      checks.push({
        name: 'node-pty spawn-helper',
        status: 'fail',
        message: `Could not fix permissions: ${permResult.errors.map(e => e.reason).join('; ')}`,
        fix: 'Manually chmod +x node_modules/node-pty/prebuilds/*/spawn-helper',
      });
    }

    // Actual spawn test (cross-platform)
    try {
      const pty = require('node-pty');
      let output = '';
      const isWin = process.platform === 'win32';
      const smokeCmd = isWin ? 'cmd.exe' : '/bin/echo';
      const smokeArgs = isWin ? ['/c', 'echo', 'pty-ok'] : ['pty-ok'];
      const p = pty.spawn(smokeCmd, smokeArgs, { name: 'xterm-256color', cols: 80, rows: 24 });
      await new Promise<void>((resolve, reject) => {
        p.onData((data: string) => { output += data; });
        p.onExit(({ exitCode }: { exitCode: number }) => {
          if (exitCode === 0 && output.includes('pty-ok')) resolve();
          else reject(new Error(`exit ${exitCode}`));
        });
        setTimeout(() => reject(new Error('timed out')), 5000);
      });
      checks.push({
        name: 'node-pty spawn test',
        status: 'pass',
        message: 'Can spawn processes',
      });
    } catch (err) {
      checks.push({
        name: 'node-pty spawn test',
        status: 'fail',
        message: `Cannot spawn processes: ${(err as Error).message}`,
        fix: 'Try: npm rebuild node-pty',
      });
    }

    // Check state directory
    const ctxRoot = join(homedir(), '.cortextos', options.instance);
    checks.push({
      name: 'State directory',
      status: existsSync(ctxRoot) ? 'pass' : 'warn',
      message: existsSync(ctxRoot) ? ctxRoot : 'Not found',
      fix: !existsSync(ctxRoot) ? 'Run: cortextos init <org-name>' : undefined,
    });

    // Check Claude Code auth
    try {
      execSync('claude --version', { encoding: 'utf8', stdio: 'pipe' });
      checks.push({ name: 'Claude Code auth', status: 'pass', message: 'Authenticated' });
    } catch {
      checks.push({
        name: 'Claude Code auth',
        status: 'warn',
        message: 'Not authenticated',
        fix: 'Run: claude login',
      });
    }

    // ── Tunnel checks (macOS only) ──────────────────────────────────────
    if (process.platform === 'darwin') {
      // cloudflared installed?
      try {
        const cfVer = execSync('cloudflared --version', { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 }).trim();
        checks.push({ name: 'cloudflared', status: 'pass', message: cfVer });
      } catch {
        checks.push({
          name: 'cloudflared',
          status: 'warn',
          message: 'Not installed',
          fix: 'Install with: brew install cloudflared',
        });
      }

      // Cloudflare auth cert
      const cfCert = join(homedir(), '.cloudflared', 'cert.pem');
      checks.push({
        name: 'Cloudflare auth',
        status: existsSync(cfCert) ? 'pass' : 'warn',
        message: existsSync(cfCert) ? 'Authenticated (cert.pem found)' : 'Not authenticated',
        fix: !existsSync(cfCert) ? 'Run: cloudflared login' : undefined,
      });

      // Tunnel exists?
      let tunnelExists = false;
      try {
        const listOut = execSync('cloudflared tunnel list --output json', {
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 10000,
        });
        const tunnels: Array<{ name: string }> = JSON.parse(listOut);
        tunnelExists = tunnels.some((t) => t.name === 'cortextos');
      } catch { /* not authenticated or cloudflared not installed */ }
      checks.push({
        name: "Tunnel 'cortextos'",
        status: tunnelExists ? 'pass' : 'warn',
        message: tunnelExists ? 'Exists' : 'Not created',
        fix: !tunnelExists ? 'Run: cortextos tunnel start' : undefined,
      });

      // launchd service running?
      let serviceRunning = false;
      try {
        const launchctlOut = execSync('launchctl list', { encoding: 'utf-8', stdio: 'pipe' });
        serviceRunning = launchctlOut.includes('com.cortextos.tunnel');
      } catch { /* launchctl not available */ }
      checks.push({
        name: 'Tunnel service (launchd)',
        status: serviceRunning ? 'pass' : 'warn',
        message: serviceRunning ? 'Running' : 'Not running',
        fix: !serviceRunning ? 'Run: cortextos tunnel start' : undefined,
      });

      // Tunnel URL saved?
      const tunnelConfigPath = join(homedir(), '.cortextos', options.instance, 'tunnel.json');
      let tunnelUrl: string | undefined;
      try {
        const tc = JSON.parse(readFileSync(tunnelConfigPath, 'utf-8'));
        tunnelUrl = tc.tunnelUrl;
      } catch { /* no config yet */ }
      checks.push({
        name: 'Tunnel URL',
        status: tunnelUrl ? 'pass' : 'warn',
        message: tunnelUrl ?? 'Not set',
        fix: !tunnelUrl ? 'Run: cortextos tunnel start' : undefined,
      });
    }

    // Check gh CLI (needed for community publishing --contribute)
    try {
      const ghVersion = execSync('gh --version', { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 }).trim().split('\n')[0];
      checks.push({ name: 'gh CLI', status: 'pass', message: ghVersion });
    } catch {
      checks.push({
        name: 'gh CLI',
        status: 'warn',
        message: 'Not installed',
        fix: 'Install with: brew install gh (macOS) or https://cli.github.com',
      });
    }

    // Check upstream git remote (needed for check-upstream and community --contribute)
    const frameworkRoot = process.cwd();
    if (existsSync(join(frameworkRoot, '.git'))) {
      try {
        execSync('git remote get-url upstream', { encoding: 'utf-8', stdio: 'pipe', cwd: frameworkRoot });
        checks.push({ name: 'upstream remote', status: 'pass', message: 'Configured' });
      } catch {
        checks.push({
          name: 'upstream remote',
          status: 'warn',
          message: 'Not configured',
          fix: 'Run: git remote add upstream <canonical-cortextos-repo-url>',
        });
      }
    }

    // Check framework code-quality rules (referenced by every agent's session-start protocol)
    const codeQualityRulesPath = join(frameworkRoot, '.claude', 'rules', 'code-quality.md');
    checks.push({
      name: '.claude/rules/code-quality.md',
      status: existsSync(codeQualityRulesPath) ? 'pass' : 'warn',
      message: existsSync(codeQualityRulesPath) ? 'Found' : 'Not found — agents will fail to load engineering bar at session start',
      fix: !existsSync(codeQualityRulesPath) ? 'Run: cortextos bus check-upstream --apply to fetch the latest framework rules' : undefined,
    });

    // Check community/catalog.json (needed for browse-catalog and install-community-item)
    const catalogPath = join(frameworkRoot, 'community', 'catalog.json');
    checks.push({
      name: 'community/catalog.json',
      status: existsSync(catalogPath) ? 'pass' : 'warn',
      message: existsSync(catalogPath) ? 'Found' : 'Not found',
      fix: !existsSync(catalogPath) ? 'Run: cortextos bus check-upstream --apply to fetch the latest catalog' : undefined,
    });

    // BL-003 phase 1: per-org Claude-profile registry
    //
    // For each org with a profiles.json: parse it, confirm the default
    // resolves to a real profile + each profile's config_dir exists on
    // disk + each agent's claude_profile (if set) names a known
    // profile. Warn-level — missing or malformed registry shouldn't
    // block daemon boot (the spawn path silently degrades to no env
    // override) but the operator should know.
    //
    // Dangling-ref detection is delegated to `findDanglingReferences`
    // from profiles.ts (single source of truth — the spawn path uses
    // the loader; the doctor must not reimplement the predicate or
    // the two diverge).
    const orgsRoot = join(frameworkRoot, 'orgs');
    if (existsSync(orgsRoot)) {
      try {
        const orgEntries = readdirSync(orgsRoot, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
        for (const org of orgEntries) {
          const profilesPath = join(orgsRoot, org, 'profiles.json');
          if (!existsSync(profilesPath)) continue;

          // Distinguish parse error from schema error so the operator
          // gets a fix-shaped message, not a generic "broken registry".
          let parsed: { default_profile?: unknown; profiles?: unknown };
          try {
            parsed = JSON.parse(readFileSync(profilesPath, 'utf-8'));
          } catch (err) {
            checks.push({
              name: `Profiles registry (${org})`,
              status: 'warn',
              message: `Malformed JSON: ${(err as Error).message}`,
              fix: `Validate orgs/${org}/profiles.json — spawn path silently falls back to no profile override until fixed`,
            });
            continue;
          }

          const registry = loadProfileRegistry(frameworkRoot, org);
          if (!registry) {
            // parsed OK but failed loader's schema gate (no default,
            // wrong shapes, etc.). All entries with bad config_dir
            // were also dropped during parsing.
            checks.push({
              name: `Profiles registry (${org})`,
              status: 'warn',
              message: 'Schema invalid — needs default_profile + profiles map (entries with non-string config_dir are dropped)',
              fix: `See BL-2026-05-08-003 for the registry shape`,
            });
            continue;
          }

          // Walk agents, build (profile_name → [agent_names]) so the
          // warn message names which agents are using each dangling
          // profile. Use a Map for dedup; the previous flat-array
          // approach miscompared "name" against "agent→name" entries
          // and emitted N warnings for N agents on the same missing
          // profile (caught by code-evaluator on phase 1).
          const referencedBy = new Map<string, string[]>();
          const agentsDir = join(orgsRoot, org, 'agents');
          if (existsSync(agentsDir)) {
            const agentEntries = readdirSync(agentsDir, { withFileTypes: true })
              .filter(d => d.isDirectory())
              .map(d => d.name);
            for (const agentName of agentEntries) {
              const cfgPath = join(agentsDir, agentName, 'config.json');
              if (!existsSync(cfgPath)) continue;
              try {
                const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) as {
                  claude_profile?: unknown;
                  fallback_profile?: unknown;
                };
                // Active profile + phase-3 fallback profile both
                // count as references — a dangling fallback fails
                // boss's runbook just as silently as a dangling
                // active profile fails the spawn path.
                for (const ref of [cfg.claude_profile, cfg.fallback_profile]) {
                  if (typeof ref === 'string' && ref) {
                    const list = referencedBy.get(ref) ?? [];
                    if (!list.includes(agentName)) list.push(agentName);
                    referencedBy.set(ref, list);
                  }
                }
              } catch { /* skip malformed config */ }
            }
          }

          const dangling = findDanglingReferences(registry, referencedBy.keys());
          const missingDirs: string[] = [];
          // Re-read the raw profiles map for the on-disk dir check —
          // loadProfileRegistry already filtered out bad config_dirs,
          // but `parsed` retains them so we can flag unset values too.
          const rawProfiles = (parsed.profiles ?? {}) as Record<string, { config_dir?: unknown }>;
          for (const [pname, p] of Object.entries(rawProfiles)) {
            const dir = p?.config_dir;
            if (typeof dir !== 'string' || !dir || !existsSync(dir)) {
              missingDirs.push(`${pname}→${dir ?? '(unset)'}`);
            }
          }

          const issues: string[] = [];
          if (dangling.length) {
            const annotated = dangling.map(name => {
              const users = referencedBy.get(name) ?? [];
              return users.length ? `${name} (used by: ${users.join(', ')})` : name;
            });
            issues.push(`dangling refs: ${annotated.join(', ')}`);
          }
          if (missingDirs.length) issues.push(`config_dir missing on disk: ${missingDirs.join(', ')}`);

          checks.push({
            name: `Profiles registry (${org})`,
            status: issues.length ? 'warn' : 'pass',
            message: issues.length
              ? issues.join('; ')
              : `${Object.keys(registry.profiles).length} profile(s); default=${registry.default_profile}`,
            fix: issues.length
              ? `Edit orgs/${org}/profiles.json or the offending agent config.json`
              : undefined,
          });
        }
      } catch { /* ignore scan errors */ }
    }

    // BL-003 phase 3: analyst boss-failover doc drift check.
    //
    // The active org's analyst HEARTBEAT.md + GUARDRAILS.md are
    // gitignored — the canonical version lives in templates/analyst/.
    // When a phase-3+ change updates the templates, the active doc
    // can silently drift (the auditor-misses-themselves trap class).
    // This check warns when the active doc is older than the
    // template by file mtime — operator action: re-sync the active
    // copy from the template (a one-line `cp` per file).
    //
    // Per-org mtime check; warn-level only (the active doc may be
    // intentionally diverged for that org's workflow).
    const templatesAnalystDir = join(frameworkRoot, 'templates', 'analyst');
    if (existsSync(templatesAnalystDir) && existsSync(orgsRoot)) {
      try {
        for (const org of readdirSync(orgsRoot, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name)) {
          const activeAnalystDir = join(orgsRoot, org, 'agents', 'analyst');
          if (!existsSync(activeAnalystDir)) continue;
          const drifted: string[] = [];
          for (const f of ['HEARTBEAT.md', 'GUARDRAILS.md']) {
            const tpl = join(templatesAnalystDir, f);
            const active = join(activeAnalystDir, f);
            if (!existsSync(tpl) || !existsSync(active)) continue;
            const tplMtime = statSync(tpl).mtimeMs;
            const activeMtime = statSync(active).mtimeMs;
            if (tplMtime > activeMtime) {
              const ageDays = Math.floor((tplMtime - activeMtime) / (24 * 60 * 60 * 1000));
              drifted.push(`${f} (template ${ageDays}d newer)`);
            }
          }
          if (drifted.length) {
            checks.push({
              name: `Analyst doc drift (${org})`,
              status: 'warn',
              message: `Template newer than active: ${drifted.join(', ')}`,
              fix: `Diff and re-sync: diff -u templates/analyst/<file> orgs/${org}/agents/analyst/<file>`,
            });
          }
        }
      } catch { /* ignore scan errors */ }
    }

    // Check GEMINI_API_KEY for Knowledge Base (semantic search / RAG)
    const orgsDir = join(frameworkRoot, 'orgs');
    let geminiConfigured = false;
    let geminiOrgFound = false;
    if (existsSync(orgsDir)) {
      try {
        for (const org of readdirSync(orgsDir)) {
          const secretsPath = join(orgsDir, org, 'secrets.env');
          if (existsSync(secretsPath)) {
            geminiOrgFound = true;
            const content = readFileSync(secretsPath, 'utf-8');
            if (/^GEMINI_API_KEY=.+/m.test(content)) {
              geminiConfigured = true;
              break;
            }
          }
        }
      } catch { /* ignore scan errors */ }
    }
    if (geminiOrgFound) {
      checks.push({
        name: 'Knowledge Base (GEMINI_API_KEY)',
        status: geminiConfigured ? 'pass' : 'warn',
        message: geminiConfigured ? 'Configured' : 'Not set — semantic search and RAG disabled',
        fix: !geminiConfigured ? 'Add GEMINI_API_KEY to orgs/<org>/secrets.env — get a free key at https://aistudio.google.com/app/apikey' : undefined,
      });
    }

    // Display results
    let hasFailures = false;
    for (const check of checks) {
      const icon = check.status === 'pass' ? 'OK' : check.status === 'warn' ? 'WARN' : 'FAIL';
      const prefix = `  [${icon}]`;
      console.log(`${prefix.padEnd(10)} ${check.name}: ${check.message}`);
      if (check.fix) {
        console.log(`           Fix: ${check.fix}`);
      }
      if (check.status === 'fail') hasFailures = true;
    }

    const warnCount = checks.filter(c => c.status === 'warn').length;
    const failCount = checks.filter(c => c.status === 'fail').length;

    console.log('');
    if (failCount > 0) {
      console.log(`  ${failCount} check(s) failed. Fix the issues above and run doctor again.\n`);
      process.exit(1);
    } else if (warnCount > 0) {
      console.log(`  All critical checks passed, ${warnCount} warning(s). See above for details.\n`);
    } else {
      console.log('  All checks passed.\n');
    }
  });
