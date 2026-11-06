#!/usr/bin/env python3
"""How loud is each new sound against the synthesized sound it replaces? (the author's own balance, event by event)

The layer match brings the WHOLE new layer to the integrated loudness of the old one. It cannot see that the ticks came
out 8 dB too loud and the bells 4 dB too quiet, or that typing stands 17 dB over the author's. This reads the
momentary loudness (BS.1770, 400 ms, K-weighted, every 100 ms) of both layers around every event and says, per event,
how far the new sound is from the one the author mixed once the average offset is taken out.

  python levels.py RESOLVED.json SFX_TRACK.wav [--reference FILE ...] [--json OUT.json]

Importable: compare(cues, ref_files, new_track) -> (rows, overall_offset_db); edits(rows) -> a batch for sheet.py apply.
The reference is the synthesized layer the mix replaced: the stems from_cues subtracted (`_draft.reference_layer` of
the sheet) or the effects-only render of the project's script. Its gain inside the mix does not matter: only the
differences between events count.
"""
import argparse
import bisect
import json
import math
import re
import statistics
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import load_json

SILENT = -60.0


def momentary(path):
    """[(t, M LUFS)] every 100 ms: the loudness of the 400 ms that ENDS at t. Silence is -200."""
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-nostdin", "-i", str(path), "-vn", "-af",
                        "ebur128=framelog=info", "-f", "null", "-"], capture_output=True, text=True, errors="replace")
    out = []
    for m in re.finditer(r"t:\s*([\d.]+)\s+TARGET:\s*-?\d+\s+LUFS\s+M:\s*(-?[\d.]+|-inf)", r.stderr):
        v = -200.0 if m.group(2) == "-inf" else float(m.group(2))
        out.append((float(m.group(1)), max(-200.0, v)))
    return out


def combine(series_list, gains_db=None):
    """Energy sum of several momentary series on their common 100 ms grid (a layer made of several stems)."""
    acc = {}
    for k, s in enumerate(series_list):
        g = (gains_db or [0.0] * len(series_list))[k]
        for t, v in s:
            key = round(t * 10)
            acc[key] = acc.get(key, 0.0) + (10 ** ((v + g) / 10.0) if v > -150 else 0.0)
    return [(k / 10.0, 10 * math.log10(e) if e > 0 else -200.0) for k, e in sorted(acc.items())]


def level_in(series, t0, t1):
    """The loudest momentary value of the windows that contain the first 100 ms .. 0.5 s after the event began."""
    if not series:
        return None
    ts = [t for t, _ in series]
    i0 = bisect.bisect_left(ts, t0 + 0.1)
    i1 = bisect.bisect_right(ts, t1 + 0.5)
    vals = [v for _, v in series[i0:i1]]
    return max(vals) if vals else None


def groups(cues, run_gap=0.3, layer_gap=0.08):
    """Events as a listener hears them: a run of the same kind (typing, ticks) and the layers of one moment are one
    group. [{t0, t1, kind, n}]. A texture sound (texture.py) has no sound of the author's to be matched against."""
    main = sorted((c for c in cues if not c.get("_layer") and not c.get("texture")), key=lambda c: c["t"])

    def kind_of(c):
        w = str(c.get("label", "")).split()
        return (w[0] if w else c.get("role") or "?").lower()

    out = []
    for c in main:
        k = kind_of(c)
        g = out[-1] if out else None
        if g and ((k == g["kind"] and c["t"] - g["t1"] <= run_gap) or c["t"] - g["t1"] <= layer_gap):
            g["t1"] = max(g["t1"], c["t"])
            g["n"] += 1
        else:
            out.append({"t0": c["t"], "t1": c["t"], "kind": k, "n": 1})
    return out


def compare(cues, ref_files, new_track, ref_gains_db=None):
    """Rows [{t0, t1, kind, n, ref, new, d, e}] and the overall offset D (median of d: how much quieter, in dB, the
    new layer is than the old one on average). e = d - D: what this event is off, once the average is taken out
    (positive: the new sound is too quiet against the author's balance, negative: too loud)."""
    ref = combine([momentary(f) for f in ref_files], ref_gains_db)
    new = momentary(new_track)
    rows = []
    for g in groups(cues):
        lr, ln = level_in(ref, g["t0"], g["t1"]), level_in(new, g["t0"], g["t1"])
        if lr is None or ln is None or lr < SILENT or ln < SILENT:
            continue
        rows.append(dict(g, ref=round(lr, 1), new=round(ln, 1), d=round(lr - ln, 1)))
    if not rows:
        return [], 0.0
    D = statistics.median(r["d"] for r in rows)
    for r in rows:
        r["e"] = round(r["d"] - D, 1)
    return rows, round(D, 1)


def edits(rows, min_db=1.5, max_db=8.0):
    """A batch for `sheet.py apply`: the gain that brings every group that is off by min_db or more to the author's
    balance (clamped to max_db)."""
    ops = []
    for r in rows:
        if abs(r["e"]) < min_db:
            continue
        g = round(max(-max_db, min(max_db, r["e"])) * 2) / 2.0
        if g == 0:
            continue
        sel = {"label": r["kind"]}
        if r["n"] > 1:
            sel["between"] = [round(r["t0"] - 0.01, 3), round(r["t1"] + 0.01, 3)]
        else:
            sel["at"] = round(r["t0"], 3)
        ops.append(dict(sel, gain=g))
    return ops


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("cues")
    ap.add_argument("track")
    ap.add_argument("--reference", nargs="+", help="the synthesized layer (default: _draft.reference_layer of the sheet)")
    ap.add_argument("--json", help="write the batch for sheet.py apply here")
    ap.add_argument("--min-db", type=float, default=1.5)
    ap.add_argument("--max-db", type=float, default=8.0)
    a = ap.parse_args()
    sheet = load_json(a.cues)
    ref = a.reference or (sheet.get("_draft") or {}).get("reference_layer") or []
    ref = [f for f in ref if Path(f).exists()]
    if not ref:
        sys.exit("no reference: the synthesized layer the sounds replace is not known for this sheet (from_cues "
                 "records it when it took the layer out; or give --reference FILE ...)")
    rows, D = compare(sheet["cues"], ref, a.track)
    if not rows:
        sys.exit("no event could be compared (silent in one of the two layers)")
    print(f"{len(rows)} events; the new layer is {D:+.1f} dB against the replaced one on average "
          f"(the layer match / master decide that; below is each event against that average)")
    by = {}
    for r in rows:
        by.setdefault(r["kind"], []).append(r["e"])
    print(f"{'kind':14s} {'events':>6} {'median':>7} {'worst':>7}   (e > 0: the new sound is too quiet against the author's)")
    for k, es in sorted(by.items(), key=lambda kv: -abs(statistics.median(kv[1]))):
        worst = max(es, key=abs)
        print(f"{k[:14]:14s} {len(es):6d} {statistics.median(es):+7.1f} {worst:+7.1f}")
    ops = edits(rows, a.min_db, a.max_db)
    if a.json:
        Path(a.json).parent.mkdir(parents=True, exist_ok=True)
        Path(a.json).write_text(json.dumps(ops, indent=1), encoding="utf-8")
    print(f"{len(ops)} event(s) are off by {a.min_db:g} dB or more" +
          (f": batch written to {a.json}  ->  sheet.py apply SHEET {a.json}, render again" if a.json and ops else
           ("" if ops else ": the balance is the author's")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
