---
domain: [reliability, observability]
applies_to: [engineer, devops, fullstack, analyst, boss]
severity: blocker
---

# Filesystem watch alone misses sub-cadence outages; pair with out-of-band liveness probe

**The watch's resolution can't be coarser than the smallest outage you care about.** cortextOS analyst's heartbeat ran every 4h with a "stale heartbeat >5h" flag threshold. On 2026-05-07 boss had a 110-min outage from `/System/Volumes/Data` filling to 100% (135Mi free). The hook-crash-alert.ts (a SessionEnd hook) correctly alerted Saurav directly, who freed disk; analyst missed the outage entirely because the next 4h heartbeat fired post-recovery and the staleness threshold was 5h > 2h-outage.

## Pattern fix

Pair the every-Nh integrity audit with continuous out-of-band probes:
- File-system hooks (e.g. SessionEnd hook for Claude Code crashes)
- Disk-full check on every heartbeat
- TTL-based liveness on critical state files

## Rule of thumb

If your watch fires every Nh, you're forensic-only on outages shorter than N. Hooks are the live alarm; the watch is the forensic record. Both are necessary. Closing the gap is not "make the watch faster" but "add a hook for the failure mode the watch can't resolve."

## Source incident

Micro-retro 2026-05-07 — analyst's missed-outage-detection during boss's 110-min ENOSPC. Same shape recurs for any "X every Nh" reliability surface.
