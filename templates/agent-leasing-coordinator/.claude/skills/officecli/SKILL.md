---
name: officecli
effort: low
description: "Create, read, and edit Word (.docx), Excel (.xlsx), and PowerPoint (.pptx) files. Use when a task requires generating a report, analysis spreadsheet, or presentation. No Office installation needed — single binary, works offline."
triggers: ["word document", "excel", "spreadsheet", "powerpoint", "presentation", "docx", "xlsx", "pptx", "generate report", "create report", "monthly report", "owner report", "work order report", "onboarding deck", "officecli", "office document"]
---

# OfficeCLI — Word, Excel, PowerPoint from the Terminal

> Create and edit Office documents without Microsoft Office. Single binary, no auth, no cloud. Works on any file the agent can read/write.

---

## Installation

```bash
curl -L https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.47/officecli-mac-arm64 \
  -o ~/bin/officecli && chmod +x ~/bin/officecli

# Register as MCP (enables tool calls directly from Claude)
officecli mcp claude
```

Verify: `officecli --version`

---

## Core Commands

| Command | What it does |
|---------|-------------|
| `officecli create file.docx` | Create blank document |
| `officecli view file.docx outline` | Read structure (low token cost) |
| `officecli view file.docx text` | Read all text content |
| `officecli add file.docx /body --type paragraph --prop text="..."` | Add content |
| `officecli set file.docx /body/p[1]/r[1] --prop bold=true` | Edit properties |
| `officecli merge template.docx output.docx '{"key":"value"}'` | Template merge |
| `officecli batch file.docx --input ops.json` | Multi-operation batch |
| `officecli validate file.docx` | Check schema integrity |

**All commands support `--json` for structured output.**

Path addressing uses 1-based indexing: `/body/p[1]`, `/slide[2]/shape[3]`, `/$Sheet:A1`

---

## Word (.docx) Patterns

### Monthly Owner Report

```bash
# Create and populate
officecli create ~/reports/owner-report-$(date +%Y-%m).docx
DOC=~/reports/owner-report-$(date +%Y-%m).docx

# Title
officecli add $DOC /body --type paragraph \
  --prop text="AscendOps Monthly Report — $(date +%B\ %Y)" \
  --prop style=Heading1

# Sections
officecli add $DOC /body --type paragraph \
  --prop text="Maintenance Summary" --prop style=Heading2
officecli add $DOC /body --type paragraph \
  --prop text="Open work orders: N. Completed this month: N. Avg close time: X days."

# Table for key metrics
officecli add $DOC /body --type table \
  --prop rows=4 --prop cols=3 \
  --prop header="Category,Count,Avg Days"
```

### Template Merge (variable substitution)

```bash
officecli merge template.docx output.docx '{
  "owner_name": "John Smith",
  "property": "123 Main St",
  "month": "April 2026",
  "open_orders": "3",
  "completed": "12"
}'
```

---

## Excel (.xlsx) Patterns

### Work Order Analysis

```bash
officecli create ~/reports/work-orders.xlsx
XLS=~/reports/work-orders.xlsx

# Add a sheet with data from CSV
officecli add $XLS / --type sheet \
  --prop name="April WOs" \
  --prop csv=/path/to/work_orders.csv

# Add a summary formula
officecli add $XLS / --type sheet --prop name="Summary"
officecli set $XLS 'Summary!A1' --prop value="Total Open"
officecli set $XLS 'Summary!B1' --prop formula="=COUNTIF('April WOs'!D:D,\"Open\")"
```

### Set cell values and formulas

```bash
# Set a specific cell
officecli set report.xlsx 'Sheet1!A1' --prop value="Property"
officecli set report.xlsx 'Sheet1!B1' --prop value="Open WOs"

# Formula
officecli set report.xlsx 'Sheet1!C2' \
  --prop formula="=AVERAGE(B2:B20)" \
  --prop format="0.0"
```

---

## PowerPoint (.pptx) Patterns

### Onboarding / Welcome Deck

```bash
officecli create ~/reports/onboarding.pptx
DECK=~/reports/onboarding.pptx

# Title slide
officecli add $DECK / --type slide \
  --prop title="Welcome to AscendOps" \
  --prop background=1A1A2E

# Content slide
officecli add $DECK / --type slide --prop title="Your AI Agent Team"
officecli add $DECK '/slide[2]' --type shape \
  --prop text="• Dane — Orchestrator\n• Blue — PM Specialist\n• Aussie — Analyst\n• Collie — Dev Agent" \
  --prop x=2cm --prop y=4cm --prop font=Arial --prop size=20

# Live preview while building
officecli watch $DECK --port 26315
```

---

## Reading Documents

```bash
# Low-token outline (structure only)
officecli view report.docx outline

# Full text
officecli view report.docx text

# Stats (word count, page count, etc.)
officecli view report.docx stats

# JSON output for programmatic use
officecli get report.docx /body/p[1] --json
```

---

## Batch Operations (multi-step)

Write a JSON file with operations, run in one call:

```json
[
  {"op": "add", "path": "/body", "type": "paragraph", "props": {"text": "Section 1", "style": "Heading2"}},
  {"op": "add", "path": "/body", "type": "paragraph", "props": {"text": "Content here."}},
  {"op": "set", "path": "/body/p[1]/r[1]", "props": {"bold": true}}
]
```

```bash
officecli batch report.docx --input ops.json --force
```

---

## Tips

- Use `view outline` before editing — cheaper than reading the full document
- Use `--json` when the output will be parsed by code
- `merge` is fastest for templated reports — create the template once, fill it each month
- `watch` is useful when iterating on a presentation — live browser preview
- Resident mode (`officecli open` → edit → `officecli close`) reduces per-operation latency for many sequential edits

---

*No auth required. File must be accessible (not locked by another process). Supported formats: .docx, .xlsx, .pptx only.*
