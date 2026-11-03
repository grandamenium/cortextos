#!/usr/bin/env python3
"""Render storyboard frames from a frames HTML file to PNG with headless Chrome, then check each one.

Each frame is drawn at <frames.html>#<id>&clean (notes removed) unless --with-notes is given.
Checks per frame:
  FAIL  the frame script threw an error, the frame is missing, or output is missing
  WARN  a line of on-screen text overlaps a visual element or sits outside the title-safe area, or anything
        sits in the bottom band (default bottom 17%, set BRAND.clearBottom)
WARN layout items are candidates for a person to look at; they are not verdicts.
Blank-image heuristics require review via --reviews. Exit 0 structural completion; 2 review required; 1 error.

Usage:
  python3 render_frames.py storyboard/frames.html --all --out storyboard/frames-v0.2
  python3 render_frames.py storyboard/frames.html --ids 01a,01b,02a --out storyboard/frames-v0.2
  python3 render_frames.py storyboard/frames.html --ids 01a --variant cool --out storyboard/looks
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]


def find_chrome() -> str:
    env = os.environ.get("CHROME")
    if env and Path(env).exists():
        return env
    for c in CHROME_CANDIDATES:
        if Path(c).exists():
            return c
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "msedge"):
        found = shutil.which(name)
        if found:
            return found
    sys.exit("FAIL: no Chrome or Chromium found. Set CHROME=/path/to/chrome.")


def chrome(binary: str, profile: str, size: tuple[int, int], budget: int, *args: str) -> subprocess.CompletedProcess:
    cmd = [binary, "--headless=new", "--hide-scrollbars", "--disable-gpu", "--allow-file-access-from-files",
           f"--user-data-dir={profile}", f"--window-size={size[0]},{size[1]}", f"--virtual-time-budget={budget}", *args]
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(cmd, 124, stdout="", stderr="Chrome timed out after 120 s")


def frame_info(binary: str, profile: str, url: str) -> tuple[list[str], tuple[int, int]]:
    """Return the frame ids and the frame size the file declares (BRAND.size)."""
    result = chrome(binary, profile, (1920, 1080), 1500, "--dump-dom", f"{url}#__list")
    if result.returncode:
        raise RuntimeError(f"Chrome frame listing failed: {result.stderr[-500:]}")
    out = result.stdout
    m = re.search(r'<pre id="frame-list">(.*?)</pre>', out, re.S)
    z = re.search(r'<pre id="frame-size">(\d+)x(\d+)</pre>', out)
    if not m or not z:
        sys.exit("FAIL: could not list frames. Does the file load frame-kit.js and call KIT.renderFrame()? "
                 "A JavaScript syntax error (often a stray comma between frames) stops the whole file.")
    return [line.strip() for line in m.group(1).splitlines() if line.strip()], (int(z.group(1)), int(z.group(2)))


def blank_check(png: Path) -> str | None:
    """Return a reason if the PNG looks blank."""
    try:
        from PIL import Image, ImageStat  # optional
        im = Image.open(png).convert("L").resize((96, 54))
        if max(ImageStat.Stat(im).stddev) < 2.0:
            return "the frame is a single flat color"
        return None
    except ImportError:
        return "file is suspiciously small (likely blank)" if png.stat().st_size < 12_000 else None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("frames", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--all", action="store_true")
    g.add_argument("--ids")
    ap.add_argument("--variant", help="draw each frame with &variant=<name>; files are saved as <id>@<variant>.png")
    ap.add_argument("--with-notes", action="store_true", help="keep the dashed reviewer notes in the PNGs")
    ap.add_argument("--size", help="window size WxH; by default the size the frames file declares in BRAND.size")
    ap.add_argument("--reviews", type=Path, help="JSON list of {id, sha256, reason} dispositions for blank:<frame-id> candidates")
    ap.add_argument("--budget", type=int, default=2500, help="milliseconds of page time before capture")
    args = ap.parse_args()

    frames = args.frames.resolve()
    if not frames.exists():
        sys.exit(f"FAIL: {frames} not found")
    binary = find_chrome()
    url = frames.as_uri()
    args.out.mkdir(parents=True, exist_ok=True)
    failures, warnings, pending = 0, 0, 0
    reviews = {}
    if args.reviews:
        raw = json.loads(args.reviews.read_text())
        if not isinstance(raw, list):
            raise ValueError("--reviews must be a list of {id, sha256, reason}")
        for item in raw:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not isinstance(item.get("reason"), str) or not item["reason"].strip():
                raise ValueError("each review needs string id and nonempty reason")
            if item["id"] in reviews:
                raise ValueError(f"duplicate review id: {item['id']}")
            if not isinstance(item.get("sha256"), str):
                raise ValueError("each review requires the current printed sha256")
            reviews[item["id"]] = (item["sha256"], item["reason"].strip())
    with tempfile.TemporaryDirectory() as profile:
        all_ids, declared = frame_info(binary, profile, url)
        w, h = (int(x) for x in args.size.lower().split("x")) if args.size else declared
        ids = all_ids if args.all else [i.strip() for i in args.ids.split(",") if i.strip()]
        if not ids:
            sys.exit("FAIL: no frames found. FRAMES is empty, or the page script stopped before defining it.")
        for fid in ids:
            suffix = "" if args.with_notes else "&clean"
            if args.variant:
                suffix += f"&variant={args.variant}"
            target = f"{url}#{fid}{suffix}"
            name = f"{fid}@{args.variant}.png" if args.variant else f"{fid}.png"
            png = args.out / name
            # Capture into fresh scratch; a failed Chrome invocation cannot reuse an older PNG.
            with tempfile.TemporaryDirectory() as capture_dir:
                fresh = Path(capture_dir) / "frame.png"
                capture = chrome(binary, profile, (w, h), args.budget, f"--screenshot={fresh}", target)
                if capture.returncode or not fresh.is_file():
                    raise RuntimeError(f"Chrome capture failed for {fid}: {capture.stderr[-500:]}")
                shutil.copyfile(fresh, png)
            dump = chrome(binary, profile, (w, h), args.budget, "--dump-dom", target)
            if dump.returncode:
                raise RuntimeError(f"Chrome layout probe failed for {fid}: {dump.stderr[-500:]}")
            dom = dump.stdout
            m = re.search(r'<script type="application/json" id="layout-report">(.*?)</script>', dom, re.S)
            problems, notes = [], []
            if not png.exists():
                problems.append("no PNG was written")
            elif (reason := blank_check(png)):
                cid = f"blank:{fid}"
                digest = hashlib.sha256(png.read_bytes()).hexdigest()
                if reviews.get(cid, (None,))[0] == digest:
                    notes.append(f"REVIEWED {cid}: {reviews[cid][1]}")
                else:
                    pending += 1
                    notes.append(f"REVIEW {cid} sha256={digest}: {reason}; inspect actual PNG and intent")
            if not m:
                problems.append("no layout report (the page script did not run; check for a syntax error)")
            else:
                rep = json.loads(m.group(1))
                if rep.get("size") and tuple(rep["size"]) != (w, h):
                    problems.append(f"the frame is {rep['size'][0]}x{rep['size'][1]} but was rendered at {w}x{h}; drop --size or match BRAND.size")
                if rep.get("error"):
                    problems.append(rep["error"])
                if rep.get("empty"):
                    problems.append("the frame drew nothing")
                low = rep.get("lowband", [])
                if low:
                    notes.append(f"{len(low)} element(s) in the bottom band, e.g. {low[0]['element']} at {low[0]['box']}")
                for u in rep.get("unsafe", []):
                    notes.append(f'line outside title-safe area: "{u}"')
                seen = set()
                for o in rep.get("overlaps", []):
                    key = (o["caption"], o["element"], tuple(o["box"]))
                    if key in seen:
                        continue
                    seen.add(key)
                    notes.append(f'line "{o["caption"][:40]}" touches {o["element"]} at {o["box"]}')
            if problems:
                failures += 1
                print(f"FAIL {fid}: " + "; ".join(problems))
            elif notes:
                warnings += 1
                print(f"WARN {fid}:")
                for n in notes[:8]:
                    print(f"     - {n}")
                if len(notes) > 8:
                    print(f"     - and {len(notes) - 8} more")
            else:
                print(f"PASS {fid}")
    print(f"\n{len(ids)} frames → {args.out.resolve()}  ({failures} failed, {warnings} with warnings)")
    if warnings:
        print("Open each WARN frame and decide: a real overlap gets fixed; a deliberate one gets a reason in the storyboard.")
    return 1 if failures else 2 if pending else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, TypeError, KeyError, AttributeError, RuntimeError) as exc:
        print(f"ERROR: invalid or unreadable frame input/output: {exc}", file=sys.stderr)
        raise SystemExit(1)
