#!/usr/bin/env python3
"""Check a HyperFrames composition before a render goes out: text sizes, reading time and motion frames.

Steps through the composition's timeline every 0.1 s in headless Chrome and records the size, weight and
visibility of every on-screen line, grouped by its data-text-role. Then, if a rendered video is given,
pulls frame strips at 8 fps around every move and cut for a person to look at.

Text roles (set data-text-role on the element that holds the words):
  opening   opening side text          line      the film's on-screen lines (top-center, mid, center)
  emphasis  an emphasised word         card      claim, chapter or title cards
  label     a label beside a thing     caption   captions of narration
  ui        the product's own text     name      a person's name bar
  ui-read   UI text the viewer must read (4%)
  typed     text typed into the product          legal     legal text

Measured candidates require visual/context review; fix or record a reasoned disposition:
  size       a role uses more than one size across the film, or a line mixes sizes inside it
  short      a line is fully readable for less than 1.0 s + 0.045 s per character (0.6 s base for 1-3 words)
  long       a line stays fully readable much longer than it needs (over 2.5x the floor and over floor + 3 s)
  small      text set below the floor for its role, as font size against frame height: lines, openings, cards
             and emphasis 3%; labels, captions, names, typed and UI text 2%; ui-read 4%; every role but legal and UI
             3% in a vertical frame (read on a phone); legal text is not checked
  typing     a typed element keeps growing for more than 2.0 s (two allowed exceptions in text-and-captions.md
             need judgment, so list them in the exceptions file)
  unroled    visible text with no data-text-role (the check can't group it)
  empty      a frame in a motion strip is nearly blank (possible empty card mid-transition)

Notes (printed, never block): caps, when on-screen lines use more than one capitalization pattern.

Reviews: a JSON list in <project>/render-check-exceptions.json, each {"check": "long", "match": "<selector or
role>", "sha256": "<current finding hash from render-check.json>", "reason": "actual contextual disposition"}.
Exact size/small/unroled errors cannot be waived. "match" must equal the finding's selector or role (or one element of a grouped finding);
add "text": true to match the line's text by substring instead. An entry with no reason accepts nothing and is
reported as an open finding.

Usage:
  python3 check_render.py build/ --motion --video output/cut-v3.mp4 --out output/checks-v3   # the full required check
  python3 check_render.py build/                         # text checks only
  python3 check_render.py build/ --role '.cap2=line' --role '.cap=opening'   # roles by selector where not set
  python3 check_render.py build/ --video output/cut-v3.mp4 --out output/checks-v3
Exit 0: complete measurements, no unresolved candidates; exit 2: review required; exit 1: input or measurement error.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from render_frames import find_chrome  # noqa: E402
import motion_check  # noqa: E402

LINE_ROLES = {"opening", "line", "card", "caption", "name"}
STEP = 0.1

PROBE = r"""
<script id="vd-probe-src">
(function () {
  const STEP = %(step)s;
  const ROLE_MAP = %(roles)s;
  function root() { return document.querySelector("[data-composition-id]"); }
  function timelines() {
    const all = window.__timelines || {};
    const id = root() && root().getAttribute("data-composition-id");
    if (id && all[id]) return [all[id]];
    return Object.values(all);
  }
  const clips = [...document.querySelectorAll("[data-start]")].filter(el => el !== root());
  function applyClips(t) {
    for (const el of clips) {
      const s = parseFloat(el.getAttribute("data-start")) || 0;
      const d = parseFloat(el.getAttribute("data-duration"));
      const on = t >= s - 1e-6 && (isNaN(d) || t < s + d - 1e-6);
      el.style.visibility = on ? "" : "hidden";
    }
  }
  function seek(t) { applyClips(t); for (const tl of timelines()) { tl.seek(t, false); } }
  function opacityChain(el) {
    let o = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden") return 0;
      o *= parseFloat(cs.opacity);
    }
    return o;
  }
  function onScreen(r) { return r.width > 1 && r.height > 1 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight; }
  function sel(el) {
    if (el.id) return "#" + el.id;
    let p = el.parentElement, path = el.tagName.toLowerCase();
    while (p && !p.id && p !== document.body) { path = p.tagName.toLowerCase() + ">" + path; p = p.parentElement; }
    return (p && p.id ? "#" + p.id + " " : "") + path;
  }
  function textSizes(el) {
    // font sizes of the text actually drawn inside el (descendant text nodes)
    const out = new Set(), walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) { const n = walker.currentNode; if (n.textContent.trim()) out.add(Math.round(parseFloat(getComputedStyle(n.parentElement).fontSize))); }
    return [...out];
  }
  function run() {
    for (const [selector, role] of ROLE_MAP) document.querySelectorAll(selector).forEach(el => { if (!el.hasAttribute("data-text-role")) el.setAttribute("data-text-role", role); });
    const r = root(); const dur = parseFloat(r && r.getAttribute("data-duration")) || 0;
    const els = [...document.querySelectorAll("[data-text-role]")];
    const textNodes = el => { const out = [], w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); while (w.nextNode()) if (w.currentNode.textContent.trim()) out.push(w.currentNode); return out; };
    const nodesOf = els.map(textNodes);
    // typed text is often written into the element as the timeline runs, so its text is read again at every step
    const typed = els.map(el => el.getAttribute("data-text-role") === "typed");
    const typedText = els.map(() => "");
    const samples = [], unroled = {};
    for (let i = 0; i * STEP <= dur + 1e-6; i++) {
      const t = +(i * STEP).toFixed(3); seek(t);
      const row = [];
      els.forEach((el, k) => {
        if (typed[k]) nodesOf[k] = textNodes(el);
        if (opacityChain(el) < 0.05) return;
        const rect = el.getBoundingClientRect(); if (!onScreen(rect)) return;
        // judge readability word by word: words fully shown, and words caught mid-fade
        const shown = [], partial = [];
        for (const n of nodesOf[k]) {
          const o = opacityChain(n.parentElement);
          if (o >= 0.95) shown.push(n.textContent.trim()); else if (o > 0.05) partial.push(n.textContent.trim());
        }
        if (!shown.length && !partial.length) return;
        if (typed[k] && shown.join(" ").length > typedText[k].length) typedText[k] = shown.join(" ").replace(/\s+/g, " ");
        const cs = getComputedStyle(el);
        const scale = el.offsetHeight ? rect.height / el.offsetHeight : 1;
        row.push([k, partial.length ? 0.5 : 1, Math.round(parseFloat(cs.fontSize)), Math.round(parseFloat(cs.fontSize) * scale), cs.fontWeight, textSizes(el), shown.join(" ").replace(/\s+/g, " ")]);
      });
      samples.push([t, row]);
      if (i %% 5 === 0) {
        const walker = document.createTreeWalker(r || document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const n = walker.currentNode, p = n.parentElement;
          if (!n.textContent.trim() || p.closest("[data-text-role]") || p.closest("script,style")) continue;
          if (opacityChain(p) < 0.5 || !onScreen(p.getBoundingClientRect())) continue;
          const s = sel(p); if (!unroled[s]) unroled[s] = { first: t, text: n.textContent.trim().slice(0, 60) };
        }
      }
    }
    const moves = [];
    for (const tl of timelines()) {
      if (!tl.getChildren) continue;
      for (const c of tl.getChildren(true, true, false)) {
        let start = c.startTime(), p = c.parent;
        while (p && p !== tl && p.startTime) { start += p.startTime(); p = p.parent; }
        const d = c.duration();
        if (d >= 0.15) moves.push([+start.toFixed(3), +(start + d).toFixed(3)]);
      }
    }
    const cuts = [...new Set(clips.map(el => parseFloat(el.getAttribute("data-start"))).filter(x => !isNaN(x) && x > 0))].sort((a, b) => a - b);
    const meta = els.map((el, k) => ({ role: el.getAttribute("data-text-role"), selector: sel(el), narrated: (el.hasAttribute("data-narrated") ? el.getAttribute("data-narrated") : root()?.getAttribute("data-narrated")) === "true", text: (typed[k] && typedText[k] ? typedText[k] : nodesOf[k].map(n => n.textContent.trim()).join(" ")).slice(0, 120) }));
    const out = document.createElement("script"); out.type = "application/json"; out.id = "vd-probe";
    out.textContent = JSON.stringify({ duration: dur, step: STEP, elements: meta, samples, unroled, moves, cuts, timelines: timelines().length });
    document.body.appendChild(out);
  }
  function go() { try { run(); } catch (e) { const out = document.createElement("script"); out.type = "application/json"; out.id = "vd-probe"; out.textContent = JSON.stringify({ error: String(e && e.stack || e) }); document.body.appendChild(out); } }
  window.addEventListener("load", () => setTimeout(() => (document.fonts ? document.fonts.ready : Promise.resolve()).then(go), 300));
})();
</script>
"""


def dump_with_script(index: Path, size: tuple[int, int], budget: int, script_html: str, result_id: str, timeout: int = 300) -> dict:
    """Load a copy of the composition with script_html appended, let it run, and return the JSON it writes
    into <script id=result_id>. The copy points back at the project with a <base> tag, so nothing is written there."""
    html = index.read_text(encoding="utf-8")
    # The HyperFrames runtime normally creates window.__timelines; define it so the composition can register its timeline.
    base = f'<base href="{index.parent.resolve().as_uri()}/"><script>window.__timelines = window.__timelines || {{}};</script>'
    html = re.sub(r"<head([^>]*)>", lambda m: f"<head{m.group(1)}>{base}", html, count=1, flags=re.I) if re.search(r"<head", html, re.I) else base + html
    html = re.sub(r"</body>", lambda m: script_html + m.group(0), html, count=1, flags=re.I) if re.search(r"</body>", html, re.I) else html + script_html
    with tempfile.TemporaryDirectory() as tmp:
        page = Path(tmp) / "probe.html"
        page.write_text(html, encoding="utf-8")
        cmd = [find_chrome(), "--headless=new", "--hide-scrollbars", "--disable-gpu", "--allow-file-access-from-files",
               "--autoplay-policy=no-user-gesture-required", f"--user-data-dir={tmp}/profile", f"--window-size={size[0]},{size[1]}",
               f"--virtual-time-budget={budget}", "--dump-dom", page.as_uri()]
        try:
            dom = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=True).stdout
        except subprocess.TimeoutExpired:
            sys.exit("FAIL: Chrome timed out while stepping the timeline")
    m = re.search(rf'<script type="application/json" id="{result_id}">(.*?)</script>', dom, re.S)
    if not m:
        sys.exit("FAIL: the probe produced no result. Does the composition load in Chrome (check its scripts and the "
                 "browser console with `npx hyperframes validate`), and does it finish loading within the time budget?")
    data = json.loads(m.group(1))
    if data.get("error"):
        sys.exit(f"FAIL: the probe hit an error: {data['error']}")
    return data


def run_probe(index: Path, size: tuple[int, int], budget: int, roles: list[tuple[str, str]]) -> dict:
    probe = PROBE % {"step": STEP, "roles": json.dumps(roles).replace("<", "\\u003c")}
    return dump_with_script(index, size, budget, probe, "vd-probe")


HEAD_ROLES = {"line", "opening", "card", "emphasis"}


def size_floor(role: str, vertical: bool) -> float | None:
    """Smallest font size for a role, as a share of frame height; None = not checked."""
    if role == "legal":
        return None
    if role == "ui-read":
        return 0.04
    ui = role == "ui" or role.startswith("ui-")
    if vertical and not ui:
        return 0.03
    return 0.03 if role in HEAD_ROLES else 0.02


def reading_floor(text: str) -> float:
    base = 0.6 if len(text.split()) <= 3 else 1.0
    return base + 0.045 * len(text)


def group_motion(findings: list[dict]) -> list[dict]:
    """Merge motion findings of one kind that happen at the same moment (a whole group of elements moving together)."""
    out: list[dict] = []
    for f in sorted(findings, key=lambda f: (f["check"], f["time"])):
        last = out[-1] if out else None
        if last and last["check"] == f["check"] and f["check"] != "flicker" and abs(f["time"] - last["_t"]) <= 0.3:
            last["_members"].append(f["selector"])
            continue
        f = dict(f); f["_t"] = f["time"]; f["_members"] = [f["selector"]]
        out.append(f)
    for f in out:
        m = f.pop("_members"); f.pop("_t")
        if len(m) > 1:
            f["selector"] = f"{len(m)} elements: " + ", ".join(m[:5]) + (" ..." if len(m) > 5 else "")
    return out


def summarise(data: dict) -> list[dict]:
    """One row per text element: role, size, weight, and when it is on screen."""
    els, rows_by = data["elements"], {}
    for t, row in data["samples"]:
        for k, op, css, rendered, weight, inner, shown in row:
            rows_by.setdefault(k, []).append((t, op, rendered, weight))
    out = []
    for k, el in enumerate(els):
        rows = rows_by.get(k)
        if not rows:
            out.append({**el, "size": None, "weight": None, "on": None})
            continue
        settled = [r for r in rows if r[1] >= 1] or rows
        sizes = [r[2] for r in settled]
        weights = [r[3] for r in settled]
        out.append({**el, "size": max(set(sizes), key=sizes.count), "weight": max(set(weights), key=weights.count),
                    "on": [rows[0][0], rows[-1][0]]})
    return out


def analyse(data: dict) -> list[dict]:
    els, samples, step = data["elements"], data["samples"], data["step"]
    findings: list[dict] = []
    per_el: dict[int, list] = {}
    for t, row in samples:
        for k, op, css, rendered, weight, inner, shown in row:
            per_el.setdefault(k, []).append((t, op, css, rendered, weight, inner, shown))

    # sizes per role, measured while each element is fully readable
    role_sizes: dict[str, dict[int, list]] = {}
    for k, rows in per_el.items():
        el = els[k]
        settled = [r for r in rows if r[1] >= 1] or rows
        sizes = [r[3] for r in settled]
        size = max(set(sizes), key=sizes.count)
        role_sizes.setdefault(el["role"], {}).setdefault(size, []).append((k, settled[0][0]))
        frame_h = data.get("frame", [0, 0])[1]
        floor = size_floor(el["role"], data.get("frame", [1, 0])[1] > data.get("frame", [1, 0])[0])
        if frame_h and floor and size and size < floor * frame_h:
            findings.append({"check": "small", "role": el["role"], "selector": el["selector"], "text": el["text"], "time": settled[0][0],
                             "detail": f"{size}px is {size / frame_h:.1%} of frame height; role '{el['role']}' needs at least {floor:.0%} ({floor * frame_h:.0f}px)"})
        inner = sorted({s for r in settled for s in r[5]})
        if el["role"] in {"line", "opening"} and len(inner) > 1:
            findings.append({"check": "size", "role": el["role"], "selector": el["selector"], "text": el["text"], "time": settled[0][0],
                             "detail": f"words inside this line use {len(inner)} sizes: {', '.join(str(s) + 'px' for s in inner)}"})
    for role, by_size in role_sizes.items():
        if len(by_size) > 1:
            parts = []
            for size, items in sorted(by_size.items()):
                where = ", ".join(f"{els[k]['selector']} at {t:.1f}s" for k, t in items[:4]) + (" ..." if len(items) > 4 else "")
                parts.append(f"{size}px ({where})")
            first_k, first_t = sorted(by_size.items())[0][1][0]
            findings.append({"check": "size", "role": role, "selector": f"role {role}", "text": "", "time": first_t,
                             "detail": f"role '{role}' uses {len(by_size)} sizes: " + "; ".join(parts)})

    # reading time for lines: time each settled text state (no word mid-fade) separately
    for k, rows in per_el.items():
        el = els[k]
        if el["role"] not in LINE_ROLES:
            continue
        states: list[list] = []   # [text, start, end]
        for t, op, css, rendered, weight, inner, shown in rows:
            if op < 1 or not shown:
                continue
            if states and states[-1][0] == shown and t - states[-1][2] <= step * 1.5:
                states[-1][2] = t
            else:
                states.append([shown, t, t])
        for i, (text, a, b) in enumerate(states):
            readable = b - a + step
            nxt = states[i + 1][0] if i + 1 < len(states) else None
            prev = states[i - 1][0] if i > 0 else None
            growing = nxt is not None and nxt.startswith(text) and len(nxt) > len(text)
            if growing:
                continue  # words still arriving; the full line is judged when it completes
            new_part = text
            if prev:
                pw, tw = prev.split(), text.split()
                common = 0
                while common < min(len(pw), len(tw)) and pw[common] == tw[common]:
                    common += 1
                if common:
                    new_part = " ".join(tw[common:]) or text
            spoken = el.get("narrated", False)
            floor = len(new_part.split()) / 2.5 if spoken else reading_floor(new_part)
            full = len(text.split()) / 2.5 if spoken else reading_floor(text)
            context = "speech-rate estimate; review actual voice alignment" if spoken else "unspoken reading estimate; review narration/phrase context"
            if readable + 1e-6 < floor:
                findings.append({"check": "short", "role": el["role"], "selector": el["selector"], "text": text, "time": a,
                                 "detail": f"fully readable {readable:.1f}s ({a:.1f}-{b + step:.1f}s); estimate {floor:.1f}s ({context})"})
            elif readable > max(full * 2.5, full + 3.0):
                findings.append({"check": "long", "role": el["role"], "selector": el["selector"], "text": text, "time": a,
                                 "detail": f"fully readable {readable:.1f}s ({a:.1f}-{b + step:.1f}s); estimate {full:.1f}s ({context})"})

    # typing: a typed element should finish within about 2 s
    for k, rows in per_el.items():
        el = els[k]
        if el["role"] != "typed":
            continue
        start = last_growth = None
        prev = ""
        for t, op, css, rendered, weight, inner, shown in rows:
            shown = shown or ""
            if op < 0.5 or not shown:
                start, prev = None, ""
                continue
            if start is None:
                start = last_growth = t
            elif len(shown) > len(prev) and shown.startswith(prev):
                last_growth = t
            elif not shown.startswith(prev):
                start = last_growth = t
            prev = shown
            if last_growth - start > 2.0 + 1e-6:
                findings.append({"check": "typing", "role": el["role"], "selector": el["selector"], "text": shown, "time": start,
                                 "detail": f"typing runs {last_growth - start:.1f}s from {start:.1f}s; keep it within about 2 s or show long text whole"})
                break

    unroled = data.get("unroled", {})
    if unroled:
        items = sorted(unroled.items(), key=lambda kv: kv[1]["first"])
        listed = "; ".join(f"{s} (\"{i['text'][:30]}\" at {i['first']:.1f}s)" for s, i in items[:6]) + (f"; and {len(items) - 6} more" if len(items) > 6 else "")
        findings.append({"check": "unroled", "role": "", "selector": f"{len(items)} elements", "text": "", "time": items[0][1]["first"],
                         "detail": f"visible text without data-text-role, so its size and reading time aren't checked: {listed}"})
    return findings


def case_pattern(text: str) -> str | None:
    words = [w for w in re.findall(r"[A-Za-z][A-Za-z'’-]*", text)]
    if len(words) < 2:
        return None
    if all(w.isupper() for w in words if len(w) > 1) and any(len(w) > 1 for w in words):
        return "all caps"
    long_words = [w for w in words[1:] if len(w) >= 4]
    if long_words and all(w[0].isupper() for w in long_words):
        return "title case"
    return "sentence case"


def caps_notes(data: dict) -> list[str]:
    """One note when the film's lines use more than one capitalization pattern (proper nouns need judgment)."""
    by_pattern: dict[str, list[str]] = {}
    for el in data["elements"]:
        if el["role"] not in LINE_ROLES:
            continue
        pat = case_pattern(el.get("text", ""))
        if pat:
            by_pattern.setdefault(pat, []).append(f"{el['selector']} \"{el['text'][:40]}\"")
    if len(by_pattern) < 2:
        return []
    return [f"caps: lines use {len(by_pattern)} capitalization patterns; " + "; ".join(
        f"{pat}: " + ", ".join(items[:3]) + (" ..." if len(items) > 3 else "") for pat, items in sorted(by_pattern.items()))]


def exception_targets(f: dict) -> set[str]:
    sel = str(f.get("selector", ""))
    out = {sel, str(f.get("role", ""))}
    if re.match(r"^\d+ elements: ", sel):
        out |= {m.strip() for m in sel.split(": ", 1)[1].replace(" ...", "").split(", ")}
    return {o for o in out if o}


def motion_windows(data: dict, duration: float) -> list[tuple[float, float]]:
    wins = [(max(0.0, a - 0.25), min(duration, b + 0.25)) for a, b in data.get("moves", [])]
    wins += [(max(0.0, c - 0.5), min(duration, c + 0.5)) for c in data.get("cuts", [])]
    wins.sort()
    merged: list[list[float]] = []
    for a, b in wins:
        if merged and a <= merged[-1][1] + 0.1:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return [(round(a, 2), round(b, 2)) for a, b in merged]


def frame_strips(video: Path, windows: list[tuple[float, float]], out: Path) -> list[dict]:
    if not shutil.which("ffmpeg"):
        sys.exit("FAIL: ffmpeg is needed for motion strips")
    out.mkdir(parents=True, exist_ok=True)
    results = []
    try:
        from PIL import Image, ImageStat  # optional, for the near-blank frame hint
    except ImportError:
        raise motion_check.CoverageError("near-blank measurement unavailable: install Pillow (python3 -m pip install Pillow)")
    for n, (a, b) in enumerate(windows, 1):
        d = max(0.2, b - a)
        frames = Path(tempfile.mkdtemp(prefix=f"strip-{n:02d}-", dir=out))
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{a:.2f}", "-t", f"{d:.2f}", "-i", str(video),
                        "-vf", "fps=8,scale=480:-1", str(frames / "f-%03d.png")], check=True)
        pngs = sorted(frames.glob("f-*.png"))
        if not pngs:
            raise motion_check.CoverageError(f"ffmpeg wrote no frames for motion window {a:.2f}–{b:.2f}s")
        cols = min(8, len(pngs))
        sheet = out / f"strip-{n:02d}-{a:.2f}-{b:.2f}s.jpg"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", "8", "-i", str(frames / "f-%03d.png"),
                        "-vf", f"tile={cols}x{(len(pngs) + cols - 1) // cols}:padding=4:color=gray", "-frames:v", "1", str(sheet)], check=True)
        if not sheet.exists():
            raise motion_check.CoverageError(f"ffmpeg wrote no motion sheet: {sheet}")
        blank = []
        if Image is not None:
            for i, p in enumerate(pngs):
                im = Image.open(p).convert("L").resize((96, 54))
                if max(ImageStat.Stat(im).stddev) < 6:
                    blank.append(round(a + i / 8, 2))
        results.append({"window": [a, b], "sheet": str(sheet), "frames": len(pngs), "near_blank": blank})
    return results


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", type=Path, help="HyperFrames project folder (or its index.html)")
    ap.add_argument("--video", type=Path, help="rendered video, for motion frame strips (and the flicker scan with --motion)")
    ap.add_argument("--motion", action="store_true", help="also check for choppy motion: pops, stalls, stepping, abrupt switches, "
                    "edge-on turns, white flashes, and (with --video) flicker")
    ap.add_argument("--out", type=Path, help="where to write the report and strips (default <project>/checks)")
    ap.add_argument("--budget", type=int, default=60000, help="milliseconds of page time allowed for loading and stepping")
    ap.add_argument("--role", action="append", default=[], metavar="SELECTOR=ROLE",
                    help="assign a role by CSS selector where data-text-role isn't set, e.g. --role '.cap2=line' (repeatable)")
    args = ap.parse_args()

    index = args.project if args.project.suffix == ".html" else args.project / "index.html"
    if not index.exists():
        sys.exit(f"FAIL: {index} not found")
    project = index.parent
    html = index.read_text(encoding="utf-8")
    w = re.search(r'data-width="(\d+)"', html); h = re.search(r'data-height="(\d+)"', html)
    size = (int(w.group(1)) if w else 1920, int(h.group(1)) if h else 1080)
    out = args.out or project / "checks"
    out.mkdir(parents=True, exist_ok=True)

    roles = []
    for spec in args.role:
        if "=" not in spec:
            sys.exit(f"FAIL: --role needs SELECTOR=ROLE, got {spec!r}")
        sel, role = spec.rsplit("=", 1)
        roles.append((sel.strip(), role.strip()))
    data = run_probe(index, size, args.budget, roles)
    data["frame"] = list(size)
    if not data.get("timelines") or data.get("duration", 0) <= 0:
        raise motion_check.CoverageError("no usable timeline/duration found in window.__timelines; timeline coverage unavailable, not a clean render")
    if not data["elements"]:
        print("WARN: no element has data-text-role, so sizes and reading time can't be grouped. Add roles first.")
    findings = analyse(data)

    motion_info = None
    if args.motion:
        mdata = motion_check.timeline_motion(index, size, max(args.budget, 120000), dump_with_script)
        motion_info = {"fps": mdata["fps"], "frames": mdata["frames"], "tracked": mdata["tracked"]}
        if mdata["tracked"] == 0:
            raise motion_check.CoverageError("motion requested but no tweened elements were measurable; inspect the animation/runtime before claiming coverage")
        mf = group_motion(mdata["findings"])
        if args.video and args.video.exists():
            (out / "motion-findings").mkdir(parents=True, exist_ok=True)
            mf += motion_check.flicker_scan(args.video)
        for f in mf:
            f.setdefault("role", "")
            f.setdefault("text", "")
            if args.video and args.video.exists():
                box = f.get("box")
                if f.get("box_frac"):
                    bx = f["box_frac"]; box = [bx[0] * size[0], bx[1] * size[1], bx[2] * size[0], bx[3] * size[1]]
                if f["check"] in ("abrupt", "pop", "flash") and box:
                    change = motion_check.pixel_change(args.video, f["time"], box, size, mdata["fps"])
                    if change is not None and change < 2.0:
                        f["detail"] += f" (probably hidden: pixels in that spot change {change:.1f} grey levels in the render; confirm in the strip)"
                strip = motion_check.crop_strip(args.video, f["time"], box, size, out / "motion-findings" / f"{f['check']}-{f['time']:.2f}s.jpg")
                if strip:
                    f["strip"] = strip
        findings += mf

    if args.video:
        if not args.video.exists():
            sys.exit(f"FAIL: {args.video} not found")
        strips = frame_strips(args.video, motion_windows(data, data["duration"]), out / "motion")
        for s in strips:
            if s["near_blank"]:
                nb = s["near_blank"]
                findings.append({"check": "empty", "role": "", "selector": Path(s["sheet"]).name, "text": "", "time": nb[0],
                                 "detail": f"{len(nb)} nearly blank frame(s) inside a move or cut ({nb[0]:.2f}-{nb[-1]:.2f}s); look for an empty card mid-transition"})
    else:
        strips = []

    exc_path = project / "render-check-exceptions.json"
    exceptions = json.loads(exc_path.read_text(encoding="utf-8")) if exc_path.exists() else []
    if not isinstance(exceptions, list) or any(not isinstance(x, dict) for x in exceptions):
        raise ValueError("render-check-exceptions.json must be a list of objects")
    exact_checks = {"size", "small", "unroled", "exception"}
    for item in exceptions:
        if item.get("check") in exact_checks:
            raise ValueError(f"exact {item['check']} errors cannot be waived; fix the source")
        if not isinstance(item.get("sha256"), str):
            raise ValueError("each exception requires the current finding sha256 from render-check.json")
        if not all(isinstance(item.get(k), str) and item[k].strip() for k in ("check", "match", "reason")):
            raise ValueError("each exception requires nonempty string check, match and reason")
        if "text" in item and not isinstance(item["text"], bool):
            raise ValueError("exception text flag must be boolean")
    for x in exceptions:
        if x.get("match") and not str(x.get("reason", "")).strip():
            findings.append({"check": "exception", "role": "", "selector": str(x.get("match")), "text": "", "time": 0.0,
                             "detail": f"exception for '{x.get('check')}' has no reason, so it accepts nothing; add a reason"})
    source_digest = hashlib.sha256(index.read_bytes())
    if args.video:
        with args.video.open("rb") as video_file:
            for chunk in iter(lambda: video_file.read(1024 * 1024), b""):
                source_digest.update(chunk)
    source_hash = source_digest.hexdigest()
    for f in findings:
        f["sha256"] = hashlib.sha256((source_hash + json.dumps(f, sort_keys=True)).encode()).hexdigest()
        for x in exceptions:
            if x["sha256"] != f["sha256"]:
                continue
            if x.get("check") != f["check"] or not x.get("match") or not str(x.get("reason", "")).strip():
                continue
            hit = x["match"] in str(f.get("text", "")) if x.get("text") is True else x["match"] in exception_targets(f)
            if hit:
                f["accepted"] = x["reason"].strip()
    notes = caps_notes(data)

    for f in findings:
        f["status"] = "error" if f["check"] in exact_checks else "reviewed" if f.get("accepted") else "review_required"
    summary = summarise(data)
    report = {"composition": str(index), "duration": data["duration"], "timelines": data.get("timelines"),
              "elements": summary, "motion": motion_info, "coverage": "complete", "status": "error" if any(f["check"] in exact_checks for f in findings) else "review_required" if any(not f.get("accepted") for f in findings) else "reviewed", "findings": findings, "strips": strips}
    (out / "render-check.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    open_f = [f for f in findings if not f.get("accepted")]
    lines = [f"# Render check: {index}", "", f"{len(data['elements'])} text elements over {data['duration']}s; "
             f"{len(open_f)} contextual candidate(s) need review, {len(findings) - len(open_f)} reviewed.", ""]
    for f in sorted(findings, key=lambda f: (f["check"], f["time"])):
        mark = "reviewed: " + f["accepted"] if f.get("accepted") else "REVIEW REQUIRED"
        lines.append(f"- **{f['check']}** at {f['time']:.2f}s, {f['selector']}: {f['detail']}" + (f" — \"{f['text'][:60]}\"" if f.get("text") else "") + f" ({mark})" + (f" · strip: {f['strip']}" if f.get("strip") else ""))
    lines += ["", "## Text on screen", "", "| Role | Element | Size | Weight | On screen | Text |", "|---|---|---|---|---|---|"]
    for e in sorted(summary, key=lambda e: (e["role"], e["on"][0] if e["on"] else 1e9)):
        on = f"{e['on'][0]:.1f}-{e['on'][1]:.1f}s" if e["on"] else "never"
        lines.append(f"| {e['role']} | {e['selector']} | {str(e['size']) + 'px' if e['size'] else '-'} | {e['weight'] or '-'} | {on} | {e['text'][:50]} |")
    if notes:
        lines += ["", "## Notes (do not block)", ""] + [f"- {n}" for n in notes]
    if strips:
        lines += ["", "## Motion strips (look at every one)", ""] + [f"- {s['window'][0]:.2f}-{s['window'][1]:.2f}s: {s['sheet']}" for s in strips]
    (out / "render-check.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    if motion_info:
        print(f"Motion: stepped {motion_info['frames']} frames at {motion_info['fps']:g} fps, watching {motion_info['tracked']} animated elements.")
    for f in sorted(open_f, key=lambda f: f["time"]):
        print(f"{'ERROR' if f['check'] in exact_checks else 'REVIEW'} {f['check']:<8} {f['time']:6.2f}s  {f['selector']}: {f['detail']}")
    for f in findings:
        if f.get("accepted"):
            print(f"OK   {f['check']:<8} {f['time']:6.1f}s  {f['selector']} (accepted: {f['accepted']})")
    for n in notes:
        print(f"NOTE {n}")
    if strips:
        print(f"\n{len(strips)} motion strips in {out / 'motion'}; open every one and look for blank or choppy frames.")
    print(f"\nReport: {out / 'render-check.md'}")
    return 1 if any(f["check"] in exact_checks for f in open_f) else 2 if open_f else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, TypeError, KeyError, subprocess.CalledProcessError, motion_check.CoverageError) as exc:
        detail = exc.stderr.strip()[-800:] if isinstance(exc, subprocess.CalledProcessError) and exc.stderr else str(exc)
        if isinstance(detail, bytes):
            detail = detail.decode(errors="replace")
        print(f"COVERAGE/INPUT ERROR: measurements incomplete: {detail}", file=sys.stderr)
        raise SystemExit(1)
