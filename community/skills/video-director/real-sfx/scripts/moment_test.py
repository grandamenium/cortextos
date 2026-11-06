#!/usr/bin/env python3
"""A test of the CHOICE of a sound for a moment of a real film: not how loud, which sound.

  python moment_test.py build OUT --films FILMS.json --moments MOMENTS.json [--n 5] [--seed N] [--no-page]

For each moment (a place of a film where a sound belongs: the 3D layers split, the "Cha-ching", a wipe, the typing of a
command) the page plays the same few seconds of the film with its own music and voice and ONE sound on the moment,
the candidates blind as 1, 2, 3 ...: the film's current sound, the library's best by the person's taste and some far
from them, a few named by hand, and nothing. The person says which one belongs and what is wrong with the rest.

The candidates sit at ONE level (the loudest 150 ms, K-weighted, a fixed number of LU under the film's own 400 ms at
that moment, a different number for a click, a whoosh, a hit ...), so that what is heard is the character of the sound
and not how loud it happens to be. The level of the class is where the person put the layer in the earlier rounds
(adjust_test.py): a typical sound about 12 LU under the film, a hit not more than 6.

FILMS.json   {"launch": {"video": "...", "base": "film_base.wav (the film's own audio)", "resolved": "..._resolved_cues.json"}}
MOMENTS.json [{"id": "boom", "film": "launch", "t": 11.9, "t0": 9.9, "dur": 4.5, "title": "...", "about": "...",
               "class": "hit",
               "current": {"window": 0.12, "roles": ["hit"]},             # the cues of the film near t, together
               "picks": [{"role": "whoosh", "n": 4}],                      # the library by taste_test.choose
               "fixed": [{"id": "fill", "label": "SoftDrumFill 1", "cue": {"id": 177, "role": "hit"}}],
               "derive": [{"id": "soft", "label": "...", "gain_db": -9, "highpass": 150}],
               "none": true}]
"""
import argparse
import copy
import json
import random
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
            sys.exit("moment_test.py needs numpy, which the skill's venv has: python scripts/listen.py install --yes")
        sys.exit(subprocess.run([str(vp), str(Path(__file__)), *sys.argv[1:]]).returncode)


_need_numpy()
import numpy as np                      # noqa: E402
import adjust_test as AT                # noqa: E402  (read_pcm, write_wav, ff, K filters)
import picker                           # noqa: E402
import taste_test as TT                 # noqa: E402

SR = AT.SR
HERE = Path(__file__).parent
# loudest 150 ms of the candidate, K-weighted, against the film's own 400 ms at the moment (LU)
CLASS_DELTA = {"hit": -6.0, "accent": -6.0, "whoosh": -11.0, "chime": -10.0, "coin": -10.0, "click": -13.0, "ui": -13.0,
               "pop": -12.0, "typing": -15.0, "data": -12.0, "riser": -10.0, "default": -12.0}
SPACE = 7.0                              # seconds between the candidates in the sheet that renders them


# ------------------------------------------------------------------------------------------------ loudness
def _ir(n=16384):
    x = np.zeros(n)
    x[0] = 1.0
    for b, a in (AT.K1, AT.K2):
        x = AT.iir(x, b, a)
    return x


_IR = None


def kpower(stereo):
    """K-weighted power per sample (both channels summed), by FFT convolution with the filter's impulse response."""
    global _IR
    if _IR is None:
        _IR = _ir()
    n = len(stereo)
    m = 1
    while m < n + len(_IR):
        m *= 2
    H = np.fft.rfft(_IR, m)
    p = np.zeros(n)
    for c in (0, 1):
        y = np.fft.irfft(np.fft.rfft(stereo[:, c].astype(np.float64), m) * H, m)[:n]
        p += y * y
    return p


def lufs_of(power, s, e):
    s, e = max(0, int(s)), min(len(power), int(e))
    return -0.691 + 10.0 * np.log10(power[s:e].mean() + 1e-12) if e > s else -120.0


def loud150(stereo):
    """The loudest 150 ms (K-weighted), LUFS-like; a sound shorter than that is averaged over the 150 ms."""
    act = np.where(np.abs(stereo).max(axis=1) > 1e-5)[0]
    if not len(act):
        return -120.0
    x = stereo[max(0, act[0] - 480):act[-1] + 4800]
    p = kpower(x)
    w = int(0.15 * SR)
    if len(p) < w:
        p = np.concatenate([p, np.zeros(w - len(p))])
    cs = np.concatenate([[0.0], np.cumsum(p)])
    best = (cs[w:] - cs[:-w]).max() / w
    return -0.691 + 10.0 * np.log10(best + 1e-12)


# ------------------------------------------------------------------------------------------------ candidates
def current_cues(resolved, t, spec):
    """The film's own cues at the moment (all of them, together: the "Cha-ching" is a chime and coins and a thump)."""
    d = json.loads(Path(resolved).read_text(encoding="utf-8-sig"))
    rows = d.get("cues", d) if isinstance(d, dict) else d
    win = float(spec.get("window", 0.12))
    roles = set(spec.get("roles") or [])
    out = []
    for c in rows:
        if c.get("bed") or abs(float(c["t"]) - t) > win:
            continue
        if roles and c.get("role") not in roles:
            continue
        cue = {"file": c["file"], "role": c["role"], "dt": round(float(c["t"]) - t, 3)}
        if c.get("anchor"):
            cue["anchor"] = c["anchor"]
        if c.get("gain_db") is not None:
            cue["gain_db"] = float(c["gain_db"])
        if c.get("pitch"):
            cue["pitch"] = c["pitch"]
        out.append(cue)
    return out


def candidates_for(m, film, index, scales, rng, n_default):
    """[(id, label, [cue, ...] or None for silence, meta)] in a fixed order (the page shuffles them)."""
    cands = []
    cur = []
    if m.get("current") is not None:
        cur = current_cues(film["resolved"], float(m["t"]), m["current"])
        if cur:
            cands.append(("cur", "как сейчас в фильме: " + " + ".join(
                Path(str(c["file"])).stem.split("_", 1)[-1][:34] for c in cur), cur, {"kind": "current"}))
    for p in m.get("picks", []):
        role = p["role"]
        if role not in TT.ROLE_SPEC:                 # a role the taste test has no spec for: a plain pool of it
            TT.ROLE_SPEC[role] = {"pool": p.get("pool") or {"role": role, "max_dur": 3.0}, "cue": {}, "wrong": None}
        want = int(p.get("n", n_default))
        picks, pool_n = TT.choose(index, role, want, rng, scales, {str(c["file"]) for c in cur})
        picks = picks[:want]                         # choose() always starts with the picker's first three
        spec_cue = dict(TT.ROLE_SPEC[role]["cue"])
        spec_cue.update(p.get("cue", {}))
        for rec, rank in picks:
            cue = {"file": rec["path"], "role": p.get("as_role", role), "dt": 0.0, **spec_cue}
            cands.append((f"p{len(cands)}", rec["name"], [cue],
                          {"kind": "library", "sound_id": rec["id"], "path": rec["path"], "role": role,
                           "picker_rank": rank, "pool": pool_n}))
    for f in m.get("fixed", []):
        cue = dict(f["cue"])
        cue.setdefault("dt", 0.0)
        cands.append((f["id"], f.get("label", f["id"]), [cue], {"kind": "fixed"}))
    for dv in m.get("derive", []):
        base = [dict(c) for c in cur]
        if not base:
            continue
        for c in base:
            c["gain_db"] = float(c.get("gain_db", 0.0)) + float(dv.get("gain_db", 0.0))
            if dv.get("highpass"):
                c["highpass"] = dv["highpass"]
            if dv.get("lowpass"):
                c["lowpass"] = dv["lowpass"]
        cands.append((dv["id"], dv.get("label", dv["id"]), base, {"kind": "derived"}))
    if m.get("none", True):
        cands.append(("none", "без звука", None, {"kind": "none"}))
    return cands


def render_candidates(cands, work, label):
    """One mix.py run for every candidate (each at its own time of a silent sheet), the clips of each by time."""
    cues, spans = [], {}
    k = 0
    for cid, _lab, cs, _meta in cands:
        if not cs:
            continue
        T = 2.0 + SPACE * k
        for j, c in enumerate(cs):
            cue = {kk: vv for kk, vv in c.items() if kk != "dt"}
            cue["t"] = round(T + float(c.get("dt", 0.0)), 3)
            cue["label"] = f"{cid}:{j}"
            cues.append(cue)
        spans[cid] = T
        k += 1
    sheet = {"duration": 2.0 + SPACE * k + 3.0, "keep_audio": "no", "cues": cues}
    sp = work / f"{label}_sheet.json"
    sp.write_text(json.dumps(sheet, ensure_ascii=False, indent=1), encoding="utf-8")
    clips = work / f"{label}_clips"
    log = AT.run_mix(sp, work / f"{label}.mp4", ["--export-clips", str(clips), "--no-loudnorm", "--no-match-layer"], label)
    rows = json.loads((clips / "sfx_clips.json").read_text(encoding="utf-8"))
    by = {}
    for r in rows:
        cid = str(r["label"]).split(":")[0]
        by.setdefault(cid, []).append(r)
    return by, spans, clips, log


# ------------------------------------------------------------------------------------------------ one moment
def build_moment(m, films, out, work, index, scales, rng, n_default, with_base=False):
    film = films[m["film"]]
    t, t0, dur = float(m["t"]), float(m["t0"]), float(m["dur"])
    n = int(round(dur * SR))
    cands = candidates_for(m, film, index, scales, rng, n_default)
    if len(cands) < 3:
        sys.exit(f"[{m['id']}] only {len(cands)} candidate(s)")
    print(f"[{m['id']}] {len(cands)} candidates: " + "; ".join(f"{c[0]}={c[1][:30]}" for c in cands), flush=True)
    by, spans, clips, _log = render_candidates(cands, work, m["id"])

    # the candidates as the skill renders them, each placed on the moment
    arrays = {}
    for cid, lab, cs, meta in cands:
        arr = np.zeros((n, 2), dtype=np.float32)
        if cs:
            for r in by.get(cid, []):
                clip = AT.read_pcm(clips / r["file"])
                s = int(round((t - t0 + float(r["start"]) - spans[cid]) * SR))
                if s < 0:
                    clip = clip[-s:]
                    s = 0
                e = min(n, s + len(clip))
                if e > s:
                    arr[s:e] += clip[:e - s]
        arrays[cid] = arr
    if with_base:                # the film's own music and voice under it: a fixed number of LU under the film
        base_full = AT.read_pcm(film["base"])
        s0 = int(round(t0 * SR))
        base = base_full[s0:s0 + n]
        if len(base) < n:
            base = np.pad(base, ((0, n - len(base)), (0, 0)))
        m_base = lufs_of(kpower(base), (t - t0 - 0.75) * SR, (t - t0 + 0.75) * SR)
        target = m_base + CLASS_DELTA.get(m.get("class", "default"), CLASS_DELTA["default"])
        what = f"film at the moment {m_base:.1f} LUFS (400 ms), candidates at {target:.1f}"
    else:                        # clean SFX: the candidates as rendered, brought to the median of their loudness
        base = np.zeros((n, 2), dtype=np.float32)
        lv_all = sorted(v for v in (loud150(a_) for a_ in arrays.values()) if v > -100)
        target = max(-24.0, lv_all[len(lv_all) // 2])        # a card of quiet things (keys) is not left to the volume knob
        m_base = None
        what = f"clean sfx, candidates at {target:.1f} LUFS (the median of the card, not under -24)"
    for cid, lab, cs, meta in cands:
        lv = loud150(arrays[cid])
        if lv > -100:
            g = 10 ** ((target - lv) / 20.0)
            pk = float(np.abs(arrays[cid]).max())
            if pk * g > 0.89:                          # never over -1 dBFS: a hit that is peaky is held at its peak
                g = 0.89 / pk
            arrays[cid] = arrays[cid] * np.float32(g)
            meta["scaled_db"] = round(20 * np.log10(g), 1)
    print(f"[{m['id']}] {what}", flush=True)

    d = out / m["id"]
    d.mkdir(parents=True, exist_ok=True)
    pic = d / "pic.mp4"
    AT.ff(["-ss", f"{t0:.3f}", "-i", film["video"], "-t", f"{dur:.3f}", "-an", "-vf", "scale=-2:720", "-c:v", "libx264",
           "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-g", "30", "-fps_mode", "passthrough",
           "-movflags", "+faststart", pic])
    files, names = [], []
    for cid, lab, cs, meta in cands:
        wav = d / f"{cid}.wav"
        AT.write_wav(wav, AT.excerpt(base + arrays[cid], 0.0, dur))
        mp4 = d / f"{cid}.mp4"
        AT.ff(["-i", pic, "-i", wav, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-af",
               "alimiter=limit=0.89:level=0:latency=1", "-c:a", "aac", "-b:a", "256k", "-shortest", mp4])
        wav.unlink(missing_ok=True)
        files.append(str(mp4))
        names.append(lab.replace("|", "/").replace(" ## ", " "))
    return {"id": m["id"], "title": m["title"], "about": m.get("about", ""),
            "question": m.get("question") or (
                ("Какой звук подходит на этот момент? Музыка и голос родные, звук один и тот же по громкости. "
                 if with_base else
                 "Какой звук подходит на этот момент? Только звук, без музыки и голоса, громкость выровнена. ")
                + "Выберите лучший, у остальных отметьте, что не так."),
            "files": files, "names": names,
            "meta": {c[0]: dict(c[3], label=c[1]) for c in cands},
            "level": {"film_lufs": None if m_base is None else round(m_base, 1), "target_lufs": round(target, 1),
                      "with_base": with_base}}


def cmd_build(a):
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    films = json.loads(Path(a.films).read_text(encoding="utf-8-sig"))
    moments = json.loads(Path(a.moments).read_text(encoding="utf-8-sig"))
    work = out / "_work"
    work.mkdir(exist_ok=True)
    index = picker.load_index()
    scales = picker._scales(index)
    rng = random.Random(a.seed)
    items = []
    for m in moments:
        items.append(build_moment(m, films, out, work, index, scales, rng, a.n, with_base=a.with_base))
    (out / "moments_plan.json").write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"plan: {out / 'moments_plan.json'}")
    if a.no_page:
        return
    ab = []
    for it in items:
        ab += ["--ab", f"{it['title']} ## {it['question']} ## " + " | ".join(it["names"]), *it["files"]]
    cmd = [sys.executable, str(HERE / "listen_page.py"), "build", str(out / "page"), "--title", a.title, "--note", a.note,
           "--seed", str(a.seed), "--ab-tags", "offtheme,harsh,loud,quiet,heavy,synthetic,good", *ab]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    print((r.stdout + r.stderr).strip())
    if r.returncode:
        sys.exit(r.returncode)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("out")
    b.add_argument("--films", required=True)
    b.add_argument("--moments", required=True)
    b.add_argument("--n", type=int, default=4, help="library sounds per moment from the picker (default 4)")
    b.add_argument("--seed", type=int, default=7)
    b.add_argument("--with-base", action="store_true",
                   help="the film's own music and voice under the candidates (default: clean SFX, picture and the sound)")
    b.add_argument("--title", default="Какой звук на какой момент")
    b.add_argument("--note", default="Наушники. Один и тот же момент фильма, меняется только звук; громкость выровнена.")
    b.add_argument("--no-page", action="store_true")
    a = ap.parse_args()
    cmd_build(a)


if __name__ == "__main__":
    main()
