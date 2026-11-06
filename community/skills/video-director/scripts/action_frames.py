#!/usr/bin/env python3
"""Look at the frame where an action happens inside a shot: a click, a press, a hand reaching a knob.

python3 <skill>/scripts/action_frames.py --actions build/actions.json --video output/cut-v3.mp4 --out output/actions-v3
python3 <skill>/scripts/action_frames.py --actions build/actions.json --build build/ --video output/cut-v3.mp4 --out output/actions-v3

cut_frames.py only looks around cuts. This script looks at the moments in between, where something is meant to
touch something else. The actions file is a JSON list, one entry per moment:

  {"time": 36.94, "label": "picks the app's camera in the camera menu", "box": [1410, 360, 220, 70]}
  {"time": 36.94, "label": "picks the app's camera in the camera menu",
   "composition": "compositions/join.html", "pointer": "#ptr", "target": "#opt"}

time      film time in seconds (where the click or touch happens)
box       optional target box in video pixels [x, y, width, height]; the strip is cropped around it
composition, pointer, target   (HyperFrames UI scenes, needs --build) the composition file holding the pointer,
          and CSS selectors for the pointer and the thing it should land on. The script loads that composition in
          headless Chrome, seeks it to the click and reads both boxes from the page. It FAILS when the pointer's tip
          is not inside the target, or the pointer or target is not visible.
local_time  optional time inside that composition; by default film time minus the data-start of the clip in
          build/index.html that loads it (give local_time when the composition is loaded more than once)
tip       optional [x, y]: where the pointer's tip sits in the pointer element's own box, in CSS pixels before any
          scaling (default [3, 3]: an arrow drawn from the element's top-left corner). Check it against the SVG.
slack     optional pixels of leeway around the target (default 0)

With --video, each action gets a strip: the whole frame at the action with the target boxed, then zoomed crops
at -0.2 s, -0.07 s, the action, and +0.07 s, with the target boxed (red) and, when read from the page, the pointer's
tip marked (yellow). Open every strip. actions.json in --out lists each result.

A film with no click, press or touch inside a shot (most films without a pointer or a hand on a control) lists
none: an empty list [] writes a record saying so and passes. With --motion-spec, an empty list is flagged (exit 2)
when the spec mentions a click, tap, press, touch or pointer. A missing actions file is still an error.

Sub-compositions are assumed to fill the frame (their pixels are the film's pixels, scaled to the video's size).

Exit 0 all strips written and every pointer on its target; 2 a pointer off its target (fix the move); 1 an error.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

OFFSETS = (-0.2, -0.07, 0.0, 0.07)
DEFAULT_TIP = (3.0, 3.0)

PROBE = r"""
<script id="vd-action-src">
(function () {
  const ACTIONS = %(actions)s;
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
      el.style.visibility = (t >= s - 1e-6 && (isNaN(d) || t < s + d - 1e-6)) ? "" : "hidden";
    }
  }
  function seek(t) { applyClips(t); for (const tl of timelines()) tl.seek(t, false); }
  function opacityChain(el) {
    let o = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden") return 0;
      o *= parseFloat(cs.opacity);
    }
    return o;
  }
  function box(r) { return [r.left, r.top, r.width, r.height].map(v => +v.toFixed(1)); }
  function run() {
    const out = [];
    for (const a of ACTIONS) {
      seek(a.local_time);
      const p = document.querySelector(a.pointer), g = document.querySelector(a.target);
      const row = { index: a.index, pointer_found: !!p, target_found: !!g };
      if (p) {
        const r = p.getBoundingClientRect(), cs = getComputedStyle(p);
        const w = parseFloat(cs.width) || r.width, h = parseFloat(cs.height) || r.height;
        row.pointer_box = box(r);
        row.tip = [+(r.left + a.tip[0] * r.width / w).toFixed(1), +(r.top + a.tip[1] * r.height / h).toFixed(1)];
        row.pointer_opacity = +opacityChain(p).toFixed(3);
      }
      if (g) { row.target_box = box(g.getBoundingClientRect()); row.target_opacity = +opacityChain(g).toFixed(3); }
      out.push(row);
    }
    const r = root();
    const size = [parseFloat(r && r.getAttribute("data-width")) || innerWidth, parseFloat(r && r.getAttribute("data-height")) || innerHeight];
    const el = document.createElement("script"); el.type = "application/json"; el.id = "vd-action";
    el.textContent = JSON.stringify({ size, rows: out });
    document.body.appendChild(el);
  }
  function go() { try { run(); } catch (e) { const el = document.createElement("script"); el.type = "application/json"; el.id = "vd-action"; el.textContent = JSON.stringify({ error: String(e && e.stack || e) }); document.body.appendChild(el); } }
  window.addEventListener("load", () => setTimeout(() => (document.fonts ? document.fonts.ready : Promise.resolve()).then(go), 300));
})();
</script>
"""


def ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], capture_output=True, text=True, check=True)


def probe_video(video: Path) -> tuple[float, int, int]:
    run = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration",
                          "-of", "json", str(video)], capture_output=True, text=True, check=True)
    d = json.loads(run.stdout)
    s = d["streams"][0]
    return float(d["format"]["duration"]), int(s["width"]), int(s["height"])


def load_actions(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict):
        data = data.get("actions")
    if not isinstance(data, list):
        raise ValueError(f"{path}: expected a JSON list of actions ([] when the film has no click, press or touch)")
    out = []
    for i, a in enumerate(data, 1):
        if not isinstance(a, dict) or not isinstance(a.get("time"), (int, float)) or isinstance(a.get("time"), bool):
            raise ValueError(f"action {i}: needs a numeric 'time'")
        if not str(a.get("label", "")).strip():
            raise ValueError(f"action {i}: needs a 'label' saying what should happen")
        box = a.get("box")
        if box is not None and not (isinstance(box, list) and len(box) == 4 and all(isinstance(v, (int, float)) for v in box) and box[2] > 0 and box[3] > 0):
            raise ValueError(f"action {i}: 'box' must be [x, y, width, height] with a positive size")
        ui = [k for k in ("composition", "pointer", "target") if a.get(k)]
        if ui and len(ui) != 3:
            raise ValueError(f"action {i}: a pointer check needs all of composition, pointer and target")
        tip = a.get("tip", list(DEFAULT_TIP))
        if not (isinstance(tip, list) and len(tip) == 2 and all(isinstance(v, (int, float)) for v in tip)):
            raise ValueError(f"action {i}: 'tip' must be [x, y]")
        out.append({**a, "index": i, "label": str(a["label"]).strip(), "tip": [float(tip[0]), float(tip[1])],
                    "slack": float(a.get("slack", 0))})
    return out


def clip_start(build: Path, composition: str) -> float:
    """data-start of the clip in build/index.html that loads this composition."""
    index = build / "index.html"
    if not index.is_file():
        raise ValueError(f"no {index}: give local_time for each action, or a --build folder with index.html")
    html = index.read_text(encoding="utf-8")
    starts = []
    for tag in re.findall(r"<[^>]+data-composition-src=[^>]+>", html):
        src = re.search(r'data-composition-src="([^"]+)"', tag)
        if src and Path(src.group(1)).as_posix() == Path(composition).as_posix():
            start = re.search(r'data-start="([0-9.]+)"', tag)
            if start:
                starts.append(float(start.group(1)))
    if len(starts) > 1:
        raise ValueError(f"{composition} is loaded {len(starts)} times in {index}; give local_time for each of its actions")
    if not starts:
        raise ValueError(f"no clip in {index} loads {composition}; give local_time for that action")
    return starts[0]


def read_pointers(build: Path, actions: list[dict], budget: int) -> dict[int, dict]:
    from check_render import dump_with_script  # Chrome loader shared with the render check

    by_file: dict[str, list[dict]] = {}
    for a in actions:
        if a.get("composition"):
            if "local_time" not in a:
                a["local_time"] = round(a["time"] - clip_start(build, a["composition"]), 3)
            by_file.setdefault(a["composition"], []).append(a)
    found: dict[int, dict] = {}
    for comp, group in by_file.items():
        path = build / comp
        if not path.is_file():
            raise ValueError(f"composition not found: {path}")
        html = path.read_text(encoding="utf-8")
        w = re.search(r'data-width="(\d+)"', html)
        h = re.search(r'data-height="(\d+)"', html)
        size = (int(w.group(1)) if w else 1920, int(h.group(1)) if h else 1080)
        payload = [{"index": a["index"], "local_time": a["local_time"], "pointer": a["pointer"], "target": a["target"], "tip": a["tip"]} for a in group]
        script = PROBE % {"actions": json.dumps(payload).replace("<", "\\u003c")}
        data = dump_with_script(path, size, budget, script, "vd-action")
        for row in data["rows"]:
            found[row["index"]] = {**row, "page_size": data["size"]}
    return found


def judge(a: dict, row: dict) -> tuple[bool, str]:
    if not row.get("pointer_found"):
        return False, f"pointer {a['pointer']} not found in {a['composition']}"
    if not row.get("target_found"):
        return False, f"target {a['target']} not found in {a['composition']}"
    if row["pointer_opacity"] < 0.05:
        return False, f"pointer {a['pointer']} is not visible at {a['local_time']:.2f}s"
    if row["target_opacity"] < 0.05:
        return False, f"target {a['target']} is not visible at {a['local_time']:.2f}s (menu not open yet?)"
    x, y = row["tip"]
    bx, by, bw, bh = row["target_box"]
    s = a["slack"]
    dx = (bx - s - x) if x < bx - s else (x - (bx + bw + s)) if x > bx + bw + s else 0.0
    dy = (by - s - y) if y < by - s else (y - (by + bh + s)) if y > by + bh + s else 0.0
    if dx == 0 and dy == 0:
        return True, f"tip at ({x:.0f}, {y:.0f}) inside {a['target']} [{bx:.0f}, {by:.0f}, {bw:.0f}x{bh:.0f}]"
    where = []
    if dy:
        where.append(f"{dy:.0f} px {'above' if y < by else 'below'}")
    if dx:
        where.append(f"{dx:.0f} px {'left of' if x < bx else 'right of'}")
    return False, f"tip at ({x:.0f}, {y:.0f}) is {' and '.join(where)} {a['target']} [{bx:.0f}, {by:.0f}, {bw:.0f}x{bh:.0f}]"


def crop_for(box: list[float] | None, vw: int, vh: int) -> tuple[int, int, int, int]:
    """A crop around the box with room to see what is nearby; the whole frame with no box."""
    if not box:
        return 0, 0, vw, vh
    x, y, w, h = box
    cw = min(vw, max(w * 1.6, h * 3 * 16 / 9, vw * 0.15))
    ch = min(vh, cw * 9 / 16)
    cx, cy = x + w / 2, y + h / 2
    left = min(max(cx - cw / 2, 0), vw - cw)
    top = min(max(cy - ch / 2, 0), vh - ch)
    return int(left), int(top), int(cw) // 2 * 2, int(ch) // 2 * 2


def strip(video: Path, total: float, a: dict, box: list[float] | None, tip: list[float] | None, vw: int, vh: int,
          out: Path, width: int, tmp: Path) -> tuple[Path, list[float]]:
    cx, cy, cw, ch = crop_for(box, vw, vh)
    marks = []
    if box:
        marks.append(f"drawbox=x={box[0]:.0f}:y={box[1]:.0f}:w={box[2]:.0f}:h={box[3]:.0f}:color=red@0.9:t=3")
    if tip:
        marks.append(f"drawbox=x={tip[0] - 4:.0f}:y={tip[1] - 4:.0f}:w=9:h=9:color=yellow@0.95:t=fill")
    mark = ",".join(marks) + "," if marks else ""
    pngs, times = [], []
    whole = tmp / f"a{a['index']:02d}-whole.png"
    t0 = min(max(a["time"], 0.0), max(total - 0.04, 0.0))
    ffmpeg("-ss", f"{t0:.3f}", "-i", str(video), "-frames:v", "1", "-vf", f"{mark}scale=-2:{int(width * 9 / 16) // 2 * 2}", str(whole))
    pngs.append(whole)
    for i, off in enumerate(OFFSETS):
        t = min(max(a["time"] + off, 0.0), max(total - 0.04, 0.0))
        png = tmp / f"a{a['index']:02d}-{i}.png"
        ffmpeg("-ss", f"{t:.3f}", "-i", str(video), "-frames:v", "1", "-vf",
               f"{mark}crop={cw}:{ch}:{cx}:{cy},scale=-2:{int(width * 9 / 16) // 2 * 2}:flags=lanczos", str(png))
        pngs.append(png)
        times.append(round(t, 3))
    slug = re.sub(r"[^a-z0-9]+", "-", a["label"].lower()).strip("-")[:40]
    dest = out / f"action-{a['index']:02d}-{a['time']:.2f}s-{slug}.jpg"
    inputs = [x for p in pngs for x in ("-i", str(p))]
    ffmpeg(*inputs, "-filter_complex", "".join(f"[{i}:v]" for i in range(len(pngs))) + f"hstack=inputs={len(pngs)}", str(dest))
    return dest, times


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--actions", type=Path, required=True, help="JSON list of action moments")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--video", type=Path, help="the render; each action gets a zoomed strip")
    ap.add_argument("--build", type=Path, help="the HyperFrames project folder, for pointer checks")
    ap.add_argument("--motion-spec", type=Path, help="motion-spec.md; with an empty actions list, any click, tap, "
                    "press, touch or pointer it mentions is flagged")
    ap.add_argument("--width", type=int, default=480, help="width of each crop in the strip")
    ap.add_argument("--budget", type=int, default=8000, help="Chrome virtual time budget in ms")
    args = ap.parse_args()
    actions = load_actions(args.actions)
    if not actions:
        hits = []
        if args.motion_spec:
            words = re.compile(r"\b(click\w*|tap\w*|press(es|ed|ing)?|touch\w*|cursor|pointer)\b", re.I)
            hits = [f"{args.motion_spec}:{n}: {line.strip()[:120]}"
                    for n, line in enumerate(args.motion_spec.read_text(encoding="utf-8").splitlines(), 1)
                    if words.search(line)]
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "actions.json").write_text(json.dumps({"video": str(args.video.resolve()) if args.video else None,
                                                          "actions": [], "none": True, "motion_spec_mentions": hits},
                                                         indent=2), encoding="utf-8")
        if hits:
            print("REVIEW the actions list is empty, but the motion spec mentions a click, tap, press, touch or "
                  "pointer. List each real one in the actions file, or confirm these lines aren't actions:")
            for h in hits:
                print(f"  {h}")
            return 2
        print("No action moments listed: the film has no click, press or touch inside a shot. Nothing to check.")
        return 0
    ui = [a for a in actions if a.get("composition")]
    if ui and not args.build:
        raise ValueError("actions with a composition need --build <HyperFrames project folder>")
    if not args.video and not ui:
        raise ValueError("nothing to do: give --video for strips, or pointer checks (composition, pointer, target) with --build")
    if args.video and not (shutil.which("ffmpeg") and shutil.which("ffprobe")):
        raise RuntimeError("ffmpeg and ffprobe are required for strips")
    pointers = read_pointers(args.build, actions, args.budget) if ui else {}
    total, vw, vh = probe_video(args.video) if args.video else (0.0, 0, 0)
    if args.video:
        late = [a["time"] for a in actions if not 0 <= a["time"] < total]
        if late:
            raise ValueError(f"action time(s) outside the video (0-{total:.2f}s): {late}")
    args.out.mkdir(parents=True, exist_ok=True)
    rows, failed = [], 0
    with tempfile.TemporaryDirectory() as tmp:
        for a in actions:
            row = {"index": a["index"], "time": a["time"], "label": a["label"]}
            box, tip = a.get("box"), None
            if a["index"] in pointers:
                p = pointers[a["index"]]
                ok, why = judge(a, p)
                row.update({"check": "pointer", "pass": ok, "result": why, "local_time": a["local_time"],
                            "composition": a["composition"], "pointer_tip_page": p.get("tip"), "target_box_page": p.get("target_box")})
                failed += not ok
                if args.video and p.get("target_box"):
                    sx, sy = vw / p["page_size"][0], vh / p["page_size"][1]
                    bx, by, bw, bh = p["target_box"]
                    box = box or [bx * sx, by * sy, bw * sx, bh * sy]
                    if p.get("tip"):
                        tip = [p["tip"][0] * sx, p["tip"][1] * sy]
            if args.video:
                dest, times = strip(args.video, total, a, box, tip, vw, vh, args.out, args.width, Path(tmp))
                row.update({"strip": str(dest), "frames_at": times})
            rows.append(row)
    (args.out / "actions.json").write_text(json.dumps({"video": str(args.video.resolve()) if args.video else None,
                                                        "actions": rows}, indent=2), encoding="utf-8")
    for r in rows:
        if "check" in r:
            print(f"{'PASS' if r['pass'] else 'FAIL'} {r['time']:7.2f}s  {r['label']}: {r['result']}")
        if r.get("strip"):
            print(f"STRIP {r['time']:7.2f}s  {r['strip']}")
    print(f"{len(rows)} action moment(s); {sum('check' in r for r in rows)} pointer check(s), {failed} failed. "
          "Open every strip: frames at -0.2, -0.07, 0 and +0.07 s around each action.")
    return 2 if failed else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, KeyError, json.JSONDecodeError, subprocess.CalledProcessError) as exc:
        detail = exc.stderr.strip()[-400:] if isinstance(exc, subprocess.CalledProcessError) and exc.stderr else str(exc)
        print(f"ERROR: action frames incomplete: {detail}", file=sys.stderr)
        raise SystemExit(1)
