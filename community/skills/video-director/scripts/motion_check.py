#!/usr/bin/env python3
"""Choppy-motion checks for check_render.py --motion.

Two parts:
  timeline probe  steps the composition every frame and watches every element a tween moves
  flicker scan    reads the rendered video frame by frame, region by region

Candidates require contextual visual review before delivery; they are not semantic failures:
  pop       a tweened value jumps most of its change in a single frame, or a stroke tween never animates
  stall     words of one line arrive with visible pauses between them; or motion stops and restarts inside a move
  stepping  an element creeps slower than about half a pixel per frame for over a second (it steps visibly)
  abrupt    a visible element switches on, off or its clip changes in one frame, away from a cut
  edge-on   an element turned in 3D passes edge-on to the camera while visible
  flash     two large light elements are both half-faded over each other (reads as a white flash)
  flicker   a region of the video changes on one frame and changes back on the next (A-B-A)
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path


class CoverageError(RuntimeError):
    """A requested measurement was unavailable; no quality verdict is possible."""


# Thresholds. Names say what they measure; units are pixels, frames, seconds or opacity (0-1).
POP_SHARE = 0.6            # one frame carries more than this share of a tween's total change
POP_MIN_FRAMES = 6         # only tweens at least this many frames long can pop
POP_MIN_CHANGE = {"x": 6, "y": 6, "w": 6, "h": 6, "op": 0.25, "dash": 6}
WORD_GAP = 0.1             # seconds between two words of one line arriving
CREEP_SPEED = 0.5          # px per frame
CREEP_SECONDS = 1.0
ABRUPT_OPACITY = 0.5       # opacity change in one frame
MIN_AREA = 0.005           # share of the frame an element must cover to count as visible for abrupt checks
EDGE_RATIO = 0.15          # a 3D turn counts as edge-on when its narrower side shrinks below 15% of the element's own size
FLASH_AREA = 0.10          # two overlapping elements must each cover 10% of the frame before a half-fade reads as a white flash
FLASH_OPACITY = (0.2, 0.8) # both elements partly faded in this range at once; outside it one of them is clearly in front
FLICKER_DIFF = 6.0         # mean grey-level difference (0-255) in one region
FLICKER_RETURN = 0.35      # frame N-1 and N+1 must match this closely relative to their difference from N

MOTION_PROBE = r"""
<script id="vd-motion-src">
(function () {
  const T = %(thresholds)s;
  function root() { return document.querySelector("[data-composition-id]"); }
  function timelines() { const all = window.__timelines || {}; const id = root() && root().getAttribute("data-composition-id"); return id && all[id] ? [all[id]] : Object.values(all); }
  const clips = [...document.querySelectorAll("[data-start]")].filter(el => el !== root());
  function applyClips(t) { for (const el of clips) { const s = parseFloat(el.getAttribute("data-start")) || 0, d = parseFloat(el.getAttribute("data-duration")); el.style.visibility = (t >= s - 1e-6 && (isNaN(d) || t < s + d - 1e-6)) ? "" : "hidden"; } }
  function seek(t) { applyClips(t); for (const tl of timelines()) { tl.seek(t, false); } }
  function chain(el) { let o = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.display === "none" || cs.visibility === "hidden") return 0; o *= parseFloat(cs.opacity); } return o; }
  function sel(el) { if (el.id) return "#" + el.id; let p = el.parentElement, path = el.tagName.toLowerCase(); while (p && !p.id && p !== document.body) { path = p.tagName.toLowerCase() + ">" + path; p = p.parentElement; } return (p && p.id ? "#" + p.id + " " : "") + path; }
  function lum(c) { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return [0, 0]; const v = m[1].split(",").map(parseFloat); return [(0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]) / 255, v.length > 3 ? v[3] : 1]; }
  function run() {
    const r = root(), W = innerWidth, H = innerHeight, FA = W * H;
    const dur = parseFloat(r && r.getAttribute("data-duration")) || 0;
    const fps = Math.min(60, parseFloat(r && r.getAttribute("data-fps")) || 30), dt = 1 / fps;
    const cuts = [...new Set(clips.flatMap(el => { const s = parseFloat(el.getAttribute("data-start")), d = parseFloat(el.getAttribute("data-duration")); return [s, s + d]; }).filter(x => !isNaN(x)))];
    const nearCut = t => cuts.some(c => Math.abs(c - t) <= dt * 1.5);
    // which elements are tweened, when, and what properties
    const tw = new Map();
    for (const tl of timelines()) {
      if (!tl.getChildren) continue;
      for (const c of tl.getChildren(true, true, false)) {
        if (!c.targets) continue;
        let start = c.startTime(), p = c.parent; while (p && p !== tl && p.startTime) { start += p.startTime(); p = p.parent; }
        const props = Object.keys(c.vars || {});
        for (const el of c.targets()) { if (!(el instanceof Element)) continue; if (!tw.has(el)) tw.set(el, []); tw.get(el).push({ start, end: start + c.duration(), props }); }
      }
    }
    const els = [...tw.keys()];
    const S = els.map(() => ({ prev: null, series: {}, creep: 0, creepStart: 0, edgeDone: false, abruptAt: -9, arrive: null }));
    const findings = [], flashSeen = new Set();
    const n = Math.floor(dur * fps);
    for (let f = 0; f <= n; f++) {
      const t = f * dt; seek(t);
      const vis = [];
      els.forEach((el, k) => {
        const st = S[k], rc = el.getBoundingClientRect(), op = chain(el), cs = getComputedStyle(el);
        const cur = { x: rc.left, y: rc.top, w: rc.width, h: rc.height, op, clip: cs.clipPath + "|" + cs.webkitMaskImage, dash: parseFloat(cs.strokeDashoffset) || 0, area: rc.width * rc.height / FA };
        const active = tw.get(el).filter(w => t >= w.start - 1e-6 && t <= w.end + 1e-6);
        for (const w of active) { const key = w.start.toFixed(3); (st.series[key] = st.series[key] || { w, rows: [] }).rows.push([t, cur.x, cur.y, cur.w, cur.h, cur.op, cur.dash]); }
        const p = st.prev;
        if (p) {
          const seen = Math.max(p.op, op) >= 0.3 && Math.max(p.area, cur.area) >= T.MIN_AREA;
          if (seen && !nearCut(t) && t - st.abruptAt > 0.5) {
            const dOp = Math.abs(op - p.op);
            if (dOp >= T.ABRUPT_OPACITY && !active.some(w => w.end - w.start >= 2 * dt)) { findings.push({ check: "abrupt", time: t, selector: sel(el), box: [rc.left, rc.top, rc.width, rc.height], detail: `opacity ${p.op.toFixed(2)} → ${op.toFixed(2)} in one frame` }); st.abruptAt = t; }
            else if (cur.clip !== p.clip && op >= 0.3 && !active.some(w => w.end - w.start >= 2 * dt)) { findings.push({ check: "abrupt", time: t, selector: sel(el), box: [rc.left, rc.top, rc.width, rc.height], detail: "clip or mask changed in one frame while visible" }); st.abruptAt = t; }
          }
          const speed = Math.hypot(cur.x - p.x, cur.y - p.y);
          if (op >= 0.3 && speed > 0.02 && speed < T.CREEP_SPEED) { if (!st.creep) st.creepStart = t; st.creep++; }
          else { if (st.creep * dt >= T.CREEP_SECONDS) findings.push({ check: "stepping", time: st.creepStart, selector: sel(el), box: [rc.left, rc.top, rc.width, rc.height], detail: `moves under ${T.CREEP_SPEED}px a frame for ${(st.creep * dt).toFixed(1)}s; it steps instead of gliding` }); st.creep = 0; }
          const turns = tw.get(el).some(w => w.props.some(k => /^rotat(ion|e)[XY]$/.test(k)));
          if (turns && !st.edgeDone && op >= 0.3 && el.offsetWidth > 40 && el.offsetHeight > 40) {
            const rx = rc.width / el.offsetWidth, ry = rc.height / el.offsetHeight;
            if (Math.min(rx, ry) < T.EDGE_RATIO && Math.max(p.w / el.offsetWidth, p.h / el.offsetHeight) > 0.3) { findings.push({ check: "edge-on", time: t, selector: sel(el), box: [rc.left, rc.top, rc.width, rc.height], detail: "turns edge-on to the camera while visible" }); st.edgeDone = true; }
          }
        }
        if (op >= 0.95 && st.arrive === null) st.arrive = t;
        if (op > 0.02 && cur.area >= T.FLASH_AREA) vis.push({ k, rc, op, el });
        st.prev = cur;
      });
      // two large light elements both half-faded over each other
      for (let i = 0; i < vis.length; i++) for (let j = i + 1; j < vis.length; j++) {
        const a = vis[i], b = vis[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        if (!(a.op >= T.FLASH_OPACITY[0] && a.op <= T.FLASH_OPACITY[1] && b.op >= T.FLASH_OPACITY[0] && b.op <= T.FLASH_OPACITY[1])) continue;
        const [la, aa] = lum(getComputedStyle(a.el).backgroundColor), [lb, ab] = lum(getComputedStyle(b.el).backgroundColor);
        if (la < 0.8 || lb < 0.8 || aa < 0.5 || ab < 0.5) continue;
        const ix = Math.max(0, Math.min(a.rc.right, b.rc.right) - Math.max(a.rc.left, b.rc.left)), iy = Math.max(0, Math.min(a.rc.bottom, b.rc.bottom) - Math.max(a.rc.top, b.rc.top));
        if (ix * iy < 0.5 * Math.min(a.rc.width * a.rc.height, b.rc.width * b.rc.height)) continue;
        const key = a.k + ":" + b.k; if (flashSeen.has(key)) continue; flashSeen.add(key);
        findings.push({ check: "flash", time: t, selector: sel(a.el) + " + " + sel(b.el), box: [Math.min(a.rc.left, b.rc.left), Math.min(a.rc.top, b.rc.top), Math.max(a.rc.right, b.rc.right) - Math.min(a.rc.left, b.rc.left), Math.max(a.rc.bottom, b.rc.bottom) - Math.min(a.rc.top, b.rc.top)], detail: `two light elements crossfade over each other (${a.op.toFixed(2)} and ${b.op.toFixed(2)} opacity)` });
      }
    }
    // which measurements each tweened property moves
    const MOVES = [[/^(x|left|right|xPercent|translateX)$/, ["x"]], [/^(y|top|bottom|yPercent|translateY)$/, ["y"]],
      [/^(scale|z|translateZ)$/, ["x", "y", "w", "h"]], [/^(scaleX|width|rotationY|rotateY)$/, ["w"]], [/^(scaleY|height|rotationX|rotateX)$/, ["h"]],
      [/^(opacity|autoAlpha)$/, ["op"]], [/stroke|drawSVG/i, ["dash"]]];
    const moved = props => { const out = new Set(); for (const p of props) for (const [re, m] of MOVES) if (re.test(p)) m.forEach(x => out.add(x)); return out; };
    // pops and stops inside each tween
    els.forEach((el, k) => {
      const sets = tw.get(el).filter(x => x.end - x.start < 2 * dt);
      for (const { w, rows } of Object.values(S[k].series)) {
        if (rows.length < T.POP_MIN_FRAMES) continue;
        const animates = moved(w.props);
        if (sets.some(x => x.start > w.start + dt && x.start < w.end - dt)) continue; // an instant set lands inside this move; judged as "abrupt" instead
        const others = tw.get(el).some(x => x !== w && x.end - x.start >= 2 * dt && x.start < w.end && x.end > w.start);
        const names = ["x", "y", "w", "h", "op", "dash"];
        names.forEach((name, i) => {
          if (!animates.has(name) || others) return;
          const v = rows.map(r => r[i + 1]), d = v.slice(1).map((x, j) => Math.abs(x - v[j]));
          const sum = d.reduce((a, b) => a + b, 0), mx = Math.max(...d);
          if (sum >= T.POP_MIN_CHANGE[name] && mx > T.POP_SHARE * sum) { const at = rows[d.indexOf(mx) + 1][0]; findings.push({ check: "pop", time: at, selector: sel(el), box: null, detail: `${name} jumps ${mx.toFixed(name === "op" ? 2 : 0)} of ${sum.toFixed(name === "op" ? 2 : 0)} in one frame during a ${(w.end - w.start).toFixed(2)}s move` }); }
          if (name === "x" || name === "y") {
            // moving, then stopped for 3+ frames, then moving again within the same tween
            let state = 0, stopped = 0;
            for (const x of d) { if (x > 0.5) { if (state === 2 && stopped >= 3) { findings.push({ check: "stall", time: rows[0][0], selector: sel(el), box: null, detail: `stops and restarts inside a ${(w.end - w.start).toFixed(2)}s move` }); break; } state = 1; stopped = 0; } else if (state >= 1 && x < 0.05) { state = 2; stopped++; } }
          }
        });
        if (w.props.some(p => /stroke/i.test(p))) {
          const v = rows.map(r => r[6]), d = v.slice(1).map((x, j) => Math.abs(x - v[j])), sum = d.reduce((a, b) => a + b, 0);
          if (sum < 1) findings.push({ check: "pop", time: w.start, selector: sel(el), box: null, detail: "a stroke tween runs but the stroke never changes; it will appear all at once" });
        }
      }
    });
    // words of one line arriving with pauses between them
    document.querySelectorAll("[data-text-role]").forEach(line => {
      const arr = els.map((el, k) => [el, S[k].arrive]).filter(([el, a]) => a !== null && line.contains(el) && el !== line).map(([, a]) => a).sort((a, b) => a - b);
      for (let i = 1; i < arr.length; i++) if (arr[i] - arr[i - 1] >= T.WORD_GAP - 1e-6 && arr[i] - arr[i - 1] < 1.5) { findings.push({ check: "stall", time: arr[i - 1], selector: sel(line), box: null, detail: `words arrive ${(arr[i] - arr[i - 1]).toFixed(2)}s apart; review voice/beat alignment and phrase continuity (${arr.length} words over ${(arr[arr.length - 1] - arr[0]).toFixed(2)}s); a steady 0.1–0.3s cadence may be intentional` }); break; }
    });
    const out = document.createElement("script"); out.type = "application/json"; out.id = "vd-motion";
    out.textContent = JSON.stringify({ fps, frames: n + 1, tracked: els.length, findings });
    document.body.appendChild(out);
  }
  function go() { try { run(); } catch (e) { const out = document.createElement("script"); out.type = "application/json"; out.id = "vd-motion"; out.textContent = JSON.stringify({ error: String(e && e.stack || e) }); document.body.appendChild(out); } }
  window.addEventListener("load", () => setTimeout(() => (document.fonts ? document.fonts.ready : Promise.resolve()).then(go), 300));
})();
</script>
"""


def thresholds() -> dict:
    return {"POP_SHARE": POP_SHARE, "POP_MIN_FRAMES": POP_MIN_FRAMES, "POP_MIN_CHANGE": POP_MIN_CHANGE, "WORD_GAP": WORD_GAP,
            "CREEP_SPEED": CREEP_SPEED, "CREEP_SECONDS": CREEP_SECONDS, "ABRUPT_OPACITY": ABRUPT_OPACITY, "MIN_AREA": MIN_AREA,
            "EDGE_RATIO": EDGE_RATIO, "FLASH_AREA": FLASH_AREA, "FLASH_OPACITY": list(FLASH_OPACITY)}


def timeline_motion(index: Path, size: tuple[int, int], budget: int, dump_with_script) -> dict:
    script = MOTION_PROBE % {"thresholds": json.dumps(thresholds())}
    return dump_with_script(index, size, budget, script, "vd-motion", timeout=900)


def flicker_scan(video: Path, grid: int = 4) -> list[dict]:
    """Find A-B-A frames: region changes on frame N and changes back on N+1."""
    try:
        import numpy as np
    except ImportError:
        raise CoverageError("flicker measurement unavailable: install numpy (python3 -m pip install numpy) in the chosen interpreter")
    w, h = 160, 96
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", str(video)],
                           capture_output=True, text=True, check=True).stdout.strip()
    num, _, den = probe.partition("/")
    if not num:
        raise CoverageError("ffprobe returned no video frame rate")
    fps = float(num) / float(den or 1)
    if fps <= 0:
        raise CoverageError("ffprobe returned a nonpositive frame rate")
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(video), "-vf", f"scale={w}:{h},format=gray", "-f", "rawvideo", "-"],
                         capture_output=True, check=True).stdout
    if not raw or len(raw) % (h * w):
        raise CoverageError("ffmpeg returned missing/incomplete grayscale frames for flicker measurement")
    frames = np.frombuffer(raw, dtype=np.uint8).reshape(-1, h, w).astype(np.int16)
    if len(frames) < 3:
        raise CoverageError("flicker measurement needs at least three decoded frames")
    ch, cw = h // grid, w // grid
    cells = frames[:, : ch * grid, : cw * grid].reshape(len(frames), grid, ch, grid, cw)
    d1 = np.abs(cells[1:] - cells[:-1]).mean(axis=(2, 4))          # N vs N-1, per cell
    d2 = np.abs(cells[2:] - cells[:-2]).mean(axis=(2, 4))          # N+1 vs N-1
    prev, nxt = d1[:-1], d1[1:]                                     # for N = 1..len-2
    hit = (prev > FLICKER_DIFF) & (nxt > FLICKER_DIFF) & (d2 < FLICKER_RETURN * np.minimum(prev, nxt))
    events: list[dict] = []
    for n in np.argwhere(hit.any(axis=(1, 2))).ravel():
        f = int(n) + 1
        r, c = np.argwhere(hit[n])[0]
        t = f / fps
        if events and t - events[-1]["end"] <= 0.25:
            events[-1]["end"] = t; events[-1]["count"] += 1
        else:
            events.append({"start": t, "end": t, "count": 1, "cell": [int(r), int(c)]})
    out = []
    for e in events:
        r, c = e["cell"]
        out.append({"check": "flicker", "time": round(e["start"], 3), "selector": f"video region row {r + 1}, column {c + 1} of {grid}",
                    "box_frac": [c / grid, r / grid, 1 / grid, 1 / grid],
                    "detail": f"{e['count']} frame(s) change and change back (A-B-A) between {e['start']:.2f}s and {e['end']:.2f}s"})
    return out


def crop_strip(video: Path, t: float, box: list[float] | None, size: tuple[int, int], out: Path) -> str | None:
    """Every frame from t-0.15 s to t+0.15 s, cropped around the finding, tiled left to right."""
    if not shutil.which("ffmpeg"):
        raise CoverageError("ffmpeg is required for motion evidence strips")
    vf = []
    if box:
        x, y, w, h = box
        pad = 40
        x0, y0 = max(0, int(x - pad)), max(0, int(y - pad))
        cw, ch = min(size[0] - x0, int(w + 2 * pad)), min(size[1] - y0, int(h + 2 * pad))
        if cw > 16 and ch > 16:
            vf.append(f"crop={cw}:{ch}:{x0}:{y0}")
    vf += ["scale=320:-2", "tile=10x2:padding=3:color=gray"]
    a = max(0.0, t - 0.15)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{a:.3f}", "-t", "0.3", "-i", str(video), "-vf", ",".join(vf), "-frames:v", "1", str(out)],
                   check=True)
    if not out.exists():
        raise CoverageError(f"ffmpeg wrote no motion evidence strip: {out}")
    return str(out)


def pixel_change(video: Path, t: float, box: list[float] | None, size: tuple[int, int], fps: float) -> float | None:
    """Mean grey-level difference inside box between the frame before t and the frame at t, in the render."""
    try:
        import numpy as np
    except ImportError:
        return None
    vf = []
    if box:
        x, y, w, h = box
        x0, y0 = max(0, int(x)), max(0, int(y))
        cw, ch = min(size[0] - x0, int(w)), min(size[1] - y0, int(h))
        if cw < 8 or ch < 8:
            return None
        vf.append(f"crop={cw}:{ch}:{x0}:{y0}")
    vf += ["scale=96:54", "format=gray"]
    a = max(0.0, t - 2.0 / fps)
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{a:.4f}", "-i", str(video), "-frames:v", "4", "-vf", ",".join(vf), "-f", "rawvideo", "-"],
                         capture_output=True, check=True).stdout
    frames = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 54, 96).astype(np.int16)
    if len(frames) < 2:
        return None
    return float(max(np.abs(frames[i + 1] - frames[i]).mean() for i in range(len(frames) - 1)))
