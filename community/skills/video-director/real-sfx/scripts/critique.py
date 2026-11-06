#!/usr/bin/env python3
"""Scoreboard for a finished sound design: objective axes 1..10, three worst problems with timecodes.

  python critique.py result/film_sfx_resolved_cues.json result/film_sfx_sfx_track.wav
         [--moments work/moments/moments.json] [--rounds 1] [--out result/critique.md]

The same discipline as the video self-critique loop: look at the numbers AND at review.png, list the
three worst problems with timecodes, fix only those, re-render only what changed, repeat until every
axis is >= 8. This script covers the axes that can be measured. Three axes need your eyes on
review.png and are listed at the end: character fit (does each sound suit its picture), cleanliness
(masking, mud in the low end under music or voice) and taste (does it feel designed or sprayed on).
"""
import argparse
import json
import math
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import ROLE_TARGET_PEAK_DB, events_track, gesture_times, load_json, measure_loudness
from verify import offsets

PASS = 8.0


def clamp(v, lo=1.0, hi=10.0):
    return max(lo, min(hi, v))


def lead_level(video, seconds=2.0):
    """Mean level (dB) of the first seconds of the original audio, or None when there is none."""
    import re
    import subprocess
    if not video or not Path(video).exists():
        return None
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-t", f"{seconds}", "-i", str(video), "-vn",
                        "-af", "volumedetect", "-f", "null", "-"], capture_output=True, text=True, errors="replace")
    m = re.search(r"mean_volume:\s*(-?[\d.]+) dB", r.stderr)
    return float(m.group(1)) if m else None


def is_key_cue(c):
    """A keystroke: a cue of the keyboard (labelled key..., a piece of a typing recording, or role typing)."""
    return str(c.get("label", "")).lower().startswith("key") or "typing" in str(c.get("file", "")).lower() \
        or c.get("role") == "typing"


def collapse_runs(cues, gap=0.25, key_gap=0.7):
    """A run of the same kind of sound closer than `gap` (typing, a row of ticks) is one event for pacing. The
    keystrokes of a person typing live (2-4 a second, gaps of 0.3-0.6 s) are one run at `key_gap`."""
    ev, last = [], None
    is_key = is_key_cue

    def tail(c):                       # a long layer (a scroll wheel, a bed) fills the film until it ends
        sg = c.get("seg") or 0.0
        return min(6.0, sg) if sg >= 1.0 else 0.0

    cs = sorted(cues, key=lambda c: c["t"])
    for i, c in enumerate(cs):
        g_ = key_gap if (last is not None and is_key(c) and is_key(last)) else gap
        # a cue that HEADS a run of its own kind (the first key of a row of typing) is not a layer of the sound a few
        # ms before it: merged there, the whole row would be counted as that sound's, and every pair of keys
        # would be called a smear
        nxt = cs[i + 1] if i + 1 < len(cs) else None
        heads_run = nxt is not None and nxt["role"] == c["role"] and \
            nxt["t"] - c["t"] <= (key_gap if (is_key(c) and is_key(nxt)) else gap)
        if last is not None and c["role"] == last["role"] and c["t"] - last["t"] <= g_ and ev[-1]["role"] == c["role"]:
            ev[-1]["n"] += 1
            ev[-1]["end"] = max(ev[-1]["end"], c["t"] + tail(c))
        elif last is not None and c["t"] - last["t"] <= 0.08 and not heads_run:
            # the layers of ONE moment (a hit, its pop and a puff of dust): the ear counts one event
            ev[-1]["end"] = max(ev[-1]["end"], c["t"] + tail(c))
            ev[-1]["layers"] = ev[-1].get("layers", 1) + 1
        else:
            # a texture sound (texture.py: a small drop on a small move) is light, like a tick, for the pace
            ev.append({"t": c["t"], "end": c["t"] + tail(c), "n": 1, "role": c["role"],
                       "short": c.get("seg", 1.0) < 0.15, "texture": bool(c.get("texture"))})
        last = c
    return ev


def fmt(t):
    return f"{int(t // 60)}:{t % 60:05.2f}" if t >= 60 else f"{t:.2f}s"


def typed_row(r):
    return r.get("role") == "typing" or str(r.get("label", "")).lower().startswith("key")


def rows_as_events(rs, run_gap=0.7):
    """Verify rows as the ear counts them: a row of keystrokes (`run_gap` s apart at most) is ONE thing to judge, not
    185. (The sync axis stays n/a when too few of the rows could be measured; 185 keys must not hide 126 sounds.)"""
    keys = sorted(r["t"] for r in rs if typed_row(r))
    runs_ = sum(1 for i, t_ in enumerate(keys) if i == 0 or t_ - keys[i - 1] > run_gap)
    return sum(1 for r in rs if not typed_row(r)) + runs_


def listen_list(cues, sync_rows=(), match_rows=(), speech_groups=(), mono_bad=(), n=5, apart=1.5, first=None, masked=()):
    """The moments where the numbers are least certain: [(score, t, label, why, ask)], at most n, `apart` seconds
    apart, in time order. A script cannot hear. This is what a person listens to on headphones and then once on a phone
    speaker, built from the measurements of this very render (not a fixed set of timestamps). Different KINDS of risk
    come first (the worst of each kind), then the worst ones again; two reasons at one moment share one entry."""
    cand = []

    def add(cat, score, t, label, why, ask):
        cand.append({"cat": cat, "score": float(score), "t": float(t), "label": str(label or ""), "why": why,
                     "ask": ask})

    ordered = sorted(cues, key=lambda c: c["t"])
    if not ordered:
        return []
    c0 = first or ordered[0]            # `first`: the earliest AUDIBLE sound, a layer that leads its parent included
    add("hook", 5.0, c0["t"], c0.get("label"), "the first sound of the film: the hook",
        "does it land with the picture at once, and is it clearly there under the music or the voice?")
    peaked = [c for c in ordered if c.get("peak_after_db") is not None]
    if peaked:
        top = max(peaked, key=lambda c: c["peak_after_db"])
        add("loud", 4.5, top["t"], top.get("label"), f"the highest peak of the film ({top['peak_after_db']:+.0f} dBFS "
            f"before the master)", "is it big without hurting on headphones, and does the music under it pump?")
    for r in sync_rows:
        if r.get("judged") and not r.get("ok") and r.get("off_ms") is not None:
            add("sync", 8.0 + min(2.0, abs(r["off_ms"]) / 100.0), r["t"], r.get("label"),
                f"its {'arrival' if r.get('note') == 'arrival' else 'peak'} sits {r['off_ms']:+d} ms from the moment",
                "does it feel early or late against the picture?")
    for r in match_rows:
        if abs(r["e"]) > 6.0:
            add("match", 6.0 + min(3.0, abs(r["e"]) / 4.0), r["t0"], r.get("kind"),
                f"{abs(r['e']):.0f} dB {'quieter' if r['e'] > 0 else 'louder'} than the author's own sound it replaces",
                "is it still the right size for what happens on the picture?")
    for gr in speech_groups:
        m = max(gr, key=lambda m_: m_["over_db"])
        add("speech", 6.0 + min(3.0, m["over_db"] / 3.0), gr[0]["t"], m.get("label"),
            f"{len(gr)} sound(s) on top of the voice, {m['over_db']:+.1f} dB against it", "is every word still understood?")
    for c, loss, _lvl in mono_bad:
        add("mono", 7.0 + min(2.0, (loss - 6.0) / 3.0), c["t"], c.get("label"), f"loses {loss:.0f} dB when folded to mono",
            "play it from one speaker: is it still there?")
    for r in masked:                    # the masking model (maskmodel.py): a sound under the threshold of the rest
        by = r.get("by") or "the rest of the mix"
        extra = (f"; {r['margin_wo_bed_db']:+.0f} dB without it" if by == "bed" and r.get("margin_wo_bed_db") is not None
                 else "")
        add("masked", 6.5 + min(2.5, abs(min(0.0, r["margin_db"])) / 6.0), r["t"], r.get("label"),
            f"the masking model puts it {abs(r['margin_db']):.0f} dB under the threshold set by {by}{extra}",
            "can you hear it at all?")
    tonal = [c for c in ordered if c.get("tonal") and c.get("pitch")]
    if tonal:
        c = max(tonal, key=lambda c_: abs(c_.get("pitch") or 0))
        add("tonal", 5.0, c["t"], c.get("label"), f"retuned {c['pitch']:+g} st to the note {c['tonal']} of the score "
            f"under it", "does it sit in the key of the music, or does it clash?")
    adj = [c for c in ordered if abs(c.get("level_adj_db") or 0) >= 4.0]
    if adj:
        c = max(adj, key=lambda c_: abs(c_["level_adj_db"]))
        up_ = c["level_adj_db"] > 0
        add("level", 4.0 + min(2.0, abs(c["level_adj_db"]) / 4.0), c["t"], c.get("label"),
            f"brought {abs(c['level_adj_db']):.0f} dB {'up' if up_ else 'down'} to the perceived level of its role",
            "a thin recording lifted that far can turn harsh: is it clean?" if up_ else
            "a sound brought down that far can get lost: does it still carry its moment?")
    lifted = [c for c in ordered if (c.get("gain_applied_db") or 0) >= 14.0 and c.get("role") not in ("click", "typing")]
    if lifted:
        c = max(lifted, key=lambda c_: c_["gain_applied_db"])
        add("lift", 4.0 + min(2.0, (c["gain_applied_db"] - 14.0) / 4.0), c["t"], c.get("label"),
            f"a quiet recording lifted by {c['gain_applied_db']:.0f} dB", "does its noise floor come up with it (hiss)?")
    held = [c for c in ordered if (c.get("capped_db") or 0) >= 3.0]
    if held:
        c = max(held, key=lambda c_: c_["capped_db"])
        add("held", 4.0, c["t"], c.get("label"), f"sits {c['capped_db']:.0f} dB under its plan (a very quiet recording "
            f"lifted to the +18 dB cap)", "is it big enough for its picture?")
    moved = [c for c in ordered if abs(c.get("onset_shift_ms") or 0) >= 60]
    if moved:
        c = max(moved, key=lambda c_: abs(c_["onset_shift_ms"]))
        add("shift", 4.5, c["t"], c.get("label"), f"its attack was moved {abs(c['onset_shift_ms']):.0f} ms so that it "
            f"lands on the moment", "does the lead-in still read as part of the sound?")
    pitched = [c for c in ordered if abs(c.get("pitch") or 0) >= 4 and not c.get("tonal")]
    if pitched:
        c = max(pitched, key=lambda c_: abs(c_["pitch"]))
        add("pitch", 3.5, c["t"], c.get("label"), f"pitched {c['pitch']:+g} st (its character changes)",
            "is it still the same kind of sound?")
    snapped = [c for c in ordered if abs(c.get("snapped_ms") or 0) >= 30]
    if snapped:
        c = max(snapped, key=lambda c_: abs(c_["snapped_ms"]))
        add("snap", 3.0, c["t"], c.get("label"), f"moved {abs(c['snapped_ms']):.0f} ms to the beat",
            "does it feel on the beat, or pulled off the picture?")
    # fillers: where it is busiest, and the quietest sound that is not a tick
    ts = [c["t"] for c in ordered]
    best_n, best_i = 0, 0
    for i, t in enumerate(ts):
        k = sum(1 for u in ts if t <= u < t + 2.0)
        if k > best_n:
            best_n, best_i = k, i
    if best_n >= 4:
        add("busy", 2.5, ts[best_i] + 0.5, "", f"the busiest two seconds ({best_n} sounds)",
            "is every sound still distinct, or does it turn to mud?")
    quiet = [c for c in ordered if c.get("role") not in ("click", "ui", "data", "typing", "ambience", "vehicle")
             and c.get("loud_after_db") is not None]
    if quiet:
        c = min(quiet, key=lambda c_: c_["loud_after_db"])
        add("quiet", 2.0, c["t"], c.get("label"), "the quietest by perceived loudness among the sounds that are not "
            "ticks", "can it be heard at all?")

    cand.sort(key=lambda x: -x["score"])
    chosen = []                                   # {"t", "label", "score", "why": [...], "ask": [...], "cats": {...}}
    placed = set()

    def place(item):
        for ch in chosen:
            if abs(ch["t"] - item["t"]) < apart:       # the same moment: one entry, both reasons
                if item["cat"] not in ch["cats"] and len(ch["why"]) < 2:
                    # the second reason may belong to ANOTHER sound a second away: it says which, and when
                    same = item["label"] == ch["label"] and abs(item["t"] - ch["t"]) < 0.05
                    ch["why"].append(item["why"] if same else
                                     f"also '{item['label'][:24]}' at {fmt(item['t'])}: {item['why']}")
                    ch["ask"].append(item["ask"])
                ch["cats"].add(item["cat"])
                return True
        if len(chosen) >= n:
            return False
        chosen.append({"t": item["t"], "label": item["label"], "score": item["score"], "why": [item["why"]],
                       "ask": [item["ask"]], "cats": {item["cat"]}})
        return True

    seen = set()
    for item in cand:                              # the worst of every kind first
        if item["cat"] in seen:
            continue
        seen.add(item["cat"])
        if place(item):
            placed.add(id(item))
    per = {}
    for ch in chosen:
        for ccat in ch["cats"]:
            per[ccat] = per.get(ccat, 0) + 1
    for item in cand:                              # then more of the worst kinds (at most 3 of a kind that is certain)
        if id(item) in placed:
            continue
        cap = 3 if item["cat"] in ("sync", "mono", "speech") else 2
        if per.get(item["cat"], 0) >= cap:
            continue
        if place(item):
            per[item["cat"]] = per.get(item["cat"], 0) + 1
    out = []
    for ch in sorted(chosen, key=lambda x: x["t"]):
        out.append((ch["score"], ch["t"], ch["label"], "; ".join(ch["why"]), " / ".join(ch["ask"])))
    return out


def cut_listen(src, items, out, pre=1.0, post=2.0, dur=None):
    """The listen-list moments, one after the other (3 s each and a pause) in one wav of the film's own sound."""
    import subprocess
    parts, labels = [], []
    for i, it in enumerate(items):
        s = max(0.0, it[1] - pre)
        if dur:
            s = max(0.0, min(s, dur - (pre + post)))          # a moment near the end: the window slides back
        parts.append(f"[0:a]atrim=start={s:.3f}:end={s + pre + post:.3f},asetpts=PTS-STARTPTS,apad=pad_dur=0.4[a{i}]")
        labels.append(f"[a{i}]")
    fc = ";".join(parts) + ";" + "".join(labels) + f"concat=n={len(items)}:v=0:a=1[o]"
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-nostdin", "-i", str(src), "-filter_complex", fc, "-map", "[o]",
                        "-c:a", "pcm_s16le", str(out)], capture_output=True, text=True, errors="replace")
    return r.returncode == 0


def style_block(name, sheet, track, final_lufs, keep):
    """This film's SFX layer set against a reference style: (rows, text lines). Numbers, no scores, no verdict."""
    try:
        import refstyle
    except Exception as ex:
        return [], [f"Reference style '{name}': not available ({ex})"]
    style, _ = refstyle.find_style(name)
    if style is None:
        return [], [f"Reference style '{name}' not found (styles/{name}.json or references/profiles/{name}.json)."]
    if not style.get("measures"):
        return [], [f"Reference style '{name}' carries no measures (learned before they existed): run learn_style.py "
                    f"on the same references again."]
    src = sheet.get("sfx_track_in_mix_level")                 # the SFX layer as it sounds in the film (mastered gain)
    if not src or not Path(src).exists():
        src = track
    try:
        m = refstyle.measure(src, lufs=final_lufs, with_lufs=final_lufs is not None)
    except Exception as ex:
        return [], [f"Reference style '{name}': the track could not be measured ({ex})"]
    rows = refstyle.compare(m, style)
    note = style.get("note") or ""
    if keep:
        note = ("This film keeps its own audio: only its SFX layer was measured (at its level in the film); the "
                "references are SFX-led, so read the density and the gaps as a statement about that layer. " + note)
    return rows, (refstyle.render(rows, style, note.strip() or None) or
                  [f"Reference style '{name}': nothing comparable was measured."])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cues")
    ap.add_argument("track")
    ap.add_argument("--moments")
    ap.add_argument("--rounds", type=int, default=1, help="how many rounds of fixes were already made")
    ap.add_argument("--voice", action="store_true",
                    help="the original audio is a voice-over: add the speech-masking axis (also on when mixed with --voice-safe)")
    ap.add_argument("--out")
    ap.add_argument("--append", action="store_true",
                    help="add this round to the end of --out instead of replacing it (the history of the loop)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--list", action="store_true", help="list every moment of the speech axis, not only the 3 worst")
    ap.add_argument("--listen-out", metavar="WAV",
                    help="cut the five listen-list moments (3 s each, the film's own sound) into one wav")
    ap.add_argument("--style", metavar="NAME",
                    help="set the film against a reference style (`clean-sfx-refs` ships: nine finished SFX reels, or "
                         "one learned with learn_style.py): a table of numbers at the end, no scores, no effect on "
                         "the verdict")
    a = ap.parse_args()

    sheet = load_json(a.cues)
    cues = [c for c in sheet["cues"]]
    orig_src = sheet.get("original_audio") or sheet.get("video")      # the original audio that is really in the mix
    # a bed (bed.py) is the floor under the film, not an event: it is no gesture, no variety, no hierarchy, no hook
    main_cues = [c for c in cues if not c.get("_layer") and not c.get("bed")]
    dur = sheet.get("duration") or max(c["t"] for c in cues) + 1
    loud = sheet.get("loudness", {})
    keep = bool(sheet.get("keep_audio"))
    rows, peak_db, peak = offsets(cues, events_track(sheet, a.track))     # without the bed when the film has one

    axes, notes, problems = {}, {}, []   # problems: (severity 0..10, text)

    # 1. hook ------------------------------------------------------------------------------
    # the first AUDIBLE sound: a layer may lead its parent (a reverse swoosh 0.7 s before the hit). A long bed
    # (ambience, vehicle) given as a layer is not a hook.
    audible = [c for c in cues if not c.get("bed")
               and not (c.get("_layer") and c.get("role") in ("ambience", "vehicle"))]
    first_cue = min(audible, key=lambda c: c["t"], default=None)
    t0 = first_cue["t"] if first_cue else None
    first_ev = (sheet.get("_draft") or {}).get("first_event_t")
    if t0 is not None and first_ev is not None and first_ev > 0.6 and t0 <= first_ev + 0.35:
        axes["hook"] = 10.0                # nothing happens on the picture before: the sound opens with the picture
        notes["hook"] = (f"first sound at {fmt(t0)}; the first event of the project's list is at {fmt(first_ev)} "
                         f"(nothing is declared earlier, so nothing earlier needs a sound)")
    elif dur < 3 or t0 is None:
        axes["hook"], notes["hook"] = 10.0, "video too short for a hook rule"
    else:
        axes["hook"] = 10.0 if t0 <= 0.6 else 9.0 if t0 <= 1.2 else 7.0 if t0 <= 2.0 else 4.0 if t0 <= 3.0 else 2.0
        notes["hook"] = f"first sound at {fmt(t0)}"
        lead = lead_level(orig_src, 2.0) if keep else None
        if axes["hook"] < PASS and lead is not None and lead > -40.0:
            axes["hook"] = 9.0                                     # music or voice already opens the film
            notes["hook"] = (f"the original audio carries the first 2 s ({lead:.0f} dB mean); "
                             f"first added sound at {fmt(t0)}")
        if axes["hook"] < PASS:
            problems.append((10 - axes["hook"], f"hook: the first sound comes at {fmt(t0)}, the first 2 s are quiet"))

    # 2. sync ------------------------------------------------------------------------------
    judged = [r for r in rows if r["judged"] and r.get("present") is not False]
    n_main_rows = max(1, rows_as_events([r for r in rows if not r.get("layer")]))
    if judged and rows_as_events(judged) < max(3, 0.3 * n_main_rows):
        notes["sync"] = (f"not judged enough: {rows_as_events(judged)} of {n_main_rows} sounds (a row of keystrokes "
                         f"counts once) could be measured (clusters, neighbours, long layers); check the frames with "
                         f"zoom.py")
        judged = []
    if judged:
        ok = sum(1 for r in judged if r["ok"])
        axes["sync"] = clamp(1 + 9 * ok / len(judged))
        notes["sync"] = f"{ok}/{len(judged)} sounds on their frame (peaks, arrivals, or first onsets for clicks)"
        for r in judged:
            if not r["ok"]:
                problems.append((min(10, 4 + abs(r["off_ms"]) / 25),
                                 f"sync: '{r['label']}' at {fmt(r['t'])} "
                                 f"{'arrives' if r.get('note') == 'arrival' else 'peaks'} {r['off_ms']:+d} ms from the moment"))
    else:
        notes["sync"] = ("not judged: no peak-anchored cue could be measured (clicks only, layers on one moment, "
                         "a crowded neighbour). Check the frames with zoom.py")

    dr0 = sheet.get("_draft") or {}
    if "sync" not in axes and (dr0.get("sync") or {}).get("verdict") == "ok":
        notes["sync"] = notes.get("sync", "") + (f"; at import {dr0['sync'].get('within_tol', 0):.0%} of the list's "
                                                 f"wipes and hits sat on a picture change (the list belongs to this render)")
    lost = [r for r in rows if r.get("present") is False]
    if lost:
        axes["sync"] = min(axes.get("sync", 10.0), clamp(10 - 3.0 * len(lost)))
        notes["sync"] = notes.get("sync", "") + f"; {len(lost)} cue(s) missing from the track"
        for r in lost[:3]:
            problems.append((10, f"render: '{r['label']}' at {fmt(r['t'])} is missing from the SFX track "
                                 f"(lost in the render): run mix.py again, report it if it repeats"))

    # 3. coverage --------------------------------------------------------------------------
    if a.moments:
        if not Path(a.moments).is_file():
            sys.exit(f"--moments: {a.moments} not found. It is the moments.json that find_moments.py or "
                     f"from_hyperframes.py wrote (leave --moments out when the cues came from a project's own list)")
        moms = load_json(a.moments)["moments"]
        quiet = sheet.get("quiet") or []
        in_quiet = lambda t: any(q[0] <= t <= q[1] for q in quiet)
        strong = [m for m in moms if not in_quiet(m["t"]) and m["kind"] != "settle"
                  and ((m["kind"] == "cut" and m.get("pct", m["strength"]) >= 0.5)
                       or (m["kind"] != "cut" and m["strength"] >= 0.7))]
        miss = [m for m in strong if not any(abs(c["t"] - m["t"]) <= 0.18 for c in main_cues)]
        if strong:
            cov = 1 - len(miss) / len(strong)
            axes["coverage"] = clamp(1 + 9 * min(1.0, cov / 0.8))      # 80 % of the strong moments is enough
            notes["coverage"] = f"{len(strong) - len(miss)}/{len(strong)} strong picture moments carry a sound"
            if axes["coverage"] < PASS:
                for m in miss[:3]:
                    problems.append((6 + 3 * m["strength"], f"coverage: strong {m['kind']} at {fmt(m['t'])} "
                                     f"({m['strength']:.2f}) has no sound"))
        else:
            axes["coverage"], notes["coverage"] = 10.0, "no strong picture moments"
    else:
        notes["coverage"] = "not measured (pass --moments)"

    # 4. pacing ----------------------------------------------------------------------------
    dr = sheet.get("_draft") or {}
    if dr.get("declared"):
        silent_n = sum((dr.get("unmapped") or {}).values())
        if silent_n >= 5 or silent_n >= 0.2 * dr["declared"]:
            share = silent_n / max(1, dr["declared"])
            cov2 = clamp(10 - 12 * share)
            axes["coverage"] = min(axes.get("coverage", 10.0), cov2)
            notes["coverage"] = (notes.get("coverage", "") + "; " if a.moments else "") + \
                f"{silent_n} of {dr['declared']} declared events are silent (kinds with no mapping)"
            names_ = ", ".join(f"{k} x{v}" for k, v in list((dr.get("unmapped") or {}).items())[:4])
            problems.append((6 + 4 * share, f"coverage: {silent_n} of {dr['declared']} events of the project's list "
                             f"have no sound ({names_}): map them with from_cues.py --kind NAME=KIND and rebuild"))
        elif not a.moments:
            notes["coverage"] = (f"{len([c for c in main_cues])} cues for {dr['declared']} declared events (the list is "
                                 f"the reference; runs and clusters are thinned on purpose)")
    typed = bool(dr.get("source"))

    events = collapse_runs(main_cues)
    runs = [e for e in events if e["n"] >= 3]
    # interface ticks are light texture: half a "sound" each when counting how busy the film is
    per10 = sum(0.5 if e["role"] in ("click", "ui", "data") or e.get("short") or e.get("texture") else 1.0
                for e in events) / max(dur, 10.0) * 10
    n_tex = sum(1 for c in main_cues if c.get("texture"))
    times = sorted(e["t"] for e in events)
    ends = {e["t"]: e["end"] for e in events}
    gaps = [b - ends.get(a_, a_) for a_, b in zip([0.0] + times, times + [dur])]
    longest = max(gaps)
    g_i = gaps.index(longest)
    g_start = ([0.0] + times)[g_i]
    occupied_by_original = False
    if keep and orig_src:
        try:
            import masking as _mk
            env_o = _mk.full_env(orig_src, 0.1)
            if env_o and sum(1 for v in env_o if v < -55.0) / len(env_o) >= 0.4:     # mostly silent original
                step = 0.1
                busy = [v > -45.0 for v in env_o]
                for e in events:
                    for i in range(int(e["t"] / step), min(len(busy), int((max(e["end"], e["t"] + 0.3)) / step) + 1)):
                        busy[i] = True
                best_run, run, best_start = 0, 0, 0
                for i, b_ in enumerate(busy + [True]):
                    if not b_:
                        run += 1
                    else:
                        if run > best_run:
                            best_run, best_start = run, i - run
                        run = 0
                longest, g_start = best_run * step, best_start * step
                occupied_by_original = True
        except Exception:
            pass
    # How busy is "too busy"? A film that keeps its own music or voice: 9 weighted events per 10 s (the SFX are a part
    # of it). A film whose sound is ONLY the SFX is judged by the one number the reference reels are measured by,
    # gestures per 10 s (sounds with no pause of 0.25 s in them, layers and keystrokes included, no weights): the nine
    # references run 6.9-15.1, and a film 10 % over the busiest of them is busy.
    g10, gmax = None, None
    if not keep:
        gest_t = gesture_times(cues)
        g10 = len(gest_t) / max(dur, 1.0) * 10
        try:
            import refstyle
            st_ = refstyle.find_style("clean-sfx-refs")[0]
            gmax = (((st_ or {}).get("measures") or {}).get("gest10") or {}).get("max")
        except Exception:
            gmax = None
    gest_ruler = g10 is not None and gmax is not None
    if per10 < 3:
        score = 10 - 2.0 * (3 - per10)
    elif gest_ruler:
        score = 10.0 if g10 <= 1.1 * gmax else 10 - 0.4 * (g10 - 1.1 * gmax)
    else:
        score = 10.0 if per10 <= 9 else 10 - (0.4 if typed else 1.2) * (per10 - 9)
    if longest > 5:
        score -= min(4.0, 0.7 * (longest - 5))
    axes["pacing"] = clamp(score)
    notes["pacing"] = (f"{per10:.1f} weighted events per 10 s, longest silence {longest:.1f} s"
                       f"{' (the original audio fills the gaps it has sounds in)' if occupied_by_original else ''}" +
                       (f"; {g10:.1f} gestures per 10 s (the references run up to {gmax:g}; this film has no sound of "
                        f"its own, so too busy is judged by that number)" if gest_ruler else "") +
                       (f"; {len(runs)} runs of typing/ticks count once ({sum(e['n'] for e in runs)} sounds)"
                        if runs else "") +
                       (f"; {n_tex} texture sounds (texture.py) count at half weight" if n_tex else ""))
    if longest > 5 and axes["pacing"] < PASS:
        problems.append((5 + min(4, longest - 5), f"pacing: nothing happens between {fmt(g_start)} and {fmt(g_start + longest)}"
                         f" ({longest:.1f} s)"))
    if gest_ruler and g10 > 1.1 * gmax:
        problems.append((5 + min(4, (g10 - 1.1 * gmax) / 2), f"pacing: {g10:.1f} gestures per 10 s is busier than the "
                         f"busiest reference ({gmax:g}); drop the weakest"))
    elif not gest_ruler and per10 > 9 and not typed:
        problems.append((5 + min(4, per10 - 9), f"pacing: {per10:.1f} sounds per 10 s is too busy; drop the weakest"))
    run_ts = {round(c["t"], 3) for e in runs for c in main_cues
              if e["t"] <= c["t"] <= e["end"] and c["role"] == e["role"]}
    def gesture(x, y):                  # press + select, press + notification: the author's pair, a different file each
        return x.get("source") == "uisfx" and y.get("source") == "uisfx" and x.get("file") != y.get("file") \
            and y["t"] - x["t"] >= 0.02

    # two keys 70-100 ms apart are typing (8-14 a second), never a smear, even when another sound (a paper rustle)
    # sits inside the row and cuts it into short events
    close = [(x, y) for x, y in zip(main_cues, main_cues[1:]) if 0 < y["t"] - x["t"] < 0.12 and x["role"] == y["role"]
             and round(x["t"], 3) not in run_ts and not gesture(x, y) and not (is_key_cue(x) and is_key_cue(y))]
    for x, y in close[:2]:
        problems.append((5, f"pacing: two {x['role']} sounds {1000 * (y['t'] - x['t']):.0f} ms apart at {fmt(x['t'])} smear"))
        axes["pacing"] = clamp(axes["pacing"] - 1)

    if dr.get("screen_rec"):
        axes.pop("pacing", None)
        problems[:] = [p_ for p_ in problems if not (p_[1].startswith("pacing: nothing happens")
                                                     or "is too busy" in p_[1])]
        notes["pacing"] = (f"not judged for a screen recording: its pace is the person's work, silence where the "
                           f"picture is still is right ({per10:.1f} weighted events per 10 s, longest silence "
                           f"{longest:.1f} s)")

    # 5. variety ---------------------------------------------------------------------------
    # The ear counts SOURCE recordings: a pitch-shifted copy is another take, a slice of the same recording is not.
    # Interface sounds (uisfx, ui/data roles) are one language and repeat on purpose; a run of typing or ticks is one
    # event. Everything else is judged. Nothing left to judge means "not judged", never a free 10.
    judged_v = [c for c in main_cues if c["role"] not in ("ui", "data") and c.get("source") != "uisfx"
                and round(c["t"], 3) not in run_ts and not c.get("same_source")]
    # a sorted pack hands out one file per hit of a recording ('h01', 'h02' ...): the index knows the source
    # recording of such a file, and the ear counts that one
    try:
        from picker import load_index
        by_path = {s["path"]: s for s in load_index()}
    except (SystemExit, Exception):
        by_path = {}

    def rec_of(c):
        return by_path.get(c.get("slice_of") or c["file"])

    def srcf(c):
        r = rec_of(c)
        if r and r.get("source"):
            return f"{r['library']}:{r['source']}"
        return c.get("slice_of") or c["file"]

    files = [f"{srcf(c)}|{0 if (c.get('slice_of') or c.get('slice')) else round(c.get('pitch', 0) or 0)}" for c in judged_v]
    distinct = len(set(files))
    ratio = distinct / max(1, len(files))
    repeats = sum(1 for x, y in zip(files, files[1:]) if x == y)
    heavy = {f.split("|")[0]: files.count(f) for f in set(files) if files.count(f) >= 3}
    from common import family_key
    fams = [family_key(rec_of(c)["name"]) if rec_of(c) and rec_of(c).get("source") else
            family_key(Path(f.split("|")[0]).stem) for c, f in zip(judged_v, files)]
    fam_ratio = len(set(fams)) / max(1, len(fams))
    fam_heavy = {k: fams.count(k) for k in set(fams) if fams.count(k) >= 3 and k}
    ratio = 0.5 * ratio + 0.5 * fam_ratio           # four takes of one recording are not four sounds
    if files:
        v = 10 * clamp((ratio - 0.35) / 0.55, 0, 1) - 2 * repeats - len(heavy) - 0.5 * len(fam_heavy)
        axes["variety"] = clamp(v)
        notes["variety"] = (f"{distinct} source recordings, {len(set(fams))} families in {len(files)} sounds "
                            f"(runs and interface sounds not counted)")
    else:
        notes["variety"] = "not judged: only interface sounds, runs and sounds of one physical source"
    if axes.get("variety", 10.0) < PASS:
        for f, n in sorted(heavy.items(), key=lambda kv: -kv[1])[:2]:
            ts = ", ".join(fmt(c["t"]) for c in judged_v if srcf(c) == f)
            problems.append((4 + n, f"variety: {Path(f).name} is the source of {n} sounds ({ts}); a slice or a "
                                    f"pitch step does not make it another sound"))
        for k, n in sorted(fam_heavy.items(), key=lambda kv: -kv[1])[:1]:
            ts = ", ".join(fmt(c["t"]) for c, fk in zip(judged_v, fams) if fk == k)
            problems.append((3 + n, f"variety: {n} takes of the same recording family '{k}' ({ts}); mix in other sounds"))

    # a run of one and the same sound is a machine gun, interface sounds included (a keyboard is many slices)
    mc = sorted(main_cues, key=lambda c_: c_["t"])
    i_ = 0
    while i_ < len(mc):
        j_ = i_
        while j_ + 1 < len(mc) and mc[j_ + 1]["t"] - mc[j_]["t"] <= 0.35:
            j_ += 1
        grp = mc[i_:j_ + 1]
        clock_ = sum(1 for c_ in grp if str(c_.get("label", "")).lower().startswith(("tick", "tock"))) >= 0.7 * len(grp)
        if len(grp) >= 5 and not clock_:                # a clock ticks identically on purpose
            keys_ = {(str(c_.get("uisfx") or c_.get("slice_of") or c_.get("file")), round(c_.get("pitch", 0) or 0),
                      str(c_.get("slice"))) for c_ in grp}
            if len(keys_) <= 2:
                nm_ = Path(str(grp[0].get("uisfx") or grp[0].get("file"))).name
                axes["variety"] = min(axes.get("variety", 10.0), 6.0)
                problems.append((6, f"variety: {len(grp)} identical sounds in a row at {fmt(grp[0]['t'])}-"
                                    f"{fmt(grp[-1]['t'])} ({nm_}): a machine gun; typing belongs to the keyboard "
                                    f"(kind key), ticks need several takes"))
                notes["variety"] = (notes.get("variety", "") + "; " if notes.get("variety") else "") +                     f"a run of {len(grp)} identical sounds"
                break
        i_ = j_ + 1

    # 6. hierarchy -------------------------------------------------------------------------
    have_loud = sum(1 for c in main_cues if c.get("loud_after_db") is not None) >= 0.8 * max(1, len(main_cues))
    eff = [c["loud_after_db"] if have_loud and c.get("loud_after_db") is not None else
           (c["peak_after_db"] if c.get("peak_after_db") is not None
            else ROLE_TARGET_PEAK_DB.get(c["role"], -10) + c.get("gain_db", 0.0)) for c in main_cues]
    if len(eff) >= 6:
        s = sorted(eff)
        spread = s[int(0.9 * (len(s) - 1))] - s[int(0.1 * (len(s) - 1))]
        axes["hierarchy"] = clamp(10 if spread >= 8 else 7 + (spread - 4) * 0.75 if spread >= 4 else 4 + spread * 0.75)
        notes["hierarchy"] = f"{spread:.1f} dB between the loud and the quiet sounds"
        if axes["hierarchy"] < PASS:
            problems.append((5, f"hierarchy: all sounds sit within {spread:.1f} dB; make the big moments clearly bigger "
                                f"and the small ticks quieter"))
    else:
        notes["hierarchy"] = "not judged: fewer than 6 sounds"
    if have_loud:
        by_role_ = {}
        for c in main_cues:
            if c.get("role") not in ("typing", "click", "ui", "data", "ambience", "vehicle") and not c.get("_layer") \
                    and not c.get("texture"):                # a texture sound is quiet on purpose
                by_role_.setdefault(c["role"], []).append(c)
        for role_, cs_ in by_role_.items():
            if len(cs_) < 3:
                continue
            net = [(c["loud_after_db"] - 20 * math.log10(max(0.05, c.get("g_author") or 1.0)), c) for c in cs_
                   if c.get("loud_after_db") is not None]
            if len(net) < 3:
                continue
            med_ = sorted(v for v, _ in net)[len(net) // 2]
            for v_, c in sorted(net, key=lambda x: x[0])[:1]:
                if v_ < med_ - 8.0:                  # net of the author's own per-event gain
                    problems.append((5 + min(3, (med_ - v_ - 8.0) / 3),
                                     f"hierarchy: '{c['label'][:26]}' at {fmt(c['t'])} is {med_ - v_:.0f} dB quieter "
                                     f"(perceived level) than the other {role_} sounds: a thin recording, pick a "
                                     f"fuller one (search.py --role {role_} --sheet) or raise it"))

    # 7. headroom --------------------------------------------------------------------------
    tp = (loud.get("final") or {}).get("true_peak")
    if tp is None:
        tp = measure_loudness(a.track).get("true_peak")
    if tp is None:
        axes["headroom"], notes["headroom"] = 10.0, "true peak not measurable"
    else:
        axes["headroom"] = 10.0 if tp <= -0.9 else 7.0 if tp <= -0.1 else 2.0
        notes["headroom"] = f"true peak {tp} dBTP"
        if axes["headroom"] < PASS:
            problems.append((8 if tp > -0.1 else 5, f"headroom: true peak {tp} dBTP, lower the SFX or master"))
        hot_ = [c for c in main_cues if c.get("peak_after_db") is not None and c["peak_after_db"] > 0.0]
        if len(hot_) >= 3:
            axes["headroom"] = min(axes["headroom"], 7.0)
            worst_ = max(hot_, key=lambda c: c["peak_after_db"])
            notes["headroom"] += f"; {len(hot_)} cues peak above 0 dBFS before the limiter"
            problems.append((6, f"headroom: {len(hot_)} cues are over 0 dBFS BEFORE the limiter (worst "
                                f"'{worst_['label'][:24]}' at {fmt(worst_['t'])}, {worst_['peak_after_db']:+.0f} dBFS): "
                                f"the limiter squashes them, lower their gain_db or take louder recordings"))

    # 8. loudness / 9. balance -------------------------------------------------------------
    fin = (loud.get("final") or {}).get("lufs")
    sfx = (loud.get("sfx") or {}).get("lufs")
    if fin is not None:
        dist = abs(fin - (-14.0))
        if keep:
            axes["loudness"] = 10.0 if dist <= 3 else 7.0 if dist <= 6 else 5.0
            notes["loudness"] = f"final {fin} LUFS (the author's own balance is kept)"
            try:
                o_l = measure_loudness(orig_src).get("lufs")
            except Exception:
                o_l = None
            if o_l is not None and fin is not None and fin < o_l - 1.0:
                gap_ = o_l - fin
                act_diff = None
                try:
                    import masking as _mk2
                    if sheet.get("output") and Path(sheet["output"]).exists():
                        act_diff = _mk2.active_level_diff(orig_src, sheet["output"])
                except Exception:
                    act_diff = None
                if act_diff is not None and abs(act_diff) <= 0.7:
                    notes["loudness"] = (f"final {fin} LUFS vs the original {o_l:.1f}: the original's own sound is "
                                         f"untouched where it sounds ({act_diff:+.1f} dB); the integrated figure drops "
                                         f"because the new quiet sounds in its silence count as programme (BS.1770 gating)")
                else:
                    axes["loudness"] = min(axes["loudness"], clamp(10 - 1.2 * (gap_ - 1.0)))
                    notes["loudness"] = (f"final {fin} LUFS is {gap_:.1f} dB UNDER the original ({o_l:.1f})"
                                         + (f"; where the original sounds the film is {act_diff:+.1f} dB: the ducking, "
                                            f"the level match or the ceiling took it" if act_diff is not None else ""))
                    problems.append((5 + min(3, gap_ - 1.0), f"loudness: the film came out {gap_:.1f} dB quieter than "
                                     f"its original ({o_l:.1f} LUFS); --target-lufs {o_l:.0f} brings it back "
                                     f"(a lighter --voice-depth, a lower sfx level, or --ceiling-db if the limiter "
                                     f"took it)"))
        else:
            axes["loudness"] = 10.0 if dist <= 1.5 else 8.0 if dist <= 4 else 6.0 if dist <= 8 else 4.0
            notes["loudness"] = f"final {fin} LUFS" + (f"; {loud['note']}" if loud.get("note") else "")
    if keep and fin is not None and sfx is not None and sheet.get("video"):
        orig = measure_loudness(orig_src).get("lufs")
        if orig is not None:
            gap_lu = orig - sfx                # positive: SFX are quieter than the original
            import masking
            # a texture sound is quiet under the film's own sound on purpose: the balance is judged on the real events
            lv_all = masking.cue_levels([c for c in cues if not c.get("texture")], a.track, orig_src)
            lv = [x for x in lv_all if not x.get("silent")]
            silent = [x for x in lv_all if x.get("silent")]
            # events, not sounds: a row of keys or ticks is one event (its median), and a sound that sits on speech
            # is ducked on purpose (the speech axis judges it): a film with a voice in 80 % of it is judged on the rest
            on_sp = None
            if (a.voice or (sheet.get("flags") or {}).get("voice_safe")):
                try:
                    import masking as _mk3
                    on_sp = _mk3.speech_activity(sheet, orig_src)
                except Exception:
                    on_sp = None
            grouped, cur = [], None
            for x in sorted(lv, key=lambda x: x["t"]):
                gap_ = 0.7 if str(x.get("role")) in ("typing", "click") else 0.25
                if cur is not None and cur["role"] == x["role"] and x["t"] - cur["last"] <= gap_:
                    cur["ds"].append(x["delta_db"])
                    cur["last"] = x["t"]
                else:
                    cur = {"t": x["t"], "last": x["t"], "role": x["role"], "ds": [x["delta_db"]], "label": x["label"]}
                    grouped.append(cur)
            n_sp = 0
            lv2 = []
            for gr_ in grouped:
                if on_sp is not None and on_sp(gr_["t"]):
                    n_sp += 1
                    continue
                ds_ = sorted(gr_["ds"])
                lv2.append({"t": gr_["t"], "role": gr_["role"], "label": gr_["label"], "delta_db": ds_[len(ds_) // 2]})
            if on_sp is not None and not lv2 and grouped:
                axes.pop("balance", None)
                notes["balance"] = (f"not judged: all {len(grouped)} events sit on speech; the speech axis judges "
                                    f"them (they are ducked on purpose)")
                lv, silent, lv_all = [], [], []
            elif lv2 or silent:
                lv = lv2
                if n_sp:
                    notes["balance_extra"] = f" ({n_sp} event(s) on speech left to the speech axis)"
            if len(lv_all) >= 3 and len(silent) >= max(3, 0.5 * len(lv_all)):
                axes["balance"] = 10.0
                notes["balance"] = (f"the original is silent around {len(silent)} of {len(lv_all)} sounds: nothing "
                                    f"there to bury or to be buried by")
            elif len(lv) >= 3:
                ds = sorted(x["delta_db"] for x in lv)
                med = ds[len(ds) // 2]
                heavy = sorted(x["delta_db"] for x in lv if x["role"] in ("hit", "sub_drop", "design", "whoosh", "riser"))
                hmed = heavy[len(heavy) // 2] if heavy else None
                # a mixer's rule: ticks well under the picture's sound, big moments around it or above
                ok_mid = -12.0 <= med <= 2.0
                ok_big = hmed is None or -8.0 <= hmed <= 5.0
                axes["balance"] = 10.0 if ok_mid and ok_big else 7.0 if (-16.0 <= med <= 4.0) else 3.0
                notes["balance"] = (f"median event peak {med:+.0f} dB vs the original around it" +
                                    (f", big sounds {hmed:+.0f} dB" if hmed is not None else "") +
                                    f" (whole-track gap {gap_lu:+.0f} LU)" + notes.pop("balance_extra", ""))
                if axes["balance"] < PASS:
                    if med > 2.0 or (hmed is not None and hmed > 5.0):
                        problems.append((7, f"balance: sounds sit {max(med, hmed or med):+.0f} dB over the original "
                                            f"around them: they bury the voice/music, lower with --sfx-trim-db or "
                                            f"--voice-safe"))
                    else:
                        low = sorted(lv, key=lambda x: x["delta_db"])[:2]
                        problems.append((7, f"balance: median sound is {med:+.0f} dB under the original, "
                                            f"weakest at {', '.join(fmt(x['t']) for x in low)}: raise gain_db there "
                                            f"(sheet.py gain --db +N --between A B) and render with --no-match-layer: "
                                            f"the layer match keeps the whole layer at the loudness of the sound it "
                                            f"replaces and takes back a raise that is made on every cue"))
            elif "balance" not in notes:
                axes["balance"] = 10.0 if 3 <= gap_lu <= 11 else 7.0 if -1 <= gap_lu < 3 or 11 < gap_lu <= 15 else 3.0
                notes["balance"] = f"SFX are {gap_lu:+.1f} LU below the original audio ({orig} LUFS)"

    # 9b. doubling: the synthesized layer must be gone from the new film (replace, not double) ------------------
    ref_ = [f for f in (dr0.get("reference_layer") or []) if Path(f).exists()]
    out_ = sheet.get("output")
    if ref_ and out_ and Path(out_).exists() and sheet.get("video") and Path(sheet["video"]).exists():
        try:
            import unbake as _ub
            before_, after_ = _ub.presence(sheet["video"], ref_), _ub.presence(out_, ref_)
        except Exception:
            before_ = after_ = None
        if before_ is not None and after_ is not None:
            if before_ < 0.12:
                notes["doubling"] = (f"not measurable: the synthesized layer is only weakly in the original "
                                     f"(correlation {before_:.2f})")
            else:
                axes["doubling"] = 10.0 if abs(after_) <= 0.08 else 7.0 if abs(after_) <= 0.2 else 3.0
                notes["doubling"] = (f"correlation of the replaced synthesized layer with the film: {before_:.2f} in "
                                     f"the original -> {after_:.2f} in the new film"
                                     + (" (gone)" if abs(after_) <= 0.08 else ""))
                if axes["doubling"] < PASS:
                    problems.append((9, f"doubling: the synthesized layer is still in the new film (correlation "
                                        f"{after_:.2f} against {before_:.2f}): the real sounds sit on top of it. "
                                        f"Take it out: base_audio / unbake (from_cues.py FOLDER), --drop-original"))

    rows_, D_ = [], 0.0
    # 9c. match: every new sound against the one the author mixed, event by event ---------------------------------
    if ref_ and a.track and Path(a.track).exists():
        try:
            import levels as _lv
            rows_, D_ = _lv.compare(main_cues, ref_, a.track)
        except Exception:
            rows_, D_ = [], 0.0
        if len(rows_) >= 4:
            ok_ = sum(1 for r_ in rows_ if abs(r_["e"]) <= 3.0)
            share_ = ok_ / len(rows_)
            axes["match"] = 10.0 if share_ >= 0.85 else 8.0 if share_ >= 0.7 else clamp(10.0 * share_)
            notes["match"] = (f"{ok_}/{len(rows_)} events within 3 dB of the author's own balance (on average the new "
                              f"layer is {abs(D_):.1f} dB {'quieter' if D_ >= 0 else 'louder'} than the replaced one; "
                              f"the layer match and the master decide that, this axis is each event against it)")
            for r_ in sorted(rows_, key=lambda r: -abs(r["e"]))[:3]:
                if abs(r_["e"]) > 3.0:
                    problems.append((4 + min(4, abs(r_["e"]) / 2),
                                     f"match: '{r_['kind']}' at {fmt(r_['t0'])} is {abs(r_['e']):.0f} dB "
                                     f"{'too quiet' if r_['e'] > 0 else 'too loud'} against the author's balance "
                                     f"(levels.py RESOLVED TRACK --json edits.json, then sheet.py apply SHEET edits.json)"))

    # 9d. audibility: sounds that the ducking took out of the mix altogether (they pass every other axis) --------
    duck_ = sheet.get("sfx_ducked")
    if keep and orig_src and (sheet.get("flags") or {}).get("voice_safe") and duck_ and Path(duck_).exists():
        try:
            import masking as _mk4
            lvd_ = [x for x in _mk4.cue_levels(cues, duck_, orig_src) if x.get("delta_db") is not None]
        except Exception:
            lvd_ = []
        if len(lvd_) >= 4:
            under_ = [x for x in lvd_ if x["delta_db"] < -30.0]
            share_ = len(under_) / len(lvd_)
            ds_ = sorted(x["delta_db"] for x in lvd_)
            axes["audibility"] = clamp(10.0 - 14.0 * share_)
            notes["audibility"] = (f"{len(under_)} of {len(lvd_)} sounds sit more than 30 dB under the film's own sound "
                                   f"in the mix (median {ds_[len(ds_) // 2]:+.0f} dB, after the ducking)")
            if axes["audibility"] < PASS and axes.get("match", 0.0) >= PASS:
                axes["audibility"] = PASS                # the author's own sounds sat as low: the balance is theirs
                notes["audibility"] += "; the author's own sounds sat there too (match is kept): raise them on purpose"
            elif axes["audibility"] < PASS:
                names_ = ", ".join(sorted({str(x.get("role")) for x in under_})[:4])
                problems.append((7, f"audibility: {len(under_)} sounds ({names_}) are 30+ dB under the film's own sound "
                                    f"in the mix: they cannot be heard. The ducking took them out: "
                                    f"--voice-depth light (or normal), or a higher gain_db on those"))

    # 9e. mono: the film on a phone speaker, one earbud, a laptop ---------------------------------------------
    mono_bad_ = []
    try:
        import common as _cm
        if a.track and Path(a.track).exists():
            rep_m_, rows_m_ = _cm.fold_cues(a.track, main_cues)
        else:
            rep_m_, rows_m_ = None, []
    except Exception:
        rep_m_, rows_m_ = None, []
    if rep_m_ and rep_m_.get("loss_db") is not None:
        mono_bad_ = [(c_, l_, v_) for c_, l_, v_ in rows_m_ if l_ is not None and l_ > 6.0 and v_ > -45.0]
        loss_t_ = rep_m_["loss_db"]
        s_m_ = 10.0 - min(4.5, 1.5 * len(mono_bad_))
        if loss_t_ > 3.5:
            s_m_ -= min(3.0, loss_t_ - 3.5)
        extra_ = ""
        film_ = sheet.get("output")
        if keep and orig_src and film_ and Path(film_).exists():
            try:
                fd_, od_ = _cm.mono_drop(film_), _cm.mono_drop(orig_src)
            except Exception:
                fd_ = od_ = None
            if fd_ is not None and od_ is not None:
                add_ = fd_ - od_
                extra_ = (f"; the film loses {fd_:.1f} LU in mono against {od_:.1f} LU for the original "
                          f"({add_:+.1f} added)")
                if add_ > 1.5:
                    s_m_ -= min(3.0, add_ - 1.5)
        axes["mono"] = clamp(s_m_)
        notes["mono"] = (f"the SFX track loses {loss_t_:.1f} dB when folded to mono (0 = the channels agree, 3 = "
                         f"unrelated, 6+ = parts cancel); {len(mono_bad_)} of {len(rows_m_)} sounds lose more than "
                         f"6 dB" + extra_)
        for c_, l_, v_ in sorted(mono_bad_, key=lambda x_: -x_[1])[:3]:
            problems.append((5 + min(3, (l_ - 6.0) / 3.0),
                             f"mono: '{str(c_.get('label', ''))[:26]}' at {fmt(c_['t'])} loses {l_:.0f} dB when folded "
                             f"to mono (its channels are in opposite phase): set mono=true on the cue (one channel on "
                             f"both sides; sheet.py set SHEET --at {c_['t']:.2f} mono=true) or pick another sound"))

    # 10. speech / low-end (voice-led or music-led originals) ---------------------------------
    speech_all = []
    speech_groups_ = []
    voice = a.voice or bool((sheet.get("flags") or {}).get("voice_safe"))
    if keep and orig_src and (voice or (sheet.get("flags") or {}).get("duck")):
        import masking
        speech_src, speech_gain = orig_src, 0.0
        vst = masking.voice_stem(sheet)
        if vst:                             # a clean voice: the music under a phrase is not speech
            speech_src = vst
            speech_gain = float(sheet.get("voice_stem_gain_db", sheet.get("base_gain_db")) or 0.0)
        if voice:
            from common import voice_share
            vs_ = voice_share(speech_src)
            if vs_ is not None and vs_.get("speech", 1.0) < 0.05:
                voice = False
                notes["speech"] = f"no speech in the original audio (speech {vs_['speech']:.0%}): nothing to mask"
        if voice:
            ducked = sheet.get("sfx_ducked")
            if ducked and Path(ducked).exists():
                mk = masking.masked_cues(cues, ducked, speech_src, gain_db=speech_gain,
                                         clean_voice=bool(vst))   # what is in the mix
            else:
                mk = masking.masked_cues(cues, a.track, speech_src, gain_db=speech_gain, clean_voice=bool(vst))
                if sheet.get("flags", {}).get("voice_safe"):
                    mk = [m for m in mk if m["over_db"] > 0.0]      # estimate: the mix ducks by several dB
            groups = []                        # sounds within 0.4 s of each other are one moment on top of the voice
            for m in sorted(mk, key=lambda m: m["t"]):
                if groups and m["t"] - groups[-1][-1]["t"] <= 0.4:
                    groups[-1].append(m)
                else:
                    groups.append([m])
            speech_groups_ = groups
            axes["speech"] = clamp(10 - 1.5 * len(groups))
            n_above = sum(1 for m in mk if m["over_db"] > 0.0)
            notes["speech"] = (f"{len(mk)} sound(s) in {len(groups)} moment(s) are within 3 dB of the voice or above it "
                               f"({n_above} above)" +
                               (" even after ducking" if sheet.get("flags", {}).get("voice_safe") else ""))
            if len(groups) > 3 or a.list:
                for gr in sorted(groups, key=lambda g_: g_[0]["t"]):
                    m = max(gr, key=lambda m_: m_["over_db"])
                    speech_all.append(f"  {fmt(gr[0]['t']):>8}  {len(gr)} sound(s)  '{m['label'][:26]}' "
                                      f"{m['over_db']:+.1f} dB vs the voice -> lower by "
                                      f"{max(1.0, m['over_db'] + 4.0):.0f} dB, shorten, or move into a pause")
            for gr in sorted(groups, key=lambda g_: -max(m["over_db"] for m in g_))[:3]:
                m = max(gr, key=lambda m_: m_["over_db"])
                problems.append((6 + min(3, m["over_db"] / 3),
                                 f"speech: {len(gr)} sound(s) around {fmt(gr[0]['t'])} ('{m['label']}' "
                                 f"{m['over_db']:+.1f} dB vs the voice); lower them, shorten them, move into a pause"
                                 + ("" if (sheet.get("flags") or {}).get("voice_depth") == "deep" else
                                    " (--voice-depth deep ducks by about 24 dB in speech: check the LUFS of "
                                    "*_sfx_ducked.wav before you use it)")))
        low = masking.lowend_collisions(cues, a.track, orig_src)
        axes["low_end"] = clamp(10 - 1.5 * len(low))
        notes["low_end"] = f"{len(low)} heavy sound(s) on top of existing bass"
        for m in low[:2]:
            problems.append((5 + min(3, len(low)), f"low end: '{m['label']}' at {fmt(m['t'])} piles onto the bass already "
                             f"there ({m['orig_sub_db']:.0f} dB); lower it {m.get('need_db', 6):.0f} dB, highpass >= 140 Hz "
                             f"(the check measures 30-140 Hz: 90 Hz is not enough), or drop its sub layer"))

    # ---- report ---------------------------------------------------------------------------
    worst = sorted(problems, key=lambda p: -p[0])[:3]
    lo = min(axes.values()) if axes else 10
    lines = [f"# Critique, round {a.rounds}", ""]
    lines += ["| axis | score | basis |", "|---|---|---|"]
    for k in ("hook", "sync", "coverage", "pacing", "variety", "hierarchy", "headroom", "loudness", "balance",
              "doubling", "match", "audibility", "speech", "low_end", "mono"):
        if k in axes:
            lines.append(f"| {k} | {axes[k]:.1f} | {notes.get(k, '')} |")
        elif k in notes:
            lines.append(f"| {k} | n/a | {notes[k]} |")
    verdict = "PASS" if lo >= PASS else "FIX"
    lines += ["", f"**{verdict}**: lowest axis {lo:.1f} (every axis must reach {PASS:g}; "
              f"{'a new film needs at least 3 rounds' if a.rounds < 3 and verdict == 'PASS' else 'ok to show'})"]
    if worst and verdict == "FIX":
        lines += ["", "Three worst problems, fix only these, re-render, run again:"]
        lines += [f"{i}. {t}" for i, (_, t) in enumerate(worst, 1)]
    elif worst and worst[0][0] >= 5:
        lines += ["", "Nothing blocks showing it. If there is time, the cheapest polish:"]
        lines += [f"{i}. {t}" for i, (_, t) in enumerate(worst[:2], 1)]
    if speech_all:
        lines += ["", "Every moment on top of the voice (speech axis):"] + speech_all[:40]
    # the masking model's answer (mix.py --masking): which sounds the rest of the mix puts under the threshold
    mask_rows, mask_lines = [], []
    mk_ = sheet.get("masking") or {}
    if mk_.get("file") and Path(mk_["file"]).exists():
        try:
            import maskmodel as _mm
            mj_ = json.loads(Path(mk_["file"]).read_text(encoding="utf-8"))
            mask_lines = _mm.text(mj_["summary"], bool(sheet.get("bed")))
            mask_rows = [{"t": r_["t"], "label": r_["label"], "margin_db": r_["margin_db"],
                          "by": max(r_["masked_by"], key=r_["masked_by"].get),
                          "margin_wo_bed_db": r_.get("margin_wo_bed_db")}
                         for r_ in mj_["cues"] if r_["class"] == "masked" and _mm.judged(r_)]
        except Exception:
            mask_rows, mask_lines = [], []
    if mask_lines:
        lines += [""] + mask_lines
    # the texture layer is small by design: what the ear is sent to listen to are the real events
    first_listen = min((c for c in audible if not c.get("texture")), key=lambda c: c["t"], default=None)
    listen_ = listen_list([c for c in main_cues if not c.get("texture")],
                          [r for r in rows if not str(r.get("label", "")).startswith("texture")],
                          rows_, speech_groups_, mono_bad_, first=first_listen, masked=mask_rows)
    if listen_:
        lines += ["", f"Listen to {'this moment' if len(listen_) == 1 else f'these {len(listen_)} moments'}, on headphones "
                  f"and then once on a phone speaker. This script cannot hear: they are the places where the numbers "
                  f"above are least certain, and none of them says that it sounds good:"]
        for i, (_, t_, lab_, why_, ask_) in enumerate(listen_, 1):
            lines.append(f"  {i}. {fmt(t_):>8}  {('' + chr(39) + lab_[:24] + chr(39) + ': ') if lab_ else ''}{why_}. "
                         f"Listen for: {ask_}")
        if a.listen_out:
            src_ = sheet.get("output") if sheet.get("output") and Path(sheet["output"]).exists() else a.track
            ok_ = cut_listen(src_, listen_, a.listen_out, dur=dur)
            lines.append(f"  -> {a.listen_out}: the {len(listen_)} in this order, 3 s each" if ok_ else
                         f"  -> {a.listen_out} could not be written (ffmpeg failed)")
        else:
            lines.append("  (--listen-out FILE.wav cuts them into one file of the film's own sound)")
    style_rows = []
    if a.style:
        style_rows, st_lines = style_block(a.style, sheet, a.track, fin, keep)
        lines += [""] + st_lines
    elif not keep:
        try:
            import refstyle
            if refstyle.find_style("clean-sfx-refs")[0] is not None:
                lines += ["", "(The sound of this film is only SFX: --style clean-sfx-refs sets it against nine "
                              "finished SFX reels, numbers only, no scores.)"]
        except Exception:
            pass
    lines += ["", "Still to judge by eye on review.png: character fit (each sound suits its picture), cleanliness "
              "(no mud in the low end under music/voice, nothing masks speech), taste (designed, not sprayed on)."]
    text = "\n".join(lines)
    print(text)
    if a.out:
        p_out = Path(a.out)
        if a.append and p_out.exists():           # the history of the loop in one file, newest round last
            p_out.write_text(p_out.read_text(encoding="utf-8") + "\n\n---\n\n" + text, encoding="utf-8")
        else:
            p_out.write_text(text, encoding="utf-8")
    if a.json:
        print(json.dumps({"axes": axes, "problems": [p[1] for p in worst], "verdict": verdict,
                          "listen": [{"t": t_, "label": lab_, "why": why_, "ask": ask_}
                                     for _, t_, lab_, why_, ask_ in listen_],
                          "style": {"name": a.style, "rows": style_rows} if a.style else None}, ensure_ascii=False))
    sys.exit(0 if verdict == "PASS" else 1)


if __name__ == "__main__":
    main()
