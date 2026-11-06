#!/usr/bin/env python3
"""A layer of small real sounds on the picture's small moves that nobody voiced, for films whose sound is only SFX.

  python texture.py work/cues.json --moments work/moments/moments.json          # add the layer, write the sheet
  python texture.py work/cues.json --moments work/moments/moments.json --dry    # only say what it would add
  python texture.py work/cues.json --remove                                     # take the layer out again

Why. Nine finished SFX reels (`critique.py --style clean-sfx-refs`) have a gesture about every 0.7 s and no hole
longer than 2-3 s; the same pictures voiced by this skill have a gesture every 1.2-1.5 s and holes of 4-6 s, because
the small moves of the picture (a settle, a small pop-in, a nudge) were left quiet on purpose. A film that is only
sound design has nothing else to fill them. This script voices the quiet moves that sit in the holes, longest hole
first, with a short drop or bubble from the main pack (never synthesized), a few dB under the real events.

What it does and does not do
  * only moments of the PICTURE that no cue sits on (find_moments' bursts, onsets and settles): every sound lands on a
    frame where something moves, nothing is sprayed on a still picture;
  * only up to the pace of the references, counted the way the references are counted: GESTURES per 10 s (sounds
    with no pause of 0.25 s in them; `--target`, default the lower edge of the middle half of the nine reels, 9.0):
    a film that is dense already gets nothing, and the pacing axis counts these sounds at half weight like ticks;
  * cues carry `"texture": true` (and `same_source`: the variety axis does not judge them); running it again replaces
    the layer, `--remove` takes it out; every other cue is left exactly as it was;
  * a film that keeps its own music or voice is refused (the layer is for films where the sound is the SFX):
    `--even-with-audio` overrides, and then the sounds are left to the tonal fit and the ducking;
  * strong moments with no sound (a cut with no whoosh) are NOT texture: they are listed, voice them for real.
"""
import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import gesture_times, load_json, norm_path

MAX_DUR = 0.30                 # audible length of a texture sound, seconds
DEFAULT_TARGET = 9.0           # gestures per 10 s: the lower edge of the middle half of the nine reference reels
PITCH_CYCLE = [0, -2, 2, -1, 1, -3, 3]
# kind of picture moment -> (role, extra pick keys) in turn; the first with sounds in the index is used
KIND_CYCLE = {
    "burst": [("water", {}), ("pop", {"bright": True}), ("water", {})],
    "onset": [("pop", {}), ("water", {}), ("click", {"punchy": True})],
    "settle": [("pop", {"dark": True}), ("water", {"dark": True})],
}


def role_of(c):
    if c.get("role"):
        return c["role"]
    pk = c.get("pick") or {}
    if pk.get("role"):
        return pk["role"]
    if "uisfx" in c:
        return "ui"
    return "default"


def gestures_per10(cues, dur):
    """Gestures per 10 s of a sheet: the number refstyle.py measures on the sound of the references."""
    plain = [dict(c, role=role_of(c)) for c in cues if not c.get("_layer")]
    g = gesture_times(plain)
    return len(g) / max(dur, 1.0) * 10, len(g)


def reference_target():
    """The pace to reach: the lower edge of the middle half of the shipped reference style, else DEFAULT_TARGET."""
    try:
        import refstyle
        st = refstyle.find_style("clean-sfx-refs")[0] or {}
        p25 = ((st.get("measures") or {}).get("gest10") or {}).get("p25")
        if p25:
            return float(p25)
    except Exception:
        pass
    return DEFAULT_TARGET


def sfx_led(sheet, video):
    """True when the film's sound is only the SFX: no original audio kept, or an original that is silent."""
    ka = sheet.get("keep_audio", "auto")
    if ka in ("no", False, 0):
        return True, "keep_audio is off"
    if sheet.get("base_audio"):
        return False, "the sheet has base_audio (music or voice stems)"
    if not video or not Path(video).exists():
        return True, "no video to look at"
    try:
        from find_moments import audio_level, probe
        info = probe(video)
        if not info.get("has_audio"):
            return True, "the video has no audio"
        lvl = audio_level(video)
        if lvl is None or lvl < -50.0:
            return True, f"the video's own audio is silent ({lvl} dB)" if lvl is not None else "the video's audio is silent"
        return False, f"the video's own audio is {lvl:.0f} dB mean (music or voice)"
    except Exception:
        return True, "audio not measurable"


FALLBACK = [("click", {"punchy": True})]      # a library with no drops and no bubbles still has clicks


def spec_options(index, kind, k):
    """The (role, pick spec) for the k-th texture sound of this kind of moment: the cycle's turn if the index has
    sounds for it, else the next option, else a click; None when the library has nothing short enough."""
    from picker import rank
    cyc = KIND_CYCLE[kind]
    order = [cyc[(k + step) % len(cyc)] for step in range(len(cyc))] + FALLBACK
    for role, extra in order:
        spec = {"role": role, "max_dur": MAX_DUR, "min_dur": 0.03, **extra}
        if rank(index, spec):
            return role, spec
    return None, None


def moments_of(args, sheet, sheet_dir):
    if args.moments:
        p = Path(args.moments)
        if not p.is_file():
            sys.exit(f"--moments: {p} not found (find_moments.py FILM --out work/moments writes moments.json)")
        d = load_json(p)
        return d["moments"], (d.get("info") or {}).get("duration")
    vid = sheet.get("video")
    if not vid:
        sys.exit("no --moments and the sheet names no video: run find_moments.py on the film first")
    v = Path(norm_path(vid))
    if not v.is_absolute() and not v.exists():
        v = sheet_dir / v
    if not v.exists():
        sys.exit(f"the sheet's video {v} was not found; pass --moments")
    from find_moments import probe, visual_moments
    print(f"moments: measuring the picture of {v.name} ...", flush=True)
    moms, _ = visual_moments(str(v), max_other=80)
    return moms, probe(str(v))["duration"]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("sheet", help="the cue sheet (work/cues.json) the layer is added to")
    ap.add_argument("--moments", help="moments.json of find_moments.py (measured from the sheet's video if omitted)")
    ap.add_argument("--target", type=float, default=None,
                    help="gestures per 10 s to reach (default: the lower edge of the middle half of the reference "
                         "reels, 9.0; the references run 6.9-15.1)")
    ap.add_argument("--max-per10", type=float, default=4.0, help="at most this many texture sounds per 10 s")
    ap.add_argument("--level", type=float, default=-2.0,
                    help="gain_db of a texture sound at full strength, relative to its role's level (weaker moves: "
                         "up to 4 dB lower)")
    ap.add_argument("--min-hole", type=float, default=0.9,
                    help="only fill holes (seconds between the sounds around) at least this long")
    ap.add_argument("--min-strength", type=float, default=0.2, help="ignore picture moves weaker than this")
    ap.add_argument("--max-strength", type=float, default=0.7,
                    help="a stronger move than this is not texture: it is listed, voice it for real")
    ap.add_argument("--kinds", default="burst,onset,settle", help="moment kinds that may get a texture sound")
    ap.add_argument("--dry", action="store_true", help="say what would be added, write nothing")
    ap.add_argument("--remove", action="store_true", help="take the texture layer out of the sheet")
    ap.add_argument("--even-with-audio", action="store_true",
                    help="add the layer although the film keeps its own music or voice")
    ap.add_argument("--no-pitch", action="store_true", help="no semitone steps between repeats")
    a = ap.parse_args()

    sp = Path(a.sheet)
    if not sp.exists():
        sys.exit(f"sheet not found: {sp}")
    sheet = load_json(sp)
    if isinstance(sheet, list):
        sheet = {"cues": sheet}
    cues = sheet.setdefault("cues", [])
    old = [c for c in cues if c.get("texture")]
    base = [c for c in cues if not c.get("texture")]
    if a.remove:
        sheet["cues"] = base
        sheet.pop("_texture", None)
        if not a.dry:
            sp.write_text(json.dumps(sheet, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"removed {len(old)} texture sound(s); {len(base)} cues remain" + (" (dry run)" if a.dry else ""))
        return

    video = sheet.get("video")
    if video:
        v_ = Path(norm_path(video))
        video = str(v_ if v_.is_absolute() or v_.exists() else sp.parent / v_)
    led, why = sfx_led(sheet, video)
    if not led and not a.even_with_audio:
        sys.exit(f"not added: {why}. The texture layer is for films whose sound is only SFX (the references it follows "
                 f"are such films); over music or voice it clutters. --even-with-audio adds it anyway.")

    moms, mdur = moments_of(a, sheet, sp.parent)
    dur = sheet.get("duration") or mdur or (max([c["t"] for c in base] + [m["t"] for m in moms]) + 1.0)
    kinds = {k.strip() for k in a.kinds.split(",") if k.strip()}
    quiet = sheet.get("quiet") or []
    in_quiet = lambda t: any(q[0] <= t <= q[1] for q in quiet)
    parents = [c for c in base if not c.get("_layer") and not c.get("bed")]
    times = sorted(float(c["t"]) for c in parents)

    if len(parents) < 3:
        sys.exit(f"not added: the sheet has {len(parents)} real cue(s). The texture layer goes under real events; "
                 f"voice the film first (from_cues.py / suggest_cues.py), then add it.")
    target = a.target if a.target is not None else reference_target()
    w0, n_ev0 = gestures_per10(base, dur)
    cap = int(math.floor(a.max_per10 * max(dur, 10.0) / 10.0 + 1e-9))
    need = int(math.ceil(max(0.0, target - w0) * max(dur, 1.0) / 10.0 - 1e-9))
    n_add = min(need, cap)

    # candidates: moves of the picture that no cue sits on (the critique's own 0.18 s), not in a quiet range, not
    # inside a run of typing, not at the very start or end
    typing = [float(c["t"]) for c in parents if role_of(c) == "typing"
              or str(c.get("label", "")).lower().startswith("key")]
    def in_typing(t):
        return any(abs(t - x) <= 0.35 for x in typing)
    cand, strong_cuts, strong_moves = [], [], []
    for m in moms:
        t, kind, st = float(m["t"]), m["kind"], float(m.get("strength", 0.5))
        if any(abs(c - t) <= 0.18 for c in times):
            continue
        if kind == "cut":
            if m.get("pct", st) >= 0.5 and not in_quiet(t):
                strong_cuts.append(t)
            continue
        if kind not in kinds or in_quiet(t) or in_typing(t):
            continue
        if st > a.max_strength:
            strong_moves.append((t, kind))          # the coverage axis calls these a hole: not texture
            continue
        if st < a.min_strength or t < 0.05 or t > dur - 0.25:
            continue
        cand.append(m)

    chosen = []
    taken = list(times)
    for _ in range(n_add):
        pts = sorted(taken + [0.0, float(dur)])
        best, best_s = None, -1.0
        for m in cand:
            if m in chosen:
                continue
            t = float(m["t"])
            prev = max(p for p in pts if p <= t)
            nxt = min(p for p in pts if p > t)
            gap = nxt - prev
            clear = min(t - prev, nxt - t)
            if gap < a.min_hole or clear < 0.25:
                continue
            s = gap + 0.6 * float(m.get("strength", 0.5)) + 0.3 * min(clear, 1.0)
            if s > best_s:
                best, best_s = m, s
        if best is None:
            break
        chosen.append(best)
        taken.append(float(best["t"]))
    chosen.sort(key=lambda m: m["t"])

    # sounds: from the index, short, by the kind of the move
    index = []
    if chosen:
        try:
            from picker import load_index
            index = load_index()
        except SystemExit as ex:
            sys.exit(str(ex))
    turn, new, skipped = {}, [], []
    use_pitch = led and not a.no_pitch
    for i, m in enumerate(chosen):
        kind = m["kind"]
        k = turn.get(kind, 0)
        role, spec = spec_options(index, kind, k)
        if role is None:
            skipped.append(m)
            continue
        turn[kind] = k + 1
        st = float(m.get("strength", 0.5))
        c = {"t": round(float(m["t"]), 3), "label": f"texture {kind} {st:.2f}", "frame": m.get("frame"),
             "pick": spec, "gain_db": round(a.level - 4.0 * (1.0 - min(1.0, st)), 1), "texture": True,
             "same_source": True}
        if use_pitch and PITCH_CYCLE[i % len(PITCH_CYCLE)]:
            c["pitch"] = PITCH_CYCLE[i % len(PITCH_CYCLE)]
        if not c["frame"]:
            c.pop("frame")
        new.append(c)

    after = base + new
    w1, n_ev1 = gestures_per10(after, dur)
    print(f"pace: {w0:.1f} gestures per 10 s ({n_ev0} in {dur:.1f} s); target {target:g}, "
          f"cap {cap} texture sounds" + (f" ({len(old)} earlier ones replaced)" if old else ""))
    print(f"film: {'only SFX' if led else 'keeps its own audio'} ({why})")
    print(f"candidates: {len(cand)} unvoiced moves of the picture; holes of {a.min_hole:g} s and more are filled "
          f"longest first")
    if not new:
        if w0 >= target:
            print("nothing added: the film is at or above the target pace already")
        elif not cand:
            print("nothing added: no unvoiced move of the picture is strong enough (--min-strength) or all sit "
                  "beside a sound")
        else:
            print("nothing added: no unvoiced move sits in a hole (--min-hole) or the library has no short sound")
    else:
        for c in new:
            print(f"  {c['t']:7.2f}s  {c['pick']['role']:6s} {c['gain_db']:+5.1f} dB"
                  f"{'  ' + format(c['pitch'], '+d') + ' st' if c.get('pitch') else ''}   {c['label']}")
        print(f"added {len(new)}: pace {w0:.1f} -> {w1:.1f} gestures per 10 s")
    if skipped:
        print(f"no short sound in the library for {len(skipped)} move(s) of kind "
              f"{', '.join(sorted({m['kind'] for m in skipped}))}: left quiet")
    if strong_cuts or strong_moves:
        parts_ = [f"{t:.2f}s cut" for t in sorted(strong_cuts)] + [f"{t:.2f}s {k}" for t, k in sorted(strong_moves)]
        print(f"NOT texture: {len(parts_)} strong moment(s) have no sound ({', '.join(parts_[:8])}"
              f"{' ...' if len(parts_) > 8 else ''}): a small sound there is a hole, not a texture; voice them for "
              f"real (sheet.py add a whoosh, a hit or a pop), or leave them quiet on purpose (clip windows)")

    if a.dry:
        print("(dry run: the sheet is unchanged)")
        return
    sheet["cues"] = sorted(base + new, key=lambda c: float(c.get("t", 0.0)))      # stable: ties keep their order
    if new:
        sheet["_texture"] = {"added": len(new), "target": target, "level_db": a.level,
                             "pace_before": round(w0, 2), "pace_after": round(w1, 2)}
    else:
        sheet.pop("_texture", None)
    sp.write_text(json.dumps(sheet, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"-> {sp}  (mix.py again; `texture.py {sp.name} --remove` takes the layer out)")


if __name__ == "__main__":
    main()
