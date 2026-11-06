#!/usr/bin/env python3
"""Edit a cue sheet from the command line: a one-line way to add, change, move and drop cues without opening the
JSON (for a shell with no editor, and for scripted rounds of the self-critique loop).

  sheet.py new    SHEET --video film.mp4 [--duration 10]       an empty sheet
  sheet.py show   SHEET                                         one line per cue with its index (time order)
  sheet.py add    SHEET '{"t": 1.2, "pick": {"role": "whoosh"}, "gain_db": -3}' ['{...}' ...]
  sheet.py add    SHEET --from cues.json                        many cues at once (a JSON list; '-' = stdin)
  sheet.py add    SHEET --event key@89.37 --event bell@40.7:0.8   moments by kind and time, routed like from_cues does
  sheet.py set    SHEET (--at 1.2 [--label bead] | --index 7 | --label bead) gain_db=-4 pitch=2 anchor=start pick.role=click
  sheet.py set    SHEET --label bead --unset slice fit_dur      delete keys
  sheet.py drop   SHEET (--at 1.2 | --index 7 | --label bead | --between 10 20 [--role click])
  sheet.py shift  SHEET --by 0.12 [--between 5 20] [--role whoosh]     move cues in time
  sheet.py gain   SHEET --db -3 [--between 5 20] [--role click]        add dB to cues
  sheet.py move   SHEET --at 1.2 --to 1.25                             one cue to another time
  sheet.py top    SHEET keep_audio=no 'base_audio=["music.wav"]'       keys of the sheet itself
  sheet.py apply  SHEET edits.json                                      a batch (below); one write, one numbering
  sheet.py freeze SHEET RESOLVED.json                                   pin the sounds a render picked (file/slice/pitch)
  sheet.py repick SHEET [--keep 3] [--roles click ui ...] [--dry]       swap the sounds the person's taste ranks low

Values are JSON when they parse as JSON (numbers, true, [0.1, 0.05]), else text. A key like pick.role writes into
the pick. Setting id, file or uisfx replaces an automatic `pick` (a named sound beats an automatic choice). The sheet
is kept in time order (ties by label, then as written), and `show` prints that order: an index printed by `show`
is valid for every later edit. Selectors combine (--at 1.2 --label thump = the thump at 1.2 s); --at alone is a
time within 30 ms and must name one cue when the command changes or drops it. `--backup` keeps SHEET.bak.

apply: a JSON list of operations, every selector resolved against the sheet as it was before the batch:
  [{"at": 1.2, "label": "thump", "set": {"id": 800, "slice": [0.78, 0.12]}},
   {"label": "bead", "gain": -3}, {"between": [5, 6], "drop": true}, {"index": 3, "unset": ["slice"]},
   {"at": 2.0, "label": "whoosh", "shift": 0.04}, {"at": 3.0, "move": 3.05}]
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import load_json, norm_path, read_stdin_text, read_text_any

SOURCE_KEYS = ("pick", "id", "file", "uisfx")      # exactly one of these names the sound of a cue


def order_key(pair):
    n, c = pair
    return (float(c.get("t", 0.0)), str(c.get("label", "")), n)


def load(path):
    p = Path(path)
    if not p.exists():
        sys.exit(f"sheet not found: {p}")
    d = load_json(p)
    if isinstance(d, list):
        d = {"cues": d}
    d.setdefault("cues", [])
    d["cues"] = [c for _, c in sorted(enumerate(d["cues"]), key=order_key)]      # the numbering `show` prints
    return d


def save(path, d, backup):
    p = Path(path)
    if backup and p.exists():
        shutil.copyfile(p, str(p) + ".bak")
    d["cues"] = [c for _, c in sorted(enumerate(d["cues"]), key=order_key)]
    p.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")


def value(text):
    try:
        return json.loads(text)
    except ValueError:
        return text


_ROLES = None


def _index_roles():
    """{id: role}, {path: role} of the library index: a cue that names a sound by id has no role of its own."""
    global _ROLES
    if _ROLES is None:
        try:
            from picker import load_index
            idx = load_index()
            _ROLES = ({s["id"]: s["role"] for s in idx}, {s["path"]: s["role"] for s in idx})
        except (SystemExit, Exception):
            _ROLES = ({}, {})
    return _ROLES


def role_of(c):
    r = c.get("role") or (c.get("pick") or {}).get("role")
    if r:
        return r
    if "uisfx" in c:
        return "ui"
    by_id, by_path = _index_roles()
    return by_id.get(c.get("id")) or by_path.get(str(c.get("file", "")))


def cues_from_events(specs, kinds_user=None):
    """--event KIND@T[:G]: the moments are routed the way from_cues routes a list (key = the real keyboard, bell =
    a chime ...): the same picks, the same levels, no cue to write by hand. kinds_user: the kinds the sheet's own
    from_cues call declared with --kind / --map (`_draft.kinds_user`), so a kind such as `chip` routes as it did."""
    evs = []
    for s in specs:
        m = re.fullmatch(r"([A-Za-z_][\w-]*)@(\d+(?:\.\d+)?)(?::(\d+(?:\.\d+)?))?", s.strip())
        if not m:
            sys.exit(f"--event {s!r}: expected KIND@SECONDS[:GAIN], e.g. key@89.37 or bell@40.7:0.8")
        e = {"t": float(m.group(2)), "type": m.group(1)}
        if m.group(3):
            e["g"] = float(m.group(3))
        evs.append(e)
    with tempfile.TemporaryDirectory() as tmp:
        ep, cp = Path(tmp) / "events.json", Path(tmp) / "cues.json"
        ep.write_text(json.dumps(evs), encoding="utf-8")
        cmd = [sys.executable, str(Path(__file__).with_name("from_cues.py")), str(ep), "--out", str(cp), "--no-check",
               "--no-stems", "--no-retime", "--max-rate", "100", "--fuse", "0", "--no-typing-detect"]
        if kinds_user:
            km = Path(tmp) / "kinds.json"                       # a file: a JSON argument is mangled by PowerShell
            km.write_text(json.dumps(kinds_user, ensure_ascii=False), encoding="utf-8")
            cmd += ["--map", str(km)]
        r = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
        if r.returncode or not cp.exists():
            sys.exit("from_cues could not route those events:\n" + (r.stdout + r.stderr)[-700:])
        for ln in r.stdout.splitlines():
            if ln.startswith(("WARN", "NOT mapped")):
                print(ln)
        got = load_json(cp)["cues"]
    for c in got:
        c.pop("_g", None)
    return got


def fix_base_audio(d):
    """A path typed in Git-Bash form (/e/proj/x.wav) is not one for Windows Python: made right, and what does not
    exist is said at once, not at render time."""
    items = d.get("base_audio")
    if not isinstance(items, list):
        return
    for k, it in enumerate(items):
        if isinstance(it, dict) and "file" in it:
            it["file"] = norm_path(it["file"])
            f = it["file"]
        elif isinstance(it, str):
            items[k] = norm_path(it)
            f = re.split(r":-?\d|@-?\d", items[k])[0]
        else:
            continue
        if f and not Path(f).exists() and not Path(str(d.get("video", "."))).parent.joinpath(f).exists():
            print(f"WARN base_audio: {f} does not exist")


def select(d, index=None, at=None, label=None, between=None, role=None, id_=None, need_one=False, what="",
           exact_first=False):
    cues = d["cues"]
    idx = list(range(len(cues)))
    given = False
    if index is not None:
        given = True
        if not 0 <= index < len(cues):
            sys.exit(f"{what}index {index}: the sheet has {len(cues)} cues (0..{len(cues) - 1})")
        idx = [index]
    if at is not None:
        given = True
        idx = [i for i in idx if abs(cues[i].get("t", 0.0) - at) <= 0.03]
        if not idx:
            sys.exit(f"{what}no cue within 30 ms of t={at}")
    if label:
        given = True
        low_ = label.lower()
        sub_ = [i for i in idx if low_ in str(cues[i].get("label", "")).lower()]
        exact_ = [i for i in sub_ if str(cues[i].get("label", "")).lower() == low_]
        # a command that changes ONE cue (set, move) takes the cue whose label IS this, not the ones that merely
        # contain it ('monitor lands' must not catch 'monitor lands sub'); drop, gain, shift keep the substring
        idx = exact_ if (exact_first and exact_) else sub_
    if between:
        given = True
        lo, hi = between
        idx = [i for i in idx if lo <= cues[i].get("t", 0.0) <= hi]
    if role:
        given = True
        idx = [i for i in idx if role_of(cues[i]) == role]
    if id_ is not None:
        given = True
        idx = [i for i in idx if cues[i].get("id") == id_]
    if not idx:
        sys.exit(f"{what}no cue matches")
    time_only = at is not None and index is None and not label and not between and not role and id_ is None
    if need_one and time_only and len(idx) > 1:      # layers at one time: a time alone does not say which
        rows = "\n".join("   " + line(i, cues[i]) for i in idx[:8])
        sys.exit(f"{what}{len(idx)} cues within 30 ms of t={at}, name one (add --label / --role / --index):\n{rows}")
    return idx, given


def put(c, key, val):
    node = c
    parts = key.split(".")
    for part in parts[:-1]:
        node = node.setdefault(part, {})
    node[parts[-1]] = val
    if len(parts) == 1 and parts[0] in ("id", "file", "uisfx"):       # a named sound replaces an automatic choice
        for other in SOURCE_KEYS:
            if other != parts[0] and other != "pick":
                c.pop(other, None)
        c.pop("pick", None)
    if parts[0] == "pick" and len(parts) >= 1:
        for other in ("id", "file", "uisfx"):
            c.pop(other, None)


def unset(c, key):
    node = c
    parts = key.split(".")
    for part in parts[:-1]:
        node = node.get(part)
        if not isinstance(node, dict):
            return
    node.pop(parts[-1], None)


def line(i, c):
    what = c.get("uisfx") and f"uisfx:{c['uisfx']}" or c.get("id") and f"id {c['id']}" or \
        c.get("file") and Path(c["file"]).name or c.get("pick") and f"pick {json.dumps(c['pick'], ensure_ascii=False)}" or "?"
    extra = " ".join(f"{k}={json.dumps(c[k], ensure_ascii=False)}" for k in ("gain_db", "pitch", "anchor", "slice", "fit_dur")
                     if k in c)
    return f"{i:3d}  t={c.get('t', 0.0):8.3f}  {str(c.get('label', ''))[:22]:22s} {what[:48]:48s} {extra}"


def freeze(d, resolved_path):
    """Pin the sounds the last render picked: every library cue gets the file (and slice, pitch) the render used."""
    r = load_json(resolved_path)
    rc = r.get("cues", r) if isinstance(r, dict) else r
    pool = [c for c in rc if isinstance(c, dict) and not c.get("_layer")]
    lpool = [c for c in rc if isinstance(c, dict) and c.get("_layer")]
    done = skipped = 0

    def find(p, t, label):
        for q in p:
            if abs(float(q.get("t", 0)) - t) <= 0.002 and str(q.get("label", "")) == label:
                return q
        for q in p:             # a cue that was moved or relabelled since: the nearest within 20 ms
            if abs(float(q.get("t", 0)) - t) <= 0.02:
                return q
        return None

    def pin(c, match):
        """True when c is now a named sound (or already is one)."""
        if "uisfx" in c or match.get("source") == "uisfx":
            return True                       # a uisfx cue is already a name, nothing to pin
        src = match.get("slice_of") or match.get("file")
        if not src:
            return False
        c.pop("pick", None)
        c.pop("id", None)
        c["file"] = src
        if match.get("slice_of") and match.get("slice"):
            c["slice"] = match["slice"]
        if match.get("pitch"):
            c["pitch"] = match["pitch"]
        if match.get("role") and not c.get("role"):
            c["role"] = match["role"]
        return True

    for c in d["cues"]:
        t0 = float(c.get("t", 0))
        match = find(pool, t0, str(c.get("label", "")))
        if match is None:
            skipped += 1
        else:
            pool.remove(match)
            if pin(c, match):
                done += 1
            else:
                skipped += 1
        # the layers of the cue (a shimmer, a sub drop under a hit) are pinned the same way: their ids drift too
        for lay in c.get("layers") or []:
            if not isinstance(lay, dict):
                continue
            lt = t0 + float(lay.get("dt", 0.0))
            lm = find(lpool, lt, str(lay.get("label") or (str(c.get("label", "")) + " (layer)").strip()))
            if lm is None:
                skipped += 1
                continue
            lpool.remove(lm)
            if pin(lay, lm):
                done += 1
            else:
                skipped += 1
    return done, skipped


def apply_batch(d, ops):
    cues = d["cues"]
    chosen = []
    for n, op in enumerate(ops):
        if not isinstance(op, dict):
            sys.exit(f"operation {n}: expected an object")
        wants_one = any(k in op for k in ("set", "unset", "drop", "move"))
        idx, given = select(d, op.get("index"), op.get("at"), op.get("label"),
                            op.get("between"), op.get("role"), op.get("id"), need_one=wants_one,
                            what=f"operation {n}: ",
                            exact_first=any(k in op for k in ("set", "unset", "move")))
        if not given and ("drop" in op):
            sys.exit(f"operation {n}: drop needs a selector")
        chosen.append((op, [cues[i] for i in idx]))
    drop_ids = set()
    for op, targets in chosen:
        for c in targets:
            for k, v in (op.get("set") or {}).items():
                put(c, k, v)
            for k in op.get("unset") or []:
                unset(c, k)
            if "shift" in op:
                c["t"] = round(float(c.get("t", 0.0)) + float(op["shift"]), 4)
            if "gain" in op:
                c["gain_db"] = round(float(c.get("gain_db", 0.0)) + float(op["gain"]), 2)
            if "move" in op:
                c["t"] = round(float(op["move"]), 4)
            if op.get("drop"):
                drop_ids.add(id(c))
    d["cues"] = [c for c in cues if id(c) not in drop_ids]
    return len(ops), len(drop_ids)


def repick(d, roles=None, keep=3, dry=False):
    """Swap the sound of every cue whose current sound the person's taste (taste.json: love, ban, not_for) puts
    outside the first `keep` of its role, for the best-ranked sound of that role of a similar length and brightness.
    A loved sound stays; a banned one always goes; a typing key (slice), a uisfx cue and a bed are left alone.
    Everything else of the cue (time, gain, fit, layers) stays as it was."""
    import picker
    from common import effective_dur
    idx = picker.load_index()
    by_id = {s["id"]: s for s in idx}
    by_path = {s["path"]: s for s in idx}
    taste = picker.load_taste()
    loved, banned = set(taste.get("love", [])), set(taste.get("ban", []))

    def rec_of(c):
        if c.get("id") in by_id:
            return by_id[c["id"]]
        f = c.get("file")
        return (by_path.get(str(f)) or by_path.get(norm_path(f))) if f else None

    items = []
    for c in d["cues"]:
        items.append((c, role_of(c), c))
        for l in c.get("layers") or []:
            items.append((l, l.get("role") or role_of(l) or role_of(c), c))
    used = {}
    for c, _, _ in items:
        r = rec_of(c)
        if r:
            used[r["path"]] = used.get(r["path"], 0) + 1
    changes = []
    for c, role, top_cue in items:
        if any(k in c for k in ("slice", "slice_of", "uisfx", "texture")) or c.get("bed"):
            continue
        r = rec_of(c)
        if r is None or not role or (roles and role not in roles):
            continue
        spec = {"role": role, "target_dur": max(0.05, effective_dur(r))}
        if r.get("centroid"):
            spec["centroid"] = r["centroid"]
        others = dict(used)
        others[r["path"]] = max(0, others.get(r["path"], 1) - 1)       # the sound itself does not count against itself
        ranked = picker.rank(idx, spec, used=others, taste=taste)
        if r["path"] not in banned and (r["path"] in loved or any(x["path"] == r["path"] for _, x in ranked[:keep])):
            continue
        if not ranked:
            continue
        new = ranked[0][1]
        if new["path"] == r["path"]:
            continue
        changes.append((top_cue.get("t", 0.0), c.get("label", ""), role, r["name"], new["name"],
                        "banned" if r["path"] in banned else "not in the first %d" % keep))
        used[r["path"]] = max(0, used.get(r["path"], 1) - 1)
        used[new["path"]] = used.get(new["path"], 0) + 1
        if not dry:
            c.pop("file", None)
            c.pop("pick", None)
            c["id"] = new["id"]
    return changes

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    def sel(p):
        g = p.add_argument_group("which cues (they combine)")
        g.add_argument("--at", type=float)
        g.add_argument("--index", type=int)
        g.add_argument("--label")
        g.add_argument("--between", type=float, nargs=2, metavar=("FROM", "TO"))
        g.add_argument("--role")
        g.add_argument("--id", type=int, dest="id_")
        p.add_argument("--backup", action="store_true")

    n = sub.add_parser("new")
    n.add_argument("sheet")
    n.add_argument("--video")
    n.add_argument("--duration", type=float)
    s = sub.add_parser("show")
    s.add_argument("sheet")
    ad = sub.add_parser("add")
    ad.add_argument("sheet")
    ad.add_argument("cue", nargs="*")
    ad.add_argument("--from", dest="from_file", metavar="FILE", help="a JSON list of cues ('-' = stdin)")
    ad.add_argument("--event", action="append", default=[], metavar="KIND@T[:G]",
                    help="a moment by kind and time, routed like from_cues routes a list: key@89.37, bell@40.7:0.8")
    ad.add_argument("--backup", action="store_true")
    st = sub.add_parser("set")
    st.add_argument("sheet")
    st.add_argument("assign", nargs="*", metavar="KEY=VALUE")
    st.add_argument("--unset", nargs="+", metavar="KEY", default=[])
    sel(st)
    dr = sub.add_parser("drop")
    dr.add_argument("sheet")
    sel(dr)
    sh = sub.add_parser("shift")
    sh.add_argument("sheet")
    sh.add_argument("--by", type=float, required=True)
    sel(sh)
    gn = sub.add_parser("gain")
    gn.add_argument("sheet")
    gn.add_argument("--db", type=float, required=True)
    sel(gn)
    mv = sub.add_parser("move")
    mv.add_argument("sheet")
    mv.add_argument("--to", type=float, required=True)
    sel(mv)
    tp = sub.add_parser("top")
    tp.add_argument("sheet")
    tp.add_argument("assign", nargs="*", metavar="KEY=VALUE")
    tp.add_argument("--unset", nargs="+", metavar="KEY", default=[])
    tp.add_argument("--backup", action="store_true")
    ap_ = sub.add_parser("apply")
    ap_.add_argument("sheet")
    ap_.add_argument("edits", help="a JSON file with a list of operations ('-' = stdin)")
    ap_.add_argument("--backup", action="store_true")
    fz = sub.add_parser("freeze")
    fz.add_argument("sheet")
    fz.add_argument("resolved", help="the *_resolved_cues.json a render wrote")
    fz.add_argument("--backup", action="store_true")
    rp = sub.add_parser("repick", help="swap the sounds the person's taste ranks low (taste.json: love / ban / not_for)")
    rp.add_argument("sheet")
    rp.add_argument("--keep", type=int, default=3, help="a sound stays when it is among the first N of its role")
    rp.add_argument("--roles", nargs="+", help="only these roles")
    rp.add_argument("--dry", action="store_true", help="print the swaps, write nothing")
    rp.add_argument("--out", help="write the result here instead of over the sheet")
    rp.add_argument("--backup", action="store_true")
    a = ap.parse_args()

    if a.cmd == "new":
        d = {"cues": []}
        if a.video:
            d["video"] = str(Path(a.video).resolve()).replace("\\", "/")
        if a.duration:
            d["duration"] = a.duration
        save(a.sheet, d, False)
        print(f"new sheet {a.sheet}")
        return
    d = load(a.sheet)
    if a.cmd == "show":
        for i, c in enumerate(d["cues"]):
            print(line(i, c))
        print(f"-- {len(d['cues'])} cues, in time order" + (f", video {d['video']}" if d.get("video") else ""))
        return
    if a.cmd == "add":
        raws = list(a.cue)
        added = []
        for raw in raws:
            try:
                added.append(json.loads(raw))
            except ValueError as ex:
                sys.exit(f"not JSON: {raw[:60]!r} ({ex})")
        if a.from_file:
            src = read_stdin_text() if a.from_file == "-" else read_text_any(a.from_file)
            try:
                more = json.loads(src)
            except ValueError as ex:
                sys.exit(f"{a.from_file}: not JSON ({ex})")
            if isinstance(more, dict):
                more = more.get("cues", [])
            added += list(more)
        if a.event:
            more_ev = cues_from_events(a.event, (d.get("_draft") or {}).get("kinds_user"))
            added += more_ev
            print(f"{len(a.event)} event(s) routed to {len(more_ev)} cue(s)")
        if not added:
            sys.exit("nothing to add: give cues as JSON arguments, --from FILE or --event KIND@T")
        for c in added:
            if not isinstance(c, dict) or "t" not in c:
                sys.exit(f"a cue needs at least a time: {json.dumps(c, ensure_ascii=False)[:60]!r}")
            d["cues"].append(c)
        save(a.sheet, d, a.backup)
        print(f"added {len(added)} cue(s), {len(d['cues'])} in the sheet")
        return
    if a.cmd == "top":
        for kv in a.assign:
            k, eq, v = kv.partition("=")
            if not eq:
                sys.exit(f"expected KEY=VALUE, got {kv!r}")
            put(d, k.strip(), value(v))
        for k in a.unset:
            unset(d, k)
        fix_base_audio(d)
        save(a.sheet, d, a.backup)
        print("sheet keys: " + ", ".join(k for k in d if k != "cues"))
        return
    if a.cmd == "apply":
        src = read_stdin_text() if a.edits == "-" else read_text_any(a.edits)
        try:
            ops = json.loads(src)
        except ValueError as ex:
            sys.exit(f"{a.edits}: not JSON ({ex})")
        if isinstance(ops, dict):
            ops = [ops]
        n_ops, dropped = apply_batch(d, ops)
        save(a.sheet, d, a.backup)
        print(f"applied {n_ops} operation(s)" + (f", {dropped} cue(s) dropped" if dropped else "")
              + f", {len(d['cues'])} cues left")
        return
    if a.cmd == "repick":
        ch = repick(d, a.roles, a.keep, a.dry)
        for tm, lab, role, old, new, why in ch:
            print(f"  {tm:7.2f} s {role:8s} {lab[:24]:24s} {old[:34]:34s} -> {new[:34]}  ({why})")
        if a.dry:
            print(f"{len(ch)} swap(s) (dry run: the sheet is unchanged)")
        else:
            save(a.out or a.sheet, d, a.backup and not a.out)
            print(f"{len(ch)} sound(s) swapped" + (f" -> {a.out}" if a.out else ""))
        return
    if a.cmd == "freeze":
        done, skipped = freeze(d, a.resolved)
        save(a.sheet, d, a.backup)
        print(f"pinned {done} cue(s)" + (f", {skipped} not found in the render (left as they were)" if skipped else ""))
        return

    need_one = a.cmd in ("set", "drop", "move")
    idx, given = select(d, a.index, a.at, a.label, a.between, a.role, a.id_, need_one=need_one,
                        exact_first=a.cmd in ("set", "move"))
    if a.cmd == "drop" and not given:
        sys.exit("drop needs a selector (--at, --index, --label, --between, --role)")
    if a.cmd == "set":
        if not a.assign and not a.unset:
            sys.exit("set needs KEY=VALUE or --unset KEY")
        for i in idx:
            for kv in a.assign:
                k, eq, v = kv.partition("=")
                if not eq:
                    sys.exit(f"expected KEY=VALUE, got {kv!r}")
                put(d["cues"][i], k.strip(), value(v))
            for k in a.unset:
                unset(d["cues"][i], k)
        save(a.sheet, d, a.backup)
        print(f"changed {len(idx)} cue(s)")
    elif a.cmd == "drop":
        keep = [c for i, c in enumerate(d["cues"]) if i not in set(idx)]
        d["cues"] = keep
        save(a.sheet, d, a.backup)
        print(f"dropped {len(idx)} cue(s), {len(keep)} left")
    elif a.cmd == "shift":
        for i in idx:
            d["cues"][i]["t"] = round(d["cues"][i]["t"] + a.by, 4)
        save(a.sheet, d, a.backup)
        print(f"moved {len(idx)} cue(s) by {a.by:+g} s")
    elif a.cmd == "gain":
        for i in idx:
            d["cues"][i]["gain_db"] = round(float(d["cues"][i].get("gain_db", 0.0)) + a.db, 2)
        save(a.sheet, d, a.backup)
        print(f"{a.db:+g} dB on {len(idx)} cue(s)")
    elif a.cmd == "move":
        if len(idx) != 1:
            sys.exit("move takes exactly one cue (--at with --label, or --index)")
        d["cues"][idx[0]]["t"] = round(a.to, 4)
        save(a.sheet, d, a.backup)
        print(f"cue now at {a.to:g} s")


if __name__ == "__main__":
    main()
