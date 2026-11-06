#!/usr/bin/env python3
"""Take a synthesized layer OUT of a finished mix: the render's audio (or the project's own lossless mix) minus the
project's synthesized stem, at the gain and the lag found by correlation.

  python unbake.py film.mp4 --synth assets/audio/sfx.wav [more.wav ...] --out work/base_unbaked.wav
                   [--mix assets/audio/final_mix.wav] [--keep-voice VOICE.wav ...]
  python unbake.py film.mp4 --project E:/proj --out work/base_unbaked.wav        (stems found in the project)

Why: a film built from a score script mixes music, voice and a synthesized effect layer into ONE track. New real
sounds on top of it would double the synthesis. When the project keeps the synthesized layer as its own file
(sfx.wav, transitions.wav), the mix is linear up to the master gain and the delay, so `mix - g * stem` is the
original without it: music and voice keep the ducking and the level the author gave them, which a rebuild from
separate stems does not (the sidechain is the author's, not ours).

What it checks, because a subtraction that does not cancel is worse than none: the correlation of the stem with the
audio must be clearly above chance, the gain must be plausible, and after the subtraction the stem must be (almost)
uncorrelated with what is left. Exit status 0 = a base was written, 2 = the stem is not in this audio.

Also here: `scan_audio` (which files of a project are voice, music, synthesized layer, a finished mix) and
`fit_stems` (the stems' levels that best explain the render, so a stem that is not in the mix is seen as such).
Pure Python + ffmpeg: no numpy.
"""
import argparse
import array
import json
import math
import os
import re
import subprocess
import sys
from operator import mul
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import decode_mono, stereo_fmt

AUDIO_SUFFIX = (".wav", ".mp3", ".flac", ".aif", ".aiff", ".ogg", ".m4a")
SYNTH_TOKENS = ("sfx", "fx", "effect", "effects", "transition", "transitions", "whoosh", "foley", "impact", "impacts",
                "sound_design", "ui", "click", "clicks", "cues", "synth", "stinger", "stingers", "hits")
VOICE_TOKENS = ("voice", "vo", "vox", "dialog", "dialogue", "narrat", "narration", "speech", "voiceover", "narrator")
MUSIC_TOKENS = ("music", "score", "bed", "song", "ambien", "atmos", "ambience", "ambient", "track")
MIX_TOKENS = ("mix", "premix", "master", "mastered", "final", "full", "mixdown", "bounce")
FOLDERS = ("assets/audio/stems", "audio/stems", "assets/stems", "stems", "assets/audio", "audio", "assets/sound",
           "assets")
SR = 48000


# ------------------------------------------------------------------ which file is what
def _tokens(stem):
    return [t for t in re.split(r"[^a-z0-9]+", stem.lower()) if t]


def _has(tokens, words):
    return any(t == w or t.startswith(w) for t in tokens for w in words)


def classify(path):
    """'synth' | 'voice' | 'music' | 'mix' | 'other' from the file name (a guess: fit_stems / unbake check it)."""
    tk = _tokens(Path(path).stem)
    if not tk:
        return "other"
    mixlike = _has(tk, MIX_TOKENS) and not _has(tk, ("music",))
    if mixlike:
        return "mix"
    if _has(tk, SYNTH_TOKENS):
        return "synth"
    if _has(tk, VOICE_TOKENS):
        return "voice"
    if _has(tk, MUSIC_TOKENS):
        return "music"
    return "other"


def scan_audio(root):
    """The project's audio files by what they are. The first folder of FOLDERS that holds a synthesized layer or a
    mix wins. Returns {'folder', 'voice', 'music', 'synth', 'mix', 'other'} (lists of Paths)."""
    best = None
    for rel in FOLDERS:
        d = Path(root) / rel
        if not d.is_dir():
            continue
        found = {"folder": d, "voice": [], "music": [], "synth": [], "mix": [], "other": []}
        for f in sorted(d.iterdir()):
            if f.is_file() and f.suffix.lower() in AUDIO_SUFFIX:
                found[classify(f)].append(f)
        n_all = sum(len(found[k]) for k in ("voice", "music", "synth", "mix"))
        if n_all == 0:
            continue
        if found["synth"] or found["mix"]:
            return found
        best = best or found
    return best or {"folder": None, "voice": [], "music": [], "synth": [], "mix": [], "other": []}


# ------------------------------------------------------------------ small signal helpers (stdlib only)
def _dot(a, b):
    return sum(map(mul, a, b))


def _energy_env(samples, rate, hop):
    """RMS in dB (re full scale) per hop seconds, floor -100."""
    w = max(1, int(rate * hop))
    out = []
    for i in range(0, len(samples) - w + 1, w):
        seg = samples[i:i + w]
        e = _dot(seg, seg) / w
        out.append(10.0 * math.log10(e / (32768.0 ** 2)) if e > 1.0 else -100.0)
    return out


def _power_env(samples, rate, hop):
    w = max(1, int(rate * hop))
    return [_dot(samples[i:i + w], samples[i:i + w]) / w / (32768.0 ** 2) for i in range(0, len(samples) - w + 1, w)]


def _corr(x, y):
    n = min(len(x), len(y))
    if n < 8:
        return 0.0
    x, y = x[:n], y[:n]
    mx, my = sum(x) / n, sum(y) / n
    sxx = sum((v - mx) ** 2 for v in x)
    syy = sum((v - my) ** 2 for v in y)
    if sxx <= 0 or syy <= 0:
        return 0.0
    return sum((a - mx) * (b - my) for a, b in zip(x, y)) / math.sqrt(sxx * syy)


def _overlap(a, b, lag):
    """Samples of a and b that sit on the same instants when b is delayed by `lag` samples: a[i] <-> b[i - lag]."""
    i0 = max(0, lag)
    i1 = min(len(a), len(b) + lag)
    if i1 <= i0:
        return a[0:0], b[0:0]
    return a[i0:i1], b[i0 - lag:i1 - lag]


def _decode(path, rate):
    pcm, _ = decode_mono(path, rate)
    return pcm


def _duration(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                       capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def _flux(env):
    return [max(0.0, env[i] - env[i - 1]) if i else 0.0 for i in range(len(env))]


def coarse_lag(ref, test, rate=16000, max_s=0.6, hop=0.01, top=1):
    """Lags (seconds) that delay `test` onto `ref`, best first, from the attack envelopes. A regular pattern (ticks
    every 0.4 s) makes the envelope correlation ambiguous, so several candidates are returned: the caller decides
    with the waveform. Returns [(lag_s, score), ...]."""
    fr = _flux(_energy_env(ref, rate, hop))
    ft = _flux(_energy_env(test, rate, hop))
    nlag = int(max_s / hop)
    scores = {}
    for lag in range(-nlag, nlag + 1):
        a, b = _overlap(fr, ft, lag)
        if len(a) < 50:
            continue
        scores[lag] = _dot(a, b) / math.sqrt(max(1e-9, _dot(a, a) * _dot(b, b)))
    peaks = [lag for lag, s in scores.items()
             if s >= scores.get(lag - 1, -9) and s >= scores.get(lag + 1, -9) and s > 0]
    peaks.sort(key=lambda l: -scores[l])
    out = []
    for l in peaks:
        if all(abs(l - q) > 2 for q, _ in out):
            out.append((l, scores[l]))
        if len(out) >= top:
            break
    return [(l * hop, sc) for l, sc in out]


def _loud_windows(stem, rate, win=0.25, k=14):
    """Start samples of the k loudest non-overlapping windows of the stem."""
    n = int(rate * win)
    cand = []
    for i in range(0, len(stem) - n, n):
        seg = stem[i:i + n]
        cand.append((_dot(seg, seg), i))
    cand.sort(reverse=True)
    return sorted(i for e, i in cand[:k] if e > 0), n


def _lag_search(ref, test, rate, lo, hi, windows, n):
    """Best integer lag in [lo, hi] samples by the normalised correlation over the windows (positions in `test`)."""
    tw = [test[w:w + n] for w in windows if len(test[w:w + n]) == n]
    den_t = sum(_dot(t, t) for t in tw)
    best = (-2.0, 0)
    if den_t <= 0:
        return best
    for lag in range(lo, hi + 1):
        num = den_r = 0.0
        for w, ti in zip(windows, tw):
            ri = ref[w + lag:w + lag + n]
            if len(ri) < n:
                continue
            num += _dot(ri, ti)
            den_r += _dot(ri, ri)
        if den_r > 0:
            c = num / math.sqrt(den_r * den_t)
            if c > best[0]:
                best = (c, lag)
    return best


def _rho(ref, test, windows, n, lag):
    """Normalised correlation of `ref` (delayed view) and `test` inside the windows, at one lag (samples)."""
    num = den_r = den_t = 0.0
    for w in windows:
        a = ref[w + lag:w + lag + n]
        b = test[w:w + n]
        if len(a) == n and len(b) == n:
            num += _dot(a, b)
            den_r += _dot(a, a)
            den_t += _dot(b, b)
    return num / math.sqrt(den_r * den_t) if den_r > 0 and den_t > 0 else 0.0


def _best_lag(ref, test, rate, windows, n, max_s):
    """(rho, lag in samples): coarse candidates from the attack envelopes (and 0), the waveform decides."""
    cands = [c for c, _ in coarse_lag(ref, test, rate, max_s, 0.01, top=6)] + [0.0]
    ws = windows[:10]
    best = (-2.0, 0)
    seen = set()
    half = int(0.012 * rate)
    for cl in cands:
        centre = int(round(cl * rate))
        if centre in seen:
            continue
        seen.add(centre)
        c, l = _lag_search(ref, test, rate, centre - half, centre + half, ws, n)
        if c > best[0]:
            best = (c, l)
    return best


def _solve(A, b):
    """Gauss elimination for the small normal equations (K <= 6)."""
    n = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(M[r][c]))
        if abs(M[p][c]) < 1e-12:
            return None
        M[c], M[p] = M[p], M[c]
        for r in range(c + 1, n):
            f = M[r][c] / M[c][c]
            for k in range(c, n + 1):
                M[r][k] -= f * M[c][k]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        x[r] = (M[r][n] - sum(M[r][k] * x[k] for k in range(r + 1, n))) / M[r][r]
    return x


# ------------------------------------------------------------------ which stems explain the render
def fit_stems(video, stems, hop=0.05):
    """Non-negative levels of the stems that best explain the render's power over time (stems are summed in power:
    music, voice and effects are not correlated). Constant gains cannot follow a sidechain, but the shape is right
    for the right stems and wrong for stems of another cut. Returns {corr, lag_s, gains_db{name}, used[], unused[]}."""
    rate = 8000
    r = _decode(video, rate)
    P = [_power_env(_decode(s, rate), rate, hop) for s in stems]
    pr = _power_env(r, rate, hop)
    if not pr or not any(P):
        return {"corr": None, "lag_s": None, "gains_db": {}, "used": [], "unused": [Path(s).name for s in stems]}
    # lag from the summed stems (unit gains are enough to find it)
    n = min(len(pr), max(len(p) for p in P))
    tot = [sum(p[i] for p in P if i < len(p)) for i in range(n)]
    cand_ = coarse_lag(_decode(video, 8000), _decode_sum(stems, 8000), 8000, 0.4, 0.02, top=1)
    lag_f = cand_[0][0] if cand_ else 0.0
    lag_i = int(round(lag_f / hop))
    cols = []
    for p in P:
        a, b = _overlap(pr, p, lag_i)
        cols.append(b)
    y, _ = _overlap(pr, tot, lag_i)
    m = min([len(y)] + [len(c) for c in cols])
    y = y[:m]
    cols = [c[:m] for c in cols]
    w = [0.0] * len(cols)
    gram = [[_dot(ci, cj) for cj in cols] for ci in cols]
    rhs = [_dot(ci, y) for ci in cols]
    for _ in range(400):                                      # coordinate descent on 0.5*|y - sum w c|^2, w >= 0
        for j in range(len(cols)):
            if gram[j][j] <= 0:
                continue
            g = rhs[j] - sum(gram[j][k] * w[k] for k in range(len(cols)) if k != j)
            w[j] = max(0.0, g / gram[j][j])
    fit = [sum(w[k] * cols[k][i] for k in range(len(cols))) for i in range(m)]
    loud = [i for i in range(m) if y[i] > 1e-7]
    xs = [10 * math.log10(max(y[i], 1e-10)) for i in loud]
    ys = [10 * math.log10(max(fit[i], 1e-10)) for i in loud]
    corr = _corr(xs, ys)
    top = max(w) if w else 0.0
    gains, used, unused = {}, [], []
    for s, wj in zip(stems, w):
        nm = Path(s).name
        if top > 0 and wj > 0.02 * top:
            gains[nm] = round(10 * math.log10(wj), 1)            # power ratio = amplitude gain squared
            used.append(nm)
        else:
            unused.append(nm)
    return {"corr": round(corr, 2), "lag_s": round(lag_i * hop, 2), "gains_db": gains, "used": used, "unused": unused}


def fit_levels(video, music, voice, hop=0.05):
    """The level each rebuilt stem has inside the render. The music's level comes from the frames where the voice
    stem is silent (nothing ducks it there), the voice's from the frames where it dominates the render. Returns
    {"corr", "gains_db": {name: dB}, "lag_s"} or None. The music's own sidechain is not modelled: that is
    mix.py --duck-music."""
    rate = 8000
    r = _decode(video, rate)
    pr = _power_env(r, rate, hop)
    mus = [(Path(f), _power_env(_decode(f, rate), rate, hop)) for f in music]
    voc = [(Path(f), _power_env(_decode(f, rate), rate, hop)) for f in voice]
    if not pr or not mus or not voc:
        return None
    n = len(pr)
    cand = coarse_lag(r, _decode_sum([f for f, _ in mus] + [f for f, _ in voc], rate), rate, 0.4, 0.02, top=1)
    lag = int(round((cand[0][0] if cand else 0.0) / hop))

    def col(p):
        a, b = _overlap(pr, p, lag)
        return b
    m_cols = [col(p) for _, p in mus]
    v_cols = [col(p) for _, p in voc]
    y, _ = _overlap(pr, pr, lag)
    m = min([len(y)] + [len(c) for c in m_cols + v_cols])
    y = y[:m]
    m_cols = [c[:m] for c in m_cols]
    v_cols = [c[:m] for c in v_cols]
    vsum = [sum(c[i] for c in v_cols) for i in range(m)]
    pause = [i for i in range(m) if vsum[i] < 1e-9 and y[i] > 1e-9]
    if len(pause) < 20:
        return None
    # music: non-negative least squares on the pause frames (a few columns: coordinate descent)
    cols = [[c[i] for i in pause] for c in m_cols]
    yp = [y[i] for i in pause]
    w = [0.0] * len(cols)
    gram = [[_dot(a, b) for b in cols] for a in cols]
    rhs = [_dot(a, yp) for a in cols]
    for _ in range(300):
        for j in range(len(cols)):
            if gram[j][j] > 0:
                g = rhs[j] - sum(gram[j][k] * w[k] for k in range(len(cols)) if k != j)
                w[j] = max(0.0, g / gram[j][j])
    music_part = [sum(w[k] * m_cols[k][i] for k in range(len(cols))) for i in range(m)]
    # voice: frames where the voice is clearly the loudest thing (music under it is a tenth of the render)
    act = [i for i in range(m) if vsum[i] > 1e-6 and music_part[i] < 0.1 * y[i]]
    if len(act) < 10:
        act = [i for i in range(m) if vsum[i] > 1e-6]
    if not act:
        return None
    wv = sum(y[i] * vsum[i] for i in act) / max(1e-18, sum(vsum[i] * vsum[i] for i in act))
    fit = [music_part[i] + wv * vsum[i] for i in range(m)]
    loud = [i for i in range(m) if y[i] > 1e-7]
    corr = _corr([10 * math.log10(max(y[i], 1e-10)) for i in loud], [10 * math.log10(max(fit[i], 1e-10)) for i in loud])
    gains = {}
    for (f, _), wj in zip(mus, w):
        gains[f.name] = round(10 * math.log10(wj), 1) if wj > 0 else None
    for f, _ in voc:
        gains[f.name] = round(10 * math.log10(wv), 1) if wv > 0 else None
    return {"corr": round(corr, 2), "gains_db": gains, "lag_s": round(lag * hop, 2)}


def _decode_sum(files, rate):
    acc = None
    for f in files:
        x = _decode(f, rate)
        if acc is None:
            acc = array.array("h", x)
        else:
            if len(x) > len(acc):
                acc.extend([0] * (len(x) - len(acc)))
            for i, v in enumerate(x):
                acc[i] = max(-32768, min(32767, acc[i] + v))
    return acc if acc is not None else array.array("h")


def presence(audio, stems, rate=8000):
    """How much of a synthesized layer is in an audio file: the correlation (best lag, inside the stem's loudest
    windows) of the stem(s) with it. About 0 when the layer is not in it, high when it is. None when it cannot be
    told (no audio, a silent stem)."""
    try:
        s16 = _decode_sum([Path(s) for s in stems], rate)
        win, n = _loud_windows(s16, rate, 0.25, 12)
        if not win:
            return None
        ref = _decode(audio, rate)
        if not len(ref):
            return None
        rho, _ = _best_lag(ref, s16, rate, win, n, 0.6)
        return round(rho, 3)
    except Exception:
        return None


# ------------------------------------------------------------------ the loudness of the layer that is replaced
def layer_loudness(synth, gains_db, work_wav):
    """Integrated LUFS (BS.1770) of the synthesized stems at the levels they have inside the mix. None if unknown."""
    from common import measure_loudness
    items = [(Path(s), gains_db.get(Path(s).name)) for s in synth]
    items = [(p, g) for p, g in items if g is not None]
    if not items:
        return None
    if len(items) == 1:
        m = measure_loudness(items[0][0]).get("lufs")
        return None if m is None else round(m + items[0][1], 1)
    cmd = ["ffmpeg", "-v", "error", "-y"]
    for p, _ in items:
        cmd += ["-i", str(p)]
    chains = [f"[{i}:a]{stereo_fmt(p, SR)},volume={g:.2f}dB[x{i}]"
              for i, (p, g) in enumerate(items)]
    graph = ";".join(chains) + ";" + "".join(f"[x{i}]" for i in range(len(items))) + \
        f"amix=inputs={len(items)}:normalize=0:duration=longest[o]"
    cmd += ["-filter_complex", graph, "-map", "[o]", "-c:a", "pcm_s24le", str(work_wav)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        return None
    m = measure_loudness(work_wav).get("lufs")
    try:
        Path(work_wav).unlink()
    except OSError:
        pass
    return None if m is None else round(m, 1)


# ------------------------------------------------------------------ the subtraction
def _shift_filter(lag_samples):
    """ffmpeg filter that moves a stream by `lag_samples` samples (positive = later), exact to the sample."""
    if lag_samples > 0:
        return f"adelay={lag_samples}S|{lag_samples}S"
    if lag_samples < 0:
        return f"atrim=start_sample={-lag_samples},asetpts=PTS-STARTPTS"
    return "anull"


def unbake(video, synth, out_wav, mix=None, work=None, say=print):
    """render (or its lossless mix) minus the synthesized stem(s). Returns a report dict with "ok"."""
    rep = {"ok": False}
    synth = [Path(s) for s in synth]
    vdur = _duration(video)
    rate = 8000
    r16 = _decode(video, rate)
    if not len(r16) or not synth:
        rep["reason"] = "no audio in the render" if not len(r16) else "no synthesized stem"
        return rep
    for st in synth:                      # a stem of another length is a stem of another cut: it would cancel nothing
        d_ = _duration(st)
        if abs(d_ - vdur) > 0.25:
            rep["reason"] = (f"{st.name} is {d_:.2f} s and the render {vdur:.2f} s: the stems belong to another cut "
                             f"of the film")
            return rep
    # --- the source: the render's own (AAC) audio, or a lossless mix of the project that equals it
    source, src_name = Path(video), "render"
    src16 = r16
    lag_src = 0
    mix_used = False
    src_scale = 1.0
    if mix:
        r_env = _energy_env(r16, rate, 0.02)
        best = (0.0, None, None)
        for m in mix:
            if abs(_duration(m) - vdur) > 0.25:
                continue
            m16 = _decode(m, rate)
            c = _corr(r_env, _energy_env(m16, rate, 0.02)[:len(r_env)])
            if c > best[0]:
                best = (c, m, m16)
        if best[1] is not None and best[0] >= 0.97:
            source, src_name, src16 = Path(best[1]), f"mix {Path(best[1]).name}", best[2]
            mix_used = True
            win_m, n_m = _loud_windows(src16, rate, 0.25, 10)
            lag_src = _best_lag(r16, src16, rate, win_m, n_m, 0.3)[1]
            a_, b_ = _overlap(r16, src16, lag_src)            # the mix may be mastered differently from the render
            den_ = _dot(b_, b_)
            scale = (_dot(a_, b_) / den_) if den_ > 0 else 1.0
            if 0.2 <= scale <= 5.0:
                src_scale = scale
    rep["source"] = src_name

    # --- lag of the synthesized stem(s) against the source
    s16 = _decode_sum(synth, rate)
    win, n = _loud_windows(s16, rate, 0.25, 12)
    if not win:
        rep["reason"] = "the synthesized stem is silent"
        return rep
    c1, l1 = _best_lag(src16, s16, rate, win, n, 0.6)
    rep.update({"coarse_lag_ms": round(l1 * 1000.0 / rate, 1)})
    # refine to the sample at 48 kHz
    k48 = SR // rate
    s48 = _decode_sum(synth, SR)
    src48 = _decode(source, SR)
    win48 = [w * k48 for w in win]
    n48 = n * k48
    c2, l2 = _lag_search(src48, s48, SR, l1 * k48 - 2 * k48, l1 * k48 + 2 * k48, win48[:8], n48)
    lag48 = l2                                                       # the stem delayed by lag48 samples sits on the source
    # --- gains by least squares over the whole file (at 16 kHz), common lag
    lag16 = l1
    cols = []
    for s in synth:
        x = _decode(s, rate)
        a, b = _overlap(src16, x, lag16)
        cols.append((a, b))
    m = min(len(c[0]) for c in cols)
    ys = cols[0][0][:m]
    xs = [c[1][:m] for c in cols]
    K = len(xs)
    gram = [[_dot(xi, xj) for xj in xs] for xi in xs]
    rhs = [_dot(xi, ys) for xi in xs]
    keep = list(range(K))
    gains = None
    while keep:
        sol = _solve([[gram[i][j] for j in keep] for i in keep], [rhs[i] for i in keep])
        if sol is None:
            break
        if all(v > 0 for v in sol):
            gains = {keep[k]: sol[k] for k in range(len(keep))}
            break
        worst = min(range(len(keep)), key=lambda k: sol[k])
        keep.pop(worst)
    if not gains:
        rep["reason"] = "the stem is not in this audio (no positive gain)"
        return rep
    # --- the evidence: correlation inside the loud windows of the stem at the lag, against the same at lags that
    # cannot be it (a stem that is not in the audio correlates with nothing, at any lag)
    rho = _rho(src16, s16, win, n, lag16)
    nulls = [abs(_rho(src16, s16, win, n, lag16 + int(d * rate))) for d in (-1.1, -0.7, -0.4, 0.4, 0.7, 1.1)]
    null = max(nulls) if nulls else 0.0
    z = rho / max(null, 0.005)
    gdb = {synth[i].name: round(20 * math.log10(g), 1) for i, g in gains.items()}
    rep.update({"lag_ms": round(lag48 * 1000.0 / SR, 2), "gains_db": gdb, "rho": round(rho, 3),
                "source_scale_db": round(20 * math.log10(src_scale), 2),
                "rho_chance": round(null, 3), "lag_src_ms": round(lag_src * 1000.0 / rate, 2) if mix_used else 0.0})
    if rho < 0.03 or z < 3.0:
        rep["reason"] = (f"the stem does not show in this audio (correlation {rho:.3f} at the lag, {null:.3f} at "
                         f"lags that cannot be it): the render was made without that layer, or from another cut")
        return rep
    if any(abs(20 * math.log10(g)) > 30 for g in gains.values()):
        rep["reason"] = f"implausible gain {gdb}: the stem and the audio are not the same material"
        return rep

    # --- subtract with ffmpeg (aeval on the merged channels; exact to the sample)
    inputs = [str(source)] + [str(synth[i]) for i in gains]
    chains = []
    src_shift = int(round(lag_src * SR / rate)) if mix_used else 0
    chains.append(f"[0:a]{stereo_fmt(source, SR)},{_shift_filter(src_shift)},"
                  f"apad=whole_dur={vdur:.3f},atrim=end={vdur:.3f}[s0]")
    labels = ["[s0]"]
    for k, i in enumerate(gains, start=1):
        rel = lag48 + src_shift                                      # the stem on the render's timeline
        chains.append(f"[{k}:a]{stereo_fmt(synth[i], SR)},{_shift_filter(rel)},"
                      f"apad=whole_dur={vdur:.3f},atrim=end={vdur:.3f}[s{k}]")
        labels.append(f"[s{k}]")
    nin = len(labels)
    left = f"{src_scale:.6f}*(val(0)" + "".join(f"-{g:.6f}*val({2 * k})" for k, g in enumerate(gains.values(), start=1)) + ")"
    right = f"{src_scale:.6f}*(val(1)" + "".join(f"-{g:.6f}*val({2 * k + 1})" for k, g in
                                                  enumerate(gains.values(), start=1)) + ")"
    graph = ";".join(chains) + ";" + "".join(labels) + f"amerge=inputs={nin},aeval={left}|{right}:c=stereo[out]"
    cmd = ["ffmpeg", "-v", "error", "-y"]
    for p in inputs:
        cmd += ["-i", p]
    cmd += ["-filter_complex", graph, "-map", "[out]", "-c:a", "pcm_s24le", "-ar", str(SR), str(out_wav)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not Path(out_wav).exists():
        rep["reason"] = "ffmpeg could not build the subtraction: " + (r.stderr or "")[-200:]
        return rep

    # --- did it cancel? the stem must be (almost) gone from what is left (base is on the render's timeline)
    b16 = _decode(out_wav, rate)
    p_res = _dot(b16, b16) / max(1, len(b16)) / (32768.0 ** 2)
    res_db = 10 * math.log10(p_res) if p_res > 0 else -120.0
    rep["resid_dbfs"] = round(res_db, 1)
    if res_db <= -60.0:        # nothing but codec noise is left: the render WAS the synthesized layer
        rep["ok"], rep["silent"], rep["rho_after"] = True, True, 0.0
        return rep
    rho_after = _rho(b16, s16, win, n, lag16 + (lag_src if mix_used else 0))
    rep["rho_after"] = round(rho_after, 3)
    rep["ok"] = bool(abs(rho_after) <= max(0.02, 0.35 * abs(rho)))
    if not rep["ok"]:
        rep["reason"] = (f"the stem did not cancel (correlation {rho:.3f} -> {rho_after:.3f}): it is processed inside "
                         f"the mix (its own ducking or effects)")
        return rep
    # a constant gain cannot follow a brickwall limiter or a compressor: the sounds then stay in, a little quieter
    # and uncorrelated at the sample. Look at the level: where the stem sounds, the rest must not be louder than where
    # it does not (a steady score), and its envelope must not follow the stem's
    off = lag16 + (lag_src if mix_used else 0)
    a_, b_ = _overlap(b16, s16, off)
    hop_ = 0.05
    pb, ps = _power_env(a_, rate, hop_), _power_env(b_, rate, hop_)
    top = max(ps) if ps else 0.0
    if top > 0:
        act = [i for i, v in enumerate(ps) if v >= 1e-4 * top]
        idle = [i for i, v in enumerate(ps) if v <= 1e-6 * top]
        if len(act) >= 6 and len(idle) >= 6:
            pa = sum(pb[i] for i in act) / len(act)
            pi = max(sum(pb[i] for i in idle) / len(idle), 1e-12)
            excess = 10 * math.log10(max(pa, 1e-12) / pi)
            env_c = _corr([10 * math.log10(max(pb[i], 1e-12)) for i in act],
                          [10 * math.log10(max(ps[i], 1e-12)) for i in act])
            rep["ghost_excess_db"] = round(excess, 1)
            rep["ghost_corr"] = round(env_c, 2)
            if excess >= 6.0 and env_c >= 0.5:
                rep["ok"] = False
                rep["reason"] = (f"the subtraction left the synthesized sounds in (where they were the rest is "
                                 f"{excess:.0f} dB louder, envelope correlation {env_c:.2f}): the mix is limited or "
                                 f"compressed, its gain changes faster than one gain can follow")
    return rep


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("video")
    ap.add_argument("--synth", nargs="+", help="the synthesized stem(s) of the project")
    ap.add_argument("--project", help="project folder: stems are looked for there")
    ap.add_argument("--mix", nargs="+", help="the project's own lossless mix(es) to subtract from instead of the render")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    synth, mix = a.synth, a.mix
    if not synth and a.project:
        found = scan_audio(a.project)
        synth, mix = [str(p) for p in found["synth"]], mix or [str(p) for p in found["mix"]]
        print(f"project audio folder: {found['folder']}  synthesized: {[Path(p).name for p in synth]}  "
              f"mixes: {[Path(p).name for p in (mix or [])]}")
    if not synth:
        sys.exit("no synthesized stem: give --synth or a --project whose audio folder has one (sfx.wav ...)")
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    rep = unbake(a.video, synth, a.out, mix=mix)
    print(json.dumps(rep, ensure_ascii=False, indent=1))
    if rep.get("ok"):
        print(f"unbaked: {a.out}  (source {rep['source']}, stem delayed {rep['lag_ms']:+.2f} ms, gains {rep['gains_db']}, "
              f"correlation {rep['rho']} -> {rep['rho_after']})")
        return 0
    print("NOT unbaked:", rep.get("reason", "?"))
    return 2


if __name__ == "__main__":
    sys.exit(main())
