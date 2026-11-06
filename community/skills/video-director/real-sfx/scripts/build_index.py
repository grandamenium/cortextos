#!/usr/bin/env python3
"""Scan the sound libraries from config.json and write library_index.json.

Skips preview PNGs, HTML ads, readmes, macOS '._' stubs and the "_Mister Horse Previews" folders. Every sound gets
a primary role (whoosh, hit, riser, click ...), all matching roles, duration and levels, so the picker can search
by role/duration instead of guessing from folder names.

  python build_index.py            # all libraries in config.json
  python build_index.py --quick    # skip level analysis (fast, but no peak/anchor data cached)
  python build_index.py --full     # re-measure every file instead of reusing the old index

Libraries in config.json:
  {"name": "montage", "path": "D:/Sounds_sorted", "tier": "main"}     tier "main" (default) or "extra" (fallback:
                                                                       used only where the main libraries have
                                                                       nothing for a role)
A library folder that carries catalog.json or catalog.csv (rows: type, file, source, hit, hits_in_source ...; the
output of a sorter script) gives every sound its pack type and its source recording. The pack type decides the
primary role (it was taken from the folder the sound came from), the words of the source path become search words
(Russian ones too), and slices of one source recording count as one recording when variety is judged.
"""
import argparse
import csv
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import (SKIP_DIRS, SKILL_DIR, aliases_for, analyse_sound, fix_mojibake, index_path, is_sound_file,
                    load_config, nfc, onsets, roles_for_catalog, tag_roles, words)

# sounds that are meant to be ONE click/tick/pop: how many separate sounds are inside is worth knowing
CLICKISH = {"click", "ui", "data", "glitch", "foley", "camera", "paper", "coin", "glass", "cartoon",
            "typing", "pop", "water"}

NEW_COPY = re.compile(r"\.wav[ _]new$", re.I)
FEATURE_KEYS = ("duration", "peak_db", "mean_db", "peak_time", "attack_ms", "decay_ms", "centroid",
                "rolloff", "low", "high", "flat", "bumps", "active_dur", "lr_corr", "onset_count", "mono_ref")


def scan(lib, skip_dirs):
    root = Path(lib["path"])
    if not root.is_dir():
        print(f"WARN library '{lib['name']}' not found: {root}", file=sys.stderr)
        return []
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d.lower() not in skip_dirs and d.lower() not in SKIP_DIRS]
        for fn in filenames:
            p = Path(dirpath) / fn
            if is_sound_file(p):
                out.append((lib, root, p))
    return out


# ------------------------------------------------------------------ catalogs of sorted packs
def _catalog_key(rel):
    """The same key for a file on disk and for its row in the catalog: repaired name, composed form, forward
    slashes, lower case."""
    return nfc(fix_mojibake(str(rel))).replace("\\", "/").lower()


def _read_catalog(path):
    if path.suffix.lower() == ".json":
        rows = json.loads(path.read_text(encoding="utf-8-sig"))
        return rows.get("sounds", rows.get("rows", [])) if isinstance(rows, dict) else rows
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def load_catalog(root):
    """(folder the catalog sits in, {key: row}) for catalog.json / catalog.csv found in the library folder or one or
    two levels below it (an unzipped archive nests its folder twice). (None, {}) when there is none."""
    root = Path(root)
    spots, seen = [root], {root}
    for _ in range(2):
        nxt = []
        for d in spots:
            try:
                for c in sorted(d.iterdir()):
                    if c.is_dir() and c.name.lower() not in SKIP_DIRS and c not in seen:
                        nxt.append(c)
                        seen.add(c)
            except OSError:
                pass
        spots = nxt[:40]
    for d in [root] + sorted(seen - {root}, key=lambda p: (len(p.parts), str(p))):
        for name in ("catalog.json", "catalog.csv"):
            f = d / name
            if f.is_file():
                try:
                    rows = _read_catalog(f)
                except (OSError, ValueError, csv.Error) as e:
                    print(f"WARN cannot read catalog {f}: {e}", file=sys.stderr)
                    continue
                table = {}
                for r in rows:
                    if isinstance(r, dict) and r.get("file"):
                        table[_catalog_key(r["file"])] = r
                if table:
                    return d, table
    return None, {}


def _num(v, default=0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def pack_record(row, rel, root_rel):
    """Fields a catalog row adds: names from the source recording (not from the sorter's shortened file name)."""
    src = nfc(row.get("source", "")).replace("\\", "/")
    parent, _, leaf = src.rpartition("/")
    stem = re.sub(r"\.(wav|mp3|flac|aiff?|ogg|m4a|aac|opus)$", "", leaf, flags=re.I) or Path(rel).stem
    hit, hits = int(_num(row.get("hit"))), int(_num(row.get("hits_in_source"), 1))
    name = stem.replace("_", " ").strip()
    if hits > 1:
        name += f" #{hit}"
    folder = " / ".join(x for x in (nfc(fix_mojibake(root_rel)), parent.replace("_", " ")) if x)
    return {"name": name, "folder": folder, "pack_type": str(row.get("type", "")).lower(),
            "type_by": str(row.get("by", "")), "source": src, "hit": hit, "hits_in_source": hits,
            "src_start_s": round(_num(row.get("src_start_s")), 3), "_text": f"{parent} {stem}"}


def describe(item, quick, known=None, carry=None, catalogs=None):
    lib, root, p = item
    rel = p.relative_to(root)
    folder = nfc(fix_mojibake(str(rel.parent))) if str(rel.parent) != "." else ""
    name = nfc(fix_mojibake(p.stem.replace("_", " "))).strip()
    rec = {
        "library": lib["name"],
        "tier": lib.get("tier", "main"),
        "path": str(p),
        "folder": folder,
        "name": name,
    }
    cat_root, table = (catalogs or {}).get(lib["name"], (None, {}))
    row = None
    if cat_root is not None:
        try:
            row = table.get(_catalog_key(p.relative_to(cat_root)))
        except ValueError:
            row = None
    if row is not None:
        pk = pack_record(row, str(p.relative_to(cat_root)), str(p.relative_to(cat_root).parent))
        text = pk.pop("_text")
        rec.update(pk)
        roles = roles_for_catalog(pk["pack_type"], text) or tag_roles(f"{pk['folder']} / {pk['name']}")
    else:
        roles = tag_roles(f"{folder} / {name}")
    rec["role"] = roles[0] if roles else "misc"
    rec["roles"] = roles
    old = (known or {}).get(str(p))
    # a sound whose channels cancel was measured on a mono sum that is silence (before 0.11.1): measure it again
    stale_ = bool(old) and (old.get("lr_corr") or 0.0) < -0.3 and "mono_ref" not in old
    if old and "bumps" in old and "active_dur" in old and "lr_corr" in old and not stale_:   # measured: keep, redo tags
        rec.update({k: old[k] for k in FEATURE_KEYS if k in old})
    elif not quick:
        info = analyse_sound(p)
        if info is None:
            return None
        rec.update(info)
    keep_ = (carry or {}).get(str(p)) or old
    if keep_:                                 # what the ears said about this file stays with it, even on --full
        for k in ("tags", "tag_scores", "tags_v"):
            if k in keep_:
                rec[k] = keep_[k]
    if rec.get("onset_count") is None and rec["role"] in CLICKISH and 0 < rec.get("duration", 99) <= 3.5 and not quick:
        rec["onset_count"] = len(onsets(p)[0])
    rec["words"] = words(rec)
    al = aliases_for(f"{rec['folder']} {rec['name']}")
    if al:
        rec["aliases"] = al
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--out")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--full", action="store_true", help="re-measure every file instead of reusing the old index")
    args = ap.parse_args()

    cfg = load_config()
    skip = {s.lower() for s in cfg.get("skip_dir_names", [])}
    items, catalogs, libs_meta = [], {}, []
    for lib in cfg["libraries"]:
        if lib.get("enabled", True) is False:
            print(f"{lib['name']}: disabled in config.json, skipped")
            continue
        found = scan(lib, skip)
        cat_root, table = load_catalog(lib["path"]) if Path(lib["path"]).is_dir() else (None, {})
        if cat_root is not None:
            catalogs[lib["name"]] = (cat_root, table)
        skip_packs = {str(x).lower() for x in lib.get("skip_packs") or []}
        if skip_packs and cat_root is None:
            print(f"WARN {lib['name']}: skip_packs needs a catalog with a 'pack' column and none was found: "
                  f"nothing is skipped", file=sys.stderr)
        elif skip_packs:          # a sorted folder that also holds copies of sounds another library indexes in place
            keep = []
            for it in found:
                try:
                    row = table.get(_catalog_key(it[2].relative_to(cat_root))) or {}
                except ValueError:
                    row = {}
                if str(row.get("pack", "")).lower() not in skip_packs:
                    keep.append(it)
            print(f"{lib['name']}: skip_packs {sorted(skip_packs)} leaves {len(keep)} of {len(found)} files")
            found = keep
        print(f"{lib['name']}: {len(found)} audio files, tier {lib.get('tier', 'main')}"
              + (f", catalog with {len(table)} rows ({cat_root})" if cat_root is not None else ""))
        libs_meta.append({"name": lib["name"], "path": lib["path"], "tier": lib.get("tier", "main"),
                          "files": len(found), "catalog": cat_root is not None})
        items += found

    out_p = Path(args.out) if args.out else index_path(cfg)
    known, carry = {}, {}
    if out_p.exists():
        carry = {s["path"]: s for s in json.loads(out_p.read_text(encoding="utf-8"))["sounds"]}
        if not args.full:
            known = carry
    with ThreadPoolExecutor(args.workers) as ex:
        recs = [r for r in ex.map(lambda it: describe(it, args.quick, known, carry, catalogs), items) if r]

    # "X.wav new" files are re-exports of "X"; packs that ship a sound as both WAV and MP3 give the same name twice.
    # Drop the copy when identical (the lossless one stays), keep as "(alt)" when not.
    seen, kept = {}, []
    lossy = {".mp3", ".m4a", ".aac", ".ogg", ".opus"}
    for r in sorted(recs, key=lambda r: (bool(NEW_COPY.search(r["name"])), Path(r["path"]).suffix.lower() in lossy)):
        clean = NEW_COPY.sub("", r["name"]).strip()
        key = (r["library"], r["folder"], clean.lower())
        if key in seen:
            o = seen[key]
            if abs(o.get("duration", 0) - r.get("duration", 0)) < 0.02 and abs(o.get("peak_db", 0) - r.get("peak_db", 0)) < 0.5:
                continue
            clean += " (alt)"
        r["name"] = clean
        seen[key] = r
        kept.append(r)
    dropped = len(recs) - len(kept)
    recs = kept
    # near-identical recordings under different names (same length, level, brightness): mark them as one group
    # so the picker does not count a copy as a "different" sound
    groups = {}
    for r in recs:
        if r.get("duration", 0) >= 0.05 and "centroid" in r:
            key = f"{round(r['duration'], 2)}|{round(r['peak_db'] * 2) / 2}|{round(r['mean_db'] * 2) / 2}|{r['centroid'] // 20}"
            groups.setdefault(key, []).append(r)
    for key, members in groups.items():
        if len(members) > 1:
            for r in members:
                r["dup_key"] = key
    for i, r in enumerate(recs):
        r["id"] = i

    out = out_p
    out.write_text(json.dumps({"count": len(recs), "libraries": libs_meta, "sounds": recs}, ensure_ascii=False,
                              indent=1), encoding="utf-8")

    by_role, by_lib = {}, {}
    for r in recs:
        by_role[r["role"]] = by_role.get(r["role"], 0) + 1
        by_lib[r["library"]] = by_lib.get(r["library"], 0) + 1
    print(f"indexed {len(recs)} sounds ({dropped} duplicate re-exports dropped) -> {out}")
    print("by library:", ", ".join(f"{k}={v}" for k, v in by_lib.items()))
    print("by primary role:", ", ".join(f"{k}={v}" for k, v in sorted(by_role.items(), key=lambda kv: -kv[1])))


if __name__ == "__main__":
    main()
