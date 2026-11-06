"""Choose sounds from the index by role, length and character, with variety and taste memory.

A spec is a dict:
  role         required, e.g. "whoosh"
  target_dur   preferred length in seconds (ranks by closeness; sounds can be stretched to fit)
  min_dur / max_dur   hard limits
  library      restrict to one library name
  tier         "main" | "extra" | "all". Default: libraries of tier "main" first; "extra" libraries (the fallback
               tier of config.json) only where fewer than 3 main sounds fit
  like         id or path of a sound whose character should be matched
  bright / dark       True: prefer brighter or darker sounds
  punchy       True: attack <= 40 ms
  query        substring of folder/name
"""
import json
import math
import os
import re
import statistics
from operator import mul as _mul
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import ROLE_TARGET_PEAK_DB, SKILL_DIR, effective_dur, family_key, index_path, load_config

TASTE_PATH = Path(os.environ.get("REAL_SFX_TASTE") or SKILL_DIR / "taste.json")    # (the env: the selftest)
_FEATS = ("centroid", "rolloff", "low", "high", "flat", "attack_ms", "decay_ms", "duration")


def load_index():
    p = index_path(load_config())
    if not p.exists():
        sys.exit("library_index.json missing, run: python scripts/build_index.py")
    return json.loads(p.read_text(encoding="utf-8"))["sounds"]


_EMB = None


def embeddings():
    """path -> 1024-number YAMNet embedding, if listen.py tag-index has been run (pure python, no numpy)."""
    global _EMB
    if _EMB is not None:
        return _EMB
    _EMB = {}
    jp, bp = SKILL_DIR / "library_embeddings.json", SKILL_DIR / "library_embeddings.bin"
    if jp.exists() and bp.exists():
        import array
        meta = json.loads(jp.read_text(encoding="utf-8"))
        raw = array.array("f")
        raw.frombytes(bp.read_bytes())
        dim = meta.get("dim", 1024)
        for i, pth in enumerate(meta["paths"]):
            v = raw[i * dim:(i + 1) * dim]
            n = math.sqrt(sum(x * x for x in v)) or 1.0
            _EMB[pth] = [x / n for x in v]
    return _EMB


_STEADY = None


def steady_numbers():
    """path -> {ripple, flutter, swing} from the cache `bed.py --scan` writes ({} when it was never run)."""
    global _STEADY
    if _STEADY is None:
        from common import load_steady
        _STEADY = load_steady()
    return _STEADY


def load_taste():
    if TASTE_PATH.exists():
        return json.loads(TASTE_PATH.read_text(encoding="utf-8"))
    return {"ban": [], "love": [], "notes": {}}


def _vec(s):
    return [
        math.log(max(s["centroid"], 50)), math.log(max(s["rolloff"], 50)), s["low"], s["high"], s["flat"],
        math.log1p(s["attack_ms"]), math.log1p(s["decay_ms"]), math.log(max(effective_dur(s), 0.02)),
    ]


def _scales(index):
    cols = list(zip(*[_vec(s) for s in index if "centroid" in s]))
    return [statistics.pstdev(c) or 1.0 for c in cols]


def _passes_numbers(s, spec):
    """Numeric limits on measured character (attack in ms, centroid in Hz, shares 0..1) and a YAMNet tag."""
    for key, field, upper in (("attack_max", "attack_ms", True), ("attack_min", "attack_ms", False),
                              ("centroid_max", "centroid", True), ("centroid_min", "centroid", False),
                              ("low_max", "low", True), ("low_min", "low", False),
                              ("flat_max", "flat", True), ("flat_min", "flat", False)):
        lim = spec.get(key)
        if lim is None:
            continue
        v = s.get(field)
        if v is None or (v > lim if upper else v < lim):
            return False
    om = spec.get("onsets_max")
    if om is not None and s.get("onset_count") is not None and s["onset_count"] > om:
        return False                         # a three-click gesture or a typing take is not "a click"
    tag = spec.get("tag")
    if tag:
        wanted = [x.strip().lower() for x in str(tag).replace("|", ",").split(",") if x.strip()]
        conf = s.get("tag_scores") or [0.5] * len(s.get("tags", []))
        if not any(any(t in n.lower() for t in wanted) and c >= 0.2 for n, c in zip(s.get("tags", []), conf)):
            return False
    return True


# sounds of a role that are a joke or a voice, not the thing the role names: kept out of an automatic pick unless the
# spec asks for them by words (query / says): a mouth pop is not a UI pop
AVOID_UNLESS_ASKED = {"pop": re.compile(r"ртом|mouth|lips|губ", re.I),
                      # a chime for "ready" must not be a "magic protection BREAKING" or an alarm
                      "chime": re.compile(r"break|shatter|crack|smash|destroy|crash|explo|alarm|siren|fail|error|"
                                          r"denied|warning|buzzer|ломан|разбив", re.I),
                      # the censor bleep is a joke the library files under error: round 8, "never" for one of them, "ok" for
                      # another, and the one the person loved was Kenyset's "erreur"
                      "error": re.compile(r"censor|цензур", re.I),
                      # a rubber stretch or a belt creak is not a cartoon hit: round 8, three "not here" on a bouncing ball
                      # ("растягивание какое-то") and a "never" for the belt
                      "cartoon": re.compile(r"stretch|friction|belt|растяж", re.I)}
# musical drum fills that the library also files under ui / pop / click / chime: the person's verdict in the taste test
# was "барабаны какие-то / барабаны опять" (a fill as the impact of a cut they loved, so only these roles keep them out)
AVOID_IN_ROLE = {r: re.compile(r"drums?\s*fills?|барабан", re.I) for r in ("ui", "pop", "click", "chime")}


def find(index, ref):
    """Resolve an id or a path/name fragment to an index record."""
    if isinstance(ref, int) or str(ref).isdigit():
        return next((s for s in index if s["id"] == int(ref)), None)
    ref = str(ref).lower()
    return next((s for s in index if s["path"].lower() == ref), None) or \
        next((s for s in index if ref in s["path"].lower()), None)


def twins_of(paths, index=None):
    """The paths and every other copy of the same recording (the same dup_key in the index): a ban or a love of one copy
    covers them all (a recording lies in the library twice when two packs or two folders hold it)."""
    index = index if index is not None else load_index()
    by_path = {s["path"]: s for s in index}
    groups = {}
    for s in index:
        if s.get("dup_key"):
            groups.setdefault(s["dup_key"], []).append(s["path"])
    out = set(paths)
    for p in list(paths):
        dk = (by_path.get(p) or {}).get("dup_key")
        if dk:
            out.update(groups.get(dk, []))
    return out


def rank(index, spec, used=None, taste=None, include_banned=False):
    """Return candidates best first as (score, record)."""
    used = used or {}
    taste = taste or load_taste()
    banned, loved = set(taste.get("ban", [])), set(taste.get("love", []))
    sc = _scales(index)
    like = find(index, spec["like"]) if spec.get("like") is not None else None
    lv = _vec(like) if like and "centroid" in like else None
    emb = embeddings() if like else {}
    lemb = emb.get(like["path"]) if like else None
    cent = [s["centroid"] for s in index if "centroid" in s and spec.get("role") in s["roles"]]
    med_c = statistics.median(cent) if cent else 1000
    out = []
    dup_of = {s["path"]: s.get("dup_key") for s in index if s.get("dup_key")}
    used_dups = {dup_of[pth] for pth in used if pth in dup_of}
    # takes of one recording ("Glass Crack - 01..04") count as one family: used ones push their siblings down
    by_path = {s["path"]: s for s in index}
    fam_used = {}
    for pth, cnt in used.items():
        r_ = by_path.get(pth)
        if r_:
            k_ = (r_["library"], family_key(r_["name"]))
            fam_used[k_] = fam_used.get(k_, 0) + cnt
    tier = spec.get("tier")
    for s in index:
        role = spec.get("role")
        if role and role not in s["roles"]:
            continue
        if spec.get("library") and s["library"] != spec["library"]:
            continue
        if tier in ("main", "extra") and s.get("tier", "main") != tier:
            continue
        d = effective_dur(s)              # the audible length: pack files padded with silence count as short
        if d < spec.get("min_dur", 0) or d > spec.get("max_dur", 1e9):
            continue
        if spec.get("query"):
            hay_ = (s["folder"] + " " + s["name"] + " " + " ".join(s.get("aliases", []))).lower()
            if not any(q_.strip().lower() in hay_ for q_ in str(spec["query"]).split("|") if q_.strip()):
                continue                      # "lego|thud": any of the parts is enough
        if not _passes_numbers(s, spec):
            continue
        # the name guards: a sound asked for by words (query / says / like) or LOVED by the person passes them (round 8:
        # a soft drum fill was loved as a pop and a chime while the guard kept every drum fill out of those roles)
        guarded = not (spec.get("query") or spec.get("says") or spec.get("like")) and s["path"] not in loved
        hay_g = s["name"] + " " + s.get("folder", "")
        av_ = AVOID_UNLESS_ASKED.get(role) if role else None
        if guarded and av_ is not None and av_.search(hay_g):
            continue
        av2_ = AVOID_IN_ROLE.get(role) if role else None
        if guarded and av2_ is not None and av2_.search(hay_g):
            continue
        # the same protection when the pool is another role that holds these sounds too: role `ui` is ui + pop + chime,
        # and a mouth pop is no more a UI sound than it is a pop
        if guarded and any(r_ != role and r_ in s.get("roles", []) and rx_.search(hay_g)
                           for r_, rx_ in AVOID_UNLESS_ASKED.items()):
            continue
        tag_bonus = 0.0
        if spec.get("says"):
            # plain words always count; a YAMNet tag counts when the model was at least 30 % sure of it
            tconf = {t.lower(): c for t, c in zip(s.get("tags", []), s.get("tag_scores") or [0.5] * len(s.get("tags", [])))}
            have = set(s.get("words", [])) | set(s.get("aliases", [])) | {t for t, c in tconf.items() if c >= 0.30}
            # the words of its own folder and name count too ('boom' finds 'Cinematic Boom Hits')
            have |= set(re.findall(r"[a-zа-я0-9]{3,}", (s.get("folder", "") + " " + s.get("name", "")).lower()))
            groups = [[x for x in w.lower().split("|") if x] for w in str(spec["says"]).replace(",", " ").split()]
            if not all(any(x in have or any(x in h for h in have) for x in grp) for grp in groups):
                continue
            # the more certain the model is, the better the match (a bonus of up to 1.0)
            want = [x for grp in groups for x in grp]
            hit = [c for t, c in tconf.items() if any(w in t for w in want)]
            tag_bonus = min(1.0, max(hit)) if hit else 0.0
        if not include_banned and s["path"] in banned:
            continue
        if like and s["id"] == like["id"]:
            continue
        score = 0.0 if (not role or s["role"] == role) else 1.0
        if spec.get("target_dur"):
            score += 1.2 * abs(math.log(max(d, 0.02) / spec["target_dur"]))
        if lv and "centroid" in s:
            v = _vec(s)
            score += 0.9 * math.sqrt(sum(((a - b) / k) ** 2 for a, b, k in zip(v, lv, sc)) / len(v))
        if lemb is not None and s["path"] in emb:
            cos = sum(a * b for a, b in zip(lemb, emb[s["path"]]))
            score += 1.5 * (1.0 - max(0.0, cos))              # meaning, not just spectrum
        if "centroid" in s and spec.get("centroid"):
            # the author's own sound had this brightness: the replacement of a similar timbre keeps the mix's balance
            score += 0.7 * abs(math.log(max(s["centroid"], 50) / max(float(spec["centroid"]), 50.0)))
        if "centroid" in s:
            if spec.get("bright"):
                score += 0.5 * max(0.0, math.log(med_c / max(s["centroid"], 50)))
            if spec.get("dark"):
                score += 0.5 * max(0.0, math.log(max(s["centroid"], 50) / med_c))
            if spec.get("punchy") and s["attack_ms"] > 40:
                score += 0.4 + min(1.0, s["attack_ms"] / 400)
        if s.get("bumps", 0) >= 8 and d >= 0.5 and role in ("whoosh", "riser", "hit", "sub_drop")                 and "pulsing" not in str(spec.get("says", "")):
            score += 0.8                                        # rhythmic/tremolo texture, not a smooth swell
        if role == "ambience":
            # a floor must be steady: a recording that moves 5-8 dB about twice a second was heard as "гул" (a drone
            # that throbs); measured by bed.py --scan, a recording nobody has measured is not judged
            st_ = steady_numbers().get(s["path"])
            if st_:
                score += min(2.0, 0.3 * max(0.0, st_["ripple"] - 3.5)) + min(1.0, 0.04 * max(0.0, st_["swing"] - 12.0))
        if "peak_db" in s and role:
            boost = ROLE_TARGET_PEAK_DB.get(role, -10) - s["peak_db"]
            if boost > 8:
                score += min(2.0, 0.12 * (boost - 8))          # a quiet recording: its noise floor comes up with it
        if role in ("whoosh", "riser") and s.get("mean_db") is not None and "peak_db" in s and s.get("duration"):
            act_ = max(0.05, min(s["duration"], s.get("active_dur") or s["duration"]))
            crest = s["peak_db"] - (s["mean_db"] + 10 * math.log10(max(s["duration"], 0.05) / act_))
            if crest > 28.0:
                score += min(0.8, 0.07 * (crest - 28.0))        # a thin swipe: all peak, no body (a crest of 35 dB)
        score += 1.5 * used.get(s["path"], 0)
        if s.get("dup_key") in used_dups and s["path"] not in used:
            score += 1.5                                        # a copy of a sound that is already used
        fk = (s["library"], family_key(s["name"]))
        if fam_used.get(fk) and s["path"] not in used:
            score += 0.6 * min(3, fam_used[fk])                 # another take of a family that is already on the sheet
        if s["path"] in loved:
            score -= 1.0
        if role and role in (taste.get("not_for") or {}).get(s["path"], ()):
            score += 1.2                                        # "not here" for this role, said by the person
        score -= tag_bonus
        if spec.get("tag") and s.get("tags"):
            wanted_ = [x.strip().lower() for x in str(spec["tag"]).replace("|", ",").split(",") if x.strip()]
            conf2 = s.get("tag_scores") or [0.5] * len(s["tags"])
            best2 = max((c_ for n_, c_ in zip(s["tags"], conf2) if any(t_ in n_.lower() for t_ in wanted_)), default=0.0)
            score -= 1.0 * min(1.0, best2)                    # the surer the model, the nearer the top
        if spec.get("prefer_tag") and s.get("tags"):
            # a soft preference by meaning ("whoosh" keeps torn paper and cloth rips out of the whoosh slot)
            pt = str(spec["prefer_tag"]).lower()
            conf_ = s.get("tag_scores") or [0.5] * len(s["tags"])
            best = max((c_ for n_, c_ in zip(s["tags"], conf_) if pt in n_.lower()), default=0.0)
            if best >= 0.30:
                score -= 0.9 * min(1.0, best)
        if role == "whoosh" and not spec.get("dark") and spec.get("low_min") is None and s.get("low", 0) >= 0.7 \
                and "heavy" not in str(spec.get("says", "")) and "sub" not in str(spec.get("says", "")):
            score += 0.5
        if role in ("whoosh", "riser", "design", "scifi") and s.get("lr_corr", 1.0) < 0.2:
            score += 0.5 if s["lr_corr"] >= -0.3 else 1.0       # channels in opposite phase: thin on a phone speaker
        out.append((round(score, 4), s))
    if tier is None and not spec.get("library"):
        # the fallback tier fills only what the main libraries cannot: with three or more fitting main sounds the
        # extras are not offered at all; with fewer they follow behind (variety needs more than one or two)
        main_n = sum(1 for _, s in out if s.get("tier", "main") == "main")
        if main_n >= 3:
            out = [(sc, s) for sc, s in out if s.get("tier", "main") == "main"]
        elif main_n < len(out):
            out = [(round(sc + (0.0 if s.get("tier", "main") == "main" else 1.0), 4), s) for sc, s in out]
    out.sort(key=lambda t: (t[0], t[1]["id"]))
    # variety by MEANING: a candidate whose embedding is close to a sound already on the sheet is another take of
    # the same thing (takes of one recording sit at 0.83-0.92, two random whooshes at a median of 0.55)
    used_vecs = [embeddings().get(p) for p in used] if used else []
    used_vecs = [v for v in used_vecs if v is not None]
    if used_vecs and len(out) > 1:
        emb_ = embeddings()
        head, rest = out[:25], out[25:]
        rescored = []
        for sc, s in head:
            v = emb_.get(s["path"])
            if v is not None and s["path"] not in used:
                sim = max(sum(map(_mul, v, u)) for u in used_vecs)
                if sim > 0.82:
                    sc = round(sc + 1.5 * min(1.0, (sim - 0.82) / 0.18), 4)
            rescored.append((sc, s))
        rescored.sort(key=lambda t: (t[0], t[1]["id"]))
        out = rescored + rest
    return out


def pick(index, spec, used=None, taste=None):
    r = rank(index, spec, used, taste)
    return r[0][1] if r else None
