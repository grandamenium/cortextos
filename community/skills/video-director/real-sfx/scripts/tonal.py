#!/usr/bin/env python3
"""Does a pitched sound sit in the key of the music under it? A chime, a pop, a UI blip over a tonal score is either a
chord tone or a wrong note; a semitone or two of retuning decides which.

  python tonal.py SOUND.wav [--music score.wav --at 12.4]      the pitches of a sound (and what the score has there)
  python tonal.py --id 63 --music bed.wav --at 25.84            the same for a library sound by its id

mix.py does this by itself for the tonal roles (chime, pop, glass, coin, ui) when the sheet names the score
(`_draft.music_ref`, written by from_cues; --music-ref FILE): the sound is retuned by up to 2 whole semitones plus
the cents that put its strongest partial exactly on its note (so at most 2.5 st in all; a sound that is 40 cents flat is
put on the note) when that puts its strong partials on the pitch classes the music holds at that moment and takes them
off the ones a semitone beside a held note. Noise has no pitch and is left alone.

How: the partials are peaks of the 8192-point spectrum of the sound's loudest 0.5 s (80-3000 Hz, 12 dB over the
median); the music is a chroma (energy per pitch class, 80-2000 Hz) of 0.9 s from the moment on.
Importable: sound_partials(path), chroma(path, t0, dur), best_shift(partials, chroma) -> (shift, gain, why).
"""
import argparse
import array
import math
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import _fft

NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
N = 8192
RATE = 16000
_CACHE = {}


def midi_name(m):
    k = int(round(m))
    return f"{NOTES[k % 12]}{k // 12 - 1}"


def _decode(path, t0=0.0, dur=None):
    cmd = ["ffmpeg", "-v", "error", "-nostdin"]
    if t0 > 0:
        cmd += ["-ss", f"{t0:.3f}"]
    if dur:
        cmd += ["-t", f"{dur:.3f}"]
    cmd += ["-i", str(path), "-vn", "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-"]
    p = subprocess.run(cmd, capture_output=True)
    a = array.array("h")
    a.frombytes(p.stdout[: len(p.stdout) // 2 * 2])
    return a


def _mags(seg):
    n = N
    seg = list(seg[:n]) + [0] * max(0, n - len(seg))
    re_ = [seg[k] * (0.5 - 0.5 * math.cos(2 * math.pi * k / (n - 1))) for k in range(n)]
    im_ = [0.0] * n
    _fft(re_, im_)
    return [math.hypot(re_[k], im_[k]) for k in range(n // 2)]


def sound_partials(path, max_partials=3):
    """The strongest steady partials: [(midi float, weight)], weights sum to 1. [] for a noise (no pitch)."""
    key = ("p", str(path))
    if key in _CACHE:
        return _CACHE[key]
    a = _decode(path, 0.0, 1.5)
    if len(a) < 800:
        _CACHE[key] = []
        return []
    w = 8000                                           # the loudest half second
    best, bi = -1.0, 0
    for i in range(0, max(1, len(a) - w), 1600):
        e = sum(v * v for v in a[i:i + w])
        if e > best:
            best, bi = e, i
    mags = _mags(a[bi:bi + w])
    lo, hi = int(80 * N / RATE), int(3000 * N / RATE)
    band = mags[lo:hi]
    if not band or max(band) <= 0:
        _CACHE[key] = []
        return []
    med = sorted(band)[len(band) // 2] or 1e-9
    top = max(band)
    peaks = []
    for k in range(lo + 1, hi - 1):
        m = mags[k]
        if m >= mags[k - 1] and m > mags[k + 1] and m >= 4.0 * med and m >= 0.12 * top:
            a0, b0, c0 = mags[k - 1], m, mags[k + 1]
            d = 0.5 * (a0 - c0) / (a0 - 2 * b0 + c0) if (a0 - 2 * b0 + c0) != 0 else 0.0
            f = (k + d) * RATE / N
            peaks.append((m, f))
    peaks.sort(reverse=True)
    chosen = []
    for m, f in peaks:
        if all(abs(12 * math.log2(f / g)) > 0.6 for _, g in chosen):
            chosen.append((m, f))
        if len(chosen) >= max_partials:
            break
    if not chosen:
        _CACHE[key] = []
        return []
    tot = sum(m for m, _ in chosen)
    out = [(69.0 + 12.0 * math.log2(f / 440.0), m / tot) for m, f in chosen]
    _CACHE[key] = out
    return out


def chroma(path, t0, dur=0.9):
    """Energy per pitch class (12 values, largest = 1.0) of [t0, t0 + dur] of a music file, 80-2000 Hz."""
    key = ("c", str(path), round(t0 * 4))
    if key in _CACHE:
        return _CACHE[key]
    a = _decode(path, max(0.0, t0), dur)
    out = [0.0] * 12
    if len(a) >= 1600:
        step = max(N // 2, (len(a) - N) // 2 if len(a) > N else N)
        starts = list(range(0, max(1, len(a) - N // 2), step))[:3]
        for s in starts:
            mags = _mags(a[s:s + N])
            for k in range(int(80 * N / RATE), int(2000 * N / RATE)):
                f = k * RATE / N
                pc = int(round(69.0 + 12.0 * math.log2(f / 440.0))) % 12
                out[pc] += mags[k] ** 2
    m = max(out)
    res = [v / m for v in out] if m > 0 else [0.0] * 12
    _CACHE[key] = res
    return res


def _score(partials, ch, shift):
    sc = 0.0
    for m, w in partials:
        pc = int(round(m + shift)) % 12
        beside = max(ch[(pc + 1) % 12], ch[(pc - 1) % 12])
        sc += w * (ch[pc] - 0.6 * max(0.0, beside - ch[pc]))
    return sc


def best_shift(partials, ch, max_shift=2):
    """(shift in semitones incl. cents, score gain over leaving it, why) or (0, 0, reason)."""
    if not partials:
        return 0.0, 0.0, "no pitch (noise)"
    mean = sum(ch) / 12.0
    if mean <= 0 or max(ch) / mean < 1.6:
        return 0.0, 0.0, "the music has no clear tonal centre there"
    m0 = max(partials, key=lambda p: p[1])[0]
    cents = round(m0) - m0                      # what puts the strongest partial exactly on its note
    base = _score(partials, ch, 0.0)
    best = (0.0, 0.0)
    for k in range(-max_shift, max_shift + 1):
        s = k + cents
        gain = _score(partials, ch, s) - base - 0.04 * abs(k)
        if gain > best[1]:
            best = (s, gain)
    if best[1] < 0.15:
        return 0.0, 0.0, "already in the key"
    return round(best[0], 2), round(best[1], 2), "retuned"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("sound", nargs="?")
    ap.add_argument("--id", type=int)
    ap.add_argument("--music")
    ap.add_argument("--at", type=float, default=0.0)
    a = ap.parse_args()
    path = a.sound
    if a.id is not None:
        from picker import load_index, find
        rec = find(load_index(), a.id)
        if rec is None:
            sys.exit(f"no sound with id {a.id}")
        path = rec["path"]
    if not path:
        sys.exit("give a sound file or --id")
    pa = sound_partials(path)
    if not pa:
        print("no pitch: a noise or a click (nothing to tune)")
        return 0
    print("partials: " + ", ".join(f"{midi_name(m)} ({440 * 2 ** ((m - 69) / 12):.0f} Hz, {100 * w:.0f} %)"
                                   for m, w in pa))
    if a.music:
        ch = chroma(a.music, a.at)
        print("the music at %.2f s holds: " % a.at +
              ", ".join(f"{NOTES[i]} {ch[i]:.2f}" for i in sorted(range(12), key=lambda i: -ch[i])[:5]))
        s, g, why = best_shift(pa, ch)
        print(f"fit: {s:+.2f} semitones ({why}, gain {g:.2f})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
