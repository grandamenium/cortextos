import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { installCommunityItem } from '../../../src/bus/catalog';

describe('installCommunityItem — install_path normalization (task_1776232775374_418)', () => {
  let frameworkRoot: string;
  let ctxRoot: string;

  beforeEach(() => {
    frameworkRoot = mkdtempSync(join(tmpdir(), 'catalog-fw-'));
    ctxRoot = mkdtempSync(join(tmpdir(), 'catalog-ctx-'));
    mkdirSync(join(frameworkRoot, 'community', 'skills', 'tasks'), { recursive: true });
    writeFileSync(join(frameworkRoot, 'community', 'skills', 'tasks', 'SKILL.md'), '# tasks');
  });

  afterEach(() => {
    rmSync(frameworkRoot, { recursive: true, force: true });
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  function writeCatalog(installPath: string) {
    const catalog = {
      version: '1.0.0',
      updated_at: '2026-04-15T00:00:00Z',
      items: [{
        name: 'tasks',
        description: 'test',
        author: 'test',
        type: 'skill',
        version: '1.0.0',
        tags: [],
        dependencies: [],
        install_path: installPath,
      }],
    };
    writeFileSync(join(frameworkRoot, 'community', 'catalog.json'), JSON.stringify(catalog));
  }

  it('shipped shape: install_path with leading "community/" prefix resolves correctly', () => {
    writeCatalog('community/skills/tasks');
    const agentDir = mkdtempSync(join(tmpdir(), 'catalog-agent-'));
    try {
      const r = installCommunityItem(frameworkRoot, ctxRoot, 'tasks', { agentDir });
      expect(r.status).toBe('installed');
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('submit shape: install_path as bare "skills/X" also resolves correctly', () => {
    writeCatalog('skills/tasks');
    const agentDir = mkdtempSync(join(tmpdir(), 'catalog-agent-'));
    try {
      const r = installCommunityItem(frameworkRoot, ctxRoot, 'tasks', { agentDir });
      expect(r.status).toBe('installed');
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('skill targets .claude/skills/<name>/ under agentDir — the Claude Code harness path', () => {
    writeCatalog('community/skills/tasks');
    const agentDir = mkdtempSync(join(tmpdir(), 'catalog-agent-'));
    try {
      const r = installCommunityItem(frameworkRoot, ctxRoot, 'tasks', { agentDir });
      expect(r.status).toBe('installed');
      expect((r as { target: string }).target).toBe(join(agentDir, '.claude', 'skills', 'tasks'));
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('path traversal still rejected after normalization', () => {
    writeCatalog('community/../../../etc/passwd');
    const r = installCommunityItem(frameworkRoot, ctxRoot, 'tasks');
    expect(r.status).toBe('error');
    expect(r.error).toContain('path traversal');
  });
});
