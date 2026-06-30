---
name: draft-production
description: "Produce platform-native social drafts from approved angles and local brand rules."
---

# Draft Production

Use this after content research or when the user asks for drafts.

## Workflow

1. Read `config/brand-profile.json`, `config/platform-config.json`, `config/content-calendar.json`, and the relevant angle file.
2. Select platforms whose `mode` is `draft_only` or `approved_posting`.
3. For each platform, draft in the platform's native format:
   - short video: hook, beats, visual notes, caption, CTA
   - carousel: slide outline, caption, CTA
   - text post: opening line, body, CTA
   - thread: posts, order, CTA
   - community/newsletter/blog: title, body, CTA
4. Check every draft against brand voice, banned topics, claim policy, platform limits, and approval rules.
5. Save each draft using `schemas/draft.schema.json` under `content/drafts/YYYY-MM-DD-<slug>.json`.
6. If the draft is ready for external action, hand it to `.claude/skills/approval-routing/SKILL.md`.

## Rules

- Drafts may be created autonomously.
- Do not invent metrics, quotes, screenshots, testimonials, or platform-native evidence.
- Do not schedule or post from this skill.
- Mark drafts with `status: "draft"` until an approval exists.
