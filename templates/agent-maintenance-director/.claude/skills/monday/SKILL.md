---
name: monday
description: "CLI for Monday.com — read boards/items, update columns, post updates, register webhooks. Use when a task references a Monday board, turnover item, or work order that lives in Monday."
triggers: ["monday", "monday.com", "turnover board", "monday item", "monday work order", "register webhook", "change column value"]
---

# Monday.com CLI

## Setup

```bash
pip install -e ~/projects/monday-connector/
export MONDAY_API_KEY=<api_key>   # from Monday > Developer > API v2 tab
```

For webhook receiver:
```
pip install fastapi uvicorn
export MONDAY_WEBHOOK_AGENT=blue   # which agent receives webhook notifications
uvicorn cli_anything.monday.webhook_backend:app --host 0.0.0.0 --port 8080
```

## Commands

### Work orders / items

```bash
monday work-orders list --board 1234567890 --json
monday work-orders list --board 1234567890 --status "Open" --status-column status --json
monday item get 9876543210 --json         # includes updates/comments
```

### Writes

```bash
# Change a status by label or numeric index
monday item update-status --item 9876543210 --column status --value "Done" --json
monday item update-status --item 9876543210 --column status --value 1 --json

# Post an update (comment)
monday item post-update --item 9876543210 --message "Vendor dispatched" --json
```

### Webhooks

```bash
monday webhook register --board 1234567890 \
  --url https://hooks.example.com/monday-webhook \
  --event change_status_column_value --json
```

Event types: `change_column_value`, `change_status_column_value`, `create_item`, `create_update`, `change_subitem_column_value`, etc.

### Probe

```bash
monday probe --json    # verify MONDAY_API_KEY
```

## Backend Map

| Command | Backend |
|---------|---------|
| work-orders list | GraphQL `items_page` |
| item get | GraphQL `items` |
| item update-status | GraphQL `change_column_value` mutation |
| item post-update | GraphQL `create_update` mutation |
| webhook register | GraphQL `create_webhook` mutation |
| probe | GraphQL `me` query |

All writes are idempotent at the Monday side (repeat calls are safe). Webhook receiver dedups in-memory by (item, type, column, before, after, changedAt).
