#!/usr/bin/env python3
"""Frame-by-frame analysis of a video: find the moments that deserve a sound.

Outputs <out>/moments.json and one JPG per moment in <out>/frames/ so they can be looked at.
Moment kinds:
  cut     hard scene change or full-frame swap           -> whoosh / transition / hit
  burst   sharp spike of motion above the local level    -> hit, whoosh, pop
  onset   picture was still, then something starts       -> ui, click, pop-in, riser end
  settle  motion ended and the picture came to rest      -> landing hit, click, soft thud
Only needs ffmpeg/ffprobe. Everything is measured at a reduced size and 15 fps, so it is fast.

  python find_moments.py video.mp4 --out work/moments [--max 40] [--fps 15] [--fine]

--fine is for soft, coloured animations (gradients, glows, pastel shapes that change hue): the default reads the
brightness only and sees 5-6 moves of the 40 a person finds there. It also reads the chroma change; moments it adds
carry src=chroma|luma. It is a candidate list: the frames (look.py --at T --span S) still decide.
"""
import argparse
import json
import re
import statistics
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import run


def probe(video):
    p = run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate",
             "-of", "json", str(video)])
    j = json.loads(p.stdout)
    v = next((s for s in j["streams"] if s["codec_type"] == "video"), {})
    num, _, den = v.get("r_frame_rate", "30/1").partition("/")
    return {
        "duration": float(j["format"]["duration"]),
        "width": v.get("width"), "height": v.get("height"),
        "fps": round(float(num) / float(den or 1), 3),
        "has_audio": any(s["codec_type"] == "audio" for s in j["streams"]),
    }


def audio_level(video):
    p = run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(video), "-vn", "-af", "volumedetect", "-f", "null", "-"])
    m = re.search(r"mean_volume:\s*(-?[\d.]+) dB", p.stderr)
    return float(m.group(1)) if m else None


def _span_args(t0, t1):
    out = []
    if t0:
        out += ["-ss", f"{t0:.3f}"]
    if t1:
        out += ["-t", f"{max(0.1, t1 - (t0 or 0.0)):.3f}"]
    return out


def ydif_series(video, fps, roi=None, t0=0.0, t1=None):
    # metadata goes to stdout (file=-): no temp files and no cwd, so long Windows paths cannot break it
    r = run(["ffmpeg", "-v", "error", "-nostdin"] + _span_args(t0, t1) + ["-i", str(video), "-an",
             "-vf", (f"crop={roi[2]}:{roi[3]}:{roi[0]}:{roi[1]}," if roi else "") +
                    f"fps={fps},scale=160:-2,signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=-",
             "-f", "null", "-"])
    if "YDIF" not in r.stdout:
        sys.exit("motion analysis failed:\n" + r.stderr[-1500:])
    ts, ys, t = [], [], None
    for line in r.stdout.splitlines():
        m = re.search(r"pts_time:([\d.]+)", line)
        if m:
            t = float(m.group(1))
        m = re.search(r"YDIF=([\d.]+)", line)
        if m and t is not None:
            ts.append(t + (t0 or 0.0))
            ys.append(float(m.group(1)))
    return ts, ys


def diff_series(video, fps, roi=None, t0=0.0, t1=None):
    """Luma AND chroma change per frame: (times, YDIF, UDIF + VDIF). Soft, coloured animations (gradients, glows,
    pastel shapes that change hue, not brightness) move the chroma planes and hardly the luma."""
    r = run(["ffmpeg", "-v", "error", "-nostdin"] + _span_args(t0, t1) + ["-i", str(video), "-an",
             "-vf", (f"crop={roi[2]}:{roi[3]}:{roi[0]}:{roi[1]}," if roi else "") +
                    f"fps={fps},scale=160:-2,signalstats,metadata=print:file=-",
             "-f", "null", "-"])
    if "YDIF" not in r.stdout:
        sys.exit("motion analysis failed:\n" + r.stderr[-1500:])
    ts, ys, cs = [], [], []
    t = y = u = v = None
    for line in r.stdout.splitlines():
        m = re.search(r"pts_time:([\d.]+)", line)
        if m:
            if t is not None and y is not None:
                ts.append(t + (t0 or 0.0))
                ys.append(y)
                cs.append((u or 0.0) + (v or 0.0))
            t, y, u, v = float(m.group(1)), None, None, None
            continue
        m = re.search(r"signalstats\.([YUV])DIF=([\d.]+)", line)
        if m:
            val = float(m.group(2))
            if m.group(1) == "Y":
                y = val
            elif m.group(1) == "U":
                u = val
            else:
                v = val
    if t is not None and y is not None:
        ts.append(t + (t0 or 0.0))
        ys.append(y)
        cs.append((u or 0.0) + (v or 0.0))
    return ts, ys, cs


def series_peaks(ts, sig, fps, k=3.0, floor=0.3, min_gap=0.12):
    """Local maxima of the rise of a change signal over its +-0.5 s median that stand k robust sigmas above the
    noise: [(t, rise)]. The floor keeps a still picture's compression noise from becoming events."""
    n = len(sig)
    if n < 5:
        return []
    half = max(2, int(0.5 * fps))
    base = [statistics.median(sig[max(0, i - half): i + half + 1]) for i in range(n)]
    res = [s - b for s, b in zip(sig, base)]
    med = statistics.median(res)
    mad = statistics.median(abs(r - med) for r in res)
    thr = max(floor, k * 1.4826 * mad)
    out = []
    for i in range(1, n - 1):
        if res[i] > thr and res[i] >= res[i - 1] and res[i] >= res[i + 1]:
            if out and ts[i] - out[-1][0] < min_gap:
                if res[i] > out[-1][1]:
                    out[-1] = (ts[i], res[i])
                continue
            out.append((ts[i], res[i]))
    return out


def scene_cuts(video, threshold, t0=0.0, t1=None):
    r = run(["ffmpeg", "-v", "error", "-nostdin"] + _span_args(t0, t1) + ["-i", str(video), "-an",
             "-vf", f"scale=320:-2,select='gt(scene,{threshold})',metadata=print:file=-", "-f", "null", "-"])
    cuts, t = [], None
    for line in r.stdout.splitlines():
        m = re.search(r"pts_time:([\d.]+)", line)
        if m:
            t = float(m.group(1))
        m = re.search(r"scene_score=([\d.]+)", line)
        if m and t is not None:
            cuts.append((t + (t0 or 0.0), float(m.group(1))))
    return cuts


def refine(video, t, kind, span=0.2):
    """Re-measure a +-span window at the source frame rate and return the exact frame time."""
    t0 = max(0.0, t - span)
    r = run(["ffmpeg", "-v", "error", "-nostdin", "-ss", f"{t0:.3f}", "-t", f"{2 * span:.3f}", "-i", str(video), "-an",
             "-vf", "scale=160:-2,signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=-", "-f", "null", "-"])
    pts, cur = [], None
    for line in r.stdout.splitlines():
        m = re.search(r"pts_time:([\d.]+)", line)
        if m:
            cur = float(m.group(1))
        m = re.search(r"YDIF=([\d.]+)", line)
        if m and cur is not None:
            pts.append((t0 + cur, float(m.group(1))))
    if not pts:
        return t
    peak = max(y for _, y in pts)
    if kind == "onset":   # first frame that reaches half of the window's peak
        return next(tt for tt, y in pts if y >= 0.5 * peak)
    return max(pts, key=lambda p: p[1])[0]


def detect(ts, ys, fps):
    n = len(ys)
    if n < 5:
        return []
    half = max(2, int(fps))  # +-1 s rolling median = "the usual amount of motion here"
    base = [statistics.median(ys[max(0, i - half): i + half + 1]) for i in range(n)]
    res = [y - b for y, b in zip(ys, base)]
    mad = statistics.median(abs(r) for r in res) or 0.05
    thr = max(1.2, 4 * 1.4826 * mad)
    still = 0.6          # mean luma change per frame below this = a held frame
    look = max(2, int(0.4 * fps))
    out = []

    # bursts: local maxima of the residual, at least 0.2 s apart
    last_t = -9
    for i in range(1, n - 1):
        if res[i] > thr and res[i] >= res[i - 1] and res[i] >= res[i + 1]:
            if ts[i] - last_t < 0.2 and out and out[-1]["kind"] == "burst":
                if res[i] > out[-1]["raw"]:
                    out[-1].update(t=ts[i], raw=res[i])
                    last_t = ts[i]
                continue
            out.append({"t": ts[i], "kind": "burst", "raw": res[i]})
            last_t = ts[i]
    # onsets and settles around held frames
    for i in range(look, n - look):
        before = sum(ys[i - look:i]) / look
        after = sum(ys[i:i + look]) / look
        if before < still and ys[i] > 2.0:
            out.append({"t": ts[i], "kind": "onset", "raw": ys[i]})
        elif before > 2.0 and after < still and ys[i] < still:
            out.append({"t": ts[i], "kind": "settle", "raw": before})
    # thin out repeats of the same kind closer than 0.25 s
    out.sort(key=lambda m: m["t"])
    thin = []
    for m in out:
        if thin and thin[-1]["kind"] == m["kind"] and m["t"] - thin[-1]["t"] < 0.25:
            if m["raw"] > thin[-1]["raw"]:
                thin[-1] = m
            continue
        thin.append(m)
    return thin


def visual_moments(video, fps=15.0, scene=0.30, max_other=40, roi=None, t0=0.0, t1=None, fine=False):
    """Cuts, bursts, onsets and settles of a video, strongest non-cut moments first-limited.

    Returns (moments sorted by time, mean frame-to-frame luma change). Each moment: t, kind, strength.
    fine: the picture is soft and coloured (gradients, glows, shapes that change hue): the chroma change is read as
    well as the luma, and its peaks (and the luma's at a lower bar) become `burst` moments of their own, marked
    `src`. On three such reels this found 42-50 % of the events a person reading the frames wrote down, against 25 %
    for luma alone.
    """
    if fine:
        ts, ys, cs = diff_series(video, fps, roi, t0, t1)
    else:
        ts, ys = ydif_series(video, fps, roi, t0, t1)
        cs = None
    cuts = scene_cuts(video, scene, t0, t1) if not roi else []
    moments = [{"t": t, "kind": "cut", "raw": s, "exact": True} for t, s in cuts]
    cut_ts = [c["t"] for c in moments]
    prio = {"onset": 0, "burst": 1, "settle": 2}
    kept = []
    for m in sorted(detect(ts, ys, fps), key=lambda m: (prio[m["kind"]], m["t"])):
        if any(abs(m["t"] - c) < 0.15 for c in cut_ts):
            continue                      # the cut itself is the event
        if m["kind"] == "settle" and any(0 <= m["t"] - c < 0.5 for c in cut_ts):
            continue                      # motion that merely decays after a cut
        if any(abs(m["t"] - k["t"]) < 0.12 for k in kept):
            continue                      # burst/onset/settle describing one and the same event
        kept.append(m)
    moments += kept

    if fine and cs is not None:
        # the extra moves: peaks of the chroma change and of the luma change at a lower bar, none within 0.1 s of a
        # moment already found. Their `raw` is brought to the luma scale (the 90th percentile of the signal's own
        # peaks = 6) so that the strengths below mean the same for all of them.
        extras = []
        for src_, sig_, floor_, k_ in (("chroma", cs, 0.3, 3.0), ("luma", ys, 1.0, 2.0)):
            pk_ = series_peaks(ts, sig_, fps, k=k_, floor=floor_)
            if not pk_:
                continue
            rises = sorted(r_ for _, r_ in pk_)
            p90_ = rises[int(0.9 * (len(rises) - 1))] or 1.0
            for t_, r_ in pk_:
                extras.append({"t": t_, "kind": "burst", "raw": 6.0 * r_ / p90_, "src": src_})
        extras.sort(key=lambda m: (-m["raw"], m["t"]))
        for m in extras:
            if any(abs(m["t"] - k["t"]) < 0.10 for k in moments):
                continue
            if any(abs(m["t"] - c) < 0.12 for c in cut_ts):
                continue
            moments.append(m)

    # refine bursts/onsets at the video's own frame rate: +-1 frame instead of +-1/fps (not the chroma ones: the
    # refinement reads the luma, which did not move there)
    for m in moments:
        if m["kind"] in ("burst", "onset") and m.get("src") != "chroma":
            m["t"] = refine(video, m["t"], m["kind"])

    # refinement can move an onset/burst onto the very frame of a cut: the cut then is the event, drop the twin
    cut_ts = [m["t"] for m in moments if m["kind"] == "cut"]
    moments = [m for m in moments if m["kind"] == "cut" or all(abs(m["t"] - c) >= 0.12 for c in cut_ts)]
    thin = []
    for m in sorted((m for m in moments if m["kind"] != "cut"), key=lambda m: (prio[m["kind"]], m["t"])):
        if all(abs(m["t"] - k["t"]) >= 0.10 for k in thin):
            thin.append(m)
    moments = [m for m in moments if m["kind"] == "cut"] + thin

    # strengths are comparable only inside a group: cuts use the scene score, the rest use motion
    for group in (["cut"], ["burst", "onset", "settle"]):
        g = [m for m in moments if m["kind"] in group]
        if not g:
            continue
        top = sorted(m["raw"] for m in g)[int(0.9 * (len(g) - 1))] or 1
        # absolute floor: in a calm film a single twitch must not become "strength 1.0" just because it is the only
        # one (busy UI films have bursts of 2-40, noise stays under 2; scene scores of real cuts are 0.3-1)
        top = max(top, 0.6 if group == ["cut"] else 6.0)
        order = sorted(g, key=lambda m: m["raw"])
        for rank, m in enumerate(order):
            m["strength"] = round(min(1.0, m["raw"] / top), 2)
            # rank within its group (0 = weakest, 1 = strongest): strength saturates at 1.0 for many moments,
            # the rank still tells which ones are really the biggest
            m["pct"] = round(rank / max(1, len(order) - 1), 2)
    cuts_k = [m for m in moments if m["kind"] == "cut"]
    rest = sorted((m for m in moments if m["kind"] != "cut"), key=lambda m: -m["strength"])[: max_other]
    moments = sorted(cuts_k + rest, key=lambda m: m["t"])

    activity_mean = sum(ys) / max(1, len(ys))
    return moments, activity_mean


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--out", required=True)
    ap.add_argument("--max", type=int, default=0,
                    help="max non-cut moments to keep, strongest first (0 = auto: 15 per 10 s, at least 40)")
    ap.add_argument("--fps", type=float, default=None, help="analysis rate (default 15; 30 with --fine)")
    ap.add_argument("--fine", action="store_true",
                    help="a soft, coloured animation (gradients, glows, pastel shapes): also read the CHROMA change "
                         "and a lower luma bar, so that moves that change hue and not brightness are found "
                         "(moments carry src=chroma|luma). More moments: 25 per 10 s are kept instead of 15")
    ap.add_argument("--scene", type=float, default=0.30, help="scene-change threshold 0..1")
    ap.add_argument("--roi", help="x,y,w,h: look only at this region of the picture (a screen recording: the input "
                                  "field, the toast corner). Cuts are not searched in a region.")
    ap.add_argument("--from", dest="t_from", type=float, default=0.0, help="analyse only from this second")
    ap.add_argument("--to", dest="t_to", type=float, default=None, help="analyse only up to this second")
    a = ap.parse_args()
    roi = tuple(int(float(v)) for v in a.roi.split(",")) if a.roi else None

    out = Path(a.out).resolve()
    (out / "frames").mkdir(parents=True, exist_ok=True)
    info = probe(a.video)
    if info["has_audio"]:
        info["audio_mean_db"] = audio_level(a.video)

    span_ = (a.t_to or info["duration"]) - (a.t_from or 0.0)
    per10_ = 25 if a.fine else 15
    limit = a.max or max(40, int(max(1.0, span_) / 10 * per10_))
    fps_ = a.fps if a.fps else (30.0 if a.fine else 15.0)
    moments, act = visual_moments(a.video, fps_, a.scene, limit, roi, a.t_from, a.t_to, fine=a.fine)

    for i, m in enumerate(moments):
        m["id"] = i
        m["t"] = round(m["t"], 3)
        m.pop("raw", None)
        m.pop("exact", None)
        # grab the frame just after the moment: that is the picture the sound has to match
        fn = f"m{i:03d}_t{m['t']:.2f}_{m['kind']}.jpg"
        run(["ffmpeg", "-v", "error", "-y", "-ss", f"{min(m['t'] + 0.05, max(0, info['duration'] - 0.05)):.3f}",
             "-i", str(a.video), "-frames:v", "1", "-vf", "scale=640:-2", str(out / "frames" / fn)])
        m["frame"] = f"frames/{fn}"
        if roi:
            m["roi"] = list(roi)

    activity = {"mean_ydif": round(act, 2)}
    (out / "moments.json").write_text(
        json.dumps({"video": str(a.video), "info": info, "activity": activity, "moments": moments},
                   ensure_ascii=False, indent=1), encoding="utf-8")
    counts = {}
    for m in moments:
        counts[m["kind"]] = counts.get(m["kind"], 0) + 1
    print(f"{info['duration']:.1f}s {info['width']}x{info['height']} {info['fps']}fps "
          f"audio={'yes' if info['has_audio'] else 'no'}")
    print(f"{len(moments)} moments: " + ", ".join(f"{k}={v}" for k, v in counts.items()))
    print(f"-> {out / 'moments.json'}  (frames in {out / 'frames'})")


if __name__ == "__main__":
    main()
