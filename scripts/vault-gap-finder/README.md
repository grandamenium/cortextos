# vault-gap-finder

Scans Sebastian's Obsidian vault for knowledge-quality gaps. Built per build menu E2.

## What it finds

- **Orphan links** — `[[Target]]` wikilinks where the target file doesn't exist. Fix: create stub OR remove link.
- **Dead-end files** — files with zero inbound links. Fix: link from an index file OR archive if obsolete.
- **Thin stubs** — files under 200 chars. Fix: flesh out OR delete.

## Usage

```bash
# Weekly auto-write to vault Knowledge/system/vault-gap-report-<YYYY-MM-DD>.md
python C:/Users/Sebas/cortextos/scripts/vault-gap-finder/gap_finder.py

# Just print, don't write
python gap_finder.py --report-only

# Include _archive/ folders (default: skip)
python gap_finder.py --include-archive

# Different vault root
python gap_finder.py --vault /path/to/other/vault
```

## What's scanned

Folders: `Knowledge`, `Deliverables`, `Sessions`, `Projects`, `Ideas`, `People`, `Daily`

Skipped: `_archive`, `_trash`, `_AI_Inbox`, `.obsidian`, `.trash`

## What's NOT a gap

- Cross-system wikilinks (e.g., vault `[[feedback_memory_name]]` pointing to seb_boss memory files OUTSIDE vault) WILL show as orphan. Those are intentional cross-references — not actual orphans. Future enhancement: add memory-dir resolver.
- Headers in [[Page#Header]] links — script only checks page existence, not header. Fine for now.

## Scheduling

Weekly Sunday morning cron via cortextos:

```yaml
# In seb_boss crons.json
- name: vault-gap-finder-weekly
  schedule: "0 8 * * 0"  # Sunday 8am ET
  command: "python C:/Users/Sebas/cortextos/scripts/vault-gap-finder/gap_finder.py"
  on_fire: "Surface report to Sebastian if delta vs last week (more orphans / new dead-ends) > 10%"
```

Sunday brief surfaces the report. Sebastian reviews + fixes any new gaps. Idempotent (re-run after fixes verifies clean).

## Output location

`C:/Users/Sebas/OneDrive/Documentos/Obsidian Vault/Knowledge/system/vault-gap-report-<YYYY-MM-DD>.md`

## Baseline (first run 2026-05-28)

- Scanned: 160 .md files
- Orphan links: 149
- Dead-ends: 92
- Thin stubs: 3

The 149 orphan-link count is INFLATED by cross-system links to seb_boss memory files (outside vault). Real vault-internal orphans are probably ~30-50. Future: filter cross-system links.

## Portability

Pure Python, no external deps beyond stdlib (`pathlib`, `re`, `argparse`, `collections`, `datetime`). Runs anywhere Python 3.8+.

Move with vault + scripts dir. Re-cron on target host.
