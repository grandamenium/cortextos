---
name: youtube-transcribe
description: Download YouTube audio + transcribe via Whisper. Local-only, no API. Use to ingest podcasts, talks, interviews, lectures into the research corpus as plaintext.
allowed_tools: [Bash, Read]
---

# youtube-transcribe

YouTube → audio → Whisper transcript. All local, no API calls.

## Usage

```bash
./bin/yt-transcribe.sh <url-or-id> [--out /path/transcript.md] [--model base.en]
```

Defaults:
- output: `/tmp/yt-transcribe-<videoid>.md`
- model: `base.en` (~74MB; English-only, fastest)
- audio-only download, 128kbps MP3, ~10-30MB per hour of source

Available Whisper models (download on first use, cached locally):
- `tiny.en` — 39MB, fastest, ok for clear speech
- `base.en` — 74MB, DEFAULT, good quality/speed tradeoff
- `small.en` — 244MB, slow but more accurate
- `medium.en` — 769MB, near-best quality
- `large-v3` — 1.5GB, best quality, multilingual, slowest

## Performance (M4 Max MacBook estimates)

| Audio length | base.en | small.en | large-v3 |
|---|---|---|---|
| 5 min talk | ~15s | ~45s | ~3min |
| 30 min podcast | ~90s | ~4min | ~15min |
| 2 hour lecture | ~6min | ~16min | ~60min |

## Output format

Markdown with frontmatter:

```markdown
---
source: https://youtube.com/watch?v=...
duration: 1234s
model: base.en
transcribed_at: 2026-05-13T10:00:00Z
---

[00:00] First sentence of the transcript.
[00:05] Second sentence.
...
```

## Limits

- ToS: YouTube ToS prohibits "scraping" but personal-use audio download for transcription is widely tolerated. Don't redistribute the audio.
- Copyright: the transcript is your own work product (an analysis of audio you have legitimate access to). Don't paste copyrighted audio verbatim into shared corpora unless fair-use applies.
- Speaker diarization: NOT included. Whisper alone gives flat transcript. Add pyannote-audio if you need "who said what" — separate skill.
- Live streams: not supported; only published videos.

## When to use

- Ingest a podcast/talk into the knowledge base for later RAG queries
- Build a citation-able transcript for a research synthesis
- Cross-reference a video claim against other sources
