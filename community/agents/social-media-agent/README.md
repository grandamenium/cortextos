# Social Media Agent

Reusable community template for a tool-agnostic social media/content agent.

## First Run

1. Install as a cortextOS agent.
2. Start it and say `/setup`.
3. The setup wrapper runs `.claude/skills/social-media-setup/SKILL.md`.
4. Connect whichever tools you use: platform dashboards, browser automation, Google Workspace/gogcli, Notion, Airtable, YouTube tools, RSS, Apify, newsletters, blog CMS exports, or manual files.
5. Review approval rules before allowing any publishing workflow.

## Included Workflows

- content research and angle generation
- platform-native draft production
- approval queue management
- scheduling handoff after approval
- analytics digest and content retros
- recurring crons for heartbeat, daily content brief, draft pipeline review, analytics digest, and weekly retro

## Operating Contract

- `AGENTS.md` is the full cortextOS runtime protocol.
- `CLAUDE.md` delegates to `AGENTS.md` and points `/setup` to `.claude/skills/setup/SKILL.md`.
- Common operating skills are bundled under `.claude/skills/`.
- Domain skills cover research, draft production, approval routing, analytics, and weekly retros.
- Schemas live in `schemas/`; examples live in `examples/`.

## Safety

Drafts are local and autonomous. Publishing, scheduling, comments, replies, DMs, edits, deletes, paid actions, and profile changes require explicit approval.
