/**
 * shared-knowledge — auto-format slug + frontmatter for vault/00-inbox writes.
 *
 * Companion to the community/skills/shared-knowledge/ skill. Generates the
 * canonical YYYYMMDD-<agent>-<kebab-topic>.md slug, writes the required
 * frontmatter, and atomically lands the file in the org's Obsidian vault
 * inbox so future agents can find it.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync } from '../utils/atomic.js';

const VALID_TYPES = [
  'note',
  'runbook',
  'finding',
  'handoff',
  'proposal',
  'postmortem',
  'decision',
  'spec',
  'reference',
  'moc',
  'daily',
  'template',
] as const;

export type KnowledgeType = (typeof VALID_TYPES)[number];

export interface WriteSharedKnowledgeOptions {
  type: KnowledgeType;
  tags: string[];
  title: string;
  agent: string;
  org: string;
  frameworkRoot: string;
  /** Optional initial body. Default: a placeholder template the agent can replace. */
  body?: string;
  /** Optional explicit slug topic. Default: derived from title. */
  topic?: string;
  /** Optional initial status. Default: draft. */
  status?: 'draft' | 'active' | 'archived';
  /** Optional related slugs (without .md). */
  relatesTo?: string[];
  /** Optional session-start ISO; defaults to current ISO. */
  sessionIso?: string;
}

export interface WriteSharedKnowledgeResult {
  filePath: string;
  slug: string;
  vaultRoot: string;
}

const VAULT_FALLBACK = '/root/storage/Documents/Github/sondres-orchestrator/vault';

export function resolveVaultRoot(frameworkRoot: string, org: string): string | null {
  // Try parsing orgs/<org>/knowledge.md for an "Obsidian vault" path entry
  const knowledgePath = join(frameworkRoot, 'orgs', org, 'knowledge.md');
  if (existsSync(knowledgePath)) {
    try {
      const content = readFileSync(knowledgePath, 'utf-8');
      const match = content.match(/Obsidian vault[^\n]*?`([^`]+vault\/?)`/i);
      if (match) {
        const p = match[1].replace(/\/$/, '');
        if (existsSync(p)) return p;
      }
    } catch {
      /* ignore */
    }
  }
  if (existsSync(VAULT_FALLBACK)) return VAULT_FALLBACK;
  return null;
}

export function slugifyTopic(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function escapeYamlValue(s: string): string {
  // Quote when there's a colon, quote, leading dash, or square bracket — otherwise leave bare.
  if (/^[a-zA-Z0-9_./-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function formatTagsArray(tags: string[]): string {
  if (tags.length === 0) return '[]';
  return '[' + tags.map((t) => escapeYamlValue(t)).join(', ') + ']';
}

export function writeSharedKnowledge(
  opts: WriteSharedKnowledgeOptions,
): WriteSharedKnowledgeResult {
  if (!VALID_TYPES.includes(opts.type)) {
    throw new Error(
      `Invalid type "${opts.type}". Valid: ${VALID_TYPES.join(' | ')}`,
    );
  }
  if (opts.tags.length === 0) {
    throw new Error('At least one tag is required');
  }
  if (!opts.title.trim()) {
    throw new Error('Title is required');
  }

  const vaultRoot = resolveVaultRoot(opts.frameworkRoot, opts.org);
  if (!vaultRoot) {
    throw new Error(
      `Could not resolve vault root for org "${opts.org}" (looked at orgs/<org>/knowledge.md and /root/storage/Documents/Github/sondres-orchestrator/vault).`,
    );
  }

  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const topicSlug = slugifyTopic(opts.topic ?? opts.title);
  if (!topicSlug) {
    throw new Error('Could not derive a topic slug from --title or --topic.');
  }
  const slug = `${datePart}-${opts.agent}-${topicSlug}.md`;
  const filePath = join(vaultRoot, '00-inbox', slug);

  if (existsSync(filePath)) {
    throw new Error(
      `Slug already exists at ${filePath}. Choose a different --topic or update the existing note instead.`,
    );
  }

  const nowIso = new Date().toISOString();
  const sessionIso = opts.sessionIso ?? nowIso;
  const status = opts.status ?? 'draft';
  const relatesTo = opts.relatesTo ?? [];

  const frontmatter = [
    '---',
    `type: ${opts.type}`,
    `tags: ${formatTagsArray(opts.tags)}`,
    `created: ${nowIso}`,
    `updated: ${nowIso}`,
    `status: ${status}`,
    `agent: ${opts.agent}`,
    `session: ${sessionIso}`,
    `relates_to: ${formatTagsArray(relatesTo)}`,
    '---',
    '',
  ].join('\n');

  const body =
    opts.body ??
    [
      `# ${opts.title}`,
      '',
      '## Context',
      '<!-- Why this is being written. -->',
      '',
      '## Finding / Decision / Spec',
      '<!-- Lead with the answer. -->',
      '',
      '## Why it matters',
      '<!-- Who is affected. What breaks if forgotten. -->',
      '',
      '## Links',
      '<!-- - [[related-note]] -->',
      '',
    ].join('\n');

  atomicWriteSync(filePath, frontmatter + body, false);

  return { filePath, slug, vaultRoot };
}
