# RunPod Endpoints and Generation Routing

---

## Primary Image Generation Endpoint

**RunPod endpoint ID:** `ygjupdn1giw0u0`
**Type:** ComfyUI serverless
**Status:** LIVE — primary for all AI image generation

### Available Models

| Model | Alias | Use case |
|-------|-------|---------|
| FLUX | FLUX | General image generation (currently PAUSED — Krea 2 is primary) |
| KREA 2 | KREA2 / `qxm27naj9po2uu` | Primary image gen — editorial, mockups, privacy arch diagrams |
| ZIMAGE | ZIMAGE | Supplementary |

**Current routing:** Krea 2 (`qxm27naj9po2uu`) is the active primary model. FLUX paused as of 2026-07-30 (Chris directive).

---

## Generation Routing Policy

| Content type | Generator | Notes |
|-------------|-----------|-------|
| Editorial images | RunPod / Krea 2 | Primary |
| Blog / article body images | RunPod / Krea 2 | Primary |
| UI mockups | RunPod / Krea 2 | Stitch-seed if needed |
| Quote-short backgrounds | NOT diffusion | Template overlay ONLY |
| Video b-roll (LAWS / DIT) | Pre-made b-roll only | Chris directive 2026-07-29 |
| Video b-roll (ai-theist) | Higgsfield (existing) | Per HeyGen/Higgsfield pipeline |

**Higgsfield:** NOT used for new generation. Existing aitheist pipeline only.

---

## API Access

RunPod endpoint accessed via `/repos/ai-theist/src/` generation workers. API key in `ai-theist/.env.local`. For standalone generation: use RunPod REST API with endpoint ID `ygjupdn1giw0u0`.

---

## R2 Storage

Generated assets written to R2 mount at `/mnt/r2/`. Subdirectories:
- `/mnt/r2/files/ma_studio_agency/` — article images, drafts
- `/mnt/r2/videos/` — video assets, channel branding
- `/mnt/r2/files/` — general file share (CDN: files.profithits.app)
