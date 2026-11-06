#!/usr/bin/env python3
"""Check that every sound and music file in a project's assets/audio/ has a row in assets/audio/SOURCES.md.

python3 <skill>/scripts/check_sources.py assets/audio

Each file's source and licence is what lets the film be published, and the free libraries' licences differ (some
need a credit, some forbid sharing the files). SOURCES.md holds a Markdown table whose first column is the file's
path relative to assets/audio/ (backticks allowed), with a column whose header contains "licence" or "license":

  | File | Source | Page or id | Made by | Licence, and what it allows | Downloaded | Used for |
  |---|---|---|---|---|---|---|
  | `effects/door-close.wav` | Freesound | sound <id> | <uploader> | CC0: any use, no credit needed | <date> | the door at 0:12 |

It reports:
  missing  a sound or music file with no row
  orphan   a row whose file is not there
  licence  a row with an empty licence cell
Sound and music files are found by extension (wav, mp3, m4a, aac, aif, aiff, flac, ogg, opus, caf). Exit 0 all
present; 2 something to fix; 1 an error (no folder, no SOURCES.md, no table).
"""
from __future__ import annotations

import argparse
from pathlib import Path
import sys

AUDIO = {".wav", ".mp3", ".m4a", ".aac", ".aif", ".aiff", ".flac", ".ogg", ".opus", ".caf"}


def cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def read_rows(sources: Path) -> list[tuple[str, str]]:
    """(file, licence) for every row of every table that has a licence column."""
    rows: list[tuple[str, str]] = []
    lines = sources.read_text(encoding="utf-8").splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.lstrip().startswith("|") and i + 1 < len(lines) and set(lines[i + 1].replace("|", "").strip()) <= set("-: "):
            head = [h.lower() for h in cells(line)]
            lic = next((k for k, h in enumerate(head) if "licen" in h), None)
            i += 2
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                c = cells(lines[i])
                name = c[0].strip("`").strip()
                if name:
                    rows.append((name, c[lic] if lic is not None and lic < len(c) else ""))
                i += 1
            continue
        i += 1
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", type=Path, help="the project's assets/audio folder")
    args = ap.parse_args()
    folder = args.folder
    sources = folder / "SOURCES.md"
    if not folder.is_dir():
        print(f"error: {folder} is not a folder", file=sys.stderr)
        return 1
    if not sources.is_file():
        print(f"error: {sources} is missing; every project keeps one (sound-stage.md)", file=sys.stderr)
        return 1
    rows = read_rows(sources)
    if not rows:
        print(f"error: {sources} has no table rows with a file in the first column", file=sys.stderr)
        return 1
    files = sorted(p.relative_to(folder).as_posix() for p in folder.rglob("*")
                   if p.is_file() and p.suffix.lower() in AUDIO)
    listed = {name for name, _ in rows}
    problems = [f"missing  {f}: no row in SOURCES.md" for f in files if f not in listed]
    problems += [f"orphan   {name}: listed in SOURCES.md but not in {folder}" for name, _ in rows
                 if name not in files]
    problems += [f"licence  {name}: the licence cell is empty" for name, lic in rows if not lic.strip()]
    for line in problems:
        print(f"REVIEW {line}")
    print(f"{len(files)} files, {len(rows)} rows: " + (f"{len(problems)} to fix" if problems else "all listed"))
    return 2 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
