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

function instrumentedRun(dir, failedSync) {
  const fs = require('node:fs'), vm = require('node:vm');
  const descriptors = new Map(), synced = [], output = [];
  const process = { env: { CTX_ROOT: dir }, stdout: { write: text => output.push(text) }, stderr: { write() {} }, exitCode: 0 };
  const instrumented = { ...fs,
    openSync(path, ...args) { const fd = fs.openSync(path, ...args); descriptors.set(fd, path); return fd; },
    fsyncSync(fd) {
      const path = descriptors.get(fd); synced.push(path);
      if (path === failedSync) throw Object.assign(new Error('fixture sync failure'), { code: 'EIO' });
      fs.fsyncSync(fd);
    },
  };
  vm.runInNewContext(readFileSync(helper, 'utf8'), { require: name => name === 'node:fs' ? instrumented : require(name), process });
  return { synced, output, process };
}

test('new parent entries are synced before reservation and output', () => {
  const dir = root(), result = instrumentedRun(dir);
  assert.deepEqual(result.synced, [dir, join(dir, 'state'), join(dir, 'state/notices/cortext-v2-release.json'), join(dir, 'state/notices')]);
  assert.equal(result.output.length, 1);
});

test('parent sync failure emits zero bytes', () => {
  for (const parent of ['', 'state']) {
    const dir = root(), result = instrumentedRun(dir, join(dir, parent));
    assert.equal(result.output.length, 0); assert.equal(result.process.exitCode, 1);
  }
});
