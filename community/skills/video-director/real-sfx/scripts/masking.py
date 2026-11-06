#!/usr/bin/env python3
"""Does a sound cover speech (or the music's body)? Objective check for voice-led videos.

  python masking.py result/film_sfx_resolved_cues.json result/film_sfx_sfx_track.wav --video film.mp4

For every cue the speech band (250-3800 Hz) of the original audio is compared with the same band of the
SFX track in the window where the sound is audible. A cue masks when the original is speaking there
(its band rises 8 dB above its own local floor, so a pause over a music bed does not count) and the SFX is
within 3 dB of it or louder. Returns the list so critique.py and the
agent can fix those cues first: lower gain_db, add highpass, shorten, move into a pause, or run mix.py
with --voice-safe.

Importable: masked_cues(cues, sfx_wav, video) -> list of dicts.
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


def band_env(path, hop=0.05):
    """RMS in dB of the 250-3800 Hz band per hop, for a file's audio."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "1", "-ar", str(RATE),
                        "-af", "highpass=f=250,lowpass=f=3800", "-f", "s16le", "-"], capture_output=True)
    a = array.array("h")
    a.frombytes(r.stdout[: len(r.stdout) // 2 * 2])
    w = int(RATE * hop)
    out = []
    for i in range(0, len(a) - w + 1, w):
        e = math.sqrt(sum(v * v for v in a[i:i + w]) / w) / 32768.0
        out.append(20 * math.log10(e) if e > 1e-5 else -100.0)
    return out


def speech_active(orig, hop=0.05, rise_db=8.0, window_s=3.0, below_peak=26.0):
    """True where the original's speech band rises clearly above its own local floor: voice bursts over a bed.
    A pause (music bed or room tone only) stays False, so a sound in a pause is not 'masking speech'."""
    n = len(orig)
    half = max(1, int(window_s / hop / 2))
    act = [False] * n
    live = sorted(v for v in orig if v > -70.0)
    # the speech itself sets the scale: the tail of a word in a pause (20 dB under the speech) is not speech
    ref = live[int(0.9 * (len(live) - 1))] if live else -50.0
    floor_abs = max(-50.0, ref - below_peak)          # a clean voice stem: breath and noise sit 20+ dB under the words
    for i in range(n):
        win = sorted(orig[max(0, i - half):i + half + 1])
        floor = win[int(0.10 * (len(win) - 1))]
        act[i] = orig[i] > max(floor + rise_db, floor_abs)
    return act


VOICE_WORDS = ("voice", "vo_", "_vo", "vox", "dialog", "narrat", "speech", "speak")


def voice_stem(sheet):
    """The speech stem among the files the original was rebuilt from: a clean voice, its pauses are real pauses
    (the music under it is not mistaken for speech). None when there is none."""
    given = sheet.get("voice_stems") or []
    if isinstance(given, str):
        given = [given]
    for f in given:                         # the mixer wrote which files are speech
        if Path(f).exists():
            return f
    for f in sheet.get("base_audio") or []:
        f = f.get("file") if isinstance(f, dict) else f
        s = Path(str(f)).stem.lower()
        if any(w in s for w in VOICE_WORDS) and Path(f).exists():
            return f
    return None


def speech_activity(sheet, orig_src, hop=0.05):
    """The speech mask of a sheet on a grid of `hop`: from the voice stem when the mixer rebuilt from one, else
    from the original audio. Returns a function t -> bool, or None when there is nothing to read."""
    src = voice_stem(sheet) or orig_src
    if not src or not Path(src).exists():
        return None
    act = speech_active(band_env(src, hop), hop)
    return lambda t: bool(0 <= int(t / hop) < len(act) and act[int(t / hop)])


def active_level_diff(orig, final, hop=0.1, floor_db=-50.0):
    """Mean level of `final` minus `orig` (dB, energy mean) over the frames where the ORIGINAL sounds. The
    integrated LUFS of a file with new quiet sounds in the original's silence drops (BS.1770 gating) although the
    original's own sound was not touched; this says which of the two it is. None when it cannot be read."""
    try:
        eo, ef = full_env(orig, hop), full_env(final, hop)
    except Exception:
        return None
    n = min(len(eo), len(ef))
    idx = [i for i in range(n) if eo[i] > floor_db]
    if len(idx) < 10:
        return None
    po = sum(10 ** (eo[i] / 10.0) for i in idx) / len(idx)
    pf = sum(10 ** (ef[i] / 10.0) for i in idx) / len(idx)
    if po <= 0 or pf <= 0:
        return None
    return 10 * math.log10(pf / po)


def masked_cues(cues, sfx_wav, video, hop=0.05, margin_db=3.0, speech_floor_db=-48.0, gain_db=0.0, clean_voice=False):
    """Cues whose sound sits within margin_db of (or above) the original while the original is SPEAKING.
    gain_db: what the mix added to `video` (a stem enters the mix at the base gain). clean_voice: `video` is a voice
    stem (no music): breath and noise between words are not speech (a stricter floor under the words).
    The voice is read 100 ms ahead (the first frame of a word is its attack, the word is what masks), and a cue is
    only judged until the next cue begins (the next cue's own energy is not this cue's)."""
    orig = [v + gain_db for v in band_env(video, hop)]
    sfx = band_env(sfx_wav, hop)
    act = speech_active(orig, hop, below_peak=20.0 if clean_voice else 26.0)
    n = min(len(orig), len(sfx))
    ahead = [max(orig[i:i + 3]) for i in range(len(orig))]
    mains = sorted((c for c in cues if not c.get("_layer")), key=lambda c: c.get("start", c["t"]))
    res = []
    for k_, c in enumerate(mains):
        t0 = c.get("start", c["t"])
        t1 = t0 + min(c.get("seg", 0.4), 0.6)
        nxt = next((m_.get("start", m_["t"]) for m_ in mains[k_ + 1:] if m_.get("start", m_["t"]) > t0 + 0.03), None)
        if nxt is not None and nxt < t1:
            t1 = max(t0 + hop, nxt - 0.01)
        i0, i1 = int(t0 / hop), max(int(t0 / hop) + 1, int(t1 / hop))
        worst, where = None, None
        for i in range(i0, min(i1, n)):
            if act[i] and orig[i] > speech_floor_db and sfx[i] > -60:
                d = sfx[i] - ahead[i]
                if worst is None or d > worst:
                    worst, where = d, i * hop
        if worst is not None and worst > -margin_db:
            res.append({"t": c["t"], "label": c.get("label", ""), "role": c.get("role"), "over_db": round(worst, 1),
                        "at": round(where, 2)})
    return res


def full_env(path, hop=0.1, rate=16000):
    """RMS in dB of the whole band per hop (for loudness relations, not for masking)."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "1", "-ar", str(rate),
                        "-f", "s16le", "-"], capture_output=True)
    a = array.array("h")
    a.frombytes(r.stdout[: len(r.stdout) // 2 * 2])
    w = int(rate * hop)
    out = []
    for i in range(0, len(a) - w + 1, w):
        e = math.sqrt(sum(v * v for v in a[i:i + w]) / w) / 32768.0
        out.append(20 * math.log10(e) if e > 1e-5 else -100.0)
    return out


def cue_levels(cues, sfx_wav, video, hop=0.1, around_s=3.0):  # silent windows are reported with silent=True
    """For every cue: how loud is the sound at its loudest 100 ms compared with the original's median level in the
    3 s around it. This is the balance a mixer judges: a tick sits 8-12 dB under the picture's sound, a big hit
    around it or a little above. Integrated LUFS of a sparse SFX track cannot say that."""
    orig, sfx = full_env(video, hop), full_env(sfx_wav, hop)
    half = max(1, int(around_s / hop / 2))
    res = []
    for c in cues:
        if c.get("_layer"):
            continue
        t0 = c.get("start", c["t"])
        i0 = int(t0 / hop)
        i1 = max(i0 + 1, int((t0 + min(c.get("seg", 0.4), 0.6)) / hop))
        s = max(sfx[i0:i1], default=-100.0)
        win = sorted(orig[max(0, i0 - half):i0 + half + 1])
        o = win[len(win) // 2] if win else -100.0
        if s > -70 and o > -70:
            res.append({"t": c["t"], "role": c.get("role"), "label": c.get("label", ""), "delta_db": round(s - o, 1)})
        elif s > -70:                       # the original is silent around this sound: nothing to bury or mask
            res.append({"t": c["t"], "role": c.get("role"), "label": c.get("label", ""), "delta_db": None,
                        "silent": True})
    return res


def sub_env(path, hop=0.05):
    """RMS in dB of the 30-140 Hz band per hop."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "1", "-ar", str(RATE),
                        "-af", "highpass=f=30,lowpass=f=140", "-f", "s16le", "-"], capture_output=True)
    a = array.array("h")
    a.frombytes(r.stdout[: len(r.stdout) // 2 * 2])
    w = int(RATE * hop)
    out = []
    for i in range(0, len(a) - w + 1, w):
        e = math.sqrt(sum(v * v for v in a[i:i + w]) / w) / 32768.0
        out.append(20 * math.log10(e) if e > 1e-5 else -100.0)
    return out


def lowend_collisions(cues, sfx_wav, video, hop=0.05, floor_db=-38.0):
    """Heavy cues (hit, sub_drop, design) that land where the original audio already has strong sub/bass.
    Two bass sources on top of each other make mud; the original stays, so the SFX has to make room:
    highpass the sound (about 90 Hz), lower it, move it between bass notes, or drop the sub layer."""
    orig, sfx = sub_env(video, hop), sub_env(sfx_wav, hop)
    n = min(len(orig), len(sfx))
    res = []
    for c in cues:
        if c.get("role") not in ("hit", "sub_drop", "design"):
            continue
        t0 = c.get("start", c["t"])
        i0 = int(t0 / hop)
        i1 = max(i0 + 1, int((t0 + min(c.get("seg", 0.5), 0.6)) / hop))
        pairs = [(orig[i], sfx[i]) for i in range(i0, min(i1, n)) if sfx[i] > -60]
        if not pairs:
            continue
        o = max(p[0] for p in pairs)
        s = max(p[1] for p in pairs)
        if o > floor_db and s > o - 6.0:
            res.append({"t": c["t"], "label": c.get("label", ""), "role": c["role"], "orig_sub_db": round(o, 1),
                        "sfx_sub_db": round(s, 1), "need_db": round(s - (o - 6.0) + 1.0, 1)})
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cues")
    ap.add_argument("track")
    ap.add_argument("--video")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--lowend", action="store_true", help="also report heavy cues that collide with bass in the original")
    ap.add_argument("--dry-track", action="store_true",
                    help="judge the raw SFX track even when the sheet has the ducked one (the default is what is in the mix)")
    a = ap.parse_args()
    sheet = load_json(a.cues)
    video = a.video or sheet.get("original_audio") or sheet.get("video")
    if not video:
        sys.exit("need the video (--video) to read the original audio")
    from common import voice_share
    vstem = voice_stem(sheet) if not a.video else None
    speech_src = vstem or video
    speech_gain = float(sheet.get("voice_stem_gain_db", sheet.get("base_gain_db")) or 0.0) if vstem else 0.0
    track = a.track
    if sheet.get("sfx_ducked") and Path(sheet["sfx_ducked"]).exists() and not a.dry_track:
        track = sheet["sfx_ducked"]                  # what is IN the mix after the voice-safe ducking
        print(f"track: {Path(track).name} (the SFX as they sit in the mix, after ducking; --dry-track for the raw bus)")
    if vstem:
        print(f"speech reference: the voice stem {Path(vstem).name} (not the whole original, music is not speech)")
    vs = voice_share(speech_src)
    if vs is not None and vs.get("speech", 1.0) < 0.05 and not a.lowend:
        print(f"no speech in the original audio (speech {vs['speech']:.0%}, music {vs.get('music', 0):.0%}): "
              f"nothing to mask. --lowend still checks the bass.")
        return
    if (sheet.get("flags") or {}).get("voice_safe") and track == a.track and not a.dry_track:
        print("WARN: this mix was made with --voice-safe but its ducked SFX file (*_sfx_ducked.wav) is missing: the "
              "dry track overstates the masking (the mix ducks it by several dB)")
    res = masked_cues(sheet["cues"], track, speech_src, gain_db=speech_gain, clean_voice=bool(vstem)) \
        if (vs is None or vs.get("speech", 1.0) >= 0.05) else []
    if a.lowend:
        low = lowend_collisions(sheet["cues"], track, video)
        if low:
            print(f"{len(low)} heavy cue(s) collide with bass already in the original audio:")
            for r in low:
                print(f"  {r['t']:7.2f}s  {r['role']:8s} {r['label'][:28]:28s} original sub {r['orig_sub_db']:.0f} dB, "
                      f"SFX sub {r['sfx_sub_db']:.0f} dB: lower it {r['need_db']:.0f} dB, or highpass >= 140 Hz "
                      f"(90 Hz leaves the 100-140 Hz band the check measures), or drop the sub layer")
        else:
            print("no heavy cue collides with bass in the original audio")
    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=1))
    elif not res:
        print("no cue masks the original audio")
    else:
        print(f"{len(res)} cue(s) sit on top of the original audio (speech band):")
        for r in res:
            print(f"  {r['t']:7.2f}s  {r['role'] or '?':8s} {r['label'][:28]:28s} SFX {r['over_db']:+.1f} dB vs original"
                  f"  -> lower by {max(1.0, r['over_db'] + 3.0 + 1.0):.0f} dB, shorten, or move into a pause")
    sys.exit(1 if res else 0)


if __name__ == "__main__":
    main()
