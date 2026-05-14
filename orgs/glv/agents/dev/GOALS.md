# Dev Agent Goals

_Last updated: 2026-05-14 UTC — cloud session. glvmarketing.ca launch blockers **fully resolved**. Client repos: 0 open PRs across all 4 ✅. ~89 cortextos PRs waiting Aiden. ⚠️ PR #98 OPEN (Lead interface CI fix) — all CI ✅, awaiting Aiden merge. ✅ Coverage scan complete. ✅ glv-marketing theme PHP 8.x grep scan CLEAN. ⚠️ PHPCompatibility PHPCS install OVERDUE — 6 days to May 20 PHP 7.4 cutover (local agent only). ⚠️ Node 22 deadline June 2 (19 days). ✅ exp_1778496458_smku CLOSED as KEEP (2026-05-13T10:57Z). ▶️ exp_1778669306_rmkr RUNNING — REQUIRED_MARKERS fix, 24h/48h elapsed, 0 deploys, KEEP trajectory (window closes 2026-05-15T10:57Z). ⏳ mattpocock skills cherry-pick — holding for Aiden evening review approval (2+ cycles, no signal). Next autoresearch eval: 2026-05-15T10:57Z._

## Priority 0 — glvmarketing.ca Launch Status (ALL RESOLVED ✅)

**Boss dispatch 19:55 UTC May 12 resolved. All P0 blockers closed as of ~22:00 UTC May 12.**

**Final resolved state:**
- ✅ Visual fixes done
- ✅ Contact form / Resend wired
- ✅ URL hierarchy reparented (Services parent page)
- ✅ 20 pages created via REST with content (boss phase, then dev phase)
- ✅ **template-service.php 500 fixed** — infinite `have_posts()` loop in loop body; null-coalescing + icon safety added; all 17 service pages return 200
- ✅ All service pages have content — hero_subtitle, features, problem sections all populated
- ✅ case-studies/titan-tiny-homes + fusion-financial 404 fixed — CPT slug conflict resolved, rewrites flushed
- ✅ FAQ page visual fixed — `glass` class replaced, pricing violation removed, CTA aligned
- ✅ About page v3 live — QC passed by boss 2026-05-12 23:40 UTC (commit cfba7607 → PHP)
- ✅ All smoke URLs green: /, /services/, 17 service child pages, /case-studies/, 3 case study pages, /contact/, /about/, /faq/

**Remaining (local agent or Aiden action required):**
- ⏳ WP templates (template-service.php, template-case-study.php, page-about.php, page-faq.php) deployed via FTP only — not yet in glvcrypto/glvmarketing repo (SSH + git push needed)
- ✅ PR #2 CLOSED 23:15 UTC May 12 — "Superseded by live FTP deploy"
- ✅ PR #3 CLOSED 23:15 UTC May 12 — logos + Reyco partner row live-verified before close
- ✅ FAQ visual — fixed (glass class removed, pricing violation removed)
- ✅ /case-studies/{titan,fusion} 404 — CPT slug conflict resolved

**Aiden hint:** reference `glvcrypto/reyco-marine` template-service.php — same SG infra, same template name, works there.

**Cloud session NOTE:** `glvcrypto/glvmarketing` and `glvcrypto/reyco-marine` are NOT accessible from cloud (git proxy restricted to cortextos only). **Local agent must handle all glvmarketing.ca work.** See deliverable:

```
orgs/glv/clients/glv-marketing/deliverables/template-service-fix/
  template-service.php   — clean replacement template (safe, no fatal)
  APPLY.md               — diagnostic steps + SCP/git apply instructions
```

### P0-1: template-service.php 500 fix (LAUNCH BLOCKER)

**Local agent steps:**
1. SSH to SiteGround: `ssh -p 18765 giowm1155.siteground.biz -i ~/.ssh/sg-reyco`
2. Check PHP error log: `tail -100 ~/glvmarketing.ca/logs/php_error.log`
3. View current template: `cat ~/glvmarketing.ca/public_html/wp-content/themes/glv-marketing/template-service.php`
4. Compare with reyco-marine: `cat ~/reyco-marine.com/public_html/wp-content/themes/reyco-marine/template-service.php` (same server)
5. If syntax/fatal error: SCP the clean version from `deliverables/template-service-fix/template-service.php`
6. Verify 200 on a service page, then commit fix to `glvcrypto/glvmarketing`

### P0-2: Remaining 11 pages (after 500 fixed)

Pages needing proper content + template-service.php assignment:
`LocalSEO`, `GEO`, `WebsiteDesign`, `PaidAdvertising`, `ContentMarketing`, `AIAutomation`, `GoogleBusinessProfile`, `case-studies/titan`, `case-studies/fusion`, `MarketingHub`, `AutomationHub`, `CustomAIHub`

Use WP REST API or WP-CLI to assign `template-service.php` to each:
```bash
wp post meta update <ID> _wp_page_template template-service.php
wp post list --post_type=page --fields=ID,post_title,post_name --posts_per_page=50
```

### P0-3: /case-studies/{titan,fusion} 404

Rewrite cache issue. Fix: `wp rewrite flush` + verify page slugs/parents match expected URLs.

### P0-4: FAQ visual match

`page-faq.php` uses vanilla JS accordion — styling needs to match Vite design tokens. Low priority vs 500 fix.

### P0-5: deploy.yml fix (glvmarketing PR #3 prereq)

Already documented in GOALS.md Priority 1 table (glvmarketing #3). Still needs:
- Remove SPA `.htaccess` step from deploy.yml
- Change FTP target to `dist/assets/` → `wp-content/themes/glv-marketing/assets/`
- Local agent apply: exact YAML in PR #3 description

## Priority 1 — Merge Queue (blocked on Aiden review)

These PRs are complete and tested. Waiting for merge approval.

> ⚠️ CONFLICT ALERT (flagged to Aiden via Telegram + #internal-dev 2026-04-30):
>
> **Upstream drift (PARTIALLY RESOLVED — Apr 30):**
> - `a803002 fix(daemon): guard worker PTY null-write` → **RESOLVED by PR #55** (ecosystem max_restarts + crash-storm circuit breaker)
> - `3420b5b fix(test)` + 5 remaining commits NOT yet in origin/main: `a38ef7a fix(bus): hard-restart IPC`, `b6e4515 fix(daemon): CronCreate on boot`, `5f1943e fix(telegram): HTML parse mode`, `b85cb69 fix(daemon): cron-expression gap detection`, `eb119a9 fix(telegram): validate BOT_TOKEN`
> - `ecosystem.config.js` conflict **RESOLVED** — PR #55 fixes the generator (max_restarts 10, CTX_DEBUG_ALLOW_CRASH_TRIGGER passthrough)
> - PR #7 still stale — 5 remaining upstream commits still need Aiden decision: update PR #7 to include them, OR close #7 and open a fresh sync PR.
>
> **Upstream Sync Audit (2026-05-01) — file-level findings from PR #35/#36 diff:**
> PRs #35–#43 carry these 12 production src files from the 5 upstream commits:
>
> | File | Upstream change | Also in PR #55? |
> |------|-----------------|----------------|
> | `ecosystem.config.js` | CTX_DEBUG_ALLOW_CRASH_TRIGGER + max_restarts:10 | ✅ YES (duplicate — skip) |
> | `src/daemon/index.ts` | Crash-loop detection + Telegram alert (~+230 lines) | ✅ YES (PR #55 uses crash-handlers.ts; different approach, same outcome) |
> | `src/daemon/worker-process.ts` | PTY null guard (`this.pty!` → `this.pty?.`) | ✅ YES |
> | `src/pty/inject.ts` | Deferred-Enter try/catch | ✅ YES |
> | `src/hooks/hook-crash-alert.ts` | `.daemon-crashed` marker + message | ✅ YES |
> | `src/bus/cron-state.ts` | `cronExpressionMinIntervalMs()` — cron-expr gap detection | ❌ UNIQUE — not in any clean PR |
> | `src/cli/bus.ts` | `hard-restart` now sends IPC restart-agent to daemon | ❌ UNIQUE — not in any clean PR |
> | `src/cli/enable-agent.ts` | BOT_TOKEN + CHAT_ID pre-validation before registering | ❌ UNIQUE — not in any clean PR |
> | `src/cli/setup.ts` | Interactive Telegram cred validation in setup wizard | ❌ UNIQUE — not in any clean PR |
> | `src/daemon/agent-process.ts` | Boot prompt: CronCreate vs /loop + cron-expr gap | ❌ UNIQUE — not in any clean PR |
> | `src/telegram/api.ts` | HTML parse mode changes (+308/-74) | ❌ UNIQUE — not in any clean PR |
> | `src/telegram/logging.ts` | Logging tweaks (+4/-13) | ❌ UNIQUE — not in any clean PR |
>
> **Recommended action (Aiden decision needed):**
> 1. **Merge PR #55 first** (crash-storm fix, cleanest approach, passes all tests)
> 2. **Close PRs #35–#43** — test content superseded by cleaner PRs; crash-storm src covered by #55
> 3. **Open fresh `sync/upstream-remaining-5-commits`** with ONLY the 6 unique upstream files above — dev agent can create this when Aiden confirms
>
> **Immediate safe merges (no upstream sequencing needed):**
> - Docs/config only: PR #6 (.gitignore), PR #10 (cron docs), PR #20 (community skill)
> - Clean test PRs (no production src changes): #21–#34, #44–#54, #56–#68
> - Fixes: PR #55 (crash-storm), PR #16 (ecosystem PATH), PR #17 (heartbeat cron-fire)
>
> **Test PR queue conflicts:**
> - #46 (metrics) + #47 (experiment) duplicate coverage already in upstream #21 + #22 → **close #46 and #47 after #21/#22 merge**
> - PRs #35–#43 ALL carry those 5 upstream src changes rebased in → **recommend closing** (see audit above)
> - PR #42 (message HMAC) superseded by #49; PR #43 test content superseded by #21+#22

| PR | Title | Notes |
|----|-------|-------|
| glvmarketing #3 | fix: glvmarketing.ca Phase 2 regressions — logos + Reyco partner row | **Local agent action required before merge**: apply deploy.yml change (remove SPA .htaccess step, re-target dist/assets/ → WP theme assets dir). Exact YAML in PR description. WP-CLI items (permalink, PHP template, RankMath, CF7) also in PR description. |
| glvmarketing #2 | feat(wp-theme): GLV Marketing custom WordPress theme — Phase 1 | WP Phase 2 live via FTP. PR is source-control only. SLA expired 19:01 UTC May 12. Safe to merge or close. |
| #98 | fix(dashboard): add created_at and updated_at to Lead interface | CI all ✅ (Build, Unit Tests, Dashboard Build). Fixes Dashboard Build failure introduced by #86. Awaiting Aiden merge. |
| #95 | feat(skills): blotato-posting — Remotion carousel → Blotato schedule pipeline | Socials Phase 1 skill. Bridges orgs/glv Remotion pipeline to Blotato API. No src/ changes — docs only. Can merge independently. |
| #90 | feat(skills): fleet-experiments-rollup — aggregate experiment state in one call | Cycle-17 H1 deliverable. Dual-mode: bus list-experiments + Python filesystem fallback. Docs only. |
| #87 | test(bus): knowledge-base coverage — scope routing, parseOutput, ensureKBDirs, loadSecretsEnv (24 cases) | Extends existing 5-case knowledge-base.test.ts to 29 cases. Covers all untested paths: scope routing (shared/private/all), result merging, parseOutput edge cases (null/no-JSON/malformed/r.result fallback), ensureKBDirs (create/skip), loadSecretsEnv (quote strip/comments). Test-only change. ⚠️ local agent must run npm test before Aiden reviews. |
| #82 | test(bus): postActivity success + failure + replyMarkup + second-candidate coverage — 4 cases | Fills postActivity live-send path gap in system.test.ts. returns true on success, false on throw, replyMarkup forwarded, second candidate env path. 20 pre-existing + 4 new = 24/24. ⚠️ local agent must run npm test before Aiden reviews. |
| #81 | test(bus): hardRestart + autoCommit + checkGoalStaleness gap coverage — 7 cases | hardRestart (3: both markers created, HARD-RESTART log, distinct file paths), autoCommit (3: .cortextos-env blocked, node_modules/ excluded, non-git returns clean), checkGoalStaleness (1: INVALID_AGENT filtered). 15 pre-existing + 7 new = 22/22. ⚠️ local agent must run npm test before Aiden reviews. |
| #80 | test(cli): startCommand coverage — 20 cases | Last untested CLI source file. daemon-script-missing exit(1), --foreground spawn, PM2+ecosystem, PM2 throw, no-PM2 detached (fake timers), agent auto-register, org propagation, IPC success/failure, --instance. 20/20 pass. Build clean. ⚠️ local agent must run npm test before Aiden reviews. |
| #79 | test(cli): stopCommand coverage — 19 cases | Covers IPC-driven command paths missing from lifecycle-markers.test.ts. Guards: no-arg exit(2), agent+--all conflict exit(2). Daemon-down early-return. Single-agent: stop-agent IPC (success+error), .user-stop marker, --instance flag. --all: list-agents→stop-agent, list-error exit(1), empty-list, multi-agent, pm2-hint. 19/19 pass. Full suite 688/689 (pre-existing comms flake). Build clean. |
| #78 | test(dashboard): maskToken + normalizeFsPath + parseSkillMd coverage — 14 cases | Exports 3 pure helpers from dashboard actions. 14/14 pass. Build clean. |
| #77 | test(cli,dashboard): commandExists + categorizeFilePath coverage — 13 cases | SAFE_CMD regex (2) + commandExists (6, injectable spawnSync+isWindows) + categorizeFilePath (5-branch watcher classifier). 13/13 pass. Build clean. |
| #76 | test(hooks): sendCompactNotification + buildPermissionMessage coverage — 14 cases | Exports sendCompactNotification(env, fetch?) + buildPermissionMessage(agentName, toolName, summary). 14/14 pass. Build clean. |
| #75 | test(cli): list-agents + get-config + goals coverage — 25 cases | list-agents (8) + get-config (8, fixes CTX_ORG/CTX_AGENT_NAME env leakage) + goals (9, path-traversal guard). 25/25 pass. Build clean. |
| #74 | test(pty): AgentPTY coverage — 18 cases | Pre-spawn state (5) + getBinaryName (1) + buildClaudeArgs (12). vi.mock node-pty. 18/18 pass. Build clean. |
| #73 | test(cli): tunnel config helpers coverage — 8 cases | getTunnelConfigPath (2) + readTunnelConfig (3) + writeTunnelConfig (3). 8/8 pass. Build clean. |
| #72 | test(cli,hooks): workers + notify-agent + idle-flag coverage — 17 cases | spawn/terminate/list/inject-worker IPC paths (9) + notify-agent routing (4) + writeIdleFlag (4). 17/17 pass. Build clean. |
| #71 | test(cli): parseEnvFile + fixSpawnHelper coverage — 19 cases | parseEnvFile (10, dashboard.ts) + fixSpawnHelper (9, install.ts). 19/19 pass. Build clean. |
| #70 | test(cli): uninstall command coverage — 15 cases | Early-exit (3) + full uninstall (3) + --keep-state (4) + PM2 cleanup (5). 15/15 pass. Build clean. |
| #69 | test(cli): doctor command coverage — 28 cases | [OK]/[WARN]/[FAIL] output (7) + PM2/Claude CLI/PTY/gh/state-dir checks + --instance option. 28/28 pass. Build clean. |
| #68 | test(dashboard): api routes batch 12 — knowledge/search alias + SSE guard paths (10 cases) | 3 files, 10/10 pass. GET /api/knowledge/search (2) + GET /api/events/stream (3) + GET /api/messages/stream/[agent] (5). Completes non-auth API route coverage sprint. vitest.config.ts: restore @api-media-route + add @api-messages-stream-route. 679 pass + 1 pre-existing. Build clean. |
| #67 | test(dashboard): api routes batch 11 — kb/search + messages/upload + media (21 cases) | 3 files, 21/21 pass. GET /api/kb/search (9) + POST /api/messages/upload (7) + GET /api/media/[...filepath] (5). vitest.config.ts: @api-media-route alias for bracket-dir import. 690 pass full suite + 1 pre-existing. Build clean. |
| #66 | test(dashboard): api routes batch 10 — lifecycle + comms/channel + comms/upload + kb (30 cases) | 4 files, 30/30 pass. POST+DELETE /api/agents/[name]/lifecycle (13) + GET /api/comms/channel/[pair] (7) + POST /api/comms/upload (5) + GET /api/kb/collections (5). 699 pass full suite + 1 pre-existing. Build clean. |
| #65 | test(dashboard): api routes batch 9 — auth/mobile + mcp/restart + comms (25 cases) | 4 files, 25/25 pass. POST /api/auth/mobile (7) + POST /api/mcp/restart (7) + GET /api/comms/channels (5) + GET /api/comms/feed (6). 694 pass full suite + 1 pre-existing. Build clean. |
| #64 | test(dashboard): api routes batch 8 — messages/send + messages/history + notifications/register + mcp (30 cases) | 4 files, 30/30 pass. POST /api/messages/send (7) + GET /api/messages/history/[agent] (7) + POST /api/notifications/register (6) + GET+POST+DELETE /api/mcp (10). 702 pass full suite + 1 pre-existing. Build clean. |
| #63 | test(dashboard): api routes batch 7 — agents/[name] main + crons + config + settings/users + commands (49 cases) | 5 files, 49/49 pass. GET+PATCH /api/agents/[name] (9) + GET+PUT /api/agents/[name]/crons (12) + GET+PATCH /api/agents/[name]/config (13) + GET+POST+DELETE /api/settings/users (9) + GET /api/commands (6). 718 pass full suite + 1 pre-existing. Build clean. |
| #62 | test(dashboard): api routes batch 6 — agents/[name] sub-routes (27 cases) | 4 files, 27/27 pass. GET /api/agents/[name]/logs (6) + GET /api/agents/[name]/typing (5) + GET+PATCH /api/agents/[name]/goals (10) + GET /api/agents/[name]/memory (6). 696 pass full suite + 1 pre-existing. Build clean. |
| #61 | test(dashboard): api routes batch 5 — analytics + tasks/[id] + leads/[id] + content/[id] (40 cases) | 4 files, 40/40 pass. GET /api/analytics/overview (6) + GET/DELETE/PUT/PATCH /api/tasks/[id] (20) + GET/PATCH/DELETE /api/leads/[id] (7) + GET/PATCH/DELETE /api/content/[id] (7). 709 pass full suite + 1 pre-existing. Build clean. |
| #60 | test(dashboard): api routes batch 4 — org/config + settings + clients (29 cases) | 4 files, 29/29 pass. GET+PATCH /api/org/config (12) + GET+PUT /api/settings/system (7) + GET /api/settings/telegram (5) + GET /api/clients (5). 698 pass + 1 pre-existing. Build clean. |
| #59 | test(dashboard): api routes batch 3 — experiments + skills + sync + agents (35 cases) | 4 files, 35/35 pass. GET /api/experiments (9) + GET/POST/DELETE /api/skills (14) + GET+POST /api/sync (2) + GET /api/agents + POST validation (10). 704 pass full suite + 1 pre-existing (comms timestamp). Build clean. |
| #58 | test(dashboard): api routes batch 2 — approvals + leads + outreach + content (35 cases) | 5 files, 35/35 pass. GET /api/approvals (6) + GET+PATCH /api/approvals/[id] (10) + GET+POST /api/leads (7) + GET /api/outreach (5) + GET+POST /api/content (7). 696 pass full suite + 9 pre-existing (8 git-signing + 1 comms). Build clean. |
| #57 | test(dashboard): src/lib + lib/data + api routes — 22 commits, 336 cases | 22 commits on branch test/dashboard-lib-coverage. lib+data (290): cost-parser (17) + comms-identity (13) + config (39) + rate-limit (6) + ipc-client (8) + auth (10) + heartbeats (18) + goals (8) + agents-paths (11) + events (22) + tasks (27) + approvals (17) + leads (21) + outreach (20) + analytics (14) + content (21) + reports (12) + organization (6). API routes (46): GET+PATCH /api/goals (19) + GET /api/events (14) + GET+POST /api/tasks (13). Full suite 999/1000 + 1 pre-existing. Build clean. |
| #56 | test(dashboard): markdown-parser pure helpers — parseMarkdown + Identity/Soul/Goals (38 cases) | 38/38 pass. First coverage for dashboard/src/lib/. Covers parseMarkdown/serializeMarkdown round-trip safety, parseIdentityMd/parseSoulMd/parseGoalsMd + serializers, case-insensitive section matching, heading alias resolution. 672 pass full suite + 8 pre-existing. Build clean. |
| #55 | fix(daemon): ecosystem max_restarts 50→10 + crash-storm circuit breaker (a803002) | 2 commits. Commit 1: max_restarts 50→10 daemon+dashboard, CTX_DEBUG_ALLOW_CRASH_TRIGGER slot. Commit 2: crash-handlers.ts (new), uncaughtException/unhandledRejection + Telegram alert at 3 crashes/15min, PTY null-write guard (worker-process.ts), deferred-Enter try/catch (inject.ts), daemon-crashed hook variant. 17 new cases (651 pass + 8 pre-existing). Build clean. |
| #54 | test(hooks): findMostRecentPlan + readPlanContent + buildContextStatusPayload (25 cases) | 25/25 pass. Exports 2 helpers from hook-planmode-telegram.ts + extracts payload builder from hook-context-status.ts. Covers mtime-sort, empty/missing dirs, readdirSync error, line-truncation, all null-coercion branches. Build clean. |
| #53 | fix(heartbeat): Step 5b outbound-log staleness filter — cloud session false-positive suppression | Docs-only. Adds suppress/fire truth table to HEARTBEAT.md. Analyst-calibrated 2026-04-30. |
| #52 | test(hooks): generateId + waitForResponseFile + cleanupResponseFile coverage (8 cases) | 8/8 pass. Covers hex-format check, uniqueness, file-pre-exists, fs.watch late-write, timeout→null, delete, no-op, idempotent. Build clean. |
| #51 | test(telegram): TelegramAPI method coverage — sendMessage + answerCallbackQuery + editMessageText + sendChatAction + setMyCommands (17 cases) | 17/17 pass. Adds 17 cases to existing 2 in api.test.ts. Covers parse-mode fallback, sanitizeMarkdown, chunking, retry logic, all 5 methods. Build clean. |
| #50 | test(utils): lock.ts stale-lock + corrupt-PID + releaseLock idempotency (3 cases) | 6/6 pass (3→6 total). Covers dead-PID stale recovery, NaN/corrupt PID, releaseLock no-op. Build clean. |
| #49 | test(bus): message.ts security + error-recovery gaps (9 cases) | 9/9 pass. HMAC signing/verification paths + corrupt JSON + stale inflight recovery + ackInbox no-match. Build clean. |
| #48 | test(cli): writeDisableMarker (BUG-036) coverage — 4 cases | 16/16 pass. Additive to existing enable-agent-validation.test.ts. |
| #47 | test(bus): experiment.ts coverage — 27 tests | ⚠️ SUPERSEDED by #22. Close after #22 merges. |
| #46 | test(bus): metrics.ts coverage — parseUsageOutput + storeUsageData + collectMetrics (21 cases) | ⚠️ SUPERSEDED by #21. Close after #21 merges. |
| #45 | test(bus): catalog browseCatalog + prepareSubmission + submitCommunityItem + installCommunityItem gaps (50 cases) | 50/50 pass. Build clean. |
| #44 | test(bus): fill coverage gaps in agents + approval modules | Adds 6 agents tests + 7 approval tests. Build clean. |
| #41 | test(cli): setup validators + dashboard env helpers (56 cases) | 56/56 pass. Build clean. |
| #34 | test(cli): ecosystem buildDashboardBlock + buildEcosystemContent (34 cases) | 34/34 pass. Build clean. |
| #33 | test(cli): bus.ts pure helpers — parseDisplayNameFromLines + checkDeliverableRequirement + pct (28 cases) | 28/28 pass. Build clean. |
| #32 | test(cli): add-agent helpers createAgentsMd + findTemplateDir + copyTemplateFiles + createMinimalAgent (37 cases) | 37/37 pass. Build clean. |
| #31 | test(cli): init findOrgTemplateDir + copyOrgTemplateFiles + buildAgentSystemMd (31 cases) | 31/31 pass. Build clean. |
| #30 | test(cli): status formatUptime + formatHeartbeatAge (30 cases) | 30/30 pass. Build clean. |
| #29 | test(cli): get-config resolveConfig + formatConfigText (33 cases) | 33/33 pass. Build clean. |
| #28 | test(cli): goals isValidGoalsName + buildGoalsMd (33 cases) | 33/33 pass. Build clean. |
| #27 | test(daemon): IPCServer + IPCClient (30 cases) | Real Unix socket tests. 30/30 pass. Build clean. |
| #26 | test(cli): list-skills parseFrontmatter + scanSkillsDir (23 cases) | 23/23 pass. Build clean. |
| #25 | test(hooks): crash-alert 29-case suite | isQuietHoursLA + detectRateLimitInLog + shouldSuppressDedup. 29/29 pass. |
| #24 | test(pty): 18-case unit suite for redactSecrets | JWT redaction security function. 18/18 pass. Build clean. |
| #23 | test(utils): atomic + paths + env + random (64 cases) | Completes src/utils/ coverage. 64/64 pass. Build clean. |
| #22 | test(bus): event + experiment + save-output (56 cases) | Completes src/bus/ coverage. 56/56 pass. Build clean. |
| #43 | test(bus): event + heartbeat + save-output coverage | ⚠️ Contains 5 production src changes + test content superseded by #21/#22. Audit src changes before merge. |
| #42 | test(bus): message.ts HMAC security + edge cases | ⚠️ Contains 5 production src changes + likely superseded by #49. Audit src changes. |
| #39 | test(validate): validateOrgName coverage | ⚠️ Contains 5 production src changes. Audit src changes before merge. |
| #38 | test(bus): extend cron-state suite — cronExpressionMinIntervalMs + parseDurationMs edge cases | ⚠️ Contains 5 production src changes. Audit src changes before merge. |
| #37 | docs(event-logging): severity landmine note — warn is invalid, use warning | ⚠️ Contains 5 production src changes alongside docs. Audit src changes before merge. |
| #36 | test(bus): save-output copy/move/collision/linking (22 cases) | ⚠️ Contains 5 production src changes. Audit src changes before merge. |
| #35 | test(utils,pty,bus): env/paths/random/atomic/redact/event/heartbeat (133 cases) | ⚠️ Contains 5 production src changes + superset of #23. Audit src changes before merge. |
| #21 | test(bus): heartbeat + metrics (36 cases) | 36/36 pass. Build clean. |
| #19 | feat(accounting): expense tracking dashboard + fx-fetcher CLI | Task #19 — clean cherry-pick, 7 commits. Build clean. |
| #17 | fix(heartbeat): Option A — add update-cron-fire to template Step 1 | Merge with #14 for full FP elimination |
| #14 | fix(daemon): Option B — seed cron-state.json at startup | Merge with #17 |
| #16 | fix(ecosystem): pin node bin dir into PATH | Fleet-verified on 12 agents |
| #15 | feat: 3 scout specs (approval queue aging, ctx pre-alert, proposal KPI) | User-approved specs |
| #18 | feat(prospector): n8n Gmail send workflow | active: false until Aiden approves + SPF/DKIM verified |

## Priority 2 — Active Workstreams

### Reyco Marine

- **⚠️ PHP 7.4 → 8.x migration — DEADLINE May 20, 2026 (8 days)** — SiteGround drops PHP 7.4 support site-wide. Reyco Marine custom theme must be PHP 8.x-compatible before then.
  - Files to audit: `functions.php`, `header.php`, `footer.php`, `single-product.php`, `service-detail.php`, `inc/class-resend-mailer.php`, `front-page.php`, `subcategory-section.php`
  - Key patterns to check: `each(`, `create_function(`, `(real)` cast, old-style constructors, `${` string interpolation, `ereg`/`split`
  - **✅ Cloud grep scan (2026-05-03 ~08:00 UTC)**: GitHub code search across master branch — zero hits on all critical PHP 7.4→8.x removed/deprecated patterns: `each(`, `create_function(`, `(real)`, `ereg`/`split(`, `${` interpolation, `mysql_*`, old-style constructors, `function match` keyword conflict. Master branch is clean on grep-level checks. `Reyco_Resend_Mailer` (PR #130) not yet on master — verify when merged.
  - Recommended action: run full PHPCompatibility PHPCS scan on dev machine checkout + test staging against PHP 8.1 for behavioral-change coverage (null coercion, match keyword, dynamic properties). Cloud grep scan reduces risk but doesn't substitute for full tool scan.
  - Requires: reyco-marine checkout for full scan (not available in cloud sessions — local agent must run before May 10)
- **⚠️ WordPress 7.0 — ALSO drops May 20, 2026** — SAME DAY as SiteGround PHP cutover = double-change day risk. WP 7.0 raises PHP minimum to 7.4 (our migration-FROM version — should pass). New features: real-time co-editing, Web Client AI API, refreshed admin. Recommend testing Reyco on WP 7.0 staging before May 20.
  - **PHP 8.3 note:** SiteGround migration target is PHP 8.1 (EOL Dec 31, 2025 — already EOL). Consider requesting PHP 8.3 (actively maintained through Dec 2027) if SiteGround allows on the hosting plan.
  - Source: Context7 weekly stack scan 2026-05-08 ~14:56 UTC.
- **WC 10.7 HPOS audit** — cloud GitHub code search (2026-05-05): zero hits on `wp_postmeta`, `get_post_meta`, `update_post_meta`, `get_posts`, and WC REST v1/v2/v3 across master branch. Theme is a display layer only — no custom order-management code. Low HPOS risk. Recommend local agent run `WP_DEBUG=true` smoke test after WC 10.7 upgrade to catch any runtime surprises.
  - Experiment `exp_1777768046_php8g` — **DECIDED: KEEP** (2026-05-04T20:18Z). Zero PHP deploys in 48h window; gate correct; master branch clean. Closed.
  - Experiment `exp_1777925922_phpc` — **✅ CLOSED → decision: IMPLEMENT** (closed 2026-05-06T20:18Z). PHPCompatibility PHPCS gate for PHP 7.4→8.x behavioral changes. **🚨 DEADLINE PASSED (midnight UTC May 10) — local agent must install NOW:** `composer global require squizlabs/php_codesniffer phpcompatibility/php-compatibility` + `phpcs --config-set installed_paths $(composer config -g home)/vendor/phpcompatibility/php-compatibility/PHPCompatibility` + add step 4.75 to pre-push checklist (block on ERROR, warn on WARNING). PHP deadline May 20 (8 days) makes this mandatory.
- **Path C booking form** — interim wp_mail form + calendar embed slot. Standing by for Aiden spot-check on v2 service pages.
- **Visual regression CI** — PR #75 closed 2026-05-04 (no Playwright CI planned at this time).
- **Lightspeed product sync** — 58 products still missing images (Mercury 38, Toro 7, Cub Cadet 10, Princecraft 3). Root cause: not yet synced from Lightspeed to WC. Unblocked when Casey runs sync.
- **Open PRs:** 0 ✅ — PR #234 (mobile CTA spacing) and PR #189 (Casey-twice fix) both resolved by Aiden as of 2026-05-10–11.

### WC Pricing Sweep

- **Held** — pending pentester clearance on WP admin credential request.

## Priority 3 — Pending Sequencing Decisions

| PR | Title | Blocked On |
|----|-------|----------|
| #7 | sync: upstream 17-commit merge | Aiden merge decision |
| #8 | feat(dashboard): Clients/Reyco tabs | Depends on #7 merge order? |
| #11 | fix(auto-commit): gate .db + .gitignore (draft) | Sync #7 sequencing |
| #20 | feat(community): add page-by-page-audit skill | Can merge independently (docs only) |
| #10 | docs(cron): loop skill cron-fire protocol | Can merge independently |
| #6 | chore: .gitignore .db artifacts | Can merge independently |

## Completed (Recent)

- **2026-05-13 — PR #98 OPEN** (13:51 UTC): fix(dashboard): add created_at + updated_at to Lead interface. Fixes Dashboard Build CI failures introduced after #86 merged. All CI ✅ — awaiting Aiden merge.
- **2026-05-13 — soosackers PR #7 MERGED + DEPLOYED** (14:33 UTC): `54c75de4` — fix(seo): always include item field in BreadcrumbList JSON-LD. CI deployed to SiteGround. GSC "Missing field item in itemListElement" will clear in 1–2 crawl cycles.
- **2026-05-13 — reyco-marine PR #239 MERGED** (13:26 UTC): `4d89e5af` — feat(routing): serve /llms.txt and /llms-full.txt via template_redirect. CI deploy to reycomarine.com triggered.
- **2026-05-13 — cortextos PRs #97 + #96 MERGED** (13:26 UTC): #97=`e31fa9eb` feat(daemon): MEMORY.md size enforcement + cron-fire auto-stamp on gap nudge; #96=`abbece82` fix(bus): manage-cycle agentDir CWD fix.
- **2026-05-13 — cortextos test batch #89/#91/#92/#93/#94 MERGED** (13:26 UTC): registerTelegramCommands (4), logEvent (9), heartbeat (16), saveOutput (10), checkUpstream (8) — all test-only, CI clean.
- **2026-05-13 — cortextos PRs #83/#84/#85/#86 MERGED** (01:52 UTC): Node.js 20→22 LTS (#83), comms timestamp flake fix (#84), viewport export fix (#85), Lead interface closing brace (#86).

- **2026-05-12 — blotato-posting community skill** (cloud session): `community/skills/blotato-posting/SKILL.md` built (182 lines). Bridges Remotion carousel pipeline (Phase 0, e30dd51) to Blotato scheduling API. PR #95 opened on `feat/blotato-posting-skill`.
- **2026-05-11 — GLV Marketing WP Phase 2 DONE** (cloud session): theme `glv-marketing` (28 files) uploaded via FTP + activated; CF7 + Rank Math + WP Importer plugins installed; 11 pages created + reading settings + permalinks; 24 blog posts imported from Supabase WXR; CF7 forms (GLV Contact ID 6, GLV Lead ID 42) created; site title set; all 11 routes 200 ✅. glvmarketing PR #2 still open for source version control.
- **2026-05-11 — Titan Tiny Homes floating CTA** (cloud session): `FloatingMeetingButton.tsx` + `MeetingModal.tsx` built; 15s/30%-scroll auto-popup once-per-session; Resend wired via Supabase send-email function → joseph@titantinyhomes.ca; site-wide joeyrattan@ → joseph@ sweep (Contact, Footer, Privacy, Terms, schema.org). PR #5 squash-merged SHA `3d8dc88` + GHA deployed to SiteGround ✅. Bundle smoke check: joseph@ 10x, joeyrattan@ 0, CTA code confirmed.
- **2026-05-11 — GLV Socials Phase 0** (cloud session): Remotion 4.0.459 carousel pipeline at `orgs/glv/clients/glv-marketing/socials/remotion/`. GLV brand tokens, 3 slide types, 2 compositions (1080×1350 + 1080×1080). Batch render script + 10 test stills confirmed. Committed to cortextos main (e30dd51).

- reyco-marine PR #238 (merged 2026-05-08 23:51 UTC) — feat(canonical): contact email info@reycomarine.com — customizer default + LocalBusiness schema + wp_mail_from filter + about.php RECIPIENTS fix
- reyco-marine PR #237 (merged 2026-05-08) — fix: mixed-content HTTPS — `is_ssl()` false behind SiteGround reverse proxy → assets on `http://`; 3 hooks: init HTTPS flag + script/style URL rewrite filters
- reyco-marine PR #236 (merged 2026-05-08) — fix(homepage): adventure-tab label "Water" → "Marine"
- reyco-marine PR #235 (merged 2026-05-08) — feat(forms): multi-recipient contact forms (info@+parts@+sales@ RECIPIENTS) across all 4 forms: class-resend-mailer.php, contact.php, service-detail.php, notify-me.php
- reyco-marine PR #134 (merged 2026-05-04) — fix(home): adventure-tabs grid cols 5→4 after snow hide
- reyco-marine PR #133 (merged 2026-05-04) — fix(visibility): hide snow equipment carousels + megamenu (no scope yet)
- reyco-marine PR #132 (merged 2026-05-04) — fix(nav): megamenu hover = orange box over white text + bump font 2pt
- reyco-marine PR #131 (merged 2026-05-04) — fix(nav): megamenu dropdowns blue+white+orange hover
- reyco-marine PR #130 (merged 2026-05-04) — feat(forms): Resend SMTP relay (all wp_mail() calls); needs `REYCO_RESEND_API_KEY` in wp-config.php + reycomarine.com domain verified in Resend to go live
- reyco-marine PR #129 (merged 2026-05-04) — fix(nav): bold weight + orange underline hover on desktop nav
- reyco-marine PR #125 (merged 2026-05-04) — feat(seo): admin-trigger batch write handler for meta descriptions + image alt
- reyco-marine PR #75 (closed 2026-05-04) — docs(ci): Playwright visual regression design doc (no CI planned)
- reyco-marine PR #25 (closed 2026-05-04) — feat(email): Resend scaffold (superseded by #130)
- reyco-marine PR #128 (merged 2026-05-02) — fix(carousel): hide empty carousel sections site-wide; sha `586a873a`
- reyco-marine PR #127 (merged 2026-05-02) — fix(homepage): product spotlight Princecraft placeholder → Vectra 21 + footer Reyco logo inline style; sha `493ba68d`
- reyco-marine PR #126 (merged 2026-05-02) — fix(footer): GLV logo oversized — replaced uncompiled Tailwind h-[108px] with inline style; sha `2d453a0`
- reyco-marine PR #124 (merged 2026-05-01) — feat(seo): WC products JSON export for SEO audit; squash-merged `cada21d`
- reyco-marine PRs #121/#122/#123 (merged 2026-04-30) — hero images auto-merged under Reyco policy
- soosackers PR #6 (opened 2026-04-30) — fix(seo): Teams breadcrumb missing item URL + SchedulePage JSON-LD; needs Aiden review
- PR #12 (merged) — outreach tab auto-refresh 30s poll
- PR #9 (merged) — suppress repeat gap-nudges within 1× cron interval
- PR #5 (merged) — Leads Pipeline Kanban
- PR #4 (merged) — Content Calendar
- Reyco v2 service-page sprint — 11/11 pages deployed
- Reyco image import — 127/185 products have images
