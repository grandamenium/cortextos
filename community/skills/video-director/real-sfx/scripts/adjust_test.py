#!/usr/bin/env python3
"""A test of another kind: the person SETS the levels by ear, on a looping excerpt of a real film with the film's own
music and voice, instead of judging finished versions.

  python adjust_test.py build OUT --items ITEMS.json [--title T] [--seed N] [--no-page]
  python adjust_test.py plan  OUT --items ITEMS.json      # the stems and the plan only (no page)

Why. Rounds of "which of these is better" answer WHICH sound, not HOW LOUD, and every complaint of the person so far was
a level or a place ("громко", "пусто", "не в тему"). Here the stems of a film (its own audio, the sounds, the bed, the
variants of one accent) are separate and play on one clock; the person moves a slider until it sits right and marks the
accents they would keep. The answer is a number in dB against the film as the skill planned it, which can be written
into a default, and a verdict on the accents heard at the same level.

ITEMS.json: a list of
  {"id": "launch", "title": "...", "why": "...", "question": "...",
   "sheet": "cue sheet of the film as the skill plans it now",           # from_cues.py's output
   "video": "the picture (its own sound is not used)", "base_audio": [...],   # base_audio: as in a sheet, optional
   "t0": 9.0, "dur": 6.0,                                                 # the excerpt
   "voice_safe": true, "voice_depth": "normal",
   "accent": {"t": 11.9, "label": "thump",                                # the cue of the sheet the variants stand for
              "default_db": -4,                                           # level of the variants against the planned one
              "variants": [{"id": "cur", "label": "as planned"},
                           {"id": "soft", "label": "...", "derive": {"gain_db": -9, "highpass": 150}},
                           {"id": "fill", "label": "...", "cue": {"id": 177, "role": "hit", "anchor": "peak"}},
                           {"id": "none", "label": "nothing", "none": true}]},
   "sliders": {"sfx": [-18, 12], "bed": [-30, 18], "acc": [-24, 12]}}

What it makes, per film: the film is rendered the way the skill renders it (mix.py, the sheet, --voice-safe), the cue
clips it exports are summed into stems at the planned levels (the layer match applied, the voice-safe dip applied the
way the pipeline does: the same sidechain, per stem), the stems are checked against the real mix (the residual is
printed), the excerpt is cut, and the variants of the accent are equalised by momentary loudness (BS.1770, 400 ms).
The page (listen_page.py --adjust-plan) plays them with Web Audio on one clock and writes the answers.
"""
import argparse
import copy
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common


def _need_numpy():
    try:
        import numpy  # noqa: F401
    except ImportError:
        vp = common.venv_python()
        if vp is None:
            sys.exit("adjust_test.py needs numpy, which the skill's venv has: python scripts/listen.py install --yes "
                     "(about 45 MB), then run this again")
        sys.exit(subprocess.run([str(vp), str(Path(__file__)), *sys.argv[1:]]).returncode)


_need_numpy()
import numpy as np                      # noqa: E402
import mix                              # noqa: E402

SR = 48000
HERE = Path(__file__).parent
K1 = ([1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -1.69065929318241, 0.73248077421585])
K2 = ([1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621])


# ------------------------------------------------------------------------------------------------ small helpers
def ff(args):
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-nostdin", *[str(x) for x in args]], capture_output=True)
    if r.returncode:
        sys.exit("ffmpeg failed: " + r.stderr.decode("utf-8", "replace")[-400:])
    return r


def read_pcm(path):
    """A file as float32 stereo [n, 2] at 48 kHz (a stereo file keeps its level)."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "2", "-ar", str(SR),
                        "-f", "f32le", "-"], capture_output=True)
    if r.returncode:
        sys.exit(f"cannot read {path}: " + r.stderr.decode("utf-8", "replace")[-300:])
    return np.frombuffer(r.stdout, dtype="<f4").reshape(-1, 2).astype(np.float32)


def write_wav(path, arr):
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-nostdin", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "-",
                        "-c:a", "pcm_s24le", str(path)], input=np.ascontiguousarray(arr, dtype="<f4").tobytes(),
                       capture_output=True)
    if r.returncode:
        sys.exit("ffmpeg failed: " + r.stderr.decode("utf-8", "replace")[-300:])


def db(x):
    return 20.0 * np.log10(max(float(x), 1e-12))


def iir(x, b, a):
    try:
        from scipy.signal import lfilter
        return lfilter(b, a, x)
    except ImportError:
        pass
    b0, b1, b2, a1, a2 = b[0], b[1], b[2], a[1], a[2]
    x1 = x2 = y1 = y2 = 0.0
    out = []
    for xn in x.tolist():
        yn = b0 * xn + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        out.append(yn)
        x2, x1, y2, y1 = x1, xn, y1, yn
    return np.array(out)


def momentary_max(stereo):
    """The loudest 400 ms of a short sound, BS.1770 K-weighted, LUFS (a click is averaged over the 400 ms, as the
    standard does: that is how long the ear integrates). Only the sounding part of the array is measured."""
    act = np.where(np.abs(stereo).max(axis=1) > 1e-5)[0]
    if len(act):
        stereo = stereo[max(0, act[0] - int(0.05 * SR)):act[-1] + int(0.2 * SR)]
    n = max(len(stereo), int(0.4 * SR))
    st = np.zeros((n, 2), dtype=np.float64)
    st[:len(stereo)] = stereo
    p = np.zeros(n)
    for c in (0, 1):
        y = st[:, c]
        for b, a in (K1, K2):
            y = iir(y, b, a)
        p += y * y
    cs = np.concatenate([[0.0], np.cumsum(p)])
    w, hop, best = int(0.4 * SR), int(0.05 * SR), -200.0
    for s in range(0, max(1, n - w + 1), hop):
        best = max(best, -0.691 + 10.0 * np.log10((cs[s + w] - cs[s]) / w + 1e-12))
    return best


def excerpt(arr, t0, dur):
    n, s = int(round(dur * SR)), int(round(t0 * SR))
    seg = arr[s:s + n]
    if len(seg) < n:
        seg = np.pad(seg, ((0, n - len(seg)), (0, 0)))
    seg = seg.copy()
    f = int(0.012 * SR)                                      # the loop point: a short fade each side, no click
    ramp = np.linspace(0.0, 1.0, f, dtype=np.float32)[:, None]
    seg[:f] *= ramp
    seg[-f:] *= ramp[::-1]
    return seg


def place(rows, clips_dir, n, gain=1.0):
    """Sum exported clips into one stereo stem of n samples."""
    out = np.zeros((n, 2), dtype=np.float32)
    for r in rows:
        x = read_pcm(Path(clips_dir) / r["file"])
        s = int(round(float(r["start"]) * SR))
        if s >= n:
            continue
        e = min(n, s + len(x))
        out[s:e] += x[:e - s]
    return out * np.float32(gain)


# ------------------------------------------------------------------------------------------------ one film
def run_mix(sheet_path, out_mp4, extra, label):
    cmd = [sys.executable, str(HERE / "mix.py"), str(sheet_path), "--out", str(out_mp4), *extra]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode:
        sys.exit(f"mix.py failed for {label}:\n" + (r.stdout + r.stderr)[-900:])
    return r.stdout


def duck_stem(stem, key_wav, depth, work, tag):
    """The voice-safe dip of the pipeline, on one stem: the same sidechain, keyed by the same voice."""
    n = len(stem)
    raw_in, raw_out = work / f"{tag}_in.raw", work / f"{tag}_out.raw"
    raw_in.write_bytes(np.ascontiguousarray(stem, dtype="<f4").tobytes())
    graph = ("[1:a]aformat=sample_rates=48000:channel_layouts=stereo,highpass=f=250,lowpass=f=3800[vsc];"
             f"[0:a][vsc]sidechaincompress={mix.VOICE_DEPTH[depth]}[o]")
    ff(["-f", "f32le", "-ar", SR, "-ac", 2, "-i", raw_in, "-i", key_wav, "-filter_complex", graph, "-map", "[o]",
        "-f", "f32le", "-ar", SR, "-ac", 2, raw_out])
    out = np.frombuffer(raw_out.read_bytes(), dtype="<f4").reshape(-1, 2).astype(np.float32)
    raw_in.unlink(missing_ok=True)
    raw_out.unlink(missing_ok=True)
    if len(out) < n:
        out = np.pad(out, ((0, n - len(out)), (0, 0)))
    return out[:n]


def build_film(film, out_dir, work_root):
    fid = film["id"]
    work = work_root / fid
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    sheet = json.loads(Path(film["sheet"]).read_text(encoding="utf-8-sig"))
    sheet["video"] = str(film["video"])
    sheet["keep_audio"] = "auto"
    if film.get("base_audio"):
        sheet["base_audio"] = film["base_audio"]
    sheet.update(film.get("sheet_extra") or {})              # e.g. {"duck_music": true}, as the film's author has it
    sheet_path = work / "sheet.json"
    sheet_path.write_text(json.dumps(sheet, ensure_ascii=False, indent=1), encoding="utf-8")
    t0, dur = float(film["t0"]), float(film["dur"])
    depth = film.get("voice_depth", "normal")

    # 1. the film as the skill renders it: the real mix, the base, the clips of every cue
    extra = ["--export-clips", str(work / "clips")]
    if film.get("voice_safe", True):
        extra += ["--voice-safe", "--voice-depth", depth]
    print(f"[{fid}] rendering the film as the skill does ...", flush=True)
    log = run_mix(sheet_path, work / "film.mp4", extra, fid)
    report = (work / "film_cue_report.md").read_text(encoding="utf-8")
    m = re.search(r"final mix\s+(-?[\d.]+) LUFS \(true peak\s+(-?[\d.]+) dBTP, gain\s+([+-]?[\d.]+) dB\)", report)
    if not m:
        sys.exit(f"[{fid}] the cue report has no loudness line: {report[:300]}")
    final_lufs, master_db = float(m.group(1)), float(m.group(3))
    m2 = re.search(r"whole SFX bus\s+([+-]?[\d.]+) dB", log)
    match_db = float(m2.group(1)) if m2 else 0.0
    rows = json.loads((work / "clips" / "sfx_clips.json").read_text(encoding="utf-8"))
    base_wav = work / "film_base.wav"
    if not base_wav.exists():
        sys.exit(f"[{fid}] mix.py wrote no base: give base_audio (the film's own audio without the sounds)")
    base = read_pcm(base_wav)
    n = len(base)
    print(f"[{fid}] final mix {final_lufs:.1f} LUFS, master {master_db:+.1f} dB, layer match {match_db:+.1f} dB, "
          f"{len(rows)} cues", flush=True)

    # 2. the stems: bed, the accent cue(s), everything else; the layer match and the voice-safe dip as the pipeline
    acc = film.get("accent")
    acc_rows = []
    if acc:
        want_t = float(acc["t"])
        acc_rows = [r for r in rows if abs(float(r["t_moment"]) - want_t) < 0.08 and not r.get("bed")
                    and r["role"] in ("hit", "sub_drop", "design", "foley", "other")
                    and (not acc.get("label") or str(r["label"]).lower().startswith(str(acc["label"]).lower()))]
        if not acc_rows:
            sys.exit(f"[{fid}] no cue near {want_t} s with the label {acc.get('label')!r} in the sheet")
    acc_ids = {r["id"] for r in acc_rows}
    bed_rows = [r for r in rows if r.get("bed") or r["role"] == "ambience"]
    sfx_rows = [r for r in rows if r["id"] not in acc_ids and r not in bed_rows]
    g = 10 ** (match_db / 20.0)
    stems = {"sfx": place(sfx_rows, work / "clips", n, g), "bed": place(bed_rows, work / "clips", n, g)}
    acc_raw = place(acc_rows, work / "clips", n, g) if acc_rows else None      # the film's own accent, not yet dipped
    acc_cur = acc_raw

    voice_items = []
    for it in sheet.get("base_audio") or []:
        if isinstance(it, dict):
            stem_name = Path(str(it["file"])).stem.lower()
            if it.get("key_only") or any(w in stem_name for w in mix.VOICE_STEM_WORDS):
                voice_items.append({"file": str(it["file"]), "gain_db": float(it.get("gain_db", 0.0))})
    key_wav = None
    if film.get("voice_safe", True) and voice_items:
        key_wav = work / "voice_key.wav"
        mix.build_voice_key(voice_items, n / SR, 0.0, key_wav, work)
        for k in list(stems):
            stems[k] = duck_stem(stems[k], key_wav, depth, work, f"duck_{k}")
        if acc_cur is not None:
            acc_cur = duck_stem(acc_cur, key_wav, depth, work, "duck_acc")

    # 3. the check: base + stems at the master gain against the real film's own audio
    recon = (base + stems["sfx"] + stems["bed"] + (acc_cur if acc_cur is not None else 0)) * 10 ** (master_db / 20.0)
    real = read_pcm(work / "film.mp4")
    m_ = min(len(real), len(recon))
    res = recon[:m_] - real[:m_]
    resid_db = db(np.sqrt(np.mean(res ** 2))) - db(np.sqrt(np.mean(real[:m_] ** 2)))
    print(f"[{fid}] stems against the real mix: residual {resid_db:.1f} dB under the film "
          f"({'good' if resid_db < -20 else 'CHECK: the stems do not add up to the film'})", flush=True)

    # 4. the accent variants: rendered once (every one in the same sheet at its own time), equalised by loudness
    variants = []
    if acc:
        cur_clip = acc_raw if acc_raw is not None else np.zeros((n, 2), dtype=np.float32)
        vs = acc["variants"]
        need = [v for v in vs if v.get("cue")]
        vclips = {}
        if need:
            cues = []
            for k, v in enumerate(need):
                c = copy.deepcopy(v["cue"])
                c["t"] = 2.0 + 4.0 * k
                c.setdefault("label", v["id"])
                cues.append(c)
            vsheet = {"duration": 4.0 * len(need) + 4.0, "keep_audio": "no", "cues": cues}
            vp = work / "variants.json"
            vp.write_text(json.dumps(vsheet, ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"[{fid}] rendering {len(need)} accent variant(s) ...", flush=True)
            run_mix(vp, work / "variants.mp4", ["--export-clips", str(work / "vclips"), "--no-loudnorm"], f"{fid} variants")
            vrows = json.loads((work / "vclips" / "sfx_clips.json").read_text(encoding="utf-8"))
            for k, v in enumerate(need):
                t_v = 2.0 + 4.0 * k
                r = min(vrows, key=lambda r_: abs(float(r_["t_moment"]) - t_v))
                clip = read_pcm(work / "vclips" / r["file"])
                # the clip where the cue would put it if the cue stood at the accent's time (a sound that lands on its
                # peak starts before it)
                put = np.zeros((n, 2), dtype=np.float32)
                s0 = max(0, int(round((float(acc["t"]) + float(r["start"]) - t_v) * SR)))
                e0 = min(n, s0 + len(clip))
                put[s0:e0] = clip[:e0 - s0]
                vclips[v["id"]] = put * np.float32(g)
        for v in vs:
            if v.get("none"):
                variants.append((v, np.zeros((n, 2), dtype=np.float32)))
            elif v.get("derive"):
                d = v["derive"]
                tmp = work / f"derive_{v['id']}.wav"
                write_wav(tmp, cur_clip)
                outp = work / f"derive_{v['id']}_out.wav"
                af = []
                if d.get("highpass"):
                    af.append(f"highpass=f={int(d['highpass'])}")
                if d.get("lowpass"):
                    af.append(f"lowpass=f={int(d['lowpass'])}")
                if af:
                    ff(["-i", tmp, "-af", ",".join(af), "-c:a", "pcm_s24le", "-ar", SR, outp])
                    arr = read_pcm(outp)[:n]
                else:
                    arr = cur_clip
                variants.append((v, arr * np.float32(10 ** (float(d.get("gain_db", 0.0)) / 20.0))))
            elif v.get("cue"):
                variants.append((v, vclips[v["id"]]))
            else:                                            # "cur": the film's own accent
                variants.append((v, cur_clip))
        if key_wav is not None:                              # every variant is dipped under the voice like the rest
            variants = [(v, duck_stem(a_, key_wav, depth, work, f"duck_v_{v['id']}") if np.any(a_) else a_)
                        for v, a_ in variants]
        # equal momentary loudness among the variants, at the planned accent's level plus default_db
        m_cur = None
        for v, a_ in variants:
            if v["id"] == "cur" and np.any(a_):
                m_cur = momentary_max(a_)
        if m_cur is None:
            ms = [momentary_max(a_) for v, a_ in variants if np.any(a_)]
            m_cur = max(ms) if ms else -30.0
        target = m_cur + float(acc.get("default_db", -4.0))
        scaled = []
        for v, a_ in variants:
            if np.any(a_):
                mv = momentary_max(a_)
                a_ = a_ * np.float32(10 ** ((target - mv) / 20.0))
                v["_rel_db"] = round(target - mv, 1)
            scaled.append((v, a_))
        variants = scaled
        print(f"[{fid}] the planned accent: {m_cur:.1f} LUFS momentary; variants at {target:.1f} "
              f"({acc.get('default_db', -4.0):+.1f} dB)", flush=True)

    # 5. the excerpt: stems, picture; the plan
    item_dir = out_dir / fid
    item_dir.mkdir(parents=True, exist_ok=True)
    stem_list = []

    def put_stem(sid, arr):
        p = item_dir / f"{sid}.wav"
        write_wav(p, excerpt(arr, t0, dur))
        stem_list.append({"id": sid, "file": f"{fid}/{p.name}"})
    put_stem("base", base)
    put_stem("sfx", stems["sfx"])
    if np.any(stems["bed"]):
        put_stem("bed", stems["bed"])
    for v, a_ in variants:
        put_stem("v_" + v["id"], a_)
    pic = item_dir / "pic.mp4"
    ff(["-ss", f"{t0:.3f}", "-i", film["video"], "-t", f"{dur:.3f}", "-an", "-vf", "scale=-2:720", "-c:v", "libx264",
        "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-g", "30", "-fps_mode", "passthrough",
        "-movflags", "+faststart", pic])

    lim = film.get("sliders") or {}
    sliders = [{"id": "sfx", "label": "Все остальные звуки (щелчки, свиши, звоны, ввод текста)", "stems": ["sfx"],
                "min": lim.get("sfx", [-18, 12])[0], "max": lim.get("sfx", [-18, 12])[1], "default": 0, "step": 0.5,
                "hint": "0 — как скилл это ставит сейчас"}]
    if np.any(stems["bed"]):
        bl = lim.get("bed", [-30, 18])
        sliders.append({"id": "bed", "label": "Подложка (непрерывный фон)", "stems": ["bed"], "min": bl[0], "max": bl[1],
                        "default": 0, "step": 0.5, "off": True, "hint": "0 — как сейчас (-54 dBFS); левый край — без подложки"})
    var_block = None
    if acc:
        al = lim.get("acc", [-24, 12])
        sliders.append({"id": "acc", "label": acc.get("slider_label", "Акцент в этот момент"), "stems": [],
                        "min": al[0], "max": al[1], "default": 0, "step": 0.5, "off": True,
                        "hint": f"0 — одинаковая громкость вариантов, на {acc.get('default_db', -4.0):+.0f} дБ от запланированного"})
        var_block = {"slider": "acc", "ids": ["v_" + v["id"] for v, _ in variants],
                     "labels": [v.get("label", v["id"]) for v, _ in variants]}
    item = {"id": fid, "title": film["title"], "why": film.get("why", ""), "question": film.get("question", ""),
            "picture": f"{fid}/pic.mp4", "duration": dur, "master_db": round(master_db, 2), "stems": stem_list,
            "sliders": sliders, "variants": var_block,
            "meta": {"film": fid, "t0": t0, "final_lufs": final_lufs, "master_db": master_db, "match_db": match_db,
                     "bed_level_dbfs": (sheet.get("_bed") or {}).get("level_dbfs", -54.0),
                     "residual_db": round(float(resid_db), 1), "accent_t": acc and acc["t"],
                     "accent_default_db": acc and acc.get("default_db", -4.0),
                     "variant_rel_db": {v["id"]: v.get("_rel_db") for v, _ in variants}}}
    return item


# ------------------------------------------------------------------------------------------------ main
def cmd_build(a):
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    films = json.loads(Path(a.items).read_text(encoding="utf-8-sig"))
    films = films if isinstance(films, list) else films.get("items", [])
    work_root = out / "_work"
    items = []
    t_start = time.time()
    for film in films:
        items.append(build_film(film, out, work_root))
    plan = {"items": items}
    (out / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"plan: {out / 'plan.json'}  ({len(items)} item(s), {time.time() - t_start:.0f} s)")
    if a.no_page:
        return
    cmd = [sys.executable, str(HERE / "listen_page.py"), "build", str(out / "page"), "--adjust-plan",
           str(out / "plan.json"), "--title", a.title, "--note", a.note, "--seed", str(a.seed)]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    print((r.stdout + r.stderr).strip())
    if r.returncode:
        sys.exit(r.returncode)


def cmd_ladder(a):
    """The same excerpts as a plain blind comparison: the SFX layer at several levels against the film as planned, the
    film's own music and voice kept (the format the person already knows: which one is right, and what is wrong with the
    others). The film's own accent goes with the layer; the bed stays where it was."""
    out = Path(a.out)
    plan = json.loads((out / "plan.json").read_text(encoding="utf-8"))
    steps = [float(x) for x in a.steps]
    labels = [("как сейчас" if abs(s) < 1e-9 else f"{s:+g} дБ") for s in steps]
    ab = []
    for it in plan["items"]:
        d = out / it["id"]
        stem = {s["id"]: read_pcm(out / s["file"]) for s in it["stems"]}
        n = len(stem["base"])
        zero = np.zeros((n, 2), dtype=np.float32)
        acc = zero
        rel = ((it.get("meta") or {}).get("variant_rel_db") or {}).get("cur")
        if "v_cur" in stem:                                   # the accent as planned (the variant was equalised)
            acc = stem["v_cur"] * np.float32(10 ** (-(rel or 0.0) / 20.0))
        bed, master = stem.get("bed", zero), np.float32(10 ** (float(it.get("master_db", 0.0)) / 20.0))
        files = []
        for k, st in enumerate(steps):
            g = np.float32(10 ** (st / 20.0))
            mixed = (stem["base"] + (stem["sfx"] + acc) * g + bed) * master
            wav = d / f"ladder_{k}.wav"
            write_wav(wav, mixed)
            mp4 = d / f"ladder_{k}.mp4"                       # one picture (copied: the same stream in every file)
            ff(["-i", d / "pic.mp4", "-i", wav, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-af",
                "alimiter=limit=0.89:level=0:latency=1", "-c:a", "aac", "-b:a", "256k", "-shortest", mp4])
            wav.unlink(missing_ok=True)
            files.append(str(mp4))
        ab += ["--ab", f"{it['title']} ## {a.question}", *files]
    cmd = [sys.executable, str(HERE / "listen_page.py"), "build", str(out / "ladder_page"), "--title", a.title,
           "--note", a.note, "--seed", str(a.seed), "--ab-tags", "quiet,masked,loud,voice,empty,distracting,good",
           "--labels", *labels, *ab]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    print((r.stdout + r.stderr).strip())
    if r.returncode:
        sys.exit(r.returncode)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    lad = sub.add_parser("ladder", help="a blind comparison of the SFX layer at several levels, on the excerpts of OUT")
    lad.add_argument("out", help="a folder made by `build` or `plan`")
    lad.add_argument("--steps", nargs="+", default=["0", "4", "8", "12"], help="dB against the plan (default 0 4 8 12)")
    lad.add_argument("--title", default="Громкость звуков: какая в самый раз")
    lad.add_argument("--note", default="Наушники. Музыка и голос родные; версии отличаются только громкостью слоя звуков.")
    lad.add_argument("--question", default="Версии отличаются только громкостью звуков (щелчки, свиши, звоны, акценты); "
                                           "музыка и голос те же. Какая звучит в самый раз? У остальных отметьте, что не так.")
    lad.add_argument("--seed", type=int, default=11)
    for name in ("build", "plan"):
        b = sub.add_parser(name)
        b.add_argument("out")
        b.add_argument("--items", required=True)
        b.add_argument("--title", default="Подстройка на слух")
        b.add_argument("--note", default="Наушники. Двигайте ползунки, пока не зазвучит так, как должно быть в этом фильме.")
        b.add_argument("--seed", type=int, default=7)
        b.add_argument("--no-page", action="store_true")
    a = ap.parse_args()
    if a.cmd == "ladder":
        return cmd_ladder(a)
    if a.cmd == "plan":
        a.no_page = True
    cmd_build(a)


if __name__ == "__main__":
    main()
