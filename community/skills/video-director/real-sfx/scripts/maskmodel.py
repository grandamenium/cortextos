#!/usr/bin/env python3
"""Is every sound of the film audible in the mix, or is it under the masked threshold of the rest? A model of simultaneous
and forward masking in critical bands, run on the processed cues of a render.

  python mix.py cues.json --out film.mp4 --masking                 # does everything below
  python maskmodel.py film_resolved_cues.json CLIPS_DIR [--gain-db G] [--original WAV --original-gain-db G]
                                                       [--spl-full-scale 80] [--offset-db 0] [--json OUT]

CLIPS_DIR is what `mix.py --export-clips` writes (sfx_clips.json + one wav per cue, its own gain baked in).

What it computes. Every cue is a target; everything else that sounds at that time (the other cues, the bed, the film's
own music and voice when it is kept) is the masker, band by band (24 Bark bands, 1536-point STFT at 48 kHz, 16 ms hop).
The masker is spread over the neighbouring bands with Schroeder's spreading function (-27 dB/Bark downwards, steeper
upwards), lowered by the noise-masker offset of the MPEG-1 psychoacoustic model (6 dB + 0.275 dB per Bark), held on
after it stops (forward masking, 12 dB per 50 ms) and put over the absolute threshold of hearing (Terhardt) at the
playback level given by --spl-full-scale. A target is audible where its power over a 192 ms window (the ear integrates
that long: a 5 ms click is judged by its energy) stands over that threshold. Per cue:

  margin_db     the best band's power over the masked threshold (>= 10 clear, 3..10 ok, 0..3 marginal, < 0 masked)
  share         the part of the sound's power that sits in bands where it is over the threshold
  bed_cost_db   what the bed takes off the margin (the margin without it minus the margin with it)
  masked_by     where the threshold power at the best band comes from: bed, other cues, original audio

What it is not: a listening test. It is a textbook model of tones and noise applied to transients; its use is the order
of the places (which sound is under which), and to be CALIBRATED against the verdicts of listen_page.py (--offset-db).
"""
import argparse
import json
import math
import sys
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

try:
    import numpy as np
except ImportError:                      # the system Python of this skill has none: the venv of listen.py has
    np = None

SR = 48000
NFFT = 1536                              # 32 ms: 31.25 Hz per bin at 48 kHz
HOP = 768                                # 16 ms
INTEG = 12                               # frames of the energy window: 192 ms
EDGES = [0, 100, 200, 300, 400, 510, 630, 770, 920, 1080, 1270, 1480, 1720, 2000, 2320, 2700, 3150, 3700, 4400, 5300,
         6400, 7700, 9500, 12000, 15500]  # Zwicker's critical bands
NB = len(EDGES) - 1
FWD_DB_PER_FRAME = 0.24 * 16             # forward masking: 12 dB per 50 ms
PRE = 0.4                                # seconds of masker history before a sound
EPS = 1e-12


def need_numpy():
    if np is None:
        sys.exit("maskmodel.py needs numpy: run it with the Python of the skill's venv "
                 "(`python scripts/listen.py install --yes` makes it), mix.py --masking does that by itself")


# ------------------------------------------------------------------------------------------------ the model
def bark(f):
    return 13.0 * math.atan(0.00076 * f) + 3.5 * math.atan((f / 7500.0) ** 2)


def tables():
    """Band matrix (bins x bands), spreading matrix (target band x masker band, power), offsets, absolute threshold."""
    freqs = np.fft.rfftfreq(NFFT, 1.0 / SR)
    B = np.zeros((len(freqs), NB))
    for b in range(NB):
        B[(freqs >= EDGES[b]) & (freqs < EDGES[b + 1]), b] = 1.0
    z = np.array([bark(0.5 * (EDGES[b] + EDGES[b + 1])) for b in range(NB)])
    dz = z[:, None] - z[None, :]                     # target - masker, Bark
    sf = 15.81 + 7.5 * (dz + 0.474) - 17.5 * np.sqrt(1.0 + (dz + 0.474) ** 2)
    S = 10.0 ** (sf / 10.0)
    offset = 6.025 + 0.275 * z                       # dB under the spread masker (noise-like masker)
    fc = np.array([0.5 * (EDGES[b] + EDGES[b + 1]) for b in range(NB)]) / 1000.0
    ath = 3.64 * fc ** -0.8 - 6.5 * np.exp(-0.6 * (fc - 3.3) ** 2) + 1e-3 * fc ** 4      # dB SPL
    return B, S, offset, ath


def band_power(x, tab):
    """x: (samples, channels) float -> (frames, bands) mean-square power, channels averaged. A full-scale sine is 0.5."""
    B = tab[0]
    if x.shape[0] < NFFT:
        x = np.vstack([x, np.zeros((NFFT - x.shape[0], x.shape[1]))])
    win = np.hanning(NFFT + 1)[:-1]
    norm = 1.0 / (NFFT ** 2 * np.mean(win ** 2))
    out = None
    for c in range(x.shape[1]):
        fr = np.lib.stride_tricks.sliding_window_view(x[:, c], NFFT)[::HOP] * win
        p = np.abs(np.fft.rfft(fr, axis=1)) ** 2 * norm * 2.0
        p[:, 0] *= 0.5
        pb = p @ B
        out = pb if out is None else out + pb
    return out / x.shape[1]


def threshold(P, tab, offset_extra_db=0.0):
    """Masked threshold power per band from the masker's band power (frames x bands): spread, offset, held on."""
    _, S, offset, _ = tab
    T = (P @ S.T) * 10.0 ** (-(offset + offset_extra_db) / 10.0)
    dec = 10.0 ** (-FWD_DB_PER_FRAME / 10.0)
    for t in range(1, T.shape[0]):
        T[t] = np.maximum(T[t], T[t - 1] * dec)
    return T


def ath_power(tab, spl_full_scale):
    return 0.5 * 10.0 ** ((tab[3] - spl_full_scale) / 10.0)


CARRY = 1e-3                             # a band counts for a sound when it holds this much of the strongest band's power


def margin(Pt, T, onset, length):
    """Best margin of a target over a threshold: windows of INTEG frames from the onset to `length` frames after it,
    over the bands that carry the sound (not its leakage skirts: a pure low tone has none above the threshold).
    -> (margin_db, share, window_start, band)"""
    best = (-99.0, 0.0, onset, 0)
    n = Pt.shape[0]
    js = list(range(max(0, onset - 2), min(n - 1, onset + max(1, length)) + 1))
    power = {j: float(Pt[j:min(n, j + INTEG)].mean(axis=0).sum()) for j in js}
    top = max(power.values()) if power else 0.0
    for j in js:
        if power[j] <= 1e-16 or power[j] < 0.1 * top:            # a window with (almost) none of the sound in it
            continue
        a, b = j, min(n, j + INTEG)
        pt, tt = Pt[a:b].mean(axis=0), T[a:b].mean(axis=0)
        carry = pt >= pt.max() * CARRY
        r = np.where(carry, 10.0 * np.log10((pt + EPS) / (tt + EPS)), -999.0)
        k = int(np.argmax(r))
        if r[k] > best[0] or best[0] <= -99.0:
            tot = float(pt.sum()) + EPS
            best = (float(r[k]), float(pt[carry & (pt > tt)].sum() / tot), j, k)
    return best


# ------------------------------------------------------------------------------------------------ audio in
def read_wav(path):
    """-> (samples, channels) float32 at SR, or None. 16/24/32-bit PCM through the wave module, anything else via ffmpeg."""
    try:
        with wave.open(str(path), "rb") as w:
            ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
            raw = w.readframes(n)
        if sr == SR and sw in (2, 3, 4):
            if sw == 2:
                v = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
            elif sw == 4:
                v = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
            else:
                a = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
                i = a[:, 0].astype(np.int32) | (a[:, 1].astype(np.int32) << 8) | (a[:, 2].astype(np.int32) << 16)
                v = (np.where(i >= 1 << 23, i - (1 << 24), i) / float(1 << 23)).astype(np.float32)
            return v.reshape(-1, ch)
    except Exception:
        pass
    return decode(path)


def decode(path):
    import subprocess
    r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "2", "-ar", str(SR),
                        "-f", "f32le", "-"], capture_output=True)
    if r.returncode or not r.stdout:
        return None
    return np.frombuffer(r.stdout, dtype="<f4").reshape(-1, 2).copy()


def stereo(x):
    if x.shape[1] == 1:
        return np.repeat(x, 2, axis=1)
    return x[:, :2]


def put(dst, src, start_s):
    i0 = int(round(start_s * SR))
    if i0 >= dst.shape[0] or i0 + src.shape[0] <= 0:
        return
    a = max(0, -i0)
    b = min(src.shape[0], dst.shape[0] - i0)
    dst[i0 + a:i0 + b] += src[a:b]


# ------------------------------------------------------------------------------------------------ the film
def analyse(clips, dur, gain_db=0.0, original=None, original_gain_db=0.0, spl_full_scale=80.0, offset_db=0.0):
    """clips: [{start, wav (array), bed, texture, layer, ...}] -> per-cue result list."""
    need_numpy()
    tab = tables()
    ath = ath_power(tab, spl_full_scale)
    g = 10.0 ** (gain_db / 20.0)
    n = int(math.ceil(dur * SR)) + NFFT
    bed = np.zeros((n, 2), dtype=np.float32)
    rest = np.zeros((n, 2), dtype=np.float32)
    for c in clips:
        put(bed if c.get("bed") else rest, c["wav"] * g, c["start"])
    orig = np.zeros((n, 2), dtype=np.float32)
    if original is not None:
        o = original[: n] * (10.0 ** (original_gain_db / 20.0))
        orig[: o.shape[0]] = o
    out = []
    for c in clips:
        w = c["wav"] * g
        if w.shape[0] == 0 or c.get("bed"):
            continue
        s0 = max(0.0, c["start"] - PRE)
        keep = min(w.shape[0] / SR, 1.0)                       # the first second of the sound
        s1 = min(dur, c["start"] + keep + INTEG * HOP / SR)
        i0, i1 = int(s0 * SR), max(int(s1 * SR), int(s0 * SR) + NFFT)
        tgt = np.zeros((i1 - i0, 2), dtype=np.float32)
        put(tgt, w, c["start"] - s0)
        r_c = rest[i0:i1] - tgt                                 # everyone else, exactly (the sum is linear)
        P_t = band_power(tgt, tab)
        P_c, P_b, P_o = band_power(r_c, tab), band_power(bed[i0:i1], tab), band_power(orig[i0:i1], tab)
        T_c, T_b, T_o = (threshold(P, tab, offset_db) for P in (P_c, P_b, P_o))
        T_all = T_c + T_b + T_o + ath
        T_nb = T_c + T_o + ath
        onset = int(round((c["start"] - s0) * SR / HOP))
        length = int(round(keep * SR / HOP))
        m, share, j, band = margin(P_t, T_all, onset, length)
        m_nb, share_nb, _, _ = margin(P_t, T_nb, onset, length)
        # where the threshold at the best band comes from (a, b: the frames of the best window)
        a_, b_ = j, min(P_t.shape[0], j + INTEG)
        parts = {"bed": float(T_b[a_:b_, band].mean()), "cues": float(T_c[a_:b_, band].mean()),
                 "original": float(T_o[a_:b_, band].mean()), "quiet": float(ath[band])}
        tot = sum(parts.values()) + EPS
        by = {k: round(v / tot, 2) for k, v in parts.items()}
        out.append({"id": c.get("id"), "label": c.get("label", ""), "role": c.get("role", ""), "t": c.get("t_moment"),
                    "start": c["start"], "layer": bool(c.get("layer")), "texture": bool(c.get("texture")),
                    "margin_db": round(m, 1), "share": round(share, 2), "margin_wo_bed_db": round(m_nb, 1),
                    "bed_cost_db": round(m_nb - m, 1), "band_hz": [EDGES[band], EDGES[band + 1]], "masked_by": by,
                    "class": klass(m)})
    return out


def klass(m):
    return "clear" if m >= 10.0 else "ok" if m >= 3.0 else "marginal" if m >= 0.0 else "masked"


BACKDROP = ("ambience", "vehicle")       # meant to sit under everything: their margin is not a problem


def judged(r):
    """A sound whose audibility is a question: no layer (it joins its parent), no texture (quiet by design), no backdrop."""
    return not r["layer"] and not r["texture"] and r.get("role") not in BACKDROP


def summary(rows):
    real = [r for r in rows if judged(r)]
    cnt = {k: sum(1 for r in real if r["class"] == k) for k in ("clear", "ok", "marginal", "masked")}
    costs = [r["bed_cost_db"] for r in real if r["margin_wo_bed_db"] > -50]
    freed = [r for r in real if r["class"] in ("masked", "marginal") and r["margin_wo_bed_db"] >= 3.0]
    worst = sorted(real, key=lambda r: r["margin_db"])[:8]
    return {"n": len(real), "classes": cnt, "n_layers": sum(1 for r in rows if r["layer"]),
            "n_texture": sum(1 for r in rows if r["texture"] and not r["layer"]),
            "n_backdrop": sum(1 for r in rows if r.get("role") in BACKDROP and not r["layer"] and not r["texture"]),
            "bed_cost_mean_db": round(sum(costs) / len(costs), 1) if costs else 0.0,
            "bed_cost_max_db": round(max(costs), 1) if costs else 0.0,
            "freed_without_bed": [{"t": r["t"], "label": r["label"], "margin_db": r["margin_db"],
                                   "margin_wo_bed_db": r["margin_wo_bed_db"]} for r in freed],
            "worst": [{"t": r["t"], "label": r["label"], "role": r["role"], "margin_db": r["margin_db"],
                       "masked_by": max(r["masked_by"], key=r["masked_by"].get), "band_hz": r["band_hz"]}
                      for r in worst]}


def text(sm, has_bed):
    c = sm["classes"]
    apart = [f"{sm[k]} {lab}" for k, lab in (("n_layers", "layers"), ("n_texture", "texture"), ("n_backdrop", "backdrop"))
             if sm.get(k)]
    lines = [f"Masking model (critical bands, 192 ms energy window): {sm['n']} sounds"
             f"{' (+' + ', '.join(apart) + ' not judged: they are meant to sit under or inside others)' if apart else ''}",
             f"  clear (10 dB and more over the masked threshold) {c['clear']}, ok (3..10) {c['ok']}, "
             f"marginal (0..3) {c['marginal']}, masked (under it) {c['masked']}"]
    if has_bed:
        lines.append(f"  the bed takes {sm['bed_cost_mean_db']:.1f} dB of margin on average (up to {sm['bed_cost_max_db']:.1f}); "
                     f"{len(sm['freed_without_bed'])} sound(s) would be clearly audible without it")
        for r in sm["freed_without_bed"][:4]:
            lines.append(f"     {r['t']:.2f}s '{str(r['label'])[:28]}': {r['margin_db']:+.1f} dB with the bed, "
                         f"{r['margin_wo_bed_db']:+.1f} without")
    lines.append("  the least audible (the bed, layers and the texture layer left out):")
    for r in sm["worst"][:5]:
        lines.append(f"     {r['t']:.2f}s {str(r['label'])[:28]:28s} {r['role']:8s} {r['margin_db']:+6.1f} dB   "
                     f"at {r['band_hz'][0]}-{r['band_hz'][1]} Hz, under: {r['masked_by']}")
    lines.append("  A textbook model of tones and noise on transients: it orders the places, it does not hear. "
                 "Check the first ones by ear (listen_page.py).")
    return lines


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("resolved")
    ap.add_argument("clips", help="the folder of mix.py --export-clips")
    ap.add_argument("--gain-db", type=float, default=None,
                    help="the level of the clips in the film (layer match + master gain); default: the master gain of the sheet")
    ap.add_argument("--original", help="the film's own audio that is in the mix (music, voice)")
    ap.add_argument("--original-gain-db", type=float, default=0.0)
    ap.add_argument("--spl-full-scale", type=float, default=80.0,
                    help="dB SPL of a full-scale sine at the listener (80 = a -14 LUFS film at ~70 dB SPL)")
    ap.add_argument("--offset-db", type=float, default=0.0,
                    help="calibration: + makes the masker weaker (more sounds audible), - stronger")
    ap.add_argument("--json", help="write the per-cue result and the summary here")
    a = ap.parse_args()
    need_numpy()
    res = json.loads(Path(a.resolved).read_text(encoding="utf-8-sig"))
    dur = float(res.get("duration") or 0.0)
    rows = json.loads((Path(a.clips) / "sfx_clips.json").read_text(encoding="utf-8"))
    gain = a.gain_db if a.gain_db is not None else float((res.get("loudness") or {}).get("gain_db") or 0.0)
    clips = []
    for r in rows:
        x = read_wav(Path(a.clips) / r["file"])
        if x is None:
            continue
        clips.append(dict(r, wav=stereo(x)))
        dur = max(dur, r["start"] + x.shape[0] / SR)
    original = stereo(decode(a.original)) if a.original else None
    out = analyse(clips, dur, gain, original, a.original_gain_db, a.spl_full_scale, a.offset_db)
    has_bed = any(r.get("bed") for r in rows)
    sm = summary(out)
    print("\n".join(text(sm, has_bed)))
    if a.json:
        Path(a.json).write_text(json.dumps({"summary": sm, "cues": out, "gain_db": gain, "spl_full_scale": a.spl_full_scale,
                                            "offset_db": a.offset_db}, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
