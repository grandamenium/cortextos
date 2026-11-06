#!/usr/bin/env python3
"""A bed under a film whose sound is only SFX: one long, dark, steady REAL recording of the library, never synthesized.

  python bed.py work/cues.json --list                 # the candidates, with their tags: choose by numbers and tags
  python bed.py work/cues.json                        # choose the best, add the bed, write the sheet
  python bed.py work/cues.json --id 641 [--level -54 | --floor -24]  # a sound you chose (ids with commas take turns)
  python bed.py work/cues.json --dry | --remove

Why. The finished SFX reels never go quiet: their quietest tenth of the film sits about 24 dB under the loudest
250 ms (median of nine; the SFX-only renders of this skill: 33-87 dB under), and they have no digital silence
(0-2 % of the time under -70 dBFS, one at 15 %; ours 4-67 %). Between the events the sound of such a film does not stop, a person hears a room, a
wind, a hum, a pad. A film with silence between its sounds reads as bare ("пусто": the listener's word for the
version without a bed).

HOW LOUD is the person's answer, not the references': in three blind ladders of one bed at -56 / -50 / -44 / -36 dBFS
(median 250 ms) the listener chose -56 every time, called -50 "всё хорошо" and -44 and louder "громко", while a bed 24 dB
under the loudest 250 ms of a dense film (about -34 dBFS) had been "гул мешает" before. So the level is ABSOLUTE:
`--level` (default -54 dBFS, the bed's own median 250 ms in the finished master). `--floor DB` is the old relative
rule (that many dB under the loudest 250 ms) for a film that wants it.

What it does and does not do
  * adds cues with `"bed": true` that cover the film (or --from/--to) with the chosen recording, in overlapping
    pieces when the recording is shorter than the film (equal-power cross-fades, no loop seam), around the sheet's
    `quiet` ranges; every other cue is left exactly as it was; running it again replaces the bed, --remove takes it out;
  * the LEVEL is not guessed here: `mix.py` renders the film without the bed, as the finished master will have it,
    and puts the bed's own median 250 ms level at `level_dbfs` (default -54; `bed:` line of the output), or with
    --floor that many dB under the loudest 250 ms, so it follows every later change of the sounds;
  * a dark, STEADY, long recording is chosen (centroid under 900 Hz, nothing that sounds like a person, an animal or
    a song: by name and by the model's tags; and one whose level does not throb: `ripple` of the 50 ms levels at most
    4 dB, `swing` at most 12; --list shows the numbers); --list shows the others, --id or --query overrides.
    Why: the listener's own verdict on four films was "гул мешает" for a sub recording that moves 5-8 dB about twice
    a second; steady recordings measure 2-3 dB (`--scan` measures the whole library once, the picker reads it too);
  * a film that keeps its own music or voice is refused (--even-with-audio overrides): there the music is the bed;
  * the critique does not count a bed as an event (no gesture, no hook, no variety, no hierarchy); the table against
    the references shows its effect (`floor`, `digital silence`, `sub bed`).
Listen to the film with and without it (--remove): the script cannot hear that a bed is not in the way.
"""
import argparse
import json
import math
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import STEADY_PATH, effective_dur, load_json, load_steady, norm_path, save_steady, steady_of

# a bed must not be a THING: no person, animal, song, weather, fire, water, footsteps (by the model's tags and by name)
AVOID = ("speech", "animal", "bird", "insect", "cricket", "crowd", "child", "music", "singing", "siren", "alarm",
         "laughter", "cough", "snoring", "cat", "dog", "fire", "storm", "thunder", "rain", "water", "ocean", "wave",
         "forest", "beach", "bubbl", "footstep", "walk", "crack", "explosion", "ringing")
# whole words of a NAME or FOLDER that say it is a thing, not a floor (the model's tags on a low drone are unreliable:
# a plain drone gets "whale vocalization", so these are not looked for in the tags)
AVOID_WORDS = ("whale", "dolphin", "wolf", "howl", "voice", "vocal", "choir", "chant", "breath", "heartbeat", "baby",
               "applause", "traffic", "train", "engine", "motor", "plane", "helicopter", "street", "city", "market",
               "cafe", "restaurant", "kitchen", "machine")
_WORDS = re.compile(r"\b(" + "|".join(AVOID_WORDS) + r")(s|es|ing)?\b")
MAX_CENTROID = 900.0
MAX_RIPPLE = 4.0              # dB: a floor that moves faster than this is a throb, not a floor (see common.steadiness)
MAX_SWING = 12.0              # dB: a fade, a gap or a rise inside the recording
OK_RIPPLE = 2.5               # steady up to here costs nothing; above, the score pays 0.3 per dB


def tags_of(rec):
    return [str(t).lower() for t in (rec.get("tags") or [])[:4]]


def usable(rec, tone):
    names = [str(rec.get("name", "")).lower(), str(rec.get("folder", "")).lower()]
    if any(a in t for t in tags_of(rec) + names for a in AVOID) or any(_WORDS.search(n) for n in names):
        return False
    if tone == "dark" and rec.get("centroid", 1e9) > MAX_CENTROID:
        return False
    return rec.get("bumps", 0) <= 8                       # a steady recording, not a rhythm or a flutter


def candidates(index, film_len, tone="dark", query=None, steady=True):
    """[(score, record)] best first; each record carries `_steady` ({ripple, flutter, swing}) when it was measured.
    A recording that throbs (ripple > MAX_RIPPLE) or drifts (swing > MAX_SWING) is left out, `steady=False` keeps it."""
    from picker import load_taste, rank
    spec = {"role": "ambience", "min_dur": min(8.0, max(3.0, film_len * 0.4))}
    if query:
        spec["query"] = query
    loved = set(load_taste().get("love", []))        # a bed the person said "всё хорошо" to needs no tag to pass
    out = []
    for score, rec in rank(index, spec):
        if "centroid" not in rec or not (rec["path"] in loved or usable(rec, tone)):
            continue
        d = effective_dur(rec)
        chain = 0.0 if d >= film_len + 0.5 else 0.4 + 0.15 * math.ceil(film_len / max(1.0, d))
        # darker and lower under the small sounds of the film (they live at 0.5-6 kHz: a rumble does not mask them),
        # steadier, without a chain of pieces
        s = (score + chain + 0.6 * max(0.0, math.log(max(rec["centroid"], 30.0) / 120.0)) + 0.08 * rec.get("bumps", 0)
             + 0.8 * (1.0 - min(1.0, rec.get("low", 0.0))))
        out.append((round(s, 3), rec))
    out.sort(key=lambda t: (t[0], t[1]["id"]))
    if not steady:
        return out
    cache = load_steady()
    before = len(cache)
    kept = []
    for s, rec in out[:80]:                                   # ~0.1 s each, once: the cache keeps the numbers
        st = steady_of(rec, cache)
        if st is None or st["ripple"] > MAX_RIPPLE or st["swing"] > MAX_SWING:
            continue
        rec = dict(rec, _steady=st)
        kept.append((round(s + 0.3 * max(0.0, st["ripple"] - OK_RIPPLE), 3), rec))
    if len(cache) != before:
        try:
            save_steady(cache)
        except OSError:
            pass
    kept.sort(key=lambda t: (t[0], t[1]["id"]))
    return kept


def pieces(a0, a1, plen, xf):
    """Cover [a0, a1] with pieces of length plen that overlap by at least xf; the last one ends at a1.
    [(start, length)]. One piece when the recording is long enough."""
    span = a1 - a0
    if plen >= span + 0.2:
        return [(a0, span + 0.2)]
    n = max(2, int(math.ceil((span - xf) / max(0.5, plen - xf))))
    step = (span - plen) / (n - 1)
    return [(a0 + i * step, plen) for i in range(n)]


def scan():
    """Measure every ambience recording of the library once (the cache is what the picker reads) and say which throb."""
    from picker import load_index
    cache = load_steady()
    rows = []
    for rec in load_index():
        if "ambience" not in (rec.get("roles") or []) and rec.get("role") != "ambience":
            continue
        if effective_dur(rec) < 3.0 or not Path(rec["path"]).exists():
            continue
        st = steady_of(rec, cache)
        if st:
            rows.append((st["ripple"], st["flutter"], st["swing"], rec))
    save_steady(cache)
    rows.sort(key=lambda r: (r[0], r[1]))
    throb = [r for r in rows if r[0] > MAX_RIPPLE]
    print(f"{len(rows)} ambience recordings measured -> {STEADY_PATH}")
    print(f"steady (ripple up to {OK_RIPPLE:g} dB): {sum(1 for r in rows if r[0] <= OK_RIPPLE)}; "
          f"throb (over {MAX_RIPPLE:g}): {len(throb)}")
    print("the steadiest:")
    for rp, fl, sw, r in rows[:8]:
        print(f"  {r['id']:5d} ripple {rp:4.1f} flutter {fl:4.2f} swing {sw:5.1f}  {r['name'][:46]} ({r.get('tier', 'main')})")
    mains = [r for r in throb if r[3].get("tier", "main") == "main"]
    print(f"the throbbing ones of the main pack ({len(mains)}):")
    for rp, fl, sw, r in sorted(mains, key=lambda r: -r[0])[:8]:
        print(f"  {r['id']:5d} ripple {rp:4.1f} flutter {fl:4.2f} swing {sw:5.1f}  {r['name'][:46]}")

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("sheet", nargs="?", help="the cue sheet (not needed for --scan)")
    ap.add_argument("--id", help="the sound(s) to use: an id, or ids with commas (they take turns)")
    ap.add_argument("--query", help="words of the name or folder (picker --query)")
    ap.add_argument("--level", type=float, default=-54.0,
                    help="where the bed's own median 250 ms level sits in the finished master, dBFS (the listener "
                         "chose -56, called -50 good and -44 and louder loud)")
    ap.add_argument("--floor", type=float, default=None,
                    help="instead of --level: that many dB under the loudest 250 ms of the film (the references: -24)")
    ap.add_argument("--xfade", type=float, default=1.5, help="seconds of cross-fade between the pieces")
    ap.add_argument("--from", dest="t_from", type=float, help="start of the bed, seconds (default: the film's start)")
    ap.add_argument("--to", dest="t_to", type=float, help="end of the bed, seconds (default: the film's end)")
    ap.add_argument("--highpass", type=float, default=30.0, help="highpass Hz on every piece (0 = none)")
    ap.add_argument("--lowpass", type=float, default=0.0, help="lowpass Hz on every piece (0 = none)")
    ap.add_argument("--tone", choices=["dark", "any"], default="dark")
    ap.add_argument("--list", action="store_true", help="print the candidates and stop")
    ap.add_argument("--any-steadiness", action="store_true",
                    help=f"keep recordings that throb (ripple over {MAX_RIPPLE:g} dB) or drift (swing over {MAX_SWING:g})")
    ap.add_argument("--scan", action="store_true",
                    help="measure the steadiness of every ambience recording once (about 0.1 s each) and print the "
                         "steadiest and the ones that throb; the picker reads the result (ambience_steady.json)")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--remove", action="store_true")
    ap.add_argument("--even-with-audio", action="store_true")
    a = ap.parse_args()
    if a.scan:
        return scan()
    if not a.sheet:
        ap.error("the sheet is required (except for --scan)")

    sp = Path(a.sheet)
    if not sp.exists():
        sys.exit(f"sheet not found: {sp}")
    sheet = load_json(sp)
    if isinstance(sheet, list):
        sheet = {"cues": sheet}
    cues = sheet.setdefault("cues", [])
    old = [c for c in cues if c.get("bed")]
    base = [c for c in cues if not c.get("bed")]
    if a.remove:
        sheet["cues"] = base
        sheet.pop("_bed", None)
        if not a.dry:
            sp.write_text(json.dumps(sheet, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"removed {len(old)} bed piece(s); {len(base)} cues remain" + (" (dry run)" if a.dry else ""))
        return

    video = sheet.get("video")
    if video:
        v_ = Path(norm_path(video))
        video = str(v_ if v_.is_absolute() or v_.exists() else sp.parent / v_)
    dur = sheet.get("duration")
    if not dur and video and Path(video).exists():
        from find_moments import probe
        dur = probe(video)["duration"]
    if not dur:
        dur = max([float(c["t"]) for c in base] + [0.0]) + 1.0
    dur = float(dur)

    from texture import sfx_led
    led, why = sfx_led(sheet, video)
    if not led and not a.even_with_audio and not a.list:
        sys.exit(f"not added: {why}. A bed goes under a film whose sound is only SFX; over music or voice the music "
                 f"is the bed. --even-with-audio adds it anyway.")

    from picker import load_index
    index = load_index()
    a0 = max(0.0, a.t_from or 0.0)
    a1 = min(dur, a.t_to if a.t_to else dur)
    if a1 - a0 < 2.0:
        sys.exit("the bed would be shorter than 2 s: check --from/--to")

    if a.id:
        want = [int(x) for x in a.id.replace(" ", "").split(",") if x]
        recs = []
        for i in want:
            rec = next((s for s in index if s["id"] == i), None)
            if rec is None:
                sys.exit(f"no sound with id {i} in the index (ids change when the index is rebuilt)")
            recs.append(rec)
    else:
        cand = candidates(index, a1 - a0, a.tone, a.query, steady=not a.any_steadiness)
        if a.list:
            print(f"{'id':>5} {'score':>6} {'tier':5s} {'dur':>6} {'cent':>6} {'low':>5} {'ripple':>6} {'flut':>5} {'swing':>6}  "
                  f"name | tags")
            for sc, r in cand[:12]:
                st = r.get("_steady") or {}
                print(f"{r['id']:5d} {sc:6.2f} {r.get('tier', 'main'):5s} {effective_dur(r):6.1f} {r['centroid']:6.0f} "
                      f"{r.get('low', 0):5.2f} {st.get('ripple', float('nan')):6.1f} {st.get('flutter', float('nan')):5.2f} "
                      f"{st.get('swing', float('nan')):6.1f}  {r['name'][:38]} | {', '.join(tags_of(r)[:3])}")
            if not cand:
                print("no steady dark recording of the library fits (--tone any, --any-steadiness, --query WORDS or "
                      "--id N)")
            return
        if not cand:
            sys.exit("no steady dark recording of role ambience in the library fits: --tone any, --query WORDS, "
                     "--id N (search.py --role ambience --paths shows what there is)")
        best = cand[0][1]
        recs = [best]
        if effective_dur(best) < (a1 - a0) + 0.5:
            # the film is longer than the recording: a chain of pieces, and three DIFFERENT recordings take turns, so
            # that no cycle of 13 seconds can be heard
            seen = {best.get("dup_key") or best["name"].replace("(alt)", "").strip()}
            for _, r in cand[1:]:
                key = r.get("dup_key") or r["name"].replace("(alt)", "").strip()
                if key in seen:
                    continue
                recs.append(r)
                seen.add(key)
                if len(recs) == 3:
                    break

    # the quiet ranges of the sheet cut the bed into allowed stretches
    quiet = sorted((float(q[0]), float(q[1])) for q in (sheet.get("quiet") or []) if len(q) >= 2)
    spans, cur = [], a0
    for q0, q1 in quiet:
        if q1 <= cur or q0 >= a1:
            continue
        if q0 - cur >= 1.0:
            spans.append((cur, min(q0, a1)))
        cur = max(cur, q1)
    if a1 - cur >= 1.0:
        spans.append((cur, a1))
    if not spans:
        sys.exit("the sheet's quiet ranges leave no stretch of 1 s for a bed")

    new, k = [], 0
    for si, (s0, s1) in enumerate(spans):
        plen = min(effective_dur(r_) for r_ in recs)               # every piece is at least this long
        pcs = pieces(s0, s1, plen, a.xfade)
        for pi, (t, ln) in enumerate(pcs):
            r_ = recs[k % len(recs)]
            k += 1
            first, last = pi == 0, pi == len(pcs) - 1
            c = {"t": round(t, 3), "label": f"bed {r_['name'][:24]}", "file": r_["path"], "role": "ambience",
                 "anchor": "start", "max_dur": round(min(ln, effective_dur(r_)), 3),
                 "fade_in": round(0.8 if first else a.xfade, 2), "fade_out": round(1.2 if last else a.xfade, 2),
                 "fade_curve": "qsin", "gain_db": 0.0, "bed": True, "same_source": True}
            if a.floor is not None:                         # relative: that many dB under the loudest 250 ms
                c["floor_db"] = a.floor
            else:                                           # absolute: the bed's median 250 ms in the master
                c["level_dbfs"] = a.level
            if a.highpass:
                c["highpass"] = a.highpass
            if a.lowpass:
                c["lowpass"] = a.lowpass
            new.append(c)

    print(f"film {dur:.1f} s ({'only SFX' if led else 'keeps its own audio'}: {why}); bed {a0:.1f}-{a1:.1f} s"
          f"{' in ' + str(len(spans)) + ' stretches around the quiet ranges' if len(spans) > 1 else ''}")
    for r_ in recs:
        print(f"  sound: id {r_['id']} {r_['name'][:46]} ({r_.get('library')}, {effective_dur(r_):.1f} s, centroid "
              f"{r_.get('centroid', 0):.0f} Hz, tags {', '.join(tags_of(r_)[:3])})")
    print(f"  {len(new)} piece(s)" + (f" overlapping by {a.xfade:g} s" if len(new) > 1 else "") +
          (f"; level: {a.floor:+g} dB under the loudest 250 ms of the film" if a.floor is not None else
           f"; level: {a.level:g} dBFS (the bed's median 250 ms in the master)") + ", set by mix.py" +
          (f" ({len(old)} earlier piece(s) replaced)" if old else ""))
    if a.dry:
        print("(dry run: the sheet is unchanged)")
        return
    sheet["cues"] = sorted(base + new, key=lambda c: float(c.get("t", 0.0)))
    sheet["_bed"] = {"ids": [r_["id"] for r_ in recs], "names": [r_["name"] for r_ in recs], "pieces": len(new),
                     "floor_db": a.floor, "level_dbfs": None if a.floor is not None else a.level, "xfade": a.xfade,
                     "from": round(a0, 2), "to": round(a1, 2)}
    sp.write_text(json.dumps(sheet, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"-> {sp}  (mix.py again; listen with and without: `bed.py {sp.name} --remove`)")


if __name__ == "__main__":
    main()

