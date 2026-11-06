#!/usr/bin/env python3
"""Set the sound of a film against a reference style, in numbers, with no scores.

  python refstyle.py FILM.mp4|SFX_TRACK.wav --style clean-sfx-refs [--json]
  python refstyle.py --export styles/mine.json --out references/profiles/mine.json     (a compact, shippable copy)

`critique.py --style NAME` prints the same table at the end of its scoreboard. A style is the median and the range of
a handful of measures over a set of finished reference videos (`learn_style.py` writes them, `clean-sfx-refs` ships
with the skill: nine SFX-led reels). Every number is measured by the SAME code on the reference and on the film:
sharp rises of the level are sound events, events closer than 0.25 s are one gesture, and the table reads

    this film   |   reference: median (range)   |   inside / below / above

It does not say that the film sounds good or bad: a film with its own music and voice is not meant to match a reel
that is only sound design. It says where the film differs, and what usually moves that number.

Pure python (ffmpeg only), like the rest of the measuring scripts.
"""
import argparse
import json
import math
import statistics
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import SKILL_DIR, measure_loudness

GESTURE_GAP = 0.25            # events closer than this are one gesture (the critique's own pacing gap)
RATE = 16000

# key, label, unit, number format, what usually moves it when the film is BELOW / ABOVE the references
MEASURES = (
    ("gest10", "gestures per 10 s", "", "{:.1f}",
     "texture.py puts small real sounds on the picture moves nobody voiced (films whose sound is only SFX)",
     "busier than the references: drop the weakest sounds (the pacing axis)"),
    ("gap_med", "gap between gestures, median", "s", "{:.2f}",
     "sounds crowd each other more than in the references: thin the series, give the big moments room",
     "the film breathes more than the references: texture.py fills holes where the picture moves"),
    ("gap_p90", "gap between gestures, P90", "s", "{:.2f}",
     "", "long holes: texture.py fills them where the picture moves; where it does not, the stillness is the "
         "picture's"),
    ("gap_max", "longest gap", "s", "{:.1f}",
     "", "the longest hole is longer than the references' (the pacing axis); texture.py fills it where the picture "
         "moves"),
    ("spread_db", "level spread of gestures (P90 - P10)", "dB", "{:.1f}",
     "the loud and the quiet sounds are close: raise the big moments, lower the ticks (the hierarchy axis)",
     "more spread than the references: the quietest sounds may vanish on a phone speaker"),
    ("typ_db", "typical gesture vs the loudest", "dB", "{:+.1f}",
     "most sounds sit far under the loudest one: one hit sets the level; bring the small sounds up or that hit down",
     "most sounds sit close to the loudest: little hierarchy"),
    ("first_s", "first sound", "s", "{:.2f}",
     "", "the first sound comes later than in the references (the hook axis)"),
    ("low_share", "gestures with low end", "%", "{:.0f}",
     "few gestures carry low end: sub_drop under the heavy hits (suggest_cues layers them)",
     "nearly every gesture has low end: the small sounds may be heavier than they need to be (the low-end axis)"),
    ("bed", "sub bed 30-100 Hz present", "% of time", "{:.0f}",
     "no steady low bed; the references hold one in most reels: bed.py puts a long dark real ambience under the film "
     "(a film whose sound is only SFX)", "a steady low bed under the film: check the low-end axis"),
    ("floor_db", "the quietest tenth under the loudest, dB", "dB", "{:+.1f}",
     "the film falls far under its own sounds between them (the references do not): bed.py puts a steady layer "
     "under the film; texture.py fills the holes where the picture moves",
     "the film never gets quiet: the references have a floor, a bed this loud may be masking the small sounds"),
    ("silent", "digital silence, % of time", "%", "{:.0f}",
     "", "stretches of digital silence (the references have none): bed.py, or a tail that rings on (see the pacing "
         "axis for the holes)"),
    ("lufs", "loudness of this file", "LUFS", "{:.1f}",
     "quieter than the references (the loudness axis judges the film)", "louder than the references (the loudness axis)"),
)
LABELS = {k: (lab, unit, fmt, lo, hi) for k, lab, unit, fmt, lo, hi in MEASURES}


# ---------------------------------------------------------------------------------------------------- measuring
def _band(path, af, rate=2000):
    import array
    r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "1", "-ar", str(rate),
                        "-af", af, "-f", "s16le", "-"], capture_output=True)
    a = array.array("h")
    a.frombytes(r.stdout[: len(r.stdout) // 2 * 2])
    return a


def bed_share(path):
    """Share of the film where a steady low bed (30-100 Hz) is present: 100 ms windows within 20 dB of the strongest
    low moment of the file. One drop that rings for a second is a few percent; a drone under the film is most of it."""
    x = _band(path, "highpass=f=30,lowpass=f=100")
    w = 200
    if len(x) < 4 * w:
        return None
    lv = []
    for i in range(0, len(x) - w + 1, w):
        e = math.sqrt(sum(v * v for v in x[i:i + w]) / w) / 32768.0
        lv.append(20 * math.log10(e) if e > 1e-6 else -120.0)
    top = max(lv)
    if top < -70.0:
        return 0.0
    return 100.0 * sum(1 for v in lv if v >= top - 20.0) / len(lv)


def sound_events(path, full=None):
    """(full, full_env, events) of an audio file: the decoded track (16 kHz mono), its 10 ms envelope in dB, and the
    sound events (sharp rises of the level, high band and low band)."""
    import learn_style as L
    full = full if full is not None else L.decode(path)
    full_env = L.env_db(full)
    hi_env = L.env_db(L.decode(path, "highpass=f=400"))
    lo_env = L.env_db(L.decode(path, "lowpass=f=150"))
    ev = L.merge_events(L.audio_events(hi_env, lo_env, min_rise=9.0, floor=-55.0),
                        L.audio_events(lo_env, lo_env, min_rise=10.0, floor=-45.0))
    return full, full_env, ev


def group_gestures(ev):
    """Events closer than GESTURE_GAP are one gesture: [[event, ...], ...]."""
    ges, cur = [], []
    for e in ev:
        if cur and e["t"] - cur[-1]["t"] <= GESTURE_GAP:
            cur.append(e)
        else:
            if cur:
                ges.append(cur)
            cur = [e]
    if cur:
        ges.append(cur)
    return ges


def gestures(path):
    """([{t, on, t0, on0, pk, n, low}], seconds) for one audio file, by the detector of measure(): t = the time of the
    loudest point of the gesture's loudest event (a riser or a lead-in starts earlier, the sync point is the hit), on =
    when that event came within 10 dB of its peak (its onset: what a designer puts on the picture), t0 / on0 the same
    for the gesture's first event, pk = its level in dBFS (the loudest 10 ms), n = events in it, low = low end."""
    full, _env, ev = sound_events(path)
    out = []
    for g in group_gestures(ev):
        loud = max(g, key=lambda e: e["level"])
        out.append({"t": loud["t"], "on": round(max(0.0, loud["t"] - loud.get("build_ms", 0) / 1000.0), 3),
                    "t0": g[0]["t"], "on0": round(max(0.0, g[0]["t"] - g[0].get("build_ms", 0) / 1000.0), 3),
                    "pk": round(loud["level"], 1), "n": len(g), "low": any(e["band"] in ("lo", "both") for e in g)})
    import learn_style as L
    return out, len(full) / L.RATE


# A 250 ms window under this is digital silence. It was -55 until a bed of -54 dBFS (what the listener chose: -56 and
# -50 "good", -44 "loud") counted as half silence by its own median.
SILENT_DB = -70.0


def measure(path, lufs=None, with_lufs=True):
    """The measures of MEASURES for one audio file (a film's mp4 or an SFX track). `lufs` overrides the file's own
    loudness (the film's final figure when `path` is its SFX track); with_lufs=False leaves the loudness out (an SFX
    track is measured before the master gain: its own figure says nothing about the film)."""
    import learn_style as L
    full = L.decode(path)
    dur = len(full) / L.RATE
    if dur < 1.0:
        return {"dur": round(dur, 2)}
    full, full_env, ev = sound_events(path, full)
    out = {"dur": round(dur, 2), "events10": round(len(ev) / dur * 10, 2)}
    if not ev:
        out.update({"gest10": 0.0, "gap_max": round(dur, 1)})
    else:
        ges = group_gestures(ev)
        times = [g[0]["t"] for g in ges]
        gaps = [b - a for a, b in zip([0.0] + times, times + [dur])]
        sg = sorted(gaps)

        def pct(v, q):
            return v[min(len(v) - 1, max(0, int(round(q * (len(v) - 1)))))]
        lv = []
        for g in ges:                                      # the full-band level of the gesture's loudest 10 ms
            i0, i1 = int((g[0]["t"] - 0.03) * 100), int((g[-1]["t"] + 0.15) * 100) + 1
            seg = full_env[max(0, i0):min(len(full_env), i1 + 1)]
            lv.append(max(seg) if seg else -100.0)
        out.update({
            "gest10": round(len(ges) / dur * 10, 2), "gap_med": round(statistics.median(gaps), 2),
            "gap_p90": round(pct(sg, 0.9), 2), "gap_max": round(max(gaps), 1), "first_s": round(times[0], 2),
            "low_share": round(100.0 * sum(1 for g in ges if any(e["band"] in ("lo", "both") for e in g)) / len(ges), 0),
            "n_gestures": len(ges)})
        if len(ges) >= 6:
            sl = sorted(lv)
            out["spread_db"] = round(pct(sl, 0.9) - pct(sl, 0.1), 1)
            out["typ_db"] = round(statistics.median(lv) - max(lv), 1)
    # presence: 250 ms windows, the last half second (the fade-out of any film) left out
    env250 = L.env_db(full, 250)
    body = env250[: max(0, len(env250) - 2)]
    if len(body) >= 8:
        sb = sorted(body)
        out["floor_db"] = round(sb[int(0.1 * (len(sb) - 1))] - sb[-1], 1)
        out["silent"] = round(100.0 * sum(1 for v in body if v < SILENT_DB) / len(body), 0)
    b = bed_share(path)
    if b is not None:
        out["bed"] = round(b, 0)
    try:
        v = lufs if lufs is not None else (measure_loudness(path).get("lufs") if with_lufs else None)
    except Exception:
        v = None
    if v is not None:
        out["lufs"] = round(float(v), 1)
    return out


# ---------------------------------------------------------------------------------------------------- styles
def aggregate(per_ref):
    """{key: {median, p25, p75, min, max, n}} over the references that have the measure."""
    agg = {}
    for k, *_ in MEASURES:
        v = sorted(r[k] for r in per_ref if r.get(k) is not None)
        if v:
            q = statistics.quantiles(v, n=4, method="inclusive") if len(v) >= 4 else [v[0], statistics.median(v), v[-1]]
            agg[k] = {"median": round(statistics.median(v), 2), "p25": round(q[0], 2), "p75": round(q[2], 2),
                      "min": v[0], "max": v[-1], "n": len(v)}
    return agg


def find_style(name):
    """$REAL_SFX_STYLES/NAME.json (a folder named by the environment: the re-sound test uses it to hand an agent the
    references WITHOUT the reel it is sounding), then styles/NAME.json (learned on this machine), then
    references/profiles/NAME.json (shipped). The first file that carries measures wins; an older style without them is
    returned only when nothing better exists."""
    import os
    fallback = (None, None)
    where = [SKILL_DIR / "styles" / f"{name}.json", SKILL_DIR / "references" / "profiles" / f"{name}.json"]
    if os.environ.get("REAL_SFX_STYLES"):
        where.insert(0, Path(os.environ["REAL_SFX_STYLES"]) / f"{name}.json")
    for p in where:
        if p.exists():
            try:
                d = json.loads(p.read_text(encoding="utf-8"))
            except ValueError:
                continue
            if d.get("measures"):
                return d, p
            if fallback[0] is None:
                fallback = (d, p)                           # an older style: the caller says it has no measures
    return fallback


def compare(m, style):
    """Rows for the measures both sides have. `where`: inside (the middle half of the references), low/high (outside
    the middle half, still inside the references' range), BELOW/ABOVE (outside every reference)."""
    ref = (style or {}).get("measures") or {}
    rows = []
    for k, label, unit, fmt, lo_hint, hi_hint in MEASURES:
        v, r = m.get(k), ref.get(k)
        if v is None or not r or r.get("n", 0) < 3:
            continue
        lo, hi, med = r["min"], r["max"], r["median"]
        q1, q3 = r.get("p25", lo), r.get("p75", hi)
        pad = max(0.05 * (hi - lo), 0.02 * abs(med), 0.05)     # a hair outside the range is not "outside"
        if v < lo - pad:
            where = "BELOW"
        elif v > hi + pad:
            where = "ABOVE"
        elif v < q1 - 1e-9:
            where = "low"
        elif v > q3 + 1e-9:
            where = "high"
        else:
            where = "inside"
        lever = lo_hint if where in ("BELOW", "low") else hi_hint if where in ("ABOVE", "high") else ""
        span = max(q3 - q1, 0.05 * abs(med), 0.05)             # how far out, in widths of the middle half
        off = 0.0 if where == "inside" else (q1 - v if where in ("BELOW", "low") else v - q3) / span
        rows.append({"key": k, "label": label, "unit": unit, "fmt": fmt, "value": v, "median": med, "p25": q1,
                     "p75": q3, "min": lo, "max": hi, "n": r["n"], "where": where, "lever": lever,
                     "off": round(off, 2)})
    return rows


def render(rows, style, note=None):
    if not rows:
        return []
    name = style.get("name", "?")
    n = style.get("n_refs") or max(r["n"] for r in rows)
    durs = [r.get("dur") or r.get("duration") for r in style.get("per_ref", []) if r.get("dur") or r.get("duration")]
    span = f", {min(durs):.0f}-{max(durs):.0f} s" if durs else ""
    lines = [f"Against the reference style '{name}' ({n} finished videos{span}). Not scored: it says where this film "
             f"differs, not that it is better or worse."]
    lines.append(f"  {'measure':38s} {'this film':>10s}   {'reference: median (middle half) [range]':44s} where")
    for r in rows:
        f = r["fmt"]
        unit = {"": "", "%": "%"}.get(r["unit"], f" {r['unit']}")
        cell = f"{f.format(r['value'])}{unit}"
        refc = (f"{f.format(r['median'])} ({f.format(r['p25'])} .. {f.format(r['p75'])}) "
                f"[{f.format(r['min'])} .. {f.format(r['max'])}]")
        lines.append(f"  {r['label']:38s} {cell:>10s}   {refc:44s} {r['where']}")
    out = [r for r in rows if r["where"] != "inside" and r["lever"]]
    out.sort(key=lambda r: -r["off"])
    if out:
        lines.append("  What usually moves these (farthest from the references first):")
        for r in out[:4]:
            side = {"BELOW": "below every reference", "ABOVE": "above every reference",
                    "low": "on the low side of the references", "high": "on the high side of the references"}[r["where"]]
            lines.append(f"   - {r['label']}: {side}; {r['lever']}")
    if note:
        lines.append("  " + note)
    return lines


# ---------------------------------------------------------------------------------------------------- CLI
def export(src, dst):
    d = json.loads(Path(src).read_text(encoding="utf-8"))
    if not d.get("measures"):
        sys.exit(f"{src} has no 'measures': learn it again with this version of learn_style.py")
    # no file names of the references: they are somebody's videos, and a shareable profile needs only the numbers
    keep = {"name": d.get("name"), "n_refs": d.get("n_refs"), "basis": d.get("basis"), "note": d.get("note"),
            "measures": d["measures"],
            "per_ref": [{"file": f"reference {i}", "dur": r.get("duration"), **r.get("measures", {})}
                        for i, r in enumerate(d.get("per_ref", []), 1)]}
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    Path(dst).write_text(json.dumps(keep, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{dst}: {len(keep['per_ref'])} references, {len(keep['measures'])} measures")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("file", nargs="?", help="a film (mp4) or an SFX track (wav)")
    ap.add_argument("--style", default="clean-sfx-refs")
    ap.add_argument("--lufs", type=float, help="the loudness to report instead of the file's own")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--export", metavar="STYLE_JSON", help="write a compact shippable profile of a learned style")
    ap.add_argument("--out", help="with --export: the destination")
    a = ap.parse_args()
    if a.export:
        if not a.out:
            sys.exit("--export needs --out FILE")
        export(a.export, a.out)
        return
    if not a.file:
        ap.error("a file to measure is required")
    style, p = find_style(a.style)
    if style is None:
        sys.exit(f"style '{a.style}' not found (styles/{a.style}.json or references/profiles/{a.style}.json)")
    if not style.get("measures"):
        sys.exit(f"style '{a.style}' ({p}) was learned before the measures existed: run learn_style.py on the same "
                 f"references again")
    is_film = Path(a.file).suffix.lower() in (".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi")
    m = measure(a.file, lufs=a.lufs, with_lufs=is_film or a.lufs is not None)
    rows = compare(m, style)
    if a.json:
        print(json.dumps({"measures": m, "rows": rows}, ensure_ascii=False))
        return
    print("\n".join(render(rows, style, style.get("note"))))


if __name__ == "__main__":
    main()
