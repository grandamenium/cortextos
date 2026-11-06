#!/usr/bin/env python3
"""A taste test by category: ten sounds of one role, the same picture, one tap each; the answers become the skill's taste.

  python taste_test.py plan    OUT --hosts HOSTS.json [--roles click ui ...] [-n 10] [--seed N] [--exclude-rated]
  python taste_test.py render  OUT [--jobs 4]          # one short film per sound: the picture + that sound, as mix.py places it
  python taste_test.py page    OUT                     # OUT/page for `listen_page.py serve` (sections, one tap per sound)
  python taste_test.py results OUT [--apply]           # unblind, taste_ratings.json; --apply writes taste.json (love / ban)
  python taste_test.py hosts   VIDEO [VIDEO ...]       # picture events of silent videos to choose the hosts from
  python taste_test.py round   OUT --hosts HOSTS.json [--roles ...] [-n 8] [--title T]   # the next round in one go

Why. Which sound is good for a click, a transition, an impact is a matter of taste, and the taste is one person's. The
library holds hundreds of sounds of a role; the skill's picker orders them by numbers (nearness in brightness, attack,
length). Here the person's ears give the order directly, and what they say about ten sounds says something about the
others.

How the test is built (so that the answers are worth having).
  * One HOST picture per role: a short moment of a silent film of the person's own (a button press, a wipe, a title
    slam), the same in all clips of the role, so only the sound changes and the sounds can be compared with each other.
    hosts.json says which moment (video, start, length, the event times) and how to describe it.
  * Ten sounds per role: the three the picker would take first (what the skill does by default is tested too) and seven
    chosen to be as far from each other as possible in brightness, attack, length and weight (farthest-first), so that
    the ten cover the role and the taste shows along which direction it runs. One family of recordings once.
  * Two controls per role, marked only in the results: a REPEAT of one sound (does the same ear say the same twice;
    how much a single answer is worth) and ONE SOUND OF ANOTHER ROLE (a click in the whoosh set: does the picture decide,
    or does everything get "class"). The person is told that they are there.
  * The sound is placed by mix.py as the skill would place it (the role's level and anchor), no loudness gain, no layer
    match: the clip is the sound in the picture, nothing else.
  * Four verdicts, not five stars: love (take it gladly), ok, not here (a good sound, wrong for THIS picture: say what
    it is better for), never (not in any film). Reasons are chips (harsh, dull, long, short, loud, quiet, dirty,
    synthetic, cliche, off the picture).

What comes out. `results` writes taste_ratings.json (personal, never packaged): per sound the verdict, the reasons and
the better-for, with the sound's measured character; with --apply the "love" sounds go to taste.json `love` (the picker
prefers them) and the "never" sounds to `ban` (the picker never takes them), the rest as notes. The next round can
leave the rated ones out (--exclude-rated) and the answers say along which measured direction the taste runs.
"""
import argparse
import json
import math
import os
import random
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import SKILL_DIR, effective_dur, family_key
import picker

RATINGS = Path(os.environ.get("REAL_SFX_RATINGS") or SKILL_DIR / "taste_ratings.json")    # (the env: the selftest)
SCORE_ORDER = {"love": 2, "ok": 1, "notfit": 0, "never": -1}
HERE = Path(__file__).parent

# how a role is drawn from the library for the test, how its cue is given to mix.py, which role is the "wrong" control
ROLE_SPEC = {
    "click":    {"pool": {"role": "click", "max_dur": 0.9, "onsets_max": 1}, "cue": {}, "wrong": "whoosh"},
    "ui":       {"pool": {"role": "ui", "max_dur": 1.6, "onsets_max": 2}, "cue": {}, "wrong": "hit"},
    "pop":      {"pool": {"role": "pop", "max_dur": 1.3}, "cue": {}, "wrong": "riser"},
    "whoosh":   {"pool": {"role": "whoosh", "min_dur": 0.3, "max_dur": 2.0}, "cue": {"anchor": "peak"}, "wrong": "click"},
    "hit":      {"pool": {"role": "hit", "min_dur": 0.2, "max_dur": 3.5}, "cue": {"max_dur": 2.5}, "wrong": "chime"},
    # 6 dB under the role's level: how the skill's event map places a sub drop (under a hit), not alone at full level
    "sub_drop": {"pool": {"role": "sub_drop", "min_dur": 0.4, "max_dur": 4.0}, "cue": {"max_dur": 2.5, "gain_db": -6},
                 "wrong": "pop"},
    "chime":    {"pool": {"role": "chime", "max_dur": 3.0}, "cue": {"max_dur": 2.2}, "wrong": "hit"},
    "riser":    {"pool": {"role": "riser", "min_dur": 1.2, "max_dur": 4.5}, "cue": {"anchor": "end"}, "wrong": "click"},
    # typing: a take of typing, its first 0.7 s (the skill slices single keys; here the touch of the keys is judged)
    "typing":   {"pool": {"role": "typing", "min_dur": 0.3, "max_dur": 8.0}, "cue": {"max_dur": 0.7}, "wrong": "whoosh"},
    "glitch":   {"pool": {"role": "glitch", "max_dur": 1.5}, "cue": {"max_dur": 1.0}, "wrong": "chime"},
    "paper":    {"pool": {"role": "paper", "max_dur": 2.0}, "cue": {"max_dur": 1.5}, "wrong": "hit"},
    "data":     {"pool": {"role": "data", "max_dur": 2.0}, "cue": {"max_dur": 1.5}, "wrong": "whoosh"},
    "error":    {"pool": {"role": "error", "max_dur": 1.5}, "cue": {"max_dur": 1.2}, "wrong": "pop"},
    # a bed: a steady recording under the picture AND three fixed sounds the person already loved (the host names them),
    # levelled by mix.py as in a film; the "known" control is the recording heard as a hum in the first listening round
    "ambience": {"pool": {"role": "ambience", "min_dur": 5.0}, "cue": {}, "wrong": None, "bed": True, "known": 646,
                 "known_label": "the old drone (heard as a hum)"},
}
DEFAULT_ROLES = ["click", "ui", "pop", "whoosh", "hit", "sub_drop", "chime", "riser"]
ROLE_TITLE = {"click": "Клики", "ui": "Интерфейс", "pop": "Поп / пузыри", "whoosh": "Переходы (whoosh)", "hit": "Удары",
              "sub_drop": "Низкие удары (sub drop)", "chime": "Успех / колокольчики", "riser": "Нарастания (riser)",
              "typing": "Печать", "glitch": "Глитч", "paper": "Бумага", "data": "Данные", "error": "Ошибка",
              "ambience": "Подложка (фон)"}
HOST_CONTEXT = {"click": "click", "ui": "appear", "pop": "appear", "whoosh": "transition", "hit": "impact",
                "sub_drop": "impact", "chime": "success", "riser": "build", "typing": "typing", "error": "error"}
PLAN_NOTE = ("В каждой категории несколько звуков на один и тот же момент картинки: меняется только звук. Оцените "
             "каждый: «Класс» (брать охотно), «Нормально», «Не здесь» (звук сам по себе нормальный, но к этой картинке "
             "не подходит: отметьте, для чего он лучше) или «Не брать» (не нужен нигде). В каждой категории есть один "
             "повтор и один звук для проверки теста (чужой, или тот, что вы уже слышали): это не ошибка. Можно "
             "отвечать по частям, ответы сохраняются на каждый тап (список разделов сверху).")


# ------------------------------------------------------------------------------------------------ choosing the sounds
def feat(rec, scales):
    return [v / s for v, s in zip(picker._vec(rec), scales)]


def dist(a, b):
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def families(ranked):
    """Best first, one record per family of takes and per duplicate."""
    seen, out = set(), []
    for score, rec in ranked:
        k = (rec.get("library"), family_key(rec["name"]))
        d = rec.get("dup_key")
        if k in seen or (d and ("dup", d) in seen):
            continue
        seen.add(k)
        if d:
            seen.add(("dup", d))
        out.append((score, rec))
    return out


def choose(index, role, n, rng, scales, skip_paths=()):
    """n sounds of a role: the picker's first three, then farthest-first through the feature space."""
    spec = dict(ROLE_SPEC[role]["pool"])
    ranked = [(s, r) for s, r in picker.rank(index, spec) if "centroid" in r and r["path"] not in skip_paths]
    if ROLE_SPEC[role].get("bed"):             # a bed: steady (not a throb) and not a person, an animal, a song ...
        from bed import AVOID, MAX_RIPPLE, MAX_SWING, _WORDS
        from common import load_steady, save_steady, steady_of
        cache = load_steady()
        keep = []
        for s, r in ranked[:140]:
            nm = str(r.get("name", "")).lower()           # by NAME: the folder says "City" of a recording of a rumble
            if any(w in nm for w in AVOID) or _WORDS.search(nm):
                continue
            st = steady_of(r, cache)
            if st and st["ripple"] <= MAX_RIPPLE and st["swing"] <= MAX_SWING:
                keep.append((s, r))
        try:
            save_steady(cache)
        except OSError:
            pass
        ranked = keep
    fam = families(ranked)
    if len(fam) < n + 2:                       # a small role: the other takes of a family may stand in
        have = {r["path"] for _, r in fam}
        fam = fam + [x for x in ranked if x[1]["path"] not in have]
    main = [x for x in fam if x[1].get("tier", "main") == "main"]
    pool = (main if len(main) >= n + 4 else fam)[:90]            # the worst of the ranking is not the point
    chosen = pool[:3]
    rest = pool[3:]
    vec = {id(r): feat(r, scales) for _, r in pool}
    while len(chosen) < n and rest:
        best = max(rest, key=lambda sr: (min(dist(vec[id(sr[1])], vec[id(c[1])]) for c in chosen), -sr[0]))
        chosen.append(best)
        rest.remove(best)
    rank_of = {r["path"]: i + 1 for i, (_, r) in enumerate(fam)}
    return [(r, rank_of.get(r["path"])) for _, r in chosen], len(fam)


def describe(rec, rank=None, pool=None):
    return {"sound_id": rec["id"], "path": rec["path"], "name": rec["name"], "library": rec.get("library"),
            "tier": rec.get("tier", "main"), "role": rec.get("role"), "dur": round(effective_dur(rec), 2),
            "centroid": rec.get("centroid"), "rolloff": rec.get("rolloff"), "low": rec.get("low"), "high": rec.get("high"),
            "flat": rec.get("flat"), "attack_ms": rec.get("attack_ms"), "decay_ms": rec.get("decay_ms"),
            "picker_rank": rank, "pool": pool}


# ------------------------------------------------------------------------------------------------ plan
def plan_uisfx(index, key, h, rng):
    """A section of ONE uisfx cue in every pack (12 characters of the same meaning), plus library sounds the person
    already loved as anchors, so that the pack and the library can be compared by the same ear on the same picture."""
    from common import load_config
    from search import uisfx_dir, uisfx_file
    cfg = load_config()
    packs = h.get("packs") or sorted(p.name for p in (uisfx_dir(cfg) / "sounds").iterdir() if p.is_dir())
    items = []
    for pk in packs:
        if not uisfx_file(cfg, h["cue"], pk):
            continue
        items.append({"sound": {"sound_id": None, "path": f"uisfx:{pk}/{h['cue']}", "name": f"uisfx {h['cue']} / {pk}",
                                "library": "uisfx", "tier": "uisfx", "role": h.get("role", "ui"), "dur": None,
                                "centroid": None, "picker_rank": None, "pool": len(packs), "pack": pk, "cue": h["cue"]},
                      "control": None})
    by_path = {x["path"]: x for x in index}
    for pth in h.get("anchors", []):
        rec = by_path.get(pth)
        if rec:
            d_ = describe(rec, None, None)
            d_["anchor"] = "library favourite"
            items.append({"sound": d_, "control": None})
    rng.shuffle(items)
    if len(items) >= 4:                            # a repeat of one of the packs, a few places later
        rep = rng.choice([i for i in items if i["sound"].get("pack")] or items)
        items.insert(min(len(items), items.index(rep) + 5), {"sound": dict(rep["sound"]), "control": "repeat"})
    for k, it in enumerate(items, 1):
        it["n"] = k
    return {"role": key, "title": h.get("title") or key, "about": h.get("about", ""), "host": h, "items": items}


def cmd_plan(a):
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    hosts = json.loads(Path(a.hosts).read_text(encoding="utf-8-sig"))
    roles = a.roles or [r for r in DEFAULT_ROLES if r in hosts]
    index = picker.load_index()
    scales = picker._scales(index)
    rng = random.Random(a.seed if a.seed is not None else time.time_ns())
    rated_keys = set()
    if a.exclude_rated and RATINGS.exists():
        rated_keys = set(json.loads(RATINGS.read_text(encoding="utf-8")).get("sounds", {}))
    sections = []
    for role in roles:
        if role not in hosts:
            print(f"{role}: no host picture in {a.hosts}: skipped")
            continue
        if hosts[role].get("kind") == "uisfx":
            sec_ = plan_uisfx(index, role, hosts[role], rng)
            sections.append(sec_)
            print(f"{role}: {len(sec_['items'])} clips (uisfx {hosts[role]['cue']} in {len(sec_['items'])} versions)")
            continue
        if role not in ROLE_SPEC:
            print(f"{role}: no spec for this role in taste_test.py: skipped")
            continue
        skip = {k.split("::", 1)[1] for k in rated_keys if k.startswith(role + "::")}
        again = []
        if a.reuse and RATINGS.exists():
            # the same sounds in another picture: does the verdict belong to the sound or to the picture?
            old = [(e, k.split("::", 1)[1]) for k, e in json.loads(RATINGS.read_text(encoding="utf-8")).get("sounds", {}).items()
                   if k.startswith(role + "::") and e.get("verdict") in SCORE_ORDER]
            by_path_ = {x["path"]: x for x in index}
            old = [(e, p_) for e, p_ in old if p_ in by_path_]
            old.sort(key=lambda ep: -SCORE_ORDER[ep[0]["verdict"]])
            half = max(1, a.reuse // 2)
            chosen_old = old[:half] + old[::-1][:a.reuse - half]
            seen_ = set()
            for e, p_ in chosen_old:
                if p_ not in seen_:
                    seen_.add(p_)
                    again.append((by_path_[p_], e["meta"].get("picker_rank"), e["verdict"]))
        picks, pool_n = choose(index, role, max(0, a.n - len(again)), rng, scales, skip | {r["path"] for r, _, _ in again})
        picks = [(r, rk, None) for r, rk in picks]
        picks = again + picks
        if len(picks) < 4:
            print(f"{role}: only {len(picks)} sounds fit: skipped")
            continue
        items = []
        for r, rk, prev in picks:
            d_ = describe(r, rk, pool_n)
            if prev:
                d_["prev"] = prev                        # what it got in the earlier picture
            items.append({"sound": d_, "control": None})
        # a repeat of one (not the first) sound, and one sound of another role
        rep = items[min(len(items) - 1, 1 + rng.randrange(max(1, len(items) - 1)))]
        wrong_role = ROLE_SPEC[role]["wrong"]
        if wrong_role is None:                  # no other role to borrow from: a sound the person has already judged
            known = next((x for x in index if x["id"] == ROLE_SPEC[role].get("known")), None)
            wr = [(0.0, known)] if known else []
            wrong_label = "known: " + ROLE_SPEC[role].get("known_label", "heard before")
        else:
            wspec = dict(ROLE_SPEC[wrong_role]["pool"]) if wrong_role in ROLE_SPEC else {"role": wrong_role, "max_dur": 2.0}
            wr = [(s, r) for s, r in picker.rank(index, wspec) if "centroid" in r]
            wr = families(wr)[:1]
            wrong_label = f"other role: {wrong_role}"
        order = list(range(len(items)))
        rng.shuffle(order)
        shuffled = [items[i] for i in order]
        rep_item = {"sound": dict(rep["sound"]), "control": f"repeat"}
        pos = min(len(shuffled), max(len(shuffled) // 2 + 1, shuffled.index(rep) + 4 if rep in shuffled else 5))
        shuffled.insert(pos, rep_item)
        if wr:
            w = {"sound": describe(wr[0][1], None, None), "control": wrong_label}
            shuffled.insert(rng.randrange(1, len(shuffled)), w)
        for k, it in enumerate(shuffled, 1):
            it["n"] = k
        h = hosts[role]
        sections.append({"role": role, "title": h.get("title") or f"{ROLE_TITLE.get(role, role)}", "about": h.get("about", ""),
                         "host": h, "items": shuffled})
        print(f"{role}: {len(shuffled)} clips ({len(picks)} chosen from {pool_n} families, + repeat, + {wrong_label})")
    plan = {"created": time.strftime("%Y-%m-%d %H:%M:%S"), "seed": a.seed, "n": a.n, "sections": sections}
    (out / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"-> {out / 'plan.json'}\n   next: python taste_test.py render {out}")


# ------------------------------------------------------------------------------------------------ render
def ffrun(args):
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-nostdin"] + [str(x) for x in args], capture_output=True,
                       text=True, errors="replace")
    if r.returncode:
        raise RuntimeError(r.stderr[-300:])


def render_one(job):
    sheet, clip = job
    r = subprocess.run([sys.executable, str(HERE / "mix.py"), str(sheet), "--out", str(clip), "--no-loudnorm",
                        "--no-match-layer"], capture_output=True, text=True, encoding="utf-8", errors="replace")
    return clip, r.returncode, (r.stderr or r.stdout)[-300:]


def cmd_render(a):
    out = Path(a.out)
    plan = json.loads((out / "plan.json").read_text(encoding="utf-8"))
    (out / "hosts").mkdir(exist_ok=True)
    (out / "sheets").mkdir(exist_ok=True)
    (out / "clips").mkdir(exist_ok=True)
    jobs = []
    for sec in plan["sections"]:
        h = sec["host"]
        if a.only and sec["role"] not in a.only:           # rendered before: only the clip names are kept
            for it in sec["items"]:
                it["clip"] = f"clips/{sec['role']}_{it['n']:02d}/clip.mp4"
            continue
        host_clip = out / "hosts" / f"{sec['role']}.mp4"
        ffrun(["-ss", f"{h['t0']:.3f}", "-t", f"{h['dur']:.3f}", "-i", h["video"], "-an", "-c:v", "libx264", "-preset",
               "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", host_clip])
        cue_extra = ROLE_SPEC.get(sec["role"], {}).get("cue", {})
        level_role = h.get("role") if h.get("kind") == "uisfx" else sec["role"]
        for it in sec["items"]:
            s = it["sound"]
            # a sound of another role stands in the place of this role: at this role's level, so that it is not
            # simply louder or quieter than the others
            if h.get("kind") == "uisfx" and str(s["path"]).startswith("uisfx:"):
                cues = [{"t": round(float(ev) - float(h["t0"]), 3), "label": f"{h['cue']} {it['n']}", "uisfx": s["cue"],
                         "pack": s["pack"], "role": level_role, **h.get("cue_extra", {})} for ev in h["events"]]
            elif h.get("kind") == "uisfx":              # a library favourite beside the packs: at the same role level
                cues = [{"t": round(float(ev) - float(h["t0"]), 3), "label": f"anchor {it['n']}", "file": s["path"],
                         "role": level_role} for ev in h["events"]]
            elif ROLE_SPEC[sec["role"]].get("bed"):
                # the bed under the whole clip, as bed.py makes it, levelled by mix.py against the fixed sounds
                cues = [{"t": 0.0, "label": f"bed {it['n']}", "file": s["path"], "role": "ambience", "anchor": "start",
                         "max_dur": round(float(h["dur"]) + 0.2, 2), "fade_in": 0.8, "fade_out": 1.2, "fade_curve": "qsin",
                         "gain_db": 0.0, "bed": True, "same_source": True, "floor_db": float(h.get("floor_db", -30.0)),
                         "highpass": 30.0}]
            else:
                cues = [dict({"t": round(float(ev) - float(h["t0"]), 3), "label": f"{sec['role']} {it['n']}",
                              "file": s["path"], "role": sec["role"]}, **cue_extra) for ev in h["events"]]
            for fx in h.get("accompany", []):            # sounds that stay the same in every clip of the section
                cues.append({"t": round(float(fx["t"]) - float(h["t0"]), 3), "label": fx.get("label", fx["role"]),
                             "file": fx["file"], "role": fx["role"]})
            sheet = out / "sheets" / f"{sec['role']}_{it['n']:02d}.json"
            sheet.write_text(json.dumps({"video": str(host_clip), "keep_audio": "no", "duration": float(h["dur"]),
                                         "cues": cues}, ensure_ascii=False, indent=1), encoding="utf-8")
            # a folder of its own: mix.py keeps its analysis cache beside the output, and four at once would share it
            clip = out / "clips" / f"{sec['role']}_{it['n']:02d}" / "clip.mp4"
            clip.parent.mkdir(parents=True, exist_ok=True)
            it["clip"] = f"clips/{clip.parent.name}/clip.mp4"
            jobs.append((sheet, clip))
    (out / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(jobs)} clips to render with {a.jobs} jobs")
    bad = 0
    with ThreadPoolExecutor(a.jobs) as ex:
        for clip, rc, err in ex.map(render_one, jobs):
            if rc or not Path(clip).exists():
                bad += 1
                print(f"FAILED {Path(clip).name}: {err}")
    for w in (out / "clips").glob("*/_work"):
        shutil.rmtree(w, ignore_errors=True)
    for stale in (out / "clips").glob("*.mp4"):           # the layout of the first draft: one file per clip
        stale.unlink()
    print(f"{len(jobs) - bad} of {len(jobs)} rendered -> {out / 'clips'}")


# ------------------------------------------------------------------------------------------------ level ladder of a bed
LADDER_Q = ("Одна и та же запись фона на разных уровнях (и версия без фона); звуки сверху и картинка одинаковые. "
            "Какой уровень вам подходит? Если фон вам не нужен вообще, выберите версию без фона. Ниже отметьте, "
            "что мешает.")


def cmd_ladder(a):
    """A bed at several levels (and none): the same clip, the same fixed sounds, only the bed's level changes."""
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    plan_p = out / "plan.json"
    plan = json.loads(plan_p.read_text(encoding="utf-8")) if plan_p.exists() else {
        "created": time.strftime("%Y-%m-%d %H:%M:%S"), "seed": a.seed, "n": 0, "sections": []}
    h = json.loads(Path(a.hosts).read_text(encoding="utf-8-sig"))[a.role]
    index = picker.load_index()
    (out / "hosts").mkdir(exist_ok=True)
    (out / "sheets").mkdir(exist_ok=True)
    host_clip = out / "hosts" / f"{a.role}_ladder.mp4"
    ffrun(["-ss", f"{h['t0']:.3f}", "-t", f"{h['dur']:.3f}", "-i", h["video"], "-an", "-c:v", "libx264", "-preset",
           "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", host_clip])
    jobs, groups = [], []
    for frag in a.sounds:
        rec = next((x for x in index if frag.lower() in x["name"].lower() and "ambience" in x.get("roles", [])), None)
        if rec is None:
            sys.exit(f"no ambience recording with {frag!r} in its name")
        grp = []
        for fl in [None] + list(a.floors):
            cues = []
            for fx in h.get("accompany", []):
                cues.append({"t": round(float(fx["t"]) - float(h["t0"]), 3), "label": fx.get("label", fx["role"]),
                             "file": fx["file"], "role": fx["role"]})
            if fl is not None:
                cues.append({"t": 0.0, "label": "bed", "file": rec["path"], "role": "ambience", "anchor": "start",
                             "max_dur": round(float(h["dur"]) + 0.2, 2), "fade_in": 0.8, "fade_out": 1.2,
                             "fade_curve": "qsin", "gain_db": 0.0, "bed": True, "same_source": True,
                             "floor_db": float(fl), "highpass": 30.0})
            tag = "none" if fl is None else f"f{int(round(-fl))}"
            sheet = out / "sheets" / f"ladder_{rec['id']}_{tag}.json"
            sheet.write_text(json.dumps({"video": str(host_clip), "keep_audio": "no", "duration": float(h["dur"]),
                                         "cues": cues}, ensure_ascii=False, indent=1), encoding="utf-8")
            clip = out / "ladder" / f"{rec['id']}_{tag}" / "clip.mp4"
            clip.parent.mkdir(parents=True, exist_ok=True)
            jobs.append((sheet, clip))
            grp.append((fl, clip))
        groups.append((rec, grp))
    print(f"{len(jobs)} clips to render")
    with ThreadPoolExecutor(a.jobs) as ex:
        for clip, rc, err in ex.map(render_one, jobs):
            if rc or not Path(clip).exists():
                sys.exit(f"FAILED {clip}: {err}")
    ab = []
    for rec, grp in groups:
        files, labels = [], []
        for fl, clip in grp:
            if fl is None:
                labels.append("без подложки")
            else:
                res = json.loads(clip.with_name("clip_resolved_cues.json").read_text(encoding="utf-8"))
                b = res.get("bed") or {}
                lvl = b.get("bed_before_db", 0.0) + b.get("gain_change_db", 0.0)
                labels.append(f"подложка {lvl:.0f} dBFS")
            files.append(str(clip.relative_to(out)).replace("\\", "/"))
            shutil.rmtree(clip.parent / "_work", ignore_errors=True)
        ab.append({"title": f"Фон: {rec['name'][:40]}", "question": LADDER_Q, "files": files, "labels": labels,
                   "meta": {"sound_id": rec["id"], "path": rec["path"], "name": rec["name"]}})
        print(f"  {rec['name'][:44]}: " + " | ".join(labels))
    plan["ab"] = ab
    plan_p.write_text(json.dumps(plan, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"-> {plan_p} ({len(ab)} ladder item(s)); `page` puts them before the sections")

# ------------------------------------------------------------------------------------------------ page
def cmd_page(a):
    out = Path(a.out)
    plan = json.loads((out / "plan.json").read_text(encoding="utf-8"))
    secs = []
    for sec in plan["sections"]:
        h = sec["host"]
        items = []
        for it in sec["items"]:
            if not it.get("clip") or not (out / it["clip"]).exists():
                sys.exit(f"{it.get('clip')} is missing: run `render` first")
            meta = dict(it["sound"], control=it["control"], host=sec["role"], n=it["n"])
            items.append({"file": str(out / it["clip"]), "meta": meta})
        secs.append({"id": sec["role"], "title": sec["title"], "about": sec.get("about", ""),
                     "question": h.get("question") or "Подходит ли этот звук к этому моменту? Картинка одна, меняется звук.",
                     "items": items})
    contexts = None
    rp = {"sections": secs}
    (out / "rate_plan.json").write_text(json.dumps(rp, ensure_ascii=False, indent=1), encoding="utf-8")
    ab_args, label_args = [], []
    for it in plan.get("ab", []):                  # ladders: versions of one clip, shown blind, before the sections
        ab_args += ["--ab", f"{it['title']} ## {it['question']}"] + [str(out / f) for f in it["files"]]
        if it["labels"] and it["labels"] not in [x[1:] for x in label_args]:
            label_args.append(["--labels"] + it["labels"])
    cmd = [sys.executable, str(HERE / "listen_page.py"), "build", str(out / "page"), "--rate-plan",
           str(out / "rate_plan.json"), "--title", a.title, "--note", PLAN_NOTE, "--seed", str(plan.get("seed") or 1)]
    cmd += ab_args
    for la in label_args:
        cmd += la
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    print(r.stdout + r.stderr)
    if r.returncode:
        sys.exit(r.returncode)
    print(f"serve: python {HERE / 'listen_page.py'} serve {out / 'page'}")


# ------------------------------------------------------------------------------------------------ results
SCORE = {"love": 2, "ok": 1, "notfit": 0, "never": -1}      # "none": chips or a note and no verdict
FEATS = (("centroid", "centroid, Hz"), ("attack_ms", "attack, ms"), ("dur", "length, s"), ("low", "share under 250 Hz"),
         ("flat", "noisiness 0..1"))


def median(v):
    v = sorted(v)
    return v[len(v) // 2] if v else None


def final_verdict(vs):
    """One verdict per sound: the one given, or the more cautious of two that differ."""
    given = [x for x in vs if x in SCORE]
    return min(given, key=lambda x: SCORE[x]) if given else ("none" if vs else None)


def cmd_results(a):
    out = Path(a.out)
    sys.path.insert(0, str(HERE))
    import listen_page as LP
    man, rows = LP.unblind(out / "page")
    rated = [r for r in rows if r["kind"] == "rate" and r["answered"]]
    total = [r for r in rows if r["kind"] == "rate"]
    print(f"{man['title']}: {len(rated)} of {len(total)} sounds rated")
    sounds = {}        # (role, path) -> every answer about the sound itself (not the other-role control)
    for r in rated:     # (one sound can be in several roles: ui, pop and hit all hold the same drum fill)
        m = r["meta"]
        if (m.get("control") or "").startswith("other role"):
            continue
        e = sounds.setdefault((r["section"], m["path"]), {
            "meta": {k: v for k, v in m.items() if k not in ("control", "n")}, "section": r["section"],
            "verdicts": [], "reasons": [], "use": [], "notes": []})
        e["verdicts"].append(r["verdict"])
        e["reasons"] += r["reasons"]
        e["use"] += r["use"]
        if r["note"]:
            e["notes"].append(r["note"])
    # a level ladder is a verdict on the recording AS A BED: the chosen level not "without" = ok, and love when a bed
    # version got "всё хорошо"; the tags of the beds (loud ...) are reasons
    plan_ab = {}
    if (out / "plan.json").exists():
        plan_ab = {x["title"]: x.get("meta", {}) for x in json.loads((out / "plan.json").read_text(encoding="utf-8")).get("ab", [])}
    for r in rows:
        m = plan_ab.get(r["title"]) if r["kind"] == "ab" and r["answered"] else None
        if not m or not m.get("path"):
            continue
        beds = {k: v for k, v in r["tags"].items() if k != "без подложки"}
        chosen = r["winner"]
        if chosen in beds or (chosen not in ("без подложки", "same", "bad") and chosen):
            verdict = "love" if any("good" in v for v in beds.values()) else "ok"
        elif chosen == "bad":
            verdict = "never"
        else:
            verdict = "none"                          # no bed at all, or "the same": the recording says nothing
        e = sounds.setdefault(("ambience", m["path"]), {
            "meta": {"sound_id": m.get("sound_id"), "path": m["path"], "name": m["name"], "picker_rank": None,
                     "bed_level": chosen}, "section": "ambience", "verdicts": [], "reasons": [], "use": [], "notes": []})
        e["verdicts"].append(verdict)
        e["reasons"] += [x for v in beds.values() for x in v if x != "good"]
        e["notes"] += ([f"as a bed: chosen {chosen}"] + ([r["note"]] if r["note"] else []))
    for e in sounds.values():
        e["verdict"] = final_verdict(e["verdicts"])
    sections = list(dict.fromkeys(r["section"] for r in rated))
    for role in sections:
        part = [r for r in rated if r["section"] == role]
        own = {k[1]: e for k, e in sounds.items() if k[0] == role}
        cnt = {}
        for e in own.values():
            cnt[e["verdict"]] = cnt.get(e["verdict"], 0) + 1
        twice = [e["verdicts"] for e in own.values() if len(e["verdicts"]) >= 2]
        same = sum(1 for v in twice if v[0] == v[1])
        close = sum(1 for v in twice if v[0] in SCORE and v[1] in SCORE and abs(SCORE[v[0]] - SCORE[v[1]]) <= 1)
        wrong = [r for r in part if (r["meta"].get("control") or "").startswith("other role")]
        print(f"\n[{role}] " + ", ".join(f"{k} {v}" for k, v in sorted(cnt.items(), key=lambda kv: -SCORE.get(kv[0], -2)))
              + (f"  | the same sound twice: same {same} of {len(twice)}, within a step {close}" if twice else "")
              + (("  | a sound of another role: " + ", ".join(f"{r['meta'].get('name', '?')[:24]} -> {r['verdict']}"
                                                              for r in wrong)) if wrong else ""))
        for lab, keys in (("love", ("love",)), ("ok", ("ok",)), ("not here", ("notfit",)), ("never", ("never",)),
                          ("no verdict", ("none",))):
            grp = [e for e in own.values() if e["verdict"] in keys]
            for e in grp:
                m = e["meta"]
                why = ("; why: " + "/".join(sorted(set(e["reasons"])))) if e["reasons"] else ""
                use = ("; better for: " + "/".join(sorted(set(e["use"])))) if e["use"] else ""
                note = ("; " + " ".join(e["notes"])) if e["notes"] else ""
                before = f"  [before: {m['prev']}]" if m.get("prev") else ""
                print(f"    {lab:8s} {m['name'][:40]:40s} picker #{m.get('picker_rank')!s:>3}  {m.get('dur')} s  "
                      f"{m.get('centroid')} Hz  atk {m.get('attack_ms')} ms{before}{why}{use}{note}")
        good = [e for e in own.values() if e["verdict"] in ("love", "ok")]
        bad = [e for e in own.values() if e["verdict"] in ("never", "notfit")]
        if len(good) >= 3 and len(bad) >= 3:
            bits = []
            for key, lab in FEATS:
                g, b = median([e["meta"][key] for e in good if e["meta"].get(key) is not None]), \
                    median([e["meta"][key] for e in bad if e["meta"].get(key) is not None])
                if g is not None and b is not None:
                    bits.append(f"{lab}: {g:g} vs {b:g}")
            print(f"    liked vs not (medians of {len(good)} / {len(bad)}): " + "; ".join(bits))
        top = [e for e in own.values() if (e["meta"].get("picker_rank") or 99) <= 3]
        if top:
            sc = [SCORE[e["verdict"]] for e in top if e["verdict"] in SCORE]
            if sc:
                print(f"    the picker's first three: mean score {sum(sc) / len(sc):.1f} of 2 "
                      f"({', '.join(e['verdict'] for e in top)})")
        why = {}
        for e in own.values():
            for rsn in e["reasons"]:
                why[rsn] = why.get(rsn, 0) + 1
        if why:
            print("    reasons given: " + ", ".join(f"{k} {v}" for k, v in sorted(why.items(), key=lambda kv: -kv[1])))
    ladders = [r for r in rows if r["kind"] == "ab" and r["answered"]]
    for r in ladders:
        tg = "; ".join(f"{k}: {', '.join(v)}" for k, v in r["tags"].items())
        print(f"\n[ladder] {r['title']}: chosen {r['winner']}" + (f"  [{tg}]" if tg else "") +
              (f"  — {r['note']}" if r["note"] else ""))
    if sounds:
        data = json.loads(RATINGS.read_text(encoding="utf-8")) if RATINGS.exists() else {"sounds": {}, "rounds": []}
        for (role, path), e in sounds.items():
            key = f"{role}::{path}"
            hist = [h for h in data["sounds"].get(key, {}).get("history", []) if h.get("round") != man["title"]]
            hist.append({"round": man["title"], "created": man.get("created"), "verdict": e["verdict"],
                         "reasons": sorted(set(e["reasons"])), "use": sorted(set(e["use"])), "notes": e["notes"]})
            e["history"] = hist                    # one entry per picture it was heard in: later rounds add to it
            data["sounds"][key] = e
        data["rounds"] = [x for x in data["rounds"] if (x.get("title"), x.get("created")) != (man["title"], man.get("created"))]
        data["rounds"].append({"title": man["title"], "created": man.get("created"),
                               "logged": time.strftime("%Y-%m-%d %H:%M:%S"), "rated": len(rated)})
        RATINGS.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\n{len(sounds)} sounds -> {RATINGS}" + ("" if a.apply else "  (taste.json untouched: --apply writes love / ban)"))
    if a.apply:
        apply_taste(a)


def effective(data):
    """What the whole history says: (love, ban, not_for, better_for, notes), each from the LATEST verdicts.
    love: the latest verdict in that role is love. ban: the latest is never and no other role says love / ok.
    not_for[role]: the latest is never (but liked in another role), or "not here" in two pictures running (one
    picture's "not here" was often "ok" in the next one, so it is not enough)."""
    by_path = {}
    for key, e in data.get("sounds", {}).items():
        role, path = key.split("::", 1)
        h = [x["verdict"] for x in e.get("history") or [{"verdict": e.get("verdict")}] if x["verdict"] in SCORE]
        by_path.setdefault(path, {})[role] = (h, e)
    love, ban, not_for, better, notes = set(), set(), {}, {}, {}
    uisfx, lib_scores = {}, {}                   # {cue: {pack: verdict}}, {cue: ([pack scores], [library scores])}
    for path in [p for p in by_path if p.startswith("uisfx:")]:
        for role, (h, e) in by_path.pop(path).items():
            pack, _, cue = path[len("uisfx:"):].partition("/")
            reasons = {r for x in e.get("history") or [] for r in x.get("reasons", [])} | set(e.get("reasons") or [])
            latest = h[-1] if h else ("notfit" if "synthetic" in reasons else None)   # "synthetic" and no verdict
            if latest:
                uisfx.setdefault(cue, {})[pack] = latest
                lib_scores.setdefault(cue, ([], []))[0].append(SCORE[latest])
    for key, e in data.get("sounds", {}).items():          # library favourites that stood beside the packs
        role, path = key.split("::", 1)
        if role.startswith("uisfx_") and not path.startswith("uisfx:"):
            hh = [x["verdict"] for x in e.get("history") or [] if x["verdict"] in SCORE]
            if hh:
                lib_scores.setdefault(role[len("uisfx_"):], ([], []))[1].append(SCORE[hh[-1]])
    ui_source = {}
    for cue, (packs_, libs_) in lib_scores.items():
        if len(packs_) >= 4 and libs_:
            d_ = sum(libs_) / len(libs_) - sum(packs_) / len(packs_)
            if d_ >= 0.5:
                ui_source[cue] = "library"
            elif d_ <= -0.5:
                ui_source[cue] = "uisfx"
    for path, roles in by_path.items():
        for role, (h, e) in roles.items():
            if not h:
                continue
            latest = h[-1]
            elsewhere = any(r != role and hh and hh[-1] in ("love", "ok") for r, (hh, _) in roles.items())
            if latest == "love":
                love.add(path)
            if latest == "never" and not elsewhere:
                ban.add(path)
            if (latest == "never" and elsewhere) or (latest == "notfit" and len(h) >= 2 and h[-2] in ("notfit", "never")):
                not_for.setdefault(path, set()).add(role)
            use = {u for x in e.get("history") or [] for u in x.get("use", [])} | set(e.get("use") or [])
            if use:
                better.setdefault(path, set()).update(use)
            bits = [latest + (f" (earlier: {', '.join(h[:-1])})" if len(h) > 1 else "")]
            rs = {r for x in e.get("history") or [] for r in x.get("reasons", [])}
            if rs:
                bits.append("why " + "/".join(sorted(rs)))
            if use:
                bits.append("better for " + "/".join(sorted(use)))
            bits += [n for x in e.get("history") or [] for n in x.get("notes", [])] or list(e.get("notes") or [])
            notes[path] = (notes[path] + " | " if path in notes else "") + f"[{role}] " + "; ".join(bits)
    love -= ban
    effective.uisfx, effective.ui_source = uisfx, ui_source      # (read by apply_taste and status)
    return love, ban, {p: sorted(v) for p, v in not_for.items()}, {p: sorted(v) for p, v in better.items()}, notes


def apply_taste(a):
    """Write the accumulated verdicts into taste.json (love / ban / not_for / better_for / notes)."""
    data = json.loads(RATINGS.read_text(encoding="utf-8")) if RATINGS.exists() else {"sounds": {}}
    love, ban, not_for, better, notes = effective(data)
    t = picker.load_taste()
    t["ban"] = sorted(set(t.get("ban", [])) | ban)
    t["love"] = sorted((set(t.get("love", [])) | love) - set(t["ban"]))
    n_ban, n_love = len(t["ban"]), len(t["love"])
    idx_ = picker.load_index()                  # a recording that lies in the library twice (a copy, another folder) is one sound
    t["ban"] = sorted(picker.twins_of(t["ban"], idx_))
    t["love"] = sorted(picker.twins_of(t["love"], idx_) - set(t["ban"]))
    t["not_for"] = {**(t.get("not_for") or {}), **not_for}
    t["better_for"] = {**(t.get("better_for") or {}), **better}
    t["notes"] = {**(t.get("notes") or {}), **notes}
    if effective.uisfx:
        t["uisfx"] = {**(t.get("uisfx") or {}), **effective.uisfx}           # {cue: {pack: verdict}}
    if effective.ui_source:
        t["ui_source"] = {**(t.get("ui_source") or {}), **effective.ui_source}  # {cue: "library" | "uisfx"}
    picker.TASTE_PATH.write_text(json.dumps(t, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\ntaste.json: {len(t['love'])} loved, {len(t['ban'])} banned, {len(t['not_for'])} with a role they are "
          f"not for, {len(t['notes'])} notes ({picker.TASTE_PATH}); copies of the same recording: "
          f"+{len(t['ban']) - n_ban} banned, +{len(t['love']) - n_love} loved")


def cmd_status(a):
    """What would be written, without writing it."""
    data = json.loads(RATINGS.read_text(encoding="utf-8")) if RATINGS.exists() else {"sounds": {}, "rounds": []}
    love, ban, not_for, better, notes = effective(data)
    rounds = data.get("rounds", [])
    print(f"{len(data.get('sounds', {}))} role-sound verdicts from {len(rounds)} round(s): "
          + "; ".join(f"{r['title']} ({r['rated']})" for r in rounds))
    print(f"would be loved: {len(love)}; banned: {len(ban)}; not for a role: {sum(len(v) for v in not_for.values())} "
          f"on {len(not_for)} sounds; better-for hints on {len(better)}")
    for p in sorted(ban):
        print("   ban:", Path(p).name)
    for p, rs in sorted(not_for.items()):
        print(f"   not for {'/'.join(rs)}: {Path(p).name}")
    for cue, prefs in sorted(effective.uisfx.items()):
        print(f"   uisfx {cue}: " + ", ".join(f"{k} {v}" for k, v in sorted(prefs.items())))
    for cue, src in sorted(effective.ui_source.items()):
        print(f"   interface cue {cue}: the person liked the {src} better")

# ------------------------------------------------------------------------------------------------ hosts helper
def cmd_hosts(a):
    for v in a.video:
        r = subprocess.run([sys.executable, str(HERE / "find_moments.py"), v, "--out", str(Path(a.work) / Path(v).stem)],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        print(f"{v}: " + (r.stdout.strip().splitlines() or ["?"])[0])
    print("then look at them: python look.py --moments WORK/NAME/moments.json --out frames.png, and write hosts.json")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan")
    p.add_argument("out")
    p.add_argument("--hosts", required=True)
    p.add_argument("--roles", nargs="+")
    p.add_argument("-n", type=int, default=10)
    p.add_argument("--seed", type=int)
    p.add_argument("--exclude-rated", action="store_true")
    p.add_argument("--reuse", type=int, default=0, metavar="N",
                   help="hear N already rated sounds of each role again (the best and the worst) in the new picture")
    r = sub.add_parser("render")
    r.add_argument("out")
    r.add_argument("--jobs", type=int, default=4)
    r.add_argument("--only", nargs="+", help="render only these roles again (the others keep their clips)")
    g = sub.add_parser("page")
    g.add_argument("out")
    g.add_argument("--title", default="Проба звуков по категориям")
    s = sub.add_parser("results")
    s.add_argument("out")
    s.add_argument("--apply", action="store_true", help="write love / ban / notes into taste.json")
    h = sub.add_parser("hosts")
    h.add_argument("video", nargs="+")
    h.add_argument("--work", default=".")
    sub.add_parser("status", help="what the accumulated verdicts would write into taste.json (writes nothing)")
    sub.add_parser("apply", help="write the accumulated verdicts into taste.json (love / ban / not_for / better_for)")
    ld = sub.add_parser("ladder", help="a bed at several levels (and none), blind, for the page")
    ld.add_argument("out")
    ld.add_argument("--hosts", required=True)
    ld.add_argument("--role", default="ambience")
    ld.add_argument("--sounds", nargs="+", required=True, help="parts of the names of the ambience recordings")
    ld.add_argument("--floors", nargs="+", type=float, default=[-29.0, -23.0, -17.0, -9.0],
                    help="the bed's median level under the loudest 250 ms of the clip, dB (the fixed sounds: about -27 dBFS)")
    ld.add_argument("--jobs", type=int, default=4)
    ld.add_argument("--seed", type=int)
    q = sub.add_parser("round", help="plan + render + page of the next round in one go (rated sounds are left out)")
    q.add_argument("out")
    q.add_argument("--hosts", required=True)
    q.add_argument("--roles", nargs="+")
    q.add_argument("-n", type=int, default=8)
    q.add_argument("--reuse", type=int, default=0)
    q.add_argument("--seed", type=int)
    q.add_argument("--jobs", type=int, default=4)
    q.add_argument("--only", nargs="+", help=argparse.SUPPRESS)
    q.add_argument("--title", default="Проба звуков по категориям")
    a = ap.parse_args()
    if a.cmd == "round":
        a.exclude_rated = True
        cmd_plan(a)
        cmd_render(a)
        cmd_page(a)
        return
    {"plan": cmd_plan, "render": cmd_render, "page": cmd_page, "results": cmd_results, "hosts": cmd_hosts,
     "ladder": cmd_ladder, "status": cmd_status, "apply": lambda a_: apply_taste(a_)}[a.cmd](a)


if __name__ == "__main__":
    main()

