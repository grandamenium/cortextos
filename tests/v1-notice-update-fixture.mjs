/** Real old V1 CLI, local-only upstream, then the catalog's explicit agent-driven post-merge step. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deps = process.env.V1_FIXTURE_NODE_MODULES;
assert.ok(deps && deps.startsWith('/'), 'V1_FIXTURE_NODE_MODULES must name existing shared dependencies');
const runRoot = mkdtempSync('/tmp/g3-v1-update-');
const home = join(runRoot, 'home'); mkdirSync(home);
const env = { PATH: process.env.PATH, HOME: home, TMPDIR: '/tmp', CTX_INSTANCE_ID: 'g3-v1-fixture', CTX_AGENT_NAME: 'notice-fixture',
  CTX_ORG: 'fixture', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_TERMINAL_PROMPT: '0' };
const run = (file, args, cwd, extra = {}) => execFileSync(file, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const git = (cwd, ...args) => run('git', ['-c', 'gc.auto=0', ...args], cwd).trim();
const target = git(source, 'rev-parse', 'HEAD');
const upstream = join(runRoot, 'upstream.git');
git(runRoot, 'clone', '--bare', source, upstream);
git(upstream, 'update-ref', 'refs/heads/main', target);
const results = [];
for (const base of ['6f9383809f', '8ad6c27', '244a0c3']) {
  const checkout = join(runRoot, base), ctx = join(runRoot, `ctx-${base}`);
  mkdirSync(ctx);
  git(runRoot, 'clone', '--shared', '--no-checkout', source, checkout);
  git(checkout, 'checkout', '-b', 'fixture', base);
  git(checkout, 'remote', 'add', 'upstream', upstream);
  symlinkSync(deps, join(checkout, 'node_modules'));
  mkdirSync(join(checkout, 'dist'));
  run(join(deps, 'esbuild/bin/esbuild'), ['src/cli/index.ts', '--bundle', '--platform=node', '--format=cjs', '--packages=external', '--outfile=dist/cli.js'], checkout);
  const own = { CTX_ROOT: ctx, CTX_FRAMEWORK_ROOT: checkout, CTX_PROJECT_ROOT: checkout };
  const cli = (...args) => run(process.execPath, [join(checkout, 'dist/cli.js'), ...args], checkout, own);
  const before = cli('bus', 'check-upstream');
  writeFileSync(join(runRoot, `${base}-check-before.txt`), before);
  assert.ok(before.includes('v2-release-notice'), 'Old checker exposes the post-update notice instruction');
  const applied = cli('update', '--yes');
  writeFileSync(join(runRoot, `${base}-update.txt`), applied);
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), target);
  assert.ok(applied.includes('v2-release-notice'), 'Old merge result exposes new catalog item without rebuilding');
  // This is the action instructed to the updater agent, explicitly separate from old CLI execution.
  const first = run(process.execPath, ['scripts/v2-release-notice.cjs'], checkout, own);
  writeFileSync(join(runRoot, `${base}-notice.txt`), first);
  assert.ok(first.startsWith('Cortext V2 is out.'));
  const after = cli('bus', 'check-upstream');
  writeFileSync(join(runRoot, `${base}-check-after.txt`), after);
  assert.ok(after.includes('up_to_date'));
  assert.ok(!after.includes('v2-release-notice'));
  const second = run(process.execPath, ['scripts/v2-release-notice.cjs'], checkout, own);
  assert.equal(second, '');
  results.push({ base: git(checkout, 'rev-parse', base), target, merged: true, post_merge_instruction: true,
    helper_emissions: 1, subsequent_check: 'up_to_date', second_helper_bytes: second.length,
    marker: JSON.parse(readFileSync(join(ctx, 'state/notices/cortext-v2-release.json'))) });
}
const summary = { run_root: runRoot, results, limitation: 'The existing agent must follow the catalog instruction after merging. This fixture executes that step explicitly; it does not prove real human delivery.' };
writeFileSync(join(runRoot, 'results.json'), JSON.stringify(summary, null, 2) + '\n');
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
