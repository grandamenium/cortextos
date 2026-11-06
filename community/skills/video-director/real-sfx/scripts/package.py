#!/usr/bin/env python3
"""Build a clean, shareable copy of the skill: no personal paths, indexes, taste or reference analyses.

  python package.py --out dist/real-sfx.skill [--no-uisfx]

Included: SKILL.md, README.md, config.example.json (as config.json with no libraries), scripts, references,
tests, evals, vendor/package.json and (unless --no-uisfx) the CC0 uisfx sounds as mp3 + manifest, so UI
cues work out of the box. Excluded: library_index.json, taste.json, listening_log.json, styles/*, library_embeddings.*,
vendor/venv, vendor/models, caches, __pycache__, evals results.

The result is a zip with a top folder real-sfx/, the shape Claude skill installers expect.
"""
import argparse
import json
import sys
import zipfile
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
SKIP_DIRS = {"__pycache__", "venv", "models", "styles", "dist", ".git", "node_modules"}
SKIP_FILES = {"library_index.json", "taste.json", "config.json", "library_embeddings.bin", "library_embeddings.json",
              "analysis_cache.json", "kind_map.json", "listening_log.json", "ambience_steady.json",
              "taste_ratings.json"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(SKILL / "dist" / "real-sfx.skill"))
    ap.add_argument("--no-uisfx", action="store_true")
    a = ap.parse_args()
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    n = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(SKILL.rglob("*")):
            if not p.is_file():
                continue
            rel = p.relative_to(SKILL)
            parts = set(rel.parts)
            if parts & SKIP_DIRS or p.name in SKIP_FILES or p.suffix in (".pyc",):
                continue
            if rel.parts[0] == "vendor":
                continue                      # handled below
            z.writestr(f"real-sfx/{rel.as_posix()}", p.read_bytes())
            n += 1
        # a neutral config: the user adds libraries with setup.py
        ex = SKILL / "config.example.json"
        cfg = ex.read_text(encoding="utf-8") if ex.exists() else json.dumps(
            {"libraries": [], "uisfx": {"path": "vendor/node_modules/uisfx", "default_pack": "studio"},
             "skip_dir_names": ["_mister horse previews"], "index_path": "library_index.json"}, indent=2)
        z.writestr("real-sfx/config.json", cfg)
        z.writestr("real-sfx/vendor/package.json", '{"name":"real-sfx-vendor","private":true,"version":"1.0.0"}')
        if not a.no_uisfx:
            ui = SKILL / "vendor" / "node_modules" / "uisfx"
            if (ui / "manifest.json").exists():
                for p in sorted(ui.rglob("*")):
                    if p.is_file() and (p.suffix == ".mp3" or p.name in ("manifest.json", "LICENSE", "LICENSE-AUDIO",
                                                                         "README.md", "package.json")):
                        z.writestr(f"real-sfx/vendor/node_modules/uisfx/{p.relative_to(ui).as_posix()}", p.read_bytes())
                        n += 1
            else:
                print("note: uisfx is not installed here, the package will ask the user to run setup.py init --uisfx")
    mb = out.stat().st_size / 1e6
    print(f"{out}  ({n} files, {mb:.1f} MB)")


if __name__ == "__main__":
    main()
