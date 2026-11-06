#!/usr/bin/env python3
"""Find the beat grid of the music in a video or audio file (no extra packages needed), and check it against the kicks.

  python beats.py film.mp4 --out work/beats.json [--plot work/beats.png]
  python beats.py film.mp4 --check 5.0 12.4 20.1              # distance of these moments to the nearest beat
  python beats.py film.mp4 --suggest-offset work/moments.json  # how far to move the music so cuts land on beats

Output: {"tempo": 118.4, "confidence": 0.62, "usable": true, "beats": [...seconds...], "downbeats": [...],
         "kick_check": {"kicks": 97, "within40": 0.98, "median_ms": 1, "shifted_ms": 0}}
`usable` is false when no steady, accented pulse was found: do not snap to such a grid. The tempo can be
off by an octave (88 vs 176 BPM); the beat positions themselves stay valid.

Method: spectral flux onset strength -> autocorrelation for the tempo (60..200 BPM, gently preferring
80..160) -> best phase -> every beat nudged to the nearest onset peak. Downbeats are the 1-in-4 phase
with the most low-frequency energy. Good enough to decide whether a picture event sits on the beat;
it is not a transcription tool.

The grid is then CHECKED against the kicks, independently: the low band (< 125 Hz) alone gives its own onsets, and
the share of beats that sit within 40 ms of one is reported. A tracker that locks onto the off-beat (hats stronger
than the kick) is a classic failure: when the grid is steady but sits beside the kicks, it is moved onto them
(`phase_shift` in kick_check) when that makes most beats land on a kick. `--plot` draws the low band against the grid
so the picture can be looked at, the way a person would zoom in on a few bars.
"""
import argparse
import array
import json
import math
import subprocess
import sys
import zlib
import struct
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import _fft  # noqa: E402

RATE = 16000
N = 1024      # 64 ms window: resolves a 55 Hz kick (15.6 Hz bins)
HOP = 320     # 20 ms hop = 50 frames per second
FPS = RATE / HOP
LAT = (N / 2 + HOP / 2) / RATE      # a frame describes the sound around its middle, not its start
KICK_BINS = 7                       # bins 2..8 = ~31..125 Hz: the kick, not the bass line's upper notes


def decode(path, max_seconds=900):
    r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "1", "-ar", str(RATE),
                        "-t", str(max_seconds), "-f", "s16le", "-"], capture_output=True)
    a = array.array("h")
    a.frombytes(r.stdout[: len(r.stdout) // 2 * 2])
    return a


def onset_strength(x):
    """Return (full-band flux, low-band flux, kick-band flux) per hop."""
    hann = [0.5 - 0.5 * math.cos(2 * math.pi * i / (N - 1)) for i in range(N)]
    prev = None
    flux, low, kick = [], [], []
    nb = N // 2
    for s in range(0, len(x) - N, HOP):
        re_ = [x[s + i] * hann[i] for i in range(N)]
        im_ = [0.0] * N
        _fft(re_, im_)
        mag = [math.log1p(0.01 * math.sqrt(re_[k] * re_[k] + im_[k] * im_[k])) for k in range(2, nb)]
        if prev is not None:
            d = [m - p for m, p in zip(mag, prev)]
            flux.append(sum(v for v in d if v > 0))
            low.append(sum(v for v in d[:26] if v > 0))     # bins 2..27 = ~30..420 Hz
            kick.append(sum(v for v in d[:KICK_BINS] if v > 0))
        else:
            flux.append(0.0)
            low.append(0.0)
            kick.append(0.0)
        prev = mag
    return flux, low, kick


def detrend(o, win=31):
    out = []
    n = len(o)
    csum = [0.0]
    for v in o:
        csum.append(csum[-1] + v)
    for i in range(n):
        a, b = max(0, i - win // 2), min(n, i + win // 2 + 1)
        out.append(max(0.0, o[i] - (csum[b] - csum[a]) / (b - a)))
    return out


def tempo_from(o):
    n = len(o)
    lo, hi = int(FPS * 60 / 200), int(FPS * 60 / 60)
    mean = sum(o) / n
    x = [v - mean for v in o]
    var = sum(v * v for v in x) or 1.0
    best, best_lag, scores = -1e9, None, {}
    for lag in range(lo, min(hi, n // 2)):
        r = sum(x[i] * x[i + lag] for i in range(n - lag)) / var
        bpm = 60.0 * FPS / lag
        prior = math.exp(-0.5 * (math.log2(bpm / 120.0) / 0.9) ** 2)     # gentle bias to the 80..160 range
        scores[lag] = r * (0.5 + 0.5 * prior)
        if scores[lag] > best:
            best, best_lag = scores[lag], lag
    if best_lag is None:
        return None, 0.0
    # parabolic interpolation of the peak
    l0 = best_lag
    if l0 - 1 in scores and l0 + 1 in scores:
        a, b, c = scores[l0 - 1], scores[l0], scores[l0 + 1]
        den = a - 2 * b + c
        l0 = l0 + (0.5 * (a - c) / den if den else 0.0)
    return l0, best


def beat_grid(o, low, lag):
    n = len(o)
    ilag = max(1, int(round(lag)))
    # phase: offset that collects the most onset energy
    best, off = -1.0, 0
    for p in range(ilag):
        s = sum(o[i] for i in range(p, n, ilag) if True)
        if s > best:
            best, off = s, p
    beats, t = [], float(off)
    while t < n:
        i = int(round(t))
        lo_i, hi_i = max(0, i - ilag // 4), min(n, i + ilag // 4 + 1)
        j = max(range(lo_i, hi_i), key=lambda k: o[k]) if hi_i > lo_i else i
        # follow the music gently (drift) but never jump more than a quarter beat
        t_adj = 0.7 * t + 0.3 * j
        beats.append(t_adj)
        t += lag
    times = [round(b / FPS + LAT, 3) for b in beats]
    # downbeats: which of 4 phases has the most low-end flux on its beats
    down = []
    if len(beats) >= 8:
        sc = []
        for ph in range(4):
            idx = beats[ph::4]
            sc.append(sum(low[min(len(low) - 1, int(round(b)))] for b in idx) / max(1, len(idx)))
        ph = max(range(4), key=lambda k: sc[k])
        down = times[ph::4]
    return times, down


# ------------------------------------------------------------------ the check against the kicks
def kick_peaks(k, pct=0.93, min_gap=0.18):
    """Times (s) of the kick onsets: peaks of the detrended kick-band flux above its 93rd percentile."""
    if len(k) < 10:
        return []
    s = sorted(k)
    thr = s[int(pct * (len(s) - 1))]
    if thr <= 0:
        return []
    out, last = [], -9.0
    for i in range(1, len(k) - 1):
        if k[i] >= thr and k[i] >= k[i - 1] and k[i] > k[i + 1]:
            t = i / FPS + LAT
            if t - last >= min_gap:
                out.append(round(t, 3))
                last = t
    return out


def kick_stats(grid, kicks, tol=0.04):
    """(share of grid points with a kick within tol, median signed offset in s: kick minus beat)."""
    if not grid or not kicks:
        return 0.0, 0.0
    import bisect
    ds = []
    for b in grid:
        j = bisect.bisect_left(kicks, b)
        cands = [kicks[x] for x in (j - 1, j) if 0 <= x < len(kicks)]
        k = min(cands, key=lambda v: abs(v - b))
        ds.append(k - b)
    share = sum(1 for d in ds if abs(d) <= tol) / len(ds)
    srt = sorted(ds)
    return share, srt[len(srt) // 2]


def kick_phase_shift(grid, kicks, period):
    """The shift (s) that brings the grid onto the kicks: the most crowded offset of the kicks against their nearest
    beat (10 ms bins, +-20 ms smoothed), None when the kicks have no one offset."""
    import bisect
    res = []
    for kk in kicks:
        j = bisect.bisect_left(grid, kk)
        cands = [grid[x] for x in (j - 1, j) if 0 <= x < len(grid)]
        b = min(cands, key=lambda v: abs(v - kk))
        d = kk - b
        if abs(d) <= period / 2:
            res.append(d)
    if len(res) < 8:
        return None
    nb = max(8, int(period / 0.01))
    hist = [0] * nb
    lo = -period / 2
    for d in res:
        hist[min(nb - 1, int((d - lo) / 0.01))] += 1
    best, bi = -1, 0
    for i in range(nb):
        s = sum(hist[(i + j) % nb] for j in range(-2, 3))
        if s > best:
            best, bi = s, i
    if best < 0.4 * len(res):
        return None
    # the centre of the crowd, not the first bin of a plateau: the mean of the offsets that sit around the best window
    c = lo + (bi + 0.5) * 0.01
    near = []
    for d in res:
        e = d - c
        e = (e + period / 2) % period - period / 2          # wrapped distance to the window centre
        if abs(e) <= 0.03:
            near.append(e)
    return c + (sum(near) / len(near) if near else 0.0)


def check_grid(res, kicks):
    """Fill res['kick_check'] and, for a usable but misplaced grid, move it onto the kicks."""
    beats = res.get("beats") or []
    chk = {"kicks": len(kicks), "checked": False}
    res["kick_check"] = chk
    if len(beats) < 8 or len(kicks) < 8 or not res.get("tempo"):
        return res
    period = 60.0 / res["tempo"]
    share, med = kick_stats(beats, kicks)
    chk.update({"checked": True, "within40": round(share, 2), "median_ms": round(1000 * med), "shifted_ms": 0})
    if share < 0.5:
        shift = kick_phase_shift(beats, kicks, period)
        if shift is not None and abs(shift) > 0.015:
            moved = [round(b + shift, 3) for b in beats]
            s2, m2 = kick_stats(moved, kicks)
            if s2 >= 0.6 and s2 >= share + 0.2:
                res["beats"] = moved
                res["downbeats"] = [round(b + shift, 3) for b in res.get("downbeats") or []]
                res["half_beats"] = [round(b + shift, 3) for b in res.get("half_beats") or []]
                chk.update({"shifted_ms": round(1000 * shift), "within40_before": round(share, 2),
                            "within40": round(s2, 2), "median_ms": round(1000 * m2)})
                share = s2
    if share < 0.5 and res.get("usable"):
        # a grid that sits beside the kicks and cannot be moved onto them: snapping to it would put every big move
        # beside the beat the ear hears, so the safe answer is to not snap at all
        res["usable"] = False
        res["unusable_reason"] = "kick check"
        chk["rejected"] = True
    return res


def say_check(res):
    """The line a person (or an agent) reads."""
    c = res.get("kick_check") or {}
    if not c.get("checked"):
        return f"kick check: not enough beats or kicks ({c.get('kicks', 0)} kicks) to compare the grid with them"
    if c.get("shifted_ms"):
        return (f"kick check: the grid sat {c['shifted_ms']:+d} ms beside the kicks ({c['within40_before']:.0%} of the "
                f"beats on a kick): moved onto them, now {c['within40']:.0%} within 40 ms")
    if c["within40"] >= 0.7:
        return (f"kick check: {c['within40']:.0%} of the beats sit within 40 ms of a kick (< 125 Hz), median "
                f"{c['median_ms']:+d} ms: the grid is on the kick")
    if c["within40"] >= 0.5:
        return (f"kick check: {c['within40']:.0%} of the beats sit within 40 ms of a kick, median {c['median_ms']:+d} ms: "
                f"only loosely on the kick (syncopated kicks, or a mix with a lot on top); look at --plot before "
                f"you lean on it")
    why = "marked unusable, --snap-beats will not use it" if c.get("rejected") else "it was not usable anyway"
    return (f"WARN kick check: only {c['within40']:.0%} of the beats sit within 40 ms of a kick: the grid is not on the "
            f"kick ({why}); look at --plot (music with no kick drum gives no check: then judge by ear)")


# ------------------------------------------------------------------ music offset for the cuts
def music_offset(times, beats, period, tol=0.04):
    """How far to move the music (later: positive) so that the most of `times` land on a beat. Returns
    {"shift_s", "before", "after", "n"}; the move is a suggestion, the music is not touched."""
    import bisect
    if len(times) < 3 or len(beats) < 4:
        return None
    srt = sorted(beats)

    def score(shift):
        """(share of the moves within tol of a beat, mean distance of the moves to their beat, capped at 100 ms)"""
        ok, dsum = 0, 0.0
        for t in times:
            j = bisect.bisect_left(srt, t - shift)
            cands = [srt[x] for x in (j - 1, j) if 0 <= x < len(srt)]
            d = min(abs(c + shift - t) for c in cands) if cands else 0.1
            ok += d <= tol
            dsum += min(d, 0.1)
        return ok / len(times), dsum / len(times)

    before = score(0.0)[0]
    # the most moves on a beat; among equals the one that puts them closest to it (the middle of a plateau), then the
    # smallest move of the music
    best_key, bs = None, 0.0
    steps = int(period / 2 / 0.005)
    for k in range(-steps, steps + 1):
        s = k * 0.005
        sh, dm = score(s)
        key = (round(sh, 6), -round(dm, 4), -abs(s))
        if best_key is None or key > best_key:
            best_key, bs = key, s
    n = len(times)
    k = int(round(best_key[0] * n))
    p0 = min(0.5, 2 * tol / period)                       # a move lands within tol of a beat by chance with this share
    tail = sum(math.comb(n, i) * p0 ** i * (1 - p0) ** (n - i) for i in range(k, n + 1))
    # the best of ~period/(2 tol) independent shifts: it has to beat chance, or any music "fits" ten random moves
    significant = tail * max(1.0, period / (2 * tol)) < 0.01
    return {"shift_s": round(bs, 3), "before": round(before, 2), "after": round(best_key[0], 2), "n": n,
            "chance": round(p0, 2), "significant": bool(significant)}


def detect(path, max_seconds=900):
    x = decode(path, max_seconds)
    if len(x) < RATE * 4:
        return {"tempo": None, "confidence": 0.0, "beats": [], "downbeats": [], "fps": FPS}
    flux, low, kick = onset_strength(x)
    f_d, l_d, k_d = detrend(flux), detrend(low), detrend(kick)
    mf = (sum(f_d) / len(f_d)) or 1e-9
    ml = (sum(l_d) / len(l_d)) or 1e-9
    # kicks live in the low band and carry the pulse; hats/noise only add broadband flux: weight both
    o = [a / mf + 3.0 * b / ml for a, b in zip(f_d, l_d)]
    lag, r_best = tempo_from(o)
    if not lag:
        return {"tempo": None, "confidence": 0.0, "beats": [], "downbeats": [], "fps": FPS}
    beats, down = beat_grid(o, low, lag)
    mean_all = sum(o) / len(o) or 1e-9
    on_beats = [o[max(0, min(len(o) - 1, int(round((b - LAT) * FPS))))] for b in beats]
    ratio = (sum(on_beats) / max(1, len(on_beats))) / mean_all
    # confidence = how periodic the onsets are (autocorrelation peak) and how much stronger the beats are than
    # the average moment; each half of the score alone is fooled by either steady hats or sparse accents
    periodic = max(0.0, min(1.0, (r_best - 0.05) / 0.30))
    onbeat = max(0.0, min(1.0, (ratio - 1.0) / 1.2))
    conf = 0.6 * periodic + 0.4 * onbeat
    # a 140 BPM song is often read as 70 (the strongest autocorrelation is two beats): the positions in between
    # are real beats when they carry as much onset energy as the beats do
    half = []
    if len(beats) >= 8:
        def at(t):
            return o[max(0, min(len(o) - 1, int(round((t - LAT) * FPS))))]
        mids = [b + (lag / FPS) / 2 for b in beats]
        ms = sum(at(m) for m in mids) / len(mids)
        bs = sum(at(b) for b in beats) / len(beats)
        if ms >= 0.6 * bs and ms / mean_all >= 1.2:
            half = [round(m, 3) for m in mids]
    res = {"tempo": round(60.0 * FPS / lag, 1), "confidence": round(conf, 2), "periodicity": round(r_best, 3),
           "half_beats": half, "tempo_if_halves_are_beats": round(120.0 * FPS / lag, 1) if half else None,
           "onbeat_ratio": round(ratio, 2),
           # snapping events to this grid only makes sense when the pulse is both periodic and accented
           "usable": bool(conf >= 0.5 and ratio >= 1.5),
           "beats": beats, "downbeats": down, "fps": FPS}
    kicks = kick_peaks(k_d)
    check_grid(res, kicks)
    res["kicks"] = kicks
    res["_kick_env"] = [round(v, 3) for v in k_d]            # for --plot; stripped before it is written
    return res


def nearest(beats, t):
    if not beats:
        return None, None
    b = min(beats, key=lambda v: abs(v - t))
    return b, round((t - b) * 1000)


# ------------------------------------------------------------------ a picture of the grid against the low band
def _png(path, w, h, px):
    raw = b"".join(b"\x00" + bytes(px[y * w * 3:(y + 1) * w * 3]) for y in range(h))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    Path(path).write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                           + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def plot_grid(path, env, beats, kicks, span=8.0, panels=2, w=1000, row_h=130):
    """Panels of the kick-band onset strength (blue), kick onsets (green ticks on top) and beats (red lines): the
    kicks must sit under the red lines. First panel from the first kick, the others spread over the film."""
    dur = len(env) / FPS
    starts = []
    first = kicks[0] if kicks else 0.0
    for p in range(panels):
        starts.append(max(0.0, min(first + p * max(0.0, dur - span - first) / max(1, panels - 1), max(0.0, dur - span))))
    h = row_h * len(starts)
    px = bytearray([16, 16, 20]) * (w * h)

    def put(x, y, c):
        if 0 <= x < w and 0 <= y < h:
            o = (y * w + x) * 3
            px[o:o + 3] = bytes(c)

    top = max(env) or 1.0
    for row, t0 in enumerate(starts):
        y0 = row * row_h
        for x in range(w):
            t = t0 + span * x / w
            i = int((t - LAT) * FPS)
            v = env[i] / top if 0 <= i < len(env) else 0.0
            for y in range(int(v * (row_h - 26))):
                put(x, y0 + row_h - 4 - y, (70, 120, 200))
        for b in beats:
            if t0 <= b <= t0 + span:
                x = int((b - t0) / span * w)
                for y in range(row_h):
                    put(x, y0 + y, (235, 70, 70))
                    put(x + 1, y0 + y, (235, 70, 70))
        for k in kicks:
            if t0 <= k <= t0 + span:
                x = int((k - t0) / span * w)
                for y in range(12):
                    put(x, y0 + y, (80, 220, 120))
                    put(x + 1, y0 + y, (80, 220, 120))
        for sec in range(int(span) + 1):                     # a tick per second at the bottom
            x = int(sec / span * w)
            for y in range(6):
                put(x, y0 + row_h - 1 - y, (200, 200, 200))
    _png(path, w, h, px)
    return starts


def moments_of(path, kinds):
    """The times (s) of the big moves in a moments.json / an event list / a cue sheet."""
    d = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if isinstance(d, dict):
        d = d.get("moments") or d.get("cues") or d.get("events") or []
    want = {k.strip().lower() for k in kinds.split(",") if k.strip()}
    out = []
    for e in d:
        if not isinstance(e, dict) or "t" not in e:
            continue
        k = str(e.get("kind") or e.get("type") or "").lower()
        if not k:
            lab = str(e.get("label", "")).split()
            k = (lab[0] if lab else str(e.get("role", ""))).lower()
        if k in want or e.get("role") in want:
            out.append(float(e["t"]))
    return sorted(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("media")
    ap.add_argument("--out")
    ap.add_argument("--max-seconds", type=int, default=900)
    ap.add_argument("--check", nargs="*", type=float, help="moments (s) to compare against the grid")
    ap.add_argument("--plot", help="PNG: the low band against the grid and the kicks (look at it)")
    ap.add_argument("--suggest-offset", metavar="FILE",
                    help="moments.json / event list / cue sheet: how far to move the music so its big moves land on beats")
    ap.add_argument("--kinds", default="cut,onset,wipe,hit,thump,drop,riser,whoosh",
                    help="which moves count for --suggest-offset (kind, type, first word of the label or role)")
    a = ap.parse_args()
    res = detect(a.media, a.max_seconds)
    env = res.pop("_kick_env", [])
    if a.out:
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        Path(a.out).write_text(json.dumps(res, indent=1), encoding="utf-8")
    print(f"tempo {res['tempo']} BPM, confidence {res['confidence']}, {len(res['beats'])} beats, "
          f"{len(res['downbeats'])} downbeats, usable {res.get('usable', False)}")
    if res.get("tempo"):
        print(say_check(res))
    if a.plot and env and res["beats"]:
        Path(a.plot).parent.mkdir(parents=True, exist_ok=True)
        st = plot_grid(a.plot, env, res["beats"], res.get("kicks", []))
        print(f"picture: {a.plot} (blue: kick-band onsets, green: kicks, red: the grid; panels from "
              + ", ".join(f"{s:.1f} s" for s in st) + "; the green ticks must sit on the red lines)")
    for t in a.check or []:
        b, d = nearest(res["beats"], t)
        print(f"  {t:7.3f} s: nearest beat {b} s ({d:+d} ms)")
    if a.suggest_offset:
        times = moments_of(a.suggest_offset, a.kinds)
        if not res.get("tempo") or not res["beats"]:
            print("offset: no beat grid in this audio")
        else:
            mo = music_offset(times, res["beats"], 60.0 / res["tempo"])
            if mo is None:
                print(f"offset: too few moves of the kinds {a.kinds} ({len(times)}) or beats to say")
            elif abs(mo["shift_s"]) < 0.01 or mo["after"] <= mo["before"] + 0.05:
                print(f"offset: {mo['before']:.0%} of {mo['n']} big moves sit within 40 ms of a beat already; moving "
                      f"the music would not help (best {mo['shift_s']:+.3f} s -> {mo['after']:.0%})")
            elif not mo["significant"]:
                print(f"offset: no shift of the music puts the big moves on beats convincingly (best "
                      f"{mo['shift_s']:+.3f} s: {mo['before']:.0%} -> {mo['after']:.0%} of {mo['n']}, about "
                      f"{mo['chance']:.0%} by chance): the moves do not follow this music's pulse (or there are too "
                      f"few of them, or the grid is wrong: look at --plot)")
            else:
                way = "later" if mo["shift_s"] > 0 else "earlier"
                print(f"offset: move the music {abs(mo['shift_s']):.3f} s {way} (or the picture "
                      f"{'earlier' if mo['shift_s'] > 0 else 'later'}): big moves within 40 ms of a beat "
                      f"{mo['before']:.0%} -> {mo['after']:.0%} of {mo['n']}. A suggestion: the music is not touched")
                if not res.get("usable"):
                    print("   (the pulse is not steady and accented: take it as a hint, listen before you move anything)")


if __name__ == "__main__":
    main()
