#!/usr/bin/env python3
"""Have a video model watch a rendered cut in motion and list problems with timestamps.

python3 <skill>/scripts/watch_cut.py output/cut-v3.mp4 --out output/watch-v3 --upload-allowed --notes direction-notes.md

Uploads the MP4 to the Gemini API (Files API), asks the model to watch it at --fps frames a second, and writes
watch.json and watch.md: awkward transitions, jumps in space or continuity, frozen or jerky stretches, things
appearing or disappearing, text or pointers in the wrong place, and pacing that drags, each with a time. The
findings are candidates: pull frames at each time and confirm before changing anything. The upload is deleted
afterwards whatever happens (Google also deletes uploads after 48 hours); watch.json records whether it was.

Nothing is uploaded without --upload-allowed: pass it only when the user agreed in the brief that cuts may go to
Google. The key comes from GEMINI_API_KEY, or a GEMINI_API_KEY= line in --env-file. Without permission, without a
key, or on any error, the script writes status "not_watched" with the reason, so the report says "not watched in
motion".

Google documents a custom frame rate for its Interactions API; a plain generateContent request may use the default
1 frame a second. The script estimates the rate actually used from the token count and reports it, or "unknown".

Exit 0 watched; 3 not watched (no permission or no key); 1 error (also recorded as not watched).
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://generativelanguage.googleapis.com"
MODEL = "gemini-3.5-flash-lite"
# Gemini 3 models at the default media resolution: 70 tokens per video frame, 25 per second of audio
# (Google AI Studio docs, media-resolution page, read 2026-11-03).
TOKENS_PER_FRAME = 70
AUDIO_TOKENS_PER_S = 25
KINDS = ["transition", "continuity-jump", "frozen", "jerky", "pop-in", "pop-out", "misplaced-text",
         "misplaced-pointer", "pacing", "other"]

PROMPT = """You are checking a short rendered video before a client sees it. Watch it in motion and list every
place a first-time viewer would notice something wrong. Look for:
- transition: an awkward or abrupt change between shots or layouts; a flash, an empty frame, a bad crossfade
- continuity-jump: a person or object jumps to another place, pose or outfit between shots for no reason
- frozen: a stretch where nothing moves that is not a deliberate final hold
- jerky: motion that stutters, steps or changes speed suddenly
- pop-in / pop-out: something appears or disappears with no cause
- misplaced-text / misplaced-pointer: text, a cursor, an arrow or a highlight in the wrong spot, doubled, covering
  something it should not, or pointing at the wrong thing
- pacing: a stretch that drags, or text that leaves before it can be read
- other: anything else clearly wrong
Give times as seconds from the start of the video (numbers, not m:ss). Report only what you can see or hear; if the
video looks fine, return {"findings": []}. Return JSON only, in this shape:
{"findings": [{"start": 3.2, "end": 3.6, "kind": "transition", "severity": "high", "what": "one plain sentence"}]}
severity is high, medium or low."""


class NotWatched(Exception):
    def __init__(self, reason: str, code: int = 1):
        super().__init__(reason)
        self.code = code


def allowed_host(url: str) -> bool:
    host = urllib.parse.urlparse(url).hostname or ""
    return host.endswith("googleapis.com") or host in ("127.0.0.1", "localhost")


def load_key(env_file: Path | None) -> str:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if key or not env_file:
        return key
    if not env_file.is_file():
        raise NotWatched(f"--env-file not found: {env_file}", 3)
    for line in env_file.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("GEMINI_API_KEY="):
            key = line.split("=", 1)[1].strip().strip('"').strip("'")
    return key


def request(method: str, url: str, key: str, data: bytes | None = None, headers: dict | None = None,
            timeout: float = 600) -> tuple[dict, dict]:
    if not allowed_host(url):
        raise NotWatched(f"refusing to send the API key to {urllib.parse.urlparse(url).hostname}")
    req = urllib.request.Request(url, data=data, method=method, headers={"x-goog-api-key": key, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
        return (json.loads(body) if body.strip() else {}), {k.lower(): v for k, v in resp.headers.items()}


def probe(video: Path) -> tuple[float, bool]:
    if not shutil.which("ffprobe"):
        raise NotWatched("ffprobe is required to read the video's length")
    run = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json",
                          str(video)], capture_output=True, text=True, check=True)
    d = json.loads(run.stdout)
    return float(d["format"]["duration"]), any(s.get("codec_type") == "audio" for s in d.get("streams", []))


def start_upload(api: str, key: str, video: Path, state: dict) -> dict:
    mime = mimetypes.guess_type(video.name)[0] or "video/mp4"
    size = video.stat().st_size
    _, h = request("POST", f"{api}/upload/v1beta/files", key, json.dumps({"file": {"display_name": video.name}}).encode(),
                   {"X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
                    "X-Goog-Upload-Header-Content-Length": str(size), "X-Goog-Upload-Header-Content-Type": mime,
                    "Content-Type": "application/json"})
    url = h.get("x-goog-upload-url")
    if not url:
        raise NotWatched("the upload did not return an upload URL")
    body, _ = request("POST", url, key, video.read_bytes(), {"X-Goog-Upload-Offset": "0",
                      "X-Goog-Upload-Command": "upload, finalize", "Content-Length": str(size)})
    f = body.get("file") or {}
    if not f.get("name"):
        raise NotWatched("the upload returned no file name")
    state["name"] = f["name"]          # from here on the upload exists and must be deleted
    return {**f, "mimeType": f.get("mimeType") or mime}


def wait_active(api: str, key: str, f: dict) -> dict:
    deadline = time.time() + 600
    while f.get("state") != "ACTIVE":
        if f.get("state") == "FAILED":
            raise NotWatched("Google could not process the video")
        if time.time() > deadline:
            raise NotWatched("the uploaded video did not become ready within 10 minutes")
        time.sleep(3)
        f, _ = request("GET", f"{api}/v1beta/{f['name']}", key)
    return f


def seconds_of(value) -> float:
    if isinstance(value, bool):
        raise ValueError("not a time")
    if isinstance(value, (int, float)):
        return float(value)
    m = re.fullmatch(r"\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s*s?\s*", str(value))
    if not m:
        raise ValueError(f"not a time: {value!r}")
    return int(m.group(1) or 0) * 60 + float(m.group(2))


def parse_findings(text: str, total: float) -> tuple[list[dict], int]:
    text = text.strip()
    fence = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", text, re.S)
    if fence:
        text = fence.group(1)
    data = json.loads(text)
    items = data.get("findings") if isinstance(data, dict) else data if isinstance(data, list) else None
    if not isinstance(items, list):
        raise NotWatched(f"the model's answer was not a findings list: {text[:200]}")
    out, dropped = [], 0
    for it in items:
        try:
            if not isinstance(it, dict):
                raise ValueError("not an object")
            start = seconds_of(it["start"])
            end = seconds_of(it.get("end", start))
        except (KeyError, ValueError, TypeError):
            dropped += 1
            continue
        if not 0 <= start <= total + 0.5:
            dropped += 1
            continue
        kind = str(it.get("kind", "other")).strip().lower()
        sev = str(it.get("severity", "medium")).strip().lower()
        out.append({"start": round(start, 2), "end": round(min(max(end, start), total), 2),
                    "kind": kind if kind in KINDS else "other", "severity": sev if sev in ("high", "medium", "low") else "medium",
                    "what": str(it.get("what", "")).strip()})
    return sorted(out, key=lambda f: f["start"]), dropped


def applied_fps(prompt_tokens: int | None, prompt_text: str, seconds: float, audio: bool, requested: float) -> float | None:
    """The frame rate (requested or the 1 fps default) that explains the video's share of the tokens, within 25%."""
    if not prompt_tokens or seconds <= 0:
        return None
    video_tokens = prompt_tokens - len(prompt_text) / 4
    best = None
    for fps in sorted({requested, 1.0}):
        expected = seconds * (TOKENS_PER_FRAME * fps + (AUDIO_TOKENS_PER_S if audio else 0))
        if abs(video_tokens - expected) <= 0.25 * expected:
            best = fps
    return best


def write(out: Path, report: dict) -> None:
    out.mkdir(parents=True, exist_ok=True)
    (out / "watch.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    lines = [f"# Watched in motion: {report['video']}", ""]
    if report["status"] != "watched":
        lines.append(f"**Not watched in motion:** {report['reason']}")
    else:
        rate = f"{report['fps_applied']:g} fps" if report.get("fps_applied") else "unknown"
        lines.append(f"Model {report['model']}; requested {report['fps_requested']:g} fps; rate used: {rate}.")
        if report.get("note"):
            lines += ["", report["note"]]
        lines += ["", f"{len(report['findings'])} candidate(s). Pull frames at each time and confirm before acting.", ""]
        lines += [f"- **{f['start']:.2f}-{f['end']:.2f}s** {f['kind']} ({f['severity']}): {f['what']}" for f in report["findings"]]
    if "upload_deleted" in report:
        lines += ["", f"Upload deleted from Google: {'yes' if report['upload_deleted'] else 'NO, it stays up to 48 hours'}."]
    (out / "watch.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def watch(args, base: dict) -> dict:
    if not args.upload_allowed:
        raise NotWatched("uploads to Google were not allowed (pass --upload-allowed only when the brief allows it)", 3)
    if not allowed_host(args.api_base):
        raise NotWatched(f"--api-base must be a googleapis.com address, not {args.api_base}")
    key = load_key(args.env_file)
    if not key:
        raise NotWatched("no GEMINI_API_KEY in the environment or --env-file", 3)
    seconds, audio = probe(args.video)
    prompt = PROMPT
    if args.notes and args.notes.is_file():
        prompt += "\n\nContext from the director (deliberate choices are not faults):\n" + args.notes.read_text(encoding="utf-8")[:6000]
    state: dict = {}
    try:
        f = wait_active(args.api_base, key, start_upload(args.api_base, key, args.video, state))
        body = {"contents": [{"role": "user", "parts": [
                    {"fileData": {"fileUri": f["uri"], "mimeType": f["mimeType"]}, "videoMetadata": {"fps": args.fps}},
                    {"text": prompt}]}],
                "generationConfig": {"temperature": 0, "responseMimeType": "application/json"}}
        resp, _ = request("POST", f"{args.api_base}/v1beta/models/{args.model}:generateContent", key,
                          json.dumps(body).encode(), {"Content-Type": "application/json"})
    finally:
        if state.get("name"):
            try:
                request("DELETE", f"{args.api_base}/v1beta/{state['name']}", key, timeout=60)
                base["upload_deleted"] = True
            except (OSError, urllib.error.URLError, NotWatched):
                base["upload_deleted"] = False
    parts = ((resp.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts if isinstance(p, dict))
    if not text.strip():
        raise NotWatched(f"the model returned no answer: {json.dumps(resp)[:300]}")
    findings, dropped = parse_findings(text, seconds)
    usage = resp.get("usageMetadata") or {}
    fps = applied_fps(usage.get("promptTokenCount"), prompt, seconds, audio, args.fps)
    if fps == args.fps:
        note = ""
    elif fps == 1.0:
        note = ("The token count matches the 1 fps default, not the requested rate: fast cuts and short pops may "
                "have been missed. Lean on the cut strips (cut_frames.py) and say so.")
    else:
        note = "The rate used couldn't be worked out from the token count; treat fast cuts as unchecked by the watch."
    if dropped:
        note += f" {dropped} finding(s) had no usable time or fell outside the video and were dropped."
    return {**base, "status": "watched", "seconds": round(seconds, 2), "fps_applied": fps,
            "prompt_tokens": usage.get("promptTokenCount"), "output_tokens": usage.get("candidatesTokenCount"),
            "note": note.strip(), "findings": findings}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--upload-allowed", action="store_true", help="the user agreed cuts may be uploaded to Google")
    ap.add_argument("--model", default=MODEL)
    ap.add_argument("--fps", type=float, default=10.0)
    ap.add_argument("--notes", type=Path, help="a text file of context for the model (what the film is, deliberate holds)")
    ap.add_argument("--env-file", type=Path)
    ap.add_argument("--api-base", default=os.environ.get("GEMINI_API_BASE", API))
    args = ap.parse_args()
    base = {"video": str(args.video.resolve()), "model": args.model, "fps_requested": args.fps}
    try:
        if not args.video.is_file():
            raise NotWatched(f"not a file: {args.video}")
        if not 0 < args.fps <= 24:
            raise NotWatched("--fps must be between 0 and 24")
        report = watch(args, base)
    except NotWatched as exc:
        reason, code = str(exc), exc.code
    except urllib.error.HTTPError as exc:
        reason, code = f"Gemini API {exc.code}: {exc.read().decode(errors='replace')[:300]}", 1
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError, subprocess.CalledProcessError) as exc:
        reason, code = f"{type(exc).__name__}: {exc}", 1
    else:
        write(args.out, report)
        rate = f"{report['fps_applied']:g}" if report["fps_applied"] else "unknown"
        print(f"WATCHED {report['seconds']:.1f}s with {args.model}; fps requested {args.fps:g}, used {rate}; "
              f"{len(report['findings'])} candidate(s) -> {args.out / 'watch.md'}")
        if report["note"]:
            print(f"NOTE {report['note']}")
        if report.get("upload_deleted") is False:
            print("NOTE the upload could not be deleted; Google removes it within 48 hours.")
        for x in report["findings"]:
            print(f"REVIEW {x['kind']:<17} {x['start']:6.2f}s  {x['what']}")
        return 0
    write(args.out, {**base, "status": "not_watched", "findings": [], "reason": reason})
    print(f"NOT WATCHED IN MOTION: {reason}. Report this cut as not watched in motion.", file=sys.stderr if code == 1 else sys.stdout)
    if base.get("upload_deleted") is False:
        print("NOTE the upload could not be deleted; Google removes it within 48 hours.")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
