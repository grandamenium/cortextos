#!/usr/bin/env python3
"""Build a self-contained review page from a storyboard or options JSON file and its rendered frames.

Two page kinds, chosen by "kind" in the JSON:
  storyboard  the whole video in order, how each scene turns into the next, then one card per scene
  options     2-3 options for one design decision, side by side, with an optional switch (for example color)

Every page has: full-width frames with tabs (arrow keys flip), click-to-zoom up to 8x with drag to pan,
a notes box under every card, numbered pins on frames, Copy all notes / Download / Import, and the
previous version's notes when --previous-notes is given.

Usage:
  python3 build_storyboard.py storyboard/storyboard-v0.3.json storyboard/storyboard-v0.3.html
  python3 build_storyboard.py storyboard/storyboard-v0.4.json storyboard/storyboard-v0.4.html --previous-notes ~/Downloads/notes-v0.3.json
  python3 build_storyboard.py storyboard/options-look-v0.1.json storyboard/options-look-v0.1.html

The output is never overwritten: each review round gets a new version number.
"""
from __future__ import annotations

import argparse
import hashlib
import base64
import html
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

NOTES_FORMAT = "video-director-storyboard-notes"
e = html.escape
_cache: dict[tuple[str, int], str] = {}


def embed(path: Path, width: int) -> str:
    """Return a data URI for a frame, resized to width as JPEG when possible."""
    key = (str(path), width)
    if key in _cache:
        return _cache[key]
    if not path.exists():
        raise SystemExit(f"FAIL: missing frame image {path}")
    data, mime = None, "image/jpeg"
    try:
        from PIL import Image  # optional, gives smaller pages
        im = Image.open(path).convert("RGB")
        if im.width > width:
            im = im.resize((width, round(width * im.height / im.width)), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=84)
        data = buf.getvalue()
    except ImportError:
        if shutil.which("sips"):
            with tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp) / "f.jpg"
                r = subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "84", "--resampleWidth", str(width), str(path), "--out", str(out)],
                                   capture_output=True)
                if r.returncode == 0 and out.exists():
                    data = out.read_bytes()
        if data is None:
            data, mime = path.read_bytes(), "image/png"
    uri = f"data:{mime};base64,{base64.b64encode(data).decode()}"
    _cache[key] = uri
    return uri


def norm_frames(frames: list) -> list[dict]:
    out = []
    n = len(frames)
    default = {1: ["Frame"], 2: ["Start", "End"], 3: ["Start", "Middle", "End"]}.get(n) or (["Start"] + [f"Step {i}" for i in range(2, n)] + ["End"])
    for i, f in enumerate(frames):
        if isinstance(f, str):
            out.append({"id": f, "label": default[i]})
        else:
            out.append({"id": f["id"], "label": f.get("label") or default[i]})
    return out


def link(x: dict) -> str:
    url, label = str(x.get("url") or ""), e(x.get("source", "link") or "link")
    if url.startswith(("https://", "http://")):
        return f'<a href="{e(url, quote=True)}" rel="noopener">{label}</a>'
    return e(x.get("source", ""))


def t(x) -> str:
    return f"{int(x // 60)}:{x % 60:04.1f}"


def move_text(m) -> str:
    if not m:
        return ""
    if isinstance(m, str):
        return e(m)
    parts = []
    if m.get("move"):
        parts.append(f"<b>{e(m['move'])}</b>")
    if m.get("camera"):
        parts.append(f"Camera: {e(m['camera'])}")
    if m.get("carries"):
        parts.append(f"Carries over: {e(m['carries'])}")
    if m.get("timing"):
        parts.append(f"Timing: {e(m['timing'])}")
    if m.get("easing"):
        parts.append(f"Easing: {e(m['easing'])}")
    if m.get("detail"):
        parts.append(e(m["detail"]))
    return " · ".join(parts)


# A soft transition between pictures. A single object or line fading up inside a scene is fine,
# and so is a text blur-out; a crossfade, dissolve or blur between scenes is not.
SCENE_FADE = re.compile(r"cross-?fade|dissolve|\bblur(?!-out| out)\b|\bfade (?:to|through|between|out)\b|\bfades? into\b", re.I)
ITEM_FADE = re.compile(r"cross-?fade|dissolve|\bblur\b(?![- ]out)|\bfades? out\b", re.I)
# The seven rows every direction option states (SKILL.md stage 4).
PLAN_ROWS = ("The idea", "Product at the turn", "Media", "Drawing style", "Recurring element", "Moving between ideas", "End line")


def reading_time(line: str, narrated: bool = False) -> float:
    """Seconds a line needs after it lands.

    Unspoken line: 1.0 s + 0.045 s per character (0.6 s base for one to three words).
    Spoken line: its spoken length at about 2.5 words per second, plus 0.3 s."""
    if narrated:
        return len(line.split()) / 2.5 + 0.3
    base = 0.6 if len(line.split()) <= 3 else 1.0
    return base + 0.045 * len(line)


def check(data: dict, frames_dir: Path, strict: bool) -> tuple[list[str], list[str], list[dict]]:
    """Return (structural problems, timing notes, contextual review candidates).

    Structural problems are presence checks; --strict turns them into failures. Lexical fade/blur hits need an actual model/human disposition; code does not decide their meaning.
    Reading-time notes are estimates for a person to judge and never fail the build.
    Whether a move is a good one is a judgment for the person reviewing."""
    warns, notes, candidates = [], [], []
    if data.get("kind", "storyboard") != "storyboard":
        if data.get("kind") == "options":
            options = data.get("options")
            variants = (data.get("variants") or {}).get("items", [])
            if not isinstance(options, list) or not options:
                raise ValueError("options must be a nonempty list")
            count = len(variants) if variants else len(options)
            if count not in (2, 3):
                raise ValueError(f"options page needs 2–3 choices; found {count}")
        if data.get("kind") == "options" and str(data.get("decision", "")).strip().lower() == "direction":
            for op in data.get("options", []):
                plan = op.get("plan") or {}
                gaps = [r for r in PLAN_ROWS if not str(plan.get(r, "")).strip()]
                if gaps:
                    warns.append(f"direction {op.get('key')}: plan is missing or empty for {', '.join(gaps)}")
        if strict and warns:
            for w in warns:
                print(f"FAIL: {w}", file=sys.stderr)
            raise SystemExit(1)
        return warns, notes, candidates
    scenes = data.get("scenes", [])
    # A film whose recorded style allows dissolves or blur (calm text-led, motion graphics) skips the fade checks.
    fades_ok = bool((data.get("style") or {}).get("dissolves"))
    for i, s in enumerate(scenes):
        sid = s.get("id")
        fr = norm_frames(s.get("frames", []))
        pairs = len(fr) - 1
        motion = s.get("motion")
        if pairs > 0:
            if not motion:
                warns.append(f"scene {sid}: {pairs} change(s) inside the scene but no motion entries")
            elif not isinstance(motion, list):
                warns.append(f"scene {sid}: motion is one sentence, but the scene has {pairs} frame change(s); give each change a move, timing and easing")
            else:
                for mi, m in enumerate(motion):
                    missing = [k for k in ("move", "timing", "easing") if not m.get(k)]
                    if missing:
                        warns.append(f"scene {sid}: motion {m.get('from')}→{m.get('to')} is missing {', '.join(missing)}")
                    if not fades_ok and ITEM_FADE.search(str(m.get("move", ""))):
                        candidates.append({"id": f"motion:{sid}:{mi}:fade", "detail": f"scene {sid}: fade/blur wording in {m.get('move')!r}; review the actual move, negation and permitted text/material effects"})
                if len(motion) < pairs:
                    warns.append(f"scene {sid}: {pairs} frame changes but only {len(motion)} motion entries")
        if i < len(scenes) - 1:
            nxt = s.get("to_next")
            if not nxt:
                warns.append(f"scene {sid}: no to_next (how it turns into scene {scenes[i + 1].get('id')})")
            elif not isinstance(nxt, dict):
                warns.append(f"scene {sid}: to_next is one sentence; give it move, camera, timing, easing and carries")
            else:
                if not all(nxt.get(k) for k in ("move", "camera", "timing", "easing", "carries")):
                    warns.append(f"scene {sid}: to_next is missing move, camera, timing, easing or carries")
                # A dissolve into the end card (the change into the last scene) is allowed.
                if not fades_ok and SCENE_FADE.search(str(nxt.get("move", ""))) and i < len(scenes) - 2:
                    candidates.append({"id": f"transition:{sid}:fade", "detail": f"scene {sid}: fade/blur wording in {nxt.get('move')!r}; review actual transition and recorded style exceptions"})
        lines = s.get("lines", [])
        if lines and isinstance(s.get("start"), (int, float)) and isinstance(s.get("end"), (int, float)):
            spoken = s.get("narrated", data.get("narrated", False))
            need = sum(reading_time(l, bool(spoken)) for l in lines)
            have = s["end"] - s["start"]
            if have < need * 0.85:
                notes.append(f"scene {sid}: {have:.1f}s on screen; its lines need about {need:.1f}s to read (cycling words can run shorter)")
    # The camera move under each scene change should differ; the kind of change (one element becoming the next) may repeat.
    seen = {}
    for s in scenes:
        nxt = s.get("to_next")
        if not isinstance(nxt, dict) or nxt.get("motif"):
            continue
        key = str(nxt.get("camera") or nxt.get("move") or "").strip().lower()
        if key:
            seen.setdefault(key, []).append(str(s.get("id")))
    for key, ids in sorted(seen.items()):
        if len(ids) > 1 and key not in ("none", "still", "locked") and not key.startswith(("hard cut", "cut on")):
            warns.append(f"the same camera move under scene changes {', '.join(ids)}: {key} (vary it, or mark one as a motif)")
    if strict and warns:
        for w in warns:
            print(f"FAIL: {w}", file=sys.stderr)
        raise SystemExit(1)
    return warns, notes, candidates


def figure(frames_dir: Path, f: dict, idx: int, variants: list[str], width: int, alt: str) -> str:
    if variants:
        imgs = "".join(f'<img data-v="{e(v)}" src="{embed(frames_dir / (f["id"] + "@" + v + ".png"), width)}" alt="{e(alt)} ({e(v)})">' for v in variants)
    else:
        imgs = f'<img src="{embed(frames_dir / (f["id"] + ".png"), width)}" alt="{e(alt)}">'
    return f'<figure class="fv{" on" if idx == 0 else ""}" data-i="{idx}" data-label="{e(f["label"])}"><div class="fwrap">{imgs}</div><figcaption>{e(f["label"])} · {e(f["id"])}</figcaption></figure>'


def viewer(key: str, label: str, frames_dir: Path, frames: list[dict], variants: list[str], kind: str) -> str:
    figs = "".join(figure(frames_dir, f, i, variants, 1600, f"{label}: {f['label']}") for i, f in enumerate(frames))
    tabs = "".join(f'<button type="button" class="tab{" on" if i == 0 else ""}" data-i="{i}">{i + 1} · {e(f["label"])}</button>' for i, f in enumerate(frames))
    return f"""<div class="card" data-key="{e(key)}" data-kind="{kind}" data-label="{e(label)}">
<div class="tabs">{tabs}<button type="button" class="pinbtn" aria-pressed="false">Add pin</button>
<span class="hint">← → flips frames. Click a frame to zoom in.</span></div>
<div class="stack">{figs}</div>
<ol class="pinlist"></ol>
<label class="nlabel">Your notes</label><textarea class="note" rows="3" placeholder="What should change here?"></textarea>
<div class="prev"></div></div>"""


CSS = """
:root{--ink:#17171c;--muted:#686874;--paper:#f2f2f4;--card:#fff;--line:#dfdfe6;--hi:#17171c}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--ink:#ececf1;--muted:#a0a0ac;--paper:#121215;--card:#1c1c21;--line:#2e2e36;--hi:#ececf1}}
:root[data-theme="dark"]{--ink:#ececf1;--muted:#a0a0ac;--paper:#121215;--card:#1c1c21;--line:#2e2e36;--hi:#ececf1}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1400px;margin:0 auto;padding:36px 16px 120px}
h1{font-size:32px;letter-spacing:-.02em;margin:0}h2{font-size:24px;margin:56px 0 6px}h3{margin:0;font-size:22px}
h4{margin:0 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.lede,.intro{color:var(--muted);margin:6px 0 16px}
.summary{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 18px;margin:20px 0}
.flows{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.flow{display:block;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;color:inherit;text-decoration:none}
.flow img{display:block;width:100%}.fmeta{padding:8px 12px 0;font-weight:600}.fmeta span{float:right;color:var(--muted);font-weight:500;font-size:14px}
.fline{padding:2px 12px 12px;font-size:14px}
.block{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:18px;scroll-margin-top:12px}
.block header{display:flex;gap:16px;align-items:baseline;margin-bottom:12px}.num{font-size:28px;font-weight:750;min-width:46px}.sub{color:var(--muted);font-size:14px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:14px}.pair img{display:block;width:100%;border-radius:8px;border:1px solid var(--line);cursor:zoom-in}
.pair .cap{font-size:13px;color:var(--muted);padding:4px 2px}.bridge{margin:10px 0 0}
.tabs{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
.tab,.pinbtn,.vbtn,.act{font:inherit;font-weight:600;border:1px solid var(--line);background:var(--paper);color:var(--ink);border-radius:999px;padding:6px 14px;cursor:pointer}
.tab.on,.vbtn.on,.pinbtn[aria-pressed="true"]{background:var(--hi);border-color:var(--hi);color:var(--paper)}
.hint{color:var(--muted);font-size:13px}
.stack figure{margin:0}html.js .stack figure{display:none}html.js .stack figure.on{display:block}
.fwrap{position:relative;line-height:0}.fwrap img{display:block;width:100%;height:auto;border-radius:10px;border:1px solid var(--line);cursor:zoom-in}
.card.pinning .fwrap img{cursor:crosshair}
figcaption{font-size:12px;color:var(--muted);margin-top:6px}
body:not([data-variant]) img[data-v]{display:none}body:not([data-variant]) img[data-v]:first-child{display:block}
.pin{position:absolute;transform:translate(-50%,-50%);width:28px;height:28px;border-radius:50%;background:#111;color:#fff;border:2px solid #fff;font:700 13px/24px sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.4);cursor:pointer;z-index:2}
.pinlist{margin:10px 0 0;padding-left:22px}.pinlist li{margin:4px 0}.pinlist input{font:inherit;width:min(640px,80%);border:1px solid var(--line);border-radius:8px;padding:4px 8px;background:var(--paper);color:var(--ink)}
.pinlist button{font:inherit;border:0;background:none;color:var(--muted);cursor:pointer}
.nlabel{display:block;font-weight:600;margin:12px 0 4px}
textarea{width:100%;font:inherit;border:1px solid var(--line);border-radius:10px;padding:10px;background:var(--paper);color:var(--ink)}
.prev{color:var(--muted);font-size:14px}.prev:not(:empty){margin-top:8px;border-top:1px solid var(--line);padding-top:8px}
.grid{display:grid;grid-template-columns:1fr 1.3fr 1.3fr;gap:20px;margin-top:16px}.grid p{margin:0 0 10px}
.lines{margin:0;padding-left:18px;font-weight:600}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);font-size:15px}
td,th{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.motion td:first-child{white-space:nowrap;font-weight:600}
.bar{position:sticky;top:0;z-index:5;background:var(--paper);border-bottom:1px solid var(--line);padding:8px 16px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.bar .status{color:var(--muted);font-size:14px;margin-left:auto}
.plan{margin:0 0 14px}.plan th{text-align:left;width:22%;color:var(--muted);font-weight:600;vertical-align:top}
.rec{display:inline-block;margin-left:8px;font-size:13px;font-weight:700;border:1px solid var(--line);border-radius:999px;padding:1px 10px}
#zoom{position:fixed;inset:0;background:rgba(0,0,0,.94);display:none;z-index:20;flex-direction:column}#zoom.on{display:flex}
#zoom .zbar{display:flex;gap:8px;align-items:center;padding:10px 14px;color:#fff}
#zoom .zbar button{font:inherit;font-weight:600;border:1px solid #555;background:#222;color:#fff;border-radius:999px;padding:5px 12px;cursor:pointer}
#zoom .zbar button[aria-pressed="true"]{background:#fff;color:#111}
#zoom .zlabel{margin-left:auto;font-size:14px;color:#ccc}
#zoom .zstage{flex:1;overflow:auto;cursor:grab}#zoom .zstage.drag{cursor:grabbing}#zoom .zstage.pinning{cursor:crosshair}
#zoom .zframe{position:relative;margin:auto;line-height:0}#zoom .zframe img{width:100%;display:block}
.qs li{margin-bottom:6px}details{margin-top:36px}summary{cursor:pointer;font-weight:600}
@media (max-width:820px){.pair,.grid{grid-template-columns:1fr}}
"""

JS = r"""
document.documentElement.classList.add('js');
const DATA = JSON.parse(document.getElementById('board-data').textContent);
const KEY = 'video-director-notes:v1:' + DATA.kind + ':' + DATA.title + ':' + DATA.version + ':' + location.pathname;
let store = {general: '', cards: {}};
let saving = true;
try { const s = localStorage.getItem(KEY); if (s) store = Object.assign(store, JSON.parse(s)); } catch (err) { saving = false; }
for (const c of Object.values(store.cards || {})) { c.note = c.note || ''; c.pins = (c.pins || []).map(p => Object.assign({text: ''}, p)); }
const cardData = k => store.cards[k] || (store.cards[k] = {note: '', pins: []});
function save() { try { localStorage.setItem(KEY, JSON.stringify(store)); saving = true; } catch (err) { saving = false; } status(); }
function count() { let n = store.general.trim() ? 1 : 0; for (const c of Object.values(store.cards)) n += (c.note.trim() ? 1 : 0) + c.pins.filter(p => p.text.trim()).length; return n; }
function status() { document.querySelectorAll('.status').forEach(el => el.textContent = count() + ' notes' + (saving ? ' · saved in this browser' : ' · this browser is not saving notes; copy or download them before closing')); }

/* variants (options pages) */
document.querySelectorAll('.vbtn').forEach(b => b.addEventListener('click', () => {
  document.body.dataset.variant = b.dataset.v;
  document.querySelectorAll('.vbtn').forEach(x => x.classList.toggle('on', x === b));
  const css = document.getElementById('vcss'); css.textContent = 'img[data-v]{display:none}img[data-v="' + b.dataset.v + '"]{display:block}';
}));
const visibleImg = fig => [...fig.querySelectorAll('img')].find(i => i.offsetParent !== null || getComputedStyle(i).display !== 'none') || fig.querySelector('img');

/* tabs */
function show(card, i) {
  const figs = card.querySelectorAll('.fv'), tabs = card.querySelectorAll('.tab');
  if (!figs.length) return;
  i = (i + figs.length) % figs.length;
  figs.forEach((f, k) => f.classList.toggle('on', k === i)); tabs.forEach((t, k) => t.classList.toggle('on', k === i));
  card.dataset.i = i;
}
function currentCard() {
  let best = null, dist = Infinity; const mid = innerHeight / 2;
  document.querySelectorAll('.card').forEach(c => { if (!c.querySelector('.fv')) return; const r = c.querySelector('.stack').getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight) return; const d = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid)); if (d < dist) { dist = d; best = c; } });
  return best;
}

/* pins */
function drawPins(card) {
  const cd = cardData(card.dataset.key);
  card.querySelectorAll('.fv').forEach((fig, fi) => {
    const wrap = fig.querySelector('.fwrap'); wrap.querySelectorAll('.pin').forEach(p => p.remove());
    cd.pins.forEach((p, n) => { if (p.f !== fi) return; const d = document.createElement('div'); d.className = 'pin'; d.textContent = n + 1; d.style.left = (p.x * 100) + '%'; d.style.top = (p.y * 100) + '%'; d.title = p.text; d.addEventListener('click', ev => { ev.stopPropagation(); show(card, fi); card.querySelectorAll('.pinlist input')[n]?.focus(); }); wrap.append(d); });
  });
  const list = card.querySelector('.pinlist'); list.replaceChildren();
  cd.pins.forEach((p, n) => {
    const li = document.createElement('li'), inp = document.createElement('input'), del = document.createElement('button');
    inp.value = p.text; inp.placeholder = 'Pin ' + (n + 1) + ' on ' + (card.querySelectorAll('.fv')[p.f]?.dataset.label || 'frame');
    inp.addEventListener('input', () => { p.text = inp.value; save(); });
    del.textContent = 'Remove'; del.type = 'button'; del.addEventListener('click', () => { cd.pins.splice(n, 1); save(); drawPins(card); });
    li.append(inp, ' ', del); list.append(li);
  });
}
function addPin(card, fi, x, y, text) {
  const cd = cardData(card.dataset.key); cd.pins.push({f: fi, x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, text: text || ''});
  save(); drawPins(card);
  if (text === undefined) { const inputs = card.querySelectorAll('.pinlist input'); inputs[inputs.length - 1]?.focus(); }
}

/* zoom */
const Z = {el: document.getElementById('zoom'), level: 1, items: [], i: 0, card: null, pinning: false};
Z.stage = Z.el.querySelector('.zstage'); Z.frame = Z.el.querySelector('.zframe'); Z.img = Z.frame.querySelector('img'); Z.label = Z.el.querySelector('.zlabel');
function fitWidth() { const r = Z.stage.getBoundingClientRect(), ratio = Z.img.naturalWidth / Z.img.naturalHeight || 16 / 9; return Math.max(40, Math.min(r.width - 32, (r.height - 32) * ratio)); }
function setZoom(level, cx, cy) {
  const s = Z.stage.getBoundingClientRect(), f = Z.frame.getBoundingClientRect();
  const fx = cx === undefined ? .5 : (cx - f.left) / f.width, fy = cy === undefined ? .5 : (cy - f.top) / f.height;
  Z.level = Math.max(1, Math.min(8, level)); Z.frame.style.width = (fitWidth() * Z.level) + 'px';
  const nf = Z.frame.getBoundingClientRect();
  Z.stage.scrollLeft += nf.left + fx * nf.width - (cx === undefined ? s.left + s.width / 2 : cx);
  Z.stage.scrollTop += nf.top + fy * nf.height - (cy === undefined ? s.top + s.height / 2 : cy);
  Z.el.querySelector('.zlevel').textContent = (+Z.level.toFixed(1)) + '×';
}
function zoomPins() {
  Z.frame.querySelectorAll('.pin').forEach(p => p.remove());
  const it = Z.items[Z.i]; if (!Z.card || it.fi === undefined) return;
  cardData(Z.card.dataset.key).pins.forEach((p, n) => { if (p.f !== it.fi) return; const d = document.createElement('div'); d.className = 'pin'; d.textContent = n + 1; d.title = p.text; d.style.left = (p.x * 100) + '%'; d.style.top = (p.y * 100) + '%'; Z.frame.append(d); });
}
function zshow(i) {
  Z.i = (i + Z.items.length) % Z.items.length; const it = Z.items[Z.i];
  Z.img.src = it.src; Z.label.textContent = it.label;
  if (Z.card && it.fi !== undefined) show(Z.card, it.fi);
  const go = () => { setZoom(Z.level); zoomPins(); };
  Z.img.complete ? go() : Z.img.onload = go;
}
function openZoom(items, i, card) { Z.items = items; Z.card = card; Z.level = 1; Z.el.querySelector('.zpin').hidden = !card; Z.el.classList.add('on'); zshow(i); Z.el.querySelector('.zclose').focus(); }
function closeZoom() { Z.el.classList.remove('on'); Z.pinning = false; Z.stage.classList.remove('pinning'); Z.el.querySelector('.zpin').setAttribute('aria-pressed', 'false'); if (Z.card) drawPins(Z.card); }
Z.el.querySelectorAll('[data-z]').forEach(b => b.addEventListener('click', () => setZoom(+b.dataset.z)));
Z.el.querySelector('.zprev').addEventListener('click', () => zshow(Z.i - 1));
Z.el.querySelector('.znext').addEventListener('click', () => zshow(Z.i + 1));
Z.el.querySelector('.zclose').addEventListener('click', closeZoom);
Z.el.querySelector('.zpin').addEventListener('click', ev => { Z.pinning = !Z.pinning; ev.currentTarget.setAttribute('aria-pressed', String(Z.pinning)); Z.stage.classList.toggle('pinning', Z.pinning); });
Z.stage.addEventListener('wheel', ev => { if (!ev.ctrlKey && !ev.metaKey) return; ev.preventDefault(); setZoom(Z.level * (ev.deltaY < 0 ? 1.15 : 1 / 1.15), ev.clientX, ev.clientY); }, {passive: false});
let drag = null;
Z.stage.addEventListener('pointerdown', ev => { drag = {x: ev.clientX, y: ev.clientY, sl: Z.stage.scrollLeft, st: Z.stage.scrollTop, moved: false}; });
Z.stage.addEventListener('pointermove', ev => { if (!drag) return; const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; Z.stage.classList.add('drag'); } Z.stage.scrollLeft = drag.sl - dx; Z.stage.scrollTop = drag.st - dy; });
Z.stage.addEventListener('pointerup', ev => {
  const d = drag; drag = null; Z.stage.classList.remove('drag'); if (!d || d.moved) return;
  const f = Z.frame.getBoundingClientRect(), inside = ev.clientX >= f.left && ev.clientX <= f.right && ev.clientY >= f.top && ev.clientY <= f.bottom;
  if (!inside) { if (ev.target === Z.stage) closeZoom(); return; }
  const it = Z.items[Z.i];
  if (Z.pinning && Z.card && it.fi !== undefined) { const text = prompt('Note for this pin'); if (text === null) return; addPin(Z.card, it.fi, (ev.clientX - f.left) / f.width, (ev.clientY - f.top) / f.height, text); zoomPins(); return; }
  setZoom(Z.level > 1.01 ? 1 : 4, ev.clientX, ev.clientY);
});
addEventListener('resize', () => { if (Z.el.classList.contains('on')) setZoom(Z.level); });

/* wire cards */
document.querySelectorAll('.card').forEach(card => {
  card.dataset.i = 0;
  const cd = cardData(card.dataset.key);
  card.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => show(card, +b.dataset.i)));
  const pinbtn = card.querySelector('.pinbtn');
  pinbtn.addEventListener('click', () => { const on = pinbtn.getAttribute('aria-pressed') !== 'true'; pinbtn.setAttribute('aria-pressed', String(on)); card.classList.toggle('pinning', on); });
  card.querySelectorAll('.fv').forEach((fig, fi) => fig.querySelector('.fwrap').addEventListener('click', ev => {
    if (ev.target.classList.contains('pin')) return;
    if (card.classList.contains('pinning')) { const r = ev.currentTarget.getBoundingClientRect(); addPin(card, fi, (ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height); return; }
    const items = [...card.querySelectorAll('.fv')].map((f, k) => ({src: visibleImg(f).src, label: card.dataset.label + ' · ' + f.dataset.label, fi: k}));
    openZoom(items, fi, card);
  }));
  const ta = card.querySelector('textarea.note'); ta.value = cd.note; ta.addEventListener('input', () => { cd.note = ta.value; save(); });
  const prev = (DATA.previous_notes?.cards || []).find(c => c.key === card.dataset.key);
  if (prev && (prev.note || prev.pins?.length)) {
    const box = card.querySelector('.prev'); box.innerHTML = '<b>Notes on the last version</b>';
    if (prev.note) { const p = document.createElement('p'); p.textContent = prev.note; box.append(p); }
    for (const pin of prev.pins || []) { const p = document.createElement('p'); p.textContent = '• ' + (pin.frame_label ? pin.frame_label + ': ' : '') + pin.text; box.append(p); }
  }
  drawPins(card);
});
document.querySelectorAll('.pair img').forEach(img => img.addEventListener('click', () => {
  const imgs = [...img.closest('.pair').querySelectorAll('img')]; openZoom(imgs.map(i => ({src: i.src, label: i.alt})), imgs.indexOf(img), null);
}));
const gen = document.getElementById('general'); if (gen) { gen.value = store.general; gen.addEventListener('input', () => { store.general = gen.value; save(); }); }
if (DATA.previous_notes?.general) { const box = document.getElementById('prev-general'); box.innerHTML = '<b>Overall notes on the last version</b>'; const p = document.createElement('p'); p.textContent = DATA.previous_notes.general; box.append(p); }

/* export / import */
function exportNotes() {
  const cards = [...document.querySelectorAll('.card')].map(card => {
    const cd = cardData(card.dataset.key), labels = [...card.querySelectorAll('.fv')].map(f => f.dataset.label + ' (' + f.querySelector('figcaption').textContent.split(' · ').pop() + ')');
    return {key: card.dataset.key, kind: card.dataset.kind, label: card.dataset.label, note: cd.note, pins: cd.pins.filter(p => p.text.trim()).map(p => ({frame: p.f, frame_label: labels[p.f], x: p.x, y: p.y, text: p.text}))};
  }).filter(c => c.note.trim() || c.pins.length);
  return {format: 'video-director-storyboard-notes', format_version: 1, title: DATA.title, version: DATA.version, exported_at: new Date().toISOString(), general: store.general, cards};
}
function markdown(x) {
  let md = '# Notes on ' + x.title + ' ' + x.version + '\n\n';
  if (x.general.trim()) md += '## Overall\n' + x.general.trim() + '\n\n';
  for (const c of x.cards) {
    md += '## ' + c.label + '\n'; if (c.note.trim()) md += c.note.trim() + '\n';
    for (const p of c.pins) md += '- Pin on ' + p.frame_label + ' at ' + Math.round(p.x * 100) + '% across, ' + Math.round(p.y * 100) + '% down: ' + p.text + '\n';
    md += '\n';
  }
  return md;
}
document.querySelectorAll('.act-copy').forEach(b => b.addEventListener('click', async () => {
  const md = markdown(exportNotes());
  try { await navigator.clipboard.writeText(md); b.textContent = 'Copied'; } catch (err) { const t = document.createElement('textarea'); t.value = md; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); b.textContent = 'Copied'; }
  setTimeout(() => b.textContent = 'Copy all notes', 1500);
}));
document.querySelectorAll('.act-download').forEach(b => b.addEventListener('click', () => {
  const a = document.createElement('a'), slug = (DATA.title + '-' + DATA.version).toLowerCase().replace(/[^a-z0-9.]+/g, '-');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(exportNotes(), null, 2)], {type: 'application/json'})); a.download = 'notes-' + slug + '.json'; a.click();
}));
document.querySelectorAll('.act-import').forEach(inp => inp.addEventListener('change', async () => {
  try {
    const x = JSON.parse(await inp.files[0].text()); if (x.format !== 'video-director-storyboard-notes') throw new Error('not a notes file');
    if (count() && !confirm('Replace the notes on this page with the imported ones?')) return;
    store = {general: x.general || '', cards: {}};
    for (const c of x.cards || []) store.cards[c.key] = {note: c.note || '', pins: (c.pins || []).map(p => ({f: p.frame || 0, x: p.x || 0, y: p.y || 0, text: p.text || ''}))};
    save(); location.reload();
  } catch (err) { alert('Could not import: ' + err.message); }
}));
document.addEventListener('keydown', ev => {
  if (ev.target.matches?.('input,textarea')) return;
  if (Z.el.classList.contains('on')) { if (ev.key === 'Escape') closeZoom(); if (ev.key === 'ArrowRight') zshow(Z.i + 1); if (ev.key === 'ArrowLeft') zshow(Z.i - 1); return; }
  const current = currentCard(); if (!current) return; if (ev.key === 'ArrowRight') show(current, +current.dataset.i + 1); if (ev.key === 'ArrowLeft') show(current, +current.dataset.i - 1);
});
status();
"""


def page(data: dict, body: str, variants_bar: str = "") -> str:
    payload = {"kind": data.get("kind", "storyboard"), "title": data["title"], "version": data["version"], "previous_notes": data.get("previous_notes")}
    blob = json.dumps(payload, ensure_ascii=False).replace("<", "\\u003c")
    bar = f"""<div class="bar">{variants_bar}<button type="button" class="act act-copy">Copy all notes</button>
<button type="button" class="act act-download">Download notes</button>
<label class="act">Import notes<input type="file" accept="application/json" class="act-import" hidden></label><span class="status"></span></div>"""
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(data['title'])} {e(data['version'])}</title><style>{CSS}</style><style id="vcss"></style></head><body>
{bar}<main>{body}
<h2>Overall notes</h2><textarea id="general" rows="5" placeholder="Anything about the whole thing"></textarea><div class="prev" id="prev-general"></div>
</main>
<div id="zoom" role="dialog" aria-label="Zoomed frame"><div class="zbar"><button type="button" data-z="1">Fit</button><button type="button" data-z="2">2×</button>
<button type="button" data-z="4">4×</button><button type="button" data-z="8">8×</button><span class="zlevel">1×</span>
<button type="button" class="zprev">←</button><button type="button" class="znext">→</button><button type="button" class="zpin" aria-pressed="false">Add pin</button>
<span class="zlabel"></span><button type="button" class="zclose">Close</button></div><div class="zstage"><div class="zframe"><img alt=""></div></div></div>
<script id="board-data" type="application/json">{blob}</script><script>{JS}</script></body></html>"""


def build_storyboard(data: dict, fdir: Path) -> str:
    scenes = data["scenes"]
    for s in scenes:
        s["_frames"] = norm_frames(s["frames"])
    flow = "".join(f"""<a class="flow" href="#s{e(s['id'])}"><img src="{embed(fdir / (s['_frames'][-1]['id'] + '.png'), 480)}" alt="Scene {e(s['id'])} end">
<div class="fmeta">{e(s['id'])} {e(s['name'])}<span>{t(s['start'])}–{t(s['end'])}</span></div><div class="fline">{e(' / '.join(s.get('lines', [])))}</div></a>""" for s in scenes)
    changes = ""
    for a, b in zip(scenes, scenes[1:]):
        key = f"t:{a['id']}>{b['id']}"
        changes += f"""<div class="block"><div class="pair"><div><img src="{embed(fdir / (a['_frames'][-1]['id'] + '.png'), 960)}" alt="End of {e(a['id'])} {e(a['name'])}"><div class="cap">End of {e(a['id'])} · {e(a['name'])}</div></div>
<div><img src="{embed(fdir / (b['_frames'][0]['id'] + '.png'), 960)}" alt="Start of {e(b['id'])} {e(b['name'])}"><div class="cap">Start of {e(b['id'])} · {e(b['name'])}</div></div></div>
<p class="bridge"><b>{e(a['id'])} → {e(b['id'])}</b> {move_text(a.get('to_next'))}</p>
<div class="card" data-key="{e(key)}" data-kind="transition" data-label="Change {e(a['id'])} → {e(b['id'])}" style="display:contents"><div class="tabs" hidden></div><div class="stack" hidden></div><ol class="pinlist" hidden></ol><button class="pinbtn" hidden></button>
<label class="nlabel">Notes on this change</label><textarea class="note" rows="2" placeholder="Does this change connect the two shots?"></textarea><div class="prev"></div></div></div>"""
    cards = ""
    for s in scenes:
        motion = s.get("motion")
        if isinstance(motion, list):
            rows = "".join(f"<tr><td>{e(str(m.get('from', '')))} → {e(str(m.get('to', '')))}</td><td>{move_text(m)}</td></tr>" for m in motion)
            motion_html = f'<table class="motion">{rows}</table>'
        else:
            motion_html = f"<p>{e(motion or '')}</p>"
        lines = "".join(f"<li>{e(l)}</li>" for l in s.get("lines", []))
        cards += f"""<section class="block" id="s{e(s['id'])}"><header><div class="num">{e(s['id'])}</div><div><h3>{e(s['name'])}</h3>
<div class="sub">{t(s['start'])}–{t(s['end'])} · {s['end'] - s['start']:.1f}s{(' · ' + e(s['kind'])) if s.get('kind') else ''}</div></div></header>
{viewer('s:' + s['id'], 'Scene ' + s['id'] + ' ' + s['name'], fdir, s['_frames'], [], 'scene')}
<div class="grid"><div><h4>On-screen lines</h4><ul class="lines">{lines}</ul><h4 style="margin-top:14px">Sound</h4><p>{e(s.get('sound', ''))}</p></div>
<div><h4>What changes on screen</h4><p>{e(s.get('change', ''))}</p></div><div><h4>Motion inside the scene</h4>{motion_html}</div></div></section>"""
    tables = ""
    for key, title in (("rules", "How things move"), ("people", "How the people move")):
        if data.get(key):
            tables += f"<h2>{title}</h2><table>" + "".join(f"<tr><td><b>{e(r[0])}</b></td><td>{e(r[1])}</td></tr>" for r in data[key]) + "</table>"
    if data.get("techniques"):
        tables += "<h2>Techniques used</h2><table><tr><th>Technique</th><th>Where</th><th>What you'll see</th><th>From</th></tr>" + "".join(
            f"<tr><td><b>{e(x['name'])}</b></td><td>{e(x.get('where', ''))}</td><td>{e(x.get('what', ''))}</td><td>{link(x)}</td></tr>"
            for x in data["techniques"]) + "</table>"
    qs = "".join(f"<li>{e(q)}</li>" for q in data.get("questions", []))
    timing = "".join(f"<tr><td>{e(s['id'])}</td><td>{e(s['name'])}</td><td>{t(s['start'])}</td><td>{t(s['end'])}</td><td>{', '.join(e(f['id']) for f in s['_frames'])}</td></tr>" for s in scenes)
    body = f"""<h1>{e(data['title'])} · Storyboard {e(data['version'])}</h1>
<p class="lede">{e(data.get('date', ''))} · {e(str(data.get('type', '')).replace('-', ' '))}{' · ' if data.get('type') else ''}{e(data.get('format', ''))} · {e(data.get('length', ''))} · Not animated yet</p>
{('<div class="summary">' + e(data['summary']) + '</div>') if data.get('summary') else ''}
<h2>1. The whole video, in order</h2><p class="intro">Each tile shows how the scene ends. Click one to jump to its card.</p><div class="flows">{flow}</div>
<h2>2. How each scene turns into the next</h2><p class="intro">The last frame of each scene beside the first frame of the next, with the move that connects them.</p>{changes}
<h2>3. Scene by scene</h2><p class="intro">One frame at full width. Flip through to see what changes. Use Add pin to leave a comment on a spot in a frame.</p>{cards}
{tables}{('<h2>Questions for you</h2><ol class="qs">' + qs + '</ol>') if qs else ''}
<details><summary>Production details</summary><table><tr><th>Scene</th><th>Name</th><th>Start</th><th>End</th><th>Frames</th></tr>{timing}</table></details>"""
    return page(data, body)


def build_options(data: dict, fdir: Path) -> str:
    v = data.get("variants") or {}
    items = v.get("items", [])
    keys = [i["key"] for i in items]
    vbar = ""
    if items:
        vbar = f'<span class="hint">{e(v.get("label", "Variant"))}:</span>' + "".join(
            f'<button type="button" class="vbtn{" on" if k == 0 else ""}" data-v="{e(i["key"])}">{e(i.get("name", i["key"]))}</button>' for k, i in enumerate(items))
    cards = ""
    for o in data["options"]:
        frames = norm_frames(o["frames"])
        rec = '<span class="rec">Recommended</span>' if o.get("recommended") else ""
        plan = "".join(f"<tr><th>{e(k)}</th><td>{e(val)}</td></tr>" for k, val in (o.get("plan") or {}).items())
        cards += f"""<section class="block" id="o{e(o['key'])}"><header><div class="num">{e(o['key'])}</div><div><h3>{e(o['name'])}{rec}</h3>
<div class="sub">{e(o.get('from', ''))}</div></div></header><p>{e(o.get('summary', ''))}</p>
{('<table class="plan">' + plan + '</table>') if plan else ''}
{viewer('o:' + o['key'], 'Option ' + o['key'] + ' ' + o['name'], fdir, frames, keys, 'option')}</section>"""
    qs = "".join(f"<li>{e(q)}</li>" for q in data.get("questions", []))
    body = f"""<h1>{e(data['title'])} · {e(data.get('decision', 'Options'))} {e(data['version'])}</h1>
<p class="lede">{e(data.get('date', ''))} · {len(data['options'])} options</p>
{('<div class="summary">' + e(data['summary']) + '</div>') if data.get('summary') else ''}{cards}
{('<h2>Questions for you</h2><ol class="qs">' + qs + '</ol>') if qs else ''}"""
    out = page(data, body, vbar)
    if items:
        out = out.replace('<style id="vcss"></style>', f'<style id="vcss">img[data-v]{{display:none}}img[data-v="{e(keys[0])}"]{{display:block}}</style>')
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("data", type=Path)
    ap.add_argument("output", type=Path)
    ap.add_argument("--previous-notes", type=Path, help="notes JSON downloaded from the previous version's page")
    ap.add_argument("--reviews", type=Path, help="JSON list of {id, sha256, reason} dispositions for printed contextual candidates")
    ap.add_argument("--strict", action="store_true", help="fail instead of warn when a frame change or scene change has no named move, timing and easing, or a direction option has an empty plan row")
    args = ap.parse_args()
    if args.output.exists():
        print(f"FAIL: {args.output} exists. Use a new version number; earlier pages stay as the record of each round.", file=sys.stderr)
        return 1
    data = json.loads(args.data.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("storyboard input must be a JSON object")
    for k in ("title", "version"):
        if not data.get(k):
            print(f"FAIL: the JSON needs a {k}", file=sys.stderr)
            return 1
    kind = data.get("kind", "storyboard")
    if kind not in ("storyboard", "options"):
        raise ValueError("kind must be storyboard or options")
    items = data.get("scenes" if kind == "storyboard" else "options")
    if not isinstance(items, list) or not items or any(not isinstance(item, dict) for item in items):
        raise ValueError(f"{kind} requires a nonempty list of objects")
    for item in items:
        frames = item.get("frames")
        if not isinstance(frames, list) or not frames:
            raise ValueError("each scene/option requires a nonempty frames list")
        if any(not (isinstance(frame, str) and frame or isinstance(frame, dict) and isinstance(frame.get("id"), str) and frame["id"]) for frame in frames):
            raise ValueError("every frame needs a nonempty string id")
    fdir = (args.data.parent / data.get("frames_dir", "frames")).resolve()
    if args.previous_notes:
        prev = json.loads(args.previous_notes.read_text(encoding="utf-8"))
        if prev.get("format") != NOTES_FORMAT:
            print("FAIL: --previous-notes must be a notes file downloaded from a storyboard page", file=sys.stderr)
            return 1
        data["previous_notes"] = prev
    for k, sc in enumerate(data.get("scenes", []) if data.get("kind", "storyboard") == "storyboard" else []):
        missing = [f for f in ("id", "name", "start", "end", "frames") if f not in sc]
        if missing:
            print(f"FAIL: scene {k + 1} is missing {', '.join(missing)}", file=sys.stderr)
            return 1
    for k, op in enumerate(data.get("options", []) if data.get("kind") == "options" else []):
        missing = [f for f in ("key", "name", "frames") if f not in op]
        if missing:
            print(f"FAIL: option {k + 1} is missing {', '.join(missing)}", file=sys.stderr)
            return 1
    warns, notes, candidates = check(data, fdir, args.strict)
    for candidate in candidates:
        candidate["sha256"] = hashlib.sha256(args.data.read_bytes() + candidate["id"].encode()).hexdigest()
    reviews = {}
    if args.reviews:
        raw = json.loads(args.reviews.read_text(encoding="utf-8"))
        if not isinstance(raw, list):
            raise ValueError("--reviews must contain a JSON list of {id, sha256, reason}")
        for item in raw:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not isinstance(item.get("reason"), str) or not item["reason"].strip():
                raise ValueError("each review needs a string id and a nonempty reason")
            if item["id"] in reviews:
                raise ValueError(f"duplicate review id: {item['id']}")
            if not isinstance(item.get("sha256"), str):
                raise ValueError("each review requires the printed current sha256")
            reviews[item["id"]] = (item["sha256"], item["reason"].strip())
    pending = [c for c in candidates if reviews.get(c["id"], (None,))[0] != c["sha256"]]
    kind = data.get("kind", "storyboard")
    html_out = build_options(data, fdir) if kind == "options" else build_storyboard(data, fdir)
    args.output.write_text(html_out, encoding="utf-8")
    for w in warns:
        print(f"WARN: {w}")
    for n in notes:
        print(f"NOTE: {n}")
    for c in candidates:
        if reviews.get(c["id"], (None,))[0] == c["sha256"]:
            print(f"REVIEWED {c['id']}: {reviews[c['id']][1]}")
        else:
            print(f"REVIEW {c['id']} sha256={c['sha256']}: {c['detail']}")
    print(f"Built {args.output.resolve()} ({args.output.stat().st_size / 1e6:.1f} MB); "
          f"{len(pending)} contextual candidate(s) need review. Structural completion is not visual approval.")
    return 2 if pending else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        print(f"ERROR: invalid or unreadable storyboard input/output: {exc}", file=sys.stderr)
        raise SystemExit(1)
