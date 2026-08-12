# Channel Schema

Source of truth: `aitheist` PostgreSQL DB (127.0.0.1:5432) + Postiz DB (postiz-postgres container).

---

## AI Theist DB — channels table

Primary key: `id` (varchar 64). Note: `channel_id` is the FK column name on the jobs table (not a channels column).

| id | name | tts_provider | elevenlabs_voice_id | voxtral_voice_id | heygen_avatar_id | brand_color | target_platforms | outro_video_path | blotato_accounts |
|----|------|-------------|-------------------|-----------------|-----------------|-------------|-----------------|-----------------|-----------------|
| ai-theist | AI Theist | xai | (none) | en_paul_neutral | Abigail_expressive_2024112501 | #888888 | youtube | /mnt/r2/videos/assets/aitheist/Outro.mp4 | {} |
| chris-meredith | Chris Meredith | elevenlabs | kyj06yo9f25k | onyx | (none) | #1a1a2e | youtube | (none) | {"youtube": "39156"} |
| phantom-findings | Phantom Findings | xai | (none) | (none) | (none) | #3d1a5c | youtube, tiktok | (none) | {"tiktok": "4064", "youtube": "2368"} |
| wendy-recap | WendyRECAP | openai | (none) | (none) | Abigail_expressive_2024112501 | #FF6B6B | youtube | /mnt/r2/videos/assets/wendy/outtro-landscape.mp4 | {"youtube": "32114"} |

**Full channels schema (rendering-relevant columns):** id, name, brand_color, voice_style, hook_style, cta, personality_traits (jsonb), elevenlabs_voice_id, heygen_voice_id, heygen_avatar_id, icon_path, watermark_path, outro_video_path, intro_video_path, target_platforms (jsonb), custom_prompt, active, blotato_accounts (jsonb), tts_provider, video_provider, voxtral_voice_id

**Schema columns (jobs table):** id (uuid), source_url, source_platform, extracted_text, script (jsonb), status, input_type (url/text/script), channel_id (FK to channels.id), thumbnails (jsonb), series_metadata (jsonb)

**job_status enum:** ingested, classified, scripted, rendered, published, error

---

## Postiz DB — Integration IDs

| channel_id | name | Postiz integration_id | type |
|-----------|------|----------------------|------|
| ai-theist | AI-Theist-IO | cms82dw7m000tpmd7zf4irf6a | youtube |
| ai-theist | AI-Theist-IO | cms82efmu000vpmd7gelf8u3g | youtube |
| ai-theist | AI-Theist-IO | cmqh3g7x40005pmekeprp9x87 | youtube |
| chris-meredith | Christopher Meredith | cms82da4n000rpmd77v1671b7 | youtube |
| chris-meredith | Christopher Meredith | cmqh3dahs0001pmekt2wx31tu | youtube |
| chris-meredith | Christopher Meredith | cms855no70001ntcbvg3ig0my | linkedin |
| phantom-findings | Phantom Findings | cmqh3f3dn0003pmekl0fwf5d8 | youtube |

**Postiz CLI:** set `POSTIZ_API_URL=https://postiz.profithits.app/api` before any `postiz` command. Self-hosted instance (not SaaS).

---

## Canonical Outro Voice

- **chris-meredith:** ElevenLabs voice `kyj06yo9f25k`
- **ai-theist / wendy-recap:** HeyGen avatar `Abigail_expressive_2024112501`
- **phantom-findings:** no canonical voice/avatar (visual-only)
