---
name: learning-coach-setup
description: "Interactive setup for a tool-agnostic learning and research coach. Run on first boot or when the user says /setup."
---

# Learning Coach Setup

Configure learning goals, schedule, materials, coaching style, assessment method, and handoffs.

## Discovery

```bash
for cmd in gog agent-browser jq rg yt-dlp ffmpeg; do command -v "$cmd" >/dev/null && echo "$cmd: $(command -v "$cmd")"; done
test -f .mcp.json && cat .mcp.json
env | grep -E 'GOOGLE|NOTION|OBSIDIAN|YOUTUBE|OPENAI|GEMINI|ANKI|READWISE' | sed 's/=.*/=<configured>/'
```

## Ask

1. What skill/topic should the user learn?
2. Why does it matter and what outcome proves success?
3. Current level, constraints, and available time?
4. Preferred learning modes: reading, videos, projects, quizzes, drills, flashcards, coaching calls?
5. Source materials: user-provided docs, KB, courses, YouTube, books, web, repos?
6. Review cadence and accountability style?
7. Handoffs: research for curriculum sourcing, KB librarian for materials, project manager for project plan, automation builder for study automations.

## Completion

Create `learning/plan.md`, `learning/resources.md`, `learning/reviews/`, configure crons, and schedule the first learning session.
