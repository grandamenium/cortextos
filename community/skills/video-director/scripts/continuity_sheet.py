#!/usr/bin/env python3
"""Put every recurring prop and piece of clothing side by side across the shots it appears in.

python3 <skill>/scripts/continuity_sheet.py output/cut-v3.mp4 --items continuity.json --out output/continuity-v3
python3 <skill>/scripts/continuity_sheet.py --verify output/continuity-v3

Between shots of a generated live-action film, objects and clothes change with nobody noticing: a water bottle
becomes a different bottle, a door that was shut is open again, a crop top becomes a sports bra. Cut strips don't
show it, because the change is often many shots apart.

The items file lists each recurring thing named in the brief or storyboard, and one moment from every shot it
appears in:

  {"items": [
    {"name": "water bottle", "note": "big bottle with a straw",
     "shots": [{"time": 3.1, "label": "hallway", "box": [820, 400, 260, 420]},
               {"time": 12.4, "label": "desk", "box": [1300, 520, 200, 330]}]},
    {"name": "front door", "note": "shut once she is inside", "shots": [{"time": 2.0}, {"time": 30.5}]}]}

box is optional [x, y, width, height] in video pixels around the item in that shot; without it the whole frame
is used. Every tile in an item's sheet is the same size, so the item is seen at the same scale in each shot. Tiles run left to right in
the order the shots are listed (printed, and kept in continuity.json).

Writes one sheet per item (sheet-NN-<name>.jpg) and continuity.json with an empty "verdict" for each item. Open
every sheet and write one line per item in continuity.json, starting with one of:
  same:      the item looks the same in every shot (say what you compared)
  changed:   it changes between shots (say where); fix it before anyone sees the render
  accepted:  it changes, and the user said that is fine (quote their words in quotation marks, with the date
             as YYYY-MM-DD)
Then run --verify. A verdict carries over to a new run only when the video file is unchanged (same path, size and
time); a re-render needs new verdicts. Exit 0 sheets written (or, with --verify, every item has a same/accepted
verdict); 1 an error, an empty verdict, a "changed" verdict, or an "accepted" verdict without a quote and a date.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

VERDICTS = ("same:", "changed:", "accepted:")


def ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], capture_output=True, text=True, check=True)


def probe_video(video: Path) -> tuple[float, int, int]:
    run = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration",
                          "-of", "json", str(video)], capture_output=True, text=True, check=True)
    d = json.loads(run.stdout)
    return float(d["format"]["duration"]), int(d["streams"][0]["width"]), int(d["streams"][0]["height"])


def load_items(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    items = data.get("items") if isinstance(data, dict) else data
    if not isinstance(items, list) or not items:
        raise ValueError(f"{path}: expected {{\"items\": [...]}} with at least one item")
    for i, it in enumerate(items, 1):
        if not isinstance(it, dict) or not str(it.get("name", "")).strip():
            raise ValueError(f"item {i}: needs a 'name'")
        shots = it.get("shots")
        if not isinstance(shots, list) or len(shots) < 2:
            raise ValueError(f"item {i} ({it['name']}): list at least two shots it appears in")
        for s in shots:
            if not isinstance(s, dict) or not isinstance(s.get("time"), (int, float)) or isinstance(s.get("time"), bool):
                raise ValueError(f"item {i} ({it['name']}): every shot needs a numeric 'time'")
            box = s.get("box")
            if box is not None and not (isinstance(box, list) and len(box) == 4 and all(isinstance(v, (int, float)) for v in box) and box[2] > 0 and box[3] > 0):
                raise ValueError(f"item {i} ({it['name']}): 'box' must be [x, y, width, height] with a positive size")
    return items


def tile_size(item: dict, vw: int, vh: int, height: int) -> tuple[int, int]:
    """One tile shape for the whole item: the widest box's shape, or the frame's when no box is given."""
    boxes = [s["box"] for s in item["shots"] if s.get("box")]
    ratio = max(b[2] / b[3] for b in boxes) if boxes and len(boxes) == len(item["shots"]) else vw / vh
    return max(2, int(height * ratio) // 2 * 2), height


def make_sheet(video: Path, total: float, item: dict, n: int, vw: int, vh: int, out: Path, height: int, tmp: Path) -> Path:
    tw, th = tile_size(item, vw, vh, height)
    tiles = []
    for k, s in enumerate(item["shots"]):
        t = min(max(float(s["time"]), 0.0), max(total - 0.04, 0.0))
        x, y, w, h = s.get("box") or [0, 0, vw, vh]
        crop = f"crop={int(w) // 2 * 2}:{int(h) // 2 * 2}:{int(x)}:{int(y)}," if s.get("box") else ""
        png = tmp / f"{n:02d}-{k:02d}.png"
        ffmpeg("-ss", f"{t:.3f}", "-i", str(video), "-frames:v", "1", "-vf",
               f"{crop}scale={tw}:{th}:force_original_aspect_ratio=decrease:flags=lanczos,pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2:color=black,"
               f"pad={tw + 8}:{th}:0:0:color=white", str(png))
        tiles.append(png)
    slug = re.sub(r"[^a-z0-9]+", "-", item["name"].lower()).strip("-")[:40]
    dest = out / f"sheet-{n:02d}-{slug}.jpg"
    inputs = [x for p in tiles for x in ("-i", str(p))]
    ffmpeg(*inputs, "-filter_complex", "".join(f"[{i}:v]" for i in range(len(tiles))) + f"hstack=inputs={len(tiles)}", str(dest))
    return dest


def verify(folder: Path) -> int:
    path = folder / "continuity.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    problems = 0
    for it in data["items"]:
        v = str(it.get("verdict", "")).strip()
        kind = next((p for p in VERDICTS if v.lower().startswith(p)), None)
        if not kind or len(v) <= len(kind) + 2:
            print(f"OPEN    {it['name']}: no verdict. Open {it['sheet']} and write one line starting same:, changed: or accepted:")
            problems += 1
        elif kind == "changed:":
            print(f"CHANGED {it['name']}: {v[len(kind):].strip()}")
            problems += 1
        elif kind == "accepted:" and not (re.search(r'["\u201c].+["\u201d]', v) and re.search(r"\b\d{4}-\d{2}-\d{2}\b", v)):
            print(f"OPEN    {it['name']}: an accepted: line must quote the user in quotation marks and give the date (YYYY-MM-DD)")
            problems += 1
        else:
            print(f"{kind[:-1].upper():<7} {it['name']}: {v[len(kind):].strip()}")
    print(f"{len(data['items'])} item(s); {problems} open or changed.")
    return 1 if problems else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video", type=Path, nargs="?")
    ap.add_argument("--items", type=Path, help="JSON list of recurring props and clothes with the shots they appear in")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--verify", type=Path, metavar="FOLDER", help="check the verdicts in FOLDER/continuity.json")
    ap.add_argument("--height", type=int, default=360, help="height of each tile")
    args = ap.parse_args()
    if args.verify:
        return verify(args.verify)
    if not (args.video and args.items and args.out):
        raise ValueError("give VIDEO --items FILE --out FOLDER, or --verify FOLDER")
    if not (shutil.which("ffmpeg") and shutil.which("ffprobe")):
        raise RuntimeError("ffmpeg and ffprobe are required")
    items = load_items(args.items)
    total, vw, vh = probe_video(args.video)
    late = [s["time"] for it in items for s in it["shots"] if not 0 <= s["time"] < total]
    if late:
        raise ValueError(f"shot time(s) outside the video (0-{total:.2f}s): {late}")
    out_json = args.out / "continuity.json"
    old = {}
    if out_json.is_file():
        old = {it["name"]: it for it in json.loads(out_json.read_text(encoding="utf-8")).get("items", [])}
    args.out.mkdir(parents=True, exist_ok=True)
    rows = []
    st = args.video.stat()
    stamp = [st.st_size, int(st.st_mtime)]
    vpath = str(args.video.resolve())
    with tempfile.TemporaryDirectory() as tmp:
        for n, it in enumerate(items, 1):
            sheet = make_sheet(args.video, total, it, n, vw, vh, args.out, args.height, Path(tmp))
            prev = old.get(it["name"], {})
            # a verdict carries over only for the same shots of the same, unchanged video file
            keep = prev.get("shots") == it["shots"] and prev.get("video") == vpath and prev.get("stamp") == stamp
            rows.append({"name": it["name"], "note": it.get("note", ""), "shots": it["shots"], "sheet": str(sheet),
                         "verdict": prev.get("verdict", "") if keep else "", "video": vpath, "stamp": stamp})
    out_json.write_text(json.dumps({"video": str(args.video.resolve()), "items": rows}, indent=2), encoding="utf-8")
    for r in rows:
        order = ", ".join(f"{s['time']:.2f}s {s.get('label', '')}".strip() for s in r["shots"])
        print(f"SHEET {r['name']}: {r['sheet']}\n      tiles left to right: {order}")
    print(f"{len(rows)} sheet(s). Open every one, write a one-line verdict per item in {out_json} "
          f"(same:, changed: or accepted:), then run --verify {args.out}.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, KeyError, json.JSONDecodeError, subprocess.CalledProcessError) as exc:
        detail = exc.stderr.strip()[-400:] if isinstance(exc, subprocess.CalledProcessError) and exc.stderr else str(exc)
        print(f"ERROR: continuity sheet incomplete: {detail}", file=sys.stderr)
        raise SystemExit(1)
