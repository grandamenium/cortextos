#!/usr/bin/env python3
"""A listening page: the person's ears, made cheap. Versions of a film to compare blind, and the moments the critique
sends the ear to, each with a question and a verdict in one tap; the answers land in a file this skill can read.

  python listen_page.py build OUT --ab "bed on or off" without.mp4 with.mp4 [--ab LABEL V1 V2 [V3 ..]] ...
                                  [--moments FILM.mp4 --critique RESOLVED.json TRACK.wav | --list LIST.json]
                                  [--rate-plan PLAN.json]   # sounds to rate one by one (taste_test.py page)
                                  [--title T] [--labels "without a bed" "with a bed"]
                                  [--picture-height 720]    # a picture shared by the versions is shown this tall at most
  python listen_page.py serve OUT [--port 8765] [--lan] [--open]
  python listen_page.py results OUT [--log]

Why. The skill measures and cannot hear. What it can do is to ask the one pair of ears there is a precise question
and to keep the answer. A pair is shown as "1" and "2" in a random order (the key stays in the manifest), the picture
is the same, you switch the sound without stopping. A moment is a 3 s piece of the film with the question of the
critique's listen list. Verdicts are saved on every tap (POST to this script's own tiny server, or a download when the
page is opened from a file), and `results` unblinds them: which version won, which tags it got. `--log` appends a run
to `listening_log.json` of the skill (personal, never packaged): the data to calibrate the numbers against.

Versions of a film that differ in sound only (the video streams are byte-identical, which `build` checks) are built as
ONE picture, no taller than --picture-height, and the sound of each version beside it: the page plays them all together
and the one heard is the one not muted, so a switch is instant and no video is decoded twice. (Two copies of a 1080p60
film, one of them hidden, stalled in the browser and were re-seeked every 250 ms: the page stuttered on version 2.)
Versions with pictures of their own play one at a time, and a switch is a seek.

`serve --lan` makes the page reachable from a phone on the same network (the critique asks for one listen on a phone
speaker). The server serves only the folder it was given and writes only verdicts.json there.
"""
import argparse
import html
import json
import mimetypes
import random
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import SKILL_DIR

VIDEO = (".mp4", ".mov", ".m4v", ".webm", ".mkv")
AUDIO = (".wav", ".mp3", ".m4a", ".flac", ".ogg", ".aac")
LOG = SKILL_DIR / "listening_log.json"
MOMENT_VERDICTS = ["ok", "loud", "masked", "harsh", "extra", "missing"]
TAGS = ["offtheme", "quiet", "masked", "loud", "heavy", "voice", "empty", "harsh", "distracting", "synthetic", "hum",
        "noise", "early", "late", "good"]
LOOP_UNDER = 8.0                  # a comparison of clips shorter than this loops by itself
PICTURE_HEIGHT = 720              # the picture the versions of a pair share is shown this tall at most (0 = as it is)
# a sound rated on its own in a picture (taste_test.py): the verdict, the reasons, where it would fit better
RATE_VERDICTS = [{"key": "love", "label": "👍 Класс"}, {"key": "ok", "label": "👌 Нормально"},
                 {"key": "notfit", "label": "↔ Не здесь"}, {"key": "never", "label": "🚫 Не брать"}]
RATE_REASONS = [{"key": "harsh", "label": "резкий"}, {"key": "dull", "label": "глухой / тусклый"},
                {"key": "long", "label": "слишком длинный"}, {"key": "short", "label": "слишком короткий"},
                {"key": "loud", "label": "громкий"}, {"key": "quiet", "label": "тихий"},
                {"key": "dirty", "label": "грязный / шумный"}, {"key": "synthetic", "label": "синтетика"},
                {"key": "cliche", "label": "заезженный"}, {"key": "sync", "label": "не попал в картинку"}]
RATE_CONTEXTS = [{"key": "click", "label": "клик / нажатие"}, {"key": "appear", "label": "появление элемента"},
                 {"key": "transition", "label": "переход / свайп"}, {"key": "impact", "label": "удар / акцент"},
                 {"key": "success", "label": "успех / подтверждение"}, {"key": "build", "label": "нарастание"},
                 {"key": "typing", "label": "ввод текста"}, {"key": "error", "label": "ошибка / предупреждение"},
                 {"key": "ambience", "label": "фон / атмосфера"}]
# what the person can mark WHILE an adjust excerpt plays (a tap logs the time of the loop)
ADJUST_MARKS = [{"key": "loud", "label": "громко"}, {"key": "harsh", "label": "резко"},
                {"key": "extra", "label": "лишнее"}, {"key": "missing", "label": "не хватает"},
                {"key": "off", "label": "не в тему"}]


# ------------------------------------------------------------------------------------------------ build
def kind_of(path):
    return "video" if str(path).lower().endswith(VIDEO) else "audio"


def duration_of(path):
    """Seconds of a media file by ffprobe, 0.0 when it cannot be told."""
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                           capture_output=True, text=True, errors="replace")
        return float(r.stdout.strip().splitlines()[0])
    except (OSError, ValueError, IndexError):
        return 0.0


def probe_stream(path, fields, stream="v:0"):
    """Fields of the first video (or audio) stream by ffprobe, as a dict; {} when it cannot be told."""
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", stream, "-show_entries", f"stream={fields}",
                            "-of", "json", str(path)], capture_output=True, text=True, errors="replace")
        return (json.loads(r.stdout).get("streams") or [{}])[0]
    except (OSError, ValueError, IndexError):
        return {}


def video_md5(path):
    """MD5 of the packets of the first video stream (copied, not decoded): files with the same picture share it."""
    try:
        r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-map", "0:v:0", "-c", "copy",
                            "-f", "md5", "-"], capture_output=True, text=True, errors="replace")
    except OSError:
        return ""
    last = (r.stdout.strip().splitlines() or [""])[-1]
    return last[4:] if r.returncode == 0 and last.startswith("MD5=") else ""


def make_picture(src, dst, height=PICTURE_HEIGHT):
    """The picture of a film without its sound: copied as it is when it is no taller than `height`, else scaled down
    (a 1080p60 decode drops frames in a browser pane, and the page shows it a few hundred pixels wide), with a key
    frame every half second so that a seek costs little. The frames keep their times."""
    h = int(probe_stream(src, "height").get("height") or 0)
    if height and h > height:
        v = ["-vf", f"scale=-2:{int(height)}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
             "-pix_fmt", "yuv420p", "-g", "30", "-fps_mode", "passthrough"]
    else:
        v = ["-c:v", "copy"]
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-nostdin", "-i", str(src), "-map", "0:v:0", "-an", *v,
                        "-movflags", "+faststart", str(dst)], capture_output=True, text=True, errors="replace")
    return r.returncode == 0 and Path(dst).exists()


def extract_audio(src, dst):
    """The sound of a film alone, as .m4a: its AAC stream copied (nothing is encoded twice), else encoded to AAC."""
    codec = probe_stream(src, "codec_name", "a:0").get("codec_name", "")
    if not codec:
        return False
    a = ["-c:a", "copy"] if codec == "aac" else ["-c:a", "aac", "-b:a", "192k"]
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-nostdin", "-i", str(src), "-map", "0:a:0", "-vn", *a,
                        "-movflags", "+faststart", str(dst)], capture_output=True, text=True, errors="replace")
    return r.returncode == 0 and Path(dst).exists()


def cut_moment(src, t, out, dur=3.0, pre=1.0):
    """A 3 s piece of the film around a moment, picture and sound, small enough to play at once."""
    t0 = max(0.0, float(t) - pre)
    if kind_of(src) == "video":
        cmd = ["ffmpeg", "-v", "error", "-y", "-nostdin", "-ss", f"{t0:.3f}", "-t", f"{dur:.3f}", "-i", str(src),
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", "-c:a", "aac",
               "-b:a", "160k", "-movflags", "+faststart", str(out)]
    else:
        cmd = ["ffmpeg", "-v", "error", "-y", "-nostdin", "-ss", f"{t0:.3f}", "-t", f"{dur:.3f}", "-i", str(src),
               "-c:a", "aac", "-b:a", "160k", str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
    return r.returncode == 0 and Path(out).exists()


def moments_from(args):
    if args.list:
        d = json.loads(Path(args.list).read_text(encoding="utf-8-sig"))
        return d.get("listen", d) if isinstance(d, dict) else d
    res, trk = args.critique
    r = subprocess.run([sys.executable, str(Path(__file__).parent / "critique.py"), res, trk, "--json"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    for line in reversed(r.stdout.strip().splitlines()):
        if line.startswith("{"):
            return json.loads(line).get("listen", [])
    sys.exit("critique.py gave no JSON: " + (r.stderr or r.stdout)[-300:])


def build(a):
    out = Path(a.out)
    media = out / "media"
    media.mkdir(parents=True, exist_ok=True)
    rnd = random.Random(a.seed if a.seed is not None else time.time_ns())
    items = []
    for n, spec in enumerate(a.ab or [], 1):
        label, files = spec[0], spec[1:]
        if len(files) < 2:
            sys.exit(f"--ab {label!r}: at least two versions")
        question, own = a.question, None
        if " ## " in label:                  # "title ## the question of this pair [## name 1 | name 2 | ...]"
            parts = [x.strip() for x in label.split(" ## ")]
            label, question = parts[0], parts[1]
            if len(parts) > 2:
                own = [x.strip() for x in parts[2].split(" | ")]
        # several --labels sets may be given (4 versions here, 2 there): the one that fits the number of versions
        sets = [s for s in (a.labels or []) if len(s) == len(files)]
        names = (own if own and len(own) == len(files) else
                 sets[0] if sets else [f"version {i}" for i in range(1, len(files) + 1)])
        for f in files:
            if not Path(f).exists():
                sys.exit(f"not found: {f}")
        vers, picture = [], None
        # versions of one film that differ in sound only: ONE picture and the sound of each, played together
        if all(kind_of(f) == "video" for f in files) and not a.separate_pictures:
            sums = [video_md5(f) for f in files]
            if sums[0] and len(set(sums)) == 1:
                pic = media / f"ab{n}_pic.mp4"
                snd = [media / f"ab{n}_v{i + 1}.m4a" for i in range(len(files))]
                if make_picture(files[0], pic, a.picture_height) and all(extract_audio(f, d) for f, d in zip(files, snd)):
                    picture = f"media/{pic.name}"
                    vers = [{"label": names[i], "file": f"media/{d.name}", "kind": "audio"} for i, d in enumerate(snd)]
                else:
                    for p in [pic, *snd]:
                        p.unlink(missing_ok=True)
        if not vers:                                         # pictures of their own (or sounds only): the files as they are
            for i, f in enumerate(files):
                dst = media / f"ab{n}_v{i + 1}{Path(f).suffix.lower()}"
                shutil.copyfile(f, dst)
                vers.append({"label": names[i], "file": f"media/{dst.name}", "kind": kind_of(f)})
        order = list(range(len(vers)))
        rnd.shuffle(order)
        short = 0.0 < duration_of(files[0]) <= LOOP_UNDER
        items.append({"id": f"ab{n}", "kind": "ab", "title": label, "versions": vers, "order": order, "loop": short,
                      **({"picture": picture} if picture else {}),
                      "question": question or ("Какая звучит лучше? Картинка одна, различается звук: "
                                               "переключайте 1 / 2 на ходу.")})
    if a.moments:
        listen = moments_from(a)
        if not listen:
            print("the critique has no listen list for this film: no moments added")
        for k, m in enumerate(listen, 1):
            dst = media / f"m{k}{'.mp4' if kind_of(a.moments) == 'video' else '.m4a'}"
            if not cut_moment(a.moments, m["t"], dst):
                print(f"moment {k} ({m['t']} s) could not be cut", file=sys.stderr)
                continue
            lab = (m.get("label") or "").strip()
            items.append({"id": f"m{k}", "kind": "moment", "title": f"{float(m['t']):.2f} с" + (f", «{lab}»" if lab else ""),
                          "versions": [{"label": "film", "file": f"media/{dst.name}", "kind": kind_of(dst)}],
                          "order": [0], "why": m.get("why", ""), "question": m.get("ask", "")})
    sections, rate_ctx = [], RATE_CONTEXTS
    if a.rate_plan:
        plan = json.loads(Path(a.rate_plan).read_text(encoding="utf-8-sig"))
        rate_ctx = plan.get("contexts") or RATE_CONTEXTS
        base = Path(a.rate_plan).parent
        n_r = 0
        for sec in plan.get("sections", []):
            first = len(items)
            for k, it in enumerate(sec.get("items", []), 1):
                f = Path(it["file"])
                f = f if f.is_absolute() else base / f
                if not f.exists():
                    sys.exit(f"not found: {f}")
                n_r += 1
                dst = media / f"r{n_r}{f.suffix.lower()}"
                shutil.copyfile(f, dst)
                items.append({"id": f"r{n_r}", "kind": "rate", "section": sec["id"],
                              "title": f"{sec['title']}: {k} из {len(sec['items'])}",
                              "versions": [{"label": "sound", "file": f"media/{dst.name}", "kind": kind_of(f)}],
                              "order": [0], "loop": True, "question": sec.get("question", ""),
                              "why": sec.get("about", ""), "meta": it.get("meta", {})})
            sections.append({"id": sec["id"], "title": sec["title"], "first": first, "n": len(items) - first})
    if a.adjust_plan:                                        # levels set by ear on a looping excerpt (adjust_test.py)
        plan = json.loads(Path(a.adjust_plan).read_text(encoding="utf-8-sig"))
        base = Path(a.adjust_plan).parent

        def put(rel, name):
            f = Path(rel)
            f = f if f.is_absolute() else base / f
            if not f.exists():
                sys.exit(f"not found: {f}")
            shutil.copyfile(f, media / name)
            return f"media/{name}"
        for n_a, it in enumerate(plan.get("items", []), 1):
            var = it.get("variants") or None
            order = list(range(len(var["ids"]))) if var else []
            rnd.shuffle(order)
            items.append({
                "id": f"adj{n_a}", "kind": "adjust", "title": it["title"], "why": it.get("why", ""),
                "question": it.get("question", ""), "duration": float(it.get("duration") or 0.0),
                "picture": put(it["picture"], f"adj{n_a}_pic.mp4") if it.get("picture") else None,
                "master_db": float(it.get("master_db", 0.0)),
                "stems": [{"id": s["id"], "file": put(s["file"], f"adj{n_a}_{s['id']}{Path(s['file']).suffix.lower()}")}
                          for s in it["stems"]],
                "sliders": it.get("sliders", []), "variants": var, "order": order,
                "marks": it.get("marks") or ADJUST_MARKS, "meta": it.get("meta", {})})
    if not items:
        sys.exit("nothing to listen to: give --ab, --moments, --rate-plan and/or --adjust-plan")
    manifest = {"title": a.title, "created": time.strftime("%Y-%m-%d %H:%M:%S"), "items": items,
                "ab_tags": [t.strip() for t in a.ab_tags.split(",") if t.strip()] if a.ab_tags else None,
                "note": a.note or "", "moment_verdicts": MOMENT_VERDICTS, "tags": TAGS,
                "rate_verdicts": RATE_VERDICTS, "rate_reasons": RATE_REASONS, "rate_contexts": rate_ctx,
                "sections": sections}
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "index.html").write_text(PAGE.replace("/*MANIFEST*/null", json.dumps(manifest, ensure_ascii=False)),
                                    encoding="utf-8")
    n_ab = sum(1 for i in items if i["kind"] == "ab")
    n_rt = sum(1 for i in items if i["kind"] == "rate")
    n_aj = sum(1 for i in items if i["kind"] == "adjust")
    print(f"{out}: {n_ab} comparison(s), {len(items) - n_ab - n_rt - n_aj} moment(s)" +
          (f", {n_rt} sound(s) to rate in {len(sections)} section(s)" if n_rt else "") +
          (f", {n_aj} excerpt(s) to set by ear" if n_aj else "") + "\n"
          f"  python {Path(__file__).name} serve {out}      (then answer in the browser; --lan for a phone)\n"
          f"  python {Path(__file__).name} results {out}    (what you answered, unblinded)")


# ------------------------------------------------------------------------------------------------ serve
def make_handler(root):
    root = Path(root).resolve()

    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _send(self, code, body=b"", ctype="text/plain; charset=utf-8", extra=None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            path = urllib.parse.unquote(self.path.split("?")[0])
            if path == "/api/load":
                f = root / "verdicts.json"
                return self._send(200, f.read_bytes() if f.exists() else b"{}", "application/json")
            f = (root / (path.lstrip("/") or "index.html")).resolve()
            if root not in f.parents and f != root or not f.is_file():
                return self._send(404, b"not found")
            size = f.stat().st_size
            ctype = mimetypes.guess_type(str(f))[0] or "application/octet-stream"
            rng = self.headers.get("Range")
            if rng and rng.startswith("bytes="):
                try:
                    a0, _, a1 = rng[6:].partition("-")
                    start = int(a0) if a0 else max(0, size - int(a1))
                    end = min(size - 1, int(a1)) if a1 and a0 else size - 1
                except ValueError:
                    return self._send(416, b"bad range")
                if start > end or start >= size:
                    return self._send(416, b"bad range", extra={"Content-Range": f"bytes */{size}"})
                with open(f, "rb") as fh:
                    fh.seek(start)
                    body = fh.read(end - start + 1)
                return self._send(206, body, ctype, {"Content-Range": f"bytes {start}-{end}/{size}",
                                                     "Accept-Ranges": "bytes"})
            return self._send(200, f.read_bytes(), ctype, {"Accept-Ranges": "bytes"})

        def do_POST(self):
            if self.path != "/api/save":
                return self._send(404, b"not found")
            try:
                n = int(self.headers.get("Content-Length") or 0)
                data = json.loads(self.rfile.read(n).decode("utf-8"))
                if not isinstance(data, dict) or n > 2_000_000:
                    raise ValueError("not a verdicts object")
            except Exception as ex:
                return self._send(400, str(ex).encode("utf-8"))
            tmp = root / "verdicts.json.tmp"
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
            tmp.replace(root / "verdicts.json")
            return self._send(200, b'{"ok": true}', "application/json")

    return H


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def serve(a):
    out = Path(a.out)
    if not (out / "index.html").exists():
        sys.exit(f"{out} has no index.html: run `build` first")
    host = "0.0.0.0" if a.lan else "127.0.0.1"
    srv = ThreadingHTTPServer((host, a.port), make_handler(out))
    port = srv.server_address[1]
    url = f"http://127.0.0.1:{port}/"
    print(f"listening page: {url}" + (f"   (phone on the same network: http://{lan_ip()}:{port}/)" if a.lan else ""),
          flush=True)
    print("answers are saved to", out / "verdicts.json", "; Ctrl+C stops", flush=True)
    if a.open:
        import webbrowser
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


# ------------------------------------------------------------------------------------------------ results
def unblind(out):
    man = json.loads((Path(out) / "manifest.json").read_text(encoding="utf-8"))
    vf = Path(out) / "verdicts.json"
    ver = json.loads(vf.read_text(encoding="utf-8-sig")) if vf.exists() else {}      # a hand-saved file may carry a BOM
    answers = ver.get("items", ver)
    rows = []
    for it in man["items"]:
        v = answers.get(it["id"])
        if not v:
            rows.append({"id": it["id"], "kind": it["kind"], "title": it["title"], "answered": False})
            continue
        order = it["order"]
        names = [it["versions"][i]["label"] for i in order] if it.get("versions") else []   # under 1, 2, 3 ...
        row = {"id": it["id"], "kind": it["kind"], "title": it["title"], "answered": True, "note": v.get("note", "")}
        ch = str(v.get("choice", ""))
        if it["kind"] == "adjust":
            # levels the person set (dB against the film as planned), the accents they marked (by true name), the
            # moments they flagged while it played (seconds into the excerpt)
            labs = (it.get("variants") or {}).get("labels") or []
            marks_v = {}
            for pos, mk in (v.get("vmarks") or {}).items():
                if str(pos).isdigit() and 1 <= int(pos) <= len(order) and order[int(pos) - 1] < len(labs) and mk:
                    marks_v[labs[order[int(pos) - 1]]] = mk
            sl = {k: x for k, x in (v.get("sliders") or {}).items() if isinstance(x, (int, float))}
            row.update({"sliders": sl,
                        "defaults": {s["id"]: float(s.get("default", 0.0)) for s in it.get("sliders", [])},
                        "labels": {s["id"]: s.get("label", s["id"]) for s in it.get("sliders", [])},
                        "vmarks": marks_v, "marks": v.get("marks") or [], "meta": it.get("meta", {}),
                        "answered": bool(ch or sl or marks_v or v.get("marks") or v.get("note"))})
            rows.append(row)
            continue
        if it["kind"] == "rate":
            reasons = (v.get("tags") or {}).get("1", [])
            # chips or a note without a verdict are an answer too ("loud" on every bed, no verdict to give)
            row.update({"section": it.get("section"), "verdict": ch or "none", "meta": it.get("meta", {}),
                        "reasons": reasons, "use": v.get("use", []),
                        "answered": bool(ch or reasons or v.get("use") or v.get("note"))})
        elif it["kind"] == "ab":
            row["winner"] = names[int(ch) - 1] if ch.isdigit() and 1 <= int(ch) <= len(names) else ch   # same / bad
            row["tags"] = {names[int(k) - 1]: t for k, t in (v.get("tags") or {}).items()
                           if str(k).isdigit() and 1 <= int(k) <= len(names) and t}
        else:
            row["verdict"] = ch
            row["tags"] = {"film": v.get("tags", {}).get("1", [])}
        rows.append(row)
    return man, rows


def results(a):
    man, rows = unblind(a.out)
    done = [r for r in rows if r["answered"]]
    print(f"{man['title']}: {len(done)} of {len(rows)} answered")
    wins = {}
    rated = [r for r in rows if r["kind"] == "rate" and r["answered"]]
    if rated:
        vlab = {v["key"]: v["label"] for v in man.get("rate_verdicts", RATE_VERDICTS)}
        for sid in dict.fromkeys(r["section"] for r in rated):
            part = [r for r in rated if r["section"] == sid]
            cnt = {}
            for r in part:
                cnt[r["verdict"]] = cnt.get(r["verdict"], 0) + 1
            print(f"  [{sid}] {len(part)} rated: " + ", ".join(f"{vlab.get(k, k)} {n}" for k, n in sorted(cnt.items())))
            for r in part:
                m = r["meta"]
                extra = []
                if r["reasons"]:
                    extra.append("why: " + ", ".join(r["reasons"]))
                if r["use"]:
                    extra.append("better for: " + ", ".join(r["use"]))
                if r["note"]:
                    extra.append("— " + r["note"])
                print(f"      {vlab.get(r['verdict'], r['verdict']):14s} {str(m.get('name', r['id']))[:44]:44s} "
                      f"{('[' + str(m.get('control')) + '] ') if m.get('control') else ''}" + "; ".join(extra))
        (Path(a.out) / "ratings.json").write_text(json.dumps(
            [{"id": r["id"], "section": r["section"], "verdict": r["verdict"], "reasons": r["reasons"], "use": r["use"],
              "note": r["note"], "meta": r["meta"]} for r in rated], ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"  -> {Path(a.out) / 'ratings.json'}")
    for r in rows:
        if r["kind"] == "rate":
            continue
        if not r["answered"]:
            print(f"  {r['id']:5s} {r['title']}: not answered")
            continue
        if r["kind"] == "adjust":
            lv = ", ".join(f"{r['labels'].get(k, k)} {x - r['defaults'].get(k, 0.0):+.1f} dB"
                           + (f" (now {x:+.1f})" if r['defaults'].get(k, 0.0) else "") for k, x in r["sliders"].items())
            mk_v = ", ".join(f"{k}: {m}" for k, m in r["vmarks"].items())
            mk_t = ", ".join(f"{m.get('t', 0):.1f}s {m.get('key', '')}" for m in r["marks"])
            print(f"  {r['id']:5s} {r['title']}: " + (f"set [{lv}]" if lv else "levels untouched") +
                  (f"; accents [{mk_v}]" if mk_v else "") + (f"; flagged [{mk_t}]" if mk_t else "") +
                  (f"  — {r['note']}" if r["note"] else ""))
        elif r["kind"] == "ab":
            wins[r["winner"]] = wins.get(r["winner"], 0) + 1
            tg = "; ".join(f"{k}: {', '.join(v)}" for k, v in r["tags"].items())
            print(f"  {r['id']:5s} {r['title']}: {r['winner']}" + (f"  [{tg}]" if tg else "") +
                  (f"  — {r['note']}" if r["note"] else ""))
        else:
            tg = ", ".join(r["tags"].get("film", []))
            print(f"  {r['id']:5s} {r['title']}: {r['verdict']}" + (f"  [{tg}]" if tg else "") +
                  (f"  — {r['note']}" if r["note"] else ""))
    if wins:
        print("  comparisons won: " + ", ".join(f"{k} {v}" for k, v in sorted(wins.items(), key=lambda kv: -kv[1])))
    if a.log and done:
        log = json.loads(LOG.read_text(encoding="utf-8")) if LOG.exists() else []
        log.append({"title": man["title"], "created": man.get("created"), "logged": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "answers": done})
        LOG.write_text(json.dumps(log, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"  -> appended to {LOG}")


# ------------------------------------------------------------------------------------------------ the page
PAGE = r"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Прослушивание</title>
<style>
:root{--bg:#14161b;--card:#1d2027;--ink:#e8eaf0;--mut:#9aa1b0;--acc:#6aa8ff;--ok:#4ade80;--bad:#f87171;--line:#2d3240}
@media (prefers-color-scheme: light){:root{--bg:#f4f5f8;--card:#fff;--ink:#1a1d24;--mut:#5b6272;--acc:#1f6feb;--line:#d8dbe3}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,Segoe UI,Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:4px 0 2px}.mut{color:var(--mut);font-size:14px}
.bar{height:6px;background:var(--line);border-radius:3px;margin:10px 0 14px}.bar i{display:block;height:100%;background:var(--acc);border-radius:3px;width:0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:10px 0}
video,audio{width:100%;border-radius:8px;background:#000;max-height:46vh}
.row{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
button{font:inherit;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:9px 14px;cursor:pointer;min-height:44px}
button:hover{border-color:var(--acc)}button.on{background:var(--acc);color:#fff;border-color:var(--acc)}
button.big{font-weight:600}button.sel{outline:2px solid var(--acc)}
.chip{padding:6px 10px;min-height:36px;font-size:14px}.chip.on{background:var(--bad);border-color:var(--bad);color:#fff}.chip.good.on{background:var(--ok);border-color:var(--ok);color:#06210f}
textarea{width:100%;min-height:54px;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px}
select{width:100%;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px;margin-bottom:8px}
.q{font-size:17px;margin:6px 0}.why{color:var(--mut);margin:2px 0 8px}
.nav{display:flex;justify-content:space-between;gap:8px;margin-top:12px}
.saved{color:var(--ok);font-size:13px;min-height:18px}
.final td,.final th{padding:4px 8px;text-align:left;border-bottom:1px solid var(--line)}
</style></head><body><main>
<h1 id="title"></h1><div class="mut" id="note"></div>
<div class="bar"><i id="prog"></i></div>
<div id="stage"></div>
<div class="saved" id="saved"></div>
</main>
<script>
const M = /*MANIFEST*/null;
const TAGS = {offtheme:"не в тему", quiet:"тихо", masked:"тонет", loud:"громко", heavy:"тяжёлый", voice:"мешает голосу",
              empty:"пусто", harsh:"резкий", distracting:"отвлекает", synthetic:"синтетика", hum:"гул мешает",
              noise:"шум / шипение мешает", early:"рано", late:"поздно", good:"всё хорошо"};
const MV = {ok:"ок", loud:"слишком громко", masked:"не слышно (тонет)", harsh:"резкий", extra:"лишний", missing:"не хватает звука"};
let idx = 0, S = {items:{}}, saveTimer = null;
const el = (t, a={}, ...k) => { const e = document.createElement(t); for (const [x,v] of Object.entries(a)) {
  if (x==="class") e.className=v; else if (x.startsWith("on")) e[x]=v; else if (v!==false && v!==null) e.setAttribute(x,v);}
  k.flat().forEach(c => e.append(c.nodeType ? c : document.createTextNode(c))); return e; };
document.title = "Прослушивание: " + M.title; document.getElementById("title").textContent = M.title;
document.getElementById("note").textContent = M.note || "Наушники, потом один раз динамик телефона. Отвечайте по слуху, не по цифрам.";

async function load() {
  try { const r = await fetch("/api/load"); if (r.ok) { const j = await r.json(); if (j && j.items) S = j; } } catch (e) {}
  try { const l = localStorage.getItem("lp:" + M.created); if (l && !Object.keys(S.items).length) S = JSON.parse(l); } catch (e) {}
  // the first item with no answer (an adjust item counts as answered once "готово" or "далее" was pressed on it)
  const first = M.items.findIndex(it => it.kind === "adjust" ? !(S.items[it.id] && S.items[it.id].choice) : !S.items[it.id]);
  idx = first < 0 ? M.items.length : first; render();
}
function persist() {
  S.title = M.title; S.created = M.created; S.updated = new Date().toISOString();
  try { localStorage.setItem("lp:" + M.created, JSON.stringify(S)); } catch (e) {}
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const box = document.getElementById("saved");
    try { const r = await fetch("/api/save", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(S)});
          box.textContent = r.ok ? "сохранено" : "не удалось сохранить (скачайте файл в конце)"; }
    catch (e) { box.textContent = "сервер не отвечает: ответы в браузере, файл можно скачать в конце"; }
  }, 150);
}
function ans(id) { return S.items[id] || (S.items[id] = {choice:"", tags:{}, note:""}); }

function player(it) {
  const vs = it.order.map(i => it.versions[i]);
  const mk = (tag, src) => el(tag, {src, preload: "auto", playsinline: ""});
  const media = vs.map(v => mk(v.kind === "video" ? "video" : "audio", v.file));
  // Versions that share one picture (build checked it): the picture and the sound of every version run together and
  // the one heard is the one not muted, so a switch is instant and nothing is seeked. Versions that bring a picture of
  // their own: one runs at a time (a hidden video does not keep time, and chasing it with seeks made 0.14.0 stutter).
  const pic = it.picture ? mk("video", it.picture) : null;
  const solo = !pic && vs.some(v => v.kind === "video");
  const all = pic ? [pic, ...media] : media;
  let active = 0, timer = null, fixedAt = 0;
  media.forEach((m, k) => { m.muted = k !== 0; });
  if (pic) pic.muted = true;
  const view = k => media.forEach((m, j) => { m.style.display = !pic && j === k ? "block" : "none"; });
  view(0);
  const box = el("div", {}, ...(pic ? [pic] : []), ...media);
  const running = () => solo ? [media[active]] : all;
  const loop = it.kind === "moment" || it.loop === true;
  if (loop) all.forEach(m => { m.loop = true; });
  const sw = vs.length > 1 ? vs.map((v, k) => el("button", {class: "big" + (k === 0 ? " on" : ""), "data-k": k,
        onclick: () => switchTo(k)}, String(k + 1))) : [];
  const playBtn = el("button", {class: "big"}, "▶ играть");
  const stopKeeping = () => { clearInterval(timer); timer = null; };
  // The picture follows the sound heard by a little speeding up or slowing down (a seek of a playing element stalled
  // it in a browser pane): a few percent of speed closes a 70 ms start-up offset in a second or so, unseen. Only a
  // stall of 0.4 s or more is answered with a seek, not oftener than every 1.5 s. The sounds not heard are left alone:
  // a busy machine serves a muted element last and it falls behind, which costs nothing until it is switched to.
  const wrap = d => { const dur = media[active].duration || 0; return loop && dur > 1 ? d - Math.round(d / dur) * dur : d; };
  function keepTime() {
    stopKeeping();
    if (solo || !pic) return;
    timer = setInterval(() => {
      const ref = media[active];
      if (ref.paused || ref.seeking || ref.readyState < 3 || pic.seeking || pic.readyState < 2) return;
      const d = wrap(pic.currentTime - ref.currentTime), now = performance.now();
      if (Math.abs(d) > 0.25) {
        if (now - fixedAt > 1500) { pic.currentTime = ref.currentTime; pic.playbackRate = 1; fixedAt = now; }
      } else if (Math.abs(d) > 0.02) pic.playbackRate = Math.min(1.1, Math.max(0.9, 1 - d * 0.8));
      else if (pic.playbackRate !== 1) pic.playbackRate = 1;
    }, 150);
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function play() {
    const h = media[active], t = h.currentTime;
    all.forEach(m => { m.playbackRate = 1; });
    running().forEach(m => { if (Math.abs(m.currentTime - t) > 0.02) m.currentTime = t; });
    await h.play().catch(() => {});
    // the sound heard goes first: opening an audio device is the slow part on a busy machine, and the rest wait for
    // its clock to move and then start from where it is (a picture that started with it would run ahead)
    for (let i = 0; i < 80 && !h.paused && wrap(h.currentTime - t) < 0.015; i++) await sleep(15);
    const rest = running().filter(m => m !== h), t2 = h.currentTime;
    rest.forEach(m => { if (Math.abs(wrap(m.currentTime - t2)) > 0.02) m.currentTime = t2; });
    await Promise.all(rest.map(m => m.play().catch(() => {})));
    // a busy or backgrounded page starts the rest late: they come to where the sound heard is now
    const t3 = h.currentTime;
    rest.forEach(m => { if (Math.abs(wrap(m.currentTime - t3)) > 0.05) m.currentTime = t3; });
    playBtn.textContent = h.paused ? "▶ играть" : "⏸ пауза";   // the browser may refuse to start by itself
    if (!h.paused) keepTime();
  }
  function pause() { all.forEach(m => { m.pause(); m.playbackRate = 1; }); stopKeeping(); playBtn.textContent = "▶ играть"; }
  function toggle() { return media[active].paused ? play() : pause(); }
  function switchTo(k) {
    if (k === active) return;
    const t = media[active].currentTime, playing = !media[active].paused, was = active;
    active = k;
    media.forEach((m, j) => { m.muted = j !== k; });
    media[k].playbackRate = 1;
    if (!solo && Math.abs(wrap(media[k].currentTime - t)) > 0.04) media[k].currentTime = t;   // it fell behind unheard
    view(k);
    if (solo) {                                   // a picture of its own: the other one waits where it is
      media[was].pause();
      media[k].currentTime = t;
      if (playing) media[k].play().catch(() => {});
    }
    sw.forEach((b, j) => b.classList.toggle("on", j === k));
  }
  playBtn.onclick = toggle;
  media.forEach((m, j) => { m.onended = () => { if (j === active) pause(); }; });
  const again = el("button", {onclick: () => { all.forEach(m => { m.currentTime = 0; }); }}, "с начала");
  const row = el("div", {class: "row"}, playBtn, again, ...sw);
  if (it.kind === "rate") play();                 // a sound to rate plays at once (when the browser allows it)
  return {box, row, toggle, switchTo, n: vs.length};
}

// kind "adjust": the person sets levels by ear on a looping excerpt of a real film, with the film's own music and
// voice. Web Audio: every stem plays on ONE clock (sample-exact, no element to starve on a busy machine), a slider or
// a switch changes a gain and never seeks; the picture follows that clock by a few percent of speed.
function renderAdjust(st, it, a) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const card = el("div", {class: "card"});
  card.append(el("div", {class: "mut"}, `${idx + 1} из ${M.items.length}`), el("h1", {}, it.title));
  if (!AC) { card.append(el("div", {}, "Этот браузер не умеет Web Audio: откройте страницу в Chrome или Edge.")); st.append(card); return; }
  const lin = db => Math.pow(10, db / 20), L = it.duration || 6;
  const ctx = new AC({latencyHint: "interactive"});
  const master = ctx.createGain(); master.gain.value = lin(it.master_db || 0);
  const lim = ctx.createDynamicsCompressor();               // a safety net for a slider pushed up, not a mastering tool
  lim.threshold.value = -2; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.08;
  master.connect(lim); lim.connect(ctx.destination);
  const gains = {}, bufs = {};
  it.stems.forEach(s => { const g = ctx.createGain(); g.connect(master); gains[s.id] = g; });
  a.sliders = a.sliders || {}; a.vmarks = a.vmarks || {}; a.marks = a.marks || [];
  const sliders = it.sliders || [], V = it.variants || null;
  const val = sl => (a.sliders[sl.id] !== undefined ? a.sliders[sl.id] : (sl.default || 0));
  let pos = 0, chosen = V ? it.order[0] : -1;                // the accent being auditioned: blind position / index in V.ids
  let srcs = [], origin = null, playing = false, timer = null, fixedAt = 0, failed = "";
  function applyGains() {
    const want = {};
    it.stems.forEach(s => { want[s.id] = 1; });
    sliders.forEach(sl => {
      const v = val(sl), g = (sl.off && v <= sl.min) ? 0 : lin(v);
      (sl.stems || []).forEach(id => { want[id] = g; });
      if (V && V.slider === sl.id) V.ids.forEach((id, k) => { want[id] = k === chosen ? g : 0; });
    });
    for (const id in want) {
      if (!gains[id]) continue;
      if (origin === null) gains[id].gain.value = want[id]; else gains[id].gain.setTargetAtTime(want[id], ctx.currentTime, 0.012);
    }
  }
  const pic = it.picture ? el("video", {src: it.picture, preload: "auto", playsinline: ""}) : null;
  if (pic) { pic.muted = true; pic.loop = true; }
  const loading = Promise.all(it.stems.map(async s => {
    const r = await fetch(s.file); bufs[s.id] = await ctx.decodeAudioData(await r.arrayBuffer());
  })).catch(e => { failed = String(e); });
  function startSources(offset) {
    srcs.forEach(s => { try { s.stop(); } catch (e) {} });
    srcs = [];
    const when = ctx.currentTime + 0.05;
    it.stems.forEach(s => { const n = ctx.createBufferSource(); n.buffer = bufs[s.id]; n.loop = true;
      n.connect(gains[s.id]); n.start(when, offset); srcs.push(n); });
    origin = when - offset;
  }
  function position() {                                     // seconds into the excerpt, as heard now
    if (origin === null) return 0;
    const t = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);   // what is at the speaker, not in the buffer
    return (((t - origin) % L) + L) % L;
  }
  const stopKeep = () => { clearInterval(timer); timer = null; };
  function keep() {
    stopKeep();
    if (!pic) return;
    timer = setInterval(() => {
      if (!playing || pic.seeking || pic.readyState < 2) return;
      const p = position(), now = performance.now();
      let d = pic.currentTime - p; d -= Math.round(d / L) * L;
      if (Math.abs(d) > 0.25) { if (now - fixedAt > 1500) { pic.currentTime = p; pic.playbackRate = 1; fixedAt = now; } }
      else if (Math.abs(d) > 0.02) pic.playbackRate = Math.min(1.1, Math.max(0.9, 1 - d * 0.8));
      else if (pic.playbackRate !== 1) pic.playbackRate = 1;
    }, 150);
  }
  const playBtn = el("button", {class: "big"}, "▶ играть");
  async function play() {
    await loading;
    if (failed) { playBtn.textContent = "не загрузилось: " + failed.slice(0, 60); return; }
    applyGains();
    await ctx.resume();
    if (origin === null) startSources(0);
    if (pic) { pic.currentTime = position(); await pic.play().catch(() => {}); }
    playing = true; playBtn.textContent = "⏸ пауза"; keep();
  }
  function pause() { ctx.suspend(); if (pic) pic.pause(); playing = false; stopKeep(); playBtn.textContent = "▶ играть"; }
  const toggle = () => (playing ? pause() : play());
  playBtn.onclick = toggle;
  const again = el("button", {onclick: async () => { await loading; if (failed) return; startSources(0); if (pic) pic.currentTime = 0; }}, "с начала");

  // the accents (blind) and a mark for each
  const vRow = el("div", {class: "row"}), vMarkRow = el("div", {class: "row"});
  const MARKS = {best: "⭐ лучший", ok: "👌 годится", bad: "🚫 не годится"};
  const SYM = {best: " ⭐", ok: " 👌", bad: " 🚫"};
  function paintVariants() {
    if (!V) return;
    [...vRow.children].forEach((b, p) => { b.classList.toggle("on", p === pos); b.textContent = String(p + 1) + (SYM[a.vmarks[String(p + 1)]] || ""); });
    [...vMarkRow.children].forEach(b => b.classList.toggle("on", a.vmarks[String(pos + 1)] === b.dataset.k));
  }
  if (V) {
    it.order.forEach((k, p) => vRow.append(el("button", {class: "big", onclick: () => { pos = p; chosen = k; applyGains(); paintVariants(); }}, String(p + 1))));
    Object.entries(MARKS).forEach(([key, lab]) => vMarkRow.append(el("button", {"data-k": key, onclick: () => {
      const cur = a.vmarks[String(pos + 1)];
      if (cur === key) delete a.vmarks[String(pos + 1)];
      else { if (key === "best") for (const q in a.vmarks) if (a.vmarks[q] === "best") delete a.vmarks[q]; a.vmarks[String(pos + 1)] = key; }
      persist(); paintVariants(); }}, lab)));
  }
  // the sliders: dB against the film as planned
  const sliderBox = el("div", {});
  sliders.forEach(sl => {
    const out = el("b", {style: "display:inline-block;min-width:78px;text-align:right"});
    const inp = el("input", {type: "range", min: sl.min, max: sl.max, step: sl.step || 0.5, value: val(sl), style: "width:100%"});
    const show = () => { const v = Number(inp.value); out.textContent = (sl.off && v <= sl.min) ? "выкл" : (v > 0 ? "+" : "") + v.toFixed(1) + " дБ"; };
    inp.oninput = () => { a.sliders[sl.id] = Number(inp.value); applyGains(); show(); persist(); };
    const reset = el("button", {class: "chip", onclick: () => { inp.value = sl.default || 0; inp.oninput(); }}, "как было");
    show();
    sliderBox.append(el("div", {}, el("div", {class: "row", style: "justify-content:space-between;align-items:center;margin:6px 0 2px"},
      el("span", {}, sl.label), el("span", {}, out, " ", reset)), inp, sl.hint ? el("div", {class: "mut"}, sl.hint) : ""));
  });
  // moments flagged while it plays
  const markBox = el("div", {class: "row"}), markList = el("div", {class: "mut"});
  const paintMarks = () => { markList.textContent = a.marks.length ? "Отмечено: " + a.marks.map(m =>
    `${Number(m.t).toFixed(1)} с — ${(it.marks.find(x => x.key === m.key) || {}).label || m.key}`).join("; ") : ""; };
  it.marks.forEach(m => markBox.append(el("button", {class: "chip", onclick: () => {
    a.marks.push({t: Math.round(position() * 10) / 10, key: m.key}); persist(); paintMarks(); }}, m.label)));
  markBox.append(el("button", {class: "chip", onclick: () => { a.marks.pop(); persist(); paintMarks(); }}, "↶ убрать последнюю"));

  if (it.why) card.append(el("div", {class: "why"}, it.why));
  if (it.question) card.append(el("div", {class: "q"}, it.question));
  if (pic) card.append(pic);
  card.append(el("div", {class: "row"}, playBtn, again,
    el("span", {class: "mut", style: "align-self:center"}, `фрагмент ${L.toFixed(0)} с, по кругу; пробел — пауза`)));
  if (V) card.append(el("div", {class: "mut"}, "Что звучит в момент акцента (вслепую, цифры 1–" + it.order.length +
    "): послушайте каждый и отметьте"), vRow, vMarkRow);
  card.append(el("div", {class: "mut", style: "margin-top:8px"},
    "Выставьте так, как должно быть в этом фильме (музыка и голос остаются как есть):"), sliderBox,
    el("div", {class: "mut", style: "margin-top:8px"}, "Пока играет, можно отметить момент, где что-то не так:"), markBox, markList);
  const ta = el("textarea", {placeholder: "заметка (по желанию): что именно, где"}); ta.value = a.note || "";
  ta.oninput = () => { a.note = ta.value; persist(); };
  card.append(ta, el("div", {class: "nav"},
    el("button", {onclick: () => { a.choice = a.choice || "seen"; persist(); idx = Math.max(0, idx - 1); render(); }}, "← назад"),
    el("button", {class: "big on", onclick: () => { a.choice = "done"; persist(); idx++; render(); }},
      idx + 1 >= M.items.length ? "готово" : "готово, далее →")));
  st.append(card);
  paintVariants(); paintMarks(); applyGains();
  window._lp_dispose = () => { stopKeep(); if (pic) pic.pause(); try { ctx.close(); } catch (e) {} };
  window._lp_dbg = {ctx, gains, bufs, position, state: () => ({chosen, pos, origin, playing, failed, srcs: srcs.length})};
  if (window._lp_keys) document.removeEventListener("keydown", window._lp_keys);
  window._lp_keys = ev => {
    if (ev.target.tagName === "TEXTAREA") return;
    if (ev.code === "Space") { ev.preventDefault(); toggle(); }
    else if (V && /^[1-9]$/.test(ev.key) && Number(ev.key) <= it.order.length) {
      pos = Number(ev.key) - 1; chosen = it.order[pos]; applyGains(); paintVariants(); }
  };
  document.addEventListener("keydown", window._lp_keys);
}

function render() {
  if (window._lp_dispose) { window._lp_dispose(); window._lp_dispose = null; }
  const st = document.getElementById("stage"); st.innerHTML = "";
  document.getElementById("prog").style.width = (100 * Math.min(idx, M.items.length) / M.items.length) + "%";
  if (idx >= M.items.length) return final(st);
  if (M.items[idx].kind === "adjust") return renderAdjust(st, M.items[idx], ans(M.items[idx].id));
  const it = M.items[idx], a = ans(it.id), P = player(it);
  const card = el("div", {class: "card"});
  if (M.sections && M.sections.length) {          // a page of sections: jump to one, see how many are answered
    const sel = el("select", {onchange: e => { idx = Number(e.target.value); render(); }},
      ...M.sections.map(s => { const done = M.items.slice(s.first, s.first + s.n).filter(i => (S.items[i.id] || {}).choice).length;
        const o = el("option", {value: s.first}, `${s.title}: отвечено ${done} из ${s.n}`);
        if (idx >= s.first && idx < s.first + s.n) o.selected = true; return o; }));
    card.append(sel);
  }
  card.append(el("div", {class: "mut"}, `${idx + 1} из ${M.items.length}`), el("h1", {}, it.title));
  if ((it.kind === "moment" || it.kind === "rate") && it.why) card.append(el("div", {class: "why"}, it.why));
  card.append(el("div", {class: "q"}, it.question || ""), P.box, P.row);
  // the buttons change their own look: a re-render would start the film over under the finger
  const choiceRow = () => { const row = el("div", {class: "row"});
    row.add = (val, label) => { const b = el("button", {class: "big" + (String(a.choice) === String(val) ? " on" : "")}, label);
      b.onclick = () => { a.choice = val; persist(); row.querySelectorAll("button").forEach(x => x.classList.remove("on")); b.classList.add("on"); };
      row.append(b); return b; };
    return row; };
  const chips = (list, store, cls) => el("div", {class: "row"}, ...list.map(o => {
    const b = el("button", {class: "chip " + (cls || "") + (store.includes(o.key) ? " on" : "")}, o.label);
    b.onclick = () => { const p = store.indexOf(o.key); if (p < 0) store.push(o.key); else store.splice(p, 1); persist(); b.classList.toggle("on", p < 0); };
    return b; }));
  let rateButtons = [];
  if (it.kind === "ab") {
    const n = it.versions.length, row = choiceRow();
    for (let k = 1; k <= n; k++) row.add(String(k), `${k} лучше`);
    row.add("same", "одинаково"); row.add("bad", n > 2 ? "все плохие" : "обе плохие");
    card.append(row, el("div", {class: "mut"}, "Что не так (по версиям, если есть):"));
    for (let k = 1; k <= n; k++) {
      a.tags[k] = a.tags[k] || [];
      card.append(el("div", {class: "row"}, el("span", {class: "mut", style: "min-width:70px"}, `версия ${k}`),
        ...Object.entries(TAGS).filter(([key]) => !M.ab_tags || M.ab_tags.includes(key)).map(([key, lab]) => { const b = el("button", {class: "chip " + (key === "good" ? "good " : "") + (a.tags[k].includes(key) ? "on" : "")}, lab);
          b.onclick = () => { const L = a.tags[k], p = L.indexOf(key); if (p < 0) L.push(key); else L.splice(p, 1); persist(); b.classList.toggle("on", p < 0); };
          return b; })));
    }
  } else if (it.kind === "rate") {
    const row = choiceRow();
    rateButtons = M.rate_verdicts.map(v => row.add(v.key, v.label));
    a.tags["1"] = a.tags["1"] || []; a.use = a.use || [];
    card.append(row, el("div", {class: "mut"}, "Что не так со звуком (если что-то не так):"),
      chips(M.rate_reasons, a.tags["1"], ""),
      el("div", {class: "mut"}, "Для чего он лучше подойдёт (если не сюда):"), chips(M.rate_contexts, a.use, "good"));
  } else {
    const row = choiceRow();
    Object.entries(MV).forEach(([key, lab]) => row.add(key, lab));
    card.append(row);
  }
  const ta = el("textarea", {placeholder: "заметка (по желанию): что именно слышно, где, как это исправить"});
  ta.value = a.note || ""; ta.oninput = () => { a.note = ta.value; persist(); };
  card.append(ta);
  card.append(el("div", {class: "nav"},
    el("button", {onclick: () => { idx = Math.max(0, idx - 1); render(); }}, "← назад"),
    el("button", {class: "big on", onclick: () => { idx++; render(); }}, idx + 1 >= M.items.length ? "готово" : "далее →")));
  st.append(card);
  if (window._lp_keys) document.removeEventListener("keydown", window._lp_keys);
  window._lp_keys = ev => {
    if (ev.target.tagName === "TEXTAREA") return;
    if (ev.code === "Space") { ev.preventDefault(); P.toggle(); }
    else if (it.kind === "rate" && /^[1-9]$/.test(ev.key)) { const b = rateButtons[Number(ev.key) - 1]; if (b) b.click(); }
    else if (/^[1-9]$/.test(ev.key) && P.n > 1) P.switchTo(Math.min(P.n - 1, Number(ev.key) - 1));
    else if (ev.key === "Enter") { idx++; render(); }
    else if (ev.key === "ArrowRight") { idx++; render(); } else if (ev.key === "ArrowLeft") { idx = Math.max(0, idx - 1); render(); }
  };
  document.addEventListener("keydown", window._lp_keys);
}

function final(st) {
  const n = Object.values(S.items).filter(v => v.choice).length;
  const card = el("div", {class: "card final"}, el("h1", {}, "Готово"),
    el("div", {}, `Отвечено ${n} из ${M.items.length}. Ответы сохранены в файл verdicts.json рядом со страницей; ` +
      "скажите Claude, что закончили."));
  const dl = el("button", {class: "big", onclick: () => {
      const b = new Blob([JSON.stringify(S, null, 1)], {type: "application/json"});
      const a = el("a", {href: URL.createObjectURL(b), download: "verdicts.json"}); document.body.append(a); a.click(); a.remove(); }},
    "скачать ответы файлом (если сервер не был запущен)");
  card.append(el("div", {class: "row"}, dl, el("button", {onclick: () => { idx = 0; render(); }}, "просмотреть сначала")));
  st.append(card);
}
load();
</script></body></html>
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("out")
    b.add_argument("--ab", nargs="+", action="append", metavar=("LABEL", "V"),
                   help="LABEL V1 V2 [V3 ...]: versions of one film (mp4 or wav), shown blind as 1, 2, ...")
    b.add_argument("--labels", nargs="+", action="append",
                   help="names of the versions, in the order given (for the results); repeat for pairs with another "
                        "number of versions: the set that fits the pair is used")
    b.add_argument("--ab-tags", metavar="KEY,KEY,...",
                   help="only these 'what is wrong' chips under a comparison (of: " + ", ".join(TAGS) + ")")
    b.add_argument("--adjust-plan", metavar="PLAN.json",
                   help="excerpts of real films whose levels the person sets by ear (adjust_test.py writes the plan): "
                        "stems on one clock, a slider each, accent variants shown blind, moments to flag")
    b.add_argument("--picture-height", type=int, default=PICTURE_HEIGHT, metavar="PX",
                   help="versions with one and the same picture share it, shown at most this tall (default %(default)s; "
                        "0 keeps it as it is)")
    b.add_argument("--separate-pictures", action="store_true",
                   help="keep every version as its own file even when the pictures are the same (the old way)")
    b.add_argument("--rate-plan", metavar="PLAN.json",
                   help="sounds to rate one by one (taste_test.py writes the plan): sections of clips, each with a "
                        "verdict (love / ok / not here / never), the reasons and where it would fit better")
    b.add_argument("--moments", metavar="FILM", help="a film whose listen-list moments are cut into 3 s clips")
    b.add_argument("--critique", nargs=2, metavar=("RESOLVED", "TRACK"), help="run critique.py to get the listen list")
    b.add_argument("--list", help="a JSON with the listen list (critique.py --json output, or a list of {t,label,why,ask})")
    b.add_argument("--title", default="Прослушивание")
    b.add_argument("--note")
    b.add_argument("--question", help="the question under every --ab comparison (default: which sounds better)")
    b.add_argument("--seed", type=int, help="fix the random order of the versions (tests)")
    s = sub.add_parser("serve")
    s.add_argument("out")
    s.add_argument("--port", type=int, default=8765, help="0 = any free port")
    s.add_argument("--lan", action="store_true", help="reachable from other devices of the network (a phone)")
    s.add_argument("--open", action="store_true", help="open the page in the default browser")
    r = sub.add_parser("results")
    r.add_argument("out")
    r.add_argument("--log", action="store_true", help="append the answers to listening_log.json of the skill")
    a = ap.parse_args()
    if a.cmd == "build":
        if a.moments and not (a.critique or a.list):
            ap.error("--moments needs --critique RESOLVED TRACK or --list FILE")
        build(a)
    elif a.cmd == "serve":
        serve(a)
    else:
        results(a)


if __name__ == "__main__":
    main()
