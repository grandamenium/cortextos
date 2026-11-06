#!/usr/bin/env python3
"""A model that describes a sound in words, locally, on the CPU: MiDashengLM-0.6B (Xiaomi, Apache-2.0).

  python hear.py status
  python hear.py install --yes                       # ~3.1 GB: a venv of its own, the model at a pinned revision
  python hear.py describe FILE [--span T0 T1] [--ask "question"] [--tokens 80]
  python hear.py bench [--n 2] [--json OUT]          # does it tell what we need told? library sounds + synthetic cases

Why. Claude takes no audio in here. A caption model is a middleman: it turns a sound into words ("a short dry click,
then a low hum") that can be read, compared and asked questions. It is small, it is not a person: it can be wrong,
and the way to find out how wrong for THIS skill's questions is `bench`, which uses sounds whose truth is known (the
category of a library sound, a bed that is there or is not, how many clicks, which of two is louder). Nothing is
built into the critique before that answer is in.

What `bench` showed (2026-10-15, this model, CPU, 1.3 s per answer after a 2 s load; 51 questions on known sounds):
  * what kind of sound: 12 of 27 right. Impacts and drums 3/3, glass 3/3, typing 2/3; whoosh, click, pop, riser 1/3 each,
    paper 0/3, ambience 0/3 (a bell for a room tone, a vacuum cleaner for a whoosh). Part of that is the library's own
    labels, part is the model.
  * is there a hum under the sounds (yes / no): 6 of 12 = chance, it answers "yes" to everything.
  * how many separate clicks: 0 of 6, it answers "1" to everything. Which of two is louder: 3 of 6 = chance, "first".
  * the same bed question as a caption (the task it was trained on): the caption of a dry sound never mentions a hum or
    a background (0 of 8), the caption of the same sound over a bed does in 3-4 of 8: no false alarms, and it misses more
    than half. Captions also invent things (a cat, a person speaking).
So it is NOT an ear for what this skill needs told (is the bed there, how many, how loud against what): that is what
measuring is for (the critique, the masking model). It can be a rough second opinion on WHAT a sound is, and it is not
built into the critique. A larger model might do better on the category; counting and loudness are hard for any of them.

Where it lives. `vendor/venv-audiolm` (torch CPU, transformers 4.57, numpy: not the skill's other venv) and
`vendor/models/midashenglm-0.6b`, both left out of the package. REAL_SFX_AUDIOLM_HOME names another folder for them.
The model's own python files run on load (trust_remote_code): the revision is pinned, the files were read, and their
SHA-256 are in CODE_SHA256 below; the model is refused when one differs. It runs offline.
"""
import argparse
import hashlib
import json
import os
import random
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import SKILL_DIR

HOME = Path(os.environ.get("REAL_SFX_AUDIOLM_HOME") or (SKILL_DIR / "vendor"))
VENV = HOME / "venv-audiolm"
MODEL_DIR = HOME / "models" / "midashenglm-0.6b"
REPO = "mispeech/midashenglm-0.6b-fp32"
REVISION = "3969e451d1c62618089c1135fe4c58ed33af2457"           # 2026-04-03
FILES = {"model.safetensors": 2748851080}                       # size in bytes
CODE_FILES = ("configuration_midashenglm.py", "modeling_midashenglm.py", "processing_midashenglm.py")
# the three python files of the model, READ IN FULL on 2026-10-15 (revision above): model definition, config and
# processor; no network, no subprocess, no eval/exec, no pickle, no file writes, no environment reads
CODE_SHA256 = {
    "configuration_midashenglm.py": "ca740ad2dd13be0deea2e76c418ffc06f5734b2a0e446b828ae421d100dce6d2",
    "modeling_midashenglm.py": "0d0b62bd987fea96785b963f91d89dc8a2661f16e7eb45e50ddbb9123adc238e",
    "processing_midashenglm.py": "926d1a81d60b4ba1f64a027719201e8cd08c4af808dc6c92bb4e0776b85ee1b4",
}
PIP_TORCH = ["torch==2.11.0", "torchaudio==2.11.0"]
PIP_REST = ["transformers==4.57.6", "numpy", "huggingface_hub"]
DEFAULT_ASK = "Describe this sound: what it is, how it starts and ends, whether it is dark or bright, clean or noisy. One or two sentences."


def venv_py():
    p = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    return p if p.exists() else None


def sha256(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def have_model():
    return all((MODEL_DIR / f).exists() and (MODEL_DIR / f).stat().st_size == n for f, n in FILES.items()) and \
        all((MODEL_DIR / f).exists() for f in CODE_FILES)


def status():
    print(f"audio-language model (MiDashengLM-0.6B, CPU): {'READY' if venv_py() and have_model() else 'not installed'}")
    print(f"  venv   : {'yes' if venv_py() else 'no'}  {VENV}")
    print(f"  model  : {'yes' if have_model() else 'no'}  {MODEL_DIR}  ({REPO} @ {REVISION[:8]})")
    if have_model():
        for f in CODE_FILES:
            h = sha256(MODEL_DIR / f)
            ok = CODE_SHA256.get(f) == h
            print(f"  code   : {f}  {h[:16]}  {'matches the reviewed file' if ok else 'NOT REVIEWED / CHANGED'}")
    if not (venv_py() and have_model()):
        print(f"\nTo install (about 3.1 GB: the model 2.75 GB, torch CPU 0.2 GB, the rest 0.1 GB):\n"
              f"  python {Path(__file__).name} install --yes")


def install(yes):
    if not yes:
        sys.exit("install downloads about 3.1 GB (the model 2.75 GB from huggingface.co, torch and transformers into a new "
                 "venv); run again with --yes to confirm")
    if not venv_py():
        print("creating the venv ...", flush=True)
        VENV.parent.mkdir(parents=True, exist_ok=True)
        subprocess.check_call([sys.executable, "-m", "venv", str(VENV)])
    py = str(venv_py())
    print("installing torch and torchaudio (CPU) ...", flush=True)
    subprocess.check_call([py, "-m", "pip", "install", "--disable-pip-version-check", "-q", "--index-url",
                           "https://download.pytorch.org/whl/cpu"] + PIP_TORCH)
    print("installing transformers, numpy, huggingface_hub ...", flush=True)
    subprocess.check_call([py, "-m", "pip", "install", "--disable-pip-version-check", "-q"] + PIP_REST)
    print(f"downloading {REPO} @ {REVISION[:8]} ...", flush=True)
    code = ("from huggingface_hub import snapshot_download; "
            f"snapshot_download(repo_id={REPO!r}, revision={REVISION!r}, local_dir=r'{MODEL_DIR}', "
            "allow_patterns=['*.json','*.py','*.safetensors','*.jinja','merges.txt','vocab.json','LICENSE*'])")
    MODEL_DIR.parent.mkdir(parents=True, exist_ok=True)
    subprocess.check_call([py, "-c", code])
    bad = [f for f, n in FILES.items() if not (MODEL_DIR / f).exists() or (MODEL_DIR / f).stat().st_size != n]
    if bad:
        sys.exit(f"the download is incomplete or not the expected files: {bad}")
    print("done. The model's own python files, to be read before the first run:")
    for f in CODE_FILES:
        print(f"  {MODEL_DIR / f}  sha256 {sha256(MODEL_DIR / f)}")
    print("then add the hashes to CODE_SHA256 in this script (or run with --trust-unreviewed once).")


# ------------------------------------------------------------------------------------------------ run (in the venv)
def run_jobs(jobs_path, out_path, trust_unreviewed):
    """Inside the venv: load the model once, answer every job. jobs: [{file, t0, t1, ask, tokens}] -> [{text, secs}]."""
    import time
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    for f in CODE_FILES:
        h = sha256(MODEL_DIR / f)
        if CODE_SHA256.get(f) != h and not trust_unreviewed:
            sys.exit(f"{f} is not the file that was read (sha256 {h[:16]}): not run. Read it, put the hash into "
                     f"CODE_SHA256, or --trust-unreviewed.")
    import numpy as np
    import torch
    from transformers import AutoModelForCausalLM, AutoProcessor, AutoTokenizer
    t_load = time.time()
    model = AutoModelForCausalLM.from_pretrained(str(MODEL_DIR), trust_remote_code=True, local_files_only=True)
    model.eval()
    tok = AutoTokenizer.from_pretrained(str(MODEL_DIR), local_files_only=True)
    proc = AutoProcessor.from_pretrained(str(MODEL_DIR), trust_remote_code=True, local_files_only=True)
    sr = int(getattr(proc, "sampling_rate", None) or proc.feature_extractor.sampling_rate)
    load_s = time.time() - t_load

    def load_audio(path, t0, t1):
        cmd = ["ffmpeg", "-v", "error", "-nostdin"]
        if t0:
            cmd += ["-ss", f"{float(t0):.3f}"]
        cmd += ["-i", str(path)]
        if t1 is not None:
            cmd += ["-t", f"{max(0.1, float(t1) - float(t0 or 0)):.3f}"]
        cmd += ["-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"]
        r = subprocess.run(cmd, capture_output=True)
        x = np.frombuffer(r.stdout, dtype="<f4").astype(np.float32).copy()
        return x[: sr * 60]                                   # one minute is plenty for a question about a moment

    out = []
    for j in json.loads(Path(jobs_path).read_text(encoding="utf-8")):
        t = time.time()
        x = load_audio(j["file"], j.get("t0"), j.get("t1"))
        if x.size < sr // 20:
            out.append({"text": "", "secs": 0.0, "error": "no audio"})
            continue
        msgs = [{"role": "user", "content": [{"type": "text", "text": j.get("ask") or DEFAULT_ASK},
                                             {"type": "audio", "audio": x}]}]
        with torch.no_grad():
            inp = proc.apply_chat_template(msgs, tokenize=True, add_generation_prompt=True, add_special_tokens=True,
                                           return_dict=True).to(device=model.device, dtype=model.dtype)
            gen = model.generate(**inp, max_new_tokens=int(j.get("tokens") or 80), do_sample=False,
                                 repetition_penalty=1.05)
        n_in = inp["input_ids"].shape[1] if "input_ids" in inp else 0
        text = tok.batch_decode(gen[:, n_in:] if gen.shape[1] > n_in else gen, skip_special_tokens=True)[0].strip()
        out.append({"text": text, "secs": round(time.time() - t, 1)})
    Path(out_path).write_text(json.dumps({"load_s": round(load_s, 1), "answers": out}, ensure_ascii=False), encoding="utf-8")


def ask_model(jobs, trust_unreviewed=False):
    """Run jobs through the model in the venv. -> list of {text, secs}."""
    py = venv_py()
    if not py or not have_model():
        sys.exit("the model is not installed: python hear.py install --yes")
    with tempfile.TemporaryDirectory() as td:
        jp, op = Path(td) / "jobs.json", Path(td) / "out.json"
        jp.write_text(json.dumps(jobs, ensure_ascii=False), encoding="utf-8")
        cmd = [str(py), str(Path(__file__).resolve()), "_run", str(jp), str(op)] + \
              (["--trust-unreviewed"] if trust_unreviewed else [])
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                           env=dict(os.environ, PYTHONUTF8="1", REAL_SFX_AUDIOLM_HOME=str(HOME)))
        if r.returncode or not op.exists():
            sys.exit("the model did not run:\n" + (r.stderr or r.stdout)[-1500:])
        return json.loads(op.read_text(encoding="utf-8"))


# ------------------------------------------------------------------------------------------------ bench
KEYWORDS = {
    "whoosh": ("whoosh", "swoosh", "swish", "air", "wind", "sweep", "swipe", "rush", "swipe", "movement"),
    "hit": ("hit", "impact", "thud", "boom", "punch", "slam", "knock", "bang", "thump", "drum", "explosion", "strike"),
    "click": ("click", "tick", "tap", "snap", "button", "switch", "pop", "beep"),
    "pop": ("pop", "bubble", "plop", "burst", "blip", "bloop", "drop", "water", "bubbl"),
    "glass": ("glass", "clink", "ring", "chime", "bell", "shatter", "crystal", "ping", "metal", "tinkl"),
    "paper": ("paper", "rustle", "crumple", "page", "crinkle", "foil", "fabric", "cloth", "scrap", "rub"),
    "typing": ("typing", "keyboard", "key", "type", "tap", "click", "typewriter"),
    "riser": ("rise", "riser", "swell", "build", "sweep", "whoosh", "tension", "increas", "crescendo", "sci"),
    "ambience": ("hum", "drone", "ambient", "noise", "rumble", "room", "wind", "background", "static", "hiss", "engine",
                 "tone", "buzz"),
}


def ffmpeg(args):
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-nostdin"] + [str(a) for a in args], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr[-300:])


def bench(n, json_out, trust_unreviewed):
    from picker import load_index
    index = [s for s in load_index() if s.get("tier", "main") == "main"]
    rnd = random.Random(7)
    td = Path(tempfile.mkdtemp(prefix="hear_bench_"))
    items = []                                              # {kind, truth, file, ask, check}
    # A: what kind of sound is this (the category of the library)
    for role, words in KEYWORDS.items():
        pool = [s for s in index if s.get("role") == role and 0.25 <= (s.get("active_dur") or s.get("duration") or 0) <= 4.0
                and Path(s["path"]).exists()]
        for s in rnd.sample(pool, min(n, len(pool))):
            items.append({"kind": "category", "truth": role, "file": s["path"], "name": s.get("name", ""),
                          "ask": "What kind of sound is this? Answer in one short sentence.", "words": list(words)})
    # B: a bed under short sounds, there or not
    shorts = [s for s in index if s.get("role") in ("click", "pop", "glass") and 0.1 <= (s.get("active_dur") or 0) <= 1.0
              and Path(s["path"]).exists()]
    beds = [s for s in index if s.get("role") == "ambience" and (s.get("centroid") or 9e9) < 400 and Path(s["path"]).exists()]
    for k, s in enumerate(rnd.sample(shorts, min(2 * n, len(shorts)))):
        base = td / f"b{k}_dry.wav"
        ffmpeg(["-i", s["path"], "-af", "apad=whole_dur=4,atrim=end=4", "-ac", "2", "-ar", "16000", base])
        items.append({"kind": "bed", "truth": "no", "file": str(base),
                      "ask": "Is there a continuous low hum or rumble under the sounds? Answer yes or no."})
        if beds:
            b = rnd.choice(beds)
            wet = td / f"b{k}_wet.wav"
            ffmpeg(["-i", s["path"], "-stream_loop", "-1", "-i", b["path"], "-filter_complex",
                    "[0:a]apad=whole_dur=4,atrim=end=4,aformat=channel_layouts=stereo[a];"
                    "[1:a]atrim=end=4,aformat=channel_layouts=stereo,volume=-14dB[b];[a][b]amix=inputs=2:normalize=0",
                    "-ar", "16000", wet])
            items.append({"kind": "bed", "truth": "yes", "file": str(wet),
                          "ask": "Is there a continuous low hum or rumble under the sounds? Answer yes or no."})
    # C: how many separate clicks
    clicks = [s for s in index if s.get("role") == "click" and 0.03 <= (s.get("active_dur") or 0) <= 0.3
              and Path(s["path"]).exists()]
    for k in range(n * 2):
        cnt = 2 + k % 4
        s = rnd.choice(clicks)
        f = td / f"c{k}_{cnt}.wav"
        parts = "".join(f"[0:a]atrim=end=0.4,apad=whole_dur=0.7[p{i}];" for i in range(cnt))
        ffmpeg(["-i", s["path"], "-filter_complex", parts + "".join(f"[p{i}]" for i in range(cnt)) +
                f"concat=n={cnt}:v=0:a=1,aformat=channel_layouts=mono", "-ar", "16000", f])
        items.append({"kind": "count", "truth": str(cnt), "file": str(f),
                      "ask": "How many separate clicks or taps do you hear? Answer with a number only."})
    # D: which of two is louder
    for k in range(n * 2):
        s = rnd.choice(shorts or clicks)
        f = td / f"d{k}.wav"
        first_loud = k % 2 == 0
        g1, g2 = ("0dB", "-18dB") if first_loud else ("-18dB", "0dB")
        ffmpeg(["-i", s["path"], "-filter_complex",
                f"[0:a]atrim=end=0.5,apad=whole_dur=1.2,volume={g1}[a];[0:a]atrim=end=0.5,apad=whole_dur=1.2,volume={g2}[b];"
                f"[a][b]concat=n=2:v=0:a=1,aformat=channel_layouts=mono", "-ar", "16000", f])
        items.append({"kind": "louder", "truth": "first" if first_loud else "second", "file": str(f),
                      "ask": "Two sounds follow each other. Which one is louder, the first or the second? Answer with one word: first or second."})
    print(f"{len(items)} questions on {len(set(i['file'] for i in items))} sounds; running the model (CPU) ...", flush=True)
    res = ask_model([{"file": i["file"], "ask": i["ask"], "tokens": 40} for i in items], trust_unreviewed)
    rows = []
    for it, a in zip(items, res["answers"]):
        txt = (a.get("text") or "").lower()
        if it["kind"] == "category":
            ok = any(w in txt for w in it["words"])
        elif it["kind"] == "bed":
            ok = (("yes" in txt.split()[:3] or txt.startswith("yes")) if it["truth"] == "yes" else
                  ("no" in txt.split()[:3] or txt.startswith("no")))
        elif it["kind"] == "count":
            digits = [w for w in txt.replace(".", " ").split() if w.isdigit()]
            words = {"two": "2", "three": "3", "four": "4", "five": "5", "six": "6"}
            got = digits[0] if digits else next((v for w, v in words.items() if w in txt), "")
            ok = got == it["truth"]
        else:
            ok = it["truth"] in txt
        rows.append({"kind": it["kind"], "truth": it["truth"], "name": it.get("name", ""), "said": a.get("text", ""),
                     "ok": bool(ok), "secs": a.get("secs")})
    print(f"model loaded in {res['load_s']} s; per answer {sum(r['secs'] or 0 for r in rows) / max(1, len(rows)):.1f} s")
    for kind in ("category", "bed", "count", "louder"):
        rs = [r for r in rows if r["kind"] == kind]
        if rs:
            print(f"  {kind:9s} {sum(r['ok'] for r in rs)} of {len(rs)} right")
    for kind in ("category",):
        by = {}
        for r in rows:
            if r["kind"] == kind:
                by.setdefault(r["truth"], []).append(r["ok"])
        print("  by category: " + ", ".join(f"{k} {sum(v)}/{len(v)}" for k, v in by.items()))
    if json_out:
        Path(json_out).write_text(json.dumps({"rows": rows, "load_s": res["load_s"]}, ensure_ascii=False, indent=1),
                                  encoding="utf-8")
    return rows


HUM_WORDS = ("hum", "drone", "rumble", "background", "ambient", "ambience", "buzz", "engine", "low-frequency",
             "low frequency", "murmur", "wind", "noise", "constant", "continuous", "steady", "bass", "vibrat")


def bench_captions(n, json_out, trust_unreviewed):
    """The model is a CAPTIONER: yes/no questions were answered 'yes' to everything. What it was trained on is a caption:
    do the captions of a dry sound and of the same sound over a bed differ in a way a word list can read?"""
    from picker import load_index
    index = [s for s in load_index() if s.get("tier", "main") == "main"]
    rnd = random.Random(11)
    td = Path(tempfile.mkdtemp(prefix="hear_cap_"))
    shorts = [s for s in index if s.get("role") in ("click", "pop", "glass", "hit") and 0.1 <= (s.get("active_dur") or 0) <= 1.0
              and Path(s["path"]).exists()]
    beds = [s for s in index if s.get("role") == "ambience" and (s.get("centroid") or 9e9) < 400 and Path(s["path"]).exists()]
    items = []
    prompts = {"caption": "Write the detailed caption about this audio within 1-2 sentences.",
               "background": "Describe the quiet background of this audio, if there is any, in one sentence."}
    for k, s in enumerate(rnd.sample(shorts, min(n, len(shorts)))):
        dry, wet = td / f"d{k}.wav", td / f"w{k}.wav"
        ffmpeg(["-i", s["path"], "-af", "apad=whole_dur=4,atrim=end=4", "-ac", "2", "-ar", "16000", dry])
        b = rnd.choice(beds)
        for g, lab in ((-14, "wet"), (-24, "wet24")):
            f = td / f"{lab}{k}.wav"
            ffmpeg(["-i", s["path"], "-stream_loop", "-1", "-i", b["path"], "-filter_complex",
                    "[0:a]apad=whole_dur=4,atrim=end=4,aformat=channel_layouts=stereo[a];"
                    f"[1:a]atrim=end=4,aformat=channel_layouts=stereo,volume={g}dB[b];[a][b]amix=inputs=2:normalize=0",
                    "-ar", "16000", f])
            for pk, pt in prompts.items():
                items.append({"case": lab, "prompt": pk, "file": str(f), "ask": pt})
        for pk, pt in prompts.items():
            items.append({"case": "dry", "prompt": pk, "file": str(dry), "ask": pt})
    print(f"{len(items)} captions; running the model (CPU) ...", flush=True)
    res = ask_model([{"file": i["file"], "ask": i["ask"], "tokens": 60} for i in items], trust_unreviewed)
    rows = []
    for it, a in zip(items, res["answers"]):
        txt = (a.get("text") or "").lower()
        rows.append({"case": it["case"], "prompt": it["prompt"], "said": a.get("text", ""),
                     "hum": any(w in txt for w in HUM_WORDS)})
    for pk in prompts:
        line = []
        for case in ("dry", "wet", "wet24"):
            rs = [r for r in rows if r["case"] == case and r["prompt"] == pk]
            if rs:
                line.append(f"{case}: {sum(r['hum'] for r in rs)}/{len(rs)} mention a hum/background")
        print(f"  {pk:10s} " + "; ".join(line))
    if json_out:
        Path(json_out).write_text(json.dumps({"rows": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    i = sub.add_parser("install")
    i.add_argument("--yes", action="store_true")
    d = sub.add_parser("describe")
    d.add_argument("file")
    d.add_argument("--span", nargs=2, type=float, metavar=("T0", "T1"))
    d.add_argument("--ask")
    d.add_argument("--tokens", type=int, default=80)
    d.add_argument("--trust-unreviewed", action="store_true")
    b = sub.add_parser("bench")
    b.add_argument("--n", type=int, default=2, help="sounds per category (and per synthetic case)")
    b.add_argument("--json")
    b.add_argument("--captions", action="store_true", help="the caption test (a bed in the caption or not) instead of "
                                                           "the question test")
    b.add_argument("--trust-unreviewed", action="store_true")
    r = sub.add_parser("_run")
    r.add_argument("jobs")
    r.add_argument("out")
    r.add_argument("--trust-unreviewed", action="store_true")
    a = ap.parse_args()
    if a.cmd == "status":
        status()
    elif a.cmd == "install":
        install(a.yes)
    elif a.cmd == "_run":
        run_jobs(a.jobs, a.out, a.trust_unreviewed)
    elif a.cmd == "describe":
        job = {"file": a.file, "ask": a.ask, "tokens": a.tokens}
        if a.span:
            job.update(t0=a.span[0], t1=a.span[1])
        res = ask_model([job], a.trust_unreviewed)
        print(res["answers"][0].get("text", ""))
    elif a.captions:
        bench_captions(a.n, a.json, a.trust_unreviewed)
    else:
        bench(a.n, a.json, a.trust_unreviewed)


if __name__ == "__main__":
    main()
