#!/usr/bin/env python3
"""Show the frames on both sides of every cut, side by side.

python3 <skill>/scripts/cut_frames.py output/cut-v3.mp4 --out output/cuts-v3
python3 <skill>/scripts/cut_frames.py output/cut-v3.mp4 --out output/cuts-v3 --times 4.2,9.8,15.0

Finds the cuts (ffmpeg scene detection, or --times from the motion spec, which also catches dissolves that
detection misses), then for each one writes a strip of four
frames: 0.2 s and 0.07 s before the cut, 0.07 s and 0.2 s after it. Look at every strip for a jump in where a person
or object is, a pop, a doubled pointer or a flash. cuts.json lists each strip with its time.

Exit 0 strips written; 1 error.
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

OFFSETS = (-0.2, -0.07, 0.07, 0.2)


def ffmpeg(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["ffmpeg", "-v", "error", "-y", *args], capture_output=True, text=True, check=True)


def duration_s(video: Path) -> float:
    run = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(video)],
                         capture_output=True, text=True, check=True)
    return float(json.loads(run.stdout)["format"]["duration"])


def detect_cuts(video: Path, threshold: float) -> list[float]:
    run = subprocess.run(["ffmpeg", "-i", str(video), "-vf", f"select='gt(scene,{threshold})',showinfo", "-f", "null", "-"],
                         capture_output=True, text=True)
    if run.returncode != 0:
        raise RuntimeError(f"cut detection failed: {run.stderr.strip()[-300:]}")
    times = [float(t) for t in re.findall(r"pts_time:([0-9.]+)", run.stderr)]
    out: list[float] = []
    for t in times:
        if not out or t - out[-1] > 0.25:
            out.append(round(t, 3))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--times", help="comma-separated cut times in seconds, in place of detection")
    ap.add_argument("--threshold", type=float, default=0.3, help="scene-change threshold for detection")
    ap.add_argument("--width", type=int, default=480, help="width of each frame in the strip")
    args = ap.parse_args()
    if not (shutil.which("ffmpeg") and shutil.which("ffprobe")):
        raise RuntimeError("ffmpeg and ffprobe are required")
    if not args.video.is_file():
        raise ValueError(f"not a file: {args.video}")
    total = duration_s(args.video)
    cuts = [float(t) for t in args.times.split(",") if t.strip()] if args.times else detect_cuts(args.video, args.threshold)
    late = [t for t in cuts if not 0 < t < total]
    if late:
        raise ValueError(f"cut time(s) outside the video (0-{total:.2f}s): {late}")
    args.out.mkdir(parents=True, exist_ok=True)
    rows = []
    with tempfile.TemporaryDirectory() as tmp:
        for n, cut in enumerate(cuts, 1):
            frames = []
            for i, off in enumerate(OFFSETS):
                t = min(max(cut + off, 0.0), max(total - 0.04, 0.0))
                png = Path(tmp) / f"{n:02d}-{i}.png"
                ffmpeg("-ss", f"{t:.3f}", "-i", str(args.video), "-frames:v", "1", "-vf", f"scale={args.width}:-2", str(png))
                frames.append((t, png))
            strip = args.out / f"cut-{n:02d}-{cut:.2f}s.jpg"
            inputs = [x for _, png in frames for x in ("-i", str(png))]
            ffmpeg(*inputs, "-filter_complex", "".join(f"[{i}:v]" for i in range(len(frames))) + f"hstack=inputs={len(frames)}", str(strip))
            rows.append({"cut": cut, "frames_at": [round(t, 3) for t, _ in frames], "strip": str(strip)})
    (args.out / "cuts.json").write_text(json.dumps({"video": str(args.video.resolve()), "cuts": rows}, indent=2), encoding="utf-8")
    print(f"{len(rows)} cut strip(s) in {args.out}; frames at -0.2, -0.07, +0.07, +0.2 s. Open every one.")
    if not rows:
        print("WARN no cuts found. Scene detection misses dissolves and slow moves; pass --times from the motion spec.")
    for r in rows:
        print(f"CUT {r['cut']:7.2f}s  {r['strip']}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as exc:
        detail = exc.stderr.strip()[-400:] if isinstance(exc, subprocess.CalledProcessError) and exc.stderr else str(exc)
        print(f"ERROR: cut frames incomplete: {detail}", file=sys.stderr)
        raise SystemExit(1)
