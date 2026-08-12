# Aspect Ratio and Thumbnail Specs

---

## Platform Specs

| Platform | Format | Resolution | FPS | Notes |
|----------|--------|-----------|-----|-------|
| YouTube Standard | 16:9 landscape | 1920x1080 | 24 | Primary aitheist / chris-meredith format |
| YouTube Shorts | 9:16 portrait | 1080x1920 | 24-30 | Do NOT tag with #Shorts if is_long_form=true |
| TikTok | 9:16 portrait | 1080x1920 | 24-30 | phantom-findings primary |
| LinkedIn video | 16:9 | 1920x1080 | 24 | chris-meredith LinkedIn integration |
| Instagram Reels | 9:16 | 1080x1920 | 24-30 | wendy channel |
| Instagram Feed | 1:1 or 4:5 | 1080x1080 / 1080x1350 | 24 | wendy channel |
| Twitter/X video | 16:9 | 1280x720 min | 24-30 | wendy channel |

---

## YouTube Thumbnail Specs

- **Resolution:** 1280x720 (16:9)
- **Format:** JPG or PNG
- **File size:** under 2MB
- **Chris Meredith channel:** 4 blank-space base photos + 8 styled examples (landscape + portrait) — see `reference_chris_meredith_thumbnail_templates.md` in MEMORY for visual reference

**Thumbnail generation:** RunPod / Krea 2 (not diffusion text). Text overlaid via post-processing or template, never baked into the diffusion pass.

---

## is_long_form Flag

Jobs with `is_long_form: true` MUST NOT receive `#Shorts` in YouTube title or tags. The flag is set in the jobs table `series_metadata` field.

---

## Current Channel Formats

| channel_id | primary format | template resolution |
|-----------|---------------|-------------------|
| ai-theist | 16:9 1920x1080 | 1920x1080 |
| chris-meredith | 16:9 1920x1080 | 1920x1080 |
| phantom-findings | 9:16 (TikTok primary) | 1080x1920 |
| wendy-recap | 16:9 1920x1080 | 1920x1080 |
