#!/usr/bin/env python3
"""Read the moments straight out of a HyperFrames composition (no rendering, no frame analysis).

  python from_hyperframes.py path/to/project/index.html --out work/moments.json [--video render.mp4]

Timings are exact because they come from the composition itself:
  * every scene (a timed element directly under the root, or a sub-composition host) -> a "cut" at its start
  * every other timed element (`data-start`)                                        -> an "onset"
  * every GSAP tween on a registered timeline with a numeric/relative position      -> "onset" (entrances),
    "burst" (fast moves/scales), exits are ignored
Relative starts (`data-start="intro + 2"`), sub-compositions (offsets are added up) and GSAP positions
("<", ">", "+=0.3", labels) are resolved. Anything it cannot resolve is reported, never guessed.

The output has the same shape as find_moments.py's moments.json, so suggest_cues.py, mix.py and
critique.py work on it unchanged. `hint` carries the element's id/classes/text so UI cues can be chosen.
"""
import os
import argparse
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

VOID = {"br", "hr", "img", "input", "meta", "link", "source", "area", "base", "col", "embed", "track", "wbr"}
STRONG = ("title", "headline", "logo", "hero", "cta", "h1", "wordmark", "brand")
MEDIUM = ("card", "panel", "modal", "stat", "number", "counter", "button", "btn", "badge", "chart", "icon", "device")
WEAK = ("caption", "subtitle", "sub", "text", "label", "body", "copy", "bg", "background", "shape")


class Collector(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.elements, self.scripts, self._script = [], [], [], None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "script":
            self._script = []
            return
        el = {"tag": tag, "attrs": a, "depth": len(self.stack), "text": "", "parent": self.stack[-1] if self.stack else None}
        self.elements.append(el)
        if tag not in VOID:
            self.stack.append(el)

    def handle_endtag(self, tag):
        if tag == "script":
            if self._script is not None:
                self.scripts.append("".join(self._script))
            self._script = None
            return
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i]["tag"] == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        if self._script is not None:
            self._script.append(data)
        elif self.stack:
            for el in self.stack:
                if len(el["text"]) < 60:
                    el["text"] = (el["text"] + " " + data.strip()).strip()


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def hint_of(el):
    a = el["attrs"]
    bits = [a.get("id", ""), a.get("class", "").replace("clip", ""), el["tag"], (el.get("text") or "")[:30]]
    return " ".join(b for b in bits if b).strip()


def strength_of(hint, dur=None):
    h = hint.lower()
    if any(k in h for k in STRONG):
        return 0.9
    if any(k in h for k in MEDIUM):
        return 0.7
    if any(k in h for k in WEAK):
        return 0.4
    return 0.55


# ------------------------------------------------------------------ GSAP tweens (best effort)
def split_args(s):
    """Split a call's argument text on top-level commas."""
    out, depth, cur, q = [], 0, [], None
    i = 0
    while i < len(s):
        ch = s[i]
        if q:
            cur.append(ch)
            if ch == "\\":
                cur.append(s[i + 1])
                i += 1
            elif ch == q:
                q = None
        elif ch in "\"'`":
            q = ch
            cur.append(ch)
        elif ch in "([{":
            depth += 1
            cur.append(ch)
        elif ch in ")]}":
            depth -= 1
            cur.append(ch)
        elif ch == "," and depth == 0:
            out.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
        i += 1
    if "".join(cur).strip():
        out.append("".join(cur).strip())
    return out


def find_calls(js):
    """Yield (method, [args]) for .to/.from/.fromTo/.set/.addLabel calls in source order."""
    for m in re.finditer(r"\.(to|from|fromTo|set|addLabel)\s*\(", js):
        i, depth, q = m.end(), 1, None
        while i < len(js) and depth:
            ch = js[i]
            if q:
                if ch == "\\":
                    i += 1
                elif ch == q:
                    q = None
            elif ch in "\"'`":
                q = ch
            elif ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            i += 1
        yield m.group(1), split_args(js[m.end():i - 1])


def tween_moments(js, offset, warn):
    """Return moments from the GSAP calls of one script, times shifted by offset (sub-composition start)."""
    out, labels, cursor, prev_start = [], {}, 0.0, 0.0
    for method, args in find_calls(js):
        if method == "addLabel":
            if args:
                name = args[0].strip("\"'`")
                pos = args[1] if len(args) > 1 else None
                labels[name] = num(pos) if num(pos) is not None else cursor
            continue
        if method == "set":
            continue
        if not args:
            continue
        pos_arg = args[3] if method == "fromTo" and len(args) > 3 else (args[2] if method != "fromTo" and len(args) > 2 else None)
        vars_txt = args[2] if method == "fromTo" and len(args) > 2 else (args[1] if len(args) > 1 else "")
        dm = re.search(r"duration\s*:\s*([\d.]+)", vars_txt)
        dur = float(dm.group(1)) if dm else 0.5
        # --- position
        start = None
        if pos_arg is None:
            start = cursor
        else:
            p = pos_arg.strip().strip("\"'`")
            if num(p) is not None:
                start = float(p)
            elif p == "<":
                start = prev_start
            elif p == ">":
                start = cursor
            elif re.fullmatch(r"<[+-]?[\d.]+", p):
                start = prev_start + float(p[1:])
            elif re.fullmatch(r">[+-]?[\d.]+", p):
                start = cursor + float(p[1:])
            elif re.fullmatch(r"[+-]=[\d.]+", p):
                start = cursor + (float(p[2:]) if p[0] == "+" else -float(p[2:]))
            else:
                lm = re.fullmatch(r"([A-Za-z_][\w-]*)(?:([+-])=([\d.]+))?", p)
                if lm and lm.group(1) in labels:
                    start = labels[lm.group(1)] + (float(lm.group(3)) * (1 if lm.group(2) == "+" else -1) if lm.group(3) else 0)
        if start is None:
            warn.append(f"GSAP position not understood: {pos_arg!r}")
            continue
        prev_start = start
        cursor = max(cursor, start + dur)
        tgt = args[0].strip()
        target = tgt.strip("\"'`") if tgt[:1] in "\"'`" else tgt
        low = vars_txt.lower()
        entering = method in ("from", "fromTo") and bool(re.search(r"opacity|autoalpha|scale|\by\b|\bx\b|yPercent|xPercent|clip", vars_txt))
        exiting = method == "to" and re.search(r"(opacity|autoalpha)\s*:\s*0\b", low)
        moving = method == "to" and re.search(r"\b(x|y|xpercent|ypercent|scale|rotation|rotate)\s*:", low)
        if exiting:
            continue
        if not (entering or moving):
            continue
        hint = re.sub(r"[#.\[\]=\"'>~+*]", " ", target).strip()
        st = strength_of(hint)
        kind = "onset" if entering else "burst"
        if dur <= 0.25 and kind == "burst":
            st = min(1.0, st + 0.15)
        out.append({"t": round(offset + start, 3), "kind": kind, "strength": round(st, 2), "hint": hint[:60],
                    "source": "gsap", "tween_s": round(dur, 2)})
    return out


# ------------------------------------------------------------------ composition tree
def load(path, offset, depth, warn, seen):
    path = Path(path)
    if path in seen or depth > 6 or not path.exists():
        if not path.exists():
            warn.append(f"sub-composition not found: {path}")
        return [], [], None
    seen = seen | {path}
    text = path.read_text(encoding="utf-8", errors="replace")
    p = Collector()
    p.feed(text)
    els = p.elements
    root = next((e for e in els if "data-composition-id" in e["attrs"]), None)
    root_dur = num(root["attrs"].get("data-duration")) if root else None
    starts, ends = {}, {}
    ids = {e["attrs"]["id"]: e for e in els if "id" in e["attrs"]}

    def resolve(el, stack=()):
        a = el["attrs"]
        raw = a.get("data-start")
        if raw is None:
            return None
        if num(raw) is not None:
            return float(raw)
        m = re.fullmatch(r"\s*([\w-]+)\s*(?:([+-])\s*([\d.]+))?\s*", raw)
        if not m or m.group(1) not in ids or m.group(1) in stack:
            warn.append(f"unresolved data-start={raw!r}")
            return 0.0
        ref = ids[m.group(1)]
        s = resolve(ref, stack + (m.group(1),))
        d = num(ref["attrs"].get("data-duration"))
        base = (s or 0.0) + (d if d is not None else 0.0)
        if m.group(2):
            base += float(m.group(3)) * (1 if m.group(2) == "+" else -1)
        return base

    clips = []
    for el in els:
        if "data-start" not in el["attrs"] or el["tag"] in ("audio",):
            continue
        s = resolve(el)
        if s is None:
            continue
        d = num(el["attrs"].get("data-duration"))
        clips.append({"el": el, "start": s, "dur": d})

    moments, subs = [], []
    root_children = [c for c in clips if c["el"]["parent"] is root]
    for c in clips:
        el, a = c["el"], c["el"]["attrs"]
        t = offset + c["start"]
        # inside a sub-composition the root's children are elements of that scene, not scenes of the film
        is_scene = depth == 0 and c in root_children and (c["dur"] or 0) >= 0.5
        h = hint_of(el)
        if "data-composition-src" in a:
            sub_path = path.parent / a["data-composition-src"]
            sm, _, sdur = load(sub_path, t, depth + 1, warn, seen)
            subs.append(sm)
            moments.append({"t": round(t, 3), "kind": "cut", "strength": 0.85, "hint": h, "source": "scene",
                            "scene_s": c["dur"]})
        elif is_scene:
            moments.append({"t": round(t, 3), "kind": "cut", "strength": 0.85, "hint": h, "source": "scene",
                            "scene_s": c["dur"]})
        elif el["tag"] not in ("video",):
            moments.append({"t": round(t, 3), "kind": "onset", "strength": strength_of(h), "hint": h,
                            "source": "clip", "tween_s": c["dur"]})
    for js in p.scripts:
        if "gsap" in js or ".to(" in js or ".from(" in js:
            moments += tween_moments(js, offset, warn)
    for sm in subs:
        moments += sm
    return moments, clips, root_dur


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("composition", help="index.html or the project folder")
    ap.add_argument("--out", required=True)
    ap.add_argument("--video", help="rendered video of this composition (needed later by mix.py)")
    ap.add_argument("--merge-ms", type=float, default=60, help="merge moments of the same kind closer than this")
    a = ap.parse_args()

    p = Path(a.composition)
    if p.is_dir():
        p = p / "index.html"
    if not p.exists():
        sys.exit(f"composition not found: {p}")
    warn = []
    moments, clips, root_dur = load(p, 0.0, 0, warn, frozenset())

    # the first scene at t=0 is the hook, not a cut
    for m in moments:
        if m["kind"] == "cut" and m["t"] < 0.05:
            m["kind"], m["strength"] = "onset", 0.8
    moments.sort(key=lambda m: (m["t"], -m["strength"]))
    merged = []
    for m in moments:
        near = next((x for x in reversed(merged) if abs(x["t"] - m["t"]) * 1000 <= a.merge_ms), None)
        if near and (near["kind"] == m["kind"] or {near["kind"], m["kind"]} == {"cut", "onset"}):
            if m["strength"] > near["strength"] or (m["kind"] == "cut" and near["kind"] == "onset"):
                near.update(m)
            continue
        merged.append(m)
    tmax = max((m["t"] for m in merged), default=0.0)
    dur = root_dur or max(tmax + 1.0, 1.0)
    merged = [m for m in merged if m["t"] <= dur + 0.001]
    ranked = sorted(m["strength"] for m in merged)
    for i, m in enumerate(merged):
        m["id"] = i
        m["pct"] = round(sum(1 for s in ranked if s <= m["strength"]) / max(1, len(ranked)), 2)

    res = {"video": str(Path(a.video).resolve()) if a.video else None, "composition": str(p.resolve()),
           "info": {"duration": dur, "source": "hyperframes", "has_audio": None},
           "moments": merged, "warnings": sorted(set(warn))}
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    kinds = {}
    for m in merged:
        kinds[m["kind"]] = kinds.get(m["kind"], 0) + 1
    print(f"{p.name}: {dur:.1f} s, {len(merged)} moments ({', '.join(f'{k}={v}' for k, v in kinds.items())}), "
          f"{len(clips)} timed elements")
    for w in res["warnings"]:
        print("WARN", w)
    if len(merged) <= 2 and len(clips) <= 3:
        # one element, no timeline tweens: the film is drawn by a script (a function of time), so the HTML holds
        # no timings. Look for the project's own cue list, else the picture is the only source.
        proj = p.parent
        found = [proj / rel for rel in ("docs/cues.json", "cues.json", "scripts/cues.json", "sfx/cues.json",
                                         "src/cues.json", "docs/sfx_cues.json", "sound_cues.json",
                                         "docs/sound_cues.json") if (proj / rel).exists()]
        if not found:                      # a bounded search: any cues*.json / *sfx*.json that looks like a list
            skip = {"node_modules", ".git", ".hyperframes", "renders", "assets", "dist", "snapshots", "vendor"}
            for dp, dns, fns in os.walk(proj):
                dns[:] = [d for d in dns if d not in skip and len(Path(dp, d).relative_to(proj).parts) < 3]
                for fn in fns:
                    if fn.lower().endswith(".json") and ("cue" in fn.lower() or "sfx" in fn.lower()):
                        found.append(Path(dp) / fn)
        print("NOTE: the composition has one timed element and no tweens: the timing lives in a script, not in the HTML.")
        if found:
            try:
                from from_cues import load_events
                ev = load_events(found[0])
            except Exception:
                ev = []
            kinds = sorted({e["kind"] for e in ev})
            print(f"      found a cue list: {found[0]} ({len(ev)} events: {', '.join(kinds[:12])})")
            print(f"      use it: python scripts/from_cues.py \"{found[0]}\" --video RENDER.mp4 --out work/cues.json")
        else:
            print("      no cue list in the project. Take the moments from the render: "
                  "python scripts/find_moments.py RENDER.mp4 --out work/moments")
    if len(merged) <= 2 and len(clips) >= 6:
        print(f"NOTE: {len(clips)} timed elements but only {len(merged)} moment(s): the motion of this film does not "
              f"run on data-start (a script computes it, often with its own time map). Its sound is probably made "
              f"by a script too: python scripts/from_synth.py {p.parent} --dry   (or from_cues.py {p.parent} "
              f"--video RENDER.mp4 --out work/cues.json), else find_moments.py on the render.")
    if not a.video:
        print("note: render the composition and pass --video (or put the path into the cue sheet) before mix.py")
    print("->", a.out)


if __name__ == "__main__":
    main()
