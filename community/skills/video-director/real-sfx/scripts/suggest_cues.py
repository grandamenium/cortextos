#!/usr/bin/env python3
"""Draft a cue sheet from detected moments, following references/recipes.md.

  python suggest_cues.py work/moments/moments.json --out work/cues.json [--density 5] [--beats work/beats.json]

The draft is a starting point, not the answer: open the frames next to it (moments.json lists them),
delete what should stay quiet, and fix any moment the detector misread. It encodes the parts that are
the same in every video: what to leave out, hook in the first 2 s, no two sounds smeared together,
heavy moments layered, repeated roles varied in pitch, UI moments from uisfx.

Options
  --density N      sounds per 10 s of video (default 5; 'auto' = 60 % of the picture events per 10 s)
  --min-gap S      minimum spacing between two non-layer cues (default 0.35 s)
  --ui MODE        uisfx (default) or library: where UI moments come from
  --pack NAME      uisfx pack for UI cues (default from config.json)
  --beats FILE     beats.json from beats.py; cues get "beat_off_ms" so you can see what is on the pulse
  --no-layers      never add sub/air layers
"""
import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import load_config, load_json

KIND_BASE = {"cut": 1.0, "settle": 0.85, "onset": 0.7, "burst": 0.6}
PITCH_CYCLE = [0, -2, 2, -3, 1, -1]
UI_HINTS = [  # (substrings in the element hint, uisfx cue)
    (("toggle", "switch"), "toggle-on"), (("success", "done", "complete", "check"), "success"),
    (("error", "fail", "warning", "alert"), "error"), (("cart", "basket"), "add-to-cart"),
    (("message", "chat", "bubble", "reply"), "receive"), (("button", "cta", "click", "press"), "press"),
    (("notification", "toast", "badge"), "notification"), (("card", "panel", "modal", "sheet", "window", "popup"), "open"),
    (("menu", "dropdown", "expand", "accordion"), "expand"), (("coin", "price", "buy", "pay", "checkout"), "purchase"),
    (("progress", "loader", "loading", "percent"), "progress-step"),
]
UI_ROTATION = ["select", "open", "expand", "check", "notification"]


def ui_cue(hint, k):
    h = (hint or "").lower()
    for keys, cue in UI_HINTS:
        if any(x in h for x in keys):
            return cue
    return UI_ROTATION[k % len(UI_ROTATION)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("moments")
    ap.add_argument("--out", required=True)
    ap.add_argument("--density", default="5")
    ap.add_argument("--min-gap", type=float, default=0.35)
    ap.add_argument("--ui", choices=["uisfx", "library"], default="uisfx")
    ap.add_argument("--pack")
    ap.add_argument("--beats")
    ap.add_argument("--no-layers", action="store_true")
    a = ap.parse_args()

    cfg = load_config()
    pack = a.pack or cfg["uisfx"]["default_pack"]
    d = load_json(a.moments)
    moments = d["moments"]
    dur = d.get("info", {}).get("duration") or max((m["t"] for m in moments), default=0) + 1
    grid = load_json(a.beats) if a.beats else None
    if grid and not grid.get("usable"):
        print("note: the beat grid is not reliable (usable=false); beat offsets are shown but should not drive decisions")

    if a.density == "auto":
        per10 = len(moments) / dur * 10
        density = max(3.0, min(8.0, 0.6 * per10))
    else:
        density = float(a.density)
    cap = max(2, math.ceil(density * dur / 10.0))

    # --- which moments get a sound
    scored = []
    for m in moments:
        s = KIND_BASE.get(m["kind"], 0.5) * (0.4 + 0.6 * m.get("strength", 0.5))
        if m["t"] <= 2.0:
            s *= 1.3                                    # the hook must not be silent
        scored.append((s, m))
    scored.sort(key=lambda x: (-x[0], x[1]["t"]))
    chosen = []
    for s, m in scored:
        if len(chosen) >= cap:
            break
        if all(abs(m["t"] - c["t"]) >= a.min_gap for _, c in chosen):
            chosen.append((s, m))
    chosen.sort(key=lambda x: x[1]["t"])
    skipped = [m for _, m in scored if m not in [c for _, c in chosen]]

    # --- turn them into cues
    cues, count = [], {}
    # an impact on every cut turns the film into a drum machine: only the top third of the chosen cuts get one
    cut_ranks = sorted((m.get("pct", m.get("strength", 0)) for s, m in chosen if m["kind"] == "cut"), reverse=True)
    pct_cut = cut_ranks[max(0, math.ceil(len(cut_ranks) / 3) - 1)] if cut_ranks else 1.0
    strong_cut_ids = {id(m) for s, m in chosen if m["kind"] == "cut"
                      and m.get("pct", m.get("strength", 0)) >= pct_cut and m.get("strength", 0) >= 0.6}
    ui_k = 0
    for i, (s, m) in enumerate(chosen):
        nxt = chosen[i + 1][1]["t"] - m["t"] if i + 1 < len(chosen) else 1.0
        kind, st, t = m["kind"], m.get("strength", 0.5), m["t"]
        base_gain = round(-7 + 5 * st, 1)
        label = f"{kind} {st:.2f}" + (f" [{m['hint']}]" if m.get("hint") else "")
        n_role = lambda r: count.setdefault(r, 0)

        def vary(role):
            k = count[role] = count.get(role, 0) + 1
            return PITCH_CYCLE[(k - 1) % len(PITCH_CYCLE)]

        if kind == "cut":
            cue = {"t": round(max(0.0, t - 0.05), 3), "label": label, "frame": m.get("frame"),
                   "pick": {"role": "whoosh", "target_dur": round(min(0.9, max(0.3, nxt * 0.8)), 2), "max_dur": 1.2},
                   "gain_db": base_gain - 2}
            p = vary("whoosh")
            if p:
                cue["pitch"] = p
            cues.append(cue)
            if id(m) in strong_cut_ids:
                hit = {"t": round(t + 0.015, 3), "label": label + " impact", "frame": m.get("frame"),
                       "pick": {"role": "hit", "punchy": True, "max_dur": 1.3}, "gain_db": base_gain}
                p = vary("hit")
                if p:
                    hit["pitch"] = p
                if not a.no_layers and m.get("pct", st) >= 0.8:
                    hit["layers"] = [{"dt": 0.0, "pick": {"role": "sub_drop", "max_dur": 1.8}, "gain_db": -7,
                                      "lowpass": 150}]
                cues.append(hit)
        elif kind == "settle":
            hit = {"t": round(t + 0.015, 3), "label": label, "frame": m.get("frame"),
                   "pick": {"role": "hit", "punchy": True, "max_dur": 1.2}, "gain_db": base_gain - 1}
            p = vary("hit")
            if p:
                hit["pitch"] = p
            if not a.no_layers and m.get("pct", st) >= 0.66 and st >= 0.5:
                hit["layers"] = [{"dt": 0.0, "pick": {"role": "sub_drop", "max_dur": 1.5}, "gain_db": -8, "lowpass": 150}]
            cues.append(hit)
        elif kind == "onset":
            if not m.get("hint") and st < 0.8:
                continue                       # a weak change with no named element: a blinking indicator, a caret
            if a.ui == "uisfx":
                cues.append({"t": round(t, 3), "label": label, "frame": m.get("frame"),
                             "uisfx": ui_cue(m.get("hint"), ui_k), "pack": pack, "gain_db": base_gain + 1})
                ui_k += 1
            else:
                cues.append({"t": round(t, 3), "label": label, "frame": m.get("frame"),
                             "pick": {"role": "click", "max_dur": 0.6, "punchy": True}, "gain_db": base_gain})
        else:  # burst
            cue = {"t": round(max(0.0, t - 0.03), 3), "label": label, "frame": m.get("frame"),
                   "pick": {"role": "whoosh", "target_dur": 0.4, "max_dur": 0.8}, "gain_db": base_gain - 3}
            p = vary("whoosh")
            if p:
                cue["pitch"] = p
            cues.append(cue)

    for c in cues:                         # torn paper is not a whoosh: prefer what the ears call one
        pk = c.get("pick")
        if pk and pk.get("role") == "whoosh":
            pk.setdefault("prefer_tag", "whoosh")
    if grid and grid.get("beats"):
        for c in cues:
            b = min(grid["beats"], key=lambda v: abs(v - c["t"]))
            c["beat_off_ms"] = round((c["t"] - b) * 1000)

    sheet = {"video": d.get("video"), "keep_audio": "auto", "cues": cues,
             "_draft": {"source": str(a.moments), "density_per_10s": density, "moments": len(moments),
                        "chosen": len(chosen), "skipped": len(skipped)}}
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(sheet, ensure_ascii=False, indent=1), encoding="utf-8")

    hook = [c for c in cues if c["t"] <= 2.0]
    print(f"{len(moments)} moments -> {len(chosen)} get a sound ({len(cues)} cues incl. impacts), "
          f"{len(skipped)} left quiet; target {density:g} per 10 s over {dur:.1f} s")
    print("hook (first 2 s):", "yes at " + ", ".join(f"{c['t']:.2f}s" for c in hook) if hook else
          "NONE: no moment in the first 2 s, consider adding one by hand")
    if skipped:
        weak = ", ".join(f"{m['t']:.1f}s {m['kind']}" for m in skipped[:10])
        print(f"left quiet (weakest/closest first): {weak}{' ...' if len(skipped) > 10 else ''}")
    print("->", a.out, "  (review the frames, then run mix.py)")


if __name__ == "__main__":
    main()
