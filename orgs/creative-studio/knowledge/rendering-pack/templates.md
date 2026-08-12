# Canon Template Inventory

Templates live in `/home/claude-dev/repos/ai-theist/templates/hf/` (git-versioned).

---

## CRITICAL RULE: No Diffusion-Rendered Text

Quote text, lower-thirds, brand marks, and any on-screen text MUST be rendered via HTML template overlays. Never use image-generation models (FLUX, KREA2, Higgsfield, or any diffusion model) to render text. Diffusion models produce garbled, unreadable text (confirmed failure mode, 2026-07-30 Bradley incident).

**Pre-render check (devops task task_1785454943436_ch5ev9):** render pipeline will block jobs where channel has a canon template but the job does not reference it.

---

## Template Directory Map

| channel_id | template directory | status |
|-----------|-------------------|--------|
| ai-theist | `templates/hf/ai-theist/` | canon |
| chris-meredith | `templates/hf/` (root hf) | canon |
| phantom-findings | `templates/hf/phantom-findings/` | canon |
| wendy-recap | `templates/hf/wendy-recap/` | canon |

---

## Template Files (per channel)

Each channel template directory contains:

| File | Purpose |
|------|---------|
| `master.template.html` | Full composition shell |
| `intro.template.html` | Opening sequence |
| `body.template.html` | Main content area |
| `outro.template.html` | Closing CTA + brand mark |
| `lower-third.template.html` | Speaker ID / quote attribution overlay |
| `stitch-body.template.html` | Scene stitching body |
| `stitch-shell.css.html` | Stitching CSS |

**Outro placeholders:** `{{brand}}`, `{{question}}`, `{{url}}`, `{{cta}}` — all text-overlay, not diffusion.

---

## Quote-Short Template Spec (chris-meredith)

- **Master composition:** 1920x1080 at 24fps (confirmed from job c0cdc641 render meta)
- **Platform variants:** portrait 9:16 (1080x1920) derived per platform — tiktok.mp4 and instagram_reels.mp4 are generated from the master; do not canonize "landscape" as the only quote-short format
- **Quote text:** rendered as HTML overlay in body.template.html
- **Attribution:** rendered via lower-third.template.html
- **Voice:** ElevenLabs `kyj06yo9f25k` (tts_provider: elevenlabs; fallback voxtral: onyx)
- **Brand color:** `#1a1a2e`
- **Distribution:** youtube (primary), linkedin (cms855no70001ntcbvg3ig0my)
- **Blotato account:** youtube `39156`

**Dispatch rule:** all quote-short jobs for chris-meredith channel MUST reference `templates/hf/` root directory. Jobs that skip this reference are blocked at pre-render gate (once devops wires the check).
