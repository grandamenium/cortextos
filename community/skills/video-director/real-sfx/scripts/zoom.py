#!/usr/bin/env python3
"""Zoom into a few seconds of the finished mix: frames, the SFX waveform and spectrogram, the original audio.

  python zoom.py result/film_sfx_resolved_cues.json result/film_sfx_sfx_track.wav --at 12.4 [--span 3]
                 [--video film.mp4] --out result/zoom_12.4.png

This is the "strip around the fast action" of the self-critique loop: frames every span/8 seconds, red
lines at every cue inside the window, the SFX waveform and spectrogram below, and the spectrogram of the
original audio (voice/music) at the bottom, so a sound that lands on top of speech or fights the music
bass is visible. The window is [at - span/2, at + span/2].
"""
import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import load_json, require_tools

W = 1600
GREEN = "format=rgb24,colorchannelmixer=rr=0.29:gg=0.87:bb=0.5"


def ff(args):
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-nostdin"] + [str(a) for a in args], capture_output=True,
                       text=True, errors="replace")
    if r.returncode:
        sys.exit("ffmpeg failed:\n" + r.stderr[-1200:])


def has_audio(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type",
                        "-of", "csv=p=0", str(path)], capture_output=True, text=True)
    return "audio" in r.stdout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cues")
    ap.add_argument("track")
    ap.add_argument("--at", type=float, required=True)
    ap.add_argument("--span", type=float, default=3.0)
    ap.add_argument("--video", help="the film: frames are drawn above the waveform (default: the sheet's video)")
    ap.add_argument("--out", help="the PNG to write (default: zoom_<time>s.png next to the cue sheet)")
    a = ap.parse_args()
    if not a.out:
        a.out = str(Path(a.cues).resolve().with_name(f"zoom_{a.at:.1f}s.png"))
    require_tools()

    sheet = load_json(a.cues)
    video = a.video or sheet.get("video")
    t0 = max(0.0, a.at - a.span / 2)
    span = a.span
    marks = []
    for c in sheet["cues"]:
        if t0 - 1e-6 <= c["t"] <= t0 + span:
            x = int((c["t"] - t0) / span * W)
            marks.append(f"drawbox=x={min(W - 2, x)}:y=0:w=2:h=ih:color=red@0.9:t=fill")
    mk = ",".join(marks) or "null"
    out = Path(a.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    parts = []
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        if video and Path(video).exists():
            n, fw, fh = 8, W // 8, int(W / 8 * 9 / 16)
            inp, chain = [], []
            for i in range(n):
                tt = t0 + span * (i + 0.5) / n
                inp += ["-ss", f"{tt:.3f}", "-i", str(video)]
                chain.append(f"[{i}:v]setpts=PTS-STARTPTS,scale={fw}:{fh},format=rgb24[f{i}]")
            lay = "".join(f"[f{i}]" for i in range(n)) + f"hstack=inputs={n}[strip]"
            png = tmp / "strip.png"
            ff(inp + ["-filter_complex", ";".join(chain + [lay]), "-map", "[strip]", "-frames:v", "1", png])
            parts.append(png)
        wav = tmp / "wave.png"
        ff(["-ss", f"{t0:.3f}", "-t", f"{span:.3f}", "-i", a.track, "-filter_complex",
            f"[0:a]aformat=channel_layouts=mono,showwavespic=s={W}x120:colors=white,{GREEN},{mk}",
            "-frames:v", "1", wav])
        parts.append(wav)
        spec = tmp / "spec.png"
        ff(["-ss", f"{t0:.3f}", "-t", f"{span:.3f}", "-i", a.track, "-filter_complex",
            f"[0:a]aformat=channel_layouts=mono,showspectrumpic=s={W}x200:legend=0:fscale=log:scale=log:color=magma,"
            f"format=rgb24,{mk}", "-frames:v", "1", spec])
        parts.append(spec)
        orig_src = a.video or sheet.get("original_audio") or video     # what is really under the SFX in the mix
        if orig_src and Path(orig_src).exists() and has_audio(orig_src):
            orig = tmp / "orig.png"
            ff(["-ss", f"{t0:.3f}", "-t", f"{span:.3f}", "-i", str(orig_src), "-vn", "-filter_complex",
                f"[0:a]aformat=channel_layouts=mono,showspectrumpic=s={W}x160:legend=0:fscale=log:scale=log:color=viridis,"
                f"format=rgb24,{mk}", "-frames:v", "1", orig])
            parts.append(orig)
        cmd = []
        for p in parts:
            cmd += ["-i", str(p)]
        ff(cmd + ["-filter_complex", "".join(f"[{i}:v]" for i in range(len(parts))) + f"vstack=inputs={len(parts)}",
                  "-frames:v", "1", out])
    inside = [c for c in sheet["cues"] if t0 <= c["t"] <= t0 + span]
    print(f"window {t0:.2f}-{t0 + span:.2f} s, {len(inside)} cues in it:")
    for c in inside:
        print(f"  {c['t']:7.3f}  {c.get('role', '?'):9s} {c.get('label', '')}")
    print("image:", out, "(top to bottom: frames, SFX wave, SFX spectrogram" +
          (", original audio spectrogram)" if len(parts) == 4 else ")"))


if __name__ == "__main__":
    main()
