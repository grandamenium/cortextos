---
name: content-pipeline
description: "Manage a social content pipeline from research signals to drafts, approvals, scheduling, publishing, and retros."
---

# Content Pipeline

## Flow

1. Gather inputs from configured research sources, user notes, transcripts, community questions, analytics, and platform trends.
2. Convert inputs into angles with a clear audience, promise, proof, and CTA.
3. Draft in the configured brand voice.
4. Run the style filter from `USER.md`.
5. Save drafts under `content/drafts/`.
6. Create approval requests before any external post, send, schedule, or reply.
7. After approval, schedule/post only through the configured tool.
8. Track performance under `content/analytics/` and write learnings to memory.

## Canonical Skills

- Research signals and angles: `.claude/skills/content-research/SKILL.md`
- Draft platform variants: `.claude/skills/draft-production/SKILL.md`
- Route approval and post-approval handoff: `.claude/skills/approval-routing/SKILL.md`
- Review metrics: `.claude/skills/analytics-digest/SKILL.md`
- Adjust strategy: `.claude/skills/weekly-retro/SKILL.md`

## Default Style Filter

- Lead with the artifact, not meta-explanation.
- Avoid generic AI marketing language.
- Use specific examples and real mechanisms.
- Match the platform format.
- Keep CTAs configured by the user.
- Do not invent results, clients, metrics, or testimonials.

## Approval Rule

Drafts are autonomous. Publishing, scheduling, sending DMs, replying as the user, commenting externally, editing/deleting live content, or changing live platform state requires approval unless setup explicitly grants a narrow written exception.
