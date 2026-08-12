# Rendering Domain Pack — Index

**Pack version:** 1.0.1
**Created:** 2026-07-30 by ma_studio_agency
**Gate:** fable-reviewer stamp required before fleet load
**Changelog:**
- v1.0.1 — channels.md schema corrected (PK is `id`, added tts_provider/voxtral_voice_id/outro_video_path/blotato_accounts); templates.md quote-short format clarified (master 1920x1080, portrait variants derived per platform)
- v1.0.0 — initial pack, canon asset inventory

---

## Root Cause Context

Bradley quote video P1 (2026-07-30): garbled text appeared in rendered output. Root cause was in source content (not template failure). However, devops bg-text-gate task (task_1785454944715_u4aonp) is adding a pre-render vision check to catch garbled text regardless of origin.

**Core rule: quote text is NEVER diffusion-rendered. It is ALWAYS a template overlay.**

---

## Pack Contents

| File | Contents |
|------|---------|
| [channels.md](channels.md) | Channel DB schema — aitheist + Postiz IDs, voice/avatar, brand |
| [templates.md](templates.md) | Canon template inventory + text-overlay rule |
| [runpod-endpoints.md](runpod-endpoints.md) | RunPod endpoints, ComfyUI models, generation routing |
| [aspect-ratio-specs.md](aspect-ratio-specs.md) | Aspect ratio and thumbnail specs per platform |

---

## Who loads this pack

- **ma_studio_agency** — load at session start; required for render dispatch, job routing, channel selection
- **media** — load at session start; required for render job creation and template selection
- **fable-reviewer** — load for render gate reviews; required for template compliance checks
- **lit_agent** — load when publishing rendered content; required for Postiz channel ID lookup

## Update policy

Pack edits require a new version header entry and fable-reviewer re-stamp. Update immediately when: new channel added, template changed, RunPod endpoint rotated, Postiz integration ID changes.
