#!/usr/bin/env python3
"""The skill's ears: describe what a sound is, in words, without playing it.

  listen.py status                         what works now and what an install would add
  listen.py describe FILE [--sheet PNG]    numbers, plain words, a picture and (if installed) AudioSet tags
  listen.py tag-index                      add tags + embeddings for every indexed sound (needs install)
  listen.py compare A B                    how alike two sounds are
  listen.py onsets FILE                    where separate sounds start inside a recording (and their slices)
  listen.py install --yes                  create vendor/venv, install onnxruntime + numpy, fetch yamnet.onnx

Two levels of "hearing":
  1. always available, no downloads: measured character -> words (punchy / dark / heavy / long-tail ...)
     plus the spectrogram picture that the model can look at (contact_sheet.py / --sheet).
  2. after `install --yes` (about 45 MB, runs on CPU in the skill's own venv, nothing else on the system
     is touched): YAMNet gives the 521 AudioSet labels per second of audio (Whoosh, Explosion, Click,
     Glass, Typing ...) and a 1024-number embedding, so sounds can be found and compared by meaning.

`install` is never run implicitly. It downloads: onnxruntime and numpy wheels from PyPI (~25 MB) and
yamnet.onnx (16.1 MB, Apache-2.0, https://huggingface.co/audiomagic/yamnet-onnx) with its class map.
"""
import argparse
import csv
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import SKILL_DIR, analyse_sound, index_path, load_config, words

VENV = SKILL_DIR / "vendor" / "venv"
MODEL_DIR = SKILL_DIR / "vendor" / "models"
MODEL = MODEL_DIR / "yamnet.onnx"
CLASSES = MODEL_DIR / "yamnet_class_map.csv"
MODEL_URL = "https://huggingface.co/audiomagic/yamnet-onnx/resolve/main/yamnet.onnx"
CLASSES_URL = "https://huggingface.co/audiomagic/yamnet-onnx/resolve/main/yamnet_class_map.csv"
MODEL_BYTES = 16_093_355
EMB_BIN = SKILL_DIR / "library_embeddings.bin"
EMB_JSON = SKILL_DIR / "library_embeddings.json"


def venv_python():
    from common import venv_python as _venv_python         # one place, with REAL_SFX_VENV_PYTHON
    return _venv_python()


def have_runtime():
    try:
        import numpy  # noqa: F401
        import onnxruntime  # noqa: F401
        return True
    except Exception:
        return False


def reexec_in_venv():
    """Heavy commands run inside the skill's venv, so the system Python stays untouched."""
    py = venv_python()
    if py and Path(sys.executable).resolve() != py.resolve():
        raise SystemExit(subprocess.call([str(py), __file__] + sys.argv[1:]))


def status():
    print("ears, level 1 (always on): measured character -> words, spectrogram pictures")
    print(f"ears, level 2 (YAMNet tags + embeddings): "
          f"{'READY' if MODEL.exists() and (have_runtime() or venv_python()) else 'not installed'}")
    print(f"  model file     : {'yes' if MODEL.exists() else 'no'}  {MODEL}")
    print(f"  venv           : {'yes' if venv_python() else 'no'}  {VENV}")
    print(f"  runtime in use : {'yes' if have_runtime() else 'no (will use venv if present)'}")
    emb = EMB_BIN.exists()
    print(f"  library tagged : {'yes' if emb else 'no'}")
    if not (MODEL.exists() and venv_python()):
        print("\nTo add level 2 (about 45 MB, asks nothing else of the system):\n"
              f"  python {Path(__file__).name} install --yes")


def install(yes):
    if not yes:
        sys.exit("install downloads ~45 MB (onnxruntime, numpy, yamnet.onnx); run again with --yes to confirm")
    if not venv_python():
        print("creating venv ...", flush=True)
        subprocess.check_call([sys.executable, "-m", "venv", str(VENV)])
    py = venv_python()
    print("installing onnxruntime and numpy into the skill's venv ...", flush=True)
    subprocess.check_call([str(py), "-m", "pip", "install", "--disable-pip-version-check", "-q", "onnxruntime", "numpy"])
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    for url, dst in ((MODEL_URL, MODEL), (CLASSES_URL, CLASSES)):
        if dst.exists() and (dst != MODEL or dst.stat().st_size == MODEL_BYTES):
            continue
        print(f"downloading {dst.name} ...", flush=True)
        urllib.request.urlretrieve(url, dst)
    if MODEL.stat().st_size != MODEL_BYTES:
        MODEL.unlink()
        sys.exit("yamnet.onnx has an unexpected size, removed it; try again or check the connection")
    print("done. try:  listen.py describe <file>")


# ------------------------------------------------------------------ YAMNet
class Yamnet:
    def __init__(self):
        import numpy as np
        import onnxruntime as ort
        self.np = np
        self.sess = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
        with open(CLASSES, encoding="utf-8") as f:
            rows = list(csv.reader(f))
        self.names = [r[2] for r in rows[1:]]

    def run(self, path, max_seconds=12.0):
        np = self.np
        r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "1", "-ar", "16000",
                            "-t", f"{max_seconds:.2f}", "-f", "f32le", "-"], capture_output=True)
        x = np.frombuffer(r.stdout, dtype="<f4")
        if len(x) < 480:                        # under 30 ms: nothing to listen to
            return None
        if len(x) < 15600:                      # the model needs about one frame (0.975 s): pad short sounds
            x = np.concatenate([x, np.zeros(15600 - len(x), dtype="<f4")])
        scores, emb, _ = self.sess.run(None, {"waveform": x.astype("float32")})
        return scores, emb

    # classes that describe the surroundings or the absence of sound, not the sound
    STOP = {"Silence", "Sound effect", "Inside, small room", "Inside, large room or hall", "Inside, public space",
            "Outside, urban or manmade", "Outside, rural or natural", "Environmental noise", "Static"}

    def tags(self, path, top=6, active_s=None):
        """Top AudioSet classes and the mean embedding of the AUDIBLE part (pack files carry seconds of silence
        after the sound, and 'Silence 100 %' tells nothing about what the sound is)."""
        limit = 12.0
        if active_s:
            limit = min(limit, max(1.0, active_s + 0.1))
        out = self.run(path, limit)
        if out is None:
            return [], None
        scores, emb = out
        np = self.np
        peak = scores.max(axis=0)
        order = np.argsort(-peak)
        tags = [(self.names[i], float(peak[i])) for i in order if peak[i] > 0.08 and self.names[i] not in self.STOP][:top]
        return tags, emb.mean(axis=0)


def describe(path, sheet=None, top=6):
    p = Path(path)
    if not p.exists():
        sys.exit(f"file not found: {p}")
    info = analyse_sound(p)
    if not info:
        sys.exit(f"cannot decode {p}")
    info["words"] = words(info)
    print(f"{p.name}")
    print(f"  length {info['duration']}s  peak {info['peak_db']} dBFS  loudest point at {info['peak_time']}s")
    print(f"  attack {info['attack_ms']} ms, tail {info['decay_ms']} ms, centroid {info['centroid']} Hz, "
          f"low-end share {info['low']}, noisiness {info['flat']}")
    print(f"  in words: {', '.join(info['words'])}")
    if MODEL.exists() and (have_runtime() or venv_python()):
        if not have_runtime():
            reexec_in_venv()
        tags, _ = Yamnet().tags(p, top, info.get("active_dur"))
        if tags:
            print("  tags    : " + "; ".join(f"{n} ({s:.0%})" for n, s in tags))
    else:
        print("  tags    : (level 2 not installed: listen.py install --yes)")
    if sheet:
        from contact_sheet import render_sheet
        rec = dict(info, id=0, path=str(p), role="?", library="file", name=p.stem, folder="")
        print("  picture :", render_sheet([rec], sheet, 1))


def voice_cmd(path):
    """JSON line: share of the file in which YAMNet hears speech / music (frames with a score of 0.35 or more)."""
    if not (MODEL.exists() and (have_runtime() or venv_python())):
        sys.exit("level 2 is not installed: listen.py install --yes")
    if not have_runtime():
        reexec_in_venv()
    y = Yamnet()
    out = y.run(path, max_seconds=240.0)
    if out is None:
        sys.exit("nothing to listen to")
    scores, _ = out
    np = y.np
    names = y.names

    def share(*cls):
        idx = [i for i, n in enumerate(names) if n in cls]
        return float(np.mean(np.max(scores[:, idx], axis=1) >= 0.35)) if idx else 0.0
    print(json.dumps({"speech": round(share("Speech", "Narration, monologue", "Conversation"), 3),
                      "music": round(share("Music"), 3), "seconds": round(len(scores) * 0.48, 1)}))


def tag_index():
    if not (MODEL.exists() and (have_runtime() or venv_python())):
        sys.exit("level 2 is not installed: listen.py install --yes")
    if not have_runtime():
        reexec_in_venv()
    import array
    y = Yamnet()
    idx_file = index_path(load_config())
    data = json.loads(idx_file.read_text(encoding="utf-8"))
    sounds = data["sounds"]
    old = {}
    if EMB_JSON.exists() and EMB_BIN.exists():
        paths = json.loads(EMB_JSON.read_text(encoding="utf-8"))["paths"]
        raw = array.array("f")
        raw.frombytes(EMB_BIN.read_bytes())
        for i, pth in enumerate(paths):
            old[pth] = list(raw[i * 1024:(i + 1) * 1024])
    emb_out, paths_out = array.array("f"), []
    done = 0
    for n, s in enumerate(sounds):
        pth = s["path"]
        if pth in old and s.get("tags") is not None and s.get("tags_v") == 3:
            e = old[pth]
        else:
            tags, e = y.tags(pth, 5, s.get("active_dur"))
            s["tags_v"] = 3
            s["tags"] = [t for t, _ in tags]
            s["tag_scores"] = [round(c, 2) for _, c in tags]
            e = e.tolist() if e is not None else None
            done += 1
        if e is None:
            continue
        emb_out.extend(e)
        paths_out.append(pth)
        if n % 100 == 0:
            print(f"  {n}/{len(sounds)}", flush=True)
    idx_file.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    EMB_BIN.write_bytes(emb_out.tobytes())
    EMB_JSON.write_text(json.dumps({"dim": 1024, "paths": paths_out}), encoding="utf-8")
    print(f"tagged {done} new sounds, {len(paths_out)} embeddings in {EMB_BIN.name}")


def onsets_cmd(path, min_level):
    """Where do the separate sounds inside a recording start (keystrokes, knocks, ticks)? Times and levels, and the
    cue-sheet slice for each one. Works at level 1, no model needed. FILE can be an id from search.py."""
    from common import clean_hits, onsets
    if not Path(str(path)).exists() and str(path).isdigit():
        try:
            from picker import find, load_index
            rec = find(load_index(), int(path))
        except SystemExit:
            rec = None
        if rec is None:
            sys.exit(f"no sound with id {path} in the index (and no file of that name)")
        print(f"id {path}: {rec['path']}")
        path = rec["path"]
    ons, dur = onsets(path)
    ons = [(t, lvl) for t, lvl in ons if lvl >= min_level]
    print(f"{Path(path).name}: {dur:.2f} s, {len(ons)} sounds (level in dB under the loudest of the recording)")
    for i, (t, lvl) in enumerate(ons):
        nxt = ons[i + 1][0] if i + 1 < len(ons) else t + 0.2
        ln = round(min(0.12, max(0.04, nxt - t - 0.004)), 3)
        print(f"  {i:2d}  {t:6.3f} s  {lvl:+5.1f} dB   \"slice\": [{max(0.0, t - 0.006):.3f}, {ln}]")
    print("use in a cue: {\"file\": \"" + str(path).replace("\\", "/") + "\", \"slice\": [start, length], "
          "\"role\": \"hit\", \"anchor\": \"start\"}")
    hits, _ = clean_hits(path)
    good = [h for h in hits if h["clean"]]
    print(f"clean single hits (out of silence, dying away, no second hit within 150 ms): {len(good)} of {len(hits)}")
    for h in good:
        print(f"   t {h['t']:6.3f} s  {h['level_db']:+5.1f} dB  decay {h['decay_ms']:3d} ms   "
              f"\"slice\": [{h['start']:.3f}, {h['len']:.3f}]")
    if hits and not good:
        print("   (none: every hit is a tumble or rides on the one before it; take another recording)")


def compare(a, b):
    ia, ib = analyse_sound(a), analyse_sound(b)
    keys = ("centroid", "rolloff", "low", "high", "flat", "attack_ms", "decay_ms", "duration")
    import math
    d = 0.0
    for k in keys:
        x, y = float(ia[k]), float(ib[k])
        if k in ("centroid", "rolloff", "attack_ms", "decay_ms", "duration"):
            x, y = math.log1p(x), math.log1p(y)
        d += (x - y) ** 2
    print(f"character distance {math.sqrt(d / len(keys)):.2f} (0 = same, >1.5 = clearly different)")
    print(f"  A: {', '.join(words(ia))}\n  B: {', '.join(words(ib))}")
    if MODEL.exists() and (have_runtime() or venv_python()):
        if not have_runtime():
            reexec_in_venv()
        y = Yamnet()
        _, ea = y.tags(a, 6, ia.get("active_dur"))
        _, eb = y.tags(b, 6, ib.get("active_dur"))
        if ea is not None and eb is not None:
            np = y.np
            cos = float(np.dot(ea, eb) / (np.linalg.norm(ea) * np.linalg.norm(eb) + 1e-9))
            print(f"semantic similarity (YAMNet embedding cosine) {cos:.2f} (1 = same kind of sound)")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    i = sub.add_parser("install")
    i.add_argument("--yes", action="store_true")
    d = sub.add_parser("describe")
    d.add_argument("file")
    d.add_argument("--sheet")
    d.add_argument("--top", type=int, default=6)
    sub.add_parser("tag-index")
    v = sub.add_parser("voice")
    v.add_argument("file")
    o = sub.add_parser("onsets")
    o.add_argument("file")
    o.add_argument("--min-level", type=float, default=-24.0)
    c = sub.add_parser("compare")
    c.add_argument("a")
    c.add_argument("b")
    a = ap.parse_args()
    # the heavy commands run in the skill's venv; switch BEFORE anything is printed (the block was printed twice)
    if a.cmd in ("describe", "compare", "tag-index", "voice") and MODEL.exists() and not have_runtime() \
            and venv_python():
        reexec_in_venv()
    {"status": lambda: status(), "install": lambda: install(a.yes),
     "describe": lambda: describe(a.file, a.sheet, a.top), "tag-index": tag_index,
     "compare": lambda: compare(a.a, a.b), "onsets": lambda: onsets_cmd(a.file, a.min_level),
     "voice": lambda: voice_cmd(a.file)}[a.cmd]()


if __name__ == "__main__":
    main()
