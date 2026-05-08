---
domain: [daemon, supervisors, deployment]
applies_to: [engineer, devops]
severity: blocker
---

# launchd KeepAlive: {SuccessfulExit: false} doesn't restart on clean SIGTERM exit 0

**The dict form treats exit 0 as "intentional shutdown — don't restart," which is correct for one-shot tasks but wrong for a long-lived process you want to keep alive.**

A `kill -TERM <pid>` trips this — daemon shuts down gracefully with exit 0, supervisor considers it done, daemon stays dead.

## Pattern fix

For long-lived daemons, use plain `KeepAlive: true` (launchd) or `Restart=always` (systemd). These restart on ANY exit, including clean SIGTERM.

```xml
<!-- launchd plist -->
<key>KeepAlive</key>
<true/>
```

vs the trap:

```xml
<!-- WRONG for long-lived daemons -->
<key>KeepAlive</key>
<dict>
  <key>SuccessfulExit</key>
  <false/>
</dict>
```

## Rule of thumb

`{SuccessfulExit: false}` is for one-shot tasks (cron-style). `KeepAlive: true` is for daemons. If your process is supposed to run forever and you want it restarted whenever it dies for ANY reason, use the simpler form.
