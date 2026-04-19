# PHASES — Move plan (execute only on Josh go-ahead)

## Pre-flight gate (updated 2026-04-18)

- [ ] `merge/upstream-main-apr17` merged to main (current branch — must land first).
- [ ] `git status` clean at `~/cortextos/` on main.
- [ ] Fleet quiet: no agent actively mid-task (check dashboard Activity feed + `cortextos status --instance cortextos1`).
- [ ] Josh available in chat (in case of rollback).
- [x] ~~PR #65 (watchdog + 3 stability ports)~~ — superseded; all stability fixes in BUG-050 through BUG-086 are already merged.
- [x] ~~Auditos bug sweep~~ — complete as of 2026-04-16 audit.
- [x] ~~CLI --instance bug~~ — shipped in upstream merge (cortextos1 instance now working).

## Phase 1 — Freeze + snapshot (2 min)

1. Telegram Josh: "starting move, agents going offline for ~15 min"
2. `pm2 stop cortextos-daemon cortextos-dashboard`
3. Verify no PTYs hanging: `ps aux | grep claude | grep -v grep` — all gone
4. `cp -R ~/cortextos ~/cortextos.snapshot-before-move` (rollback insurance)

## Phase 2 — Move + rewrite paths (5 min)

1. `mv ~/cortextos ~/code/cortextos`
2. `cd ~/code/cortextos`
3. `sed -i '' 's|/Users/joshweiss/cortextos|/Users/joshweiss/code/cortextos|g' ecosystem.config.js`
4. `sed -i '' 's|/Users/joshweiss/cortextos|/Users/joshweiss/code/cortextos|g' ~/.cortextos/cortextos1/dashboard.env ~/.cortextos/default/dashboard.env`
5. `git diff ecosystem.config.js` — verify only the 5 expected lines changed, no surprises
6. `npm run build` — sanity compile in new location

## Phase 3 — Re-link global CLI (1 min)

1. `npm unlink -g cortextos` (removes old symlink)
2. `cd ~/code/cortextos && npm install -g .` (re-link from new path)
3. `which cortextos && cortextos --version` — verify 0.1.1 at new path

## Phase 4 — Restart daemon + dashboard (2 min)

1. `pm2 delete cortextos-daemon cortextos-dashboard` (force cwd refresh)
2. `cd ~/code/cortextos && pm2 start ecosystem.config.js`
3. `pm2 save` (persist)
4. `pm2 list` — both online

## Phase 5 — Verify fleet (5 min)

1. `cortextos status --instance cortextos1` — all 8 agents (auditos, frank2, hunter, larry, maven, muse, sage, sre) should reach `running` within 60s
2. Tail each agent stdout log, watch for bootstrap completion
3. Send Telegram test ping to frank2 bot (Josh self), await reply
4. Send agent-bus message to auditos, await ACK
5. Open dashboard localhost:3000, verify activity feed updating
6. Check `~/.claude/projects/` for NEW transcript dirs under new escaped path (`-Users-joshweiss-code-cortextos-...`)

## Phase 6 — Cleanup (1 min)

1. `rm -rf ~/cortextos.old/` (dead weight from prior migration)
2. Optional: `ln -s ~/code/cortextos ~/cortextos` (48h compat symlink for anything external that hardcoded the old path — remove after 48h if nothing breaks)
3. Commit the path-rewrite changes: `git commit -am "chore: relocate framework to ~/code/cortextos"`
4. Telegram Josh: "move complete, fleet back online, N min downtime"

## Rollback plan (if anything breaks in Phase 5)

1. `pm2 delete cortextos-daemon cortextos-dashboard`
2. `mv ~/code/cortextos ~/code/cortextos.failed-move`
3. `mv ~/cortextos.snapshot-before-move ~/cortextos`
4. `npm unlink -g cortextos && cd ~/cortextos && npm install -g .`
5. `cd ~/cortextos && pm2 start ecosystem.config.js && pm2 save`
6. Telegram Josh with what failed

## Open questions for Josh before execution

1. OK to remove `~/cortextos.old/` as part of the move? (Assumes: yes.)
2. OK to leave the 48h compat symlink, or do a hard cut?
3. Move during a low-activity window, or now is fine?
4. Any external tools (editor bookmarks, iTerm profiles, cron entries) that hardcode `~/cortextos/` I should know about?
