/**
 * Pin-enforcement guard for template .mcp.json files.
 *
 * Rationale: Roger's agentmemory-mcp supply-chain audit (2026-04-15) flagged
 * the 6-releases-in-41h publish cadence as a supply-chain risk if agents pull
 * `latest` at startup. Audit verdict was GO **conditional on version pinning**.
 * This test fails CI if any template's .mcp.json ships with a floating npx
 * invocation (no `@X.Y.Z` version suffix on the package spec).
 *
 * Scope: checks every template's .mcp.json. Applies to all MCP server entries
 * that use `npx` as the command — not just agentmemory. Any future npx-backed
 * MCP server in a template must also pin.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const TEMPLATES_ROOT = join(__dirname, '..', '..', '..', 'templates');
const TEMPLATES = ['agent', 'orchestrator', 'analyst'];

// package spec with version pin: either `pkg@1.2.3` or `@scope/pkg@1.2.3`.
// Must include at least one digit-containing segment after the LAST `@`.
const VERSION_PIN_RE = /@\d+(\.\d+)*/;

function hasVersionPin(pkgSpec: string): boolean {
  // Strip leading `@scope/` (if present) before checking for trailing `@X.Y.Z`
  const withoutScope = pkgSpec.replace(/^@[^/]+\//, '');
  return VERSION_PIN_RE.test('@' + withoutScope.split('@').slice(1).join('@'));
}

describe('template .mcp.json pin enforcement', () => {
  for (const tmpl of TEMPLATES) {
    const mcpPath = join(TEMPLATES_ROOT, tmpl, '.mcp.json');

    it(`${tmpl}: .mcp.json exists`, () => {
      expect(existsSync(mcpPath)).toBe(true);
    });

    it(`${tmpl}: every npx-backed MCP server has a pinned package version`, () => {
      const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
      const servers = config.mcpServers ?? {};
      for (const [name, server] of Object.entries<any>(servers)) {
        if (server.command !== 'npx') continue;
        const args: string[] = server.args ?? [];
        // the package spec is typically the last non-flag arg
        const pkgSpec = args.filter((a) => !a.startsWith('-')).pop();
        expect(pkgSpec, `${tmpl}/${name}: no package spec found in args`).toBeDefined();
        expect(
          hasVersionPin(pkgSpec!),
          `${tmpl}/${name}: package spec "${pkgSpec}" must be pinned to a specific version (e.g. @1.2.3). ` +
            `Floating npx invocations expose the fleet to supply-chain risk on every agent startup. ` +
            `See orgs/agentnet/agents/roger/state/research/agentmemory-mcp-audit.md.`,
        ).toBe(true);
      }
    });
  }
});
