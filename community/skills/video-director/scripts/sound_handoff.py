#!/usr/bin/env python3
"""Hand a film's planned sound moments to real-sfx, and bring its results back into the project.

  python3 <skill>/scripts/sound_handoff.py events build/audio/sound-plan.json --out build/audio/sfx/events.json \
      [--duration 51.8]
  python3 <skill>/scripts/sound_handoff.py pins build/audio/sound-plan.json --cues build/audio/sfx/cues.json \
      --out build/audio/sfx/pins.json
  python3 <skill>/scripts/sound_handoff.py collect build/audio/sound-plan.json \
      --resolved build/audio/sfx/result/fx_resolved_cues.json --track build/audio/sfx/result/fx_sfx_track.wav \
      [--project .] [--fps 30]

The sound plan (build/audio/sound-plan.json) is written at stage 7 from the motion spec: one entry per moment that
makes a sound, nothing else.

  [{"t": 21.15, "label": "click: Best Light in the Dock", "type": "click", "hear": "must-hear"},
   {"t": 7.25, "label": "calendar ding", "type": "chime", "hear": "must-hear"},
   {"t": 15.1, "label": "shirt rustle", "type": "cloth", "hear": "texture", "source": "clip", "len": 4.5},
   {"t": 43.9, "label": "typing", "type": "key", "hear": "texture", "len": 1.4, "n": 12}]

  t       film seconds: the first frame of the event (not the frame after it)
  label   what happens on screen, in words; it names the sound in every report
  type    real-sfx's event kind (click, pop, chime, success, hit, thump, whoosh, key, ...: its typed-cues list)
  hear    must-hear (the ding, the click that matters) or texture (a rustle, steps, a room)
  source  library (default: real-sfx places a real recording), clip (the clip's own sound, path A), or none
  len, g, n   passed to real-sfx as they are (length in seconds, loudness 1.0 = nominal, keystrokes in a run)
  file    optional: the recording to use (absolute path), once the user has heard and chosen one
  role    optional: real-sfx's role for it (click, pop, chime, hit, ui ...); a named recording otherwise takes the
          role of this kind, which sets its level and the point placed on the frame
  slice, pitch, gain_db, anchor, fade_in, fade_out, max_dur, lowpass, highpass, pan, mono
          optional, passed to real-sfx's cue sheet as they are (its mix.py lists them); a named recording keeps its
          own pitch unless the plan gives one

events   writes real-sfx's typed event list with the library moments only, and checks the plan against this
         skill's effects rules (few sounds, none on text or the logo).
pins     after real-sfx's from_cues.py: a batch for its `sheet.py apply` that gives every placed cue its label from
         the plan and, where the plan names one, its recording (from_cues.py names cues by kind and picks recordings
         by itself). A moment real-sfx left quiet is reported, not pinned.
collect  after real-sfx's mix.py: copies its effects track to build/audio/effects.wav, writes
         build/audio/events.json for sound_balance.py from the plan, copies every recording it placed into
         assets/audio/effects/ with a row in assets/audio/SOURCES.md (source and licence taken from the library's own
         SOURCES.md when it has one), and compares what was placed with what was planned: a planned moment left quiet,
         a sound nobody planned, a sound off its planned frame.

Exit 0 all good; 2 something to review (each line starts REVIEW); 1 an error.
"""
from __future__ import annotations

import argparse
import datetime as dt
import filecmp
import json
import re
import shutil
import sys
from pathlib import Path

# real-sfx's event kinds, their synonyms and the role each is placed with are read from its from_cues.py, which sits
# inside this skill's folder (real-sfx/). This short list is used only when real-sfx can't be found.
FALLBACK_KINDS = set("""whoosh wipe hit thump riser drop click press tap button select pop bubble blip appear tick tock
chime bell ding notify bleep success ok done complete magic water coins key keystroke type typing glitch error camera
ambience paper glass shatter data""".split())


def real_sfx_kinds(where: Path | None) -> tuple[dict[str, str], dict[str, str]]:
    """{word: canonical kind} and {canonical kind: role} from real-sfx's from_cues.py, or the fallback list."""
    folder = where or Path(__file__).resolve().parents[1] / "real-sfx"
    scripts = folder / "scripts"
    if (scripts / "from_cues.py").is_file():
        sys.path.insert(0, str(scripts))
        try:
            import from_cues  # noqa: E402  (real-sfx's own module)
            words = {k: k for k in from_cues.ROUTES}
            for k, syn in from_cues.ALIASES.items():
                words.update({w: k for w in syn})
            roles = {k: r["specs"][0].get("role", "") for k, r in from_cues.ROUTES.items() if r.get("specs")}
            return words, roles
        except Exception as e:  # a changed real-sfx: say so and carry on with the short list
            print(f"NOTE can't read real-sfx's kinds from {scripts}: {e}; using the short list", file=sys.stderr)
        finally:
            sys.path.remove(str(scripts))
    return {k: k for k in FALLBACK_KINDS}, {}


CUE_KEYS = ("slice", "pitch", "gain_db", "anchor", "fade_in", "fade_out", "max_dur", "lowpass", "highpass", "pan",
            "mono")      # per-sound settings passed to real-sfx's cue sheet as they are
TYPING = {"key", "keystroke", "type", "typing"}
NO_SOUND_WORDS = re.compile(r"\b(text|title|headline|caption|line arrives|logo|wordmark|end card|lower third)\b", re.I)
SOURCES_HEAD = ("| File | Source | Page or id | Made by | Licence, and what it allows | Downloaded | Used for |\n"
                "|---|---|---|---|---|---|---|\n")
UISFX_ROW = ("uisfx (bundled with real-sfx)", "", "Yuki Capital", "CC0 1.0: any use, no credit needed, may be shared")


def load_plan(path: Path) -> list[dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise SystemExit(f"error: can't read the sound plan {path}: {e}")
    if isinstance(data, dict):
        data = data.get("moments") or data.get("events") or data.get("cues")
    if not isinstance(data, list):
        raise SystemExit(f"error: {path}: expected a JSON list of planned moments")
    plan = []
    for i, e in enumerate(data):
        if not isinstance(e, dict):
            raise SystemExit(f"error: moment {i}: expected an object")
        missing = [k for k in ("t", "label", "type", "hear") if k not in e]
        if missing:
            raise SystemExit(f"error: moment {i} ({e.get('label', '?')}): missing {', '.join(missing)}")
        if e["hear"] not in ("must-hear", "texture"):
            raise SystemExit(f"error: moment {i} ({e['label']}): hear must be must-hear or texture")
        src = e.get("source", "library")
        if src not in ("library", "clip", "none"):
            raise SystemExit(f"error: moment {i} ({e['label']}): source must be library, clip or none")
        plan.append(dict(e, t=float(e["t"]), source=src))
    return sorted(plan, key=lambda e: e["t"])


def cmd_events(a) -> int:
    plan = load_plan(a.plan)
    words, roles = real_sfx_kinds(a.real_sfx)
    review = []
    lib = [e for e in plan if e["source"] == "library"]
    for e in plan:
        if a.duration and not 0 <= e["t"] <= a.duration:
            raise SystemExit(f"error: {e['label']} at {e['t']} s is outside the film (0-{a.duration} s)")
        if NO_SOUND_WORDS.search(e["label"]):
            review.append(f"rule     {e['t']:.2f} {e['label']}: no sound on text, a line arriving or the logo "
                          "(sound-and-voice.md, Effects); drop it unless the user asked for it")
        if e["source"] == "library" and str(e["type"]).lower() not in words:
            review.append(f"kind     {e['t']:.2f} {e['label']}: real-sfx doesn't know the kind '{e['type']}' and will "
                          f"leave it quiet; use one of its kinds or pass --kind {e['type']}=<kind> to from_cues.py")
    if len(lib) > 5:
        review.append(f"count    {len(lib)} library effects planned: most motion-design films need fewer than five. "
                      "Check each is a real thing on screen making a sound, and tell the user the count")
    out = []
    for e in lib:
        ev = {"t": round(e["t"], 3), "type": e["type"], "label": e["label"]}
        for k in ("len", "g", "n"):
            if k in e:
                ev[k] = e[k]
        out.append(ev)
        if e.get("file"):
            f = Path(e["file"]).expanduser()
            if not f.is_file():
                raise SystemExit(f"error: {e['label']}: the recording {f} doesn't exist")
            if str(e["type"]).lower() in TYPING:
                review.append(f"typing   {e['t']:.2f} {e['label']}: a typing run becomes many keystrokes and can't be "
                              "pinned to one file from the plan; name the recording with from_cues.py "
                              "--kind key=slices:<ids from search.py> instead")
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8")
    for line in review:
        print(f"REVIEW {line}")
    kept = len(plan) - len(lib)
    print(f"{len(out)} library moments written to {a.out}" + (f"; {kept} left to the clips or silent" if kept else ""))
    return 2 if review else 0


def cmd_pins(a) -> int:
    """After from_cues.py: a batch for real-sfx's `sheet.py apply` that gives each placed cue the plan's label and,
    where the plan names one, its recording. Built from the cue sheet itself, so a moment real-sfx left quiet is
    reported instead of breaking the batch, and a cue moved by a time map is found by the time it was declared at."""
    plan = load_plan(a.plan)
    words, roles = real_sfx_kinds(a.real_sfx)
    try:
        sheet = json.loads(a.cues.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise SystemExit(f"error: can't read real-sfx's cue sheet {a.cues}: {e}")
    cues = sheet.get("cues", []) if isinstance(sheet, dict) else sheet
    review, pins, taken = [], [], set()
    for e in plan:
        if e["source"] != "library" or str(e["type"]).lower() in TYPING:
            continue            # a typing run's keystrokes keep real-sfx's own labels
        near = [(abs(float(c.get("t_declared", c.get("t", 0))) - e["t"]), i) for i, c in enumerate(cues)
                if i not in taken and abs(float(c.get("t_declared", c.get("t", 0))) - e["t"]) <= 0.03]
        if not near:
            review.append(f"quiet    {e['t']:.2f} {e['label']}: real-sfx placed no sound here (see from_cues.py's "
                          "'NOT mapped' list); nothing pinned")
            continue
        i = min(near)[1]
        taken.add(i)
        c = cues[i]
        sets = {"label": e["label"]}
        if e.get("file"):
            sets["file"] = str(Path(e["file"]).expanduser())
            # a named recording drops real-sfx's automatic pick and with it the role, which sets the sound's level
            # and the point placed on the frame; keep the role this kind is placed with
            role = e.get("role") or roles.get(words.get(str(e["type"]).lower(), ""), "")
            if role:
                sets["role"] = role
            else:
                review.append(f"role     {e['t']:.2f} {e['label']}: names a recording, and real-sfx has no role for "
                              f"the kind '{e['type']}'; add \"role\" (click, pop, chime, hit, ...) to the plan")
        for k in CUE_KEYS:
            if k in e:
                sets[k] = e[k]
        if e.get("file"):
            sets.setdefault("pitch", 0)     # real-sfx varies the pitch of repeats; a chosen recording plays as chosen
        sel = {"at": round(float(c.get("t", 0)), 3)}
        if c.get("label"):
            sel["label"] = c["label"]       # two cues within 30 ms are told apart by their current label
        pins.append(dict(sel, set=sets))
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(pins, indent=1) + "\n", encoding="utf-8")
    for line in review:
        print(f"REVIEW {line}")
    named = sum(1 for p_ in pins if "file" in p_["set"])
    print(f"{len(pins)} cues to label, {named} named recordings -> {a.out}")
    return 2 if review else 0


# ---------------------------------------------------------------------------------------------- collect

def cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def find_library_sources(sound: Path) -> Path | None:
    """The nearest SOURCES.md in the sound's folder or up to three folders above it."""
    p = sound.parent
    for _ in range(4):
        if (p / "SOURCES.md").is_file():
            return p / "SOURCES.md"
        if p.parent == p:
            break
        p = p.parent
    return None


def lookup_source(sound: Path) -> dict:
    """Source, page, maker, licence and date for one library file, from the library's own SOURCES.md if it has one."""
    found = {"source": "", "page": "", "maker": "", "licence": "", "downloaded": "", "listed_in": ""}
    src = find_library_sources(sound)
    if not src:
        return found
    found["listed_in"] = str(src)
    rel = sound.resolve().relative_to(src.parent.resolve()).as_posix()
    lines = src.read_text(encoding="utf-8").splitlines()
    m = re.search(r"\b(?:downloaded|dated?)\b[^0-9]*(\d{4}-\d{2}-\d{2})", "\n".join(lines[:15]), re.I)
    found["downloaded"] = m.group(1) if m else ""
    heading = ""
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("#"):
            heading = line.lstrip("#").strip()
        is_table = (line.lstrip().startswith("|") and i + 1 < len(lines)
                    and set(lines[i + 1].replace("|", "").strip()) <= set("-: ") and lines[i + 1].strip())
        if is_table:
            head = [h.lower() for h in cells(line)]
            col = lambda *words: next((k for k, h in enumerate(head) if any(w in h for w in words)), None)
            cs, cp, cm, cl = col("source", "from"), col("page", "url", "link", " id"), col("made", "author",
                                                                                          "uploader", "by"), col("licen")
            i += 2
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                c = cells(lines[i])
                name = c[0].strip("`").strip()
                if name and (name == rel or name.endswith("/" + rel) or Path(name).name == sound.name):
                    get = lambda k: c[k] if k is not None and k < len(c) else ""
                    found.update(source=get(cs), page=get(cp), maker=get(cm), licence=get(cl))
                    return found
                i += 1
            continue
        if line.lstrip().startswith(("-", "*")) and (rel in line or sound.name in line):
            text = line.lstrip("-* ").split("—", 1)[-1].split(" - ", 1)[-1].strip()
            found["page"] = text
            lic = re.search(r"(CC0[^;,)]*|CC BY[^;,)]*|[A-Z][\w ]*Licen[cs]e[^;)]*)", heading)
            found["source"] = heading.split("(")[0].strip()
            found["licence"] = heading[heading.find("(") + 1:heading.rfind(")")] if "(" in heading else (
                lic.group(1) if lic else "")
            return found
        i += 1
    return found


def placed_file(cue: dict) -> tuple[Path | None, bool]:
    """The recording a resolved cue came from (not real-sfx's processed slice), and whether it is a uisfx cue."""
    if cue.get("source") == "uisfx" or cue.get("uisfx"):
        f = cue.get("file") or cue.get("source_file")
        return (Path(f) if f else None), True
    for k in ("source_file", "slice_of", "file"):
        f = cue.get(k)
        if f and "/_work/" not in str(f).replace("\\", "/"):
            return Path(f), False
    return None, False


def match(plan: list[dict], cues: list[dict], fps: float) -> tuple[dict[int, list[dict]], list[dict]]:
    """Each library moment in the plan gets the placed cues that belong to it: the cue nearest its time (within 0.5 s)
    with the same label if real-sfx kept the label, plus every keystroke of a typing run and every layer of a cue."""
    lib = [(i, e) for i, e in enumerate(plan) if e["source"] == "library"]
    owned: dict[int, list[dict]] = {i: [] for i, _ in lib}
    extra = []
    for c in cues:
        t = float(c.get("t", 0.0))
        best = None
        for i, e in lib:
            span = float(e.get("len", 0.0)) if str(e["type"]).lower() in TYPING else 0.0
            if e["t"] - 0.5 <= t <= e["t"] + span + 0.5:
                score = 0 if c.get("label") and c.get("label") == e["label"] else 1
                d = 0.0 if e["t"] <= t <= e["t"] + span else min(abs(t - e["t"]), abs(t - e["t"] - span))
                if best is None or (score, d) < best[0]:
                    best = ((score, d), i)
        if best is None:
            extra.append(c)
        else:
            owned[best[1]].append(c)
    return owned, extra


def table_files(text: str) -> list[str]:
    """The first-column file of every row in every table that has a licence column (as check_sources.py reads it)."""
    out, lines, i = [], text.splitlines(), 0
    while i < len(lines):
        if is_table_head(lines, i):
            lic = any("licen" in h.lower() for h in cells(lines[i]))
            i += 2
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                if lic:
                    out.append(cells(lines[i])[0].strip("`").strip())
                i += 1
            continue
        i += 1
    return out


def is_table_head(lines: list[str], i: int) -> bool:
    return (lines[i].lstrip().startswith("|") and i + 1 < len(lines) and bool(lines[i + 1].strip())
            and set(lines[i + 1].replace("|", "").strip()) <= set("-: "))


def add_rows(text: str, rows: list[str]) -> str:
    """Append rows to the end of the first table with a licence column, or start one in this skill's format."""
    lines = text.splitlines()
    for i in range(len(lines)):
        if is_table_head(lines, i) and any("licen" in h.lower() for h in cells(lines[i])):
            j = i + 2
            while j < len(lines) and lines[j].lstrip().startswith("|"):
                j += 1
            width = len(cells(lines[i]))
            fitted = []
            for r in rows:          # a table with other columns: keep file, source, page, licence where they fit
                c = cells(r)
                if width != len(c):
                    head = [h.lower() for h in cells(lines[i])]
                    pick = {k: c[n] for k, n in (("file", 0), ("source", 1), ("page", 2), ("made", 3), ("licen", 4),
                                                ("download", 5), ("used", 6))}
                    c = [next((v for k, v in pick.items() if k in h or (k == "source" and "from" in h)), "")
                         for h in head]
                    c[0] = cells(r)[0]
                fitted.append("| " + " | ".join(c) + " |")
            return "\n".join(lines[:j] + fitted + lines[j:]) + "\n"
    return text.rstrip("\n") + "\n\n" + SOURCES_HEAD + "\n".join(rows) + "\n"


def free_name(fx_dir: Path, f: Path, is_ui: bool, taken: dict) -> str:
    """The file's name in assets/audio/effects/: its own, or with its folder in front when another recording of the
    same name is already there (in this run or an earlier one); the same recording keeps its name."""
    base = f"uisfx-{f.parent.name}-{f.name}" if is_ui else f.name
    for n, name in enumerate([base, f"{f.parent.name}-{f.name}"] + [f"{f.parent.name}-{k}-{f.name}" for k in range(2, 99)]):
        if name in taken:
            if taken[name][0].resolve() == f.resolve():
                return name
            continue
        dest = fx_dir / name
        if not dest.exists() or (f.is_file() and filecmp.cmp(dest, f, shallow=False)):
            return name
    raise SystemExit(f"error: too many recordings named {f.name}")


def cmd_collect(a) -> int:
    plan = load_plan(a.plan)
    proj = a.project
    try:
        resolved = json.loads(a.resolved.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise SystemExit(f"error: can't read real-sfx's resolved cues {a.resolved}: {e}")
    cues = resolved.get("cues", resolved) if isinstance(resolved, dict) else resolved
    if not a.track.is_file():
        raise SystemExit(f"error: no effects track at {a.track}")
    review = []
    audio = proj / "build" / "audio"
    audio.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(a.track, audio / "effects.wav")

    owned, extra = match(plan, cues, a.fps)
    frame = 1.0 / a.fps
    timing = []
    for i, e in enumerate(plan):
        if e["source"] != "library":
            continue
        got = owned.get(i, [])
        if not got:
            review.append(f"quiet    {e['t']:.2f} {e['label']}: planned ({e['hear']}) but real-sfx placed nothing; "
                          "see its 'NOT mapped' list or pick a recording by hand")
            continue
        if str(e["type"]).lower() in TYPING:
            continue
        first = min(got, key=lambda c: abs(float(c.get("t", 0)) - e["t"]))
        off = float(first.get("t", 0)) - e["t"]
        timing.append((e, first, off))
        if abs(off) > frame + 1e-6:
            review.append(f"moved    {e['t']:.2f} {e['label']}: placed at {float(first['t']):.2f} s ({off:+.2f} s); "
                          "put it back on the event's frame (sheet.py move) unless the frames show it belongs there")
    for c in extra:
        review.append(f"extra    {float(c.get('t', 0)):.2f} {c.get('label') or c.get('role', '?')}: a sound nobody "
                      "planned; drop it (sheet.py drop --at T) or add the moment to the plan with the user's OK")

    # events.json for sound_balance.py: the planned moments in the effects stem, at the time real-sfx placed them
    events = []
    placed_t = {id(e): float(c.get("t", e["t"])) for e, c, _ in timing}
    for e in plan:
        if e["source"] != "library":
            continue
        t = placed_t.get(id(e), e["t"])
        ev = {"time": round(t, 3), "label": e["label"], "kind": e["hear"]}
        if e.get("len") and e["hear"] == "texture":
            ev["end"] = round(t + float(e["len"]), 3)
        events.append(ev)
    (audio / "events.json").write_text(json.dumps(events, indent=1) + "\n", encoding="utf-8")

    # every recording real-sfx placed for a planned moment: a copy in assets/audio/effects/ and a SOURCES.md row.
    # An unplanned sound gets neither: the REVIEW line above says to drop it.
    fx_dir = proj / "assets" / "audio" / "effects"
    sources = proj / "assets" / "audio" / "SOURCES.md"
    text = sources.read_text(encoding="utf-8") if sources.is_file() else (
        "# Sound and music sources\n\nThese files stay in this project and are never committed to a public "
        "repository.\n")
    listed = {r for r in table_files(text)}
    extra_ids = {id(c) for c in extra}
    used: dict[str, list[str]] = {}
    origin: dict[str, tuple[Path, bool]] = {}
    for c in cues:
        if id(c) in extra_ids:
            continue
        f, is_ui = placed_file(c)
        if f is None:
            review.append(f"file     {float(c.get('t', 0)):.2f} {c.get('label', '?')}: no source file in the resolved "
                          "cue; add its SOURCES.md row by hand")
            continue
        name = free_name(fx_dir, f, is_ui, origin)
        origin[name] = (f, is_ui)
        used.setdefault(name, []).append(f"{c.get('label') or c.get('role', '')} at {float(c.get('t', 0)):.2f} s")
    copied = 0
    new_rows = []
    for name, (f, is_ui) in origin.items():
        dest = fx_dir / name
        if not f.is_file():
            review.append(f"file     {name}: the recording {f} is gone; copy it into assets/audio/effects/ by hand")
            continue
        fx_dir.mkdir(parents=True, exist_ok=True)
        if not dest.exists():
            shutil.copy2(f, dest)
            copied += 1
        rel = f"effects/{name}"
        if rel in listed:
            continue
        if is_ui:
            src, page, maker, lic = UISFX_ROW
            page, when = f"uisfx {f.parent.name}/{f.stem}", dt.date.today().isoformat()
        else:
            info = lookup_source(f)
            src, page, maker, lic, when = (info["source"], info["page"], info["maker"], info["licence"],
                                           info["downloaded"])
            if not lic:
                where = f"its library's {info['listed_in']}" if info["listed_in"] else "no SOURCES.md in its library"
                review.append(f"licence  {rel}: no licence found ({where}); fill in its row before any render goes out")
        used_for = "; ".join(used[name])
        row = [f"`{rel}`", src, page, maker, lic, when, used_for]
        new_rows.append("| " + " | ".join(x.replace("|", "/") for x in row) + " |")
    if new_rows:
        text = add_rows(text, new_rows)
    sources.parent.mkdir(parents=True, exist_ok=True)
    sources.write_text(text, encoding="utf-8")

    report = {"effects": str(audio / "effects.wav"), "events": events, "copied": copied,
              "timing": [{"label": e["label"], "planned": e["t"], "placed": float(c.get("t", 0)),
                          "offset_s": round(o, 3)} for e, c, o in timing],
              "review": review}
    (audio / "sfx").mkdir(parents=True, exist_ok=True)
    (audio / "sfx" / "handoff.json").write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    for line in review:
        print(f"REVIEW {line}")
    lib_n = sum(1 for e in plan if e["source"] == "library")
    print(f"{lib_n} planned, {sum(1 for v in owned.values() if v)} placed, {len(extra)} unplanned; "
          f"{len(events)} events in build/audio/events.json; {copied} recordings copied to assets/audio/effects/, "
          f"{len(new_rows)} SOURCES.md rows added")
    return 2 if review else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("events", help="sound plan -> real-sfx's typed event list")
    e.add_argument("plan", type=Path)
    e.add_argument("--out", type=Path, required=True)
    e.add_argument("--duration", type=float, help="the film's length in seconds, to catch times outside it")
    e.add_argument("--real-sfx", type=Path, help="real-sfx's skill folder (default: real-sfx/ in this skill's folder)")
    pn = sub.add_parser("pins", help="real-sfx's cue sheet -> labels and named recordings for sheet.py apply")
    pn.add_argument("plan", type=Path)
    pn.add_argument("--cues", type=Path, required=True, help="the cue sheet from_cues.py wrote")
    pn.add_argument("--out", type=Path, required=True)
    pn.add_argument("--real-sfx", type=Path, help="real-sfx's skill folder (default: real-sfx/ in this skill's folder)")
    c = sub.add_parser("collect", help="real-sfx's results -> effects.wav, events.json, effects/ and SOURCES.md")
    c.add_argument("plan", type=Path)
    c.add_argument("--resolved", type=Path, required=True, help="real-sfx's <stem>_resolved_cues.json")
    c.add_argument("--track", type=Path, required=True, help="real-sfx's <stem>_sfx_track.wav")
    c.add_argument("--project", type=Path, default=Path("."))
    c.add_argument("--fps", type=float, default=30.0, help="the film's frame rate: a sound more than one frame "
                                                           "off its planned time is reported")
    a = ap.parse_args()
    return {"events": cmd_events, "pins": cmd_pins, "collect": cmd_collect}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
