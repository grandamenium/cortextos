---
name: v2-release-notice
description: Deliver the one-time V2 release notice after successfully applying this normal V1 update.
---

# V2 release notice

Use this only after the normal V1 update that adds this file has merged successfully. A pre-update check merely describes this post-update step; do not announce the release from the check output.

From the V1 framework checkout, using the current V1 instance's existing `CTX_ROOT`, run:

```bash
node scripts/v2-release-notice.cjs
```

If stdout contains the notice, relay that text to the owner in your current conversation. The updater can be the analyst or the orchestrator; either can relay it. Do not send a second copy through another agent. Empty stdout with exit code 0 means no notice should be sent: it was already reserved for emission on this V1 instance. A nonzero exit means the helper did not emit; report the error without substituting the announcement yourself.

The helper records a durable once-only reservation before emitting. This guarantees at-most-once helper emission, not that the agent or the human received it. If the process stops after reservation, do not delete the marker or retry the announcement manually.

This is a release notice only. Keep V1 running normally. Do not install V2, migrate agents, stop services, or change schedules as part of this notice. The owner decides whether to install V2; its orchestrator will offer to help bring agents over.
