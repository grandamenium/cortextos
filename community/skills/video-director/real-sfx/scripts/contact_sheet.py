#!/usr/bin/env python3
"""Draw candidate sounds side by side (waveform + spectrogram) so they can be compared by eye.

  python contact_sheet.py 239 254 249 --out work/candidates.png
  python contact_sheet.py --role whoosh --target-dur 0.7 --limit 8 --out work/whooshes.png [--like 412]
  python search.py --role hit --punchy --limit 8 --sheet work/hits.png            # same, from the search

What to read in a picture (this is how a sound is "heard" without ears):
  * waveform: a hit is a tall spike and a quick fall; a whoosh swells and fades; a riser grows to the end;
    a flat block is a bed or noise. Where the tallest point sits is where the moment will land.
  * spectrogram (time to the right, low pitch at the bottom, brightness = energy):
      - bright blob at the bottom = sub/boom, weight          - bright band at the top = air, sizzle, hiss
      - diagonal streak rising = riser / pitch sweep           - vertical bars = clicks, ticks, glitches
      - horizontal lines = tone, bell, hum                     - smeared noise = whoosh, wind, texture
  * the label gives id, role, length, library and name; loud sounds are not drawn louder, all are normalised.
"""
import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import effective_dur, require_tools
from picker import find, load_index, load_taste, rank

W, H_WAVE, H_SPEC, H_BAR = 460, 60, 110, 22
H = H_BAR + H_WAVE + H_SPEC


def find_font():
    for p in ("C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/calibri.ttf",
              "/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans.ttf"):
        if Path(p).exists():
            return p
    return None


def esc(path):
    """Escape a path for use inside an ffmpeg filter argument."""
    return str(path).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")


def one_row(src, label, out_png, font, tmp, peak_db=None):
    lab = Path(tmp) / (out_png.stem + ".txt")
    lab.write_text(label, encoding="utf-8")
    bar = f"color=c=0x1b1f24:s={W}x{H_BAR}:d=1"
    if font:
        bar += f",drawtext=fontfile='{esc(font)}':textfile='{esc(lab)}':expansion=none:fontcolor=white:fontsize=13:x=6:y=4"
    # every sound is drawn at the same peak level, otherwise a quiet recording looks like silence
    norm = f",volume={max(-6.0, min(40.0, -1.0 - peak_db)):.1f}dB" if peak_db is not None else ""
    graph = (f"[0:a]aformat=channel_layouts=mono{norm},asplit=2[a][b];"
             # showwavespic is a gray image whatever 'colors' says: go to rgb first, then tint it green
             f"[a]showwavespic=s={W}x{H_WAVE}:colors=white,format=rgb24,colorchannelmixer=rr=0.29:gg=0.87:bb=0.5[w];"
             f"[b]showspectrumpic=s={W}x{H_SPEC}:legend=0:fscale=log:scale=log:color=magma,format=rgb24[s];"
             f"{bar},format=rgb24[bar];[bar][w][s]vstack=inputs=3[row]")
    gs = Path(tmp) / (out_png.stem + "_g.txt")
    gs.write_text(graph, encoding="utf-8")
    cmd = ["ffmpeg", "-v", "error", "-y", "-nostdin", "-t", "8", "-i", str(src)]
    for flag in ("-/filter_complex", "-filter_complex_script"):
        r = subprocess.run(cmd + [flag, str(gs), "-map", "[row]", "-frames:v", "1", str(out_png)],
                           capture_output=True, text=True, errors="replace")
        if r.returncode == 0:
            return True
    return False


def render_sheet(records, out, cols=2, taste=None):
    require_tools()
    out = Path(out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    font = find_font()
    taste = taste or load_taste()
    loved = set(taste.get("love", []))
    rows = []
    with tempfile.TemporaryDirectory() as tmp:
        for s in records:
            png = Path(tmp) / f"r{s['id']}.png"
            ad = effective_dur(s)
            dur_ = f"{ad:.2f}s" + ("*" if ad < s["duration"] - 0.15 else "")      # '*': the file is longer
            head = f"#{s['id']}{' +' if s['path'] in loved else ''}  {s['role']}  {dur_}  {s['library']}: "
            lab = head + s["name"][-max(12, 64 - len(head)):]
            if one_row(s["path"], lab, png, font, tmp, s.get("peak_db")):
                rows.append(png)
        if not rows:
            sys.exit("could not draw any of the sounds")
        n = len(rows)
        cols = max(1, min(cols, n))
        lay = "|".join(f"{(i % cols) * W}_{(i // cols) * H}" for i in range(n))
        cmd = ["ffmpeg", "-v", "error", "-y", "-nostdin"]
        for p in rows:
            cmd += ["-i", str(p)]
        if n == 1:
            cmd += ["-c:v", "png", str(out)]
        else:
            cmd += ["-filter_complex",
                    "".join(f"[{i}:v]" for i in range(n)) + f"xstack=inputs={n}:layout={lay}:fill=0x101418[o]",
                    "-map", "[o]", "-frames:v", "1", str(out)]
        r = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
        if r.returncode:
            sys.exit("ffmpeg failed:\n" + r.stderr[-1200:])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*", help="sound ids from search.py (or path fragments)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--cols", type=int, default=2)
    ap.add_argument("--role")
    ap.add_argument("--library")
    ap.add_argument("--min-dur", type=float, default=0)
    ap.add_argument("--max-dur", type=float, default=1e9)
    ap.add_argument("--target-dur", type=float)
    ap.add_argument("--like")
    ap.add_argument("--bright", action="store_true")
    ap.add_argument("--dark", action="store_true")
    ap.add_argument("--punchy", action="store_true")
    ap.add_argument("--query")
    ap.add_argument("--limit", type=int, default=8)
    a = ap.parse_args()

    index = load_index()
    if a.ids:
        recs = [find(index, i) for i in a.ids]
        recs = [r for r in recs if r]
    else:
        spec = {"role": a.role, "library": a.library, "min_dur": a.min_dur, "max_dur": a.max_dur,
                "target_dur": a.target_dur, "bright": a.bright, "dark": a.dark, "punchy": a.punchy, "query": a.query}
        if a.like is not None:
            ref = find(index, a.like)
            if ref:
                spec["like"] = ref["id"]
        recs = [s for _, s in rank(index, spec)[: a.limit]]
    if not recs:
        sys.exit("no sounds to draw")
    out = render_sheet(recs, a.out, a.cols)
    print(f"{len(recs)} sounds -> {out}")
    for i, r in enumerate(recs):
        print(f"  [{i // a.cols + 1},{i % a.cols + 1}] #{r['id']} {r['role']} {r['duration']:.2f}s {r['name']}")


if __name__ == "__main__":
    main()
