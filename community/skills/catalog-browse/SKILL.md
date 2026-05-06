---
name: catalog-browse
description: "Browse the community catalog for new skills, agent templates, and org templates. Discover what is available and recommend useful items to the user."
triggers: ["catalog", "browse skills", "community", "find skill", "new skills available", "what skills"]
external_calls: []
---

# Catalog Browse

Discover new skills, agent templates, and org templates from the community catalog. Recommend useful items to the user and install with approval.

## When to Run

- Weekly cron (configured via `cortextos bus add-cron`)
- When user asks about available skills
- When an agent needs a capability that might exist in the catalog

## Workflow

### Step 1: Browse the catalog

```bash
# Browse all items
RESULT=$(cortextos bus browse-catalog)

# Filter by type
RESULT=$(cortextos bus browse-catalog --type skill)

# Filter by tag
RESULT=$(cortextos bus browse-catalog --type skill --tag email)

# Search by keyword
RESULT=$(cortextos bus browse-catalog --search "content")
```

### Step 2: Review results

The output includes:
- Item name, description, author
- Type (skill, agent, org)
- Tags and dependencies
- Whether already installed

### Step 3: Recommend to user

For items that look useful:
- Explain what the skill does
- Which agent would benefit
- Send recommendation via Telegram

### Step 4: Install (with approval)

```bash
# Dry run first
cortextos bus install-community-item <item-name> --dry-run

# Install after user approves
cortextos bus install-community-item <item-name>
```

## Config

Requires `ecosystem.catalog_browse.enabled: true` in config.json.

## Notes

- The catalog is fetched during upstream sync (`cortextos bus check-upstream`) and lives at `community/catalog.json` in the framework root
- Items are reviewed by the community before being listed
- Always dry-run before installing
