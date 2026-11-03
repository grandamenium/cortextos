#!/usr/bin/env python3
"""Check delivery file bytes and optional decoded frame count.

python3 <skill>/scripts/check_delivery.py output/cut-vN-phone.mp4 --max-mb 30
python3 <skill>/scripts/check_delivery.py output/loop.gif --max-mb 5 --max-frames 400
MB uses decimal bytes (1 MB = 1,000,000 bytes). Exit 0 passes measured limits; 1 input/limit/coverage error.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", type=Path)
    ap.add_argument("--max-mb", type=float)
    ap.add_argument("--max-frames", type=int)
    args = ap.parse_args()
    if args.max_mb is None and args.max_frames is None:
        raise ValueError("supply --max-mb and/or --max-frames")
    if args.max_mb is not None and (args.max_mb <= 0 or args.max_mb == float("inf") or args.max_mb != args.max_mb):
        raise ValueError("--max-mb must be a finite positive number")
    if args.max_frames is not None and args.max_frames < 1:
        raise ValueError("--max-frames must be positive")
    if not args.file.is_file():
        raise ValueError(f"not a regular delivery file: {args.file}")
    size = args.file.stat().st_size
    limit = args.max_mb * 1_000_000 if args.max_mb is not None else None
    if size <= 0 or (limit is not None and size > limit):
        print(f"FAIL: {args.file}: {size} bytes; limit {limit} bytes; file must be nonempty")
        return 1
    frames = None
    if args.max_frames is not None:
        if not shutil.which("ffprobe"):
            raise RuntimeError("frame-count coverage unavailable: ffprobe is required for --max-frames")
        run = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
                              "stream=nb_read_frames", "-of", "json", str(args.file)], capture_output=True, text=True, check=True)
        streams = json.loads(run.stdout).get("streams", [])
        if len(streams) != 1 or not str(streams[0].get("nb_read_frames", "")).isdigit():
            raise RuntimeError("frame-count coverage unavailable: ffprobe returned no exact decoded frame count")
        frames = int(streams[0]["nb_read_frames"])
        if frames < 1 or frames > args.max_frames:
            print(f"FAIL: {frames} frames; limit {args.max_frames}; must be nonempty")
            return 1
    print(f"PASS: {args.file.resolve()}: {size} bytes" + (f" <= {limit:g}" if limit is not None else "") + (f"; {frames} frames <= {args.max_frames}" if frames is not None else "") + "; bytes/frame limits only")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, TypeError, KeyError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"ERROR: delivery measurement incomplete: {exc}", file=sys.stderr)
        raise SystemExit(1)
