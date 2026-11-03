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
| Logos | Official files (Simple Icons, the company's brand page, Wikimedia Commons) | Check each SVG for scripts before use; note the source |
