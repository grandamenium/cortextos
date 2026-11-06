#!/usr/bin/env python3
"""Check a finished mix: does every peak-anchored sound land on its moment, is anything clipping?

  python verify.py result/film_sfx_resolved_cues.json result/film_sfx_sfx_track.wav [--tol-ms 40] [--json]

Exit code 1 when a cue is off by more than the tolerance or the track clips. A sound placed by its ARRIVAL (anchor
`arrive`: the first 60 ms within 6 dB of its loudest, the default of a sound that gets loud fast) is judged by where that
happens around t. Cues anchored on start/end are listed but not judged, since their loudest point is not meant to sit on t. Broad sounds
(whoosh, riser, ambience, design) have a flat top, so their tolerance is 2.25x; textures longer than 0.6 s (paper,
broom, rubber, static, drips) have no real peak at all: 4x. A sound counts as present when anything above -60 dBFS
sounds in its first three seconds (a bed fades in).
"""
import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import (ROLE_ANCHOR, ROLE_TARGET_PEAK_DB, decode_mono, events_track, index_path, load_config,
                    load_json)

BROAD = ("whoosh", "riser", "ambience", "design", "scifi")
# textures (paper, broom, rubber, static) have a flat top once they are longer than a click: where their loudest
# 20 ms sits is arbitrary, so they get the broad tolerance too
BROAD_IF_LONG = ("paper", "foley", "cartoon", "glitch", "vehicle", "water", "chime")


def _level(x):
    """Loudness of a placed sound: its real peak plus the gain mix.py applied (nominal when unresolved)."""
    if x.get("peak_db") is not None and x.get("gain_applied_db") is not None:
        return x["peak_db"] + x["gain_applied_db"]
    return ROLE_TARGET_PEAK_DB.get(x.get("role"), -10) + x.get("gain_db", 0.0)


def offsets(cues, track, tol_ms=40.0):
    """For every cue: where the loudest 20 ms of the track really is, around the moment (+-250 ms)."""
    samples, rate = decode_mono(track, 16000)       # the same view as the library analysis (peak_time)
    win = rate // 50                                # 20 ms windows, hop of half a window
    out = []
    sides = None                                    # the two channels, decoded only if a sound looks missing
    # a bed (bed.py) is the floor under the film, not a sound with a moment: it is not judged, and it is no neighbour
    # (as a long quiet "similar" sound it would make every quiet key look masked)
    ordered = sorted((c for c in cues if not c.get("bed")), key=lambda c: c["t"])
    ts = [c["t"] for c in ordered]
    for n, c in enumerate(ordered):
        role = c.get("role") or "default"
        anchor = c.get("anchor") or ROLE_ANCHOR.get(role, "peak")
        row = {"n": n, "t": c["t"], "label": c.get("label", ""), "role": role, "anchor": anchor, "judged": False,
               "off_ms": None, "ok": True, "layer": bool(c.get("_layer"))}
        # look only half-way towards the neighbouring sounds, otherwise a louder neighbour is measured instead
        others = [abs(x - c["t"]) for x in ts if abs(x - c["t"]) > 0.03]      # within 30 ms: the same event
        half = min(0.25, 0.5 * min(others)) if others else 0.25
        if anchor in ("peak", "arrive") and half < 0.04:
            row["note"] = "crowded: a neighbour is closer than 80 ms"
        elif anchor == "peak":
            lo = max(0, int((c["t"] - half) * rate))
            hi = min(len(samples) - win, int((c["t"] + half) * rate))
            if hi > lo:
                best = max(range(lo, hi, win // 2), key=lambda i: sum(s * s for s in samples[i:i + win]))
                tm = best / rate + win / rate / 2
                off = (tm - c["t"]) * 1000
                silent_ = not any(samples[best:best + win])      # the mono sum of channels that cancel is silence
                textured = role in BROAD_IF_LONG and (c.get("seg") or 0) >= 0.6
                tol = tol_ms * (2.25 if role in BROAD else 4.0 if textured else 1.0)
                def level(x):      # loudness of the sound as placed: its real peak plus the gain mix.py applied
                    if x.get("peak_db") is not None and x.get("gain_applied_db") is not None:
                        return x["peak_db"] + x["gain_applied_db"]
                    return ROLE_TARGET_PEAK_DB.get(x.get("role"), -10) + x.get("gain_db", 0.0)
                masker = next((o for o in ordered if o is not c and "start" in o and "seg" in o
                               and o["start"] <= tm <= o["start"] + o["seg"] and level(o) > level(c) + 1.0), None)
                # a bouncy sound has several peaks within a few dB of each other; if the one at the moment is
                # within 3 dB of the loudest, the moment is on a peak of this sound and it counts as in sync
                a0 = max(0, int((c["t"] - tol / 1000.0) * rate))
                a1 = min(len(samples) - win, int((c["t"] + tol / 1000.0) * rate))
                e_best = sum(s_ * s_ for s_ in samples[best:best + win])
                e_at = max((sum(s_ * s_ for s_ in samples[i:i + win]) for i in range(a0, a1 + 1, max(1, win // 2))),
                           default=0)
                co_peak = e_best > 0 and e_at > 0 and 10 * math.log10(e_at / e_best) >= -3.0
                if silent_:
                    row["note"] = "silent in the mono sum (its channels are in opposite phase)"
                elif masker is not None and abs(off) > tol and not co_peak:
                    # the loudest point belongs to a louder sound that is still ringing: not this cue's peak
                    row["note"] = f"masked by the louder sound at {masker['t']:.2f}s"
                else:
                    ok = abs(off) <= tol or co_peak
                    row.update(judged=True, off_ms=round(off), ok=ok, tol_ms=tol)
                    if co_peak and abs(off) > tol:
                        row["note"] = "another peak of the same sound sits on the moment"
        elif anchor == "arrive":
            # placed by its arrival: the first 60 ms within 6 dB of the loudest, around the moment (as the placement measured it)
            if any(o is not c and "start" in o and "seg" in o and "start" in c and abs(o["t"] - c["t"]) > 0.03
                   and o["start"] < c["t"] + half and o["start"] + o["seg"] > c["t"] - half
                   and _level(o) >= _level(c) - 6.0 for o in ordered):
                row["note"] = "a neighbour of similar level still sounds here: the arrival cannot be told apart"
            else:
                lo = max(0, int((c["t"] - half) * rate))
                hi = min(len(samples) - 3 * win, int((c["t"] + half) * rate))
                if hi > lo:
                    step_ = max(1, win // 2)
                    idx_ = list(range(lo, hi, step_))
                    en_ = [sum(s_ * s_ for s_ in samples[i:i + 3 * win]) for i in idx_]
                    top_ = max(en_)
                    if top_ > 0:
                        k_ = next(j for j, e_ in enumerate(en_) if e_ >= top_ * 0.251)          # within 6 dB
                        off = (idx_[k_] / rate + 0.01 - c["t"]) * 1000
                        tol = tol_ms * (2.25 if role in BROAD else 1.5)      # the local loudest is not always the sound's own: the arrival reads a little early
                        row.update(judged=True, off_ms=round(off), ok=abs(off) <= tol, tol_ms=tol, note="arrival")
        elif anchor == "start" and half >= 0.03 and any(
                o is not c and "start" in o and "seg" in o and "start" in c
                and abs(o["t"] - c["t"]) > 0.03          # layers of the SAME moment start together: one onset
                and o["start"] < c["t"] + 0.05 and o["start"] + o["seg"] > c["t"] - 0.05
                and _level(o) >= _level(c) - 6.0 for o in ordered):
            row["note"] = "a neighbour of similar level still sounds here: the onset cannot be told apart"
        elif anchor == "start" and half >= 0.03:
            # a sound anchored on its start is judged by its first onset: it has to begin on the moment
            lo = max(0, int((c["t"] - min(0.05, half)) * rate))
            hi = min(len(samples), int((c["t"] + min(0.15, half)) * rate))
            seg_ = samples[lo:hi]
            pk_ = max((abs(v) for v in seg_), default=0)
            if pk_ >= 100:
                w2 = max(1, rate // 500)                 # 2 ms windows
                step = max(1, w2 // 2)
                env_ = [max(abs(v) for v in seg_[i:i + w2]) for i in range(0, len(seg_) - w2, step)]
                if len(env_) >= 4:
                    db_ = [20 * math.log10(max(e, 1) / 32768.0) for e in env_]
                    top_ = max(db_)
                    best_i, best_rise = None, 6.0       # the FIRST rise of at least 6 dB that is not just noise
                    for i in range(2, len(db_)):            # (a two-note sound is on its moment by its first note)
                        rise = db_[i] - min(db_[i - 1], db_[i - 2])
                        if db_[i] >= top_ - 20.0 and rise > best_rise:
                            best_i, best_rise = i, rise
                            break
                    if best_i is not None:
                        off = ((lo + best_i * step) / rate - c["t"]) * 1000
                        row.update(judged=True, off_ms=round(off), ok=-12.0 <= off <= 30.0, tol_ms=30.0,
                                   note="onset")
        # presence: whatever happens to the rest, the sound must be audible where it was placed. Three seconds are
        # looked at: a bed or a riser fades in, its first 300 ms may sit under -60 dBFS and is not "lost"
        if "start" in c and "seg" in c:
            i0 = max(0, int(c["start"] * rate))
            i1 = min(len(samples), int((c["start"] + min(c["seg"], 3.0)) * rate))
            seg_peak = max((abs(v) for v in samples[i0:i1]), default=0)
            row["present"] = seg_peak >= 30                     # about -60 dBFS
            if not row["present"]:                              # silent in the mono sum: is it in the channels?
                if sides is None:
                    from common import stereo_samples
                    sides = stereo_samples(track, rate)
                lft_, rgt_ = sides
                j1_ = min(len(lft_), i1)
                if max(max((abs(v) for v in lft_[i0:j1_]), default=0),
                       max((abs(v) for v in rgt_[i0:j1_]), default=0)) >= 30:
                    row["present"] = True
                    row["note"] = "present only as the difference of the channels: it cancels in mono"
            if not row["present"]:
                row.update(judged=True, ok=False, off_ms=None, note="MISSING from the track (the render lost it)")
        out.append(row)
    peak = max(max(samples), -min(samples)) / 32768 if len(samples) else 0
    return out, (20 * math.log10(peak) if peak else -120.0), peak


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cues")
    ap.add_argument("track")
    ap.add_argument("--tol-ms", type=float, default=40)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--all", action="store_true", help="also list the cues that could not be judged")
    a = ap.parse_args()

    sheet = load_json(a.cues)
    cues = sheet["cues"]
    # a raw (unresolved) cue sheet has no roles: fall back to the library index
    cfg = load_config()
    idx = index_path(cfg)
    by_path = {}
    if idx.exists():
        by_path = {s["path"]: s["role"] for s in json.loads(idx.read_text(encoding="utf-8"))["sounds"]}
    for c in cues:
        if not c.get("role"):
            c["role"] = "ui" if "uisfx" in c else by_path.get(c.get("file", ""), "default")

    ev_track = events_track(sheet, a.track)          # without the bed when the film has one
    rows, peak_db, peak = offsets(cues, ev_track, a.tol_ms)
    if ev_track != a.track:                          # clipping belongs to the whole track, the bed included
        full_, rate_ = decode_mono(a.track, 16000)
        pk_ = max(max(full_), -min(full_)) / 32768 if len(full_) else 0
        peak_db, peak = (20 * math.log10(pk_) if pk_ else -120.0), pk_
    bad = sum(1 for r in rows if r["judged"] and not r["ok"])
    mono_ = None
    try:                                         # a mono playback (a phone speaker): does anything cancel?
        from common import fold_cues
        fr_, fc_ = fold_cues(a.track, [c for c in cues if not c.get("_layer") and not c.get("bed")])
        if fr_.get("loss_db") is not None:
            mono_ = {"loss_db": round(fr_["loss_db"], 1),
                     "bad": [{"t": c["t"], "label": c.get("label", ""), "loss_db": round(l_, 1)}
                             for c, l_, v_ in fc_ if l_ is not None and l_ > 6.0 and v_ > -45.0]}
    except Exception:
        mono_ = None
    if a.json:
        print(json.dumps({"rows": rows, "peak_db": peak_db, "bad": bad, "mono": mono_}, indent=1))
    else:
        why = {}
        for r in rows:
            if r.get("present") is False:
                print(f"{r['n']:2d} t={r['t']:7.3f}  {r['label'][:24]:24s} MISSING from the track (the render lost it)")
            elif not r["judged"]:
                note = r.get("note") or f"anchor={r['anchor']}: its peak is not on the moment by design"
                key = ("a louder or similar neighbour sounds there" if ("neighbour" in note or "masked" in note)
                       else "crowded (a neighbour closer than 80 ms)" if "crowded" in note
                       else "no clear onset to measure" if r["anchor"] == "start"
                       else "the peak is not the moment by design (end / long layer)")
                why[key] = why.get(key, 0) + 1
                if a.all:
                    print(f"{r['n']:2d} t={r['t']:7.3f}  {r['label'][:24]:24s} not judged ({key})")
            else:
                if a.all or not r["ok"]:
                    kind = {"onset": "onset", "arrival": "arrival"}.get(r.get("note"), "loudest")
                    print(f"{r['n']:2d} t={r['t']:7.3f}  {r['label'][:24]:24s} {kind} {r['off_ms']:+5d} ms  "
                          f"{'ok' if r['ok'] else 'OFF'}")
        judged_ = [r for r in rows if r["judged"]]
        missing_ = [r for r in rows if r.get("present") is False]
        print(f"{len(rows)} cues: {len(rows) - len(missing_)} present, {len(judged_)} judged "
              f"({sum(1 for r in judged_ if not r['ok'])} off), {len(rows) - len(judged_)} not judged"
              + (": " + "; ".join(f"{v} {k}" for k, v in why.items()) if why else ""))
        print(f"track peak {peak_db:.1f} dBFS (16 kHz view)" + ("  CLIPPING" if peak >= 0.999 else "")
              + ("  (sounds judged on the track without the bed)" if ev_track != a.track else ""))
        if mono_ is not None:
            print(f"mono: the SFX track loses {mono_['loss_db']:.1f} dB when folded to mono (0 = the channels agree, "
                  f"3 = unrelated, 6+ = parts cancel)" +
                  ("" if not mono_["bad"] else f"; {len(mono_['bad'])} sound(s) lose more than 6 dB: " +
                   ", ".join(f"{b_['t']:.2f}s {b_['label'][:20]} ({b_['loss_db']:.0f} dB)" for b_ in mono_["bad"][:3])))
        try:                                    # a short film is often a loop: its seam must be quiet
            sm_, rt_ = decode_mono(a.track, 16000)
            if rt_ and len(sm_) / rt_ <= 15.0 and len(sm_) > rt_ // 2:
                db_ = lambda v_: 20 * math.log10(v_ / 32768.0) if v_ > 1 else -120.0
                head_ = db_(max(abs(v) for v in sm_[:max(1, int(0.02 * rt_))]))
                tail_ = db_(max(abs(v) for v in sm_[-max(1, int(0.05 * rt_)):]))
                print(f"loop seam: the track starts at {head_:.0f} dBFS and ends at {tail_:.0f} dBFS "
                      + ("(clean: it loops without a click or a cut tail)" if head_ < -45 and tail_ < -50 else
                         "(sound at the seam: if this is a loop it will click or cut a tail; a tail must end before "
                         "the last frame, a start must not begin on a peak)"))
        except Exception:
            pass
    sys.exit(1 if bad or peak >= 0.999 else 0)


if __name__ == "__main__":
    main()
