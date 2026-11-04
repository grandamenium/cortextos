'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const helper = resolve(__dirname, '../scripts/v2-release-notice.cjs');
const roots = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'v1-notice-')); roots.push(dir); return dir; };
const run = value => spawnSync(process.execPath, [helper], { env: { CTX_ROOT: value }, encoding: 'utf8' });
after(() => roots.forEach(dir => rmSync(dir, { recursive: true, force: true })));

test('emits once per instance, persists its reservation, and is silent after restart', () => {
  const dir = root();
  const first = run(dir); assert.equal(first.status, 0); assert.match(first.stdout, /^Cortext V2 is out\./);
  const marker = JSON.parse(readFileSync(join(dir, 'state/notices/cortext-v2-release.json')));
  assert.equal(marker.notice_id, 'cortext-v2-release');
  const second = run(dir); assert.equal(second.status, 0); assert.equal(second.stdout, '');
  assert.match(run(root()).stdout, /^Cortext V2 is out\./);
});

test('concurrent runs emit a single notice', async () => {
  const dir = root();
  const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper], { env: { CTX_ROOT: dir } });
    let out = ''; child.stdout.on('data', chunk => { out += chunk; }); child.on('error', reject);
    child.on('close', code => resolve({ code, out }));
  })));
  assert.equal(results.filter(result => result.out).length, 1);
  assert.ok(results.every(result => result.code === 0));
});

test('invalid context never guesses another instance', () => {
  for (const value of ['', 'relative-instance', '/']) { const result = run(value); assert.equal(result.status, 1); assert.equal(result.stdout, ''); }
});

test('state creation failure never emits the notice', () => {
  const dir = root(); writeFileSync(join(dir, 'state'), 'blocked');
  const result = run(dir); assert.equal(result.status, 1); assert.equal(result.stdout, '');
});

test('symlinked state is refused without writing to the target', () => {
  const dir = root(), target = root(); symlinkSync(target, join(dir, 'state'));
  const result = run(dir); assert.equal(result.status, 1); assert.equal(result.stdout, '');
});

test('a crash reservation never emits again', () => {
  const dir = root(); mkdirSync(join(dir, 'state/notices'), { recursive: true });
  writeFileSync(join(dir, 'state/notices/cortext-v2-release.json'), '');
  const result = run(dir); assert.equal(result.status, 0); assert.equal(result.stdout, '');
});
