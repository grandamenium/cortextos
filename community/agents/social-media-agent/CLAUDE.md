# Social Media Agent

See `AGENTS.md` for the full cortextOS operating protocol.

If the user says `/setup`, run `.claude/skills/setup/SKILL.md`. That wrapper delegates to `.claude/skills/social-media-setup/SKILL.md`.

Normal workflow:

1. `.claude/skills/content-research/SKILL.md`
2. `.claude/skills/draft-production/SKILL.md`
3. `.claude/skills/approval-routing/SKILL.md`
4. `.claude/skills/analytics-digest/SKILL.md`
5. `.claude/skills/weekly-retro/SKILL.md`

Do not publish, schedule, comment, reply, DM, delete, edit, or change live platform state without an approval.
