#!/usr/bin/env python3
"""First-run setup and health check, for any machine and any sound library.

  python setup.py check
  python setup.py scan "D:/Sounds"                       # which folders look like sound libraries?
  python setup.py init --library main="D:/Sounds/SFX" --library ui="D:/Sounds/UI" [--uisfx] [--index]
  python setup.py add-library packs "D:/More packs" [--index]

`check` reports every dependency and what is missing, in plain words. `init` writes config.json (it will
not overwrite an existing one unless --force) and can build the index (--index) and install the uisfx
UI sound package from npm into the skill's own folder (--uisfx, ~9 MB, needs Node.js).
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import AUDIO_EXT, SKILL_DIR, config_path, is_sound_file

EXAMPLE = {
    "libraries": [],
    "uisfx": {"path": "vendor/node_modules/uisfx", "default_pack": "studio"},
    "skip_dir_names": ["_mister horse previews"],
    "index_path": "library_index.json",
}


def tool(name):
    p = shutil.which(name)
    if not p:
        return None, None
    try:
        out = subprocess.run([name, "-version" if name.startswith("ff") else "--version"], capture_output=True,
                             text=True, timeout=10).stdout.splitlines()
        return p, (out[0] if out else "")
    except Exception:
        return p, ""


def check():
    ok = True
    print("tools")
    for t, need in (("ffmpeg", True), ("ffprobe", True), ("node", False), ("npm", False)):
        p, v = tool(t)
        flag = "ok " if p else ("MISSING" if need else "missing (only needed to install uisfx)")
        print(f"  {t:8s} {flag:8s} {v[:60] if p else ''}")
        ok &= bool(p) or not need
    print(f"  python   ok       {sys.version.split()[0]}")
    cfgp = config_path()
    print("config")
    if not cfgp.exists():
        print(f"  {cfgp}: not found -> python setup.py init --library name=PATH --index")
        return False
    cfg = json.loads(cfgp.read_text(encoding="utf-8"))
    for lib in cfg.get("libraries", []):
        n = sum(1 for _ in Path(lib["path"]).rglob("*") if is_sound_file(_)) if Path(lib["path"]).is_dir() else None
        cat = ""
        if n is not None and any((d / c).is_file() for d in [Path(lib["path"])] + [x for x in Path(lib["path"]).iterdir()
                                                                                   if x.is_dir()][:20]
                                 for c in ("catalog.json", "catalog.csv")):
            cat = ", catalog"
        tier = lib.get("tier", "main")
        off = ", DISABLED" if lib.get("enabled", True) is False else ""
        print(f"  library {lib['name']:18s} {'NOT FOUND' if n is None else f'{n} audio files'} "
              f"[{tier}{cat}{off}]  {lib['path']}")
        ok &= n is not None or lib.get("enabled", True) is False
    if not cfg.get("libraries"):
        print("  no libraries configured: only uisfx UI cues will be available")
    idx = Path(cfg.get("index_path", "library_index.json"))
    idx = idx if idx.is_absolute() else SKILL_DIR / idx
    if idx.exists():
        d = json.loads(idx.read_text(encoding="utf-8"))
        print(f"  index    {d['count']} sounds  ({idx.name})")
    else:
        print("  index    MISSING -> python scripts/build_index.py")
        ok = False
    ui = Path(cfg["uisfx"]["path"])
    ui = ui if ui.is_absolute() else SKILL_DIR / ui
    print(f"  uisfx    {'ok' if (ui / 'manifest.json').exists() else 'not installed -> setup.py init --uisfx'}")
    print(f"  taste    {'yes' if (SKILL_DIR / 'taste.json').exists() else 'empty'}")
    print(f"  styles   {', '.join(p.stem for p in (SKILL_DIR / 'styles').glob('*.json')) or 'none'}")
    return ok


def scan(root, min_files):
    root = Path(root)
    if not root.is_dir():
        sys.exit(f"not a folder: {root}")
    found = []
    for top in sorted(p for p in root.iterdir() if p.is_dir()):
        n = size = 0
        for dp, dn, fn in os.walk(top):
            if "previews" in dp.lower():
                continue
            for f in fn:
                if is_sound_file(Path(dp) / f):
                    n += 1
                    try:
                        size += os.path.getsize(os.path.join(dp, f))
                    except OSError:
                        pass
        if n >= min_files:
            found.append((top, n, size))
    if not found:
        print(f"no folder under {root} has {min_files}+ audio files")
        return
    print(f"{'files':>6} {'MB':>7}  folder    (suggested option)")
    for top, n, size in sorted(found, key=lambda x: -x[1]):
        nm = "".join(ch if ch.isalnum() else "_" for ch in top.name.lower())[:24].strip("_") or "lib"
        print(f"{n:6d} {size / 1e6:7.0f}  {top}    --library {nm}=\"{top}\"")
    print("\nMusic folders and plugin preview audio also match: pick only the sound-effect packs.")


def write_config(libs, force, tier="main"):
    p = config_path()
    if p.exists() and not force:
        cfg = json.loads(p.read_text(encoding="utf-8"))
    else:
        cfg = json.loads(json.dumps(EXAMPLE))
    have = {l["name"]: l for l in cfg["libraries"]}
    for name, path in libs:
        if not Path(path).is_dir():
            print(f"warning: {path} is not a folder (kept anyway)")
        have[name] = {"name": name, "path": str(path), "tier": tier}
    cfg["libraries"] = list(have.values())
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"config written: {p}  ({len(cfg['libraries'])} libraries)")


def install_uisfx():
    vendor = SKILL_DIR / "vendor"
    vendor.mkdir(exist_ok=True)
    if not (vendor / "package.json").exists():
        (vendor / "package.json").write_text('{"name":"real-sfx-vendor","private":true,"version":"1.0.0"}', encoding="utf-8")
    npm = shutil.which("npm")
    if not npm:
        sys.exit("npm not found: install Node.js first (https://nodejs.org), then run this again")
    print("installing uisfx (CC0 UI sounds, ~9 MB) ...", flush=True)
    subprocess.check_call([npm, "install", "uisfx", "--prefix", str(vendor), "--no-audit", "--no-fund"])


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check")
    s = sub.add_parser("scan")
    s.add_argument("root")
    s.add_argument("--min-files", type=int, default=20)
    i = sub.add_parser("init")
    i.add_argument("--library", action="append", default=[], metavar="NAME=PATH")
    i.add_argument("--uisfx", action="store_true")
    i.add_argument("--index", action="store_true")
    i.add_argument("--force", action="store_true")
    ad = sub.add_parser("add-library")
    ad.add_argument("name")
    ad.add_argument("path")
    ad.add_argument("--tier", choices=["main", "extra"], default="main",
                    help="extra = a fallback library: used only where the main libraries have nothing for a role")
    ad.add_argument("--index", action="store_true")
    a = ap.parse_args()

    if a.cmd == "check":
        sys.exit(0 if check() else 1)
    if a.cmd == "scan":
        return scan(a.root, a.min_files)
    if a.cmd == "init":
        libs = []
        for item in a.library:
            if "=" not in item:
                sys.exit(f"--library expects NAME=PATH, got {item!r}")
            n, p = item.split("=", 1)
            libs.append((n.strip(), p.strip().strip('"')))
        write_config(libs, a.force)
        if a.uisfx:
            install_uisfx()
    else:
        write_config([(a.name, a.path)], False, a.tier)
    if getattr(a, "index", False):
        subprocess.check_call([sys.executable, str(Path(__file__).parent / "build_index.py")])
    check()


if __name__ == "__main__":
    main()
