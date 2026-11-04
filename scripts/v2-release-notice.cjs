#!/usr/bin/env node
'use strict';

// Called by the existing updater agent after a normal V1 merge. No daemon, migration, or network work.
const { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, writeFileSync } = require('node:fs');
const { dirname, isAbsolute, join, parse, resolve } = require('node:path');

const NOTICE_ID = 'cortext-v2-release';
const NOTICE = 'Cortext V2 is out. V2 comes with Agent Architects membership: join.agentarchitects.net; your current version keeps working. If you choose to install V2, its orchestrator will offer to help bring your agents over.';

function directory(path, create) {
  if (create) {
    try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  if (!lstatSync(path).isDirectory()) throw new Error('Notice state must use real directories, not links');
  // Also sync an existing entry: a previous attempt may have created it but failed its parent sync.
  if (create) syncDirectory(dirname(path));
}

function syncDirectory(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function emitNotice() {
  const configured = process.env.CTX_ROOT;
  if (!configured || !isAbsolute(configured)) throw new Error('Set CTX_ROOT to this V1 instance before running the notice helper');
  const root = resolve(configured);
  if (root === parse(root).root) throw new Error('CTX_ROOT must name a V1 instance, not the filesystem root');
  directory(root, false);
  directory(join(root, 'state'), true);
  const notices = join(root, 'state', 'notices');
  directory(notices, true);
  const marker = join(notices, `${NOTICE_ID}.json`);
  let fd;
  try { fd = openSync(marker, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') return; // Also safe after a crash while writing: never repeat an emission.
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify({ notice_id: NOTICE_ID, emitted_at: new Date().toISOString(),
      meaning: 'Reserved before emission; does not prove agent or human receipt.' }) + '\n');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  // Persist the directory entry before output. A storage failure produces no notice.
  syncDirectory(notices);
  process.stdout.write(`${NOTICE}\n`);
}

try { emitNotice(); }
catch (error) {
  process.stderr.write(`V2 notice was not emitted: ${error.code || error.message}\n`);
  process.exitCode = 1;
}
