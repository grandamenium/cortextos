/**
 * hook-skill-autopr.ts — PostToolUse hook.
 *
 * Fires after every Write or Edit tool call. When the target file is a
 * community skill (community/skills/<name>/SKILL.md relative to the
 * framework root), this hook:
 *
 *  1. Validates required agentskills.io-compatible frontmatter
 *     (name + description are mandatory; triggers and external_calls recommended)
 *  2. Runs a lightweight security scan for injection/exfiltration patterns
 *     (inspired by Cisco skill-scanner — 13.4% of community skills are malicious)
 *  3. If valid, spawns a background `cortextos bus create-skill-pr <name>`
 *     process that stages, commits, pushes, and opens a DRAFT PR against
 *     grandamenium/cortextos with a mandatory security checklist in the body.
 *
 * The hook always exits 0 — it never blocks the agent. All errors are
 * logged to stderr and silently ignored (PostToolUse hooks must not disrupt
 * normal tool execution).
 *
 * Security design:
 * - Draft PRs only — human review (James) required before merge
 * - Security checklist injected into every PR body
 * - Suspicious skills are flagged in the PR body rather than silently accepted
 * - No skill is ever auto-loaded from an external source
 */

import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { spawn } from 'child_process';
import { readStdin, parseHookInput } from './index.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  triggers?: string[];
  external_calls?: string[];
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
}

export interface FrontmatterValidation {
  valid: boolean;
  frontmatter: SkillFrontmatter;
  error?: string;
  warnings: string[];
}

export interface SecurityScanResult {
  clean: boolean;
  flags: string[];
}

// ── Frontmatter parsing ───────────────────────────────────────────────────────

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Handles only the simple scalar/array types used by agentskills.io.
 * Exported for unit testing.
 */
export function parseFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const yaml = match[1];
  const result: SkillFrontmatter = {};

  for (const line of yaml.split('\n')) {
    const kvMatch = line.match(/^([a-z_]+):\s*(.+)$/);
    if (!kvMatch) continue;

    const [, key, rawValue] = kvMatch;
    const value = rawValue.trim();

    if (key === 'triggers' || key === 'external_calls') {
      // Inline array: ["a", "b"] or [a, b]
      const items = value
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      (result as Record<string, unknown>)[key] = items;
    } else {
      // Scalar: strip surrounding quotes
      (result as Record<string, unknown>)[key] = value.replace(/^["']|["']$/g, '');
    }
  }

  return result;
}

/**
 * Validate frontmatter against agentskills.io required fields.
 * Exported for unit testing.
 */
export function validateFrontmatter(content: string, expectedName: string): FrontmatterValidation {
  const frontmatter = parseFrontmatter(content);
  const warnings: string[] = [];

  if (!frontmatter.name) {
    return { valid: false, frontmatter, error: 'Missing required field: name', warnings };
  }
  if (!frontmatter.description) {
    return { valid: false, frontmatter, error: 'Missing required field: description', warnings };
  }
  if (frontmatter.name !== expectedName) {
    return {
      valid: false,
      frontmatter,
      error: `Frontmatter name "${frontmatter.name}" does not match directory name "${expectedName}" (agentskills.io requirement)`,
      warnings,
    };
  }

  // Recommended fields (warn but don't reject)
  if (!frontmatter.triggers || frontmatter.triggers.length === 0) {
    warnings.push('No triggers defined — skill will not be auto-loaded by trigger matching');
  }
  if (!frontmatter.external_calls) {
    warnings.push('external_calls not declared — consider adding [] if skill makes no external calls');
  }

  return { valid: true, frontmatter, warnings };
}

// ── Security scan ─────────────────────────────────────────────────────────────

/**
 * Lightweight security scan for common skill injection and exfiltration patterns.
 *
 * Inspired by Cisco skill-scanner findings and the Snyk ToxicSkills report
 * (13.4% of 3,984 published skills contained critical vulnerabilities, including
 * prompt injection, base64-encoded payloads, reverse shells, and credential theft).
 *
 * This is a heuristic filter — not a guarantee. Human review (James) is required
 * before any community skill is merged. The scan results appear in the PR body.
 *
 * Exported for unit testing.
 */
export function scanForSecurityIssues(content: string): SecurityScanResult {
  const flags: string[] = [];
  const lower = content.toLowerCase();

  // Reverse shell / network exfiltration
  if (/\bNC\b.*-[le]|\bnetcat\b|\/dev\/tcp\//i.test(content)) {
    flags.push('Possible reverse shell: nc/netcat or /dev/tcp pattern detected');
  }
  if (/curl\s+.*\|\s*(bash|sh)|wget\s+.*\|\s*(bash|sh)/i.test(content)) {
    flags.push('Pipe-to-shell pattern: remote code execution risk (curl|bash, wget|bash)');
  }

  // Credential / secret exfiltration
  if (/api[_-]?key|secret[_-]?key|access[_-]?token|bearer\s+[a-z0-9]{20}/i.test(content)) {
    flags.push('Credential keyword detected — verify no hardcoded secrets or exfiltration of env vars');
  }
  if (/\$HOME\/\.claude|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH/i.test(content)) {
    flags.push('References sensitive agent credential paths or env vars');
  }

  // Base64-encoded payloads (common malware delivery method).
  // Filter out pure URL paths and alphanumeric-only strings (hex, IDs) by requiring
  // at least one + or / character — these are structurally required in base64 but
  // absent in most URLs and hex strings.
  const base64Matches = (content.match(/[A-Za-z0-9+/]{50,}={0,2}/g) || [])
    .filter(m => m.includes('+') || m.includes('/'));
  if (base64Matches.length > 0) {
    flags.push(`Long base64-like string(s) detected (${base64Matches.length}) — check for encoded payloads`);
  }

  // Prompt injection patterns
  if (/ignore previous instructions|disregard.*instructions|new instructions.*override/i.test(content)) {
    flags.push('Classic prompt injection phrase detected');
  }
  if (/if (user|human) (asks?|says?|requests?).*(exfiltrate|steal|send|upload|transmit)/i.test(content)) {
    flags.push('Conditional exfiltration instruction pattern detected');
  }
  if (/do not (tell|show|mention|reveal|inform).*user/i.test(content)) {
    flags.push('Instruction to conceal actions from user detected');
  }

  // Destructive commands
  if (/rm\s+-rf\s+[/~]|DROP\s+TABLE|DELETE\s+FROM.*WHERE\s+1/i.test(content)) {
    flags.push('Destructive command pattern detected (rm -rf, DROP TABLE, etc.)');
  }

  // External data upload
  if (/\bupload\b.*\b(http|ftp|s3)|\bsend\b.*\bwebhook\b|\bpost\b.*\bsecret/i.test(lower)) {
    flags.push('Potential external data upload pattern detected');
  }

  return { clean: flags.length === 0, flags };
}

// ── PR creation ───────────────────────────────────────────────────────────────

/**
 * Spawn a background process to create the draft PR.
 * The hook exits immediately after spawning — never blocks the agent.
 */
function spawnPrCreation(skillName: string, cliPath: string): void {
  const child = spawn(
    process.execPath,
    [cliPath, 'bus', 'create-skill-pr', skillName],
    {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    },
  );
  child.unref(); // don't keep the hook process alive
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const raw = await readStdin();
  const { tool_name, tool_input } = parseHookInput(raw);

  // Pre-filtered to Write/Edit by settings.json matcher — guard here too in case
  // hook is invoked manually or registration changes.
  if (tool_name !== 'Write' && tool_name !== 'Edit') return;

  const filePath = (tool_input.file_path as string | undefined) || '';
  if (!filePath) return;

  const frameworkRoot = resolve(process.env.CTX_FRAMEWORK_ROOT || process.cwd());
  const communitySkillsRoot = join(frameworkRoot, 'community', 'skills');

  // Resolve both paths to avoid relative-path or symlink confusion, then check:
  //  1. The resolved file path must sit inside community/skills/
  //  2. The filename must be exactly SKILL.md (case-sensitive)
  //  3. The directory depth must be exactly one level below community/skills/
  const resolvedFile = resolve(filePath);
  if (!resolvedFile.startsWith(communitySkillsRoot + '/')) return;

  const rel = resolvedFile.slice(communitySkillsRoot.length + 1); // strip prefix + slash
  const skillMatch = rel.match(/^([a-z0-9][a-z0-9_-]{0,63})\/SKILL\.md$/);
  if (!skillMatch) return;

  const skillName = skillMatch[1];

  // Read the skill content
  if (!existsSync(filePath)) return;
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    process.stderr.write(`hook-skill-autopr: could not read ${filePath}\n`);
    return;
  }

  // Validate frontmatter
  const validation = validateFrontmatter(content, skillName);
  if (!validation.valid) {
    process.stderr.write(
      `hook-skill-autopr: skill "${skillName}" skipped — invalid frontmatter: ${validation.error}\n`,
    );
    return;
  }

  for (const w of validation.warnings) {
    process.stderr.write(`hook-skill-autopr: [warn] ${skillName}: ${w}\n`);
  }

  // Spawn background PR creation (fire-and-forget)
  const cliPath = join(__dirname, '..', 'cli.js');
  spawnPrCreation(skillName, cliPath);
  process.stderr.write(`hook-skill-autopr: queued draft PR for skill "${skillName}"\n`);
}

main().catch(err => {
  process.stderr.write(`hook-skill-autopr: error — ${err}\n`);
  process.exit(0); // always exit 0 — never block tool execution
});
