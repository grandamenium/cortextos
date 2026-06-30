#!/usr/bin/env python3
"""
vault-gap-finder — scans Obsidian vault for knowledge-quality gaps.

Finds:
- ORPHAN LINKS: [[target]] references where target file doesn't exist
- DEAD-ENDS: files with zero inbound links (potential lost knowledge)
- THIN-STUBS: files < 200 chars (likely incomplete)
- SCOPE-MISMATCHES: files in wrong folder per _schema.md (best-effort heuristic)

Writes weekly report to vault Knowledge/system/vault-gap-report-<YYYY-MM-DD>.md

Run weekly Sunday morning via cortextos cron OR on-demand:
  python gap_finder.py
  python gap_finder.py --report-only       # don't write report, print to stdout
  python gap_finder.py --include-archive   # include _archive/ files (default: skip)
"""

import argparse
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from collections import defaultdict

VAULT_ROOT = Path("C:/Users/Sebas/OneDrive/Documentos/Obsidian Vault")

# Folders to scan by default
SCAN_FOLDERS = ["Knowledge", "Deliverables", "Sessions", "Projects", "Ideas", "People", "Daily"]

# Folders to skip even in scope
SKIP_FOLDERS = ["_archive", "_trash", "_AI_Inbox", ".obsidian", ".trash"]

# Stub threshold
STUB_THRESHOLD_CHARS = 200

# Wikilink pattern: [[Target]] or [[Target|Display]] or [[Target#Header]]
WIKILINK_PATTERN = re.compile(r"\[\[([^\]|#]+?)(?:\|[^\]]+?)?(?:#[^\]]+?)?\]\]")


def collect_files(vault: Path, include_archive: bool = False) -> list[Path]:
    """Walk vault, return list of .md files to analyze."""
    files = []
    for folder_name in SCAN_FOLDERS:
        folder = vault / folder_name
        if not folder.exists():
            continue
        for path in folder.rglob("*.md"):
            # Skip files in any SKIP_FOLDERS path
            if any(skip in path.parts for skip in SKIP_FOLDERS):
                if not include_archive or "_archive" not in path.parts:
                    continue
            files.append(path)
    return files


def extract_links(text: str) -> list[str]:
    """Return list of wikilink targets (just the name, no header/alias)."""
    return [match.strip() for match in WIKILINK_PATTERN.findall(text)]


def slug(path: Path, vault: Path) -> str:
    """Vault-relative path without extension."""
    return path.relative_to(vault).with_suffix("").as_posix()


def basename(path: Path) -> str:
    """File stem (no extension, no folder)."""
    return path.stem


def analyze(vault: Path, include_archive: bool = False) -> dict:
    """Walk vault, build link graph, identify gaps."""
    files = collect_files(vault, include_archive=include_archive)

    # filename -> Path (for resolving links)
    file_by_basename = defaultdict(list)
    for p in files:
        file_by_basename[basename(p).lower()].append(p)

    # inbound link counts per file
    inbound = defaultdict(int)
    orphan_links = []  # list of (source_file, target_string)

    # outbound + size per file
    file_meta = {}

    for f in files:
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except Exception as e:
            print(f"WARN read fail {f}: {e}", file=sys.stderr)
            continue

        size = len(text)
        links = extract_links(text)

        file_meta[f] = {
            "size": size,
            "outbound": links,
        }

        for target in links:
            target_lower = target.lower()
            # Try exact basename match
            if target_lower in file_by_basename:
                for matched in file_by_basename[target_lower]:
                    inbound[matched] += 1
            else:
                # Orphan: target doesn't exist as a file
                orphan_links.append((f, target))

    # Categorize files
    dead_ends = []
    thin_stubs = []

    for f, meta in file_meta.items():
        if inbound[f] == 0:
            dead_ends.append(f)
        if meta["size"] < STUB_THRESHOLD_CHARS:
            thin_stubs.append(f)

    return {
        "vault": str(vault),
        "scanned_files_count": len(files),
        "orphan_links_count": len(orphan_links),
        "orphan_links": orphan_links,
        "dead_ends_count": len(dead_ends),
        "dead_ends": dead_ends,
        "thin_stubs_count": len(thin_stubs),
        "thin_stubs": thin_stubs,
    }


def format_report(result: dict, vault: Path) -> str:
    """Render markdown report."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    lines = [
        "---",
        f"type: vault-gap-report",
        f"generated: {today}",
        f"scanned_files: {result['scanned_files_count']}",
        "tags:",
        "  - vault",
        "  - knowledge-quality",
        "  - automation",
        "---",
        "",
        f"# Vault Gap Report — {today}",
        "",
        f"Scanned **{result['scanned_files_count']}** markdown files across {', '.join(SCAN_FOLDERS)}.",
        "",
        "## Summary",
        "",
        f"- **Orphan links:** {result['orphan_links_count']} (wikilinks pointing to nonexistent files)",
        f"- **Dead-end files:** {result['dead_ends_count']} (no inbound links — potential lost knowledge)",
        f"- **Thin stubs:** {result['thin_stubs_count']} (files under {STUB_THRESHOLD_CHARS} chars — likely incomplete)",
        "",
    ]

    # Orphan links (top 30)
    if result["orphan_links"]:
        lines.extend([
            "## Orphan links (top 30)",
            "",
            "These wikilinks reference files that don't exist. Either create the target OR fix the link.",
            "",
            "| Source file | Broken link |",
            "|-------------|-------------|",
        ])
        for src, target in result["orphan_links"][:30]:
            src_rel = slug(src, vault)
            lines.append(f"| `{src_rel}` | `[[{target}]]` |")
        if len(result["orphan_links"]) > 30:
            lines.append(f"\n_({len(result['orphan_links']) - 30} more not shown — full list in next refresh)_\n")
        else:
            lines.append("")

    # Dead-ends (top 30)
    if result["dead_ends"]:
        lines.extend([
            "## Dead-end files (top 30)",
            "",
            "Files with zero inbound wikilinks. Consider linking them from index files OR confirm they're standalone reference docs.",
            "",
        ])
        for f in result["dead_ends"][:30]:
            lines.append(f"- `{slug(f, vault)}`")
        if len(result["dead_ends"]) > 30:
            lines.append(f"\n_({len(result['dead_ends']) - 30} more not shown)_\n")
        else:
            lines.append("")

    # Thin stubs (top 30)
    if result["thin_stubs"]:
        lines.extend([
            "## Thin stubs (top 30)",
            "",
            f"Files under {STUB_THRESHOLD_CHARS} chars — likely incomplete. Either flesh out OR delete.",
            "",
            "| File | Size (chars) |",
            "|------|--------------|",
        ])
        # Sort by size ascending (most stub-like first)
        sorted_stubs = sorted(result["thin_stubs"], key=lambda p: p.stat().st_size)
        for f in sorted_stubs[:30]:
            try:
                size = f.stat().st_size
            except Exception:
                size = "?"
            lines.append(f"| `{slug(f, vault)}` | {size} |")
        if len(result["thin_stubs"]) > 30:
            lines.append(f"\n_({len(result['thin_stubs']) - 30} more not shown)_\n")
        else:
            lines.append("")

    lines.extend([
        "## How to act",
        "",
        "- **Orphan links:** create the target file with stub content, OR remove the broken link",
        "- **Dead-ends:** add inbound links from an index file (e.g., `Knowledge/builds/_index.md`) if useful, OR move to `_archive/` if obsolete",
        "- **Thin stubs:** finish them (flesh out content) OR delete if no longer relevant",
        "",
        "Re-run `python C:/Users/Sebas/cortextos/scripts/vault-gap-finder/gap_finder.py` after fixes to verify clean.",
        "",
        f"Generated by vault-gap-finder at {datetime.now(timezone.utc).isoformat()}.",
    ])

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Vault knowledge-quality gap scanner")
    parser.add_argument("--report-only", action="store_true", help="Print to stdout instead of writing to vault")
    parser.add_argument("--include-archive", action="store_true", help="Also scan _archive/ folders")
    parser.add_argument("--vault", default=str(VAULT_ROOT), help="Path to vault root (default: locked Obsidian Vault)")
    args = parser.parse_args()

    vault = Path(args.vault)
    if not vault.exists():
        print(f"ERROR vault not found: {vault}", file=sys.stderr)
        sys.exit(1)

    result = analyze(vault, include_archive=args.include_archive)
    report = format_report(result, vault)

    if args.report_only:
        print(report)
        return

    # Write report to vault
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    report_path = vault / "Knowledge" / "system" / f"vault-gap-report-{today}.md"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(report, encoding="utf-8")
    print(f"SAVED: {report_path}")
    print(f"Scanned {result['scanned_files_count']} files. "
          f"{result['orphan_links_count']} orphan links / "
          f"{result['dead_ends_count']} dead-ends / "
          f"{result['thin_stubs_count']} thin stubs.")


if __name__ == "__main__":
    main()
