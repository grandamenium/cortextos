#!/usr/bin/env python3
"""End-to-end self test of the skill on synthetic material. Touches nothing of the user's: it builds its own
tiny library, config and index in a temp folder (REAL_SFX_CONFIG / REAL_SFX_INDEX) and cleans up.

  python tests/selftest.py            # ~40 s
  python tests/selftest.py --keep     # keep the temp folder and print its path

The sounds here are generated ONLY as test fixtures; the skill itself never synthesizes sound.
"""
import argparse
import hashlib
import json
import math
import os
import random
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
PY = sys.executable
S = SKILL / "scripts"
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS  " if ok else "FAIL  ") + name + (f"   [{detail}]" if detail else ""), flush=True)


def sh(args, env=None, ok_codes=(0,)):
    r = subprocess.run([str(a) for a in args], capture_output=True, text=True, encoding="utf-8", errors="replace",
                       env=env)
    return r, (r.returncode in ok_codes)


def ff(args):
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-nostdin"] + [str(a) for a in args], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr[-400:])


def probe(path, entry):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", entry, "-of", "csv=p=0", str(path)],
                       capture_output=True, text=True)
    return r.stdout.strip()


def fixture_library(root):
    lib = root / "lib"
    spec = {
        "Whoosh 1": ("anoisesrc=d=0.7:c=pink:r=48000,highpass=f=400,afade=t=in:d=0.3,afade=t=out:st=0.3:d=0.4", "wh"),
        "Whoosh 2": ("anoisesrc=d=0.5:c=white:r=48000,lowpass=f=3000,afade=t=in:d=0.2,afade=t=out:st=0.2:d=0.3", "wh"),
        "Whoosh 3": ("anoisesrc=d=1.1:c=brown:r=48000,highpass=f=200,afade=t=in:d=0.6,afade=t=out:st=0.6:d=0.5", "wh"),
        "Hit 1": ("sine=f=70:d=0.5:r=48000,afade=t=out:d=0.45", "hi"),
        "Hit 2": ("sine=f=110:d=0.4:r=48000,afade=t=out:d=0.35", "hi"),
        "Hit 3": ("sine=f=55:d=0.7:r=48000,afade=t=out:d=0.65", "hi"),
        "Click 1": ("anoisesrc=d=0.06:c=white:r=48000,afade=t=out:d=0.05", "cl"),
        "Click 2": ("anoisesrc=d=0.04:c=pink:r=48000,afade=t=out:d=0.035", "cl"),
        "Riser 1": ("aevalsrc='sin(2*PI*(200+600*t)*t)*t/1.4':d=1.4:s=48000", "ri"),
        "Sub Drop 1": ("sine=f=42:d=1.2:r=48000,afade=t=out:d=1.1", "sd"),
        "Sub Drop 2": ("sine=f=50:d=1.0:r=48000,afade=t=out:d=0.9", "sd"),
        "Glitch 1": ("anoisesrc=d=0.25:c=white:r=48000,tremolo=f=40:d=1,afade=t=out:d=0.2", "gl"),
        "Pad Tick 1": ("anoisesrc=d=0.05:c=white:r=48000,afade=t=out:d=0.045,apad=whole_dur=1.5", "cl"),
    }
    folders = {"wh": "Whooshes", "hi": "Hits and impacts", "cl": "Clicks", "ri": "Risers", "sd": "Sub Drops", "gl": "Glitches"}
    for name, (src, k) in spec.items():
        d = lib / folders[k]
        d.mkdir(parents=True, exist_ok=True)
        ff(["-f", "lavfi", "-i", src, "-ac", "2", str(d / f"{name}.wav")])
    typing_take(lib / "Keyboard" / "Keyboard Typing 1.wav")
    ff(["-i", str(lib / "Keyboard" / "Keyboard Typing 1.wav"), "-c:a", "libmp3lame", "-b:a", "128k",
        str(lib / "Keyboard" / "Keyboard Typing 2.mp3")])
    ff(["-f", "lavfi", "-i", "anoisesrc=d=0.2:c=white:r=48000,highpass=f=1500,afade=t=out:d=0.19", "-ac", "2",
        str(lib / "Foley" / "Пластик 1.wav")]) if (lib / "Foley").mkdir(
        parents=True, exist_ok=True) is None else None
    return lib


def typing_take(path, keys=9, gap=0.17):
    """Nine keystrokes: short noise bursts with a click, uneven spacing and level, like a hand typing."""
    path.parent.mkdir(parents=True, exist_ok=True)
    random.seed(11)
    rate = 48000
    n = int(rate * (keys * gap + 0.3))
    buf = [0.0] * n
    t = 0.08
    for k in range(keys):
        amp = 0.55 + 0.4 * random.random()
        i0 = int(t * rate)
        for j in range(int(0.045 * rate)):
            if i0 + j < n:
                buf[i0 + j] += amp * (random.random() * 2 - 1) * math.exp(-j / (0.006 * rate))
        t += gap * (0.8 + 0.4 * random.random())
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, v)) * 28000)) for v in buf))


def click_stem(path, times, dur=8.0):
    """A stem of the synthesized effect layer: loud 30 ms noise bursts at the given times."""
    random.seed(21)
    rate = 48000
    buf = [0.0] * int(rate * dur)
    for t in times:
        i0 = int(t * rate)
        for j in range(int(0.03 * rate)):
            if i0 + j < len(buf):
                buf[i0 + j] += 0.8 * (random.random() * 2 - 1) * math.exp(-j / (0.006 * rate))
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, v)) * 30000)) for v in buf))


def synthetic_video(path, with_music=True):
    ff(["-f", "lavfi", "-i", "color=c=0x1a1a2e:s=640x360:r=30:d=2", "-f", "lavfi", "-i", "color=c=0xe94560:s=640x360:r=30:d=3",
        "-f", "lavfi", "-i", "color=c=0x0f3460:s=640x360:r=30:d=3", "-f", "lavfi", "-i", "color=c=white:s=150x60:r=30:d=8",
        "-f", "lavfi", "-i", "sine=f=196:d=8",
        "-filter_complex",
        "[0][1][2]concat=n=3:v=1[bg];[bg][3]overlay=x='if(lt(t,1.6),-150+t*300,if(lt(t,3.5),-2000,"
        "if(lt(t,6),250,if(lt(t,6.5),250+(t-6)*1000,-2000))))':y=150:eval=frame[v];[4]volume=0.15[a]",
        "-map", "[v]"] + (["-map", "[a]"] if with_music else []) +
       ["-t", "8", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast"] +
       (["-c:a", "aac"] if with_music else []) + [str(path)])


def click_track(path, bpm=120.0, dur=16.0, offset=0.13):
    random.seed(3)
    rate = 22050
    n = int(rate * dur)
    buf = [0.0] * n
    beat, t, k = 60.0 / bpm, offset, 0
    while t < dur - 0.3:
        i0 = int(t * rate)
        for j in range(int(0.18 * rate)):
            if i0 + j < n:
                buf[i0 + j] += 0.9 * math.sin(2 * math.pi * 55 * j / rate) * math.exp(-j / (0.05 * rate))
        h0 = int((t + beat / 2) * rate)
        for j in range(int(0.04 * rate)):
            if h0 + j < n:
                buf[h0 + j] += 0.25 * (random.random() * 2 - 1) * math.exp(-j / (0.01 * rate))
        t += beat
        k += 1
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, v)) * 30000)) for v in buf))


def moment_takes(body, swell):
    """Two sounds whose loudest 20 ms is not where they arrive (round 9, the moment of a sound). `body`: a hit that is at
    full strength 30 ms in and has one louder 20 ms at 0.78 s; `swell`: a tone that climbs for 1.6 s and is cut."""
    rate = 48000

    def env_body(t):
        if t < 0.03:
            return 0.5 * t / 0.03
        if 0.78 <= t < 0.80:
            return 0.8
        if t < 0.86:
            return 0.5
        return max(0.0, 0.5 * (1 - (t - 0.86) / 0.44))

    for path, dur, env_, freqs in ((body, 1.3, env_body, (180.0, 421.0)),
                                   (swell, 1.6, lambda t: 0.8 * t / 1.6, (300.0,))):
        frames = []
        for i in range(int(dur * rate)):
            t = i / rate
            v = sum(math.sin(2 * math.pi * f * t) for f in freqs) / len(freqs) * env_(t)
            frames.append(struct.pack("<h", int(max(-1, min(1, v)) * 30000)))
        with wave.open(str(path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(b"".join(frames))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true")
    a = ap.parse_args()
    t0 = time.time()
    for tool in ("ffmpeg", "ffprobe"):
        if shutil.which(tool) is None:
            sys.exit(f"{tool} not found in PATH")
    root = Path(tempfile.mkdtemp(prefix="realsfx_selftest_"))
    try:
        lib = fixture_library(root)
        cfg = {"libraries": [{"name": "fixture", "path": str(lib)}],
               "uisfx": {"path": "vendor/node_modules/uisfx", "default_pack": "studio"},
               "skip_dir_names": [], "index_path": str(root / "index.json")}
        (root / "config.json").write_text(json.dumps(cfg), encoding="utf-8")
        # the personal files of the skill folder (taste, ratings, the steadiness cache) are NOT the test's: a person's
        # love / ban / ui_source must not change what the fixture checks
        env = dict(os.environ, REAL_SFX_CONFIG=str(root / "config.json"), REAL_SFX_INDEX=str(root / "index.json"),
                   REAL_SFX_TASTE=str(root / "no_taste.json"), REAL_SFX_RATINGS=str(root / "no_ratings.json"),
                   REAL_SFX_STEADY=str(root / "no_steady.json"), PYTHONUTF8="1")

        # 1-3 index and search
        r, ok = sh([PY, S / "build_index.py"], env)
        idx = json.loads((root / "index.json").read_text(encoding="utf-8")) if (root / "index.json").exists() else {"sounds": []}
        roles = {}
        for s in idx["sounds"]:
            roles[s["role"]] = roles.get(s["role"], 0) + 1
        check("index built with 16 sounds", ok and len(idx["sounds"]) == 16, f"{len(idx['sounds'])} sounds")
        pl = next((s for s in idx["sounds"] if s["name"].startswith("Пластик")), {})
        check("a Russian file name gets English search words", "plastic" in pl.get("aliases", []), str(pl.get("aliases")))
        r, ok = sh([PY, S / "search.py", "--query", "plastic", "--limit", "3"], env)
        check("an English query finds the Russian-named sound", ok and "Пластик" in r.stdout)
        pad = next((s for s in idx["sounds"] if s["name"] == "Pad Tick 1"), {})
        check("a file padded with silence is measured by its audible length",
              pad.get("duration", 0) >= 1.4 and 0 < pad.get("active_dur", 9) <= 0.2,
              f"file {pad.get('duration')} s, content {pad.get('active_dur')} s")
        r, ok = sh([PY, S / "search.py", "--role", "click", "--max-dur", "0.3", "--limit", "5"], env)
        check("a short-length search finds the padded click", ok and "Pad Tick" in r.stdout)
        check("roles recognised (whoosh, hit, click, riser, sub_drop, glitch)",
              all(roles.get(k, 0) >= 1 for k in ("whoosh", "hit", "click", "riser", "sub_drop", "glitch")), str(roles))
        check("features measured", all("centroid" in s and "bumps" in s and s.get("words") for s in idx["sounds"]))
        r, ok = sh([PY, S / "search.py", "--role", "whoosh", "--target-dur", "0.5", "--limit", "3"], env)
        check("search by role and length", ok and "Whoosh" in r.stdout, r.stdout.splitlines()[0][:60] if r.stdout else r.stderr[-80:])
        r, ok = sh([PY, S / "search.py", "--role", "hit", "--says", "punchy", "--limit", "3"], env)
        check("search by plain words runs", ok)
        r, ok = sh([PY, S / "contact_sheet.py", "--role", "whoosh", "--limit", "3", "--out", root / "sheet.png"], env)
        check("candidate contact sheet drawn", ok and (root / "sheet.png").exists() and (root / "sheet.png").stat().st_size > 3000)

        # 4-6 moments, beats, draft
        vid = root / "film.mp4"
        synthetic_video(vid)
        r, ok = sh([PY, S / "find_moments.py", vid, "--out", root / "work"], env)
        mom = json.loads((root / "work" / "moments.json").read_text(encoding="utf-8"))["moments"] if ok else []
        cuts = sorted(m["t"] for m in mom if m["kind"] == "cut")
        check("cuts found at 2.0 s and 5.0 s (+-40 ms)", len(cuts) >= 2 and abs(cuts[0] - 2.0) < 0.04 and abs(cuts[1] - 5.0) < 0.04, str(cuts))
        ons = [m["t"] for m in mom if m["kind"] == "onset"]
        check("picture onsets found near 3.5 s and 6.0 s", any(abs(t - 3.5) < 0.08 for t in ons) and any(abs(t - 6.0) < 0.08 for t in ons), str([round(t, 2) for t in ons]))
        clk = root / "click.wav"
        click_track(clk)
        r, ok = sh([PY, S / "beats.py", clk, "--out", root / "beats.json"], env)
        b = json.loads((root / "beats.json").read_text(encoding="utf-8")) if ok else {"beats": [], "tempo": 0}
        ph = min(abs(((x - 0.13) / 0.5) % 1) for x in b["beats"][:6]) * 0.5 if b["beats"] else 9
        phase_err = abs(((b["beats"][2] - 0.13 + 0.25) % 0.5) - 0.25) if b["beats"] else 9
        check("tempo 120 BPM and beat phase within 25 ms", ok and abs(b["tempo"] - 120) < 1.5 and phase_err < 0.025,
              f"{b['tempo']} BPM, phase error {phase_err * 1000:.0f} ms")
        r, ok = sh([PY, S / "suggest_cues.py", root / "work" / "moments.json", "--out", root / "cues.json", "--density", "6", "--ui", "library"], env)
        draft = json.loads((root / "cues.json").read_text(encoding="utf-8")) if ok else {"cues": []}
        check("draft cue sheet has cues and a hook", ok and len(draft["cues"]) >= 3 and "hook (first 2 s): yes" in r.stdout, f"{len(draft['cues'])} cues")

        # 7-10 mix, verify, critique, review
        out = root / "res" / "film_sfx.mp4"
        r, ok = sh([PY, S / "mix.py", root / "cues.json", "--out", out, "--duck", "--stems", "--export-clips", root / "res" / "clips"], env)
        check("mix runs", ok, r.stderr[-200:] if not ok else "")
        dur = float(probe(out, "format=duration") or 0)
        kinds = probe(out, "stream=codec_type").split()
        check("mp4 keeps video and has audio, same length", dur and abs(dur - 8.0) < 0.1 and "video" in kinds and "audio" in kinds, f"{dur:.2f}s {kinds}")
        wav = root / "res" / "film_sfx_sfx_track.wav"
        check("separate SFX wav and stems written", wav.exists() and (root / "res" / "film_sfx_stem_impacts.wav").exists() or
              any((root / "res").glob("*_stem_*.wav")))
        check("the SFX track is exactly as long as the film (not cut at the last sound)",
              wav.exists() and abs(float(probe(wav, "format=duration") or 0) - 8.0) < 0.02,
              probe(wav, "format=duration") if wav.exists() else "")
        resolved = root / "res" / "film_sfx_resolved_cues.json"
        rj = json.loads(resolved.read_text(encoding="utf-8")) if resolved.exists() else {"loudness": {}, "cues": []}
        tp = (rj["loudness"].get("final") or {}).get("true_peak")
        check("true peak at or below -0.8 dBTP", tp is not None and tp <= -0.8, f"{tp}")
        r, ok = sh([PY, S / "verify.py", resolved, wav], env)
        check("verify: peaks on their moments, no clipping", ok, r.stdout.strip().splitlines()[-1] if r.stdout else r.stderr[-100:])
        r, ok = sh([PY, S / "critique.py", resolved, wav, "--moments", root / "work" / "moments.json"], env, ok_codes=(0, 1))
        check("critique scoreboard produced", "| hook |" in r.stdout and "| sync |" in r.stdout)
        r, ok = sh([PY, S / "review.py", resolved, wav, "--out", root / "res" / "review.png"], env)
        check("review picture produced", ok and (root / "res" / "review.png").exists() and (root / "res" / "review.png").stat().st_size > 5000)
        clips = json.loads((root / "res" / "clips" / "sfx_clips.json").read_text(encoding="utf-8")) if (root / "res" / "clips" / "sfx_clips.json").exists() else []
        html = (root / "res" / "clips" / "sfx_clips_hyperframes.html").read_text(encoding="utf-8") if (root / "res" / "clips" / "sfx_clips_hyperframes.html").exists() else ""
        check("exported clips match cues, HyperFrames snippet has audio ids", len(clips) == len(rj["cues"]) and html.count("<audio id=") == len(clips), f"{len(clips)} clips")

        # 11 determinism
        out2 = root / "res2" / "film_sfx.mp4"
        sh([PY, S / "mix.py", root / "cues.json", "--out", out2, "--duck"], env)
        w2 = root / "res2" / "film_sfx_sfx_track.wav"
        check("deterministic: same cue sheet gives the identical SFX track", w2.exists() and sha(w2) == sha(wav))

        # 12 processing features end to end
        sheet = {"video": str(vid), "cues": [
            {"t": 1.0, "pick": {"role": "whoosh", "target_dur": 0.5}, "fit_dur": 0.4, "pitch": -3},
            {"t": 2.0, "pick": {"role": "hit"}, "reverse": True, "lowpass": 3000,
             "layers": [{"dt": 0.0, "pick": {"role": "sub_drop"}, "gain_db": -7}]},
            {"t": 4.0, "pick": {"role": "click"}, "highpass": 500},
            {"t": 6.6, "pick": {"role": "whoosh", "target_dur": 0.5}, "pitch": 2}]}
        (root / "proc.json").write_text(json.dumps(sheet), encoding="utf-8")
        r, ok = sh([PY, S / "mix.py", root / "proc.json", "--out", root / "proc" / "p.mp4"], env)
        pj = json.loads((root / "proc" / "p_resolved_cues.json").read_text(encoding="utf-8")) if ok else {"cues": []}
        fx = " ".join(c.get("fx", "") for c in pj["cues"])
        check("pitch, fit, reverse, filters and layers applied", ok and "rev" in fx and "-3st" in fx and "fit" in fx and len(pj["cues"]) == 5, fx)
        r, _ = sh([PY, S / "verify.py", root / "proc" / "p_resolved_cues.json", root / "proc" / "p_sfx_track.wav", "--json"], env,
                  ok_codes=(0, 1))
        vr = json.loads(r.stdout) if r.stdout.strip().startswith("{") else {"rows": []}
        lost = [x["t"] for x in vr["rows"] if x.get("present") is False]
        check("every cue, pitched or stretched, is audible at its own time (no lost delay)", vr["rows"] and not lost, str(lost))

        # 12b round 9 (the sync test): the moment of a sound. A hit that is loud from the start goes by its ARRIVAL (its loudest
        # 20 ms is 0.8 s in: put on the moment, it sounded 0.8 s before the picture), a swell goes by its peak
        ar_ = root / "arrive"
        ar_.mkdir()
        body_, swell_ = ar_ / "Body Hit.wav", ar_ / "Slow Swell.wav"
        moment_takes(body_, swell_)
        (ar_ / "cues.json").write_text(json.dumps({"duration": 9.0, "cues": [
            {"t": 1.2, "file": str(body_), "role": "hit"},
            {"t": 4.0, "file": str(swell_), "role": "riser"},
            {"t": 6.0, "file": str(body_), "role": "hit", "anchor": "peak"},
            {"t": 7.4, "file": str(body_), "role": "click"}]}), encoding="utf-8")
        r, ok = sh([PY, S / "mix.py", ar_ / "cues.json", "--out", ar_ / "m.mp4"], env)
        ac_ = json.loads((ar_ / "m_resolved_cues.json").read_text(encoding="utf-8"))["cues"] if ok else []
        check("the moment of a sound: a hit loud from the start lands by its arrival, a swell and an explicit peak by their peak, "
              "a click by its start",
              ok and [c_["anchor"] for c_ in ac_] == ["arrive", "peak", "peak", "start"]
              and ac_[0]["arrive_time"] is not None and abs(ac_[0]["start"] - (1.2 - ac_[0]["arrive_time"])) < 0.002
              and ac_[0]["peak_time"] - ac_[0]["arrive_time"] > 0.5 and ac_[0]["start"] > 1.0
              and abs(ac_[2]["start"] - (6.0 - ac_[2]["peak_time"])) < 0.002 and ac_[2]["start"] < 5.5
              and ac_[1]["arrive_time"] is None and ac_[3]["arrive_time"] is None,
              str([(c_["anchor"], c_["start"], c_["arrive_time"], c_["peak_time"]) for c_ in ac_]))
        wav_a = ar_ / "m_sfx_track.wav"
        r, _ = sh([PY, S / "verify.py", ar_ / "m_resolved_cues.json", wav_a, "--json"], env, ok_codes=(0, 1))
        va = json.loads(r.stdout) if r.stdout.strip().startswith("{") else {"rows": []}
        late_ = json.loads((ar_ / "m_resolved_cues.json").read_text(encoding="utf-8")) if ac_ else {"cues": []}
        late_["cues"][0]["t"] += 0.3                          # the same track, the moment 0.3 s later: the arrival is early now
        (ar_ / "late_cues.json").write_text(json.dumps(late_), encoding="utf-8")
        r, _ = sh([PY, S / "verify.py", ar_ / "late_cues.json", wav_a, "--json"], env, ok_codes=(0, 1))
        vl = json.loads(r.stdout) if r.stdout.strip().startswith("{") else {"rows": []}
        row_ = lambda v_: next((x_ for x_ in v_["rows"] if abs(x_["t"] - 1.2) < 0.4), {})      # noqa: E731
        check("verify: an arrival is judged by its arrival (on the moment: ok; 0.3 s late: off), the others by their loudest",
              row_(va).get("note") == "arrival" and row_(va).get("ok") is True and abs(row_(va).get("off_ms") or 999) <= 60
              and row_(vl).get("note") == "arrival" and row_(vl).get("ok") is False
              and all(x_.get("ok") for x_ in va["rows"] if x_["judged"]),
              f"on the moment {row_(va).get('off_ms')} ms, late {row_(vl).get('off_ms')} ms")
        sys.path.insert(0, str(S))
        import common as CMA_
        pure_ = {"fast": {"peak": 0.9, "arrive": 0.05, "onset20": 0.01, "near": 0.1, "climb": 0.09},
                 "builds": {"peak": 1.6, "arrive": 0.8, "onset20": 0.15, "near": 1.1, "climb": 0.95},
                 "close": {"peak": 0.12, "arrive": 0.05, "onset20": 0.01, "near": 0.1, "climb": 0.09}}
        lm_body, lm_swell = CMA_.arrival_landmarks(body_), CMA_.arrival_landmarks(swell_)
        check("common.arrive_offset: arrive only for a fast climb with the peak 0.10 s or more later, a forced arrive always",
              CMA_.arrive_offset(pure_["fast"], 0.9) == 0.05 and CMA_.arrive_offset(pure_["builds"], 1.6) is None
              and CMA_.arrive_offset(pure_["close"], 0.12) is None and CMA_.arrive_offset(None, 0.9) is None
              and CMA_.arrive_offset(pure_["builds"], 1.6, forced=True) == 0.8 and CMA_.arrive_offset(None, 0.9, forced=True) is None
              and lm_body and lm_swell and lm_body["arrive"] < 0.05 and lm_body["climb"] < CMA_.ARRIVE_CLIMB_S
              and lm_swell["climb"] >= CMA_.ARRIVE_CLIMB_S and 0.6 < lm_swell["arrive"] < 1.0,
              f"body {lm_body}, swell {lm_swell}")

        # 13 voice-safe and beat snapping
        cv = root / "clickvideo.mp4"
        ff(["-f", "lavfi", "-i", "color=c=black:s=320x180:d=16:r=30", "-i", clk, "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest", cv])
        (root / "snap.json").write_text(json.dumps({"video": str(cv), "cues": [
            {"t": 2.10, "pick": {"role": "hit", "max_dur": 1.0}}, {"t": 4.40, "pick": {"role": "hit", "max_dur": 1.0}}]}), encoding="utf-8")
        r, ok = sh([PY, S / "mix.py", root / "snap.json", "--out", root / "snap" / "s.mp4", "--snap-beats", "--voice-safe"], env)
        sj = json.loads((root / "snap" / "s_resolved_cues.json").read_text(encoding="utf-8")) if ok else {"cues": []}
        ts = [c["t"] for c in sj["cues"]]
        check("beat snapping: near cue moves to the beat, far cue stays", ok and len(ts) == 2 and abs(ts[0] - 2.122) < 0.02 and abs(ts[1] - 4.40) < 0.001, str(ts))

        # 14 many cues (batch path) and audio-only input
        random.seed(5)
        many = [{"t": round(random.uniform(0.2, 29.5), 3), "pick": {"role": random.choice(["whoosh", "hit", "click", "glitch"]),
                                                              "max_dur": 1.0}, "gain_db": -9,
                 "pitch": random.choice([0, 0, -2, 3])} for _ in range(120)]
        (root / "many.json").write_text(json.dumps({"duration": 30.0, "cues": many}), encoding="utf-8")
        r, ok = sh([PY, S / "mix.py", root / "many.json", "--out", root / "many" / "m.mp4"], env)
        mw = root / "many" / "m_sfx_track.wav"
        check("120 cues render in batches to exactly 30 s", ok and mw.exists() and abs(float(probe(mw, "format=duration")) - 30.0) < 0.05)
        r, _ = sh([PY, S / "verify.py", root / "many" / "m_resolved_cues.json", mw, "--json"], env, ok_codes=(0, 1))
        vr = json.loads(r.stdout) if r.stdout.strip().startswith("{") else {"rows": []}
        lost = [x["t"] for x in vr["rows"] if x.get("present") is False]
        check("none of the 120 cues is lost in the batched render", len(vr["rows"]) == 120 and not lost,
              f"{len(lost)} missing" if lost else "")
        (root / "ao.json").write_text(json.dumps({"video": str(clk), "keep_audio": "yes", "cues": [
            {"t": 0.5, "pick": {"role": "hit", "max_dur": 0.8}}]}), encoding="utf-8")
        r, ok = sh([PY, S / "mix.py", root / "ao.json", "--out", root / "ao" / "a.mp4"], env)
        check("audio-only source gives wav outputs, no mp4", ok and (root / "ao" / "a_mix.wav").exists() and not (root / "ao" / "a.mp4").exists())

        # 15 HyperFrames import
        hf = root / "hf"
        (hf / "scenes").mkdir(parents=True)
        (hf / "index.html").write_text(
            '<div id="root" data-composition-id="main" data-start="0" data-duration="10">'
            '<section id="a" class="clip" data-start="0" data-duration="4"><h1 id="title">x</h1></section>'
            '<section id="b" class="clip" data-start="a" data-duration="6"><div id="cta" class="clip" data-start="6" data-duration="2">y</div></section>'
            '</div><script>const tl = gsap.timeline({paused:true});'
            'tl.from("#title",{opacity:0,y:30,duration:0.5},0.2);tl.to("#cta",{scale:1.2,duration:0.2},6.5);</script>', encoding="utf-8")
        r, ok = sh([PY, S / "from_hyperframes.py", hf, "--out", hf / "m.json"], env)
        hm = json.loads((hf / "m.json").read_text(encoding="utf-8"))["moments"] if ok else []
        have = {(round(m["t"], 1), m["kind"]) for m in hm}
        check("HyperFrames import: scene cut at 4.0 s, tween onset at 0.2 s, burst at 6.5 s",
              (4.0, "cut") in have and (0.2, "onset") in have and (6.5, "burst") in have, str(sorted(have)))

        # 15b typed cue list from the project -> real sounds, keystrokes cut from the typing take, sync check
        typed = [{"t": 2.0, "type": "wipe"}, {"t": 5.0, "type": "wipe", "g": 0.8}, {"t": 3.5, "type": "thump", "g": 0.7},
                 {"t": 1.0, "type": "whoosh", "len": 0.5, "g": 0.6}, {"t": 6.2, "type": "click"},
                 {"t": 6.9, "type": "mystery"}] + \
                [{"t": round(4.0 + 0.09 * i, 3), "type": "key", "g": 1.0} for i in range(6)]
        (root / "typed.json").write_text(json.dumps(typed), encoding="utf-8")
        r, ok = sh([PY, S / "from_cues.py", root / "typed.json", "--video", vid, "--out", root / "typed_cues.json",
                    "--moments", root / "work" / "moments.json"], env)
        tc = json.loads((root / "typed_cues.json").read_text(encoding="utf-8")) if ok else {"cues": [], "_draft": {}}
        keys = [c for c in tc["cues"] if c.get("slice")]
        check("typed cue list: kinds routed, unknown kind reported, keystrokes sliced from a real take",
              ok and len(tc["cues"]) >= 8 and len(keys) >= 4 and "mystery" in tc["_draft"].get("unmapped", {}),
              f"{len(tc['cues'])} cues, {len(keys)} keystrokes, unmapped {tc['_draft'].get('unmapped')}")
        check("sync check: wipes and thump sit on the picture changes", "sync:" in r.stdout and "belongs to this render" in r.stdout,
              [l for l in r.stdout.splitlines() if "sync" in l][:1] and [l for l in r.stdout.splitlines() if "sync" in l][0][:90])
        r2, ok2 = sh([PY, S / "from_cues.py", root / "typed.json", "--video", vid, "--out", root / "typed_cues2.json",
                      "--moments", root / "work" / "moments.json", "--shift", "0.4"], env)
        check("sync check: a list that is 0.4 s late is called out with the shift to apply",
              ok2 and "WARN sync" in r2.stdout and "--shift" in r2.stdout, [l for l in r2.stdout.splitlines() if "sync" in l][:1] and
              [l for l in r2.stdout.splitlines() if "sync" in l][0][:100])
        r, ok = sh([PY, S / "mix.py", root / "typed_cues.json", "--out", root / "typed" / "t.mp4", "--voice-safe"], env)
        r, _ = sh([PY, S / "verify.py", root / "typed" / "t_resolved_cues.json", root / "typed" / "t_sfx_track.wav", "--json"],
                  env, ok_codes=(0, 1))
        vr = json.loads(r.stdout) if r.stdout.strip().startswith("{") else {"rows": []}
        check("typed sheet mixes; every cue is present in the track",
              ok and vr["rows"] and not [x for x in vr["rows"] if x.get("present") is False],
              f"{len(vr['rows'])} cues")

        # 15c looking at a film before it has sound
        for name, cmd in (("story", [vid, "--out", root / "look" / "story"]),
                          ("close look", [vid, "--at", "3.5", "--span", "2", "--out", root / "look" / "at.png"]),
                          ("moment sheet", ["--moments", root / "work" / "moments.json", "--out", root / "look" / "mom.png"])):
            r, ok = sh([PY, S / "look.py"] + cmd, env)
            png = next(iter(sorted((root / "look").glob({"story": "story_1.png", "close look": "at.png",
                                                         "moment sheet": "mom*.png"}[name]))), None) if (root / "look").exists() else None
            check(f"look.py {name}", ok and png is not None and png.stat().st_size > 3000, "" if ok else r.stderr[-120:])
        # a reel: 15 fps, the audio 0.4 s longer than the picture (every social export does this): the frame asked
        # for after the last picture is not written and the sheet used to die on a missing row
        reel = root / "reel.mp4"
        ff(["-f", "lavfi", "-i", "color=c=0x303040:s=180x320:r=15:d=3.0", "-f", "lavfi", "-i", "sine=f=330:d=3.4",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", reel])
        r, ok = sh([PY, S / "look.py", reel, "--out", root / "look" / "reel"], env)
        check("look.py story: a 15 fps reel whose audio outlasts its picture still gets its sheet",
              ok and (root / "look" / "reel_1.png").exists() and (root / "look" / "reel_1.png").stat().st_size > 2000,
              "" if ok else r.stderr[-120:])

        # 15d replace the synthesized layer: stems -> base audio, detection of a layer baked into the render
        proj = root / "proj"
        (proj / "assets" / "audio" / "stems").mkdir(parents=True)
        (proj / "index.html").write_text("<html></html>", encoding="utf-8")
        ff(["-f", "lavfi", "-i", "sine=f=220:d=8:r=48000", "-af", "volume=0.1", "-ac", "1", proj / "assets" / "audio" / "stems" / "music.wav"])
        click_stem(proj / "assets" / "audio" / "stems" / "sfx.wav", [1.0, 2.5, 4.0, 6.5])
        baked = root / "baked.mp4"
        ff(["-f", "lavfi", "-i", "color=c=0x202030:s=320x180:d=8:r=30", "-i", proj / "assets" / "audio" / "stems" / "music.wav",
            "-i", proj / "assets" / "audio" / "stems" / "sfx.wav", "-filter_complex",
            "[1:a][2:a]amix=inputs=2:normalize=0:duration=longest[a]", "-map", "0:v", "-map", "[a]", "-c:v", "libx264",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "8", baked])
        (root / "baked_cues.json").write_text(json.dumps([{"t": 1.0, "type": "click"}, {"t": 2.5, "type": "click"},
                                                           {"t": 4.0, "type": "click"}, {"t": 5.5, "type": "wipe"},
                                                           {"t": 6.5, "type": "click"}]), encoding="utf-8")
        r, ok = sh([PY, S / "from_cues.py", root / "baked_cues.json", "--video", baked, "--project", proj,
                    "--out", root / "baked_sheet.json"], env)
        bs = json.loads((root / "baked_sheet.json").read_text(encoding="utf-8")) if ok else {}
        ub_ = (bs.get("_draft", {}).get("stems", {}) or {}).get("unbake") or {}
        first_ = (bs.get("base_audio") or [None])[0]
        first_f = first_.get("file", "") if isinstance(first_, dict) else str(first_ or "")
        check("synthesized layer baked into the render is detected and the project's stem is subtracted from it",
              ok and "BAKED" in r.stdout and "unbake:" in r.stdout and ub_.get("ok") and first_f.endswith("_base.wav")
              and "sfx.wav" in (bs.get("_draft", {}).get("stems", {}) or {}).get("synth", [])
              and abs(ub_.get("rho_after", 1.0)) < 0.05,
              [l for l in r.stdout.splitlines() if "BAKED" in l or "stems" in l][:1] and
              ([l for l in r.stdout.splitlines() if "BAKED" in l or "stems" in l][0][:90]))
        r, ok = sh([PY, S / "mix.py", root / "baked_sheet.json", "--out", root / "base" / "b.mp4"], env)
        bj = json.loads((root / "base" / "b_resolved_cues.json").read_text(encoding="utf-8")) if ok else {}
        sys.path.insert(0, str(S))
        from common import decode_mono
        def click_rms(path):                 # the render's own audio where the synthesized clicks are
            x, rate = decode_mono(path, 16000)
            tot, cnt = 0.0, 0
            for t_ in (1.0, 2.5, 4.0, 6.5):
                seg = x[int(t_ * rate): int((t_ + 0.03) * rate)]
                tot += sum(v * v for v in seg)
                cnt += len(seg)
            return math.sqrt(tot / max(1, cnt))
        base_ok = ok and str(bj.get("original_audio", "")).endswith("_base.wav") and Path(bj["original_audio"]).exists()
        r_base = click_rms(bj["original_audio"]) if base_ok else 1e9
        r_orig = click_rms(baked)
        check("the original under the new sounds is rebuilt without the synthesized clicks (>= 9 dB down where they were)",
              base_ok and r_base < 0.35 * r_orig, f"click windows: base {r_base:.0f}, render's own audio {r_orig:.0f}")
        r, ok = sh([PY, S / "critique.py", root / "base" / "b_resolved_cues.json", root / "base" / "b_sfx_track.wav"],
                   env, ok_codes=(0, 1))
        check("critique reads the rebuilt original (no crash, scoreboard present)", "| balance |" in r.stdout or "| sync |" in r.stdout)
        r, ok = sh([PY, S / "mix.py", root / "baked_sheet.json",
                    "--out", root / "drop" / "d.mp4", "--drop-original"], env)
        dj = json.loads((root / "drop" / "d_resolved_cues.json").read_text(encoding="utf-8")) if ok else {}
        check("--drop-original throws the render's own audio away", ok and dj.get("keep_audio") is False)

        # 15d2 round 3: a named sound beats a pick; sheet.py keeps one numbering, batches, freezes
        cmix = {"duration": 4.0, "cues": [
            {"t": 1.0, "label": "both", "anchor": "start", "role": "hit", "pick": {"role": "whoosh"},
             "file": str(lib / "Hits and impacts" / "Hit 1.wav")},
            {"t": 2.0, "label": "thump", "pick": {"role": "hit"}}, {"t": 2.0, "label": "pop", "pick": {"role": "click"},
                                                                  "gain_db": -9}]}
        (root / "named.json").write_text(json.dumps(cmix), encoding="utf-8")
        r, ok = sh([PY, S / "mix.py", root / "named.json", "--out", root / "named" / "n.mp4", "--no-loudnorm"], env)
        nj = json.loads((root / "named" / "n_resolved_cues.json").read_text(encoding="utf-8")) if ok else {"cues": []}
        both = next((c for c in nj["cues"] if c["label"] == "both"), {})
        check("a file named on purpose beats an automatic pick (and says so)",
              ok and Path(both.get("file", "")).name == "Hit 1.wav" and "both a pick and file" in
              (root / "named" / "n_cue_report.md").read_text(encoding="utf-8"), Path(both.get("file", "")).name)
        shp = root / "layers.json"
        sh([PY, S / "sheet.py", "new", shp, "--duration", "4"], env)
        sh([PY, S / "sheet.py", "add", shp, '{"t": 2.0, "label": "thump", "pick": {"role": "hit"}}',
            '{"t": 2.0, "label": "pop", "pick": {"role": "click"}}', '{"t": 0.5, "label": "bead", "pick": {"role": "click"}}'], env)
        r, ok = sh([PY, S / "sheet.py", "set", shp, "--at", "2.0", "gain_db=-3"], env, ok_codes=(0, 1))
        amb = r.returncode != 0 and "name one" in (r.stderr + r.stdout)
        r, ok = sh([PY, S / "sheet.py", "set", shp, "--at", "2.0", "--label", "thump", "gain_db=-3", "id=7"], env)
        r2, ok2 = sh([PY, S / "sheet.py", "show", shp], env)
        row = [l for l in r2.stdout.splitlines() if "thump" in l]
        check("sheet.py: a time alone must name one of two layers; at+label does; id= replaces the pick",
              amb and ok and row and "id 7" in row[0] and "pick" not in row[0], row[0][:80] if row else r2.stdout[:80])
        (root / "edits.json").write_text(json.dumps([{"at": 2.0, "label": "pop", "set": {"gain_db": -6}},
                                                      {"label": "bead", "drop": True},
                                                      {"at": 2.0, "label": "thump", "shift": 0.04}]), encoding="utf-8")
        r, ok = sh([PY, S / "sheet.py", "apply", shp, root / "edits.json"], env)
        sj = json.loads(shp.read_text(encoding="utf-8"))
        check("sheet.py apply: one batch, one numbering (a set, a drop and a shift)",
              ok and len(sj["cues"]) == 2 and [c["label"] for c in sj["cues"]] == ["pop", "thump"]
              and abs(sj["cues"][1]["t"] - 2.04) < 1e-6 and sj["cues"][0]["gain_db"] == -6, str(sj["cues"])[:120])
        # freeze: pin what a render picked
        cfz = {"duration": 4.0, "cues": [{"t": 1.0, "label": "w", "pick": {"role": "whoosh"}},
                                         {"t": 2.5, "label": "h", "pick": {"role": "hit"}}]}
        (root / "fz.json").write_text(json.dumps(cfz), encoding="utf-8")
        r, ok = sh([PY, S / "mix.py", root / "fz.json", "--out", root / "fz" / "f.mp4", "--no-loudnorm"], env)
        r, ok2 = sh([PY, S / "sheet.py", "freeze", root / "fz.json", root / "fz" / "f_resolved_cues.json"], env)
        fj = json.loads((root / "fz.json").read_text(encoding="utf-8"))
        check("sheet.py freeze: the picked files replace the automatic picks",
              ok and ok2 and all("file" in c and "pick" not in c for c in fj["cues"]), str(fj["cues"])[:100])

        # 15d3 a project that synthesizes in a script: its calls are the list, nothing is written
        if shutil.which("node"):
            pj = root / "synthproj"
            (pj / "scripts").mkdir(parents=True)
            (pj / "package.json").write_text("{}", encoding="utf-8")
            (pj / "scripts" / "audio.cjs").write_text(
                "const fs = require('fs');\nconst SR = 48000;\nconst buf = new Float32Array(SR * 4);\n"
                "function add(t0, len, fn, g = 1) { const s0 = Math.round(t0 * SR); for (let i = 0; i < len * SR; i++)"
                " { if (s0 + i < buf.length) buf[s0 + i] += fn(i / SR) * g; } }\n"
                "const whoosh = (t, up, g = 0.3, len = 0.5) => { add(t, len, (x) => Math.sin(300 * x), g); };\n"
                "const click = (t, g = 0.2) => add(t, 0.03, (x) => Math.sin(3000 * x), g);\n"
                "for (let i = 0; i < 4; i++) add(i * 0.9, 0.5, (x) => Math.sin(110 * x), 0.2);\n"
                "whoosh(1.5, 1); click(2.0); click(2.4, 0.5); whoosh(3.0, 0, 0.4, 0.8);\n"
                "fs.writeFileSync(require('path').join(__dirname, '..', 'out.wav'), Buffer.from(buf.buffer));\n",
                encoding="utf-8")
            r, ok = sh([PY, S / "from_synth.py", pj, "--out", root / "synth_events.json"], env)
            ev = json.loads((root / "synth_events.json").read_text(encoding="utf-8")) if ok else []
            kinds_ = {}
            for e in ev:
                kinds_[e["type"]] = kinds_.get(e["type"], 0) + 1
            wh = [e for e in ev if e["type"] == "whoosh"]
            check("from_synth: the calls of the project's script are the event list; `add` is a helper; nothing written",
                  ok and kinds_ == {"whoosh": 2, "click": 2} and abs(wh[1]["len"] - 0.8) < 1e-6 and abs(wh[0]["g"] - 0.3) < 1e-6
                  and not (pj / "out.wav").exists(), json.dumps(kinds_))
            r, ok = sh([PY, S / "from_cues.py", pj, "--out", root / "synth_sheet.json", "--no-check"], env)
            sj2 = json.loads((root / "synth_sheet.json").read_text(encoding="utf-8")) if ok else {"cues": []}
            check("from_cues reads a project folder: events from its script become cues",
                  ok and len(sj2["cues"]) == 4, f"{len(sj2['cues'])} cues")
        else:
            check("from_synth (skipped: node not found)", True)

        # 15e things the fresh-agent runs found: mp3 slices keep their attack, clicks land on time, onsets, slices
        sys.path.insert(0, str(S))
        import mix as mixmod
        from common import decode_mono
        mp3 = lib / "Keyboard" / "Keyboard Typing 2.mp3"
        from common import onsets as find_onsets
        ons, _ = find_onsets(mp3)
        sl_dir = root / "slices"
        if len(ons) >= 3:
            on_t = ons[2][0]
            cdict = {"slice": [max(0.0, on_t - 0.006), 0.085]}
            sp = mixmod.cut_slice(mp3, cdict, sl_dir)
            x, rate = decode_mono(sp, 16000)
            head = max((abs(v) for v in x[: int(0.015 * rate)]), default=0)
            whole = max((abs(v) for v in x), default=1)
            check("an mp3 slice keeps its attack (no decoder-preroll silence)", head >= 0.3 * whole,
                  f"first 15 ms peak {head}, whole {whole}")
        else:
            check("an mp3 slice keeps its attack (no decoder-preroll silence)", False, f"only {len(ons)} onsets found")
        r, ok = sh([PY, S / "listen.py", "onsets", lib / "Keyboard" / "Keyboard Typing 1.wav"], env)
        check("listen.py onsets lists the separate sounds with slices", ok and r.stdout.count('"slice"') >= 5,
              f"{r.stdout.count('slice')} slices")
        cl = {"duration": 4.0, "cues": [{"t": 1.0, "label": "click", "anchor": "start", "role": "click",
                                         "file": str(lib / "Clicks" / "Click 1.wav"), "gain_db": 6},
                                        {"t": 2.5, "label": "knock", "role": "hit", "anchor": "start",
                                         "file": str(lib / "Keyboard" / "Keyboard Typing 1.wav"), "slice": "first"}]}
        (root / "lat.json").write_text(json.dumps(cl), encoding="utf-8")
        r, ok = sh([PY, S / "mix.py", root / "lat.json", "--out", root / "lat" / "l.mp4", "--no-loudnorm"], env)
        lj = json.loads((root / "lat" / "l_resolved_cues.json").read_text(encoding="utf-8")) if ok else {"cues": []}
        trk = root / "lat" / "l_sfx_track.wav"
        if ok and trk.exists():
            x, rate = decode_mono(trk, 48000)
            i = next((k for k, v in enumerate(x) if abs(v) > 800), None)
            first_ms = None if i is None else (i / rate - 1.0) * 1000
            check("a click lands on its time within 4 ms (the limiter does not delay it)",
                  first_ms is not None and -1.5 <= first_ms <= 4.0, f"{first_ms} ms")
        else:
            check("a click lands on its time within 4 ms (the limiter does not delay it)", False, r.stderr[-120:])
        sl = [c.get("slice") for c in lj["cues"] if c.get("slice")]
        check('"slice": "first" is resolved to a start and a length', ok and sl and isinstance(sl[0], list), str(sl))
        r, _ = sh([PY, S / "verify.py", root / "lat" / "l_resolved_cues.json", trk, "--json"], env, ok_codes=(0, 1))
        vr = json.loads(r.stdout) if r.stdout.strip().startswith("{") else {"rows": []}
        starts = [x for x in vr["rows"] if x["anchor"] == "start" and x["judged"]]
        check("verify judges a click by its first onset", starts and all(x["ok"] for x in starts), f"{len(starts)} judged")
        # the project's stems belong to ANOTHER cut (12 s of music against an 8 s film): say so, do not use them
        proj2 = root / "proj2"
        (proj2 / "assets" / "audio" / "stems").mkdir(parents=True)
        (proj2 / "index.html").write_text("<html></html>", encoding="utf-8")
        ff(["-f", "lavfi", "-i", "sine=f=330:d=12:r=48000", "-af", "volume=0.1", "-ac", "1",
            proj2 / "assets" / "audio" / "stems" / "music.wav"])
        click_stem(proj2 / "assets" / "audio" / "stems" / "sfx.wav", [1.0, 2.5, 4.0, 6.5], dur=12.0)
        r, ok = sh([PY, S / "from_cues.py", root / "baked_cues.json", "--video", baked, "--project", proj2,
                    "--out", root / "wrong_stems.json"], env)
        ws = json.loads((root / "wrong_stems.json").read_text(encoding="utf-8")) if ok else {}
        check("stems of another cut are recognised and not used as the base",
              ok and "do NOT belong" in r.stdout and not ws.get("base_audio"),
              [l for l in r.stdout.splitlines() if "stems" in l][:1] and [l for l in r.stdout.splitlines() if "stems" in l][0][:100])

        # 15f a sorted pack with a catalog; the fallback tier; garbled names repaired; AppleDouble stubs ignored
        import unicodedata
        pack = root / "pack"
        for d in ("impact", "pop", "whoosh", "typing"):
            (pack / d).mkdir(parents=True)
        ff(["-f", "lavfi", "-i", "sine=f=60:d=0.5:r=48000,afade=t=out:d=0.45", "-ac", "2",
            pack / "impact" / "impact_boom-1_0.50s.wav"])
        for k in range(3):
            ff(["-f", "lavfi", "-i", f"sine=f={800 + 100 * k}:d=0.1:r=48000,afade=t=out:d=0.09", "-ac", "2",
                pack / "pop" / f"pop_bubble-{k}_0.10s.wav"])
        ff(["-i", pack / "pop" / "pop_bubble-0_0.10s.wav", "-c:a", "libmp3lame", "-b:a", "192k",
            pack / "pop" / "pop_bubble-0_0.10s.mp3"])
        wh_name = unicodedata.normalize("NFD", "whoosh_быстрый-вуш_0.40s.wav")      # a Mac writes 'й' as 'и' + a mark
        garbled = wh_name.encode("utf-8").decode("cp437")                         # what an unzip on Windows makes of it
        ff(["-f", "lavfi", "-i", "anoisesrc=d=0.4:c=pink:r=48000,highpass=f=500,afade=t=in:d=0.15,afade=t=out:st=0.15:d=0.25",
            "-ac", "2", pack / "whoosh" / garbled])
        (pack / "pop" / "._pop_bubble-0_0.10s.wav").write_bytes(b"\x00\x05\x16\x07" * 200)     # AppleDouble stub
        typing_take(pack / "typing" / "typing_keyboard-typing-1_2.00s.wav", keys=24)
        rows = [{"type": "impact", "by": "folder", "file": "impact/impact_boom-1_0.50s.wav", "source": "хиты/Boom 1.wav",
                 "hit": 0, "hits_in_source": 1, "dur": 0.5}]
        rows += [{"type": "pop", "by": "folder", "file": f"pop/pop_bubble-{k}_0.10s.wav", "source": f"попы/Bubble {k}.wav",
                  "hit": 0, "hits_in_source": 1, "dur": 0.1} for k in range(3)]
        rows += [{"type": "pop", "by": "folder", "file": "pop/pop_bubble-0_0.10s.mp3", "source": "попы/Bubble 0.mp3",
                  "hit": 0, "hits_in_source": 1, "dur": 0.1},
                 {"type": "whoosh", "by": "folder", "file": "whoosh/" + wh_name,
                  "source": unicodedata.normalize("NFD", "вуши/быстрый вуш.wav"), "hit": 0, "hits_in_source": 1,
                  "dur": 0.4},
                 {"type": "typing", "by": "folder", "file": "typing/typing_keyboard-typing-1_2.00s.wav",
                  "source": "звук печатания клавы/Keyboard Typing/Type 1.wav", "hit": 0, "hits_in_source": 1,
                  "dur": 2.0}]
        (pack / "catalog.json").write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
        (root / "config_pack.json").write_text(json.dumps({
            "libraries": [{"name": "pack", "path": str(pack), "tier": "main"},
                          {"name": "fallback", "path": str(lib), "tier": "extra"}],
            "uisfx": {"path": "vendor/node_modules/uisfx", "default_pack": "studio"},
            "index_path": str(root / "index_pack.json")}), encoding="utf-8")
        env2 = dict(env, REAL_SFX_CONFIG=str(root / "config_pack.json"), REAL_SFX_INDEX=str(root / "index_pack.json"))
        r, ok = sh([PY, S / "build_index.py"], env2)
        pidx = json.loads((root / "index_pack.json").read_text(encoding="utf-8"))["sounds"] \
            if (root / "index_pack.json").exists() else []
        mine = [s for s in pidx if s["library"] == "pack"]
        check("pack: a stub, a wav/mp3 twin and nothing else are dropped (6 sounds)", ok and len(mine) == 6,
              f"{len(mine)} sounds: {[s['name'] for s in mine]}")
        wh = next((s for s in mine if s.get("pack_type") == "whoosh"), {})
        check("pack: a garbled Mac name is repaired, the name comes from the source, Russian words get aliases",
              wh.get("name") == "быстрый вуш" and "whoosh" in wh.get("aliases", []) and wh.get("role") == "whoosh",
              f"{wh.get('name')!r} {wh.get('aliases')}")
        pp = next((s for s in mine if s.get("pack_type") == "pop"), {})
        check("pack: the pack type decides the role (pop is a pop, still a ui sound)",
              pp.get("role") == "pop" and "ui" in pp.get("roles", []) and pp.get("tier") == "main", str(pp.get("roles")))
        r, ok = sh([PY, S / "search.py", "--role", "whoosh", "--tier", "main", "--limit", "9"], env2)
        check("tier main: only the main library answers", ok and "быстрый" in r.stdout and "Whoosh 1" not in r.stdout,
              r.stdout.splitlines()[0][:80] if r.stdout else r.stderr[-80:])
        r, ok = sh([PY, S / "search.py", "--role", "glitch", "--limit", "5"], env2)
        check("fallback tier fills what the main library lacks (marked ~)", ok and "Glitch 1" in r.stdout and "~" in r.stdout)
        r, ok = sh([PY, S / "search.py", "--role", "whoosh", "--limit", "9"], env2)
        first = r.stdout.splitlines()[0] if r.stdout else ""
        check("default tier policy: the main sound comes first, extras follow when fewer than 3 main fit",
              ok and "быстрый" in first and "Whoosh 1" in r.stdout, first[:90])

        # 15h the sorted folder Sounds_by_tag: it holds copies of a pack another library indexes in place (skip_packs),
        # a folder that is not effects (skip_dir_names), and types the first pack never had (a type the skill has no
        # name for is a role of its own)
        bt = root / "bytag"
        for d in ("whoosh", "granular", "_review"):
            (bt / d).mkdir(parents=True)
        ff(["-f", "lavfi", "-i", "anoisesrc=d=0.4:c=pink:r=48000,highpass=f=500,afade=t=out:st=0.1:d=0.3", "-ac", "2",
            bt / "whoosh" / "whoosh_copy-of-old_0.40s.wav"])
        ff(["-f", "lavfi", "-i", "anoisesrc=d=0.5:c=brown:r=48000,afade=t=in:d=0.2,afade=t=out:st=0.2:d=0.3", "-ac", "2",
            bt / "whoosh" / "whoosh_botanica-new-whoosh-1_0.50s.wav"])
        ff(["-f", "lavfi", "-i", "sine=f=300:d=0.6:r=48000,tremolo=f=30:d=0.9,afade=t=out:st=0.3:d=0.3", "-ac", "2",
            bt / "granular" / "granular_botanica-texture-1_0.60s.wav"])
        ff(["-f", "lavfi", "-i", "sine=f=220:d=0.5:r=48000", "-ac", "2", bt / "_review" / "_review_kenyset-a-track_0.50s.wav"])
        brows = [{"type": "whoosh", "by": "folder", "file": "whoosh/whoosh_copy-of-old_0.40s.wav",
                  "source": "Sounds_sorted/whoosh/Old Whoosh.wav", "hit": 0, "hits_in_source": 1, "pack": "montage"},
                 {"type": "whoosh", "by": "folder", "file": "whoosh/whoosh_botanica-new-whoosh-1_0.50s.wav",
                  "source": "Botanica V4/Transition/Whoosh/New Whoosh (1).wav", "hit": 0, "hits_in_source": 1,
                  "pack": "botanica"},
                 {"type": "granular", "by": "folder", "file": "granular/granular_botanica-texture-1_0.60s.wav",
                  "source": "Botanica V4/Granular/Texture (1).wav", "hit": 0, "hits_in_source": 1, "pack": "botanica"}]
        (bt / "catalog.json").write_text(json.dumps(brows, ensure_ascii=False), encoding="utf-8")
        (root / "config_bytag.json").write_text(json.dumps({
            "libraries": [{"name": "bytag", "path": str(bt), "tier": "main", "skip_packs": ["montage"]}],
            "skip_dir_names": ["_review"],
            "uisfx": {"path": "vendor/node_modules/uisfx", "default_pack": "studio"},
            "index_path": str(root / "index_bytag.json")}), encoding="utf-8")
        env3 = dict(env, REAL_SFX_CONFIG=str(root / "config_bytag.json"), REAL_SFX_INDEX=str(root / "index_bytag.json"))
        r, ok = sh([PY, S / "build_index.py"], env3)
        bidx = json.loads((root / "index_bytag.json").read_text(encoding="utf-8"))["sounds"] \
            if (root / "index_bytag.json").exists() else []
        check("by-tag folder: skip_packs leaves out the copy of a pack indexed elsewhere, skip_dir_names the _review folder",
              ok and sorted(s["name"] for s in bidx) == ["New Whoosh (1)", "Texture (1)"],
              f"{[s['name'] for s in bidx]} {r.stdout.splitlines()[:2] if r.stdout else r.stderr[-120:]}")
        gr = next((s for s in bidx if s.get("pack_type") == "granular"), {})
        nw = next((s for s in bidx if s.get("pack_type") == "whoosh"), {})
        check("by-tag folder: a type the skill had no name for is a role of its own, a whoosh stays a whoosh",
              gr.get("roles") == ["granular"] and nw.get("role") == "whoosh", f"{gr.get('roles')} {nw.get('role')}")
        r, ok = sh([PY, S / "search.py", "--role", "granular", "--limit", "5"], env3)
        r2, ok2 = sh([PY, S / "search.py", "--role", "whoosh", "--limit", "5"], env3)
        check("by-tag folder: search --role granular finds the texture, search --role whoosh does not",
              ok and ok2 and "Texture" in r.stdout and "Texture" not in r2.stdout and "New Whoosh" in r2.stdout,
              (r.stdout.splitlines() or [r.stderr[-80:]])[0][:80])

        # 15g events of a screen recording, region by region -> typed cue list -> real keystrokes of the pack
        scr = root / "screen.mp4"
        keys_t = [1.0, 1.25, 1.45, 1.8, 2.0, 2.2, 2.6, 2.75, 3.0, 3.3]
        fl = ["drawbox=x=40:y=300:w=560:h=40:color=0x808080:t=2"]
        fl += [f"drawbox=x={50 + 14 * i}:y=311:w=10:h=18:color=white:t=fill:enable='gte(t,{k})'"
               for i, k in enumerate(keys_t)]
        fl += ["drawbox=x=400:y=308:w=2:h=24:color=white:t=fill:enable='lt(mod(t,1),0.5)'",
               "drawbox=x=440:y=20:w=180:h=60:color=0x40c060:t=fill:enable='between(t,4.0,5.2)'",
               "drawbox=x=500:y=150:w=80:h=40:color=0xffcc00:t=fill:enable='between(t,7.5,7.7)'",
               "drawbox=x=0:y=0:w=iw:h=ih:color=0xe8e8f0:t=fill:enable='gte(t,8.3)'"]
        ff(["-f", "lavfi", "-i", "color=c=0x20222a:s=640x360:r=30:d=9.5", "-f", "lavfi", "-i",
            "color=c=white:s=260x14:r=30:d=9.5", "-filter_complex",
            "[0:v]" + ",".join(fl) + "[bg];[bg][1:v]overlay=x=60:y='60+mod((t-6)*300,150)':enable='between(t,6.0,6.8)'",
            "-pix_fmt", "yuv420p", "-c:v", "libx264", "-crf", "12", scr])
        r, ok = sh([PY, S / "ui_events.py", scr, "--out", root / "ui", "--roi", "input=40,300,560,40:typing",
                    "--roi", "toast=440,20,180,60:popup", "--roi", "list=40,40,300,240:scroll",
                    "--roi", "play=500,150,80,40:click", "--roi", "screen=0,0,640,360:window"], env2)
        ev = json.loads((root / "ui" / "events.json").read_text(encoding="utf-8")) if ok and (root / "ui" / "events.json").exists() else []
        kt = [e["t"] for e in ev if e["type"] == "key"]
        check("ui_events: ten keystrokes found within 50 ms, the blinking caret is not one of them",
              len(kt) == 10 and all(abs(a - (b - 0.03)) <= 0.05 for a, b in zip(kt, keys_t)),
              f"{len(kt)} keys: {[round(t, 2) for t in kt]}")
        pop = [e for e in ev if e["type"] == "pop"]
        check("ui_events: a toast appears once and says how long it stays",
              len(pop) == 1 and abs(pop[0]["t"] - 4.0) < 0.07 and abs(pop[0].get("len", 0) - 1.2) < 0.15, str(pop))
        wo = [e for e in ev if e["type"] == "whoosh"]
        check("ui_events: a scroll is one event with its length", len(wo) == 1 and abs(wo[0]["t"] - 6.0) < 0.1
              and 0.6 <= wo[0].get("len", 0) <= 1.0, str(wo))
        cl = [e for e in ev if e["type"] == "click"]
        wi = [e for e in ev if e["type"] == "wipe"]
        check("ui_events: one click, one window switch, no echoes of the switch in other regions",
              len(cl) == 1 and abs(cl[0]["t"] - 7.5) < 0.07 and len(wi) == 1 and abs(wi[0]["t"] - 8.3) < 0.07
              and not [e for e in ev if e["roi"] != "screen" and 8.1 <= e["t"] <= 8.7], f"{cl} {wi}")
        r, ok = sh([PY, S / "from_cues.py", root / "ui" / "events.json", "--video", scr, "--ui", "library",
                    "--out", root / "ui_cues.json"], env2)
        uc = json.loads((root / "ui_cues.json").read_text(encoding="utf-8")) if ok and (root / "ui_cues.json").exists() else {"cues": []}
        sl = [c for c in uc["cues"] if c.get("slice")]
        check("ui_events -> from_cues: the keys become real keystrokes sliced from the pack's typing take",
              len(sl) == 10 and all("typing_keyboard-typing-1" in c["file"] for c in sl), f"{len(sl)} slices")

        # 15g2 round 3: the time range may stand anywhere, a toggle region sounds on the way out too
        r, ok = sh([PY, S / "ui_events.py", scr, "--out", root / "ui2", "--roi", "input=40,300,560,40@0-9:typing",
                    "--roi", "toast=440,20,180,60:toggle"], env2)
        ev2 = json.loads((root / "ui2" / "events.json").read_text(encoding="utf-8")) if ok and (root / "ui2" / "events.json").exists() else []
        kt2 = [e for e in ev2 if e["type"] == "key"]
        off2 = [e for e in ev2 if e["type"] == "click" and "off" in e["roi"]]
        check("ui_events: `box@0-9:typing` is the same as `box:typing@0-9`; a toggle region adds the disappearance",
              ok and len(kt2) == 10 and len(off2) == 1 and abs(off2[0]["t"] - 5.2) < 0.2, f"{len(kt2)} keys, off {off2}")

        # 15g3 clean single hits: a knock that dies away is clean, a double knock 'tu-dum' is not
        sys.path.insert(0, str(S))
        from common import clean_hits
        knock = root / "clean" / "knock.wav"
        dbl = root / "clean" / "double.wav"
        (root / "clean").mkdir(parents=True, exist_ok=True)
        one = "exp(-40*(t-0.1))*sin(2*PI*180*(t-0.1))*gte(t,0.1)"
        two = one + "+exp(-40*(t-0.18))*sin(2*PI*180*(t-0.18))*gte(t,0.18)"
        ff(["-f", "lavfi", "-i", f"aevalsrc='{one}':d=0.8:s=48000", "-ac", "2", knock])
        ff(["-f", "lavfi", "-i", f"aevalsrc='{two}':d=0.8:s=48000", "-ac", "2", dbl])
        h1, _ = clean_hits(str(knock))
        h2, _ = clean_hits(str(dbl))
        check("clean_hits: a knock that dies away is one clean hit; the first of a double knock 80 ms apart is not",
              len(h1) == 1 and h1[0]["clean"] and len(h2) >= 1 and h2[0]["clean"] is False,
              f"single {h1[:1]}, double {[(h['t'], h['clean']) for h in h2[:3]]}")

        # 15g4 fuse, typing stretch, the reason for the ui choice, a bank named by ids
        ev_f = [{"t": 1.0, "type": "pop"}, {"t": 1.012, "type": "pop"}, {"t": 2.0, "type": "pop"},
                {"t": 5.0, "type": "bead"}]
        (root / "fuse.json").write_text(json.dumps(ev_f), encoding="utf-8")
        r, ok = sh([PY, S / "from_cues.py", root / "fuse.json", "--out", root / "fuse_cues.json", "--no-check",
                    "--kind", "bead=key"], env)
        fc = json.loads((root / "fuse_cues.json").read_text(encoding="utf-8")) if ok else {"cues": []}
        pops_ = [c for c in fc["cues"] if c["t"] < 2.5]
        check("from_cues: 12 ms twins are one sound, and a kind mapped to `key` by us is no interface (ui: auto -> library)",
              ok and len(pops_) == 2 and "ui: auto -> library" in r.stdout,
              f"{len(pops_)} pops; " + ([l for l in r.stdout.splitlines() if l.startswith("ui:")] or [""])[0][:60])
        (root / "stretch.json").write_text(json.dumps([{"t": 3.0, "type": "typing", "len": 1.0, "n": 8}]), encoding="utf-8")
        r, ok = sh([PY, S / "from_cues.py", root / "stretch.json", "--out", root / "stretch_cues.json", "--no-check"], env)
        sc_ = json.loads((root / "stretch_cues.json").read_text(encoding="utf-8")) if ok else {"cues": []}
        keys_ = [c for c in sc_["cues"] if c.get("slice")]
        check("from_cues: a typing stretch of 8 characters becomes 8 real keystrokes inside its second",
              ok and len(keys_) == 8 and all(2.9 <= c["t"] <= 4.1 for c in keys_), f"{len(keys_)} keys")
        r, ok = sh([PY, S / "search.py", "--query", "Пластик", "--json"], env)
        try:
            pid = json.loads(r.stdout)[0]["id"]
        except (ValueError, IndexError, KeyError):
            pid = None
        r, ok = sh([PY, S / "from_cues.py", root / "fuse.json", "--out", root / "bank_cues.json", "--no-check",
                    "--kind", f"bead=slices:{pid}", "--only", "bead"], env)
        bc2 = json.loads((root / "bank_cues.json").read_text(encoding="utf-8")) if ok else {"cues": []}
        check("from_cues --kind NAME=slices:ID: the cue is a cut of that sound with its own slice",
              pid is not None and ok and len(bc2["cues"]) == 1 and bc2["cues"][0].get("slice")
              and bc2["cues"][0].get("same_source"), str(bc2["cues"])[:120])

        # 15h unknown kinds mapped from the command line, one physical source, a sheet edited by script,
        # a critique that knows how many declared events stayed silent
        ev_u = [{"t": 0.5, "type": "bead"}, {"t": 0.9, "type": "soft"}, {"t": 1.3, "type": "zap"},
                {"t": 2.0, "type": "hit"}, {"t": 3.0, "type": "hit"}]
        (root / "unk.json").write_text(json.dumps(ev_u), encoding="utf-8")
        r, ok = sh([PY, S / "from_cues.py", root / "unk.json", "--video", vid, "--out", root / "unk_bare.json"], env)
        bare = json.loads((root / "unk_bare.json").read_text(encoding="utf-8")) if ok else {"_draft": {}}
        check("unknown kinds stay silent and the report says how to map them without a file",
              ok and sum(bare["_draft"].get("unmapped", {}).values()) == 3 and "--kind" in r.stdout,
              str(bare["_draft"].get("unmapped")))
        r, ok = sh([PY, S / "from_cues.py", root / "unk.json", "--video", vid, "--out", root / "unk_map.json",
                    "--kind", "bead=click", "--kind", "soft=role:click,max_dur=0.3,onsets_max=1",
                    "--map", '{"zap": "glitch"}'], env)
        mapped = json.loads((root / "unk_map.json").read_text(encoding="utf-8")) if ok else {"_draft": {}}
        check("--kind and an inline --map map the unknown kinds (declared 5, voiced 5)",
              ok and mapped["_draft"].get("declared") == 5 and mapped["_draft"].get("voiced") == 5
              and not mapped["_draft"].get("unmapped"), str(mapped["_draft"].get("unmapped")))
        (root / "ball.json").write_text(json.dumps([{"t": 0.4 + 0.5 * k, "type": "thump"} for k in range(6)]),
                                        encoding="utf-8")
        r, ok = sh([PY, S / "from_cues.py", root / "ball.json", "--video", vid, "--out", root / "ball_one.json",
                    "--one-source", "thump"], env)
        bc = json.loads((root / "ball_one.json").read_text(encoding="utf-8")) if ok else {"cues": []}
        ids = [c.get("id") for c in bc["cues"]]
        check("--one-source: the takes of ONE recording family take turns (flagged same_source)",
              ok and len(ids) == 6 and all(c.get("same_source") for c in bc["cues"]) and 1 < len(set(ids)) <= 6,
              str(ids))
        # silent events pull the coverage axis down even without picture moments
        ev_s = [{"t": 0.5 + 0.4 * k, "type": "hit"} for k in range(4)] + \
               [{"t": 0.6 + 0.3 * k, "type": "bead"} for k in range(8)]
        (root / "silent.json").write_text(json.dumps(ev_s), encoding="utf-8")
        r, ok = sh([PY, S / "from_cues.py", root / "silent.json", "--video", vid, "--out", root / "silent_cues.json"], env)
        r, ok2 = sh([PY, S / "mix.py", root / "silent_cues.json", "--out", root / "silent" / "s.mp4"], env)
        r, _ = sh([PY, S / "critique.py", root / "silent" / "s_resolved_cues.json", root / "silent" / "s_sfx_track.wav"],
                  env, ok_codes=(0, 1))
        cov = next((l for l in r.stdout.splitlines() if l.startswith("| coverage")), "")
        check("critique: 8 of 12 declared events silent is a low coverage, with the kind named",
              ok and ok2 and "declared events are silent" in cov and "bead" in r.stdout, cov[:120])
        # a sheet edited by script
        sh_p = root / "edit.json"
        r1, _ = sh([PY, S / "sheet.py", "new", sh_p, "--video", vid])
        r2, _ = sh([PY, S / "sheet.py", "add", sh_p, '{"t": 1.0, "pick": {"role": "whoosh"}, "label": "a"}',
                    '{"t": 2.0, "pick": {"role": "hit"}, "label": "b"}'])
        r3, _ = sh([PY, S / "sheet.py", "set", sh_p, "--at", "2.0", "gain_db=-3", "pick.max_dur=1.0"])
        r4, _ = sh([PY, S / "sheet.py", "shift", sh_p, "--by", "0.25", "--role", "whoosh"])
        r5, _ = sh([PY, S / "sheet.py", "gain", sh_p, "--db", "-2", "--between", "0", "1.5"])
        ed = json.loads(sh_p.read_text(encoding="utf-8"))
        a_, b_ = ed["cues"][0], ed["cues"][1]
        check("sheet.py adds, sets (also into pick), shifts and gains cues",
              len(ed["cues"]) == 2 and abs(a_["t"] - 1.25) < 1e-6 and a_.get("gain_db") == -2.0
              and b_.get("gain_db") == -3 and b_["pick"].get("max_dur") == 1.0, str(ed["cues"]))
        r6, _ = sh([PY, S / "sheet.py", "drop", sh_p, "--label", "a"])
        ed = json.loads(sh_p.read_text(encoding="utf-8"))
        r7, ok7 = sh([PY, S / "mix.py", sh_p, "--out", root / "edit" / "e.mp4"], env)
        check("sheet.py drop leaves a sheet that mixes", len(ed["cues"]) == 1 and ok7, r7.stderr[-80:] if not ok7 else "")
        r, ok = sh([PY, S / "search.py", "--role", "hit", "--says", "punchy|zzzz", "--limit", "3"], env)
        check("search --says takes alternatives with |", ok and "Hit" in r.stdout, r.stdout[:60])

        # 15i a list in design time, a render re-timed after it: the time map comes from the synthesized onsets
        # (and, when the project keeps them, from its own anchors); a speech stem keys the voice-safe ducking
        proj3 = root / "proj3"
        st3 = proj3 / "assets" / "audio" / "stems"
        st3.mkdir(parents=True)
        (proj3 / "index.html").write_text("<html></html>", encoding="utf-8")
        design = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]
        actual = [1.3, 2.3, 3.3, 4.6, 5.6, 6.6, 7.6]
        ff(["-f", "lavfi", "-i", "sine=f=220:d=9:r=48000", "-af", "volume=0.05", "-ac", "1", st3 / "music.wav"])
        click_stem(st3 / "sfx.wav", actual, dur=9.0)
        ff(["-f", "lavfi", "-i", "color=c=0x203040:s=320x180:r=30:d=9", "-i", st3 / "music.wav", "-i", st3 / "sfx.wav",
            "-filter_complex", "[1:a][2:a]amix=inputs=2:normalize=0,aformat=sample_rates=48000[a]",
            "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "9",
            proj3 / "render.mp4"])
        (proj3 / "cues.json").write_text(json.dumps([{"t": t_, "type": "click"} for t_ in design]), encoding="utf-8")
        r, ok = sh([PY, S / "from_cues.py", proj3 / "cues.json", "--video", proj3 / "render.mp4", "--project", proj3,
                    "--out", root / "warp.json"], env)
        wj = json.loads((root / "warp.json").read_text(encoding="utf-8")) if ok else {"cues": [], "_draft": {}}
        tt = sorted(c["t"] for c in wj["cues"])
        check("time map: a list in design time is moved onto the re-timed render (onsets of the stems)",
              ok and len(tt) == 7 and all(abs(x - y) < 0.07 for x, y in zip(tt, actual)) and "time map" in r.stdout,
              f"{tt}")
        (proj3 / "src").mkdir()
        (proj3 / "src" / "timing.js").write_text(
            "export const TIMING = " + json.dumps({"anchors": [[0, 0], [0.5, 0.8], [3, 3.3], [3.5, 4.1], [4, 4.6],
                                                               [7, 7.6]]}) + ";\n", encoding="utf-8")
        r, ok = sh([PY, S / "from_cues.py", proj3 / "cues.json", "--video", proj3 / "render.mp4", "--project", proj3,
                    "--out", root / "warp2.json"], env)
        w2 = json.loads((root / "warp2.json").read_text(encoding="utf-8")) if ok else {"cues": []}
        t2 = sorted(c["t"] for c in w2["cues"])
        check("time map: the anchors the project keeps (src/timing.js) are found and used",
              ok and "anchors in src/timing.js" in r.stdout and all(abs(x - y) < 0.03 for x, y in zip(t2, actual)),
              f"{t2}")
        # a speech stem in the base keys the voice-safe ducking (music under a phrase ducks nothing)
        ff(["-f", "lavfi", "-i", "anoisesrc=d=9:c=pink:r=48000,volume=0.25", "-ac", "1", proj3 / "voice.wav"])
        (root / "vk.json").write_text(json.dumps({
            "video": str(proj3 / "render.mp4"), "keep_audio": "auto",
            "base_audio": [str(proj3 / "voice.wav").replace("\\", "/"), str(st3 / "music.wav").replace("\\", "/")],
            "cues": [{"t": 2.0, "pick": {"role": "hit"}}, {"t": 5.0, "pick": {"role": "hit"}}]}), encoding="utf-8")
        r, ok = sh([PY, S / "mix.py", root / "vk.json", "--out", root / "vk" / "v.mp4", "--voice-safe"], env)
        vkj = json.loads((root / "vk" / "v_resolved_cues.json").read_text(encoding="utf-8")) if ok else {}
        check("voice-safe is keyed by the speech stem and says how much it ducked",
              ok and vkj.get("voice_key") is True and "SFX under speech" in r.stdout, r.stdout[-160:])


        # 15j round 4 (seven fresh agents on 0.10.0): every finding that cost them time is a check here
        import re as _re
        r4 = root / "r4"
        r4.mkdir(exist_ok=True)

        def wav_mono(path, samples, rate=48000):
            with wave.open(str(path), "wb") as w_:
                w_.setnchannels(1)
                w_.setsampwidth(2)
                w_.setframerate(rate)
                w_.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, v)) * 30000)) for v in samples))

        def max_db(path, af=None):
            cmd = ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af", (af + "," if af else "") + "volumedetect",
                   "-f", "null", "-"]
            m_ = _re.search(r"max_volume:\s*(-?[\d.]+) dB", subprocess.run(cmd, capture_output=True, text=True).stderr)
            return float(m_.group(1)) if m_ else None

        # (a) ffmpeg's own mono -> stereo takes 3 dB off: every mono file of the skill went through it
        from common import stereo_fmt
        mono = r4 / "mono.wav"
        ff(["-f", "lavfi", "-i", "sine=f=440:d=1:r=48000,volume=-6dB", "-ac", "1", mono])
        p_m, p_s = max_db(mono), max_db(mono, stereo_fmt(mono))
        check("a mono file made stereo keeps its level (ffmpeg's own upmix takes 3 dB off)",
              p_m is not None and p_s is not None and abs(p_m - p_s) < 0.3, f"mono {p_m} dB, stereo {p_s} dB")

        # (b) a mono stem that IS the whole render cancels to silence (it left -10 dB of itself before)
        stem_m = r4 / "impacts.wav"
        click_stem(stem_m, [1.0, 2.5, 4.0, 5.5], dur=8.0)
        ff(["-f", "lavfi", "-i", "color=c=0x202020:s=320x180:r=30:d=8", "-i", stem_m, "-map", "0:v", "-map", "1:a",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-t", "8", r4 / "only_layer.mp4"])
        r, ok = sh([PY, S / "unbake.py", r4 / "only_layer.mp4", "--synth", stem_m, "--out", r4 / "base_layer.wav"], env)
        check("unbake: a mono stem that is the whole render cancels to silence", ok and '"silent": true' in r.stdout,
              (r.stdout.strip().splitlines() or [""])[-1][:100])
        import unbake as _ub
        pres_in, pres_out = _ub.presence(r4 / "only_layer.mp4", [stem_m]), _ub.presence(vid, [stem_m])
        check("unbake.presence: a synthesized layer is in the audio it was mixed into and not in another",
              pres_in is not None and pres_in > 0.5 and (pres_out is None or abs(pres_out) < 0.15),
              f"in {pres_in}, elsewhere {pres_out}")

        # (c) a project folder gives its own cue list first (the decoy script is not run)
        proj5 = r4 / "proj5"
        (proj5 / "docs").mkdir(parents=True)
        (proj5 / "scripts").mkdir()
        (proj5 / "index.html").write_text("<html></html>", encoding="utf-8")
        (proj5 / "docs" / "cues.json").write_text(json.dumps([{"t": 1.0, "type": "whoosh"}, {"t": 3.0, "type": "hit"},
                                                              {"t": 5.0, "type": "whoosh"}]), encoding="utf-8")
        (proj5 / "scripts" / "audio.cjs").write_text(
            "const SR=48000; function whoosh(t){} whoosh(1); whoosh(2); require('fs').writeFileSync('x.wav', Buffer.alloc(8));\n",
            encoding="utf-8")
        r, ok = sh([PY, S / "from_cues.py", proj5, "--video", vid, "--out", r4 / "proj5_cues.json", "--no-check"], env)
        p5 = json.loads((r4 / "proj5_cues.json").read_text(encoding="utf-8")) if ok and (r4 / "proj5_cues.json").exists() else {"cues": []}
        check("from_cues FOLDER: the project's own cue list is the source, not its synthesizer script",
              ok and "cue list: docs/cues.json" in r.stdout and len(p5["cues"]) == 3, r.stdout[:100].replace("\n", " "))

        # (d) a file with a BOM (Windows PowerShell 5.1 writes one), by file and by stdin
        bom_events = json.dumps([{"t": 1.0, "type": "whoosh"}, {"t": 2.5, "type": "hit"}]).encode("utf-8")
        (r4 / "bom.json").write_bytes(b"\xef\xbb\xbf" + bom_events)
        r, ok = sh([PY, S / "from_cues.py", r4 / "bom.json", "--video", vid, "--out", r4 / "bom_cues.json", "--no-check"], env)
        rs = subprocess.run([PY, str(S / "from_cues.py"), "-", "--video", str(vid), "--out", str(r4 / "bom2_cues.json"),
                             "--no-check"], input=b"\xef\xbb\xbf" + bom_events, capture_output=True, env=env)
        check("a JSON with a BOM is read, from a file and from stdin", ok and rs.returncode == 0
              and (r4 / "bom2_cues.json").exists(), (rs.stderr or b"")[-80:].decode("utf-8", "replace"))

        # (e) animated typing written as `click`: eight or more in a row go to the real keyboard
        evt = [{"t": 2.0 + 0.0625 * i, "type": "click", "g": 0.2} for i in range(14)] + [{"t": 5.0, "type": "click"}]
        (r4 / "typing_clicks.json").write_text(json.dumps(evt), encoding="utf-8")
        r, ok = sh([PY, S / "from_cues.py", r4 / "typing_clicks.json", "--video", vid, "--out", r4 / "typing_cues.json",
                    "--no-check"], env)
        tc = json.loads((r4 / "typing_cues.json").read_text(encoding="utf-8")) if ok and (r4 / "typing_cues.json").exists() else {"cues": []}
        keys_ = [c for c in tc["cues"] if c.get("slice")]
        last_ = [c for c in tc["cues"] if abs(c["t"] - 5.0) < 0.05]
        check("from_cues: a row of 14 `click` events 62 ms apart is typing (real keys), a lone click is not",
              ok and "typing:" in r.stdout and len(keys_) >= 8 and all(c.get("same_source") for c in keys_)
              and last_ and not last_[0].get("slice"), f"{len(keys_)} keys, lone {last_[:1]}")

        # (f) retime: a whoosh whose declared time is its centre is not dragged onto a pop that is louder
        proj6 = r4 / "proj6"
        st6 = proj6 / "assets" / "audio" / "stems"
        st6.mkdir(parents=True)
        (proj6 / "index.html").write_text("<html></html>", encoding="utf-8")
        rng_ = random.Random(5)
        n6 = 48000 * 10
        buf = [0.0] * n6
        for i in range(int(1.4 * 48000), int(2.6 * 48000)):                      # a whoosh centred at 2.0 s
            tt_ = i / 48000.0
            buf[i] += 0.25 * math.exp(-((tt_ - 2.0) / 0.18) ** 2) * (rng_.random() * 2 - 1)
        for i in range(int(0.07 * 48000)):                                       # a loud pop at 2.6 s
            buf[int(2.6 * 48000) + i] += 0.9 * math.exp(-i / (0.012 * 48000)) * math.sin(2 * math.pi * 600 * i / 48000)
        for i in range(int(6.0 * 48000), int(6.5 * 48000)):                       # a swell that rises to 6.5 s ...
            tt_ = i / 48000.0
            buf[i] += 0.5 * ((tt_ - 6.0) / 0.5) ** 2 * (rng_.random() * 2 - 1)
        for i in range(int(0.05 * 48000)):                                       # ... and lands on a click
            buf[int(6.5 * 48000) + i] += 0.9 * math.exp(-i / (0.006 * 48000)) * (rng_.random() * 2 - 1)
        wav_mono(st6 / "sfx.wav", buf)
        ff(["-f", "lavfi", "-i", "sine=f=220:d=10:r=48000,volume=0.05", "-ac", "1", st6 / "music.wav"])
        ff(["-f", "lavfi", "-i", "color=c=0x203040:s=320x180:r=30:d=10", "-i", st6 / "music.wav", "-i", st6 / "sfx.wav",
            "-filter_complex", "[1:a][2:a]amix=inputs=2:normalize=0,aformat=sample_rates=48000[a]", "-map", "0:v",
            "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "10", proj6 / "render.mp4"])
        (proj6 / "cues.json").write_text(json.dumps([{"t": 2.0, "type": "whoosh", "len": 0.5},
                                                      {"t": 2.6, "type": "pop"},
                                                      {"t": 6.0, "type": "whoosh", "len": 0.5},
                                                      {"t": 6.5, "type": "pop"}]), encoding="utf-8")
        r, ok = sh([PY, S / "from_cues.py", proj6 / "cues.json", "--video", proj6 / "render.mp4", "--project", proj6,
                    "--out", r4 / "retime.json", "--no-check"], env)
        rt = json.loads((r4 / "retime.json").read_text(encoding="utf-8")) if ok and (r4 / "retime.json").exists() else {"cues": []}
        wh = sorted((c["t"] for c in rt["cues"] if str(c.get("label", "")).startswith("whoosh")))
        check("retime: the whoosh centred at 2.0 s stays (a louder pop is not its peak); the swell that rises to its "
              "click moves to 6.5 s", ok and len(wh) == 2 and abs(wh[0] - 2.0) < 0.05 and abs(wh[1] - 6.5) < 0.06
              and "NOT moved" in r.stdout, f"{wh}  " + " | ".join(
                  l for l in r.stdout.splitlines() if l.startswith("retime"))[:160])

        # (g) the perceived level inside a role: a thin swipe (a spike over nothing) is lifted, the others stay
        thin = r4 / "thin_swipe.wav"
        rng2 = random.Random(9)
        sm = [0.008 * (rng2.random() * 2 - 1) for _ in range(int(0.9 * 48000))]
        for i in range(int(0.003 * 48000)):
            sm[int(0.1 * 48000) + i] += 0.9 * (rng2.random() * 2 - 1)
        wav_mono(thin, sm)
        wl = lib / "Whooshes"
        lev = {"video": str(vid), "keep_audio": "no", "cues": [
            {"t": 1.0, "file": str(wl / "Whoosh 1.wav"), "role": "whoosh"},
            {"t": 2.5, "file": str(wl / "Whoosh 2.wav"), "role": "whoosh"},
            {"t": 4.0, "file": str(thin), "role": "whoosh", "label": "thin"},
            {"t": 5.5, "file": str(wl / "Whoosh 3.wav"), "role": "whoosh"}]}
        (r4 / "lev.json").write_text(json.dumps(lev), encoding="utf-8")
        r, ok = sh([PY, S / "mix.py", r4 / "lev.json", "--out", r4 / "lev" / "l.mp4"], env)
        lj = json.loads((r4 / "lev" / "l_resolved_cues.json").read_text(encoding="utf-8")) if ok else {"cues": []}
        th = next((c for c in lj["cues"] if c.get("label") == "thin"), {})
        others = [c["loud_after_db"] for c in lj["cues"] if c.get("label") != "thin" and c.get("loud_after_db") is not None]
        r, ok2 = sh([PY, S / "mix.py", r4 / "lev.json", "--out", r4 / "lev0" / "l.mp4", "--no-level-roles"], env)
        lj0 = json.loads((r4 / "lev0" / "l_resolved_cues.json").read_text(encoding="utf-8")) if ok2 else {"cues": []}
        th0 = next((c for c in lj0["cues"] if c.get("label") == "thin"), {})
        check("mix: a thin swipe is lifted to the perceived level of its role (and left alone with --no-level-roles)",
              ok and ok2 and th.get("level_adj_db", 0) >= 3.0 and th0.get("level_adj_db", 0) == 0
              and others and th.get("loud_after_db") is not None
              and abs(th["loud_after_db"] - sorted(others)[len(others) // 2]) < abs(th0["loud_after_db"] - sorted(others)[len(others) // 2]),
              f"adj {th.get('level_adj_db')} dB, loud {th.get('loud_after_db')} vs {others}")

        # (h) the audible start of a sound with a silent lead-in lands on the moment
        lead = r4 / "lead_in.wav"
        rng3 = random.Random(2)
        wav_mono(lead, [0.0] * int(0.12 * 48000) + [0.8 * (rng3.random() * 2 - 1) * math.exp(-i / 400.0) for i in range(2000)])
        (r4 / "lead.json").write_text(json.dumps({"video": str(vid), "keep_audio": "no", "cues": [
            {"t": 3.0, "file": str(lead), "role": "click", "label": "lead"}]}), encoding="utf-8")
        r, ok = sh([PY, S / "mix.py", r4 / "lead.json", "--out", r4 / "lead" / "l.mp4"], env)
        ld = json.loads((r4 / "lead" / "l_resolved_cues.json").read_text(encoding="utf-8")) if ok else {"cues": []}
        sh_ms = (ld["cues"][0].get("onset_shift_ms") if ld["cues"] else None)
        check("mix: a start-anchored sound with 120 ms of silence in front is placed by its audible start",
              ok and sh_ms is not None and 100 <= sh_ms <= 125, f"shift {sh_ms} ms")

        # (i) pan: a cue panned hard left is left only
        (r4 / "pan.json").write_text(json.dumps({"video": str(vid), "keep_audio": "no", "cues": [
            {"t": 2.0, "file": str(lib / "Hits and impacts" / "Hit 1.wav"), "role": "hit", "pan": -1.0}]}),
            encoding="utf-8")
        r, ok = sh([PY, S / "mix.py", r4 / "pan.json", "--out", r4 / "pan" / "p.mp4"], env)
        trk = r4 / "pan" / "p_sfx_track.wav"
        left, right = (max_db(trk, "pan=mono|c0=c0"), max_db(trk, "pan=mono|c0=c1")) if ok else (None, None)
        check("mix: pan -1 puts the sound in the left channel only", ok and left is not None and right is not None
              and left - right >= 20.0, f"left {left} dB, right {right} dB")

        # (j) a pitched sound over a tonal score is retuned onto its notes
        ff(["-f", "lavfi", "-i", "aevalsrc='0.3*sin(2*PI*220*t)+0.3*sin(2*PI*261.63*t)+0.3*sin(2*PI*329.63*t)':d=8:s=48000",
            "-ac", "1", r4 / "chord_am.wav"])
        ff(["-f", "lavfi", "-i", "aevalsrc='0.6*exp(-6*t)*sin(2*PI*466.16*t)+0.2*exp(-6*t)*sin(2*PI*932.3*t)':d=0.8:s=48000",
            "-ac", "1", r4 / "pop_asharp.wav"])
        (r4 / "tonal.json").write_text(json.dumps({"video": str(vid), "keep_audio": "no", "cues": [
            {"t": 2.0, "file": str(r4 / "pop_asharp.wav"), "role": "pop"}]}), encoding="utf-8")
        r, ok = sh([PY, S / "mix.py", r4 / "tonal.json", "--out", r4 / "tonal" / "t.mp4", "--music-ref",
                    r4 / "chord_am.wav"], env)
        tj = json.loads((r4 / "tonal" / "t_resolved_cues.json").read_text(encoding="utf-8")) if ok else {"cues": []}
        pt = tj["cues"][0].get("pitch") if tj["cues"] else None
        check("mix: an A# pop over an A minor score is retuned a semitone down", ok and pt is not None
              and abs(pt + 1.0) < 0.15 and "tonal fit" in r.stdout, f"pitch {pt}")

        # (k) levels.py: the event that came out 6 dB quieter than the author's is found, with the batch to fix it
        def beeps(path, levels_db, times, dur=5.0):
            buf_ = [0.0] * int(48000 * dur)
            for t_, l_ in zip(times, levels_db):
                a_ = 10 ** (l_ / 20.0)
                for i in range(int(0.15 * 48000)):
                    buf_[int(t_ * 48000) + i] += a_ * math.sin(2 * math.pi * 1000 * i / 48000) * min(1.0, i / 200.0)
            wav_mono(path, buf_)
        tms = [1.0, 2.0, 3.0, 4.0]
        beeps(r4 / "ref_layer.wav", [-20, -20, -30, -20], tms)
        beeps(r4 / "new_layer.wav", [-20, -26, -30, -20], tms)
        (r4 / "lv_resolved.json").write_text(json.dumps({"cues": [{"t": t_, "label": "tick", "role": "click"} for t_ in tms]}),
                                             encoding="utf-8")
        r, ok = sh([PY, S / "levels.py", r4 / "lv_resolved.json", r4 / "new_layer.wav", "--reference",
                    r4 / "ref_layer.wav", "--json", r4 / "lv_edits.json"], env)
        ops = json.loads((r4 / "lv_edits.json").read_text(encoding="utf-8")) if ok and (r4 / "lv_edits.json").exists() else []
        hit = [o for o in ops if abs(o.get("at", -1) - 2.0) < 0.05]
        check("levels.py: the beep that is 6 dB under the author's balance gets a +6 dB edit, the others none",
              ok and len(ops) == 1 and hit and 4.5 <= hit[0]["gain"] <= 7.0, str(ops))

        # (l) ui_events: a timer redrawing every second is not scrolling; --check draws any number of times
        ff(["-f", "lavfi", "-i", "color=c=0x20222a:s=640x360:r=30:d=12", "-f", "lavfi", "-i",
            "color=c=white:s=260x14:r=30:d=12", "-filter_complex",
            "[0:v][1:v]overlay=x=60:y='60+mod(t*300,150)':enable='lt(mod(t,1),0.45)'",
            "-pix_fmt", "yuv420p", "-c:v", "libx264", "-crf", "12", r4 / "timer.mp4"])
        r, ok = sh([PY, S / "ui_events.py", r4 / "timer.mp4", "--out", r4 / "timer", "--roi", "list=40,40,300,240:scroll"], env)
        r2_, ok2 = sh([PY, S / "ui_events.py", r4 / "timer.mp4", "--out", r4 / "timer2", "--roi",
                       "list=40,40,300,240:scroll", "--keep-periodic"], env)
        ev_t = json.loads((r4 / "timer" / "events.json").read_text(encoding="utf-8")) if ok else [1]
        ev_t2 = json.loads((r4 / "timer2" / "events.json").read_text(encoding="utf-8")) if ok2 else []
        check("ui_events: a train of evenly spaced redraws is dropped from scroll (--keep-periodic keeps it)",
              ok and ok2 and len(ev_t) == 0 and len(ev_t2) >= 6 and "even rhythm" in r.stdout, f"{len(ev_t)} / {len(ev_t2)}")
        r, ok = sh([PY, S / "ui_events.py", scr, "--out", r4 / "chk", "--roi", "input=40,300,560,40:typing",
                    "--check", "1.5,2.5,3.2"], env)
        check("ui_events --check with three times draws checkpoints.png (the last row is padded)",
              ok and (r4 / "chk" / "checkpoints.png").exists(), r.stdout[-120:].replace("\n", " "))

        # (m) find_moments --from/--to and look.py on an event list
        r, ok = sh([PY, S / "find_moments.py", vid, "--out", r4 / "fm", "--from", "1.5", "--to", "5.5"], env)
        fm = json.loads((r4 / "fm" / "moments.json").read_text(encoding="utf-8"))["moments"] if ok and (r4 / "fm" / "moments.json").exists() else []
        check("find_moments --from/--to looks only there (the cuts at 2 s and 5 s, nothing else)",
              ok and fm and all(1.4 <= m["t"] <= 5.6 for m in fm) and any(abs(m["t"] - 2.0) < 0.2 for m in fm),
              str([round(m["t"], 2) for m in fm][:8]))
        r, ok = sh([PY, S / "look.py", scr, "--moments", root / "ui" / "events.json", "--out", r4 / "evsheet.png"], env)
        check("look.py --moments on an event list draws a before/after sheet", ok and
              any(p_.name.startswith("evsheet") for p_ in r4.glob("evsheet*.png")), r.stdout[-100:].replace("\n", " "))

        # (n) sheet.py: a moment by kind and time is routed like a list; a cue named by id has its role
        shp = r4 / "ev_sheet.json"
        sh([PY, S / "sheet.py", "new", shp, "--video", vid])
        r, ok = sh([PY, S / "sheet.py", "add", shp, "--event", "key@2.0", "--event", "whoosh@3.0:0.8"], env)
        sj = json.loads(shp.read_text(encoding="utf-8")) if shp.exists() else {"cues": []}
        check("sheet.py add --event KIND@T routes a moment the way from_cues does (key = a real keystroke slice)",
              ok and len(sj["cues"]) == 2 and any(c.get("slice") for c in sj["cues"]), r.stdout[-100:].replace("\n", " "))

        # (o) the speech map of a film with a score is read from the voice stem the sheet names
        r, ok = sh([PY, S / "speech_map.py", proj3 / "render.mp4", "--cues", root / "vk" / "v_resolved_cues.json"], env)
        check("speech_map: with a resolved sheet it reads the voice stem, not the film's own music-covered audio",
              ok and "voice stem" in r.stdout, r.stdout[:120].replace("\n", " "))

        # (p) 0.11.1: the beat grid is checked against the kicks, a mono playback is checked, the critique lists the
        #     moments to listen to
        import re as re_
        import beats as B_
        r, ok = sh([PY, S / "beats.py", clk, "--out", r4 / "kb.json", "--plot", r4 / "kb.png"], env)
        kb = json.loads((r4 / "kb.json").read_text(encoding="utf-8")) if ok and (r4 / "kb.json").exists() else {}
        kc = kb.get("kick_check") or {}
        check("beats.py checks its grid against the kicks (low band) and draws it",
              ok and kc.get("checked") and kc.get("within40", 0) >= 0.8 and "kick check:" in r.stdout
              and (r4 / "kb.png").exists() and (r4 / "kb.png").stat().st_size > 2000, str(kc))
        kick_t = [round(0.13 + 0.5 * k, 3) for k in range(40)]
        late = [round(t_ + 0.22, 3) for t_ in kick_t]            # a grid 0.22 s late: the classic tracker failure
        g1 = {"tempo": 120.0, "usable": True, "beats": late, "downbeats": late[::4], "half_beats": []}
        B_.check_grid(g1, kick_t)
        k1 = g1.get("kick_check") or {}
        check("a grid 0.22 s beside the kicks is moved onto them, and says by how much",
              g1["usable"] and abs(k1.get("shifted_ms", 0) + 220) <= 15 and k1.get("within40", 0) >= 0.9
              and max(abs(b_ - k_) for b_, k_ in zip(g1["beats"], kick_t)) <= 0.02, str(k1))
        rnd_ = random.Random(4)
        scatter = sorted(round(rnd_.uniform(0.0, 20.0), 3) for _ in range(60))
        g2 = {"tempo": 120.0, "usable": True, "beats": kick_t, "downbeats": [], "half_beats": []}
        B_.check_grid(g2, scatter)
        check("a grid that fits no kicks is marked unusable, so --snap-beats leaves the cues alone",
              g2["usable"] is False and g2.get("unusable_reason") == "kick check", str(g2.get("kick_check")))
        late_cuts = [{"t": round(0.33 + 0.5 * k, 3), "kind": "cut", "strength": 0.9, "pct": 0.9} for k in range(8)]
        (r4 / "late_cuts.json").write_text(json.dumps({"moments": late_cuts}), encoding="utf-8")
        r, ok = sh([PY, S / "beats.py", clk, "--suggest-offset", r4 / "late_cuts.json"], env)
        mo_ = re_.search(r"move the music (\d\.\d+) s later.*?(\d+)% -> (\d+)%", r.stdout)
        check("beats.py --suggest-offset: cuts 0.2 s after the beats -> move the music about 0.2 s later",
              ok and mo_ and abs(float(mo_.group(1)) - 0.2) <= 0.03 and int(mo_.group(3)) >= 90,
              [l for l in r.stdout.splitlines() if l.startswith("offset")][:1] and
              [l for l in r.stdout.splitlines() if l.startswith("offset")][0][:110])
        grid_ = [round(0.138 + 0.5 * k, 3) for k in range(30)]
        rnd2_ = random.Random(2)
        mo_rand = B_.music_offset(sorted(round(rnd2_.uniform(0, 14), 3) for _ in range(10)), grid_, 0.5)
        mo_real = B_.music_offset([round(0.33 + 0.5 * k, 3) for k in range(8)], grid_, 0.5)
        check("music offset: ten moves that follow no pulse get no suggestion; eight on a common offset get one",
              mo_rand and not mo_rand["significant"] and mo_real and mo_real["significant"]
              and abs(mo_real["shift_s"] - 0.192) <= 0.01, f"random {mo_rand}, real {mo_real}")

        ff(["-f", "lavfi", "-i", "anoisesrc=d=0.8:c=pink:r=48000:seed=7,highpass=f=300,afade=t=in:d=0.3,"
            "afade=t=out:st=0.4:d=0.4", "-af", "asplit[a][b];[b]volume=-1[bi];[a][bi]amerge=inputs=2", "-ac", "2",
            r4 / "inv.wav"])
        from common import analyse_sound
        inv_ = analyse_sound(r4 / "inv.wav") or {}
        check("a sound whose channels cancel is measured on its louder channel, not on a silent mono sum",
              inv_.get("mono_ref") in (0, 1) and inv_.get("mean_db", -120) > -40 and 0.15 < inv_.get("peak_time", 0) < 0.7
              and inv_.get("lr_corr", 0) < -0.9, str({k_: inv_.get(k_) for k_ in ("mono_ref", "mean_db", "peak_time", "lr_corr")}))
        (r4 / "mono.json").write_text(json.dumps({"duration": 6.0, "cues": [
            {"t": 1.0, "label": "inverted", "file": str(r4 / "inv.wav"), "role": "whoosh"},
            {"t": 3.0, "label": "plain", "file": str(lib / "Whooshes" / "Whoosh 1.wav"), "role": "whoosh"}]}), encoding="utf-8")
        r_fix, ok_fix = sh([PY, S / "mix.py", r4 / "mono.json", "--out", r4 / "mono_fix" / "m.mp4"], env)
        r_raw, ok_raw = sh([PY, S / "mix.py", r4 / "mono.json", "--out", r4 / "mono_raw" / "m.mp4", "--no-mono-fix"], env)
        res_fix, trk_fix = r4 / "mono_fix" / "m_resolved_cues.json", r4 / "mono_fix" / "m_sfx_track.wav"
        res_raw, trk_raw = r4 / "mono_raw" / "m_resolved_cues.json", r4 / "mono_raw" / "m_sfx_track.wav"
        mj_ = json.loads(res_fix.read_text(encoding="utf-8")) if ok_fix and res_fix.exists() else {"cues": []}
        flag_ = next((c_ for c_ in mj_["cues"] if c_["label"] == "inverted"), {}).get("mono")
        check("mix: a sound with channels in opposite phase plays its louder channel, and says so (--no-mono-fix keeps it)",
              ok_fix and ok_raw and flag_ is True and "mono: 1 sound(s)" in r_fix.stdout
              and "mono: 1 sound(s)" not in r_raw.stdout, f"flag {flag_}")
        v_fix, _ = sh([PY, S / "verify.py", res_fix, trk_fix], env, ok_codes=(0, 1))
        v_raw, _ = sh([PY, S / "verify.py", res_raw, trk_raw], env, ok_codes=(0, 1))
        check("verify: mono line - the fixed track loses nothing, the raw one names the cancelling sound (not 'missing')",
              "loses 0." in v_fix.stdout and "lose more than 6 dB" in v_raw.stdout and "MISSING" not in v_raw.stdout,
              ([l for l in v_raw.stdout.splitlines() if l.startswith("mono")] or ["no mono line"])[0][:110])
        c_fix, _ = sh([PY, S / "critique.py", res_fix, trk_fix, "--json"], env, ok_codes=(0, 1))
        c_raw, _ = sh([PY, S / "critique.py", res_raw, trk_raw, "--json"], env, ok_codes=(0, 1))
        try:
            j_fix = json.loads(c_fix.stdout.strip().splitlines()[-1])
            j_raw = json.loads(c_raw.stdout.strip().splitlines()[-1])
        except Exception:
            j_fix, j_raw = {"axes": {}, "problems": []}, {"axes": {}, "problems": []}
        check("critique: axis mono is 10 for the fixed render and names the sound for the raw one",
              j_fix["axes"].get("mono", 0) >= 9.5 and j_raw["axes"].get("mono", 10) < 9.0
              and any(p_.startswith("mono:") for p_ in j_raw["problems"]),
              f"fixed {j_fix['axes'].get('mono')}, raw {j_raw['axes'].get('mono')}")

        r, ok = sh([PY, S / "critique.py", resolved, wav, "--moments", root / "work" / "moments.json",
                    "--listen-out", r4 / "listen.wav"], env, ok_codes=(0, 1))
        items_ = [re_.match(r"^\s+\d\.\s+(\d+\.\d+)s", l_) for l_ in r.stdout.splitlines()]
        times_ = [float(m_.group(1)) for m_ in items_ if m_]
        lw_ = float(probe(r4 / "listen.wav", "format=duration") or 0) if (r4 / "listen.wav").exists() else 0.0
        check("critique lists up to 5 moments to listen to, 1.5 s apart, and cuts them into one wav",
              1 <= len(times_) <= 5 and "Listen to" in r.stdout and all(b_ - a_ >= 1.5 for a_, b_ in zip(times_, times_[1:]))
              and abs(lw_ - 3.4 * len(times_)) < 0.4, f"{len(times_)} moments {times_}, wav {lw_:.1f} s")

        # (q) 0.12.0: a film is set against a reference style in numbers (no scores), and the texture layer fills the
        #     holes of a film whose sound is only SFX
        import refstyle as RS_
        click_stem(r4 / "rs_track.wav", [0.5, 1.0, 1.5, 4.0, 4.15, 7.0], dur=8.0)
        ms_ = RS_.measure(str(r4 / "rs_track.wav"), with_lufs=False)
        check("refstyle: gestures, the longest gap and the first sound of a known track (6 events, 5 gestures)",
              abs(ms_.get("gest10", 0) - 6.25) <= 0.7 and abs(ms_.get("gap_max", 0) - 3.0) <= 0.3
              and abs(ms_.get("first_s", 9) - 0.5) <= 0.06, str(ms_))
        sty_ = {"name": "t", "n_refs": 5, "measures": {
            "gest10": {"median": 10.0, "p25": 9.0, "p75": 11.0, "min": 7.0, "max": 13.0, "n": 5},
            "gap_max": {"median": 2.5, "p25": 2.0, "p75": 2.8, "min": 1.5, "max": 3.5, "n": 5}}}
        rw_ = {r_["key"]: r_ for r_ in RS_.compare({"gest10": 6.25, "gap_max": 3.0}, sty_)}
        ri_ = {r_["key"]: r_ for r_ in RS_.compare({"gest10": 10.2, "gap_max": 3.2}, sty_)}
        check("refstyle: outside every reference is BELOW and names texture.py; the middle half is inside; between is high",
              rw_["gest10"]["where"] == "BELOW" and "texture.py" in rw_["gest10"]["lever"]
              and ri_["gest10"]["where"] == "inside" and ri_["gap_max"]["where"] == "high", str({k_: v_["where"] for k_, v_ in rw_.items()}))
        c_b, _ = sh([PY, S / "critique.py", resolved, wav, "--json"], env, ok_codes=(0, 1))
        c_s, _ = sh([PY, S / "critique.py", resolved, wav, "--style", "clean-sfx-refs", "--json"], env, ok_codes=(0, 1))
        c_n, _ = sh([PY, S / "critique.py", resolved, wav, "--style", "no-such-style"], env, ok_codes=(0, 1))
        try:
            jb_, js_ = json.loads(c_b.stdout.strip().splitlines()[-1]), json.loads(c_s.stdout.strip().splitlines()[-1])
        except Exception:
            jb_, js_ = {"axes": {"a": 1}}, {"axes": {"b": 2}}
        check("critique --style: the reference table is printed, the axes and the verdict are not touched",
              "Against the reference style 'clean-sfx-refs'" in c_s.stdout and "Against the reference style" not in c_b.stdout
              and jb_["axes"] == js_["axes"] and jb_.get("verdict") == js_.get("verdict") and c_b.returncode == c_s.returncode
              and len((js_.get("style") or {}).get("rows") or []) >= 5 and "not found" in c_n.stdout,
              f"{len((js_.get('style') or {}).get('rows') or [])} rows")
        import learn_style as LS_
        la_ = LS_.analyse(str(vid), None, (0.0, 0.0, 0.5, 1.0))
        check("learn_style: a picture region is honoured (no cuts searched in it) and the measures are written",
              la_.get("roi") == [0.0, 0.0, 0.5, 1.0] and all(k_ in (la_.get("measures") or {}) for k_ in ("gest10", "gap_max", "bed"))
              and not any(x_["kind"] == "cut" for x_ in la_["rows"]), str(la_.get("measures")))
        import levels as LV_
        check("levels: a texture sound has no sound of the author's to be matched against",
              len(LV_.groups([{"t": 1.0, "role": "hit", "label": "hit"},
                              {"t": 1.6, "role": "click", "label": "texture burst 0.30", "texture": True}])) == 1)

        tx = r4 / "tx"
        tx.mkdir(exist_ok=True)
        base_cues = [
            {"t": 1.0, "label": "whoosh a", "pick": {"role": "whoosh", "max_dur": 1.0}, "gain_db": -3},
            {"t": 1.5, "label": "hit a", "pick": {"role": "hit", "max_dur": 1.0}, "gain_db": -2},
            {"t": 9.0, "label": "whoosh b", "pick": {"role": "whoosh", "max_dur": 1.0}, "gain_db": -3},
            {"t": 9.5, "label": "hit b", "pick": {"role": "hit", "max_dur": 1.0}, "gain_db": -2},
            {"t": 11.0, "label": "click c", "pick": {"role": "click"}, "gain_db": -6}]
        moms_ = [{"t": 3.0, "kind": "burst", "strength": 0.40}, {"t": 4.0, "kind": "settle", "strength": 0.30},
                 {"t": 5.2, "kind": "onset", "strength": 0.50},       # inside the quiet range
                 {"t": 6.0, "kind": "burst", "strength": 0.95},       # strong: listed, not texture
                 {"t": 6.5, "kind": "burst", "strength": 0.08},       # noise
                 {"t": 7.0, "kind": "onset", "strength": 0.45},
                 {"t": 1.05, "kind": "burst", "strength": 0.40},      # beside a real cue
                 {"t": 8.0, "kind": "settle", "strength": 0.50},
                 {"t": 10.0, "kind": "cut", "strength": 0.9, "pct": 0.9}]
        (tx / "moments.json").write_text(json.dumps({"info": {"duration": 12.0}, "moments": moms_}), encoding="utf-8")
        sheet_tx = {"duration": 12.0, "keep_audio": "no", "quiet": [[5.0, 5.5]], "cues": base_cues}
        (tx / "cues.json").write_text(json.dumps(sheet_tx), encoding="utf-8")
        r_dry, ok_dry = sh([PY, S / "texture.py", tx / "cues.json", "--moments", tx / "moments.json", "--dry"], env)
        same_ = json.loads((tx / "cues.json").read_text(encoding="utf-8")) == sheet_tx
        r_tx, ok_tx = sh([PY, S / "texture.py", tx / "cues.json", "--moments", tx / "moments.json"], env)
        st_ = json.loads((tx / "cues.json").read_text(encoding="utf-8"))
        tex_ = [c_ for c_ in st_["cues"] if c_.get("texture")]
        check("texture.py --dry changes nothing; the layer goes on unvoiced weak moves in holes, not on a quiet range, "
              "a strong move, a noise move or a move beside a real cue",
              ok_dry and same_ and ok_tx and sorted(c_["t"] for c_ in tex_) == [3.0, 4.0, 7.0, 8.0]
              and all(c_.get("same_source") and c_["pick"]["max_dur"] <= 0.3 for c_ in tex_)
              and [c_ for c_ in st_["cues"] if not c_.get("texture")] == base_cues,
              str(sorted(c_["t"] for c_ in tex_)))
        check("texture.py lists what it did not voice: the strong burst and the strong cut",
              "6.00s burst" in r_tx.stdout and "10.00s cut" in r_tx.stdout and "NOT texture" in r_tx.stdout)
        r_tx2, _ = sh([PY, S / "texture.py", tx / "cues.json", "--moments", tx / "moments.json"], env)
        st2_ = json.loads((tx / "cues.json").read_text(encoding="utf-8"))
        check("texture.py again replaces the layer (the same cues, no duplicates)",
              st2_["cues"] == st_["cues"] and len([c_ for c_ in st2_["cues"] if c_.get("texture")]) == 4)
        (tx / "withmusic.json").write_text(json.dumps(dict(sheet_tx, keep_audio="auto", base_audio=["music.wav"])),
                                           encoding="utf-8")
        r_wm, ok_wm = sh([PY, S / "texture.py", tx / "withmusic.json", "--moments", tx / "moments.json"], env,
                         ok_codes=(0, 1))
        r_wf, ok_wf = sh([PY, S / "texture.py", tx / "withmusic.json", "--moments", tx / "moments.json",
                          "--even-with-audio"], env)
        check("texture.py refuses a film that keeps its own music or voice, and --even-with-audio overrides",
              r_wm.returncode != 0 and "not added" in (r_wm.stdout + r_wm.stderr) and ok_wf
              and any(c_.get("texture") for c_ in json.loads((tx / "withmusic.json").read_text(encoding="utf-8"))["cues"]))
        r_pl, ok_pl = sh([PY, S / "mix.py", tx / "cues.json", "--out", tx / "out" / "m.mp4", "--plan"], env)
        check("mix --plan marks the texture sounds and picks short real sounds for them",
              ok_pl and r_pl.stdout.count("(texture)") == 4, f"{r_pl.stdout.count('(texture)')} marked")
        r_mx, ok_mx = sh([PY, S / "mix.py", tx / "cues.json", "--out", tx / "out" / "m.mp4"], env)
        rtx_ = tx / "out" / "m_resolved_cues.json"
        rj_tx = json.loads(rtx_.read_text(encoding="utf-8")) if rtx_.exists() else {"cues": []}
        c_tx, _ = sh([PY, S / "critique.py", rtx_, tx / "out" / "m_sfx_track.wav"], env, ok_codes=(0, 1))
        check("the render carries the texture flag and the critique counts those sounds at half weight",
              ok_mx and sum(1 for c_ in rj_tx["cues"] if c_.get("texture")) == 4
              and "texture sounds (texture.py) count at half weight" in c_tx.stdout)
        r_rm, ok_rm = sh([PY, S / "texture.py", tx / "cues.json", "--remove"], env)
        check("texture.py --remove takes the layer out and leaves every other cue as it was",
              ok_rm and json.loads((tx / "cues.json").read_text(encoding="utf-8"))["cues"] == base_cues)

        # (r) 0.12.1: what four fresh agents found when they sounded silent reels (all of it was reproduced first)
        import critique as CR_
        import common as CM_
        import picker as PK_

        def cue_(t, role, label):
            return {"t": t, "role": role, "label": label, "file": role + ".wav", "seg": 0.1}
        keys_ = [cue_(round(4.06 + 0.083 * i, 3), "typing", f"key {i}") for i in range(10)]
        ev_ = CR_.collapse_runs([cue_(4.0, "pop", "pop")] + keys_)
        check("critique: a sound 60 ms before a row of keys does not swallow the row (it made 9 false smears)",
              len(ev_) == 2 and ev_[0]["role"] == "pop" and ev_[1]["role"] == "typing" and ev_[1]["n"] == 10,
              str([(e["role"], e["n"]) for e in ev_]))
        rows_k = [{"t": 1.0 + 0.1 * i, "role": "typing", "label": f"key {i}"} for i in range(30)] + \
                 [{"t": 9.0, "role": "hit", "label": "hit"}]
        check("critique: a row of 30 keystrokes is one thing to judge for the sync axis (it hid 126 other sounds)",
              CR_.rows_as_events(rows_k) == 2, str(CR_.rows_as_events(rows_k)))
        g_ = CM_.gesture_times([
            {"t": 1.0, "role": "hit", "layers": [{"dt": -0.1, "pick": {"role": "riser"}},
                                                 {"dt": 0.12, "pick": {"role": "pop"}}]},
            {"t": 1.2, "role": "pop"}, {"t": 2.0, "role": "whoosh"}, {"t": 3.0, "role": "ambience"}])
        check("gesture_times: layers and a sound within 0.25 s are one gesture, a bed is none",
              [round(x, 2) for x in g_] == [0.9, 2.0], str(g_))
        ll_ = CR_.listen_list([{"t": 1.0, "label": "whoosh a", "role": "whoosh"},
                               {"t": 1.6, "label": "pop b", "role": "pop", "pitch": 5}])
        check("listen list: a second reason at the same moment says which sound it is about, and when",
              bool(ll_) and any("also 'pop b'" in x[3] for x in ll_), str([x[3] for x in ll_]))
        ll2_ = CR_.listen_list([{"t": 1.0, "label": "parent", "role": "hit"}],
                               first={"t": 0.2, "label": "lead layer"})
        check("listen list: the hook is the first AUDIBLE sound (a layer that leads its parent)",
              bool(ll2_) and abs(ll2_[0][1] - 0.2) < 1e-6 and ll2_[0][2] == "lead layer", str(ll2_))
        recs_ = [{"id": i, "path": f"/x/{n}.wav", "name": n, "folder": "pops", "library": "t", "roles": ["pop", "ui"],
                  "role": "pop", "duration": 0.2, "active_dur": 0.2, "peak_db": -3.0, "centroid": 900.0,
                  "rolloff": 3000.0, "low": 0.2, "high": 0.1, "flat": 0.1, "attack_ms": 5.0, "decay_ms": 100.0,
                  "tier": "main"} for i, n in ((1, "Pop Bubble 1"), (2, "Поп ртом 3"), (3, "Plop 2"))]
        got_ = [s_["name"] for _, s_ in PK_.rank(recs_, {"role": "ui"})]
        asked_ = [s_["name"] for _, s_ in PK_.rank(recs_, {"role": "ui", "query": "рто"})]
        check("picker: a mouth pop is not offered for the ui role (ui = ui + pop + chime) unless asked by words",
              "Поп ртом 3" not in got_ and len(got_) == 2 and asked_ == ["Поп ртом 3"], f"{got_} / {asked_}")

        lay = r4 / "lay"
        lay.mkdir(exist_ok=True)
        (lay / "cues.json").write_text(json.dumps({"duration": 8.0, "keep_audio": "no", "cues": [
            {"t": 1.0, "label": "boom", "pick": {"role": "hit"},
             "layers": [{"dt": -0.8, "pick": {"role": "whoosh"}, "label": "lead whoosh"}]},
            {"t": 3.0, "label": "sweep", "pick": {"role": "whoosh", "max_dur": 1.0}},
            {"t": 5.0, "label": "boom 2", "pick": {"role": "hit"}}]}), encoding="utf-8")
        r_ly, ok_ly = sh([PY, S / "mix.py", lay / "cues.json", "--out", lay / "out" / "m.mp4"], env)
        res_ly, trk_ly = lay / "out" / "m_resolved_cues.json", lay / "out" / "m_sfx_track.wav"
        c_ly, _ = sh([PY, S / "critique.py", res_ly, trk_ly], env, ok_codes=(0, 1))
        check("critique: the hook is the layer that leads (0.20 s), not its parent (1.00 s)",
              ok_ly and "first sound at 0.20s" in c_ly.stdout,
              ([l for l in c_ly.stdout.splitlines() if l.startswith("| hook")] or ["no hook line"])[0][:100])
        check("critique: a film with no sound of its own is judged busy by gestures per 10 s, the references' number",
              "gestures per 10 s" in c_ly.stdout,
              ([l for l in c_ly.stdout.splitlines() if l.startswith("| pacing")] or ["no pacing line"])[0][:140])
        out_md = lay / "crit.md"
        for _i in (1, 2):
            sh([PY, S / "critique.py", res_ly, trk_ly, "--out", out_md, "--append"], env, ok_codes=(0, 1))
        check("critique --append keeps the rounds of the loop in one file",
              out_md.exists() and out_md.read_text(encoding="utf-8").count("# Critique, round") == 2)
        r_fz, ok_fz = sh([PY, S / "sheet.py", "freeze", lay / "cues.json", res_ly], env)
        fz_ = json.loads((lay / "cues.json").read_text(encoding="utf-8"))
        lay0_ = fz_["cues"][0]["layers"][0]
        check("sheet.py freeze pins the layers of a cue too (a file, no pick)",
              ok_fz and bool(lay0_.get("file")) and "pick" not in lay0_ and bool(fz_["cues"][0].get("file")), str(lay0_))

        shutil.copyfile(root / "unk_map.json", r4 / "unk_map2.json")
        r_ev, ok_ev = sh([PY, S / "sheet.py", "add", r4 / "unk_map2.json", "--event", "bead@2.5"], env)
        um_ = json.loads((r4 / "unk_map2.json").read_text(encoding="utf-8"))
        check("sheet.py add --event reuses the kinds the sheet's own from_cues call declared (--kind bead=click)",
              ok_ev and "routed to 1 cue" in r_ev.stdout and bool((um_["_draft"].get("kinds_user") or {}).get("bead")),
              (r_ev.stdout + r_ev.stderr)[-140:])
        (r4 / "lbl.json").write_text(json.dumps({"cues": [
            {"t": 1.0, "label": "monitor lands", "pick": {"role": "hit"}},
            {"t": 1.0, "label": "monitor lands sub", "pick": {"role": "hit"}}]}), encoding="utf-8")
        r_lb, ok_lb = sh([PY, S / "sheet.py", "set", r4 / "lbl.json", "--at", "1.0", "--label", "monitor lands",
                          "gain_db=-3"], env)
        lb_ = {c_["label"]: c_.get("gain_db") for c_ in json.loads((r4 / "lbl.json").read_text(encoding="utf-8"))["cues"]}
        check("sheet.py set: the label that IS the name wins over a label that merely contains it",
              ok_lb and lb_.get("monitor lands") == -3 and lb_.get("monitor lands sub") is None, str(lb_))

        # find_moments --fine: a film where only the HUE changes (twice), the brightness never
        chroma_v = r4 / "chroma_only.mp4"
        ff(["-f", "lavfi", "-i", "color=c=gray:s=320x180:r=30:d=4,format=yuv444p,geq=lum='128':"
            "cb='if(between(T,1,2.5),150,100)':cr='if(between(T,1,2.5),100,150)'", "-pix_fmt", "yuv420p",
            "-c:v", "libx264", "-preset", "veryfast", chroma_v])
        r_pl, ok_pl2 = sh([PY, S / "find_moments.py", chroma_v, "--out", r4 / "fm_plain"], env)
        r_fn, ok_fn = sh([PY, S / "find_moments.py", chroma_v, "--out", r4 / "fm_fine", "--fine"], env)
        mp_ = json.loads((r4 / "fm_plain" / "moments.json").read_text(encoding="utf-8"))["moments"] if ok_pl2 else []
        mf_ = json.loads((r4 / "fm_fine" / "moments.json").read_text(encoding="utf-8"))["moments"] if ok_fn else []
        tf_ = sorted(m_["t"] for m_ in mf_ if m_.get("src") == "chroma")
        check("find_moments --fine finds a move that changes the hue only; the luma reading sees none",
              ok_pl2 and ok_fn and len(mp_) == 0 and len(tf_) == 2 and abs(tf_[0] - 1.0) < 0.1 and abs(tf_[1] - 2.5) < 0.1,
              f"plain {len(mp_)}, fine {tf_}")
        r_at, ok_at = sh([PY, S / "look.py", vid, "--at", "3.0", "--span", "2.4", "--step", "0.1", "--out",
                          r4 / "at_fine.png"], env)
        check("look.py --at --step: a frame every 0.1 s, 24 frames in three rows",
              ok_at and "a frame every 0.10 s" in r_at.stdout and (r4 / "at_fine.png").exists()
              and (r4 / "at_fine.png").stat().st_size > 3000, r_at.stdout[-100:])

        # (s) 0.13.0: a bed under a film that is only SFX, and the repair of the encoder's own overshoot
        import refstyle as RS_
        bed_lib = root / "bedlib" / "Ambience"
        bed_lib.mkdir(parents=True)
        for nm_, src_ in (("Room Tone Low 1", "anoisesrc=d=6:c=brown:r=48000,lowpass=f=250,volume=2"),
                          ("Air Hiss Bright 1", "anoisesrc=d=6:c=white:r=48000,highpass=f=3000"),
                          ("Rain Loop 1", "anoisesrc=d=6:c=pink:r=48000,lowpass=f=400"),
                          # a low drone that throbs twice a second: dark, long and no thing, but not steady
                          # (its name sorts first: without the steadiness penalty it would head the picker's list)
                          # (a fixed seed: with random noise its `bumps` sit near the filter's limit of 8 and flip)
                          ("A Throb Low 1", "anoisesrc=d=6:c=brown:r=48000:seed=6,lowpass=f=250,volume=2,"
                                            "tremolo=f=2.2:d=0.95")):
            ff(["-f", "lavfi", "-i", src_, "-ac", "2", str(bed_lib / f"{nm_}.wav")])
        (root / "config_bed.json").write_text(json.dumps({
            "libraries": [{"name": "bedlib", "path": str(root / "bedlib"), "tier": "main"}],
            "uisfx": {"path": "vendor/node_modules/uisfx", "default_pack": "studio"}, "skip_dir_names": [],
            "index_path": str(root / "index_bed.json")}), encoding="utf-8")
        env_b = dict(env, REAL_SFX_CONFIG=str(root / "config_bed.json"), REAL_SFX_INDEX=str(root / "index_bed.json"),
                     REAL_SFX_STEADY=str(root / "steady_bed.json"))
        sh([PY, S / "build_index.py"], env_b)
        bd = root / "bed"
        bd.mkdir()
        cues_b = [
            {"t": 1.0, "label": "hit a", "file": str(lib / "Hits and impacts" / "Hit 1.wav"), "role": "hit"},
            {"t": 4.0, "label": "whoosh", "file": str(lib / "Whooshes" / "Whoosh 1.wav"), "role": "whoosh"},
            {"t": 8.0, "label": "hit b", "file": str(lib / "Hits and impacts" / "Hit 2.wav"), "role": "hit"},
            {"t": 10.0, "label": "click", "file": str(lib / "Clicks" / "Click 1.wav"), "role": "click"}]
        (bd / "cues.json").write_text(json.dumps({"duration": 12.0, "keep_audio": "no", "cues": cues_b}), encoding="utf-8")
        (bd / "plain.json").write_text(json.dumps({"duration": 12.0, "keep_audio": "no", "cues": cues_b}), encoding="utf-8")
        r_bl, ok_bl = sh([PY, S / "bed.py", bd / "cues.json", "--list"], env_b)
        check("bed.py --list: the dark steady room tone is offered; the bright hiss and the rain are not",
              ok_bl and "Room Tone Low 1" in r_bl.stdout and "Air Hiss" not in r_bl.stdout
              and "Rain Loop" not in r_bl.stdout, r_bl.stdout[-160:].replace("\n", " | "))
        r_bt, ok_bt = sh([PY, S / "bed.py", bd / "cues.json", "--list", "--any-steadiness"], env_b)
        check("bed.py: a dark drone that throbs twice a second is left out (the listener called such a bed a hum), "
              "and --any-steadiness brings it back; the steadiness numbers are printed",
              ok_bt and "Throb Low 1" not in r_bl.stdout and "Throb Low 1" in r_bt.stdout and "ripple" in r_bl.stdout,
              (r_bl.stdout + r_bt.stdout)[-260:].replace("\n", " | "))
        from common import steadiness as steadiness_
        st_room, st_throb = steadiness_(bed_lib / "Room Tone Low 1.wav"), steadiness_(bed_lib / "A Throb Low 1.wav")
        check("common.steadiness: a steady low room tone stays under the bed's limit (4 dB on the 50 ms scale), the "
              "drone that throbs twice a second moves several times more",
              bool(st_room) and bool(st_throb) and st_room["ripple"] <= 4.0 and st_throb["ripple"] >= 8.0
              and st_throb["ripple"] >= 2.0 * st_room["ripple"], f"{st_room} {st_throb}")
        r_bs, ok_bs = sh([PY, S / "bed.py", "--scan"], env_b)
        check("bed.py --scan measures the ambience recordings once and writes the cache the picker reads",
              ok_bs and (root / "steady_bed.json").exists() and "ambience recordings measured" in r_bs.stdout
              and "Throb Low 1" in (root / "steady_bed.json").read_text(encoding="utf-8"),
              r_bs.stdout[-200:].replace("\n", " | "))
        code_pk = ("import sys, json; sys.path.insert(0, r'%s'); import picker; idx = picker.load_index(); "
                   "print(json.dumps([(x['name'], round(s, 2)) for s, x in "
                   "picker.rank(idx, {'role': 'ambience', 'min_dur': 3})]))" % S)
        r_pk, ok_pk = sh([PY, "-c", code_pk], env_b)
        try:
            ranked_ = json.loads(r_pk.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            ranked_ = []
        names_pk = [n_ for n_, _ in ranked_]
        check("picker: with the steadiness cache the ambience that throbs ranks below the steady room tone "
              "(without it, it would head the list)",
              ok_pk and "A Throb Low 1" in names_pk and "Room Tone Low 1" in names_pk
              and names_pk.index("A Throb Low 1") > names_pk.index("Room Tone Low 1"), str(ranked_)[:200])
        r_ba, ok_ba = sh([PY, S / "bed.py", bd / "cues.json"], env_b)
        bs_ = json.loads((bd / "cues.json").read_text(encoding="utf-8"))
        pcs_ = sorted((c_ for c_ in bs_["cues"] if c_.get("bed")), key=lambda c_: c_["t"])
        check("bed.py: 12 s of film, a 6 s recording: three overlapping pieces from 0 s to the end, cross-faded "
              "equal-power, the film's own cues untouched",
              ok_ba and len(pcs_) == 3 and abs(pcs_[0]["t"]) < 1e-6
              and abs(pcs_[-1]["t"] + pcs_[-1]["max_dur"] - 12.2) < 0.25 and all(c_["fade_curve"] == "qsin" for c_ in pcs_)
              and [c_ for c_ in bs_["cues"] if not c_.get("bed")] == cues_b,
              f"{[(c_['t'], c_['max_dur']) for c_ in pcs_]}")
        r_m0, ok_m0 = sh([PY, S / "mix.py", bd / "plain.json", "--out", bd / "o0" / "m.mp4"], env_b)
        r_m1, ok_m1 = sh([PY, S / "mix.py", bd / "cues.json", "--out", bd / "o1" / "m.mp4"], env_b)
        bed_line = next((l_ for l_ in r_m1.stdout.splitlines() if l_.startswith("bed:")), "")
        m0_ = RS_.measure(bd / "o0" / "m_sfx_track.wav") if ok_m0 else {}
        m1_ = RS_.measure(bd / "o1" / "m_sfx_track.wav") if ok_m1 else {}
        res_m1 = json.loads((bd / "o1" / "m_resolved_cues.json").read_text(encoding="utf-8")) if ok_m1 else {}
        bi_ = res_m1.get("bed") or {}
        lvl_ = (bi_.get("bed_before_db", 0.0) + bi_.get("gain_change_db", 0.0)) if bi_ else None
        check("mix.py levels the bed to an ABSOLUTE level (-54 dBFS median 250 ms in the master: the listener chose -56 "
              "and called -44 loud), and the digital silence between the sounds is gone",
              ok_m1 and bool(bed_line) and bi_.get("level_dbfs") == -54.0 and lvl_ is not None and abs(lvl_ + 54.0) < 0.6
              and m1_.get("silent") == 0 and (m0_.get("silent") or 0) > 20,
              f"{bed_line[:120]} | level {lvl_} silent {m1_.get('silent')} (without: silent {m0_.get('silent')})")
        # the relative rule is still there: --floor -24 puts the bed's floor about 24 dB under the loudest 250 ms
        (bd / "rel.json").write_text(json.dumps({"duration": 12.0, "keep_audio": "no", "cues": cues_b}), encoding="utf-8")
        sh([PY, S / "bed.py", bd / "rel.json", "--floor", "-24"], env_b)
        r_mr, ok_mr = sh([PY, S / "mix.py", bd / "rel.json", "--out", bd / "orel" / "m.mp4"], env_b)
        m_rel = RS_.measure(bd / "orel" / "m_sfx_track.wav") if ok_mr else {}
        check("bed.py --floor -24: the old relative rule (its floor about 24 dB under the loudest 250 ms) still works",
              ok_mr and -28.0 <= (m_rel.get("floor_db") or -99) <= -20.0, f"floor {m_rel.get('floor_db')}")
        j_ax = {}
        for tag_, d_ in (("o0", bd / "o0"), ("o1", bd / "o1")):
            c_r, _ = sh([PY, S / "critique.py", d_ / "m_resolved_cues.json", d_ / "m_sfx_track.wav", "--json"], env_b,
                        ok_codes=(0, 1))
            try:
                j_ax[tag_] = json.loads(c_r.stdout.strip().splitlines()[-1])["axes"]
            except Exception:
                j_ax[tag_] = {}
        check("critique: a bed is no event (hook, sync, pacing, variety, hierarchy are those of the film without it)",
              bool(j_ax.get("o0")) and all(j_ax["o0"].get(k_) == j_ax["o1"].get(k_)
                                           for k_ in ("hook", "sync", "pacing", "variety", "hierarchy")), str(j_ax))
        res_o1 = json.loads((bd / "o1" / "m_resolved_cues.json").read_text(encoding="utf-8"))
        nb_ = (res_o1.get("bed") or {}).get("track_nobed")
        check("mix.py writes the track without the bed and names it in the resolved cues (the sounds are judged on it)",
              bool(nb_) and Path(nb_).exists() and Path(nb_).name == "m_sfx_track_nobed.wav", str(nb_))
        v0_, _ = sh([PY, S / "verify.py", bd / "o0" / "m_resolved_cues.json", bd / "o0" / "m_sfx_track.wav", "--json"],
                    env_b, ok_codes=(0, 1))
        v1_, _ = sh([PY, S / "verify.py", bd / "o1" / "m_resolved_cues.json", bd / "o1" / "m_sfx_track.wav", "--json"],
                    env_b, ok_codes=(0, 1))
        try:
            jv0, jv1 = json.loads(v0_.stdout), json.loads(v1_.stdout)
        except ValueError:
            jv0 = jv1 = {}
        offs0 = [r_["off_ms"] for r_ in jv0.get("rows", [])]
        offs1 = [r_["off_ms"] for r_ in jv1.get("rows", [])]
        check("verify.py: the timing of the sounds under a bed is judged as without it, and the bed itself is not a row "
              "(it made 3 of 26 'off', and one piece 'MISSING' from the track without it)",
              bool(jv0) and jv0["bad"] == jv1["bad"] == 0 and len(offs0) == 4 and offs0 == offs1
              and all(r_.get("present", True) for r_ in jv1.get("rows", [])),
              f"bad {jv0.get('bad')} / {jv1.get('bad')}, off_ms {offs0} / {offs1}")
        ghost = json.loads((bd / "o1" / "m_resolved_cues.json").read_text(encoding="utf-8"))
        ghost["cues"].append({"t": 9.0, "start": 9.0, "seg": 0.3, "role": "click", "label": "ghost", "file": "x.wav",
                              "anchor": "peak", "gain_applied_db": -6.0, "peak_db": -6.0})
        (bd / "o1" / "ghost_resolved.json").write_text(json.dumps(ghost), encoding="utf-8")
        v_g, _ = sh([PY, S / "verify.py", bd / "o1" / "ghost_resolved.json", bd / "o1" / "m_sfx_track.wav"], env_b,
                    ok_codes=(0, 1))
        check("verify.py: a sound the render lost is found under a bed too (the bed alone would fill its window)",
              "ghost" in v_g.stdout and "MISSING" in v_g.stdout, v_g.stdout[-200:].replace("\n", " | "))
        def f32_(p_):
            return subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(p_), "-f", "f32le", "-ac", "2",
                                   "-ar", "48000", "-"], capture_output=True).stdout
        check("mix.py: the track without the bed IS the film without a bed, sample for sample (the bed is added on top)",
              bool(nb_) and Path(nb_).exists() and len(f32_(bd / "o0" / "m_sfx_track.wav")) > 1000
              and f32_(bd / "o0" / "m_sfx_track.wav") == f32_(nb_))
        # the same for a film that matches the loudness of a synthesized layer it replaces: the bed lifts quiet blocks
        # over the BS.1770 gate and lowers the integrated figure, which used to raise every sound by 0.3 dB
        for tag_, extra_ in (("pl", False), ("bl", True)):
            (bd / f"lay_{tag_}.json").write_text(json.dumps({"duration": 12.0, "keep_audio": "no", "cues": cues_b,
                                                             "_draft": {"layer_lufs": -26.0}}), encoding="utf-8")
            if extra_:
                sh([PY, S / "bed.py", bd / f"lay_{tag_}.json"], env_b)
            sh([PY, S / "mix.py", bd / f"lay_{tag_}.json", "--out", bd / f"o_{tag_}" / "m.mp4"], env_b)
        nb_l = bd / "o_bl" / "m_sfx_track_nobed.wav"
        check("mix.py: with a layer match too, a bed leaves every sound exactly where it was (the match is measured "
              "without the bed)", nb_l.exists() and f32_(nb_l) == f32_(bd / "o_pl" / "m_sfx_track.wav")
              and len(f32_(nb_l)) > 1000)
        r_br, ok_br = sh([PY, S / "bed.py", bd / "cues.json", "--remove"], env_b)
        check("bed.py --remove gives the sheet back exactly as it was",
              ok_br and json.loads((bd / "cues.json").read_text(encoding="utf-8"))["cues"] == cues_b)
        (bd / "own.json").write_text(json.dumps({"video": str(vid), "keep_audio": "yes", "cues": cues_b}), encoding="utf-8")
        r_bo, ok_bo = sh([PY, S / "bed.py", bd / "own.json"], env_b, ok_codes=(0, 1))
        check("bed.py refuses a film that keeps its own music or voice (the music is the bed there)",
              r_bo.returncode != 0 and "not added" in (r_bo.stdout + r_bo.stderr),
              (r_bo.stdout + r_bo.stderr)[-120:].replace("\n", " "))
        st_, _p = RS_.find_style("clean-sfx-refs")
        tab_ = "\n".join(RS_.render(RS_.compare(m1_, st_), st_)) if (m1_ and st_) else ""
        check("refstyle: the floor and the digital silence of a track are measured and set against the references",
              "floor_db" in m1_ and "silent" in m1_ and "the quietest tenth" in tab_ and "digital silence" in tab_,
              str(sorted(m1_)[:12]))

        # the encoder's own overshoot is repaired where it is: a burst of 0.95 full scale at 1 s (the one to find) and
        # one of 0.4 at 3 s (must stay exactly as it is)
        import mix as MX_
        pk_wav = bd / "peaks.wav"
        ff(["-f", "lavfi", "-i", "aevalsrc='0.95*sin(2*PI*1000*t)*between(t,1,1.05)+0.4*sin(2*PI*1000*t)*between(t,3,3.05)'"
            ":d=5:s=48000", pk_wav])
        ev_pk = MX_.peak_events(pk_wav, -1.0)
        check("mix.peak_events: finds the one place above the ceiling, at its time, and no other",
              len(ev_pk) == 1 and 0.95 < ev_pk[0][0] < 1.12 and -1.0 < ev_pk[0][1] < 0.0, str(ev_pk))
        tone_wav, dip_wav = bd / "tone.wav", bd / "dipped.wav"
        ff(["-f", "lavfi", "-i", "aevalsrc='0.5*sin(2*PI*1000*t)':d=5:s=48000", tone_wav])
        g_ = MX_.master_chain(0.0, 1.0, [[2.5, 3.0]]).replace("[1:a]", "[0:a]")
        ff(["-i", tone_wav, "-filter_complex", g_, "-map", "[aout]", "-c:a", "pcm_s24le", "-ar", "48000", dip_wav])
        fp_ = MX_.frame_peaks(dip_wav)
        inside_ = [p_ for t_, p_ in fp_ if 2.3 <= t_ <= 2.7]
        outside_ = [p_ for t_, p_ in fp_ if t_ < 2.3 or t_ > 2.7][1:-1]          # the first and last frames are partial
        steps_ = [abs(b_[1] - a_[1]) for a_, b_ in zip(fp_[2:-2], fp_[3:-2])]      # not the partial frames at the ends
        check("mix.master_chain: a 3 dB dip takes its place down by about 3 dB, smoothly, and leaves the rest alone",
              bool(inside_) and -9.6 <= min(inside_) <= -8.2 and outside_ and all(abs(p_ + 6.02) < 0.15 for p_ in outside_)
              and max(steps_) < 2.2,                    # a 3 dB dip over 60 ms: 1.6 dB per 21 ms frame at the steepest
              f"min in the dip {min(inside_) if inside_ else None}, outside {sorted(set(round(p_, 1) for p_ in outside_))}, "
              f"largest step {max(steps_):.2f} dB")

        # (t) 0.13.0: the re-sound test is a tool of the skill (tests/resound.py), tried on a synthetic reference
        rs = root / "resound"
        rs.mkdir()
        hits_t = [0.5, 1.4, 2.1, 3.3, 4.6, 5.2, 6.8]
        click_stem(rs / "ref_audio.wav", hits_t, dur=8.0)
        ref_v = rs / "ref.mp4"
        ff(["-f", "lavfi", "-i", "color=c=0x203040:s=320x240:r=30:d=8", "-i", rs / "ref_audio.wav", "-c:v", "libx264",
            "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", ref_v])
        (rs / "refs.txt").write_text(f"{ref_v} | | 0,0,1,0.5\n", encoding="utf-8")
        RS = SKILL / "tests" / "resound.py"
        r_pp, ok_pp = sh([PY, RS, "prepare", rs / "t", "--refs", rs / "refs.txt", "--n", "1", "--seed", "3"], env)
        silent_ = rs / "t" / "inputs" / "reel_a.mp4"
        sz_ = probe(silent_, "stream=width,height").replace("\n", ",") if silent_.exists() else ""
        check("resound prepare: the film the skill gets is the animation only (cropped) and has no audio stream at all",
              ok_pp and silent_.exists() and probe(silent_, "stream=codec_type") == "video"
              and sz_ in ("320,120", "320,120,") and (rs / "t" / "truth" / "reel_a_original.wav").exists()
              and (rs / "t" / "truth" / "mapping.json").exists(), f"{sz_} | {probe(silent_, 'stream=codec_type')}")
        fake_skill = rs / "skill"
        fake_skill.mkdir()
        (fake_skill / "SKILL.md").write_text("one", encoding="utf-8")
        (fake_skill / "scripts").mkdir()
        (fake_skill / "scripts" / "a.py").write_text("print(1)", encoding="utf-8")
        sh([PY, RS, "snapshot", rs / "t", "--skill", fake_skill], env)
        r_c0, _ = sh([PY, RS, "check", rs / "t", "--skill", fake_skill], env, ok_codes=(0, 1))
        (fake_skill / "scripts" / "a.py").write_text("print(2)", encoding="utf-8")
        r_c1, _ = sh([PY, RS, "check", rs / "t", "--skill", fake_skill], env, ok_codes=(0, 1))
        check("resound check: an untouched skill folder passes, a changed file is named and fails",
              r_c0.returncode == 0 and r_c1.returncode == 1 and "scripts/a.py" in r_c1.stdout,
              f"{r_c0.returncode} / {r_c1.returncode}")
        r_pr, _ = sh([PY, RS, "prompt", rs / "t", "--skill", fake_skill], env)
        check("resound prompt: tells a fresh agent the film, the skill, where to write, and not to look at the truth",
              "reel_a.mp4" in r_pr.stdout and "SKILL.md" in r_pr.stdout and "truth" in r_pr.stdout
              and "Do not change anything inside the skill folder" in r_pr.stdout)
        # the "skill's result" is the original itself: every gesture must be voiced, and nothing is missing
        res_dir = rs / "t" / "run1" / "reel_a" / "result"
        res_dir.mkdir(parents=True)
        shutil.copyfile(rs / "t" / "truth" / "reel_a_original.mp4", res_dir / "reel_a_sfx.mp4")
        r_ev, ok_ev2 = sh([PY, RS, "eval", rs / "t", "--run", "run1", "--out", "eval1"], env)
        try:
            ev_j = json.loads((rs / "t" / "eval1" / "reel_a.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            ev_j = {}
        tm_ = ((ev_j.get("timing") or {}).get("tol50") or {}).get("original_voiced_by_skill") or {}
        check("resound eval: the original against itself voices every gesture and writes the report and the A/B pair",
              ok_ev2 and tm_.get("recall") == 1.0 and abs((ev_j.get("envelope_r") or 0) - 1.0) < 0.01
              and (rs / "t" / "eval1" / "REPORT.md").exists()
              and (rs / "t" / "eval1" / "listen" / "reel_a_A_original.mp4").exists(),
              f"recall {tm_.get('recall')}, r {ev_j.get('envelope_r')}, {(r_ev.stdout + r_ev.stderr)[-150:]}")

        # the reference style an agent sees must not hold its own reel: a folder named by REAL_SFX_STYLES wins, and the
        # copy without the reel is made from the learned style (the one that has the names)
        (rs / "styles_env").mkdir()
        (rs / "styles_env" / "clean-sfx-refs.json").write_text(json.dumps({
            "name": "clean-sfx-refs", "n_refs": 4, "measures": {"gest10": {
                "median": 3.0, "p25": 2.0, "p75": 4.0, "min": 1.0, "max": 5.0, "n": 4}}, "per_ref": []}), encoding="utf-8")
        code_ = (f"import sys; sys.path.insert(0, r'{S}'); import refstyle; st, p = refstyle.find_style('clean-sfx-refs'); "
                 f"print(p.parent.name, st['measures']['gest10']['median'])")
        r_env = subprocess.run([PY, "-c", code_], capture_output=True, text=True, errors="replace",
                               env=dict(env, REAL_SFX_STYLES=str(rs / "styles_env")))
        check("REAL_SFX_STYLES: a folder named by the environment wins over the learned and the shipped style",
              r_env.stdout.strip() == "styles_env 3.0", (r_env.stdout + r_env.stderr)[-120:])
        import importlib.util
        spec_ = importlib.util.spec_from_file_location("resound_mod", RS)
        rsm = importlib.util.module_from_spec(spec_)
        spec_.loader.exec_module(rsm)
        fake_root = rs / "fakeskill"
        (fake_root / "styles").mkdir(parents=True)
        (fake_root / "styles" / "clean-sfx-refs.json").write_text(json.dumps({
            "name": "clean-sfx-refs", "per_ref": [
                {"video": f"/refs/{n_}.mp4", "duration": 10.0, "measures": {"gest10": v_, "lufs": -14.0}}
                for n_, v_ in (("a", 10.0), ("b", 12.0), ("c", 14.0), ("d", 20.0))]}), encoding="utf-8")
        rsm.SKILL = fake_root
        w_ = rsm.style_without({"d.mp4"})
        n_ = rsm.style_without({"zzz.mp4"})
        check("resound: the style an agent works with is the learned one WITHOUT its own reel (re-aggregated, anonymous)",
              w_ is not None and w_["n_refs"] == 3 and w_["measures"]["gest10"]["max"] == 14.0
              and all(r_["file"].startswith("reference ") for r_ in w_["per_ref"]) and n_ is None,
              str(w_ and w_["measures"].get("gest10")))

        # (u) 0.14.0: the ears of the person (a listening page) and the masking model
        import urllib.request
        lp = root / "lp"
        lp.mkdir()
        for nm_, hz_ in (("a", 196), ("b", 330)):
            ff(["-f", "lavfi", "-i", "color=c=0x203040:s=160x120:r=15:d=3", "-f", "lavfi", "-i", f"sine=f={hz_}:d=3",
                "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
                lp / f"{nm_}.mp4"])
        (lp / "list.json").write_text(json.dumps({"listen": [
            {"t": 1.2, "label": "hit", "why": "the highest peak", "ask": "is it big without hurting?"}]}), encoding="utf-8")
        r_pb, ok_pb = sh([PY, S / "listen_page.py", "build", lp / "page", "--ab", "bed or not", lp / "a.mp4", lp / "b.mp4",
                          "--labels", "plain", "bed", "--moments", lp / "a.mp4", "--list", lp / "list.json",
                          "--seed", "5", "--title", "selftest page"], env)
        man_ = json.loads((lp / "page" / "manifest.json").read_text(encoding="utf-8")) if ok_pb else {"items": []}
        check("listen_page build: a blind comparison of two versions and one moment with its question, media beside the page",
              ok_pb and [i_["kind"] for i_ in man_["items"]] == ["ab", "moment"]
              and (lp / "page" / "index.html").exists() and (lp / "page" / "media" / "ab1_pic.mp4").exists()
              and man_["items"][1]["question"] == "is it big without hurting?"
              and "selftest page" in (lp / "page" / "index.html").read_text(encoding="utf-8"),
              str([(i_["id"], i_["order"]) for i_ in man_["items"]]))
        # 0.14.1: versions with the same picture are ONE picture and a sound each (a hidden second copy of a 1080p60
        # film stalled in the browser and was re-seeked every 250 ms); versions with pictures of their own are files
        def streams_(p_):
            r_ = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json",
                                 str(p_)], capture_output=True, text=True, errors="replace")
            return json.loads(r_.stdout or "{}").get("streams", [])
        it0_ = man_["items"][0] if man_["items"] else {}
        pic_ = lp / "page" / (it0_.get("picture") or "none")
        snd_ = [lp / "page" / v_["file"] for v_ in it0_.get("versions", [])]
        sp_, ss_ = streams_(pic_), [streams_(s_) for s_ in snd_]
        d_pic = float((sp_[0] if sp_ else {}).get("duration") or 0)
        d_snd = [float((s_[0] if s_ else {}).get("duration") or 0) for s_ in ss_]
        check("listen_page: versions of one picture are built as ONE picture without sound and a sound each without picture",
              it0_.get("picture") == "media/ab1_pic.mp4" and [s_["codec_type"] for s_ in sp_] == ["video"]
              and len(snd_) == 2 and all([x_["codec_type"] for x_ in s_] == ["audio"] for s_ in ss_)
              and all(abs(d_ - d_pic) < 0.1 for d_ in d_snd) and all(v_["kind"] == "audio" for v_ in it0_["versions"]),
              f"picture {it0_.get('picture')} {d_pic:.2f} s, sounds {d_snd}")
        ff(["-f", "lavfi", "-i", "color=c=0x802020:s=160x120:r=15:d=3", "-f", "lavfi", "-i", "sine=f=262:d=3",
            "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", lp / "c.mp4"])
        r_p2, ok_p2 = sh([PY, S / "listen_page.py", "build", lp / "page2", "--ab", "other picture", lp / "a.mp4", lp / "c.mp4",
                          "--seed", "5"], env)
        r_p3, ok_p3 = sh([PY, S / "listen_page.py", "build", lp / "page3", "--ab", "kept apart", lp / "a.mp4", lp / "b.mp4",
                          "--separate-pictures", "--seed", "5"], env)
        m2_ = json.loads((lp / "page2" / "manifest.json").read_text(encoding="utf-8")) if ok_p2 else {"items": [{}]}
        m3_ = json.loads((lp / "page3" / "manifest.json").read_text(encoding="utf-8")) if ok_p3 else {"items": [{}]}
        check("listen_page: versions with pictures of their own (or --separate-pictures) stay whole files, one runs at a time",
              ok_p2 and ok_p3 and "picture" not in m2_["items"][0] and "picture" not in m3_["items"][0]
              and [v_["kind"] for v_ in m2_["items"][0]["versions"]] == ["video", "video"]
              and (lp / "page2" / "media" / "ab1_v2.mp4").exists() and (lp / "page3" / "media" / "ab1_v1.mp4").exists(),
              f"{ok_p2} {ok_p3} {str(m2_['items'][0])[:140]}")
        srv = subprocess.Popen([PY, str(S / "listen_page.py"), "serve", str(lp / "page"), "--port", "0"],
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
        try:
            first_ = srv.stdout.readline()
            url_ = first_.split("listening page:")[1].split()[0] if "listening page:" in first_ else ""
            idx_ = urllib.request.urlopen(url_, timeout=10).read().decode("utf-8") if url_ else ""
            rq_ = urllib.request.Request(url_ + "media/ab1_pic.mp4", headers={"Range": "bytes=10-109"})
            rr_ = urllib.request.urlopen(rq_, timeout=10)
            try:
                urllib.request.urlopen(url_ + "%2e%2e/%2e%2e/README.md", timeout=10)
                trav_ = 200
            except Exception as ex_:
                trav_ = getattr(ex_, "code", -1)
            check("listen_page serve: the page, a ranged media request (seeking works), no way out of the folder",
                  "selftest page" in idx_ and rr_.status == 206 and len(rr_.read()) == 100 and trav_ == 404,
                  f"{url_} range {rr_.status} traversal {trav_}")
            ch_ = man_["items"][0]["order"]
            body_ = json.dumps({"items": {"ab1": {"choice": "2", "tags": {"1": ["hum"], "2": []}, "note": "n"},
                                          "m1": {"choice": "masked", "tags": {}, "note": ""}}}).encode("utf-8")
            pr_ = urllib.request.Request(url_ + "api/save", data=body_, headers={"Content-Type": "application/json"})
            ps_ = urllib.request.urlopen(pr_, timeout=10).status
            back_ = json.loads(urllib.request.urlopen(url_ + "api/load", timeout=10).read().decode("utf-8"))
        finally:
            srv.terminate()
            try:
                srv.wait(timeout=5)
            except Exception:
                srv.kill()
        r_pr, ok_pr = sh([PY, S / "listen_page.py", "results", lp / "page"], env)
        want_ = man_["items"][0]["versions"][ch_[1]]["label"]                # what stood under "2"
        check("listen_page: the verdicts are saved by the server and `results` unblinds them (which version won)",
              ps_ == 200 and back_.get("items", {}).get("ab1", {}).get("choice") == "2" and ok_pr
              and f"{want_}" in r_pr.stdout and "masked" in r_pr.stdout and "2 of 2 answered" in r_pr.stdout,
              r_pr.stdout.strip()[:200].replace("\n", " | "))

        # (v) 0.14.0: the taste test by category (taste_test.py): one picture, many sounds of a role, one tap each
        tt = root / "taste"
        (tt / "lib" / "Clicks").mkdir(parents=True)
        for i_, (hz_, du_) in enumerate(((600, 0.09), (1200, 0.07), (2400, 0.06), (3500, 0.12), (5200, 0.05),
                                         (900, 0.15), (1800, 0.08)), 1):
            ff(["-f", "lavfi", "-i", f"sine=f={hz_}:d={du_}:r=48000,afade=t=out:st=0.01:d={du_ - 0.01:.3f},volume=0.6",
                "-ac", "2", tt / "lib" / "Clicks" / f"Click Soft {i_}.wav"])
        ff(["-f", "lavfi", "-i", "color=c=0x203040:s=160x120:r=15:d=4", "-c:v", "libx264", "-preset", "veryfast",
            "-pix_fmt", "yuv420p", tt / "host.mp4"])
        (tt / "config.json").write_text(json.dumps({
            "libraries": [{"name": "tastelib", "path": str(tt / "lib"), "tier": "main"}],
            "uisfx": {"path": "vendor/node_modules/uisfx", "default_pack": "studio"}, "skip_dir_names": [],
            "index_path": str(tt / "index.json")}), encoding="utf-8")
        (tt / "hosts.json").write_text(json.dumps({"click": {
            "video": str(tt / "host.mp4"), "t0": 0.5, "dur": 2.5, "events": [1.5], "title": "Clicks: a button",
            "about": "a grey card", "question": "does this click fit?"}}), encoding="utf-8")
        env_t = dict(env, REAL_SFX_CONFIG=str(tt / "config.json"), REAL_SFX_INDEX=str(tt / "index.json"),
                     REAL_SFX_TASTE=str(tt / "taste.json"), REAL_SFX_RATINGS=str(tt / "ratings.json"),
                     REAL_SFX_STEADY=str(tt / "steady.json"))
        sh([PY, S / "build_index.py"], env_t)
        r_tp, ok_tp = sh([PY, S / "taste_test.py", "plan", tt / "out", "--hosts", tt / "hosts.json", "--roles", "click",
                          "-n", "5", "--seed", "3"], env_t)
        plan_ = json.loads((tt / "out" / "plan.json").read_text(encoding="utf-8")) if ok_tp else {"sections": []}
        its_ = plan_["sections"][0]["items"] if plan_["sections"] else []
        reps_ = [i_ for i_ in its_ if i_["control"] == "repeat"]
        plain_ = [i_ for i_ in its_ if not i_["control"]]
        check("taste_test plan: five different sounds of the role on one picture, plus a repeat of one of them "
              "(no other-role control when the library has no sound of that role)",
              ok_tp and len(plain_) == 5 and len({i_["sound"]["path"] for i_ in plain_}) == 5 and len(reps_) == 1
              and reps_[0]["sound"]["path"] in {i_["sound"]["path"] for i_ in plain_}
              and sorted(i_["n"] for i_ in its_) == list(range(1, len(its_) + 1)),
              f"{len(its_)} items: {[(i_['n'], i_['control']) for i_ in its_]}")
        r_tr, ok_tr = sh([PY, S / "taste_test.py", "render", tt / "out", "--jobs", "2"], env_t)
        plan_ = json.loads((tt / "out" / "plan.json").read_text(encoding="utf-8")) if ok_tr else plan_
        clips_ = [tt / "out" / i_["clip"] for i_ in plan_["sections"][0]["items"] if i_.get("clip")] if plan_["sections"] else []
        a_ok = []
        for c_ in clips_:
            pr_ = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type",
                                  "-of", "csv=p=0", str(c_)], capture_output=True, text=True)
            a_ok.append(c_.exists() and "audio" in pr_.stdout)
        check("taste_test render: one clip per sound, the picture of the host with the sound placed on the event",
              ok_tr and len(clips_) == len(its_) and all(a_ok), f"{len(clips_)} clips, audio {a_ok}")
        r_tg, ok_tg = sh([PY, S / "taste_test.py", "page", tt / "out"], env_t)
        tman_ = json.loads((tt / "out" / "page" / "manifest.json").read_text(encoding="utf-8")) if ok_tg else {"items": []}
        rate_ = [i_ for i_ in tman_["items"] if i_["kind"] == "rate"]
        check("taste_test page: every sound is an item to rate in the section of its role, with its measured meta hidden "
              "in the manifest, the verdicts and the contexts to choose from",
              ok_tg and len(rate_) == len(its_) and all(i_["section"] == "click" and i_["loop"] for i_ in rate_)
              and {v_["key"] for v_ in tman_.get("rate_verdicts", [])} == {"love", "ok", "notfit", "never"}
              and tman_["sections"][0]["n"] == len(its_) and all("path" in i_["meta"] for i_ in rate_),
              (r_tg.stdout + r_tg.stderr)[-160:].replace("\n", " | "))
        # answer: the first sound loved, the second never, the repeat of a sound answered like the sound
        ans_ = {}
        by_path_ = {}
        for k_, i_ in enumerate(rate_):
            m_ = i_["meta"]
            if m_["control"] == "repeat":
                v_ = by_path_.get(m_["path"], "ok")
            else:
                v_ = ("love", "never", "ok", "notfit", "ok")[len(by_path_) % 5]
                by_path_[m_["path"]] = v_
            ans_[i_["id"]] = {"choice": v_, "tags": {"1": ["harsh"] if v_ == "never" else []},
                              "use": ["impact"] if v_ == "notfit" else [], "note": ""}
        (tt / "out" / "page" / "verdicts.json").write_text(json.dumps({"items": ans_}), encoding="utf-8")
        r_ts, ok_ts = sh([PY, S / "taste_test.py", "results", tt / "out", "--apply"], env_t)
        taste_ = json.loads((tt / "taste.json").read_text(encoding="utf-8")) if (tt / "taste.json").exists() else {}
        want_love = [p_ for p_, v_ in by_path_.items() if v_ == "love"]
        want_ban = [p_ for p_, v_ in by_path_.items() if v_ == "never"]
        check("taste_test results --apply: the loved sound goes to taste.json love, the never sound to ban (the picker "
              "then never takes it), the others are notes; the ratings are kept",
              ok_ts and sorted(taste_.get("love", [])) == sorted(want_love) and sorted(taste_.get("ban", [])) == sorted(want_ban)
              and len(taste_.get("notes", {})) == len(by_path_) and (tt / "ratings.json").exists()
              and not taste_.get("not_for")
              and "the same sound twice: same 1 of 1" in r_ts.stdout, r_ts.stdout[-300:].replace("\n", " | "))
        # "not here" in ONE picture is not yet "not for this role" (the next picture often said ok); in two it is:
        # the same answers once more under another picture (another round title) make it so. The picker then ranks
        # that sound lower in that role only, never bans it; the better-for chips are kept
        shutil.copytree(tt / "out", tt / "out2")
        m2_ = json.loads((tt / "out2" / "page" / "manifest.json").read_text(encoding="utf-8"))
        m2_["title"] = "the same sounds in another picture"
        (tt / "out2" / "page" / "manifest.json").write_text(json.dumps(m2_), encoding="utf-8")
        r_t2, ok_t2 = sh([PY, S / "taste_test.py", "results", tt / "out2", "--apply"], env_t)
        taste_ = json.loads((tt / "taste.json").read_text(encoding="utf-8")) if (tt / "taste.json").exists() else {}
        want_nf = [p_ for p_, v_ in by_path_.items() if v_ == "notfit"]
        code_nf = ("import sys, json; sys.path.insert(0, r'%s'); import picker; idx = picker.load_index(); "
                   "t = picker.load_taste(); none = {'ban': [], 'love': [], 'notes': {}}; "      # ({} would load the file)
                   "sc = {r['path']: s for s, r in picker.rank(idx, {'role': 'click'}, taste=none)}; "
                   "sc2 = {r['path']: s for s, r in picker.rank(idx, {'role': 'click'}, taste=t)}; "
                   "print(json.dumps({'before': sc, 'after': sc2}))" % S)
        r_nf, ok_nf = sh([PY, "-c", code_nf], env_t)
        try:
            ba_ = json.loads(r_nf.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            ba_ = {"before": {}, "after": {}}
        nf_path = want_nf[0] if want_nf else ""
        check("taste.json not_for: the sound heard as 'not here' is marked for its role and the picker ranks it 1.2 lower "
              "there (the others by their own taste: loved -1, never gone), better-for kept",
              bool(nf_path) and taste_.get("not_for", {}).get(nf_path) == ["click"]
              and "impact" in (taste_.get("better_for", {}).get(nf_path) or [])
              and abs((ba_["after"].get(nf_path, 0) - ba_["before"].get(nf_path, 0)) - 1.2) < 0.01,
              f"ok {ok_t2} not_for {taste_.get('not_for')} {ba_['before'].get(nf_path)} -> {ba_['after'].get(nf_path)} | "
              f"{(r_t2.stdout + r_t2.stderr)[-260:]}".replace("\n", " | "))
        # repick: a banned sound is swapped for the best of its role, a loved one stays
        if want_ban and want_love:
            (tt / "rp.json").write_text(json.dumps({"cues": [
                {"t": 1.0, "label": "a", "file": want_ban[0], "role": "click"},
                {"t": 2.0, "label": "b", "file": want_love[0], "role": "click"}]}), encoding="utf-8")
            r_rp, ok_rp = sh([PY, S / "sheet.py", "repick", tt / "rp.json"], env_t)
            rp_ = json.loads((tt / "rp.json").read_text(encoding="utf-8"))["cues"]
            check("sheet.py repick: a banned sound is swapped for the best of its role (by id), a loved one stays",
                  ok_rp and "file" not in rp_[0] and rp_[0].get("id") and rp_[1].get("file") == want_love[0]
                  and "1 sound(s) swapped" in r_rp.stdout, r_rp.stdout[-200:].replace("\n", " | "))
        import taste_test as TT_
        led_, ban_, nf_, bf_, _ = TT_.effective({"sounds": {
            "a::p1": {"history": [{"verdict": "love"}]},
            "a::p2": {"history": [{"verdict": "notfit"}, {"verdict": "notfit"}]},       # two pictures running: not for
            "a::p3": {"history": [{"verdict": "notfit"}, {"verdict": "ok"}]},           # the next picture said ok
            "a::p4": {"history": [{"verdict": "never"}]}, "b::p4": {"history": [{"verdict": "ok"}]},   # liked elsewhere
            "a::p5": {"history": [{"verdict": "never"}]},
            "a::p6": {"history": [{"verdict": "notfit"}], "use": ["impact"]}}})
        check("taste_test effective: love = the latest verdict, ban = never and liked nowhere else, not_for = never "
              "but liked elsewhere, or not here in two pictures running (one picture is not enough)",
              led_ == {"p1"} and ban_ == {"p5"} and nf_ == {"p2": ["a"], "p4": ["a"]} and "p6" in bf_,
              f"{led_} {ban_} {nf_} {bf_}")
        # the interface sound packs against the library, on one picture: which pack for a cue, library or pack
        TT_.effective({"sounds": {
            "uisfx_press::uisfx:zen/press": {"history": [{"verdict": "love"}]},
            "uisfx_press::uisfx:studio/press": {"history": [{"verdict": "ok"}]},
            "uisfx_press::uisfx:arcade/press": {"history": [{"verdict": "none", "reasons": ["synthetic"]}]},
            "uisfx_press::uisfx:glass/press": {"history": [{"verdict": "none", "reasons": ["synthetic"]}]},
            "uisfx_press::/lib/Click A.wav": {"history": [{"verdict": "love"}]},
            "uisfx_press::/lib/Click B.wav": {"history": [{"verdict": "love"}]},
            "uisfx_select::uisfx:studio/select": {"history": [{"verdict": "love"}]},
            "uisfx_select::uisfx:zen/select": {"history": [{"verdict": "love"}]},
            "uisfx_select::uisfx:arcade/select": {"history": [{"verdict": "ok"}]},
            "uisfx_select::uisfx:glass/select": {"history": [{"verdict": "ok"}]},
            "uisfx_select::/lib/Ui A.wav": {"history": [{"verdict": "love"}]},
            "uisfx_select::/lib/Ui B.wav": {"history": [{"verdict": "ok"}]}}})
        from search import taste_pack, taste_ui_source
        check("taste_test effective + search: a cue the packs lose to the library is `library` (press), a cue they "
              "hold their own in has no preference (select), `synthetic` with no verdict counts against a pack; "
              "taste_pack takes the best pack and keeps the default on a tie; notification takes success's verdict",
              TT_.effective.ui_source == {"press": "library"}
              and TT_.effective.uisfx["press"] == {"zen": "love", "studio": "ok", "arcade": "notfit", "glass": "notfit"}
              and taste_pack({"uisfx": {"press": {"zen": "love", "studio": "ok"}}}, "press", "studio") == "zen"
              and taste_pack({"uisfx": {"select": {"zen": "love", "studio": "love"}}}, "select", "studio") == "studio"
              and taste_pack({}, "press", "studio") == "studio"
              and taste_ui_source({"ui_source": {"success": "library"}}, "notification") == "library",
              f"{TT_.effective.ui_source} {TT_.effective.uisfx.get('press')}")
        (tt / "ev.json").write_text(json.dumps([{"t": 1.0, "type": "click"}, {"t": 2.0, "type": "click"}]), encoding="utf-8")
        t_back = json.loads((tt / "taste.json").read_text(encoding="utf-8"))
        routes_v = {}
        for variant_, src_ in (("without", {}), ("with", {"press": "library"})):
            (tt / "taste_v.json").write_text(json.dumps(dict(t_back, ui_source=src_)), encoding="utf-8")
            r_fc, _ = sh([PY, S / "from_cues.py", tt / "ev.json", "--out", tt / f"fc_{variant_}.json", "--no-check"],
                         dict(env_t, REAL_SFX_TASTE=str(tt / "taste_v.json")))
            routes_v[variant_] = next((l_ for l_ in r_fc.stdout.splitlines() if l_.startswith("routes:")), "")
        check("from_cues: with `ui_source: press = library` in the taste a click is a library sound, without it the "
              "uisfx press (--ui uisfx still forces the pack)",
              "click -> uisfx:press" in routes_v["without"] and "click -> library:click" in routes_v["with"], str(routes_v))
        # drum fills are not clicks / UI sounds / pops / chimes (they stay available as hits)
        code_df = ("import sys, json, copy; sys.path.insert(0, r'%s'); import picker; idx = picker.load_index(); "
                   "r = copy.deepcopy(idx[0]); r.update(id=99999, path=r['path'] + '.fill', name='MA Originals Drum Fills slow-002', "
                   "roles=['ui', 'pop', 'hit'], role='hit'); idx.append(r); "
                   "has = lambda role: any(x['id'] == 99999 for _, x in picker.rank(idx, {'role': role}, taste={})); "
                   "print(json.dumps({role: has(role) for role in ('ui', 'pop', 'hit')}))" % S)
        r_df, ok_df = sh([PY, "-c", code_df], env_t)
        try:
            df_ = json.loads(r_df.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            df_ = {}
        check("picker: a musical drum fill is kept out of the ui and pop pools and stays a hit",
              ok_df and df_.get("ui") is False and df_.get("pop") is False and df_.get("hit") is True, str(df_))
        # round 8: a LOVED sound passes the name guards (the person's love beats a name); the error and cartoon guards
        code_lv = ("import sys, json, copy; sys.path.insert(0, r'%s'); import picker; idx = picker.load_index(); "
                   "r = copy.deepcopy(idx[0]); r.update(id=99999, path=r['path'] + '.fill', name='MA Originals Drum Fills slow-002', "
                   "roles=['ui', 'pop', 'hit'], role='hit'); idx.append(r); "
                   "none = {'ban': [], 'love': [], 'notes': {}}; loved = {'ban': [], 'love': [r['path']], 'notes': {}}; "
                   "has = lambda role, tt: any(x['id'] == 99999 for _, x in picker.rank(idx, {'role': role}, taste=tt)); "
                   "print(json.dumps({'loved': [has(role, loved) for role in ('ui', 'pop')], "
                   "'plain': [has(role, none) for role in ('ui', 'pop')]}))" % S)
        r_lv, ok_lv = sh([PY, "-c", code_lv], env_t)
        try:
            lv_ = json.loads(r_lv.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            lv_ = {}
        check("picker: a loved drum fill passes the name guard in ui and pop, an unloved one does not",
              ok_lv and lv_.get("loved") == [True, True] and lv_.get("plain") == [False, False], str(lv_))
        code_gd = ("import sys, json, copy; sys.path.insert(0, r'%s'); import picker; idx = picker.load_index(); "
                   "r = copy.deepcopy(idx[0]); r.update(id=99998, path=r['path'] + '.beep', name='Censor Beeps-2', "
                   "roles=['error'], role='error'); "
                   "q = copy.deepcopy(idx[0]); q.update(id=99997, path=q['path'] + '.str', name='Cartoon Rubber Stretch 3', "
                   "roles=['cartoon'], role='cartoon'); idx += [r, q]; none = {'ban': [], 'love': [], 'notes': {}}; "
                   "has = lambda i, spec: any(x['id'] == i for _, x in picker.rank(idx, spec, taste=none)); "
                   "print(json.dumps({'error': has(99998, {'role': 'error'}), "
                   "'error_asked': has(99998, {'role': 'error', 'query': 'censor'}), "
                   "'cartoon': has(99997, {'role': 'cartoon'}), "
                   "'cartoon_asked': has(99997, {'role': 'cartoon', 'query': 'stretch'})}))" % S)
        r_gd, ok_gd = sh([PY, "-c", code_gd], env_t)
        try:
            gd_ = json.loads(r_gd.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            gd_ = {}
        check("picker: a censor bleep is kept out of error and a rubber stretch out of cartoon until the words ask for them",
              ok_gd and gd_ == {"error": False, "error_asked": True, "cartoon": False, "cartoon_asked": True}, str(gd_))
        code_tw = ("import sys, json, copy; sys.path.insert(0, r'%s'); import picker; idx = picker.load_index(); "
                   "a = copy.deepcopy(idx[0]); b = copy.deepcopy(idx[0]); c = copy.deepcopy(idx[1]); "
                   "a.update(id=99991, path=a['path'] + '.a', dup_key='twin-x'); b.update(id=99992, path=b['path'] + '.b', dup_key='twin-x'); "
                   "c.update(id=99993, path=c['path'] + '.c', dup_key='other'); idx += [a, b, c]; "
                   "print(json.dumps({'both': sorted(picker.twins_of([a['path']], idx)) == sorted([a['path'], b['path']]), "
                   "'alone': sorted(picker.twins_of([c['path']], idx)) == [c['path']], "
                   "'unknown': sorted(picker.twins_of(['no/such/file'], idx)) == ['no/such/file']}))" % S)
        r_tw, ok_tw = sh([PY, "-c", code_tw], env_t)
        try:
            tw_ = json.loads(r_tw.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            tw_ = {}
        check("picker.twins_of: a ban or a love of one copy of a recording covers its twins (the same dup_key), nothing else",
              ok_tw and tw_.get("both") is True and tw_.get("alone") is True and tw_.get("unknown") is True, str(tw_))

        # the masking model: numpy lives in the skill's venv (or REAL_SFX_VENV_PYTHON)
        import common as CM_
        vpy = CM_.venv_python()
        if vpy is None:
            check("maskmodel (skipped: no numpy; `listen.py install --yes` makes the skill's venv)", True)
        else:
            mk = root / "mask"
            (mk / "clips").mkdir(parents=True)
            rows_m = [("sfx-000_bed.wav", 0.0, 6.0, "bed", True,
                       "anoisesrc=d=6:c=brown:r=48000,lowpass=f=140,volume=0.8"),
                      ("sfx-001_hit.wav", 1.0, 0.5, "hit", False, "sine=f=1800:d=0.5:r=48000,volume=0.5,afade=t=out:d=0.4"),
                      ("sfx-002_click.wav", 2.5, 0.2, "click", False,
                       "anoisesrc=d=0.2:c=white:r=48000,highpass=f=3000,volume=0.25,afade=t=out:d=0.19"),
                      ("sfx-003_thump.wav", 4.0, 0.4, "hit", False, "sine=f=70:d=0.4:r=48000,volume=0.5,afade=t=out:d=0.3")]
            meta_m = []
            for i_, (fn_, st_, du_, role_, bed_, src_) in enumerate(rows_m):
                ff(["-f", "lavfi", "-i", src_, "-ac", "2", "-ar", "48000", "-c:a", "pcm_s24le", mk / "clips" / fn_])
                meta_m.append({"id": f"sfx-{i_:03d}", "file": fn_, "start": st_, "duration": du_, "t_moment": st_,
                               "role": role_, "label": fn_[8:-4], "lane": 0, "bed": bed_, "texture": False, "layer": False})
            (mk / "clips" / "sfx_clips.json").write_text(json.dumps(meta_m), encoding="utf-8")
            (mk / "res.json").write_text(json.dumps({"duration": 6.0, "bed": {"floor_db": -24}, "cues": []}),
                                         encoding="utf-8")
            r_mm, ok_mm = sh([vpy, S / "maskmodel.py", mk / "res.json", mk / "clips", "--gain-db", "0", "--json",
                              mk / "out.json"], env)
            try:
                mo_ = {c_["label"]: c_ for c_ in json.loads((mk / "out.json").read_text(encoding="utf-8"))["cues"]}
            except (OSError, ValueError, KeyError):
                mo_ = {}
            hit_, clk_, thp_ = mo_.get("hit", {}), mo_.get("click", {}), mo_.get("thump", {})
            check("maskmodel: a sound far from the bed in frequency is clear, a quiet low thump under a low bed is "
                  "masked by the bed and the bed costs it its margin",
                  ok_mm and clk_.get("class") == "clear" and hit_.get("class") == "clear"
                  and thp_.get("class") in ("masked", "marginal") and thp_.get("masked_by", {}).get("bed", 0) > 0.5
                  and thp_.get("bed_cost_db", 0) > 10 and thp_.get("margin_wo_bed_db", -99) > thp_.get("margin_db", 99),
                  {k_: (v_.get("margin_db"), v_.get("class"), v_.get("bed_cost_db")) for k_, v_ in mo_.items()}
                  if mo_ else (r_mm.stdout + r_mm.stderr)[-200:])
            # the same through mix.py --masking and the critique (a bed makes the model's answer interesting)
            (bd / "mask.json").write_text(json.dumps({"duration": 12.0, "keep_audio": "no", "cues": cues_b}),
                                          encoding="utf-8")
            sh([PY, S / "bed.py", bd / "mask.json"], env_b)
            env_m = dict(env_b, REAL_SFX_VENV_PYTHON=str(vpy))
            r_mx, ok_mx = sh([PY, S / "mix.py", bd / "mask.json", "--out", bd / "om" / "m.mp4", "--masking"], env_m)
            res_m = json.loads((bd / "om" / "m_resolved_cues.json").read_text(encoding="utf-8")) if ok_mx else {}
            c_mx, _ = sh([PY, S / "critique.py", bd / "om" / "m_resolved_cues.json", bd / "om" / "m_sfx_track.wav"], env_m,
                         ok_codes=(0, 1))
            check("mix.py --masking: the model runs on the exported cues, the answer is in the resolved cues and the "
                  "critique prints it",
                  ok_mx and bool((res_m.get("masking") or {}).get("summary")) and "Masking model" in r_mx.stdout
                  and "Masking model" in c_mx.stdout, (r_mx.stdout + r_mx.stderr)[-200:].replace("\n", " | "))

        # the caption model (hear.py) is optional and big: it says so, and downloads nothing without --yes
        env_h = dict(env, REAL_SFX_AUDIOLM_HOME=str(root / "no_audiolm"))
        r_hs, ok_hs = sh([PY, S / "hear.py", "status"], env_h)
        r_hi, _ = sh([PY, S / "hear.py", "install"], env_h, ok_codes=(0, 1))
        check("hear.py: not installed says so and names the size; install without --yes downloads nothing",
              ok_hs and "not installed" in r_hs.stdout and "3.1 GB" in r_hs.stdout and r_hi.returncode != 0
              and "--yes" in (r_hi.stdout + r_hi.stderr) and not (root / "no_audiolm").exists(),
              (r_hs.stdout + r_hi.stderr)[-160:].replace("\n", " | "))

        # 16 setup check and ears level 1
        r, ok = sh([PY, S / "setup.py", "check"], env, ok_codes=(0, 1))
        check("setup.py check reports the fixture library", "fixture" in r.stdout and "16 audio files" in r.stdout)
        r, ok = sh([PY, S / "listen.py", "describe", lib / "Hits and impacts" / "Hit 1.wav"], env)
        check("listen.py describe gives words", ok and "in words:" in r.stdout)
    finally:
        if a.keep:
            print("kept:", root)
        else:
            shutil.rmtree(root, ignore_errors=True)

    bad = [n for n, ok, _ in results if not ok]
    print(f"\n{len(results) - len(bad)}/{len(results)} checks passed in {time.time() - t0:.0f} s")
    if bad:
        print("FAILED:", "; ".join(bad))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
