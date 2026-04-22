// cortextOS Dashboard - Markdown parser for agent config files
// Round-trip safe: unknown sections preserved through edit cycles

import { stripHtmlComments } from '@/lib/utils';
import type {
  MarkdownSection,
  ParsedMarkdown,
  IdentityFields,
  SoulFields,
  GoalsMdFields,
} from '@/lib/types';

// ---------------------------------------------------------------------------
// Generic parser
// ---------------------------------------------------------------------------

/**
 * Split markdown content on heading lines (## , ### , etc.).
 * Returns a ParsedMarkdown with preamble + sections array.
 */
export function parseMarkdown(content: string): ParsedMarkdown {
  if (!content) {
    return { preamble: '', sections: [], raw: '' };
  }

  const raw = content;
  const lines = content.split('\n');
  const sections: MarkdownSection[] = [];

  // Find all heading line indices
  const headingIndices: { index: number; level: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      headingIndices.push({
        index: i,
        level: match[1].length,
        text: match[2],
      });
    }
  }

  // Preamble is everything before the first heading
  const firstHeadingLine = headingIndices.length > 0 ? headingIndices[0].index : lines.length;
  const preamble = lines.slice(0, firstHeadingLine).join('\n');

  // Build sections
  for (let h = 0; h < headingIndices.length; h++) {
    const current = headingIndices[h];
    const nextIndex = h + 1 < headingIndices.length ? headingIndices[h + 1].index : lines.length;

    const sectionLines = lines.slice(current.index, nextIndex);
    const rawSection = sectionLines.join('\n');

    // Content is everything after the heading line
    const contentLines = sectionLines.slice(1);
    const sectionContent = contentLines.join('\n');

    sections.push({
      heading: current.text,
      level: current.level,
      content: sectionContent,
      raw: rawSection,
    });
  }

  return { preamble, sections, raw };
}

/**
 * Reconstruct markdown from a ParsedMarkdown structure.
 * Round-trip safe: serializeMarkdown(parseMarkdown(s)) === s
 */
export function serializeMarkdown(parsed: ParsedMarkdown): string {
  const parts: string[] = [];

  if (parsed.preamble || parsed.sections.length === 0) {
    parts.push(parsed.preamble);
  }

  for (const section of parsed.sections) {
    parts.push(section.raw);
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the trimmed text content of a section by heading name (case-insensitive). */
function getSectionContent(parsed: ParsedMarkdown, ...headings: string[]): string {
  const lowerHeadings = headings.map((h) => h.toLowerCase());
  for (const section of parsed.sections) {
    if (lowerHeadings.includes(section.heading.toLowerCase())) {
      return section.content.trim();
    }
  }
  return '';
}

/**
 * Update a section's content by heading. If found, replaces content;
 * if not found, appends a new section. Returns a new ParsedMarkdown.
 */
function updateSection(
  parsed: ParsedMarkdown,
  heading: string,
  newContent: string,
  level: number = 2,
): ParsedMarkdown {
  const lowerHeading = heading.toLowerCase();
  const sections = parsed.sections.map((s) => {
    if (s.heading.toLowerCase() === lowerHeading) {
      const headingLine = '#'.repeat(s.level) + ' ' + s.heading;
      const newRaw = headingLine + '\n' + newContent;
      return {
        ...s,
        content: newContent,
        raw: newRaw,
      };
    }
    return s;
  });

  // If not found, append
  const found = sections.some((s) => s.heading.toLowerCase() === lowerHeading);
  if (!found && newContent) {
    const prefix = '#'.repeat(level);
    const raw = `${prefix} ${heading}\n${newContent}`;
    sections.push({
      heading,
      level,
      content: newContent,
      raw,
    });
  }

  return { ...parsed, sections };
}

/**
 * True when the new field value matches the comment-stripped content of the
 * matching section in the original markdown. Lets serialize skip a write for
 * untouched fields so template placeholder comments (<!-- ... -->) survive
 * saves where the user only edited other fields.
 */
function sectionUnchanged(
  original: ParsedMarkdown,
  headingMap: Record<string, string>,
  fieldKey: string,
  newValue: string,
): boolean {
  const normalized = newValue.trim();
  const section = original.sections.find(
    (s) => headingMap[s.heading.toLowerCase()] === fieldKey,
  );
  // No such section yet. Treat empty input as "unchanged" so we don't append
  // a blank `## Heading\n` block on save.
  if (!section) return normalized === '';
  return stripHtmlComments(section.content) === normalized;
}

// ---------------------------------------------------------------------------
// IDENTITY.md
// ---------------------------------------------------------------------------

const IDENTITY_MAP: Record<string, string> = {
  name: 'Name',
  role: 'Role',
  emoji: 'Emoji',
  vibe: 'Vibe',
  workStyle: 'Work Style',
};

const IDENTITY_HEADINGS: Record<string, string> = {
  name: 'name',
  role: 'role',
  emoji: 'emoji',
  vibe: 'vibe',
  'work style': 'workStyle',
};

export function parseIdentityMd(
  content: string,
): { fields: IdentityFields; parsed: ParsedMarkdown } {
  const parsed = parseMarkdown(content);
  const fields: IdentityFields = {
    name: '',
    role: '',
    emoji: '',
    vibe: '',
    workStyle: '',
  };

  for (const section of parsed.sections) {
    const key = IDENTITY_HEADINGS[section.heading.toLowerCase()];
    if (key) {
      fields[key] = stripHtmlComments(section.content);
    }
  }

  return { fields, parsed };
}

export function serializeIdentityMd(
  fields: IdentityFields,
  original: ParsedMarkdown,
): string {
  let result = original;
  for (const [fieldKey, heading] of Object.entries(IDENTITY_MAP)) {
    if (fields[fieldKey] === undefined) continue;
    if (sectionUnchanged(original, IDENTITY_HEADINGS, fieldKey, fields[fieldKey])) {
      continue;
    }
    result = updateSection(result, heading, fields[fieldKey] + '\n');
  }
  return serializeMarkdown(result);
}

// ---------------------------------------------------------------------------
// SOUL.md
// ---------------------------------------------------------------------------

const SOUL_MAP: Record<string, string> = {
  autonomyRules: 'Autonomy Rules',
  communicationStyle: 'Communication Style',
  dayMode: 'Day Mode',
  nightMode: 'Night Mode',
  coreTruths: 'Core Truths',
};

const SOUL_HEADINGS: Record<string, string> = {
  autonomy: 'autonomyRules',
  'autonomy rules': 'autonomyRules',
  communication: 'communicationStyle',
  'communication style': 'communicationStyle',
  'day mode': 'dayMode',
  'night mode': 'nightMode',
  'core truths': 'coreTruths',
};

export function parseSoulMd(
  content: string,
): { fields: SoulFields; parsed: ParsedMarkdown } {
  const parsed = parseMarkdown(content);
  const fields: SoulFields = {
    autonomyRules: '',
    communicationStyle: '',
    dayMode: '',
    nightMode: '',
    coreTruths: '',
  };

  for (const section of parsed.sections) {
    const key = SOUL_HEADINGS[section.heading.toLowerCase()];
    if (key) {
      fields[key] = stripHtmlComments(section.content);
    }
  }

  return { fields, parsed };
}

export function serializeSoulMd(
  fields: SoulFields,
  original: ParsedMarkdown,
): string {
  let result = original;
  for (const [fieldKey, heading] of Object.entries(SOUL_MAP)) {
    if (fields[fieldKey] === undefined) continue;
    if (sectionUnchanged(original, SOUL_HEADINGS, fieldKey, fields[fieldKey])) {
      continue;
    }
    result = updateSection(result, heading, fields[fieldKey] + '\n');
  }
  return serializeMarkdown(result);
}

// ---------------------------------------------------------------------------
// GOALS.md
// ---------------------------------------------------------------------------

const GOALS_HEADINGS: Record<string, string> = {
  bottleneck: 'bottleneck',
  'current bottleneck': 'bottleneck',
  goals: 'goals',
  'active goals': 'goals',
};

export function parseGoalsMd(
  content: string,
): { fields: GoalsMdFields; parsed: ParsedMarkdown } {
  const parsed = parseMarkdown(content);
  const fields: GoalsMdFields = {
    bottleneck: '',
    goals: '',
  };

  for (const section of parsed.sections) {
    const key = GOALS_HEADINGS[section.heading.toLowerCase()];
    if (key) {
      fields[key] = stripHtmlComments(section.content);
    }
  }

  return { fields, parsed };
}

export function serializeGoalsMd(
  fields: GoalsMdFields,
  original: ParsedMarkdown,
): string {
  let result = original;
  if (fields.bottleneck !== undefined
      && !sectionUnchanged(original, GOALS_HEADINGS, 'bottleneck', fields.bottleneck)) {
    const bottleneckHeading =
      original.sections.find((s) => GOALS_HEADINGS[s.heading.toLowerCase()] === 'bottleneck')
        ?.heading ?? 'Bottleneck';
    result = updateSection(result, bottleneckHeading, fields.bottleneck + '\n');
  }
  if (fields.goals !== undefined
      && !sectionUnchanged(original, GOALS_HEADINGS, 'goals', fields.goals)) {
    const goalsHeading =
      original.sections.find((s) => GOALS_HEADINGS[s.heading.toLowerCase()] === 'goals')
        ?.heading ?? 'Goals';
    result = updateSection(result, goalsHeading, fields.goals + '\n');
  }
  return serializeMarkdown(result);
}
