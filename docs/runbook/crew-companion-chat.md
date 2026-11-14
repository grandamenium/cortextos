# Crew — companion chat setup

Crew is a Grok Bot-style interface for talking to your cortextOS agents:
every enabled agent becomes a character with an avatar, presence-driven
moods (working / around / resting), a full-screen chat, voice messages
with local transcription, and spoken replies. It ships in the dashboard —
if you can run the dashboard, you already have Crew.

## What you get

- **`/crew`** — Crew inside the dashboard (desktop rail + chat, mobile grid).
- **`/crew-app`** — standalone phone version with its own PWA manifest and
  icon. Open it on your phone, log in, then Share → **Add to Home Screen**
  to install a separate "Crew" app that launches straight into the roster.
  Add it while you are ON the Crew screen — the login page and `/crew`
  carry the main dashboard's icon, so adding from there installs the
  dashboard app instead.
- Until you add art, each agent gets a deterministic generated robot
  ("critter") — same name, same face, everywhere.

## Character art

Two ways to give agents real characters (1024px-ish square images with a
simple background look best — ChatGPT image generation does great here):

1. **In the app:** open an agent's chat → paintbrush icon in the header →
   drop or pick an image. Works from a phone (opens your photo library).
2. **On disk:** put files at `~/.cortextos/<instance>/avatars/<agent>.png`
   (also `.jpg` / `.webp` / `.gif`; `<instance>` is usually `default`).
   Resize to ~512px first so the roster loads fast on phones:
   `sips -Z 512 in.png --out ~/.cortextos/default/avatars/orchestrator.png`

Remove art (UI button or delete the file) to get the critter back.

**Taglines:** override the default one-liners without a deploy via
`~/.cortextos/<instance>/avatars/cards.json`:

```json
{ "orchestrator": { "tagline": "Runs the show" } }
```

## Voice (optional but great)

Voice notes are transcribed **locally** with whisper.cpp — no cloud, no
API key. One-time setup on the host:

```bash
brew install whisper-cpp ffmpeg
bash scripts/install-whisper-model.sh                            # tiny.en — also enables Telegram voice-note transcription
WHISPER_MODEL=ggml-base.en.bin bash scripts/install-whisper-model.sh   # recommended: better accuracy, Crew prefers it
```

The mic button appears in every chat; the transcript is delivered to the
agent as a normal message, so agents need zero new configuration. The
speaker toggle in the chat header reads replies aloud (per-agent, never
replays history).

**HTTPS required for the mic:** browsers only allow microphone access on
secure origins. Serve the dashboard over HTTPS (e.g. a Cloudflare tunnel)
or localhost; a plain-HTTP LAN/tailnet address can chat but not record.

Env knobs (daemon + dashboard): `CTX_WHISPER_BIN`, `CTX_FFMPEG_BIN`,
`CTX_WHISPER_MODEL`, `CTX_WHISPER_LANG`.

## How it rides the bus

Nothing new to operate: sends go through the same inbox write + instant
fast-checker wake as the dashboard chat bar, history comes from the
`admin--<agent>` comms channel, and presence reads the same typing flag /
stdout mtime as the Agents page. Uploaded art lives outside the repo under
`~/.cortextos/<instance>/avatars/`, so it survives rebuilds and updates.
