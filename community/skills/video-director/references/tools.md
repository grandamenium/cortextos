# Tools

| Need | Use | Notes |
|---|---|---|
| Still images (people, places, b-roll stills, specimens) | Codex image generation, or the user's own photos | Brief: `assets/codex-image-brief.md`; commands in `references/media.md` |
| Video (living portraits, b-roll clips, generated shots) | The brief's clip tool, image-to-video from an approved still | Not for making stills; each case, including no clip tool, in `references/media.md` |
| Animation and render | HyperFrames CLI (`npx hyperframes`) | Read `npx hyperframes docs <topic>` before writing HTML |
| Storyboard frames | `assets/frame-kit.js`, `scripts/render_frames.py` | Headless Chrome renders each frame to PNG and checks layout for the format |
| Review pages | `scripts/build_storyboard.py` | Storyboards and options pages with zoom, pins and notes |
| Render check | `scripts/check_render.py` | Required before any render goes out: text sizes by role, reading time, motion strips |
| Script language | `scripts/scan_script.py` | Candidate surfacer; review in context |
| Delivery size | `scripts/check_delivery.py` | Exact byte/frame limits |
| Frames at every cut | `scripts/cut_frames.py` | Four frames around each cut, side by side |
| Action moments | `scripts/action_frames.py` | Zoomed frames at each click or touch inside a shot; fails when a HyperFrames pointer's tip misses its target |
| Props and clothes across shots | `scripts/continuity_sheet.py` | One sheet per recurring item, a tile per shot; `--verify` needs a verdict per item |
| Sound balance | `scripts/sound_balance.py` | Each effect and voice against the music at that moment, from the mix's stems |
| Bar lines of a music track | `aubio beat <track.wav>` or librosa's `beat_track` | For fitting music on bar lines (`sound-and-voice.md`); if neither is installed, say so and don't guess the bars |
| What a generated clip's audio says | `whisper-cli` with the tiny English model | Catches extra words in clip audio (`types/live-action-story.md`); if missing, say so rather than skip the check silently |
| Watching in motion | `scripts/watch_cut.py` (Gemini API, `GEMINI_API_KEY`) | A video model lists motion problems with times; candidates to confirm in frames |
| Logos | Official files (Simple Icons, the company's brand page, Wikimedia Commons) | Check each SVG for scripts before use; note the source |
