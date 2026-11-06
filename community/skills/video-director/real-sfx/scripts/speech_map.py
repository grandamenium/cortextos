#!/usr/bin/env python3
"""Where does the voice speak and where are the pauses? A map of the original audio.

  python speech_map.py film.mp4 [--cues result/film_sfx_resolved_cues.json] [--json work/speech.json]

Output: speech segments and pauses (seconds). Heavy sounds belong in pauses or on the change between
phrases, light ticks may sit under speech. With --cues it also says, for every cue, whether it sits in
speech or in a pause and how far the nearest pause is.

How: the 250-3800 Hz band of the original audio, 25 ms steps, adaptive threshold = quiet floor + 12 dB,
short gaps (< 150 ms, breaths, consonants) are bridged, blips (< 150 ms) removed. Not a speech
recogniser: music in that band counts as "speech". If the track is active more than ~92 % of the time
it is reported as continuous content (music or room tone), where pauses are not meaningful.
"""
import argparse
import array
import json
import math
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import load_json

RATE = 8000
HOP = 0.025


def band_db(path):
    r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "1", "-ar", str(RATE),
                        "-af", "highpass=f=250,lowpass=f=3800", "-f", "s16le", "-"], capture_output=True)
    a = array.array("h")
    a.frombytes(r.stdout[: len(r.stdout) // 2 * 2])
    w = int(RATE * HOP)
    out = []
    for i in range(0, len(a) - w + 1, w):
        e = math.sqrt(sum(v * v for v in a[i:i + w]) / w) / 32768.0
        out.append(20 * math.log10(e) if e > 1e-5 else -100.0)
    return out


def segments(db, bridge=0.15, minlen=0.15):
    if not db:
        return [], 0.0, -100.0
    s = sorted(db)
    floor = s[int(0.10 * (len(s) - 1))]
    thr = max(floor + 12.0, -50.0)
    # median smoothing over 5 steps
    sm = [sorted(db[max(0, i - 2):i + 3])[len(db[max(0, i - 2):i + 3]) // 2] for i in range(len(db))]
    active = [v > thr for v in sm]
    segs, start = [], None
    for i, a in enumerate(active + [False]):
        if a and start is None:
            start = i
        elif not a and start is not None:
            segs.append([start * HOP, i * HOP])
            start = None
    merged = []
    for sg in segs:
        if merged and sg[0] - merged[-1][1] < bridge:
            merged[-1][1] = sg[1]
        else:
            merged.append(sg)
    merged = [s_ for s_ in merged if s_[1] - s_[0] >= minlen]
    ratio = sum(e - s_ for s_, e in merged) / (len(db) * HOP) if db else 0.0
    return merged, ratio, thr


def pauses_of(segs, dur, min_pause=0.25):
    out, t = [], 0.0
    for s_, e in segs:
        if s_ - t >= min_pause:
            out.append([round(t, 3), round(s_, 3)])
        t = e
    if dur - t >= min_pause:
        out.append([round(t, 3), round(dur, 3)])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("media")
    ap.add_argument("--cues")
    ap.add_argument("--json")
    ap.add_argument("--min-pause", type=float, default=0.25)
    ap.add_argument("--from-film", action="store_true",
                    help="read the film's own audio even when the cue sheet names a voice stem")
    a = ap.parse_args()

    src, stem_note = a.media, None
    if a.cues and not a.from_film:
        vs_ = load_json(a.cues).get("voice_stems") or []
        vs_ = [vs_] if isinstance(vs_, str) else vs_
        vs_ = [v for v in vs_ if Path(v).exists()]
        if vs_:
            src = vs_[0]
            stem_note = (f"speech map from the voice stem {Path(src).name} named in the cue sheet (music under the "
                         f"voice is not speech; --from-film reads the film's own audio)")
            print(stem_note)
    db = band_db(src)
    dur = len(db) * HOP
    segs, ratio, thr = segments(db)
    pauses = pauses_of(segs, dur, a.min_pause)
    srt = sorted(db)
    p10, p90 = (srt[int(0.1 * (len(srt) - 1))], srt[int(0.9 * (len(srt) - 1))]) if srt else (-100.0, -100.0)
    # the band never gets quiet: a bed (music, room tone) runs under everything and level alone cannot find pauses
    continuous = (ratio > 0.92 or (p90 - p10) < 15.0 or p10 > -40.0) and stem_note is None
    res = {"duration": round(dur, 2), "threshold_db": round(thr, 1), "active_ratio": round(ratio, 2),
           "quiet_floor_db": round(p10, 1), "continuous": continuous,
           "speech": [[round(s, 2), round(e, 2)] for s, e in segs], "pauses": pauses}
    print(f"{dur:.1f} s, active {ratio:.0%} of the time, {len(segs)} segments, {len(pauses)} pauses >= {a.min_pause} s")
    if res["continuous"]:
        print(f"WARNING: the speech band never goes quiet (quiet floor {p10:.0f} dB): a music or ambience bed runs "
              f"under the voice, so level alone cannot tell speech from pauses. The lists below are NOT reliable;")
        print("         look at the original spectrogram with zoom.py (voice shows as horizontal bands, "
              "phrases as gaps between them)")
    print("speech:", ", ".join(f"{s:.1f}-{e:.1f}" for s, e in res["speech"][:24]), "..." if len(segs) > 24 else "")
    print("pauses:", ", ".join(f"{s:.1f}-{e:.1f}" for s, e in pauses[:24]), "..." if len(pauses) > 24 else "")
    if a.cues:
        sheet = load_json(a.cues)
        print("\ncue placement:")
        for c in sorted(sheet["cues"], key=lambda c: c["t"]):
            if c.get("_layer"):
                continue
            t = c["t"]
            inside = next((s for s in segs if s[0] <= t <= s[1]), None)
            if inside:
                near = min(pauses, key=lambda p: min(abs(p[0] - t), abs(p[1] - t)), default=None)
                hint = f"nearest pause {near[0]:.1f}-{near[1]:.1f}" if near else "no pause"
                print(f"  {t:7.2f}s  {c.get('role', '?'):9s} UNDER SPEECH ({inside[0]:.1f}-{inside[1]:.1f}); {hint}")
            else:
                print(f"  {t:7.2f}s  {c.get('role', '?'):9s} in a pause")
    if a.json:
        Path(a.json).parent.mkdir(parents=True, exist_ok=True)
        Path(a.json).write_text(json.dumps(res, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
