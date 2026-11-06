#!/usr/bin/env python3
"""Look at a video the way a sound designer does: frames with timestamps and, under them, the sound that is already there.

  python look.py film.mp4 --out work/look                       # the whole film: rows of frames + original audio spectrogram
  python look.py film.mp4 --at 12.4 --span 3 --out work/at12.png  # eight frames around a moment + spectrogram
  python look.py film.mp4 --at 12.4 --span 2.4 --step 0.1 --out work/at12.png   # 24 frames, a frame every 0.1 s
  python look.py --moments work/moments/moments.json --out work/moments.png [--per 12 --cols 4]

What it is for (before any sound is placed, so it needs no cue sheet):
  * the story sheet shows what happens when and where the original audio (voice, music) is busy, so the
    placement of sounds is decided from pictures, not from numbers alone;
  * --at is the close look at a fast action or a doubtful moment, the same strip zoom.py draws for a finished mix;
  * --moments tiles the frames that find_moments.py / from_hyperframes.py picked, labelled with id, time, kind
    and strength, so a draft cue sheet can be checked against the picture in a few images.

Reading the spectrogram (low pitch at the bottom, time to the right, brightness = energy): a voice is a stack of
horizontal bands that come and go as phrases; music is a steady carpet with a beat as vertical bars; silence is
black. Thin white ticks mark the frame boundaries so the two halves line up.
"""
import argparse
import os
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

W_TILE, H_TILE, PER_ROW, H_SPEC = 240, 135, 8, 72


def find_font():
    for p in ("C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/calibri.ttf",
              "/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans.ttf"):
        if Path(p).exists():
            return p
    return None


def esc(path):
    return str(path).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")


def ff(args):
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-nostdin"] + [str(a) for a in args], capture_output=True,
                       text=True, errors="replace")
    if r.returncode:
        sys.exit("ffmpeg failed:\n" + r.stderr[-1500:])


def probe(video):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                        "format=duration:stream=codec_type,duration,r_frame_rate", "-of", "json", str(video)],
                       capture_output=True, text=True)
    j = json.loads(r.stdout or "{}")
    kinds = [s["codec_type"] for s in j.get("streams", [])]
    if "video" not in kinds:
        sys.exit(f"{video} has no picture: look.py shows frames. For a sound file use zoom.py or contact_sheet.py "
                 f"(waveform and spectrogram).")
    dur = float(j.get("format", {}).get("duration", 0) or 0)
    # a reel's audio is often a few tenths of a second longer than its picture: a frame asked for after the last
    # picture is not written (and ffmpeg still says 0, the sheet then dies on a missing row): measure by the picture
    vs = [s for s in j.get("streams", []) if s.get("codec_type") == "video"]
    vd = float(vs[0].get("duration") or 0) if vs else 0.0
    if 0 < vd < dur:
        dur = vd
    try:                                   # the last picture STARTS one frame before the end of the stream
        num, den = str(vs[0].get("r_frame_rate", "30/1")).split("/")
        fps = float(num) / float(den)
        if 1.0 <= fps <= 240.0 and dur > 1.0:
            dur -= 1.2 / fps
    except (ValueError, ZeroDivisionError, IndexError):
        pass
    return dur, "audio" in kinds


def label_filter(text, font, tmp, name, size=14):
    """drawtext fragment that writes `text` in the top-left corner on a dark bar (text goes through a file)."""
    if not font:
        return ""
    f = Path(tmp) / f"{name}.txt"
    f.write_text(text, encoding="utf-8")
    return (f",drawbox=x=0:y=0:w=iw:h={size + 8}:color=black@0.65:t=fill,"
            f"drawtext=fontfile='{esc(font)}':textfile='{esc(f)}':expansion=none:fontcolor=yellow:fontsize={size}:x=5:y=4")


CROP = None                                  # (x, y, w, h) of the picture, set by --crop


def frames_row(video, t_list, tmp, name, font, labels, w=None, h=None):
    """One horizontal strip: a frame at each time of t_list, each labelled."""
    inp, chain = [], []
    w, h = w or W_TILE, h or H_TILE
    crop = f"crop={CROP[2]}:{CROP[3]}:{CROP[0]}:{CROP[1]}," if CROP else ""
    for i, t in enumerate(t_list):
        inp += ["-ss", f"{max(0.0, t):.3f}", "-i", str(video)]
        lab = label_filter(labels[i], font, tmp, f"{name}_{i}")
        chain.append(f"[{i}:v]setpts=PTS-STARTPTS,{crop}scale={w}:{h}:force_original_aspect_ratio=decrease,"
                     f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=0x101010,format=rgb24{lab}[f{i}]")
    n = len(t_list)
    stack = "".join(f"[f{i}]" for i in range(n)) + (f"hstack=inputs={n}[row]" if n > 1 else "")
    graph = ";".join(chain + ([stack] if n > 1 else []))
    out = Path(tmp) / f"{name}.png"
    mapped = "[row]" if n > 1 else "[f0]"
    ff(inp + ["-filter_complex", graph, "-map", mapped, "-frames:v", "1", out])
    return out


def spec_row(video, t0, span, width, tmp, name, ticks):
    """Spectrogram of the original audio over [t0, t0+span], with tick marks at the tile boundaries."""
    out = Path(tmp) / f"{name}.png"
    marks = ",".join(f"drawbox=x={min(width - 1, int(width * k / ticks))}:y=0:w=1:h=ih:color=white@0.35:t=fill"
                     for k in range(ticks + 1))
    ff(["-ss", f"{max(0.0, t0):.3f}", "-t", f"{span:.3f}", "-i", str(video), "-vn", "-filter_complex",
        f"[0:a]aformat=channel_layouts=mono,showspectrumpic=s={width}x{H_SPEC}:legend=0:fscale=log:scale=log:"
        f"color=viridis,format=rgb24,{marks}", "-frames:v", "1", out])
    return out


def stack_png(parts, out):
    cmd = []
    for p in parts:
        cmd += ["-i", str(p)]
    n = len(parts)
    if n == 1:
        ff(cmd + ["-frames:v", "1", out])
    else:
        ff(cmd + ["-filter_complex", "".join(f"[{i}:v]" for i in range(n)) + f"vstack=inputs={n}", "-frames:v", "1", out])


def story(video, out_prefix, step=None, rows_per_sheet=4):
    dur, has_audio = probe(video)
    if dur <= 0:
        sys.exit(f"cannot read {video}")
    font = find_font()
    if step is None:
        step = max(0.5, math.ceil(dur / 48 * 2) / 2)             # at most 48 frames in all
    n_tiles = max(1, int(math.ceil(dur / step)))
    rows = [list(range(i, min(i + PER_ROW, n_tiles))) for i in range(0, n_tiles, PER_ROW)]
    sheets = []
    with tempfile.TemporaryDirectory() as tmp:
        row_imgs = []
        for ri, tiles in enumerate(rows):
            ts = [min(dur - 0.05, (k + 0.5) * step) for k in tiles]
            labels = [(f"{t:.2f}".rstrip("0").rstrip(".") + "s") for t in ts]   # the time of the frame shown
            parts = [frames_row(video, ts, tmp, f"r{ri}", font, labels)]
            if has_audio:
                t0 = tiles[0] * step
                span = (tiles[-1] + 1) * step - t0
                # pad a short last row so tile boundaries still line up with the spectrogram
                width = W_TILE * len(tiles)
                parts.append(spec_row(video, t0, span, width, tmp, f"s{ri}", len(tiles)))
            img = Path(tmp) / f"row{ri}.png"
            stack_png(parts, img)
            row_imgs.append(img)
        for si in range(0, len(row_imgs), rows_per_sheet):
            chunk = row_imgs[si:si + rows_per_sheet]
            dst = Path(f"{out_prefix}_{si // rows_per_sheet + 1}.png")
            dst.parent.mkdir(parents=True, exist_ok=True)
            if len(chunk) == 1:
                stack_png(chunk, dst)
            else:
                # rows can differ in width (last row shorter): pad to the widest one
                wmax = W_TILE * PER_ROW
                cmd, g = [], []
                for i, p in enumerate(chunk):
                    cmd += ["-i", str(p)]
                    g.append(f"[{i}:v]pad={wmax}:ih:0:0:color=0x101010[p{i}]")
                g.append("".join(f"[p{i}]" for i in range(len(chunk))) + f"vstack=inputs={len(chunk)}")
                ff(cmd + ["-filter_complex", ";".join(g), "-frames:v", "1", dst])
            sheets.append(dst)
    print(f"{dur:.1f} s, a frame every {step:g} s, {len(rows)} rows, original audio "
          f"{'shown under each row' if has_audio else 'absent'}")
    for s in sheets:
        print("sheet:", s)
    return sheets


def at(video, centre, span, out, step=None):
    """Frames around a moment: eight in one row, or with `step` one frame every `step` s (up to 24, rows of eight, the
    original sound under each row): the way to read a fast, dense animation frame by frame."""
    dur, has_audio = probe(video)
    font = find_font()
    t0 = max(0.0, centre - span / 2)
    n = PER_ROW if not step else max(2, min(24, int(round(span / step))))
    dt = span / n
    ts = [t0 + dt * (i + 0.5) for i in range(n)]
    with tempfile.TemporaryDirectory() as tmp:
        parts = []
        rows = [ts[i:i + PER_ROW] for i in range(0, n, PER_ROW)]
        for ri, row_ts in enumerate(rows):
            row = frames_row(video, row_ts, tmp, f"at{ri}", font, [f"{t:.2f}s" for t in row_ts])
            sub = [row]
            if has_audio:
                sub.append(spec_row(video, row_ts[0] - dt / 2, dt * len(row_ts), W_TILE * len(row_ts), tmp,
                                    f"atspec{ri}", len(row_ts)))
            img = Path(tmp) / f"atrow{ri}.png"
            stack_png(sub, img)
            parts.append(img)
        out = Path(out)
        out.parent.mkdir(parents=True, exist_ok=True)
        if len(parts) == 1:
            stack_png(parts, out)
        else:                                      # the last row may be shorter: pad to the widest
            wmax = W_TILE * PER_ROW
            cmd, g = [], []
            for i, p in enumerate(parts):
                cmd += ["-i", str(p)]
                g.append(f"[{i}:v]pad={wmax}:ih:0:0:color=0x101010[p{i}]")
            g.append("".join(f"[p{i}]" for i in range(len(parts))) + f"vstack=inputs={len(parts)}")
            ff(cmd + ["-filter_complex", ";".join(g), "-frames:v", "1", out])
    print(f"window {t0:.2f}-{t0 + span:.2f} s, a frame every {dt:.2f} s ->", out)


def events_sheet(video, events, out, per, cols):
    """An event list of ui_events.py (no frame images): a BEFORE and an AFTER frame of the picture (or of --crop) for
    every event, so the false ones (a hover, a redraw, a timer) are seen at once. `per` events to a sheet."""
    font = find_font()
    evs = sorted((e for e in events if isinstance(e, dict) and "t" in e), key=lambda e: float(e["t"]))
    if not evs:
        sys.exit("no events with a time in that file")
    n_cols = max(2, cols - cols % 2)                         # tiles come in pairs
    w = W_TILE if W_TILE >= 200 else 240
    h = H_TILE
    total = len(evs)
    limit = max(6, per)                                      # a hundred keystrokes are not a hundred pictures
    if total > limit:
        groups = {}
        for e in evs:
            groups.setdefault((e.get("type"), e.get("roi")), []).append(e)
        take = max(2, limit // max(1, len(groups)))
        chosen = []
        for g in groups.values():
            if len(g) <= take:
                chosen += g
            else:
                chosen += [g[round(i * (len(g) - 1) / (take - 1))] for i in range(take)]
        evs = sorted(chosen, key=lambda e: float(e["t"]))[:max(limit, len(groups) * 2)]
        print(f"{total} events: an even sample of {len(evs)} from every region and kind (--per N shows more)")
    per = 6                                                  # events on one sheet (two tiles each)
    outs = []
    with tempfile.TemporaryDirectory() as tmp:
        for si in range(0, len(evs), per):
            chunk = evs[si:si + per]
            tiles = []
            for k, e in enumerate(chunk):
                t = float(e["t"])
                name = f"{e.get('type', '?')}" + (f" {e['roi']}" if e.get("roi") else "")
                tiles.append((max(0.0, t - 0.25), f"#{si + k} {t:.2f}s {name[:22]} before"))
                tiles.append((t + 0.2, f"#{si + k} after"))
            rows = [tiles[i:i + n_cols] for i in range(0, len(tiles), n_cols)]
            parts = []
            for ri, row in enumerate(rows):
                p = frames_row(video, [t for t, _ in row], tmp, f"ev{si}_{ri}", font, [l for _, l in row], w=w, h=h)
                if len(row) < n_cols and len(rows) > 1:
                    full = Path(tmp) / f"ev{si}_{ri}_pad.png"
                    ff(["-i", p, "-vf", f"pad={n_cols * w}:ih:0:0:color=0x101010", "-frames:v", "1", full])
                    p = full
                parts.append(p)
            dst = Path(f"{Path(out).with_suffix('')}_{si // per + 1}.png") if len(evs) > per else Path(out)
            dst.parent.mkdir(parents=True, exist_ok=True)
            stack_png(parts, dst)
            outs.append(dst)
    print(f"{len(evs)} events on {len(outs)} sheet(s) (a frame before and after each):")
    for o in outs:
        print("sheet:", o)


def moments_sheet(mj, out, per, cols):
    d = json.loads(Path(mj).read_text(encoding="utf-8-sig"))
    base = Path(mj).parent
    if isinstance(d, list):                 # an event list (ui_events.py events.json), not a moments.json
        return d
    ms = [m for m in d["moments"] if m.get("frame")]
    if not ms:
        sys.exit("no moment in this file has a frame image (from_hyperframes.py has none: use find_moments.py "
                 "or look.py FILM --out ...)")
    font = find_font()
    W, H = 400, 225
    outs = []
    with tempfile.TemporaryDirectory() as tmp:
        for si in range(0, len(ms), per):
            chunk = ms[si:si + per]
            inp, chain, pos = [], [], []
            for i, m in enumerate(chunk):
                inp += ["-i", str(base / m["frame"])]
                text = f"#{m['id']} {m['t']:.2f}s {m['kind']} s={m.get('strength', 0):.2f} p={m.get('pct', 0):.2f}"
                if m.get("hint"):
                    text += f" {m['hint'][:24]}"
                lab = label_filter(text, font, tmp, f"m{si}_{i}", size=15)
                chain.append(f"[{i}:v]scale={W}:{H}:force_original_aspect_ratio=decrease,"
                             f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=0x101010,format=rgb24{lab}[t{i}]")
                pos.append(f"{(i % cols) * W}_{(i // cols) * H}")
            n = len(chunk)
            if n > 1:
                graph = ";".join(chain + ["".join(f"[t{i}]" for i in range(n)) +
                                          f"xstack=inputs={n}:layout={'|'.join(pos)}:fill=0x101010[sheet]"])
                lab_out = "[sheet]"
            else:
                graph, lab_out = ";".join(chain), "[t0]"
            dst = Path(f"{Path(out).with_suffix('')}_{si // per + 1}.png") if len(ms) > per else Path(out)
            dst.parent.mkdir(parents=True, exist_ok=True)
            ff(inp + ["-filter_complex", graph, "-map", lab_out, "-frames:v", "1", dst])
            outs.append(dst)
    print(f"{len(ms)} moments on {len(outs)} sheet(s):")
    for o in outs:
        print("sheet:", o)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video", nargs="?")
    ap.add_argument("--out", required=True, help="output prefix (story), PNG (--at / --moments)")
    ap.add_argument("--at", type=float, help="centre of a close look, seconds")
    ap.add_argument("--span", type=float, default=3.0)
    ap.add_argument("--step", type=float,
                    help="seconds per frame: in the story sheet (default: at most 48 frames; a smaller step makes "
                         "several sheets), and with --at the step inside the window (up to 24 frames, 8 to a row)")
    ap.add_argument("--moments", help="moments.json: tile its frames with their labels")
    ap.add_argument("--tile-w", type=int, default=240,
                    help="width of one frame in pixels (240 shows the story; 480 makes interface text readable)")
    ap.add_argument("--crop", help="x,y,w,h of the picture to show (a region of the screen: input field, toasts)")
    ap.add_argument("--per", type=int, default=12)
    ap.add_argument("--cols", type=int, default=4)
    a = ap.parse_args()
    global W_TILE, H_TILE, PER_ROW, CROP
    if a.crop:
        CROP = tuple(int(float(v)) for v in a.crop.split(","))
    W_TILE = max(120, a.tile_w)
    H_TILE = int(W_TILE * (CROP[3] / CROP[2])) if CROP else int(W_TILE * 9 / 16)
    PER_ROW = max(2, min(8, 1920 // W_TILE))
    out_ = a.out
    if (a.moments or a.at is not None) and os.path.splitext(out_)[1].lower() not in (".png", ".jpg", ".jpeg"):
        out_ = out_ + ".png"                 # a picture needs an extension (the story mode takes a prefix)
        print(f"note: --out has no image extension, writing {out_}")
    if a.moments:
        got = moments_sheet(a.moments, out_, a.per, a.cols)
        if isinstance(got, list):
            if not a.video:
                ap.error("an event list needs the film too: look.py FILM --moments events.json --out sheet.png "
                         "[--crop x,y,w,h]")
            events_sheet(a.video, got, out_, a.per * 2, a.cols)
    elif a.video and a.at is not None:
        at(a.video, a.at, a.span, out_, a.step)
    elif a.video:
        story(a.video, a.out, a.step)
    else:
        ap.error("give a video, or --moments")


if __name__ == "__main__":
    main()
