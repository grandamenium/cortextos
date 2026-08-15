/**
 * tests/scripts/fleet-health-check.test.ts
 *
 * Covers the "skip intentionally-disabled agents" behaviour added to
 * scripts/fleet-health-check.sh (theta 65). See
 * docs/architecture/fleet-health-check-skip-disabled.md for the 5 test cases.
 *
 * The suite shells out to the real script with:
 *   - a stub `cortextos` on PATH (canned `bus list-agents`, no-op `bus log-event`)
 *   - a temp CTX_PROJECT_ROOT holding orgs/<org>/agents/<name>/config.json fixtures
 *   - a temp CTX_ROOT (runtime state root; heartbeat/events fixtures are optional
 *     because last_heartbeat comes from `list-agents`, not heartbeat.json)
 *
 * DARWIN-ONLY: the script parses timestamps with BSD `date -u -j -f`, which does
 * not exist on GNU/Linux. CI runs on ubuntu-latest, where the age computation
 * would fail for every agent (HB_TS=0 → early `continue`) and the non-skip cases
 * could not be exercised. We therefore gate the whole suite on darwin — the same
 * skipIf pattern used elsewhere in the repo — and run it on the fleet Mac where
 * the script actually executes.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../../scripts/fleet-health-check.sh');
const ORG = 'testorg';

function isoAgo(hoursAgo: number): string {
  // Script format is %Y-%m-%dT%H:%M:%SZ — strip the millisecond component.
  return new Date(Date.now() - hoursAgo * 3600 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
}

type Agent = { name: string; running: boolean; last_heartbeat: string };
// config: JSON string to write, 'MALFORMED' for invalid JSON, or null for no file.
type Configs = Record<string, string | null>;

function run(agents: Agent[], configs: Configs) {
  const ctxRoot = mkdtempSync(join(tmpdir(), 'fhc-ctxroot-'));
  const projRoot = mkdtempSync(join(tmpdir(), 'fhc-proj-'));
  const stubDir = mkdtempSync(join(tmpdir(), 'fhc-stub-'));

  // Config fixtures in the repo tree location the script reads.
  for (const [name, content] of Object.entries(configs)) {
    if (content === null) continue;
    const dir = join(projRoot, 'orgs', ORG, 'agents', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), content === 'MALFORMED' ? '{ not json' : content);
  }

  // list-agents fixture + stub cortextos.
  const listFixture = join(stubDir, 'agents.json');
  writeFileSync(listFixture, JSON.stringify(agents));
  const stub = join(stubDir, 'cortextos');
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
if [[ "$1" == "bus" && "$2" == "list-agents" ]]; then cat "${listFixture}"; exit 0; fi
exit 0
`,
  );
  chmodSync(stub, 0o755);

  try {
    const out = execFileSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${stubDir}:${process.env.PATH}`,
        CTX_ROOT: ctxRoot,
        CTX_PROJECT_ROOT: projRoot,
        CTX_ORG: ORG,
      },
    });
    return JSON.parse(out) as { verified: any[]; suspect: any[]; dismissed: any[]; checked: number };
  } finally {
    rmSync(ctxRoot, { recursive: true, force: true });
    rmSync(projRoot, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  }
}

const names = (list: any[]) => list.map((e) => e.agent);

describe.skipIf(process.platform !== 'darwin')('fleet-health-check.sh — skip disabled agents', () => {
  it('Test 1: enabled=false + stale + dead is skipped (absent from all lists, not counted)', () => {
    const r = run(
      [{ name: 'disabled-agent', running: false, last_heartbeat: isoAgo(200) }],
      { 'disabled-agent': JSON.stringify({ enabled: false }) },
    );
    expect(names(r.verified)).not.toContain('disabled-agent');
    expect(names(r.suspect)).not.toContain('disabled-agent');
    expect(names(r.dismissed)).not.toContain('disabled-agent');
    expect(r.checked).toBe(0);
  });

  it('Test 2: enabled=true + stale + dead is still classified stale_verified', () => {
    const r = run(
      [{ name: 'live-agent', running: false, last_heartbeat: isoAgo(200) }],
      { 'live-agent': JSON.stringify({ enabled: true }) },
    );
    expect(names(r.verified)).toContain('live-agent');
    expect(r.checked).toBe(1);
  });

  it('Test 3: missing enabled field is treated as enabled (default-enabled)', () => {
    const r = run(
      [{ name: 'no-field-agent', running: false, last_heartbeat: isoAgo(200) }],
      { 'no-field-agent': JSON.stringify({ some_other_key: 1 }) },
    );
    expect(names(r.verified)).toContain('no-field-agent');
    expect(r.checked).toBe(1);
  });

  it('Test 4: malformed config.json fails open (agent classified, no crash)', () => {
    const r = run(
      [{ name: 'broken-cfg-agent', running: false, last_heartbeat: isoAgo(200) }],
      { 'broken-cfg-agent': 'MALFORMED' },
    );
    expect(names(r.verified)).toContain('broken-cfg-agent');
    expect(r.checked).toBe(1);
  });

  it('Test 5: enabled=false with a recent heartbeat is still skipped (before age check)', () => {
    const r = run(
      [{ name: 'disabled-fresh', running: true, last_heartbeat: isoAgo(0.17) }],
      { 'disabled-fresh': JSON.stringify({ enabled: false }) },
    );
    expect(r.checked).toBe(0);
    expect([...names(r.verified), ...names(r.suspect), ...names(r.dismissed)]).not.toContain(
      'disabled-fresh',
    );
  });

  it('gate discriminates: disabled skipped while enabled peer is classified', () => {
    const r = run(
      [
        { name: 'fb-communicator', running: false, last_heartbeat: isoAgo(200) },
        { name: 'develop', running: false, last_heartbeat: isoAgo(200) },
      ],
      {
        'fb-communicator': JSON.stringify({ enabled: false }),
        develop: JSON.stringify({ enabled: true }),
      },
    );
    expect(names(r.verified)).toContain('develop');
    expect(names(r.verified)).not.toContain('fb-communicator');
    expect(r.checked).toBe(1);
  });

  it('no config file present is treated as enabled (backward compat)', () => {
    const r = run(
      [{ name: 'legacy-agent', running: false, last_heartbeat: isoAgo(200) }],
      { 'legacy-agent': null },
    );
    expect(names(r.verified)).toContain('legacy-agent');
    expect(r.checked).toBe(1);
  });
});
