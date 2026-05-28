# claude-usage-scrape

Hourly screenshot of `claude.ai/settings/usage` for analyst calibration. Sebastian's actual cap %ages, not estimated.

## First-run (one-time, interactive)

```bash
cd /c/Users/Sebas/cortextos/scripts/.claude-usage
node claude-usage-scrape.js --visible
```

Chromium window opens. Log in with sebastianjaa8@gmail.com (Google OAuth). Navigate to claude.ai/settings/usage (auto). Once the page renders with cap %ages visible, press Enter in the terminal. Screenshot saved.

Session persists in `user-data/` — subsequent runs auto-authenticate.

## Subsequent runs (headless, scheduled)

```bash
node claude-usage-scrape.js
```

Silent. Writes `screenshots/usage-<ISO-timestamp>.png`. Old screenshots auto-pruned after 7 days.

## Scheduling (Windows Task Scheduler, hourly)

```powershell
$action = New-ScheduledTaskAction -Execute "node.exe" -Argument "C:\Users\Sebas\cortextos\scripts\.claude-usage\claude-usage-scrape.js" -WorkingDirectory "C:\Users\Sebas\cortextos\scripts\.claude-usage"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddHours(1) -RepetitionInterval (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName "claude-usage-scrape" -Action $action -Trigger $trigger -Description "Hourly screenshot of claude.ai/settings/usage"
```

## analyst integration

analyst should read latest screenshot per scan:

```bash
ls -t /c/Users/Sebas/cortextos/scripts/.claude-usage/screenshots/usage-*.png | head -1
```

Parse via Read multimodal tool. Cap %ages live in the page UI.

## Logs

stdout `SAVED: <path>` lines append to scheduled-task log.
