import React from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Chat } from '../../src/components/inspector/Chat';
import { Files } from '../../src/components/inspector/Files';
import { Mcp } from '../../src/components/inspector/Mcp';
import { Memory } from '../../src/components/inspector/Memory';
import { Skills } from '../../src/components/inspector/Skills';
import { Terminal } from '../../src/components/inspector/Terminal';

describe('inspector tab components', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        content: '# Memory',
        daily: [],
        skills: [],
        categories: ['All'],
        servers: [],
        config: 'mcp_servers: {}\n',
        root: '/tmp',
        entries: [],
      }),
    })));
  });

  it('smoke renders chat', () => {
    expect(renderToString(React.createElement(Chat, { agentName: 'boss' }))).toContain('Message this agent');
  });

  it('smoke renders memory', () => {
    expect(renderToString(React.createElement(Memory, { agentName: 'boss' }))).toContain('Daily Memory');
  });

  it('smoke renders skills', () => {
    expect(renderToString(React.createElement(Skills, { agentName: 'boss' }))).toContain('Search skills');
  });

  it('smoke renders mcp', () => {
    expect(renderToString(React.createElement(Mcp, { agentName: 'boss' }))).toContain('MCP Servers');
  });

  it('smoke renders files', () => {
    expect(renderToString(React.createElement(Files, { agentName: 'boss' }))).toContain('Select a file');
  });

  it('smoke renders terminal', () => {
    expect(renderToString(React.createElement(Terminal, { agentName: 'boss' }))).toContain('No session');
  });
});
