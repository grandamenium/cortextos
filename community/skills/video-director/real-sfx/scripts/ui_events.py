#!/usr/bin/env python3
"""Interface events of a screen recording, region by region: keystrokes, toasts and dialogs, scrolls, button
presses, window switches. Writes a typed cue list that from_cues.py turns into sounds.

A screencast has no cut list and almost no motion in the usual sense: one text field is typed into, a corner shows
a toast, a status dot blinks once a second. find_moments.py watches the whole frame and calls the blinking dot "the
strongest moment". Here every region is watched on its own, with its own threshold, and a region says what kind of
event it can produce.

  python ui_events.py rec.mp4 --out work/ui \\
         --roi input=420,980,1080,60:typing  --roi toast=1500,60,400,120:popup  --roi chat=40,120,380,820:scroll
  python ui_events.py rec.mp4 --out work/ui --grid 4x3        # no regions yet: which parts of the picture move?

  --roi NAME=x,y,w,h[:kind[:sound]][@from-to]
                                       pixels, or fractions of the frame when all four numbers are <= 1;
                                       @from-to keeps only that part of the recording (a field that exists while one
                                       window is on screen: input=...:typing@0-91)
      kind   typing   a pulse per keystroke (spinners, status dots and a blinking caret are recognised by their place and left out)  -> "key"
             popup    something appears (toast, dialog, menu, tooltip); its length is how long it stays -> "pop"
             scroll   continuous motion, one event per stretch, with its length           -> "whoosh"
             click    a short local change (button state, highlight)                      -> "click"
             window   the whole picture changes (tab, app, page switch; ffmpeg's scene score,
                      --scene 0.3)                                                        -> "wipe"
             any      every pulse                                                         -> "tick"
      toggle  like popup, and the disappearance is an event too (a dialog closes, an option is chosen)  -> "pop" + "click"
      sound  the cue kind written to events.json (default as above, any kind from_cues.py knows)
      The time range may stand anywhere after the box: input=420,980,1080,60@0-91:typing, same as :typing@0-91.
      When no kind is given it is guessed from the name (input/field -> typing, toast/dialog -> popup, ...).

Output (in --out):
  events.json      typed cue list: [{"t": 12.34, "type": "key", "g": 0.8, "roi": "input"}, ...]  -> from_cues.py
  ui_events.json   everything measured: per region the noise floor, threshold, events, counts per 10 s, flags
  timeline.png     one row per region: activity (bars), the threshold (dashes) and the events found (red). Look at
                   it before you trust the list.
  checkpoints.png  the typing region at a few moments, labelled with how many keystrokes were counted so far:
                   count the characters in the picture and compare. Counts that fall short mean frames merged
                   (a sped-up recording); counts above mean flicker.

Times are the first frame that shows the change. Keystrokes are moved earlier by --lead (0.03 s): the picture lags
the key that caused it. A change that a window switch causes in every region at once is reported once, as the
switch. Measured at the recording's own frame rate (up to 60 fps), nothing but ffmpeg is needed.
"""
import argparse
import json
import re
import statistics
import struct
import sys
import tempfile
import zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import run

KIND_BY_NAME = [
    (r"input|field|text|prompt|typ|compos|editor|search|command|terminal|code", "typing"),
    (r"toast|popup|pop|modal|dialog|menu|tooltip|notif|banner|snack|alert|badge", "popup"),
    (r"scroll|list|feed|chat|panel|side|timeline|layers|preview|log", "scroll"),
    (r"button|click|btn|play|send|cta|tab", "click"),
    (r"window|screen|app|full|page|frame", "window"),
]
SOUND = {"typing": "key", "popup": "pop", "toggle": "pop", "scroll": "whoosh", "click": "click", "window": "wipe",
         "any": "tick"}
GAIN = {"typing": 0.8, "popup": 0.9, "toggle": 0.9, "scroll": 0.5, "click": 0.8, "window": 1.0, "any": 0.5}
# mean luma change per frame (0..255, over the whole region) that counts as a change at all
MIN_DIFF = {"typing": 0.06, "popup": 0.15, "toggle": 0.15, "scroll": 0.25, "click": 0.12, "window": 6.0, "any": 0.15}


# ------------------------------------------------------------------ regions
def parse_roi(text, width, height):
    name, _, rest = text.partition("=")
    if not rest:
        sys.exit(f"--roi expects NAME=x,y,w,h[:kind[:sound]][@from-to], got {text!r}")
    t_lo = t_hi = None
    m_ = re.search(r"@([0-9.]*)-([0-9.]*)", rest)           # the range may stand anywhere: box@0-4:popup:key
    if m_:
        try:
            t_lo = float(m_.group(1)) if m_.group(1) else None
            t_hi = float(m_.group(2)) if m_.group(2) else None
        except ValueError:
            sys.exit(f"--roi {name}: the time range after @ is from-to in seconds, got {m_.group(0)!r}")
        rest = rest[:m_.start()] + rest[m_.end():]
    elif "@" in rest:
        sys.exit(f"--roi {name}: the time range after @ is from-to in seconds, e.g. @0-91 or @19-20.5")
    parts = rest.split(":")
    try:
        nums = [float(v) for v in parts[0].split(",")]
    except ValueError:
        sys.exit(f"--roi {name}: the box must be four numbers x,y,w,h, got {parts[0]!r}")
    if len(nums) != 4:
        sys.exit(f"--roi {name}: the box must be four numbers x,y,w,h")
    if all(v <= 1.0 for v in nums):
        nums = [nums[0] * width, nums[1] * height, nums[2] * width, nums[3] * height]
    x, y, w, h = (int(round(v)) for v in nums)
    x, y = max(0, min(x, width - 2)), max(0, min(y, height - 2))
    w, h = max(2, min(w, width - x)), max(2, min(h, height - y))
    kind = parts[1].strip().lower() if len(parts) > 1 and parts[1].strip() else None
    if kind is None:
        kind = next((k for rx, k in KIND_BY_NAME if re.search(rx, name, re.I)), "any")
    if kind not in SOUND:
        sys.exit(f"--roi {name}: kind must be one of {', '.join(SOUND)}")
    sound = parts[2].strip() if len(parts) > 2 and parts[2].strip() else SOUND[kind]
    return {"name": name.strip(), "box": [x, y, w, h], "kind": kind, "sound": sound, "range": [t_lo, t_hi]}


def grid_rois(cols, rows, width, height):
    out = []
    cw, ch = width // cols, height // rows
    for r in range(rows):
        for c in range(cols):
            out.append({"name": f"r{r + 1}c{c + 1}", "box": [c * cw, r * ch, cw, ch], "kind": "any", "sound": "tick"})
    return out


# ------------------------------------------------------------------ measuring
def probe(video):
    p = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=width,height,r_frame_rate:format=duration", "-of", "json", str(video)])
    try:
        j = json.loads(p.stdout)
        v = j["streams"][0]
        num, _, den = v.get("r_frame_rate", "30/1").partition("/")
        return {"width": int(v["width"]), "height": int(v["height"]), "fps": float(num) / float(den or 1),
                "duration": float(j["format"]["duration"])}
    except (ValueError, KeyError, IndexError):
        sys.exit(f"cannot read the picture of {video}")


def series(video, box, fps, t_from, t_to):
    """(times, ydif): mean absolute luma change from the previous frame, over the box, at fps."""
    x, y, w, h = box
    vf = [f"crop={w}:{h}:{x}:{y}", f"fps={fps:g}"]
    if w > 960:
        vf.append("scale=960:-2:flags=area")
    vf.append("signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=-")
    cmd = ["ffmpeg", "-v", "error", "-nostdin"]
    if t_from:
        cmd += ["-ss", f"{t_from:.3f}"]
    if t_to:
        cmd += ["-t", f"{t_to - (t_from or 0):.3f}"]
    cmd += ["-i", str(video), "-an", "-vf", ",".join(vf), "-f", "null", "-"]
    r = run(cmd)
    ts, yd, t = [], [], None
    for line in r.stdout.splitlines():
        m = re.search(r"pts_time:([\d.]+)", line)
        if m:
            t = float(m.group(1)) + (t_from or 0.0)
            continue
        m = re.search(r"YDIF=([\d.]+)", line)
        if m and t is not None:
            ts.append(t)
            yd.append(float(m.group(1)))
            t = None
    if not ts:
        sys.exit("motion analysis failed:\n" + r.stderr[-1200:])
    return ts, yd


def profile_series(video, box, fps, t_from, t_to):
    """(times, residual, static_x): the mean luma change per frame of the box with the FIXED sources of change taken
    out. The change of every frame is looked at per column: a keystroke is a few columns that move to the right
    from key to key, a spinner, a status dot or a blinking caret is the same few columns again and again. Within
    every 15 seconds the places that change far more often than the rest are static and their share is subtracted
    (a caret blinks only while a field has the focus, a spinner only while something runs). static_x: those
    places in pixels of the picture."""
    import subprocess
    x, y, w, h = box
    wo = min(w, 960)
    # gray FIRST: a tv-range recording (most screen recorders) differenced in YUV and scaled afterwards comes out
    # with a constant offset of about 45 levels
    vf = f"crop={w}:{h}:{x}:{y},fps={fps:g},format=gray,tblend=all_mode=difference,scale={wo}:1:flags=area"
    cmd = ["ffmpeg", "-v", "error", "-nostdin"]
    if t_from:
        cmd += ["-ss", f"{t_from:.3f}"]
    if t_to:
        cmd += ["-t", f"{t_to - (t_from or 0):.3f}"]
    cmd += ["-i", str(video), "-an", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "gray", "-"]
    raw = subprocess.run(cmd, capture_output=True).stdout
    n = len(raw) // wo
    if n < 3:
        sys.exit("motion analysis failed (no frames came out of the region)")
    t0 = (t_from or 0.0) + 1.0 / fps                 # the first difference is the second frame
    ts = [t0 + i / fps for i in range(n)]
    rows = [raw[i * wo:(i + 1) * wo] for i in range(n)]
    narrow = max(16, 0.04 * wo)

    def spans(row):
        mx = max(row)
        if mx < 4:
            return []
        lim = max(4, 0.25 * mx)
        out, start, last = [], None, -99
        for xx, v in enumerate(row):
            if v >= lim:
                if start is None:
                    start = xx
                elif xx - last > 4:
                    out.append((start, last))
                    start = xx
                last = xx
        if start is not None:
            out.append((start, last))
        return out

    part = max(30, int(15 * fps))
    vals, all_static, geo = [], {}, []
    for p0 in range(0, n, part):
        chunk = rows[p0:p0 + part]
        bins = {}
        for row in chunk:
            for a_, b_ in spans(row):
                if b_ - a_ + 1 <= narrow:
                    k = ((a_ + b_) // 2) // 10
                    bins[k] = bins.get(k, 0) + 1
        static = []
        if bins:
            counts = sorted(bins.values())
            med = counts[len(counts) // 2]
            for k, c in bins.items():
                near = c + bins.get(k - 1, 0) + bins.get(k + 1, 0)
                # the same place again and again: far more often than the typical place, or the only place there is
                if c >= 6 and (len(bins) <= 2 or c >= 4 * max(1, med)) and near >= 6:
                    static.append(k)
        ranges = sorted({(max(0, k * 10 - 6), min(wo, k * 10 + 16)) for k in static})
        for k in static:
            all_static[k] = all_static.get(k, 0) + 1
        for row in chunk:
            total = sum(row)
            for lo, hi in ranges:
                total -= sum(row[lo:hi])
            vals.append(max(0.0, total) / wo)
            # where the change that is left sits and how wide it is: a glyph is wide, a caret toggling is a thin bar
            best = None
            for a_, b_ in spans(row):
                if any(lo <= (a_ + b_) // 2 < hi for lo, hi in ranges):
                    continue
                if best is None or (b_ - a_) > (best[1] - best[0]):
                    best = (a_, b_)
            geo.append(None if best is None else (((best[0] + best[1]) / 2.0) * w / wo, (best[1] - best[0] + 1) * w / wo))
    return ts, vals, sorted(int(round((k * 10 + 5) * w / wo)) for k in all_static), geo


def scene_times(video, box, thr, t_from, t_to):
    x, y, w, h = box
    cmd = ["ffmpeg", "-v", "error", "-nostdin"]
    if t_from:
        cmd += ["-ss", f"{t_from:.3f}"]
    if t_to:
        cmd += ["-t", f"{t_to - (t_from or 0):.3f}"]
    cmd += ["-i", str(video), "-an", "-vf",
            f"crop={w}:{h}:{x}:{y},scale=320:-2,select='gt(scene,{thr})',metadata=print:file=-", "-f", "null", "-"]
    r = run(cmd)
    out, t = [], None
    for line in r.stdout.splitlines():
        m = re.search(r"pts_time:([\d.]+)", line)
        if m:
            t = float(m.group(1)) + (t_from or 0.0)
        m = re.search(r"scene_score=([\d.]+)", line)
        if m and t is not None:
            out.append((t, float(m.group(1))))
    return out


def noise_floor(ys):
    """(residual, spread): the series minus its median over the whole recording (a static interface sits at ~0, and
    a rolling median would swallow a long scroll), and the robust spread of that residual."""
    med = statistics.median(ys) if ys else 0.0
    res = [max(0.0, y - med) for y in ys]
    mad = statistics.median(abs(y - med) for y in ys) if ys else 0.0
    return res, 1.4826 * mad


def pulses(ts, res, thr, min_gap):
    """Local maxima of the residual above thr, at least min_gap apart (the larger one wins): [(t, strength)]."""
    out = []
    n = len(res)
    for i in range(n):
        if res[i] < thr:
            continue
        if (i > 0 and res[i] < res[i - 1]) or (i + 1 < n and res[i] <= res[i + 1]):
            continue
        if out and ts[i] - out[-1][0] < min_gap:
            if res[i] > out[-1][1]:
                out[-1] = (ts[i], res[i])
            continue
        out.append((ts[i], res[i]))
    return out


KEEP_PERIODIC = False


def periodic_trains(times, min_n=6, lo=0.25, hi=2.5, tol=0.06):
    """Evenly spaced trains: at least `min_n` consecutive events whose gaps all equal one period (0.25-2.5 s) within
    `tol`. A timer or a spinner redrawing every second looks like that; a person scrolling or clicking does not.
    Returns (set of indices, [(first t, last t, period)])."""
    n = len(times)
    gone, trains = set(), []
    i = 0
    while i < n - 1:
        p = times[i + 1] - times[i]
        if not (lo <= p <= hi):
            i += 1
            continue
        j = i + 1
        while j + 1 < n and abs((times[j + 1] - times[j]) - p) <= tol:
            j += 1
        if j - i + 1 >= min_n:
            gone.update(range(i, j + 1))
            trains.append((times[i], times[j], p))
            i = j + 1
        else:
            i += 1
    return gone, trains


def drop_periodic(events):
    """Remove a blinking caret or status dot: a train of at least six pulses on a regular grid (period 0.3-1.3 s,
    ten milliseconds of slack) and of near-equal strength. A keystroke that falls on the same grid point is kept
    (its pulse is much stronger than the train's). Returns (kept, dropped_count)."""
    n = len(events)
    if n < 6:
        return events, 0
    times = [t for t, _ in events]
    best = None
    for p100 in range(30, 131):
        period = p100 / 100.0
        for ai in range(min(n, 30)):
            t0 = times[ai]
            cells = {}
            for j, t in enumerate(times):
                k = round((t - t0) / period)
                if abs(t - (t0 + k * period)) <= 0.05:
                    cells.setdefault(k, []).append(j)
            ks = sorted(cells)
            run_, longest = [], []
            for k in ks:
                if run_ and k == run_[-1] + 1:
                    run_.append(k)
                else:
                    run_ = [k]
                if len(run_) > len(longest):
                    longest = list(run_)
            if len(longest) >= 6 and (best is None or len(longest) > len(best[0]) or
                                      (len(longest) == len(best[0]) and period > best[1])):
                best = (longest, period, cells)
    if best is None:
        return events, 0
    longest, _, cells = best
    members = [cells[k][0] for k in longest]
    amps = sorted(events[j][1] for j in members)
    med = amps[len(amps) // 2]
    if amps[-1] > 6 * med and amps[0] < 0.2 * amps[-1] and len(members) < 8:
        return events, 0
    gone = {j for j in members if events[j][1] <= 2.0 * med}
    if len(gone) < 6:
        return events, 0
    return [e for k, e in enumerate(events) if k not in gone], len(gone)


def stretches(ts, res, thr, gap=0.15, min_len=0.2):
    """Runs of activity: [(start, length, mean strength)], gaps up to `gap` seconds bridged."""
    out, start, last, acc, cnt = [], None, None, 0.0, 0
    for t, r in zip(ts, res):
        if r >= thr:
            if start is None:
                start, acc, cnt = t, 0.0, 0
            elif t - last > gap:
                out.append((start, last - start, acc / max(1, cnt)))
                start, acc, cnt = t, 0.0, 0
            last = t
            acc += r
            cnt += 1
    if start is not None:
        out.append((start, last - start, acc / max(1, cnt)))
    return [s for s in out if s[1] >= min_len]


def norm(values, floor=1e-6):
    """Strengths to 0.7..1.0 by their place between the 10th and the 90th percentile (how much of the region
    changed says how important the event is, not how loud: the range is narrow on purpose)."""
    if not values:
        return []
    s = sorted(values)
    lo, hi = s[int(0.1 * (len(s) - 1))], s[int(0.9 * (len(s) - 1))]
    span = max(hi - lo, floor)
    return [round(0.7 + 0.3 * min(1.0, max(0.0, (v - lo) / span)), 2) for v in values]


def suggest_rois(cells, cols, rows):
    """The busiest touching cells are one region: [(name, [x, y, w, h], events, first, last)], busiest first. The
    threshold is relative (35 % of the busiest cell left), a region that would be most of the picture is not a region,
    and cells that change most of the time with no events (a video, an animation) are left out."""
    live = {i: c for i, c in enumerate(cells)
            if 2 <= len(c["events"]) <= 800 and c.get("active_share", 0) < 0.6}
    out = []
    while live and len(out) < 6:
        mx = max(len(c["events"]) for c in live.values())
        hot = {i for i, c in live.items() if len(c["events"]) >= max(3, 0.35 * mx)}
        seen, comps = set(), []
        for i in hot:
            if i in seen:
                continue
            stack, comp = [i], []
            seen.add(i)
            while stack:
                j = stack.pop()
                comp.append(j)
                r_, c_ = divmod(j, cols)
                for rr, cc in ((r_ - 1, c_), (r_ + 1, c_), (r_, c_ - 1), (r_, c_ + 1)):
                    k = rr * cols + cc
                    if 0 <= rr < rows and 0 <= cc < cols and k in hot and k not in seen:
                        seen.add(k)
                        stack.append(k)
            comps.append(comp)
        if not comps:
            break
        best = max(comps, key=lambda cp: sum(len(live[j]["events"]) for j in cp))
        if len(best) > 0.5 * cols * rows:
            break
        xs = [live[j]["box"][0] for j in best]
        ys = [live[j]["box"][1] for j in best]
        x1 = [live[j]["box"][0] + live[j]["box"][2] for j in best]
        y1 = [live[j]["box"][1] + live[j]["box"][3] for j in best]
        tt = [e["t"] for j in best for e in live[j]["events"]]
        out.append((f"area{len(out) + 1}", [min(xs), min(ys), max(x1) - min(xs), max(y1) - min(ys)],
                    sum(len(live[j]["events"]) for j in best), min(tt), max(tt)))
        for j in best:
            live.pop(j, None)
    return out


def native_windows(video, thresh_db=-50.0, hop=0.05, pad=0.12, join=0.3):
    """Where the recording's OWN audio sounds: [(from, to)], and the share of the film it covers. A clip playing in a
    window, a system sound: those moments have their sound already."""
    import array
    import math
    import subprocess
    raw = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(video), "-vn", "-ac", "1", "-ar", "8000",
                          "-f", "s16le", "-"], capture_output=True).stdout
    a = array.array("h")
    a.frombytes(raw[: len(raw) // 2 * 2])
    w = int(8000 * hop)
    act = []
    for i in range(0, len(a) - w + 1, w):
        seg = a[i:i + w]
        e = math.sqrt(sum(v * v for v in seg) / w) / 32768.0
        if e > 0 and 20 * math.log10(e) > thresh_db:
            act.append(i / 8000.0)
    if not act:
        return [], 0.0
    wins = []
    for t in act:
        if wins and t - wins[-1][1] <= join:
            wins[-1][1] = t + hop
        else:
            wins.append([t, t + hop])
    total = max(1.0, len(a) / 8000.0)
    share = sum(b - a_ for a_, b in wins) / total
    return [(max(0.0, a_ - pad), b + pad) for a_, b in wins], share


def grid_results(video, cols, rows, fps, t_from, t_to, scale, info):
    """Which parts of the picture live? One pass over the recording: the frame difference reduced to one value per
    cell (the mean change of the cell), at no more than 15 frames a second. Every cell is then a region of kind 'any'."""
    import subprocess
    fps_g = min(fps, 15.0)
    vf = f"fps={fps_g:g},format=gray,tblend=all_mode=difference,lutyuv=y=val*8,scale={cols}:{rows}:flags=area"
    cmd = ["ffmpeg", "-v", "error", "-nostdin"]
    if t_from:
        cmd += ["-ss", f"{t_from:.3f}"]
    if t_to:
        cmd += ["-t", f"{t_to - (t_from or 0):.3f}"]
    cmd += ["-i", str(video), "-an", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "gray", "-"]
    raw = subprocess.run(cmd, capture_output=True).stdout
    cells = cols * rows
    n = len(raw) // cells
    if n < 3:
        sys.exit("grid analysis failed (no frames came out)")
    t0 = (t_from or 0.0) + 1.0 / fps_g
    ts = [t0 + i / fps_g for i in range(n)]
    cw, ch = info["width"] // cols, info["height"] // rows
    out = []
    for c in range(cells):
        vals = [raw[i * cells + c] / 8.0 for i in range(n)]
        res, spread = noise_floor(vals)
        thr = max(0.15, 6.0 * spread) * scale
        pl = pulses(ts, res, thr, 0.1)
        act = sum(1 for r_ in res if r_ >= thr) / max(1, n)
        r_, c_ = divmod(c, cols)
        gain = norm([a for _, a in pl])
        out.append({"name": f"r{r_ + 1}c{c_ + 1}", "box": [c_ * cw, r_ * ch, cw, ch], "kind": "any", "sound": "tick",
                    "events": [{"t": round(tt, 3), "g": g, "amp": round(a, 3)} for (tt, a), g in zip(pl, gain)],
                    "flags": [], "noise_floor": round(spread, 4), "threshold": round(thr, 4), "frames": n,
                    "active_share": round(act, 3),
                    "series": {"t": [round(x, 3) for x in ts], "res": [round(x, 3) for x in res], "thr": round(thr, 3)}})
    return out


# ------------------------------------------------------------------ one region
def analyse(video, roi, fps, t_from, t_to, scale, lead, scene_thr, drop_regular, duration):
    kind, box = roi["kind"], roi["box"]
    info = {"name": roi["name"], "box": box, "kind": kind, "sound": roi["sound"], "events": [], "flags": []}
    # NAME=...@from-to: only that part of the recording is analysed (faster, and the noise floor and the thresholds
    # come from the part where the region means something)
    lo_r, hi_r = roi.get("range") or [None, None]
    whole_end = (t_from or 0.0) + duration
    t_from = max(t_from or 0.0, lo_r or 0.0) or None
    t_to = min(t_to or whole_end, hi_r) if hi_r is not None else t_to
    duration = max(1.0, (t_to or whole_end) - (t_from or 0.0))
    if kind == "window":
        # the whole picture changes: ffmpeg's scene score (the share and size of the pixels that changed). Scrolling
        # or typing in a dark interface moves the mean luma as much as a switch does, the score tells them apart
        merged = []
        for tt, s in scene_times(video, box, scene_thr * scale, t_from, t_to):
            if merged and tt - merged[-1][0] < 0.5:
                if s > merged[-1][1]:
                    merged[-1] = (merged[-1][0], s)
                continue
            merged.append((tt, s))
        gain = [round(max(0.5, min(1.0, s / 0.7)), 2) for _, s in merged]
        if merged and any(s < 0.5 for _, s in merged) and any(s >= 0.5 for _, s in merged):
            info["flags"].append("scene scores " + ", ".join(f"{tt:.1f} s {s:.2f}" for tt, s in merged[:8]) +
                                 ": the weak ones are probably a redraw of one window, not a switch "
                                 "(--scene 0.5 keeps only the strong)")
        info["noise_floor"], info["threshold"] = 0.0, scene_thr
        info["events"] = [{"t": round(tt, 3), "g": g, "amp": round(s, 3)} for (tt, s), g in zip(merged, gain)]
        _in_range(info, roi)
        info["rate_per_s"] = round(len(info["events"]) / max(1.0, duration), 3)
        return info

    if kind in ("typing", "any", "click"):
        ts, yd, static, geo = profile_series(video, box, fps, t_from, t_to)
        if static:
            info["static_x"] = static
            info["flags"].append(f"{len(static)} fixed place(s) of repeated change left out (a spinner, a status "
                                 f"dot, a blinking caret), at x = " + ", ".join(str(s) for s in static))
    else:
        ts, yd = series(video, box, fps, t_from, t_to)
    res, spread = noise_floor(yd)
    thr = max(MIN_DIFF[kind], 6.0 * spread) * scale
    info["noise_floor"] = round(spread, 4)
    info["threshold"] = round(thr, 4)
    info["frames"] = len(ts)
    step = statistics.median([b - a for a, b in zip(ts, ts[1:])]) if len(ts) > 2 else 1.0 / fps

    if kind in ("typing", "any", "click"):
        pl = pulses(ts, res, thr, 0.04 if kind == "typing" else 0.06)
        if drop_regular:
            pl, n_periodic = drop_periodic(pl)
            if n_periodic:
                info["flags"].append(f"{n_periodic} pulses of a regular train dropped (--drop-periodic)")
        if kind == "typing" and geo:
            pos = {tt: i for i, tt in enumerate(ts)}
            glyph_px = max(4.0, 0.006 * box[2])          # a typed glyph is at least about 4 px wide
            kept, last_x, n_blink = [], None, 0
            for (tt, a_) in pl:
                g_ = geo[pos[tt]] if tt in pos else None
                if g_ is None:
                    kept.append((tt, a_))
                    continue
                xc, wd = g_
                if wd >= glyph_px:                        # a glyph appeared: the caret is now at its right edge
                    kept.append((tt, a_))
                    last_x = xc + wd / 2.0
                elif last_x is not None and abs(xc - last_x) < 4.0:
                    n_blink += 1                          # a thin bar toggling at the place it already was
                else:                                     # a thin change somewhere new: the caret moved (a space)
                    kept.append((tt, a_))
                    last_x = xc
            pl = kept
            if n_blink:
                info["flags"].append(f"{n_blink} thin changes at the place of the previous one (the caret blinking) "
                                     f"left out")
        if kind == "click" and not KEEP_PERIODIC and len(pl) >= 8:
            gone_, trains_ = periodic_trains([p_[0] for p_ in pl], min_n=8)
            if gone_:
                pl = [p_ for k_, p_ in enumerate(pl) if k_ not in gone_]
                info["flags"].append(
                    f"{len(gone_)} click pulses on an even rhythm dropped (" +
                    ", ".join(f"{t0_:.0f}-{t1_:.0f} s every {p_:.2f} s" for t0_, t1_, p_ in trains_[:3]) +
                    "): a timecode or a spinner redrawing, not clicks (--keep-periodic keeps them)")
        if kind == "click":
            # the press and the release are two pulses of one click
            merged = []
            for t, a in pl:
                if merged and t - merged[-1][0] < 0.35:
                    continue
                merged.append((t, a))
            pl = merged
        # the size of a glyph says nothing about how hard a key was struck: every keystroke has the same weight,
        # the natural spread comes from the recorded keys themselves
        if kind == "typing" and len(pl) >= 10:
            med_amp = sorted(a for _, a in pl)[len(pl) // 2]
            big = [(tt, a) for tt, a in pl if a > 8.0 * med_amp]
            if big:
                pl = [(tt, a) for tt, a in pl if a <= 8.0 * med_amp]
                info["big_changes"] = [{"t": round(tt, 3), "amp": round(a, 3)} for tt, a in big]
                info["flags"].append(f"{len(big)} large changes (the field was cleared by Enter, or the window "
                                     f"changed) are not counted as keystrokes: see big_changes")
        gain = [1.0] * len(pl) if kind == "typing" else norm([a for _, a in pl])
        shift = lead if kind == "typing" else 0.0
        info["events"] = [{"t": round(max(0.0, t - shift), 3), "g": g, "amp": round(a, 3)}
                          for (t, a), g in zip(pl, gain)]
        if kind == "typing" and len(pl) >= 8:
            gaps = sorted(b[0] - a[0] for a, b in zip(pl, pl[1:]))
            med = gaps[len(gaps) // 2]
            if med < 0.07:
                info["flags"].append(f"median gap between pulses {med * 1000:.0f} ms: frames probably merge several "
                                     f"keystrokes (sped-up recording?), the count is a lower bound")
    elif kind == "scroll":
        st = stretches(ts, res, thr)
        if not KEEP_PERIODIC and len(st) >= 6:
            gone_, trains_ = periodic_trains([s_[0] for s_ in st], min_n=6)
            if gone_:
                st = [s_ for k_, s_ in enumerate(st) if k_ not in gone_]
                info["flags"].append(
                    f"{len(gone_)} scroll events on an even rhythm dropped (" +
                    ", ".join(f"{t0_:.0f}-{t1_:.0f} s every {p_:.2f} s" for t0_, t1_, p_ in trains_[:3]) +
                    "): a timer or a spinner redrawing, not scrolling (--keep-periodic keeps them)")
        gain = norm([a for _, _, a in st])
        info["events"] = [{"t": round(t, 3), "len": round(min(3.0, ln), 2), "g": g, "amp": round(a, 3)}
                          for (t, ln, a), g in zip(st, gain)]
    elif kind in ("popup", "toggle"):
        # changes come in pairs: it appears, it goes away. A popup's appearance gets the sound, its length is how long
        # it stays; a toggle's disappearance is an event too (off_events). A region that already shows something at
        # the start begins with a disappearance: 'first' flag.
        st = stretches(ts, res, thr, gap=0.12, min_len=0.0)
        groups, last_end = [], -9.0
        for (t, ln, a) in st:
            if t - last_end >= 0.5 or not groups:
                groups.append([t, ln, a])
            last_end = t + ln
        ev = []
        off_ev = []
        for k in range(0, len(groups), 2):
            on = groups[k]
            off = groups[k + 1] if k + 1 < len(groups) else None
            stay = (off[0] - on[0]) if off else None
            ev.append((on[0], stay if stay is not None else 1.5, on[2]))
            if off is not None:
                off_ev.append((off[0], off[2]))
        # one thing replaced by another has no calm in between: inside a long stretch of small changes (a timer),
        # a change several times larger than the rest of it is a new appearance
        for (g0, gl, ga) in groups:
            if gl < 1.5:
                continue
            seg = [(tt, rr) for tt, rr in zip(ts, res) if g0 <= tt <= g0 + gl]
            if len(seg) < 10:
                continue
            base_ = sorted(rr for _, rr in seg)[len(seg) // 2]
            for tt, rr in pulses([s_[0] for s_ in seg], [s_[1] for s_ in seg], max(thr, 4.0 * base_), 0.5):
                if tt - g0 >= 0.6 and all(abs(tt - e_[0]) > 0.6 for e_ in ev):
                    ev.append((tt, 1.5, rr))
        ev.sort()
        gain = norm([a for _, _, a in ev])
        info["events"] = [{"t": round(t, 3), "len": round(min(6.0, max(0.1, ln)), 2), "g": g, "amp": round(a, 3)}
                          for (t, ln, a), g in zip(ev, gain)]
        if kind == "toggle":
            og = norm([a for _, a in off_ev]) if off_ev else []
            info["off_events"] = [{"t": round(t, 3), "g": round(0.7 * g, 2), "amp": round(a, 3)}
                                  for (t, a), g in zip(off_ev, og)]
        if groups and groups[0][0] < t_from_guard(ts):
            info["flags"].append("something was already showing at the start: the first change may be a "
                                 "disappearance, check the first event on the timeline")
        short = [e for e in info["events"] if e["len"] < 0.25]
        if short and len(short) >= 0.5 * len(info["events"]):
            info["flags"].append("most popups stay under 0.25 s: a sped-up recording, one short sound each")
    _in_range(info, roi)
    info["rate_per_s"] = round(len(info["events"]) / max(1.0, duration), 3)
    info["series"] = {"t": [round(t, 3) for t in ts], "res": [round(r, 3) for r in res], "thr": round(thr, 3)}
    return info


def _in_range(info, roi):
    """Keep the events of the time range the region was given (NAME=...@from-to): a field that exists only while
    one window is on screen says nothing about the rest of the recording."""
    lo, hi = (roi.get("range") or [None, None])
    if lo is None and hi is None:
        return
    if info.get("kind") == "typing" and lo and info["events"] and 0 <= info["events"][0]["t"] - lo < 0.4:
        info["flags"].append(f"keys already run at the very start of the range ({lo:g} s): the typing probably began "
                             f"earlier, widen the range (check the frames: --check or look.py --crop)")
    keep = [e for e in info["events"] if (lo is None or e["t"] >= lo) and (hi is None or e["t"] <= hi)]
    if len(keep) != len(info["events"]):
        info["flags"].append(f"{len(info['events']) - len(keep)} event(s) outside {lo if lo is not None else 0:g}-"
                             f"{hi if hi is not None else 'end'} s dropped")
    info["events"] = keep


def t_from_guard(ts):
    """Changes this close to the first frame cannot be told from a region that was already full."""
    return (ts[0] if ts else 0.0) + 0.3


def suppress_under_windows(results):
    """A window switch changes every region at once. Keep it as the switch, drop its echoes in other regions."""
    wins = [e["t"] for r in results if r["kind"] == "window" for e in r["events"]]
    if not wins:
        return 0
    dropped = 0
    for r in results:
        if r["kind"] == "window":
            continue
        keep = [e for e in r["events"] if not any(-0.12 <= e["t"] - w <= 0.30 for w in wins)]
        dropped += len(r["events"]) - len(keep)
        r["events"] = keep
    return dropped


# ------------------------------------------------------------------ pictures
def draw_timeline(results, duration, out, width=1600, row_h=64, t0=0.0):
    """One row per region: residual bars (blue-grey) and found events (red ticks); a light line every 10 s."""
    n = max(1, len(results))
    height = n * row_h + 4
    px = bytearray(b"\x14\x16\x1a" * (width * height))

    def put(x, y, c):
        if 0 <= x < width and 0 <= y < height:
            i = (y * width + x) * 3
            px[i:i + 3] = bytes(c)

    span = max(0.5, duration)
    for k in range(int(span // 10) + 1):
        x = int(10 * k / span * width)
        for y in range(height):
            put(x, y, (46, 50, 58))
    for r, res in enumerate(results):
        y0 = r * row_h + 2
        for y in range(row_h):
            put(0, y0 + y, (80, 84, 92))
        s = res.get("series")
        if s and s["res"]:
            top = sorted(s["res"])[int(0.99 * (len(s["res"]) - 1))] or 1.0
            top = max(top, s["thr"] * 1.5)
            for t, v in zip(s["t"], s["res"]):
                x = int((t - t0) / span * width)
                h = int(min(1.0, v / top) * (row_h - 14))
                for y in range(h):
                    put(x, y0 + row_h - 3 - y, (96, 140, 190))
            ty = y0 + row_h - 3 - int(min(1.0, s["thr"] / top) * (row_h - 14))
            for x in range(0, width, 6):
                put(x, ty, (200, 200, 90))
        for e in res["events"]:
            x = int((e["t"] - t0) / span * width)
            for y in range(10):
                put(x, y0 + 1 + y, (240, 70, 70))
                put(x + 1, y0 + 1 + y, (240, 70, 70))
    raw = b"".join(b"\x00" + bytes(px[y * width * 3:(y + 1) * width * 3]) for y in range(height))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")
    Path(out).write_bytes(png)


def checkpoints_picture(video, roi, times, counts, out, tile_w):
    import look
    x, y, w, h = roi["box"]
    look.CROP = (x, y, w, h)
    tw = tile_w
    th = max(24, int(round(tw * h / w)))
    labels = [f"{t:.1f}s: {c} keys" for t, c in zip(times, counts)]
    with tempfile.TemporaryDirectory() as tmp:
        parts = []
        per_row = max(1, min(len(times), 2 if tw >= 500 else 3))
        rows = [list(range(i, min(i + per_row, len(times)))) for i in range(0, len(times), per_row)]
        for ri, idx in enumerate(rows):
            p = look.frames_row(video, [times[i] for i in idx], tmp, f"c{ri}", look.find_font(),
                                [labels[i] for i in idx], w=tw, h=th)
            if len(idx) < per_row and len(rows) > 1:        # same width as the others, or vstack refuses
                full = Path(tmp) / f"c{ri}_pad.png"
                look.ff(["-i", p, "-vf", f"pad={per_row * tw}:ih:0:0:color=0x101010", "-frames:v", "1", full])
                p = full
            parts.append(p)
        look.stack_png(parts, out)


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("video")
    ap.add_argument("--out", required=True)
    ap.add_argument("--roi", action="append", default=[], metavar="NAME=x,y,w,h[:kind[:sound]]")
    ap.add_argument("--grid", help="COLSxROWS: watch an even grid of regions (to find where the action is)")
    ap.add_argument("--fps", type=float, help="analysis frame rate (default: the recording's, at most 60)")
    ap.add_argument("--from", dest="t_from", type=float)
    ap.add_argument("--to", dest="t_to", type=float)
    ap.add_argument("--scale", type=float, default=1.0,
                    help="multiply every threshold (above 1 = fewer events, below 1 = more)")
    ap.add_argument("--lead", type=float, default=0.03, help="move keystrokes this much earlier (the picture lags)")
    ap.add_argument("--scene", type=float, default=0.30, help="scene-change threshold of 'window' regions")
    ap.add_argument("--drop-periodic", action="store_true",
                    help="also drop trains of six or more evenly spaced pulses (a blinking dot at the very place "
                         "where the keys appear); typing at an even rate would be dropped too")
    ap.add_argument("--keep-periodic", action="store_true",
                    help="keep evenly spaced trains of scroll / click events (by default a timer redrawing every "
                         "second is not taken for scrolling)")
    ap.add_argument("--check", help="comma list of seconds: counts and crops of the typing region there "
                                    "(any number of times; the picture is checkpoints.png)")
    ap.add_argument("--no-native-gate", action="store_true",
                    help="keep the events that fall where the recording's own audio sounds (a clip playing in a "
                         "window): by default they are left out, that moment has its sound")
    ap.add_argument("--tile-w", type=int, default=640)
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    global KEEP_PERIODIC
    KEEP_PERIODIC = bool(a.keep_periodic)

    info = probe(a.video)
    out = Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    fps = a.fps or min(60.0, round(info["fps"] or 30.0, 3))
    rois = [parse_roi(r, info["width"], info["height"]) for r in a.roi]
    grid_dims = None
    if a.grid:
        m = re.fullmatch(r"(\d+)x(\d+)", a.grid.lower())
        if not m:
            sys.exit("--grid expects COLSxROWS, e.g. 4x3")
        grid_dims = (int(m.group(1)), int(m.group(2)))
    if not rois and not grid_dims:
        sys.exit("give at least one --roi NAME=x,y,w,h[:kind] or --grid COLSxROWS "
                 f"(the picture is {info['width']}x{info['height']})")
    span = (a.t_to or info["duration"]) - (a.t_from or 0.0)
    print(f"{info['width']}x{info['height']} {info['fps']:.1f} fps, {info['duration']:.1f} s; analysing at {fps:g} fps")

    with ThreadPoolExecutor(max(1, a.workers)) as ex:
        results = list(ex.map(lambda r: analyse(a.video, r, fps, a.t_from, a.t_to, a.scale, a.lead, a.scene,
                                                a.drop_periodic, span), rois))
    if grid_dims:
        gres = grid_results(a.video, grid_dims[0], grid_dims[1], fps, a.t_from, a.t_to, a.scale, info)
        results += gres
        print("\nwhere the picture lives (share of the time a cell changes / events), one cell per column:")
        for r_ in range(grid_dims[1]):
            cells_ = gres[r_ * grid_dims[0]:(r_ + 1) * grid_dims[0]]
            print("   " + "   ".join(f"{c_['active_share'] * 100:3.0f}%/{len(c_['events']):<4d}" for c_ in cells_))
        print("   (a cell that is active most of the time with no events is a video or an animation; a cell with a few "
              "events is where things happen: put a --roi there)")
        props = suggest_rois(gres, grid_dims[0], grid_dims[1])
        if props:
            print("regions the grid suggests (cells with events that touch are one region; tune the box by looking at "
                  "the frames):")
            for nm_, box_, n_ev, t0_, t1_ in props[:8]:
                print(f"   --roi {nm_}={box_[0]},{box_[1]},{box_[2]},{box_[3]}   {n_ev} events, {t0_:.1f} .. {t1_:.1f} s")
    echoes = suppress_under_windows(results)

    events = []
    for res in results:
        for e in res["events"]:
            ev = {"t": e["t"], "type": res["sound"], "roi": res["name"],
                  "g": round(min(1.0, e["g"] * GAIN.get(res["kind"], 0.8) / 0.8), 2)}
            if "len" in e:
                ev["len"] = e["len"]
            events.append(ev)
        for e in res.get("off_events", []):                      # a toggle: the disappearance is a soft click
            events.append({"t": e["t"], "type": "click", "roi": res["name"] + "(off)", "g": e["g"]})
    events.sort(key=lambda e: e["t"])

    # regions that see one and the same change (a redraw touches several at once): one event, the stronger one
    merged_n, merged = 0, []
    for e in events:
        prev = merged[-1] if merged else None
        if prev is not None and prev["type"] == e["type"] and e["t"] - prev["t"] <= 0.04 and prev["roi"] != e["roi"]:
            prev["g"] = max(prev["g"], e["g"])
            prev["roi"] += "+" + e["roi"]
            merged_n += 1
        elif prev is not None and e["type"] not in ("key",) and prev["type"] == e["type"] and \
                0 < e["t"] - prev["t"] <= 0.09 and e["roi"] != prev["roi"] and e["g"] <= 0.6 * prev["g"]:
            merged_n += 1                                        # an echo two frames later in the next region
        else:
            merged.append(e)
    events = merged

    # the recording's own audio: where it sounds, it has its sound (a clip playing, a system sound)
    gate_info = None
    native_spans = None
    if not a.no_native_gate:
        try:
            wins, share = native_windows(a.video)
        except Exception:
            wins, share = [], 0.0
        native_spans = [[round(lo, 2), round(hi, 2)] for lo, hi in wins] or None
        if wins and share <= 0.4:
            try:
                from common import voice_share
                vs = voice_share(a.video) or {}
            except (SystemExit, Exception):
                vs = {}
            if vs.get("speech", 0.0) < 0.3:
                inside = [e for e in events if any(lo <= e["t"] <= hi for lo, hi in wins)]
                if inside:
                    events = [e for e in events if e not in inside]
                    by = {}
                    for e in inside:
                        by[e["roi"]] = by.get(e["roi"], 0) + 1
                    gate_info = {"windows": len(wins), "share": round(share, 3), "dropped": len(inside), "by_roi": by}
            else:
                gate_info = {"skipped": "the recording has a voice in it: its audio is not a gate"}

    for res in results:
        bins = {}
        for e in res["events"]:
            k = int(e["t"] // 10) * 10
            bins[k] = bins.get(k, 0) + 1
        res["per_10s"] = {str(k): v for k, v in sorted(bins.items())}

    (out / "events.json").write_text(json.dumps(events, ensure_ascii=False, indent=1), encoding="utf-8")
    slim = [{k: v for k, v in r.items() if k != "series"} for r in results]
    (out / "ui_events.json").write_text(json.dumps({"video": str(a.video), "info": info, "fps": fps,
                                                    "native_windows": native_spans,
                                                    "regions": slim}, ensure_ascii=False, indent=1),
                                        encoding="utf-8")
    draw_timeline(results, span, out / "timeline.png", t0=a.t_from or 0.0)

    print(f"\n{'region':14s} {'kind':7s} {'events':>6s} {'per s':>6s}  first .. last        noise  threshold")
    for r in results:
        ev = r["events"]
        rng = f"{ev[0]['t']:7.2f} .. {ev[-1]['t']:7.2f}" if ev else "      -"
        print(f"{r['name'][:14]:14s} {r['kind']:7s} {len(ev):6d} {r.get('rate_per_s', 0):6.2f}  {rng:19s}  "
              f"{r['noise_floor']:5.3f}  {r['threshold']}")
        for f in r["flags"]:
            print(f"    NOTE: {f}")
    if echoes:
        print(f"{echoes} change(s) in other regions fell on a window switch and are reported as the switch only")
    if merged_n:
        print(f"{merged_n} event(s) of several regions at one instant (a redraw) were merged into one")
    if gate_info and gate_info.get("dropped"):
        print(f"the recording's own audio sounds in {gate_info['windows']} window(s) ({gate_info['share']:.0%} of the "
              f"film): {gate_info['dropped']} event(s) inside them left out, they have their sound "
              f"(" + ", ".join(f"{k} {v}" for k, v in gate_info["by_roi"].items()) + "; --no-native-gate keeps them)")
    elif gate_info and gate_info.get("skipped"):
        print("note: " + gate_info["skipped"])
    if native_spans:
        print("   the recording's own audio sounds at (s): " +
              ", ".join(f"{lo:g}-{hi:g}" for lo, hi in native_spans[:14]) + (" ..." if len(native_spans) > 14 else "") +
              "  (all in ui_events.json: native_windows)")
    print(f"\n{len(events)} events -> {out / 'events.json'}  (picture of the activity: {out / 'timeline.png'})")

    typing = next((r for r in results if r["kind"] == "typing" and r["events"]), None)
    if typing:
        te = [e["t"] for e in typing["events"]]
        if a.check:
            times = [float(v) for v in a.check.split(",") if v.strip()]
        else:
            lo, hi = te[0], te[-1]
            times = [round(lo + (hi - lo) * k / 4, 1) for k in range(1, 5)]
        counts = [sum(1 for t in te if t <= x + 0.05) for x in times]
        print("typing counted so far: " + ", ".join(f"{c} by {t:g} s" for t, c in zip(times, counts)))
        try:
            checkpoints_picture(str(a.video), typing, times, counts, out / "checkpoints.png", a.tile_w)
            print(f"crops of the typing region at those moments: {out / 'checkpoints.png'} "
                  f"(count the characters in the picture and compare)")
        except SystemExit as ex_:
            why_ = str(ex_.code).strip().splitlines()[-1][:160] if ex_.code not in (None, 0, 1) else "look.py failed"
            print(f"note: checkpoints.png could not be drawn ({why_}); use look.py --at T --crop x,y,w,h")
        if len(te) >= 20:
            rate = len(te) / max(1.0, te[-1] - te[0])
            print(f"typing rate {rate:.1f} per second on average (a person types 4-8 per second in bursts; "
                  f"animated typing in a film runs 8-14)")
    print(f"next: python scripts/from_cues.py {out / 'events.json'} --video {a.video} --out work/cues.json   "
          f"(--ui library when the user wants no uisfx)")


if __name__ == "__main__":
    main()
