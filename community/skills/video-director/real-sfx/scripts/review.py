#!/usr/bin/env python3
"""Make one picture of the finished sound design so it can be judged by eye.

  python review.py result/film_sfx_resolved_cues.json result/film_sfx_sfx_track.wav --out result/review.png
  python review.py ... --out result/review.png --from 90 --to 120        # a window of a long film
  python review.py ... --out result/review.png --chunk 30                # one picture per 30 s (review_0000-0030.png ...)

From top to bottom: video frames at the moments that carry a sound (placed at their time), the SFX
waveform and its spectrogram with a red line at every cue, and (if the video has its own audio) the
loudness of that audio. Open the PNG and check: is the first 2 s alive, is the density even, do big
sounds sit on the right frames, are there long empty stretches or piles of overlapping sounds, do the
low frequencies (bottom of the spectrogram) only appear where a big moment happens.
Also prints a per-2-seconds density strip. A film longer than about 90 s on one picture is a red wall:
use --chunk 30 (or look at one stretch with --from/--to or with zoom.py).
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import load_json, run

W = 1600


def ff(args):
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-nostdin"] + args, capture_output=True, text=True, errors="replace")
    if r.returncode:
        sys.exit("ffmpeg failed:\n" + r.stderr[-1500:])


def render(sheet, track, out, t_lo, t_hi):
    """One picture of the window [t_lo, t_hi] of the film."""
    cues = sorted((c for c in sheet["cues"] if t_lo - 1e-6 <= c["t"] <= t_hi + 1e-6), key=lambda c: c["t"])
    span = max(0.5, t_hi - t_lo)
    video = sheet.get("video")
    out = Path(out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.parent / (out.stem + "_parts")
    tmp.mkdir(exist_ok=True)

    xs = [int((c["t"] - t_lo) / span * W) for c in cues]
    marks = ",".join(f"drawbox=x={min(W - 2, x)}:y=0:w=2:h=ih:color=red@0.9:t=fill" for x in xs) or "null"

    wave, spec = tmp / "wave.png", tmp / "spec.png"
    win = ["-ss", f"{t_lo:.3f}", "-t", f"{span:.3f}"]
    ff(win + ["-i", str(track), "-filter_complex",
              f"[0:a]aformat=channel_layouts=mono,showwavespic=s={W}x170:colors=0x4ade80,{marks}", "-frames:v", "1",
              str(wave)])
    ff(win + ["-i", str(track), "-filter_complex",
              f"[0:a]aformat=channel_layouts=mono,showspectrumpic=s={W}x240:legend=0:fscale=log:scale=log:color=magma,"
              f"{marks}", "-frames:v", "1", str(spec)])

    parts = []
    if video and Path(video).exists() and cues:
        # frames at their time position; skip a frame when it would overlap the previous one
        fw, fh, kept, last_x = 176, 99, [], -999
        for c, x in zip(cues, xs):
            if x - last_x >= fw + 4 and c["t"] < t_hi - 0.02:
                kept.append((c, x))
                last_x = x
        if kept:
            inp = ["-f", "lavfi", "-i", f"color=c=0x111418:s={W}x{fh + 6}:d=1"]
            for i, (c, x) in enumerate(kept):
                inp += ["-ss", f"{max(0.0, c['t'] + 0.05):.3f}", "-i", str(video)]
            chain, prev = [], "[0:v]"
            for i, (c, x) in enumerate(kept):
                chain.append(f"[{i + 1}:v]setpts=PTS-STARTPTS,scale={fw}:{fh},"
                             f"drawbox=x=0:y=0:w={fw}:h={fh}:color=white@0.35:t=1[f{i}]")
                px = max(0, min(W - fw, x - fw // 2))
                chain.append(f"{prev}[f{i}]overlay=x={px}:y=3[o{i}]")
                prev = f"[o{i}]"
            strip = tmp / "strip.png"
            ff(inp + ["-filter_complex", ";".join(chain), "-map", prev, "-frames:v", "1", str(strip)])
            parts.append(strip)
    parts += [wave, spec]

    cmd = []
    for p in parts:
        cmd += ["-i", str(p)]
    ff(cmd + ["-filter_complex", "".join(f"[{i}:v]" for i in range(len(parts))) + f"vstack=inputs={len(parts)}",
              "-frames:v", "1", str(out)])

    # density strip, 2 s buckets
    n = max(1, int(-(-span // 2)))
    buckets = [0] * n
    for c in cues:
        if not c.get("_layer"):
            buckets[min(n - 1, int((c["t"] - t_lo) // 2))] += 1
    print(f"{t_lo:g}-{t_hi:g} s, {sum(buckets)} sounds; density per 2 s:  " + " ".join(f"{b}" for b in buckets))
    quiet = [f"{t_lo + i * 2:g}-{t_lo + i * 2 + 2:g}s" for i, b in enumerate(buckets) if b == 0]
    if quiet:
        print("empty windows:   ", ", ".join(quiet))
    print("image:", out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cues")
    ap.add_argument("track")
    ap.add_argument("--out", required=True)
    ap.add_argument("--from", dest="t_from", type=float, help="start of the window, seconds")
    ap.add_argument("--to", dest="t_to", type=float, help="end of the window, seconds")
    ap.add_argument("--chunk", type=float, help="one picture per this many seconds (a long film)")
    a = ap.parse_args()

    sheet = load_json(a.cues)
    cues = sheet["cues"]
    dur = sheet.get("duration") or (max(c["t"] for c in cues) + 1 if cues else 1.0)
    if a.chunk:
        out = Path(a.out)
        t = a.t_from or 0.0
        end = a.t_to or dur
        while t < end - 0.5:
            hi = min(end, t + a.chunk)
            render(sheet, a.track, out.with_name(f"{out.stem}_{int(t):04d}-{int(hi):04d}{out.suffix}"), t, hi)
            t = hi
        return
    t_lo = a.t_from or 0.0
    t_hi = a.t_to or dur
    if t_hi - t_lo > 90 and not (a.t_from or a.t_to):
        print("note: a film this long on one picture is a red wall; --chunk 30 gives one picture per 30 s")
    render(sheet, a.track, a.out, t_lo, t_hi)


if __name__ == "__main__":
    main()
