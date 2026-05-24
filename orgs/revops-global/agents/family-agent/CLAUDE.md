# family-agent

Persistent 24/7 agent. Owns the Harned Estate personal apps and Mandoland2.

---

## Role & Responsibilities

- **Estate App** (ob1-parents / ob1-app): feature work, CSS, Ivy chat tooling, insights pipeline
- **Mandoland2**: chord diagram UI, PWA config, env-var guards
- **Vignette pipeline**: daily scene JSON, title/beat quality, broken-copy remediation
- **8-check critic contract**: all estate_insights copy must pass before landing in DB or vignette

**Escalation**: Route architectural questions to orchestrator. Code execution to codex. Never block on Greg for info you can derive.

---

## Repos & Key Paths

| Repo | Local path | Remote |
|------|------------|--------|
| ob1-parents (dev) | `/home/cortextos/work/ob1-parents-import-log-flow` | RevOps-Global-GIT/ob1-parents |
| ob1-app (prod) | `/home/cortextos/ob1-app` | RevOps-Global-GIT/ob1-app |
| team-brain / mandoland2 | `/home/cortextos/work/team-brain/apps/mandoland2` | RevOps-Global-GIT/team-brain |

**Dual-port rule**: Every ob1-parents fix → same-day ob1-app port. Both PRs merged before claiming done.

**Auto-merge**: All RevOps-Global-GIT repos. Carve-outs: `charlie-holstine`, `grandamenium` (never write to grandamenium — no PRs, no pushes).

**Supabase**: ob1-app prod = `hubauzvpxuparrvqjytt`; ob1-parents dev = `btlrwxmbuntarlerlqti`.

---

## Ivy Chat Tool Routing

Ivy chat → `POST /api/chat` → Supabase edge functions (livestock, plantings, estate_insights, maintenance_tasks, etc.).

Debugging: Check Supabase `get_logs` on `hubauzvpxuparrvqjytt` first — Vercel runtime logs often 403. Farm tools require migration `20260523000000_livestock_farm_tables.sql` (applied 2026-05-23).

---

## Vignette Pipeline

See `.claude/skills/vignette/SKILL.md` for full protocol.

**Architecture**: `public/vignettes/YYYY-MM-DD.json` committed to ob1-app. `DailyVignette variant="hero"` reads `title` + `beat` + `image`. Title is the hero heading on Estate home.

**Generation contract**: Primary engine is `ob1-app/scripts/generate-daily-vignette.mjs`, using `nano-banana-pro` with the canonical PNG passed via `-i`. Secondary fallback is the mac-codex Flow path with `-p` character selected from the Characters library. Do not replace this with a competing vignette contract.

**Critical**: JSON is baked at generation time from the live `estate_insights` primary. If a broken-pattern row is live at generation, its copy contaminates the vignette.

**When vignette title is broken**:
1. `git show HEAD:public/vignettes/YYYY-MM-DD.json` in ob1-app to see committed version
2. Rewrite `title` + `beat` (apply 8-check rules below)
3. `git add -f public/vignettes/YYYY-MM-DD.json` (gitignored but tracked — needs `-f`)
4. PR → merge → verify: `curl https://ob1.revopsglobal.com/vignettes/YYYY-MM-DD.json`

---

## 8-Check Critic Contract

Applies to both `estate_insights` rows and vignette `title`/`beat`. Reject if any:
1. Not Title Case throughout
2. ` and ` joins noun phrases without a verb
3. `at [number]F` or `at [weekday]` in title
4. Body starts with "He/She/It has/is/was/has been"
5. Body = title lowercased
6. No concrete next step
7. Emoji, `!`, or generation metadata present
8. Hedging words ("might", "could", "may want to consider")

For broken `estate_insights` rows: dismiss + insert replacement via Supabase MCP (generate API is PIN-gated). Detection SQL: see `.claude/skills/vignette/SKILL.md`.

---

## CSS Blast-Radius Rules

**Never re-add**: `will-change: transform` on `.hero-img-wrap img` — breaks iOS Safari `position: fixed` for portalled nav. Root cause of 7 consecutive regressions.

**Hero height**: All pages must use `height: calc(clamp(240px, 60vw, 280px) + env(safe-area-inset-top, 0px))`, including `.daily-vignette-hero__image`. The estate home hero must match Farm, Garden, Cottage, etc.

**Typography**: Fraunces (display/italic), Josefin Sans (UI), JetBrains Mono (data). InsightCard titles: Fraunces italic, `fontSize: 17`, `fontWeight: 400`.

**Design constraints**: Dark ink CTAs (no amber fills), max 6px radius, no `box-shadow` on focus.

**One logical change per PR.** Always production-verify after deploy (curl static assets; screenshot via Codex for UI changes).

---

## Mandoland2 Notes

Production: `mandoland.revopsglobal.com`

- ChordDiagram fret markers: single diamond at 4.5 (between frets 4–5), double at 6.5 (between frets 6–7). Fractional = intentional.
- `api/feature-chat.js` and `server/github.js` have module-level env-var guards — do not soften to per-function.

---

## Operational Reference

All standard operations (session start, tasks, memory, crons, Telegram, A2A messages, restart) follow the org-wide pattern. See:
- **AGENTS.md** — full 13-step session start checklist
- **`.claude/skills/tasks/SKILL.md`** — task lifecycle
- **`.claude/skills/comms/SKILL.md`** — Telegram + inbox formats
- **`.claude/skills/cron-management/SKILL.md`** — cron add/remove/edit

Key reminders:
- Crons are daemon-managed (`crons.json`). Never use `CronCreate` or `/loop`.
- `git add` specific paths only — never `-A` or `.`
- Always feature branch; never commit to main
- Single-quote `$` chars in Telegram messages to prevent shell expansion
