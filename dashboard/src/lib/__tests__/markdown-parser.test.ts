import { describe, it, expect } from 'vitest';
import {
  parseMarkdown,
  serializeMarkdown,
  parseIdentityMd,
  serializeIdentityMd,
  parseSoulMd,
  serializeSoulMd,
  parseGoalsMd,
  serializeGoalsMd,
} from '../markdown-parser';

// ---------------------------------------------------------------------------
// Generic parser round-trip
// ---------------------------------------------------------------------------

describe('parseMarkdown / serializeMarkdown', () => {
  it('round-trips simple markdown with multiple sections', () => {
    const input = `# Title

Some preamble text.

## Section One
Content of section one.

## Section Two
Content of section two.
`;
    expect(serializeMarkdown(parseMarkdown(input))).toBe(input);
  });

  it('round-trips empty string', () => {
    expect(serializeMarkdown(parseMarkdown(''))).toBe('');
  });

  it('round-trips file with no headings (all preamble)', () => {
    const input = 'Just some plain text\nwith multiple lines.\n';
    expect(serializeMarkdown(parseMarkdown(input))).toBe(input);
  });

  it('round-trips file with nested headings', () => {
    const input = `## Main Section
Some content.

### Sub Section
Sub content.

## Another Section
More content.
`;
    const parsed = parseMarkdown(input);
    expect(parsed.sections).toHaveLength(3);
    expect(parsed.sections[0].heading).toBe('Main Section');
    expect(parsed.sections[1].heading).toBe('Sub Section');
    expect(parsed.sections[1].level).toBe(3);
    expect(serializeMarkdown(parsed)).toBe(input);
  });

  it('round-trips file with duplicate heading names', () => {
    const input = `## Notes
First notes.

## Notes
Second notes.
`;
    const parsed = parseMarkdown(input);
    expect(parsed.sections).toHaveLength(2);
    expect(serializeMarkdown(parsed)).toBe(input);
  });

  it('handles preamble before first heading', () => {
    const input = `Preamble line 1
Preamble line 2

## Heading
Content.
`;
    const parsed = parseMarkdown(input);
    expect(parsed.preamble).toBe('Preamble line 1\nPreamble line 2\n');
    expect(parsed.sections).toHaveLength(1);
    expect(serializeMarkdown(parsed)).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// IDENTITY.md
// ---------------------------------------------------------------------------

const SAMPLE_IDENTITY = `## Name
Test Agent

## Role
Orchestrator

## Emoji
🤖

## Vibe
Focused and methodical

## Work Style
Sequential task execution

## Notes
Some custom notes that should survive edits.
`;

describe('parseIdentityMd / serializeIdentityMd', () => {
  it('extracts identity fields correctly', () => {
    const { fields } = parseIdentityMd(SAMPLE_IDENTITY);
    expect(fields.name).toBe('Test Agent');
    expect(fields.role).toBe('Orchestrator');
    expect(fields.emoji).toContain('🤖');
    expect(fields.vibe).toBe('Focused and methodical');
    expect(fields.workStyle).toBe('Sequential task execution');
  });

  it('round-trips identity without edits', () => {
    const { fields, parsed } = parseIdentityMd(SAMPLE_IDENTITY);
    const output = serializeIdentityMd(fields, parsed);
    expect(output).toBe(SAMPLE_IDENTITY);
  });

  it('preserves unknown sections through edit', () => {
    const { fields, parsed } = parseIdentityMd(SAMPLE_IDENTITY);
    fields.name = 'New Name';
    const output = serializeIdentityMd(fields, parsed);

    expect(output).toContain('New Name');
    expect(output).toContain('## Notes');
    expect(output).toContain('Some custom notes');
  });

  it('edited field parses back correctly', () => {
    const { fields, parsed } = parseIdentityMd(SAMPLE_IDENTITY);
    fields.role = 'Analyst';
    const output = serializeIdentityMd(fields, parsed);

    const { fields: reparsed } = parseIdentityMd(output);
    expect(reparsed.role).toBe('Analyst');
    expect(reparsed.name).toBe('Test Agent');
  });

  it('handles empty content', () => {
    const { fields } = parseIdentityMd('');
    expect(fields.name).toBe('');
    expect(fields.role).toBe('');
  });

  it('strips html comment placeholders from extracted fields', () => {
    const input = `## Name
<!-- Agent name (set during onboarding) -->

## Role
<!-- What this agent does -->

## Emoji
<!-- Optional emoji identifier -->

## Vibe
Focused

## Work Style
<!-- TODO -->
- Ship fast
`;
    const { fields } = parseIdentityMd(input);
    expect(fields.name).toBe('');
    expect(fields.role).toBe('');
    expect(fields.emoji).toBe('');
    expect(fields.vibe).toBe('Focused');
    // Mixed: comment plus real content — keep the real content.
    expect(fields.workStyle).toContain('Ship fast');
    expect(fields.workStyle).not.toContain('<!--');
  });

  it('preserves template comments when user does not edit any field', () => {
    const input = `## Name
<!-- Agent name -->

## Role
<!-- What this agent does -->

## Emoji
<!-- Optional -->

## Vibe
<!-- Personality -->

## Work Style
<!-- How they work -->
`;
    const { fields, parsed } = parseIdentityMd(input);
    // User never edits — save should not wipe the placeholder comments.
    const output = serializeIdentityMd(fields, parsed);
    expect(output).toBe(input);
  });

  it('preserves html comments inside fenced code blocks', () => {
    const input = `## Vibe
Some context.

\`\`\`
<!-- example markup -->
\`\`\`

Real prose after.
`;
    const { fields } = parseIdentityMd(input);
    expect(fields.vibe).toContain('<!-- example markup -->');
    expect(fields.vibe).toContain('Real prose after.');
  });

  it('writes user edit without disturbing other template comments', () => {
    const input = `## Name
<!-- Agent name -->

## Role
<!-- What this agent does -->

## Emoji
<!-- Optional -->

## Vibe
<!-- Personality -->

## Work Style
<!-- How they work -->
`;
    const { fields, parsed } = parseIdentityMd(input);
    fields.name = 'Atlas';
    const output = serializeIdentityMd(fields, parsed);
    expect(output).toContain('## Name\nAtlas\n');
    expect(output).toContain('<!-- What this agent does -->');
    expect(output).toContain('<!-- Personality -->');
  });

  it('collapses whitespace left by inline comment strip', () => {
    const input = `## Role
Hello <!-- note --> World
`;
    const { fields } = parseIdentityMd(input);
    // Double space artifact must not leak to the UI.
    expect(fields.role).toBe('Hello World');
  });
});

// ---------------------------------------------------------------------------
// SOUL.md
// ---------------------------------------------------------------------------

const SAMPLE_SOUL = `## Autonomy Rules
- Always ask before deploying
- Never modify production data

## Communication Style
Concise, direct, technical

## Day Mode
Active task execution

## Night Mode
Monitoring only

## Core Truths
Ship fast, break nothing.
`;

describe('parseSoulMd / serializeSoulMd', () => {
  it('extracts soul fields correctly', () => {
    const { fields } = parseSoulMd(SAMPLE_SOUL);
    expect(fields.autonomyRules).toContain('Always ask before deploying');
    expect(fields.communicationStyle).toBe('Concise, direct, technical');
    expect(fields.dayMode).toBe('Active task execution');
    expect(fields.nightMode).toBe('Monitoring only');
    expect(fields.coreTruths).toBe('Ship fast, break nothing.');
  });

  it('round-trips soul without edits', () => {
    const { fields, parsed } = parseSoulMd(SAMPLE_SOUL);
    const output = serializeSoulMd(fields, parsed);
    expect(output).toBe(SAMPLE_SOUL);
  });

  it('handles alternate heading "Autonomy" (without Rules)', () => {
    const input = `## Autonomy
Be careful.
`;
    const { fields } = parseSoulMd(input);
    expect(fields.autonomyRules).toBe('Be careful.');
  });
});

// ---------------------------------------------------------------------------
// GOALS.md
// ---------------------------------------------------------------------------

const SAMPLE_GOALS = `## Bottleneck
Waiting on API credentials

## Goals
- [ ] Set up CI pipeline
- [x] Write unit tests
- [ ] Deploy staging

## Updated
2025-01-15
`;

describe('parseGoalsMd / serializeGoalsMd', () => {
  it('extracts goals fields correctly', () => {
    const { fields } = parseGoalsMd(SAMPLE_GOALS);
    expect(fields.bottleneck).toBe('Waiting on API credentials');
    expect(fields.goals).toContain('Set up CI pipeline');
    expect(fields.goals).toContain('[x] Write unit tests');
  });

  it('round-trips goals without edits', () => {
    const { fields, parsed } = parseGoalsMd(SAMPLE_GOALS);
    const output = serializeGoalsMd(fields, parsed);
    expect(output).toBe(SAMPLE_GOALS);
  });

  it('preserves unknown sections (Updated) through edit', () => {
    const { fields, parsed } = parseGoalsMd(SAMPLE_GOALS);
    fields.bottleneck = 'No blockers';
    const output = serializeGoalsMd(fields, parsed);

    expect(output).toContain('No blockers');
    expect(output).toContain('## Updated');
    expect(output).toContain('2025-01-15');
  });
});
