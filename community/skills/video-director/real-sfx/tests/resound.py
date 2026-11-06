#!/usr/bin/env python3
"""The re-sound test: finished videos with a professional sound design are sounded BLIND by the skill, and what comes
out is set against the original sound, in numbers, by the same detector on both sides.

  python tests/resound.py prepare ROOT --refs refs.txt [--n 4] [--seed N]   silent crops + the truth, apart
  python tests/resound.py snapshot ROOT [--skill DIR]                        hash of the skill before the agents
  python tests/resound.py prompt ROOT [--skill DIR] [--run run1] [--reel reel_a]   what to tell a fresh agent
      ... one fresh agent per reel works in ROOT/run1/reel_a/{work,result} ...
  python tests/resound.py eval ROOT [--run run1] [--out eval1]               numbers, A/B files, REPORT.md, plots
  python tests/resound.py check ROOT [--skill DIR]                           the skill folder was not touched

refs.txt is the list `learn_style.py` reads: one video per line, `path | | x0,y0,x1,y1` when only a part of the picture
is the animation (a reel with the After Effects timeline under it: the timeline shows the sound clips, a leak).

Why. A film sounded by the skill can pass the skill's own critique and still be nothing like what a designer does. Here
the designer's film is the ground truth: the skill gets the picture only (no audio stream at all, the timeline cut
away), a fresh agent with nothing but SKILL.md sounds it, and then both sounds are measured the same way. The numbers
say WHERE the sounds differ (density, pauses, first sound, level spread, low end, silence, timing against the other
sound, chance-corrected); they do not say which is better. That is for the ears: `eval` writes the pair as
listen/reel_a_A_original.mp4 and reel_a_B_skill.mp4, the same picture, only the sound differs.

What it needs: python 3 and ffmpeg, like the rest of the skill (no numpy). Pillow draws the plots when it is there.
The agents are started by you (Claude Code: one Agent per reel, the text from `prompt`); this script never starts one.
"""
import argparse
import bisect
import hashlib
import json
import math
import random
import shutil
import statistics
import subprocess
import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL / "scripts"))

SKIP_DIRS = {"vendor", "__pycache__", "styles", ".git", "node_modules"}
BANDS = (("sub 30-80", 30, 80), ("low 80-250", 80, 250), ("lowmid 250-800", 250, 800), ("mid 0.8-2.5k", 800, 2500),
         ("highmid 2.5-6k", 2500, 6000), ("air 6-10k", 6000, 10000))
TOLS = (0.05, 0.10, 0.15)


def run(cmd, check=True):
    r = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, errors="replace")
    if check and r.returncode:
        sys.exit("failed: " + " ".join(str(c) for c in cmd)[:200] + "\n" + r.stderr[-600:])
    return r


def probe(path):
    r = run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate,duration",
             "-of", "json", path])
    s = json.loads(r.stdout)["streams"]
    v = next(x for x in s if x["codec_type"] == "video")
    n, d = v["r_frame_rate"].split("/")
    return int(v["width"]), int(v["height"]), float(n) / float(d or 1), float(v.get("duration") or 0)


def read_refs(path):
    """[(video, (x0, y0, x1, y1) or None)] from a learn_style refs list (a PowerShell BOM is fine)."""
    out = []
    for line in Path(path).read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [x.strip() for x in line.split("|")]
        roi = None
        if len(parts) >= 3 and parts[2]:
            try:
                roi = tuple(float(x) for x in parts[2].split(","))
            except ValueError:
                sys.exit(f"region must be x0,y0,x1,y1 as fractions: {line}")
            if len(roi) != 4:
                sys.exit(f"region must be x0,y0,x1,y1 as fractions: {line}")
        out.append((parts[0], roi))
    return out


# ---------------------------------------------------------------------------------------------------- prepare
def style_without(names):
    """The learned style (styles/clean-sfx-refs.json: it carries the file names of the references) without the
    references called `names`, ready to write; None when there is no learned style (the shipped profile is anonymous:
    nothing can be left out of it) or nothing would be left out."""
    import refstyle
    p = SKILL / "styles" / "clean-sfx-refs.json"
    if not p.exists():
        return None
    d = json.loads(p.read_text(encoding="utf-8"))
    rows = [r for r in d.get("per_ref", []) if r.get("measures")]
    keep = [r for r in rows if Path(str(r.get("video", ""))).name not in names]
    if len(keep) == len(rows) or len(keep) < 3:
        return None
    return {"name": d.get("name", "clean-sfx-refs"), "n_refs": len(keep), "basis": d.get("basis"), "note": d.get("note"),
            "measures": refstyle.aggregate([r["measures"] for r in keep]),
            "per_ref": [{"file": f"reference {i}", "dur": r.get("duration"), **r["measures"]}
                        for i, r in enumerate(keep, 1)]}


def cmd_prepare(a):
    refs = read_refs(a.refs)
    refs = [(v, r) for v, r in refs if Path(v).exists()]
    if len(refs) < a.n:
        sys.exit(f"{len(refs)} reference videos found, {a.n} asked for")
    seed = a.seed if a.seed is not None else random.SystemRandom().randrange(1, 10 ** 9)
    picked = random.Random(seed).sample(range(len(refs)), a.n)
    out = Path(a.root)
    (out / "inputs").mkdir(parents=True, exist_ok=True)
    (out / "truth").mkdir(parents=True, exist_ok=True)
    mapping = {"seed": seed, "reels": {}}
    for letter, idx in zip("abcdefghijklmnopqrstuvwxyz", picked):
        src, roi = refs[idx]
        w, h, fps, vdur = probe(src)
        x0, y0, x1, y1 = roi or (0.0, 0.0, 1.0, 1.0)
        cw, ch = int((x1 - x0) * w) // 2 * 2, int((y1 - y0) * h) // 2 * 2
        cx, cy = int(x0 * w) // 2 * 2, int(y0 * h) // 2 * 2
        vf = f"crop={cw}:{ch}:{cx}:{cy}"
        silent = out / "inputs" / f"reel_{letter}.mp4"
        with_audio = out / "truth" / f"reel_{letter}_original.mp4"
        wav = out / "truth" / f"reel_{letter}_original.wav"
        # the film the skill gets: only the animation, no audio stream at all
        run(["ffmpeg", "-v", "error", "-y", "-nostdin", "-i", src, "-vf", vf, "-an", "-c:v", "libx264", "-preset",
             "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", silent])
        # the same crop with the original sound, for the A/B listening, and the sound alone, for measuring
        run(["ffmpeg", "-v", "error", "-y", "-nostdin", "-i", src, "-vf", vf, "-c:v", "libx264", "-preset", "slow",
             "-crf", "16", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-t", f"{vdur:.3f}",
             "-movflags", "+faststart", with_audio])
        run(["ffmpeg", "-v", "error", "-y", "-nostdin", "-i", src, "-vn", "-t", f"{vdur:.3f}", "-ac", "2", "-ar",
             "48000", "-c:a", "pcm_s16le", wav])
        sw, sh_, _, sdur = probe(silent)
        # the reference style an agent works with must not contain the reel it is sounding (it would see its own
        # numbers in `critique.py --style`): a copy without it, handed over with REAL_SFX_STYLES
        st = style_without({Path(src).name})
        style_dir = None
        if st is not None:
            style_dir = out / "styles" / f"reel_{letter}"
            style_dir.mkdir(parents=True, exist_ok=True)
            (style_dir / "clean-sfx-refs.json").write_text(json.dumps(st, indent=1, ensure_ascii=False), encoding="utf-8")
        mapping["reels"][f"reel_{letter}"] = {"source": str(src), "roi": list(roi) if roi else None,
                                              "crop": [cw, ch, cx, cy], "source_size": [w, h], "fps": fps,
                                              "picture_s": round(vdur, 3), "silent_size": [sw, sh_],
                                              "silent_s": round(sdur, 3),
                                              "style_dir": str(style_dir) if style_dir else None}
        print(f"reel_{letter}: {Path(src).name[:50]}  {w}x{h} -> {sw}x{sh_}  {vdur:.1f} s  {fps:g} fps"
              + ("" if style_dir else "   (reference style: the shipped profile, it has this reel's numbers)"),
              flush=True)
    (out / "truth" / "mapping.json").write_text(json.dumps(mapping, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"seed {seed} -> {out}\nThe agents get inputs/ and nothing else; truth/ is for `eval`.")
    if any(not v["style_dir"] for v in mapping["reels"].values()):
        print("NOTE: no learned styles/clean-sfx-refs.json (with the names of the references) in this skill folder, so "
              "the style an agent sees still holds its own reel's numbers. Learn it first: learn_style.py REFS.txt "
              "--name clean-sfx-refs; or say so in the report.")


# ---------------------------------------------------------------------------------------------------- the skill folder
def tree_hash(skill):
    out = {}
    for p in sorted(Path(skill).rglob("*")):
        if not p.is_file() or any(part in SKIP_DIRS for part in p.relative_to(skill).parts):
            continue
        out[p.relative_to(skill).as_posix()] = hashlib.sha1(p.read_bytes()).hexdigest()
    return out


def cmd_snapshot(a):
    h = tree_hash(a.skill)
    (Path(a.root) / "skill_hash_before.json").write_text(json.dumps(h, indent=1), encoding="utf-8")
    print(f"{len(h)} files of {a.skill} hashed -> {Path(a.root) / 'skill_hash_before.json'}")


def cmd_check(a):
    p = Path(a.root) / "skill_hash_before.json"
    if not p.exists():
        sys.exit("no skill_hash_before.json: run `snapshot` before the agents start")
    before, now = json.loads(p.read_text(encoding="utf-8")), tree_hash(a.skill)
    changed = sorted(k for k in before if k in now and before[k] != now[k])
    added, removed = sorted(set(now) - set(before)), sorted(set(before) - set(now))
    print(f"{len(now)} files now, {len(before)} before: {len(changed)} changed, {len(added)} added, {len(removed)} removed")
    for lab, items in (("changed", changed), ("added", added), ("removed", removed)):
        for k in items[:20]:
            print(f"  {lab}: {k}")
    sys.exit(1 if (changed or added or removed) else 0)


# ---------------------------------------------------------------------------------------------------- the agent's text
PROMPT = """Sound this silent video with the real-sfx skill, from start to finish, like a job for a client.

The film:   {film}   (it has no audio stream at all; it is only the animation)
The skill:  {skill}   (read SKILL.md and follow the workflow; the whole critique loop, until every axis of
            critique.py is 8 or more, at least three rounds)
Work in:    {work}
Result:     {result}/{name}_sfx.mp4   (mix.py --out; its SFX track and resolved cues land next to it)

Rules of this test:
- The original sound of this film exists. Do not look for it: do not read anything under {root}/truth, the folders
  the original videos come from ({sources}), the other reels' folders or other runs, and do not listen to anything but
  your own renders.
{style_rule}
- Do not change anything inside the skill folder (its files are hashed before and after).
- Nothing is synthesized: sounds come from the libraries the skill is configured with.
- Say what you decided and why in your notes as you go; you will be asked for them.

When you are done, hand back as text (you may not be able to write report files): rounds of critique and the final
axes, minutes and tool calls, the sounds used (how many, which libraries), and a list of what was wrong or missing in
the SKILL (defects in code with how you reproduced them, gaps in the documentation, missing features), each naming the
file or step. Do not soften it: the list is the point of the test."""


def cmd_prompt(a):
    mp = json.loads((Path(a.root) / "truth" / "mapping.json").read_text(encoding="utf-8"))
    names = [a.reel] if a.reel else sorted(mp["reels"])
    sources = ", ".join(sorted({str(Path(v["source"]).parent) for v in mp["reels"].values()}))
    for n in names:
        if n not in mp["reels"]:
            sys.exit(f"no {n} in {a.root}/truth/mapping.json")
        d = Path(a.root) / a.run / n
        sd = mp["reels"][n].get("style_dir")
        if sd:
            style_rule = (f"- The skill's reference style (critique.py --style, texture.py, the pacing axis) is made of "
                          f"finished reels and this film is one of them. Before you run any script of the skill set the\n"
                          f"  environment variable REAL_SFX_STYLES to {sd} (PowerShell: $env:REAL_SFX_STYLES = "
                          f"'{sd}'): it holds the same style WITHOUT this reel. Do not open {a.skill}/styles or "
                          f"{a.skill}/references/profiles.")
        else:
            style_rule = ("- The reference style shipped with the skill holds this film's own numbers (no style without "
                          "it could be made): do not tune to it, and say in your report whether you used it.")
        print(f"===== {n} " + "=" * 60)
        print(PROMPT.format(film=Path(a.root) / "inputs" / f"{n}.mp4", skill=a.skill, work=d / "work",
                            result=d / "result", name=n, root=a.root, sources=sources, style_rule=style_rule))
        print()


# ---------------------------------------------------------------------------------------------------- measuring
def _nearest(ref, test):
    """For each reference time: the signed distance to the nearest test time (test - ref); None when test is empty."""
    test = sorted(test)
    out = []
    for r in ref:
        i = bisect.bisect_left(test, r)
        c = [test[j] - r for j in (i - 1, i) if 0 <= j < len(test)]
        out.append(min(c, key=abs) if c else None)
    return out


def agreement(ref_t, test_t, tol, dur=None, shifts=(-1.3, -0.9, -0.6, -0.35, 0.35, 0.6, 0.9, 1.3)):
    """Share of the reference times that have a test time within tol, and the same when the test times are moved by a
    second or so (what a designer with the same density and no relation to the picture would score)."""
    if not ref_t or not test_t:
        return {"recall": 0.0, "chance": 0.0, "lift": 0.0, "median_offset_ms": None}
    d = _nearest(ref_t, test_t)
    hit = [x for x in d if x is not None and abs(x) <= tol]
    rec = len(hit) / len(ref_t)
    ch = []
    for s in shifts:
        ts = [t + s for t in test_t if dur is None or 0 < t + s < dur]
        if ts:
            dd = _nearest(ref_t, ts)
            ch.append(sum(1 for x in dd if x is not None and abs(x) <= tol) / len(ref_t))
    chance = statistics.mean(ch) if ch else 0.0
    lift = (rec - chance) / (1 - chance) if chance < 1 else 0.0
    return {"recall": round(rec, 3), "chance": round(chance, 3), "lift": round(lift, 3),
            "median_offset_ms": round(statistics.median(hit) * 1000) if hit else None}


def correlation(x, y):
    n = min(len(x), len(y))
    if n < 5:
        return None
    x, y = x[:n], y[:n]
    mx, my = sum(x) / n, sum(y) / n
    sx = math.sqrt(sum((v - mx) ** 2 for v in x))
    sy = math.sqrt(sum((v - my) ** 2 for v in y))
    if sx < 1e-9 or sy < 1e-9:
        return None
    return sum((a_ - mx) * (b_ - my) for a_, b_ in zip(x, y)) / (sx * sy)


def silence_stats(env, step=0.25, thr=-55.0):
    """The last half second (the fade-out of any film) is not counted."""
    body = env[: max(0, len(env) - 2)]
    longest = run_ = 0
    for v in body:
        run_ = run_ + 1 if v < thr else 0
        longest = max(longest, run_)
    srt = sorted(env)
    return {"share": round(sum(1 for v in body if v < thr) / len(body), 3) if body else 0.0,
            "longest_s": round(longest * step, 2),
            "median_db": round(srt[len(srt) // 2], 1) if srt else None,
            "p10_db": round(srt[int(0.1 * (len(srt) - 1))], 1) if srt else None}


def band_balance(path, rate=22050):
    import array
    ms = {}
    for name, lo, hi in BANDS:
        r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "1", "-ar", str(rate),
                            "-af", f"highpass=f={lo},lowpass=f={hi}", "-f", "s16le", "-"], capture_output=True)
        x = array.array("h")
        x.frombytes(r.stdout[: len(r.stdout) // 2 * 2])
        ms[name] = sum(v * v for v in x) / max(1, len(x))
    tot = sum(ms.values()) + 1e-9
    return {k: round(10 * math.log10(v / tot + 1e-12), 1) for k, v in ms.items()}


def reference_others(exclude_sources):
    """Aggregate of the learned style (styles/clean-sfx-refs.json) without the references that are in this test; the
    shipped profile has no names, so all its references are used (said in the report)."""
    import refstyle
    p = SKILL / "styles" / "clean-sfx-refs.json"
    names = {Path(s).name for s in exclude_sources}
    if p.exists():
        d = json.loads(p.read_text(encoding="utf-8"))
        rows = [r["measures"] for r in d.get("per_ref", []) if r.get("measures")
                and Path(str(r.get("video", ""))).name not in names]
        if rows:
            return refstyle.aggregate(rows), len(rows), "the learned references that are not in this test"
    st, _ = refstyle.find_style("clean-sfx-refs")
    if st and st.get("measures"):
        return st["measures"], st.get("n_refs") or 0, ("all the shipped references (the profile has no names, so the "
                                                      "ones in this test could not be left out)")
    return {}, 0, "no reference style found"


def find_result(root, run_dir, name):
    d = Path(root) / run_dir / name / "result"
    for cand in (d / f"{name}_sfx.mp4",):
        if cand.exists():
            return cand
    mp4 = sorted((p for p in d.glob("*.mp4")), key=lambda p: p.stat().st_mtime, reverse=True) if d.exists() else []
    return mp4[0] if mp4 else None


def critique_axes(film):
    """The skill's own critique of a result, from its resolved cues and SFX track (None when they are not there)."""
    stem = film.with_suffix("")
    res = Path(f"{stem}_resolved_cues.json")
    if not res.exists():
        found = sorted(film.parent.glob("*_resolved_cues.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        res = found[0] if found else res
    trk = next((p for p in (Path(f"{stem}_sfx_track.wav"), Path(f"{stem}_track.wav")) if p.exists()), None)
    if trk is None:
        loose = [p for p in film.parent.glob("*sfx_track*.wav")
                 if not any(w in p.name for w in ("in_mix_level", "premaster", "nobed", "stem"))]
        trk = loose[0] if loose else None
    if not res.exists() or trk is None:
        return None, None
    r = run([sys.executable, SKILL / "scripts" / "critique.py", res, trk, "--json"], check=False)
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])["axes"], json.loads(res.read_text(encoding="utf-8"))
    except Exception:
        return None, None


def evaluate_reel(a, name, mp, film):
    import learn_style as L
    import refstyle
    orig = Path(a.root) / "truth" / f"{name}_original.wav"
    silent = Path(a.root) / "inputs" / f"{name}.mp4"
    res = {"name": name, "orig": str(orig), "skill": str(film)}
    go, dur_o = refstyle.gestures(orig)
    gs, dur_s = refstyle.gestures(film)
    dur = min(dur_o, dur_s)
    res["dur"] = {"orig": round(dur_o, 2), "skill": round(dur_s, 2)}
    # the time of a gesture is the ONSET of its loudest event (when it came within 10 dB of its peak): a designer puts
    # the start of a sound on the picture, and the peak of a swell lands wherever its length puts it
    tgo, tgs = [g["on"] for g in go], [g["on"] for g in gs]
    res["timing"] = {f"tol{int(t * 1000)}": {"original_voiced_by_skill": agreement(tgo, tgs, t, dur=dur),
                                             "skill_on_original": agreement(tgs, tgo, t, dur=dur)} for t in TOLS}
    # a systematic offset would show as a peak of this curve away from 0 (the skill's whole sound moved by s)
    res["shift_curve_tol60"] = [[s, round(sum(1 for x in _nearest(tgo, [t + s / 1000.0 for t in tgs])
                                             if x is not None and abs(x) <= 0.06) / max(1, len(tgo)), 3)]
                                for s in range(-600, 601, 40)] if tgo and tgs else []
    # the same by the loudest point of the loudest event, and by the first event of each gesture
    res["timing_peak"] = {"tol100": {"original_voiced_by_skill": agreement([g["t"] for g in go], [g["t"] for g in gs],
                                                                           0.10, dur=dur),
                                     "skill_on_original": agreement([g["t"] for g in gs], [g["t"] for g in go],
                                                                    0.10, dur=dur)}}
    res["timing_first_event"] = {"tol100": {"original_voiced_by_skill": agreement([g["on0"] for g in go],
                                                                                  [g["on0"] for g in gs], 0.10, dur=dur),
                                            "skill_on_original": agreement([g["on0"] for g in gs],
                                                                           [g["on0"] for g in go], 0.10, dur=dur)}}
    eo, es = L.env_db(L.decode(orig), 250), L.env_db(L.decode(film), 250)
    n = min(len(eo), len(es))
    eo_, es_ = [max(v, -70.0) for v in eo[:n]], [max(v, -70.0) for v in es[:n]]
    res["envelope_r"] = (round(correlation(eo_, es_), 3) if correlation(eo_, es_) is not None else None)
    shifted = [correlation(eo_[s:], es_[:n - s]) for s in (4, 6, 9, 13) if n > s + 4]
    shifted = [v for v in shifted if v is not None]
    res["envelope_r_chance"] = round(statistics.mean(shifted), 3) if shifted else None
    res["silence"] = {"orig": silence_stats(eo), "skill": silence_stats(es)}
    res["bands_db"] = {"orig": band_balance(orig), "skill": band_balance(film)}
    m_o, m_s = refstyle.measure(orig), refstyle.measure(film)
    agg, n_ref, how = reference_others([v["source"] for v in mp["reels"].values()])
    res["measures"] = {"orig": m_o, "skill": m_s, "reference_others": agg, "n_reference_others": n_ref,
                       "reference_basis": how}
    axes, resolved = critique_axes(film)
    res["critique_axes"] = axes
    if resolved:
        cues = resolved.get("cues", [])
        res["run"] = {"cues": len(cues), "distinct_files": len({c.get("file") for c in cues}),
                      "by_library": _count(c.get("library") or "?" for c in cues),
                      "synthesized": sum(1 for c in cues if c.get("source") == "uisfx"),
                      "bed": bool(resolved.get("bed")),
                      "loudness": (resolved.get("loudness") or {}).get("final")}
    try:
        from find_moments import diff_series, visual_moments
        moms, _ = visual_moments(str(silent), max_other=200, fine=True)
        tm = sorted(m["t"] for m in moms)
        res["picture"] = {"moments": len(tm),
                          "orig_gestures_on_a_move": agreement(tgo, tm, 0.10, dur=dur),
                          "skill_gestures_on_a_move": agreement(tgs, tm, 0.10, dur=dur),
                          "moves_voiced_by_orig": agreement(tm, tgo, 0.10, dur=dur),
                          "moves_voiced_by_skill": agreement(tm, tgs, 0.10, dur=dur)}
        ts, ys, cs = diff_series(str(silent), 25.0)
        sig = [y + c for y, c in zip(ys, cs)]
        res["plot"] = {"pic_t": [round(t, 2) for t in ts[::3]], "pic": [round(v, 2) for v in sig[::3]]}
    except Exception as ex:                       # the picture is a reference, not a requirement
        res["picture_error"] = str(ex)
        res["plot"] = {"pic_t": [], "pic": []}
    res["plot"].update({"env_step": 0.25, "env_orig": [round(v, 1) for v in eo], "env_skill": [round(v, 1) for v in es],
                        "g_orig": [{"t": g["on"], "pk": g["pk"]} for g in go],
                        "g_skill": [{"t": g["on"], "pk": g["pk"]} for g in gs]})
    return res


def _count(items):
    out = {}
    for x in items:
        out[x] = out.get(x, 0) + 1
    return dict(sorted(out.items(), key=lambda kv: -kv[1]))


# ---------------------------------------------------------------------------------------------------- plot, report
def plot(d, dst, tol=0.1):
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return False
    P = d["plot"]
    dur = max(d["dur"]["orig"], d["dur"]["skill"])
    W, M_L, M_R = 1900, 90, 20
    H1, H2, GAP, TOP, BOT = 80, 170, 26, 44, 34
    H = TOP + H1 + GAP + H2 + GAP + H2 + BOT
    img = Image.new("RGB", (W, H), (18, 20, 26))
    dr = ImageDraw.Draw(img)
    try:
        f, fb = ImageFont.truetype("arial.ttf", 14), ImageFont.truetype("arial.ttf", 17)
    except Exception:
        f = fb = ImageFont.load_default()

    def x_of(t):
        return M_L + (W - M_L - M_R) * t / dur

    def panel(y0, h, title):
        dr.rectangle([M_L, y0, W - M_R, y0 + h], outline=(70, 74, 86))
        dr.text((M_L, y0 - 19), title, fill=(220, 224, 232), font=f)

    go, gs = [g["t"] for g in P["g_orig"]], [g["t"] for g in P["g_skill"]]
    t100 = d["timing"]["tol100"]
    dr.text((M_L, 8), f"{d['name']}   {dur:.1f} s   gestures: original {len(go)}, skill {len(gs)}   (+-{int(tol * 1000)} ms)"
            f"   original voiced by the skill {t100['original_voiced_by_skill']['recall']:.0%} (chance "
            f"{t100['original_voiced_by_skill']['chance']:.0%}),  skill on original "
            f"{t100['skill_on_original']['recall']:.0%} (chance {t100['skill_on_original']['chance']:.0%})",
            fill=(240, 240, 245), font=fb)
    y1 = TOP
    panel(y1, H1, "picture change")
    pic, pt = P.get("pic") or [], P.get("pic_t") or []
    if len(pic) > 1:
        top = sorted(pic)[int(0.97 * (len(pic) - 1))] or max(pic) or 1.0       # one cut must not flatten the rest
        dr.line([(x_of(t), y1 + H1 - 4 - (H1 - 10) * min(1.0, v / top)) for t, v in zip(pt, pic)],
                fill=(150, 160, 180), width=1)

    def sound_panel(y0, title, env, g, pk, other, c_ok, c_bad):
        panel(y0, H2, title)
        lo, hi = -70.0, max(-6.0, max(env) if env else -6.0)
        pts = [(x_of(i * P["env_step"]), y0 + H2 - 6 - (H2 - 14) * (max(lo, v) - lo) / (hi - lo))
               for i, v in enumerate(env)]
        if len(pts) > 1:
            dr.line(pts, fill=(110, 130, 160), width=1)
        p_lo, p_hi = (min(pk), max(pk)) if pk else (0.0, 1.0)
        for t, p in zip(g, pk):
            ok = any(abs(t - o) <= tol for o in other)
            frac = 0.35 + 0.65 * ((p - p_lo) / (p_hi - p_lo) if p_hi > p_lo else 1.0)
            dr.line([(x_of(t), y0 + H2 - 2), (x_of(t), y0 + H2 - 2 - (H2 - 6) * frac)], fill=c_ok if ok else c_bad,
                    width=3)

    y2 = y1 + H1 + GAP
    sound_panel(y2, "original sound (green: the skill has a gesture within the tolerance; red: it has not; tick height "
                    "= loudness)", P["env_orig"], go, [g["pk"] for g in P["g_orig"]], gs, (74, 222, 128), (248, 90, 90))
    y3 = y2 + H2 + GAP
    sound_panel(y3, "the skill's sound (green: the original has a gesture there; orange: an extra sound)",
                P["env_skill"], gs, [g["pk"] for g in P["g_skill"]], go, (74, 222, 128), (251, 170, 60))
    step = 1 if dur <= 20 else 2 if dur <= 40 else 5
    t, yb = 0.0, y3 + H2 + 6
    while t <= dur + 1e-6:
        dr.line([(x_of(t), y1), (x_of(t), yb)], fill=(40, 44, 54), width=1)
        dr.text((x_of(t) - 8, yb + 4), f"{t:g}", fill=(190, 195, 205), font=f)
        t += step
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    img.save(dst)
    return True


KEYS = (("gest10", "gestures per 10 s"), ("gap_med", "gap between gestures, median, s"), ("gap_p90", "gap, P90, s"),
        ("gap_max", "longest gap, s"), ("spread_db", "level spread of gestures P90-P10, dB"),
        ("typ_db", "typical gesture vs the loudest, dB"), ("first_s", "first sound, s"),
        ("low_share", "gestures with low end, %"), ("bed", "sub bed 30-100 Hz, % of time"),
        ("floor_db", "the quietest tenth under the loudest, dB"), ("silent", "digital silence, % of time"),
        ("lufs", "loudness, LUFS"))


def report(root, mp, results, out_dir, run_dir, plots):
    pc = lambda x: f"{100 * x:.0f} %"
    names = sorted(results)
    L = [f"# Re-sound test: {run_dir}\n",
         f"Seed {mp.get('seed')}. {len(mp['reels'])} reels: only the animation was cut out (no timeline), ALL audio was "
         f"removed, a fresh agent per reel sounded them from SKILL.md without seeing the original. The original sound "
         f"(`truth/`) was used for comparison only. Both sounds are measured by the same code, so a difference is a "
         f"difference of the SOUND, not of the ruler.\n"]
    L.append("## 1. What each run produced\n")
    L.append("| reel | sounds | distinct files | by library | synthesized | bed | final loudness | critique axes (lowest) |")
    L.append("|---|---|---|---|---|---|---|---|")
    for n in names:
        r = results[n].get("run") or {}
        ax = results[n].get("critique_axes") or {}
        low = min(((v, k) for k, v in ax.items() if isinstance(v, (int, float))), default=None)
        lib = ", ".join(f"{k} {v}" for k, v in list((r.get("by_library") or {}).items())[:4])
        loud = r.get("loudness") or {}
        L.append(f"| {n} | {r.get('cues', '-')} | {r.get('distinct_files', '-')} | {lib or '-'} | "
                 f"{r.get('synthesized', '-')} | {'yes' if r.get('bed') else 'no'} | "
                 f"{loud.get('lufs', '-')} LUFS, {loud.get('true_peak', '-')} dBTP | "
                 f"{(str(round(low[0], 1)) + ' (' + low[1] + ')') if low else '-'} |")
    L.append("")
    how = next((results[n]["measures"].get("reference_basis") for n in names if results[n].get("measures")), "")
    L.append(f"## 2. The same measures, original | skill, and the median of the references ({how})\n")
    L.append("| measure | " + " | ".join(names) + " | reference median |")
    L.append("|---|" + "---|" * (len(names) + 1))
    for k, lab in KEYS:
        row, ref = f"| {lab} |", None
        for n in names:
            m = results[n]["measures"]
            o, s = m["orig"].get(k), m["skill"].get(k)
            ref = ref if ref is not None else (m["reference_others"].get(k) or {}).get("median")
            row += f" {o if o is not None else '-'} \\| {s if s is not None else '-'} |"
        L.append(row + f" {ref if ref is not None else '-'} |")
    L.append("")
    L.append("## 3. Timing against the original sound, and the shape of the loudness\n")
    L.append("| reel | original gestures voiced by the skill, +-100 ms, onsets (chance) | skill gestures on an original "
             "gesture (chance) | same by the loudest point (chance) | median offset, ms | loudness shape r (chance) |")
    L.append("|---|---|---|---|---|---|")
    for n in names:
        d = results[n]
        t = d["timing"]["tol100"]
        o, s = t["original_voiced_by_skill"], t["skill_on_original"]
        pk = d["timing_peak"]["tol100"]["original_voiced_by_skill"]
        L.append(f"| {n} | {pc(o['recall'])} ({pc(o['chance'])}) | {pc(s['recall'])} ({pc(s['chance'])}) | "
                 f"{pc(pk['recall'])} ({pc(pk['chance'])}) | "
                 f"{o['median_offset_ms'] if o['median_offset_ms'] is not None else '-'} | "
                 f"{d['envelope_r']} ({d['envelope_r_chance']}) |")
    L.append("\nA gesture is sounds with no pause longer than 0.25 s. Its time is the ONSET of its loudest sound (when it "
             "came within 10 dB of its peak): a designer puts the start of a sound on the picture. When both sounds are "
             "dense the chance of a match is high and the test is weak: read the difference from chance.\n")
    L.append("## 4. Presence and silence (250 ms envelope, dBFS)\n")
    L.append("| reel | original: median / P10 / digital silence | skill: median / P10 / digital silence |")
    L.append("|---|---|---|")
    for n in names:
        o, k = results[n]["silence"]["orig"], results[n]["silence"]["skill"]
        L.append(f"| {n} | {o['median_db']} / {o['p10_db']} / {pc(o['share'])} (longest {o['longest_s']} s) | "
                 f"{k['median_db']} / {k['p10_db']} / {pc(k['share'])} (longest {k['longest_s']} s) |")
    L.append("\n## 5. Tonal balance (share of the energy per band, dB), original | skill\n")
    L.append("| reel | " + " | ".join(b[0] for b in BANDS) + " |")
    L.append("|---|" + "---|" * len(BANDS))
    for n in names:
        b = results[n]["bands_db"]
        L.append(f"| {n} | " + " | ".join(f"{b['orig'][k[0]]} \\| {b['skill'][k[0]]}" for k in BANDS) + " |")
    pics = [n for n in names if results[n].get("picture")]
    if pics:
        L.append("\n## 6. The picture as a reference\n")
        L.append("| reel | picture moves | moves voiced by the original (chance) | moves voiced by the skill (chance) |")
        L.append("|---|---|---|---|")
        for n in pics:
            p = results[n]["picture"]
            vo, vs = p["moves_voiced_by_orig"], p["moves_voiced_by_skill"]
            L.append(f"| {n} | {p['moments']} | {pc(vo['recall'])} ({pc(vo['chance'])}) | "
                     f"{pc(vs['recall'])} ({pc(vs['chance'])}) |")
    L.append("\n## 7. What the agents found in the skill\n")
    L.append("_(from the agents' own reports; add them here: defects in code with how they were reproduced, gaps in "
             "SKILL.md, missing features, each with the file or step. Reproduce a defect before touching it.)_\n")
    L.append("## 8. What this test does not say\n")
    L.append("- Neither the skill nor this script can hear: the numbers say where a sound differs from the original, not "
             "that it is better or worse. The listening pairs decide: " +
             ", ".join(f"`listen/{n}_A_original.mp4` (A = original) and `{n}_B_skill.mp4` (B = skill)" for n in names[:2]) +
             (", ..." if len(names) > 2 else "") + "; the picture and the frame size are the same, only the sound differs.")
    L.append("- A few reels, one agent each, one run: a difference of a few percent is noise.")
    L.append("- An original is a showcase or a finished piece with its own music: not always 'clean SFX'.")
    if plots:
        L.append("\nPlots: " + ", ".join(f"`{n}.png`" for n in names if (out_dir / f"{n}.png").exists()) + ".")
    return "\n".join(L) + "\n"


def cmd_eval(a):
    mp = json.loads((Path(a.root) / "truth" / "mapping.json").read_text(encoding="utf-8"))
    out = Path(a.root) / a.out
    (out / "listen").mkdir(parents=True, exist_ok=True)
    results, plots = {}, False
    for name in sorted(mp["reels"]):
        film = find_result(a.root, a.run, name)
        if film is None:
            print(f"{name}: no result in {Path(a.root) / a.run / name / 'result'}")
            continue
        print(f"{name}: {film.name} ...", flush=True)
        d = evaluate_reel(a, name, mp, film)
        results[name] = d
        (out / f"{name}.json").write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
        plots = plot(d, out / f"{name}.png") or plots
        shutil.copyfile(Path(a.root) / "truth" / f"{name}_original.mp4", out / "listen" / f"{name}_A_original.mp4")
        shutil.copyfile(film, out / "listen" / f"{name}_B_skill.mp4")
        t = d["timing"]["tol100"]
        g = d["measures"]
        print(f"   gestures per 10 s: original {g['orig'].get('gest10')}, skill {g['skill'].get('gest10')}; "
              f"+-100 ms: original voiced by the skill {t['original_voiced_by_skill']['recall']:.0%} (chance "
              f"{t['original_voiced_by_skill']['chance']:.0%}); loudness shape r {d['envelope_r']} "
              f"(chance {d['envelope_r_chance']})")
    if not results:
        sys.exit("nothing to evaluate")
    (out / "REPORT.md").write_text(report(a.root, mp, results, out, a.run, plots), encoding="utf-8")
    print(f"-> {out / 'REPORT.md'}" + ("" if plots else "   (no plots: Pillow is not installed)"))
    # the ears: the original and the skill's sound under 1 and 2 in a random order, one question per reel
    ab = []
    for name in sorted(results):
        ab += ["--ab", name, str(out / "listen" / f"{name}_A_original.mp4"), str(out / "listen" / f"{name}_B_skill.mp4")]
    r = run([sys.executable, SKILL / "scripts" / "listen_page.py", "build", out / "listen_page", *ab, "--labels",
             "original", "skill", "--title", f"{a.run}: which one is the original?"], check=False)
    if r.returncode == 0:
        print(f"blind listening: python scripts/listen_page.py serve {out / 'listen_page'}   (then `results` on it)")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("root")
    p.add_argument("--refs", required=True, help="a learn_style.py list: path | | x0,y0,x1,y1")
    p.add_argument("--n", type=int, default=4)
    p.add_argument("--seed", type=int)
    p = sub.add_parser("snapshot")
    p.add_argument("root")
    p.add_argument("--skill", default=str(SKILL))
    p = sub.add_parser("check")
    p.add_argument("root")
    p.add_argument("--skill", default=str(SKILL))
    p = sub.add_parser("prompt")
    p.add_argument("root")
    p.add_argument("--skill", default=str(SKILL))
    p.add_argument("--run", default="run1")
    p.add_argument("--reel")
    p = sub.add_parser("eval")
    p.add_argument("root")
    p.add_argument("--run", default="run1")
    p.add_argument("--out", default="eval1")
    a = ap.parse_args()
    {"prepare": cmd_prepare, "snapshot": cmd_snapshot, "check": cmd_check, "prompt": cmd_prompt,
     "eval": cmd_eval}[a.cmd](a)


if __name__ == "__main__":
    main()
