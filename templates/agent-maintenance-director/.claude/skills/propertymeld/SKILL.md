---
name: propertymeld
description: "CLI for Property Meld work order management. Read work orders, properties, and vendors via Nexus API; assign techs via browser automation."
triggers: ["property meld", "work order", "meld", "pm work-orders", "pm assign-tech", "meld triage"]
---

# Property Meld CLI

## Setup

```bash
pip install -e ~/projects/cli-anything-propertymeld/
# Required env vars (from agent .env):
#   PM_CLIENT_ID, PM_CLIENT_SECRET
# For assign-tech (browser backend):
#   PM_CREDS_PATH (default: ~/.claude/credentials/property-meld.json)
#   playwright install chromium
```

## Commands

### Work Orders
```bash
pm work-orders list --status open --json          # List open work orders
pm work-orders list --status pending --json       # Pending completion
pm work-orders list --limit 50 --json             # More results
pm work-orders get <meld_id> --json              # Single work order detail
pm work-orders comments <meld_id> --json         # Get comments/notes (browser)
```

### Properties & Vendors
```bash
pm properties list --json                         # All properties
pm vendors list --json                            # All vendors
```

### Tech Assignment (browser backend)
```bash
pm assign-tech --work-order-id <id> --tech Carlos --json
```

### Health Check
```bash
pm probe --json                                   # Verify API credentials
```

## Backend Notes

| Command | Backend | Requires |
|---------|---------|---------|
| work-orders list | Nexus API | PM_CLIENT_ID, PM_CLIENT_SECRET |
| work-orders get | Nexus API | PM_CLIENT_ID, PM_CLIENT_SECRET |
| work-orders comments | Browser (Playwright) | PM_CREDS_PATH + cookies |
| properties list | Nexus API | PM_CLIENT_ID, PM_CLIENT_SECRET |
| vendors list | Nexus API | PM_CLIENT_ID, PM_CLIENT_SECRET |
| assign-tech | Browser (Playwright) | PM_CREDS_PATH + cookies |
