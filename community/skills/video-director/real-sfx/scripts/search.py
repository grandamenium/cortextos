#!/usr/bin/env python3
"""Search the indexed library by role, length and character, or list uisfx cues.

  search.py --role whoosh --target-dur 0.7                  # closest in length first
  search.py --role hit --punchy --dark --limit 5            # short attack, low centroid
  search.py --role whoosh --like 412 --limit 5              # sounds that resemble sound #412
  search.py --query "glitch" --library sfx --max-dur 1
  search.py --roles                                         # role overview with counts
  search.py --uisfx                                         # all uisfx cues by category
  search.py --uisfx success                                 # one cue: file in the default pack

Output columns: id, library, role, length, peak, centroid (Hz, high = bright), attack (ms, low =
punchy), low-end share, name.  Sounds the user banned (taste.py) are hidden, loved ones are marked +.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import SKILL_DIR, effective_dur, load_config
from picker import find, load_index, load_taste, rank


def uisfx_dir(cfg):
    d = Path(cfg["uisfx"]["path"])
    return d if d.is_absolute() else SKILL_DIR / d


def uisfx_manifest(cfg):
    p = uisfx_dir(cfg) / "manifest.json"
    if not p.exists():
        sys.exit(f"uisfx not installed: run `npm install uisfx --prefix {SKILL_DIR / 'vendor'}`")
    return json.loads(p.read_text(encoding="utf-8"))


def uisfx_file(cfg, cue, pack=None):
    pack = pack or cfg["uisfx"]["default_pack"]
    f = uisfx_dir(cfg) / "sounds" / pack / f"{cue}.mp3"
    return f if f.exists() else None


# an interface cue that was not tried on its own takes the verdict of the cue it is closest to (a notification is a
# success that was not asked for)
UI_ALIAS = {"notification": "success", "complete": "success"}


def taste_pack(taste, cue, default):
    """The pack the person rated best for this cue (taste.json "uisfx": {cue: {pack: verdict}}), else the default;
    a tie that holds the default keeps the default."""
    prefs = (taste.get("uisfx") or {}).get(cue) or {}
    score = {"love": 2, "ok": 1}
    best = max((score.get(v, -1) for v in prefs.values()), default=-1)
    if best < 1:
        return default
    cands = sorted(p for p, v in prefs.items() if score.get(v, -1) == best)
    return default if default in cands else cands[0]


def taste_ui_source(taste, cue):
    """"library" / "uisfx" / None: where the person liked this interface cue better (taste.json "ui_source")."""
    src = taste.get("ui_source") or {}
    return src.get(cue) or src.get(UI_ALIAS.get(cue))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--role")
    ap.add_argument("--query", help="substring of folder/name, case-insensitive; 'a|b' = either")
    ap.add_argument("--library")
    ap.add_argument("--min-dur", type=float, default=0)
    ap.add_argument("--max-dur", type=float, default=1e9)
    ap.add_argument("--target-dur", type=float, help="rank by closeness to this length in seconds")
    ap.add_argument("--like", help="id or path of a sound whose character to match")
    ap.add_argument("--says", help='words it must be described by, e.g. "punchy dark heavy" (see the words column)')
    ap.add_argument("--bright", action="store_true")
    ap.add_argument("--dark", action="store_true")
    ap.add_argument("--punchy", action="store_true", help="attack of 40 ms or less")
    ap.add_argument("--attack-max", type=float, help="most ms from the first sound to the peak (punchy = 30)")
    ap.add_argument("--attack-min", type=float)
    ap.add_argument("--centroid-max", type=float, help="highest brightness in Hz (dark/heavy = under 1000)")
    ap.add_argument("--centroid-min", type=float)
    ap.add_argument("--low-min", type=float, help="least share of energy under 250 Hz, 0..1 (heavy = 0.6)")
    ap.add_argument("--low-max", type=float)
    ap.add_argument("--tag", help="a YAMNet tag it must have (needs level 2): knock, glass, thump ...; several "
                                  "with commas (thunk,thump = either); the surer the model, the higher the rank")
    ap.add_argument("--tier", choices=["main", "extra", "all"],
                    help="main: only the main libraries; extra: only the fallback ones; all: both, no preference "
                         "(default: main first, extras only where fewer than 3 main sounds fit)")
    ap.add_argument("--include-banned", action="store_true")
    ap.add_argument("--limit", type=int, default=15)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--paths", action="store_true", help="print the file path (and the YAMNet tags) under every row")
    ap.add_argument("--sheet", metavar="PNG", help="also draw the results as a waveform/spectrogram contact sheet")
    ap.add_argument("--roles", action="store_true")
    ap.add_argument("--uisfx", nargs="?", const="__list__")
    ap.add_argument("--pack")
    a = ap.parse_args()
    cfg = load_config()

    if a.uisfx:
        m = uisfx_manifest(cfg)
        if a.uisfx == "__list__":
            cats = {}
            for c in m["cues"]:
                cats.setdefault(c["category"], []).append(c["name"] + ("*" if c["loop"] else ""))
            for k, v in cats.items():
                print(f"{k}: {', '.join(v)}")
            print("(* = loop)  packs:", ", ".join(p if isinstance(p, str) else p.get("name", "?") for p in m["packs"]))
        else:
            f = uisfx_file(cfg, a.uisfx, a.pack)
            print(f if f else f"no uisfx cue '{a.uisfx}' in pack '{a.pack or cfg['uisfx']['default_pack']}'")
            if f and a.sheet:
                from common import analyse_sound
                from contact_sheet import render_sheet
                rec = dict(analyse_sound(f) or {}, id=0, path=str(f), role="ui", library="uisfx", name=a.uisfx,
                           folder=a.pack or cfg["uisfx"]["default_pack"])
                print("sheet:", render_sheet([rec], a.sheet, 1))
        return

    index = load_index()
    if a.roles:
        counts = {}
        for s in index:
            counts[s["role"]] = counts.get(s["role"], 0) + 1
        for r, n in sorted(counts.items(), key=lambda kv: -kv[1]):
            print(f"{r:10s} {n}")
        return

    spec = {"role": a.role, "library": a.library, "min_dur": a.min_dur, "max_dur": a.max_dur,
            "target_dur": a.target_dur, "bright": a.bright, "dark": a.dark, "punchy": a.punchy,
            "query": a.query, "says": a.says, "attack_max": a.attack_max, "attack_min": a.attack_min,
            "centroid_max": a.centroid_max, "centroid_min": a.centroid_min, "low_min": a.low_min,
            "low_max": a.low_max, "tag": a.tag, "tier": a.tier}
    if a.like is not None:
        ref = find(index, a.like)
        if not ref:
            sys.exit(f"--like: not found: {a.like}")
        spec["like"] = ref["id"]
        print(f"like [{ref['id']}] {ref['library']}/{ref['name']}  centroid {ref.get('centroid')} Hz, "
              f"attack {ref.get('attack_ms')} ms, {ref['duration']:.2f}s")
    taste = load_taste()
    ranked = rank(index, spec, taste=taste, include_banned=a.include_banned)[: a.limit]
    if not ranked:
        print("0 sounds match.")
        if a.says:
            words_ = a.says.replace(",", " ").split()
            for w in words_:
                rest = " ".join(x for x in words_ if x != w)
                n = len(rank(index, dict(spec, says=rest or None), taste=taste, include_banned=a.include_banned))
                print(f"  without the word '{w}': {n} sound(s)")
            print("  --says needs EVERY word to be in a sound's plain-word description or sure YAMNet tags; "
                  "--punchy / --dark / --bright are soft preferences and never empty the list.")
        else:
            print("  loosen --max-dur / --role / --query, or check the library name with --roles")
        if a.tag:
            print("  --tag is an AudioSet class as listen.py describe prints it (Knock, Thunk, Thump, Tick, Whoosh, "
                  "Plop, Typing ...), matched as part of the name; --query looks into file and folder names instead")
    if a.sheet and ranked:
        from contact_sheet import render_sheet
        print("sheet:", render_sheet([s for _, s in ranked], a.sheet))
    loved = set(taste.get("love", []))
    if a.json:
        print(json.dumps([dict(s, score=sc) for sc, s in ranked], ensure_ascii=False, indent=1))
        return
    for sc, s in ranked:
        print(f"[{s['id']:>4}]{'+' if s['path'] in loved else ' '}{s['library'][:9]:9s}{'' if s.get('tier', 'main') == 'main' else '~'} {s['role']:8s} "
              f"{effective_dur(s):6.2f}{'*' if effective_dur(s) < s['duration'] - 0.15 else 's'} pk{s['peak_db']:>6.1f}  c{s.get('centroid', 0):>5} a{s.get('attack_ms', 0):>4} "
              f"lo{s.get('low', 0):.2f}  {s['folder'][-24:]}/{s['name'][-42:]}  [{' '.join(s.get('words', []))}]")
        if a.paths:
            tg = ", ".join(n for n, c in zip(s.get("tags", []), s.get("tag_scores") or [0.5] * len(s.get("tags", [])))
                           if c >= 0.2)
            print(f"        {s['path']}" + (f"   tags: {tg}" if tg else "")
                  + (f"   source: {s['source']}" + (f" hit {s['hit']}/{s['hits_in_source']}" if s.get('hit') else "")
                     if s.get("source") else ""))
    print(f"-- {len(ranked)} shown   (a '*' after the length: the file is longer, the rest is silence)")


if __name__ == "__main__":
    main()
