#!/usr/bin/env python3
"""Measure each sound effect and voice against the music playing at the same moment, from the mix's stems.

python3 <skill>/scripts/sound_balance.py --music build/audio/music.wav --effects build/audio/effects.wav \
    --voice build/audio/voice.wav --events build/audio/events.json --out output/sound-v3
python3 <skill>/scripts/sound_balance.py --music build/audio/music.wav --voice build/audio/voice.wav --out output/sound-v3

Claude can't hear the mix, and a film's overall loudness says nothing about whether a calendar ding is buried
under the music or a shirt rustle jumps out of it. This script measures it. Give it the stems exactly as they go
into the final mix (after every gain, dip and compressor, before the final loudness step), all starting at 0:00 of
the film, so music + effects + voice is the mix.

Every stem is measured with ffmpeg's EBU R128 momentary loudness (a 0.4 s window, every 0.1 s). Effects and voice
more than 25 dB under the music's usual level are not judged, and music that far under it counts as stopped. Then:
  loud     outside the listed events, any stretch of 0.2 s or more where the effects are more than --loud dB
           (default 6) above the music playing at that moment (where the music is silent, its usual level); and a
           must-hear event more than --must-hear-loud dB (default 10) above the music
  buried   an event marked "must-hear" whose loudest moment is less than --quiet dB (default 0) above the music
           around it (the loudest music within 0.2 s, since that is what covers it). A sound shorter than the
           0.4 s window reads a little low: a 0.3 s ding about 1 dB
  texture  an event marked "texture" (a rustle, steps, a room) more than --texture-loud dB (default 3) above the music
  voice    a stretch where a voice is less than --voice-gap dB (default 6) above the music
These defaults are starting values, not measured against listeners: the user's ears decide. Report the numbers.

The events file is optional but makes the report useful. One entry per sound that matters:
  [{"time": 7.3, "label": "calendar ding", "kind": "must-hear"},
   {"time": 15.1, "end": 19.6, "label": "shirt flick and rustle", "kind": "texture"}]
time (and optional end, or window in seconds, default 0.6) in film seconds; kind is must-hear or texture.

Writes sound.json and sound.md. Exit 0 nothing flagged; 2 flagged for review; 1 an error.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import shutil
import statistics
import subprocess
import sys

FRAME = 0.1          # ebur128 reports momentary loudness every 0.1 s
FLOOR = -70.0        # below this a reading is digital silence
BELOW_USUAL = 25.0   # music this far under its usual level counts as stopped; an effect or voice this far under it is
                     # not judged (relative, because stems are measured before the final loudness step)
MIN_RUN = 0.2


def momentary(path: Path) -> list[float]:
    """Momentary loudness (LUFS) every 0.1 s, each value centred on its 0.4 s window."""
    run = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af", "ebur128", "-f", "null", "-"],
                         capture_output=True, text=True)
    if run.returncode != 0:
        raise RuntimeError(f"could not measure {path}: {run.stderr.strip()[-300:]}")
    vals: list[float] = []
    for t, m in re.findall(r"\bt:\s*([0-9.]+)\s+TARGET:\S+\s+LUFS\s+M:\s*(\S+)", run.stderr):
        try:
            v = float(m)
        except ValueError:
            v = -120.0
        vals.append(v if v == v else -120.0)
    if not vals:
        raise RuntimeError(f"no loudness readings for {path}; is it an audio file?")
    # the first reading covers 0-0.1 s of a 0.4 s window; shift by 0.2 s so value i describes time i*0.1
    return vals[2:] + [vals[-1]] * 2


def at(series: list[float], i: int) -> float:
    return series[i] if 0 <= i < len(series) else -120.0


def runs(flags: list[bool]) -> list[tuple[int, int]]:
    out, start = [], None
    for i, f in enumerate(flags + [False]):
        if f and start is None:
            start = i
        elif not f and start is not None:
            if (i - start) * FRAME >= MIN_RUN - 1e-9:
                out.append((start, i))
            start = None
    return out


def load_events(path: Path | None, total: float) -> list[dict]:
    if not path:
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError(f"{path}: expected a JSON list of events")
    out = []
    for i, e in enumerate(data, 1):
        if not isinstance(e, dict) or not isinstance(e.get("time"), (int, float)) or isinstance(e.get("time"), bool):
            raise ValueError(f"event {i}: needs a numeric 'time'")
        kind = e.get("kind", "must-hear")
        if kind not in ("must-hear", "texture"):
            raise ValueError(f"event {i}: kind must be must-hear or texture")
        end = float(e["end"]) if isinstance(e.get("end"), (int, float)) else float(e["time"]) + float(e.get("window", 0.6))
        if not 0 <= e["time"] < total or end <= e["time"]:
            raise ValueError(f"event {i} ({e.get('label', '')}): time outside the stems (0-{total:.1f}s) or end before start")
        out.append({"label": str(e.get("label", f"event {i}")), "kind": kind, "start": float(e["time"]), "end": min(end, total)})
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--music", type=Path, required=True)
    ap.add_argument("--effects", type=Path, help="effects stem (with --voice, at least one of the two)")
    ap.add_argument("--voice", type=Path)
    ap.add_argument("--events", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--loud", type=float, default=6.0)
    ap.add_argument("--quiet", type=float, default=0.0)
    ap.add_argument("--texture-loud", type=float, default=3.0)
    ap.add_argument("--must-hear-loud", type=float, default=10.0)
    ap.add_argument("--voice-gap", type=float, default=6.0)
    args = ap.parse_args()
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg is required")
    if not (args.effects or args.voice):
        raise ValueError("give --effects, --voice or both")
    if args.events and not args.effects:
        raise ValueError("--events are judged against the effects stem; give --effects")
    for p in (args.music, args.effects, args.voice):
        if p and not p.is_file():
            raise ValueError(f"not a file: {p}")
    music = momentary(args.music)
    fx = momentary(args.effects) if args.effects else None
    voice = momentary(args.voice) if args.voice else None
    lengths = [len(music)] + [len(x) for x in (fx, voice) if x]
    if max(lengths) - min(lengths) > 5:
        raise ValueError(f"the stems differ in length by more than 0.5 s ({[round(n * FRAME, 1) for n in lengths]} s); "
                         "export every stem from 0:00 of the film to its end")
    n = min(lengths)
    total = n * FRAME
    playing = [m for m in music[:n] if m > FLOOR]
    usual = statistics.median(playing) if playing else -120.0
    SILENT = usual - BELOW_USUAL if playing else FLOOR
    PRESENT = max(usual - BELOW_USUAL, FLOOR) if playing else -40.0

    def ref(i: int) -> tuple[float, bool]:
        return (music[i], False) if music[i] > SILENT else (usual, True)

    flagged = []
    marked = load_events(args.events, total)
    labeled = [any(e["start"] - 0.2 <= i * FRAME < e["end"] + 0.2 for e in marked) for i in range(n)]
    over = [bool(fx) and not labeled[i] and fx[i] > PRESENT and fx[i] - ref(i)[0] > args.loud for i in range(n)]
    for a, b in runs(over):
        peak = max(range(a, b), key=lambda i: fx[i])
        r, silent = ref(peak)
        flagged.append({"check": "loud", "start": round(a * FRAME, 2), "end": round(b * FRAME, 2), "effects": round(fx[peak], 1),
                        "music": round(r, 1), "difference": round(fx[peak] - r, 1), "music_silent": silent,
                        "what": f"effects {fx[peak] - r:+.1f} dB against the music" + (" (music silent here; compared with its usual level)" if silent else "")})
    events = []
    for e in marked:
        a, b = int(e["start"] / FRAME), max(int(e["start"] / FRAME) + 1, int(round(e["end"] / FRAME)))
        peak = max(range(a, min(b, n)), key=lambda i: fx[i])
        cover = max(at(music, j) for j in range(peak - 2, peak + 3))
        r, silent = (cover, False) if cover > SILENT else (usual, True)
        diff = fx[peak] - r
        row = {**e, "effects": round(fx[peak], 1), "music": round(r, 1), "difference": round(diff, 1), "music_silent": silent}
        if fx[peak] <= PRESENT:
            row["flag"] = "missing"
            flagged.append({"check": "missing", "start": e["start"], "end": e["end"],
                            "what": f"{e['label']}: no effect sound here ({fx[peak]:.0f} LUFS, music usually {usual:.0f})"})
        elif e["kind"] == "must-hear" and diff < args.quiet and not silent:
            row["flag"] = "buried"
            flagged.append({"check": "buried", "start": e["start"], "end": e["end"], "difference": round(diff, 1),
                            "what": f"{e['label']}: {diff:+.1f} dB against the music, likely buried"})
        elif e["kind"] == "must-hear" and diff > args.must_hear_loud:
            row["flag"] = "must-hear-loud"
            flagged.append({"check": "loud", "start": e["start"], "end": e["end"], "difference": round(diff, 1),
                            "what": f"{e['label']}: {diff:+.1f} dB against the music, likely jumps out"})
        elif e["kind"] == "texture" and diff > args.texture_loud:
            row["flag"] = "texture-loud"
            flagged.append({"check": "texture", "start": e["start"], "end": e["end"], "difference": round(diff, 1),
                            "what": f"{e['label']}: {diff:+.1f} dB against the music, likely too loud for a background sound"})
        events.append(row)
    if voice:
        close = [voice[i] > PRESENT and music[i] > SILENT and voice[i] - music[i] < args.voice_gap for i in range(n)]
        for a, b in runs(close):
            gap = min(voice[i] - music[i] for i in range(a, b) if voice[i] > PRESENT)
            flagged.append({"check": "voice", "start": round(a * FRAME, 2), "end": round(b * FRAME, 2), "difference": round(gap, 1),
                            "what": f"voice only {gap:+.1f} dB above the music"})
    flagged.sort(key=lambda f: f["start"])
    report = {"music": str(args.music), "effects": str(args.effects) if args.effects else None, "voice": str(args.voice) if args.voice else None,
              "seconds": round(total, 1), "music_usual_lufs": round(usual, 1),
              "thresholds": {"loud": args.loud, "quiet": args.quiet, "texture_loud": args.texture_loud,
                             "must_hear_loud": args.must_hear_loud, "voice_gap": args.voice_gap},
              "events": events, "flagged": flagged}
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "sound.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    lines = [f"# Sound balance: {total:.1f} s", "",
             f"Music's usual level {usual:.1f} LUFS (momentary). Starting thresholds, not measured against listeners: "
             f"effects over +{args.loud:g} dB, must-hear under {args.quiet:+g} or over +{args.must_hear_loud:g} dB, texture over +{args.texture_loud:g} dB, "
             f"voice under +{args.voice_gap:g} dB.", ""]
    if events:
        lines += ["| Event | Kind | Time | Effect (LUFS) | Music (LUFS) | Difference | Flag |", "|---|---|---|---|---|---|---|"]
        lines += [f"| {e['label']} | {e['kind']} | {e['start']:.2f}-{e['end']:.2f} | {e['effects']:.1f} | {e['music']:.1f}"
                  f"{' (silent)' if e['music_silent'] else ''} | {e['difference']:+.1f} dB | {e.get('flag', '')} |" for e in events]
        lines.append("")
    lines += [f"{len(flagged)} flagged:"] + [f"- **{f['start']:.2f}-{f['end']:.2f}s** {f['check']}: {f['what']}" for f in flagged]
    (args.out / "sound.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    for e in events:
        print(f"EVENT {e['start']:6.2f}s  {e['label']:<28} {e['difference']:+6.1f} dB vs music  {e.get('flag', 'ok')}")
    for f in flagged:
        print(f"REVIEW {f['check']:<8} {f['start']:6.2f}-{f['end']:.2f}s  {f['what']}")
    print(f"{len(flagged)} flagged; report in {args.out / 'sound.md'}")
    return 2 if flagged else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, KeyError, json.JSONDecodeError) as exc:
        print(f"ERROR: sound balance incomplete: {exc}", file=sys.stderr)
        raise SystemExit(1)
