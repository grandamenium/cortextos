#!/usr/bin/env python3
"""Fit a music track to the film: cut it into pieces on its bar lines, place each piece at a film time, stretch
each piece a little if needed, and dip the music where lines are spoken.

python3 <skill>/scripts/fit_music.py assets/audio/track.wav --plan build/audio/music-plan.json \
    --bars build/audio/track-beats.txt --beats-per-bar 4 --first-bar 0.46 --out build/audio/music.wav
python3 <skill>/scripts/fit_music.py assets/audio/track.wav --bars build/audio/track-beats.txt --beats-per-bar 4 \
    --first-bar 0.46 --clicks build/audio/track-bar-clicks.wav

The plan says which seconds of the track go where in the film. Each piece has "track": [from, to] in track seconds
and one of:
  "film": [from, to]   stretch or squeeze the piece to fill exactly these film seconds
  "at": seconds        play it unstretched, starting at this film time
  "land": [t, f]       play it unstretched, placed so track second t is heard at film second f (use it to put the
                       track's own last note on the logo)

  {"film": 51.8,
   "pieces": [{"track": [0.0, 11.70], "film": [0.0, 11.5]},
              {"track": [27.44, 47.68], "film": [11.5, 31.6]},
              {"track": [91.56, 97.13], "land": [95.55, 51.0]}],
   "dips": [{"from": 40.55, "to": 42.45, "db": -8}],
   "fade_out": 0.25}

Pieces are joined with a short crossfade (--crossfade, default 0.012 s). A film gap between pieces is silence: use
it for a dead stop. "dips" lower the music by "db" (below 0; about -8 under a spoken line), fully down from "from" to "to",
ramping down over "ramp" seconds (default 0.15) before "from" and back up over the same after "to". "fade_out" fades the last seconds of the film.

--bars is the track's bar lines (the first beat of each bar), so every cut can be checked against them. It takes
a JSON list of times, a JSON object with "downbeats" or "bars", or a text file with one time per line. A beat
tracker gives beats, not bars: pass its beats with --beats-per-bar 4 (and --first-bar, the time of a bar's first
beat you have checked by ear or against a section map) and every fourth beat from there is used (3 for a waltz). With --snap,
cuts within half a bar move to the nearest bar line before anything is made.

Claude can't hear whether --first-bar is right, and a wrong guess moves every bar line while the off-bar check still
passes against the wrong grid. --clicks OUT.wav writes the whole track with a short tick on every bar line (no plan
needed): send it to the user, ask whether the ticks fall on the first beat of each bar all the way through, and write
their answer in the build log before fitting.

Checks, reported per piece:
  stretch  a piece stretched or squeezed by more than --max-stretch (default 0.03, 3%): the tempo change can be heard
  off-bar  a cut more than --bar-slack seconds (default 0.03) from a bar line, except at the track's very start
           or end, or an end heard only after the film's end. Each cut is reported once. Only with --bars
  overlap  two pieces playing over each other for longer than the crossfade
  unchecked  no --bars given, so no cut was checked against the bar lines
Gaps between pieces (silence, as for a dead stop) and music ending before the film are noted, not flagged.
A piece reaching past the track's end is an error.
Writes the fitted music (48 kHz, 24-bit stereo WAV) and OUT.json beside it with each piece's placement and
stretch. Needs ffmpeg and ffprobe. Exit 0 all clear; 2 something to review (the music is still written); 1 an error,
including a wrong command line.
"""
from __future__ import annotations

import argparse
import array
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import wave

SR = 48000


def duration(path: Path) -> float:
    run = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True)
    try:
        return float(run.stdout.strip())
    except ValueError:
        raise RuntimeError(f"could not read the length of {path}: {run.stderr.strip()[-200:]}")


def load_bars(path: Path, per_bar: int, first: float | None) -> list[float]:
    text = path.read_text().strip()
    times: list[float]
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            data = data.get("downbeats") or data.get("bars") or []
        times = [float(t) for t in data]
    except json.JSONDecodeError:
        times = [float(line.split()[0]) for line in text.splitlines() if line.strip() and not line.startswith("#")]
    times.sort()
    if per_bar > 1 and times:
        start = 0 if first is None else min(range(len(times)), key=lambda i: abs(times[i] - first))
        times = times[start % per_bar::per_bar]
    if len(times) < 2:
        raise RuntimeError(f"{path}: fewer than two bar lines")
    return times


def nearest(times: list[float], t: float) -> float:
    return min(times, key=lambda b: abs(b - t))


def place(piece: dict, i: int) -> dict:
    """Film start, film length and stretch factor (track seconds per film second) for one piece."""
    try:
        a, b = (float(v) for v in piece["track"])
    except (KeyError, TypeError, ValueError):
        raise RuntimeError(f"piece {i + 1}: needs \"track\": [from, to]")
    if b <= a:
        raise RuntimeError(f"piece {i + 1}: track end {b} is not after its start {a}")
    if "film" in piece:
        fa, fb = (float(v) for v in piece["film"])
        if fb <= fa:
            raise RuntimeError(f"piece {i + 1}: film end {fb} is not after its start {fa}")
        return {"track": [a, b], "start": fa, "length": fb - fa, "speed": (b - a) / (fb - fa)}
    if "at" in piece:
        return {"track": [a, b], "start": float(piece["at"]), "length": b - a, "speed": 1.0}
    if "land" in piece:
        t, f = (float(v) for v in piece["land"])
        return {"track": [a, b], "start": f - (t - a), "length": b - a, "speed": 1.0}
    raise RuntimeError(f"piece {i + 1}: needs \"film\", \"at\" or \"land\"")


def tempo_chain(speed: float) -> str:
    """atempo takes 0.5-100 per filter; a piece is only ever changed a few percent, but chain to be safe."""
    parts = []
    while speed > 2.0:
        parts.append("atempo=2.0")
        speed /= 2.0
    while speed < 0.5:
        parts.append("atempo=0.5")
        speed /= 0.5
    if abs(speed - 1.0) > 1e-6:
        parts.append(f"atempo={speed:.6f}")
    return ",".join(parts)


def write_clicks(track: Path, bars: list[float], out: Path) -> int:
    """The whole track with a short 1.5 kHz tick on every bar line, for the user to check by ear."""
    length = duration(track)
    n = int(length * SR) + 1
    ticks = array.array("h", bytes(2 * n))
    tick = [int(12000 * math.sin(2 * math.pi * 1500 * k / SR) * (1 - k / (0.03 * SR))) for k in range(int(0.03 * SR))]
    for t in bars:
        s0 = int(t * SR)
        for k, v in enumerate(tick):
            if 0 <= s0 + k < n:
                ticks[s0 + k] = v
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        tick_wav = Path(tmp) / "ticks.wav"
        with wave.open(str(tick_wav), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(ticks.tobytes())
        run = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(track), "-i", str(tick_wav),
                              "-filter_complex", f"[0:a]aresample={SR},aformat=channel_layouts=stereo,volume=0.6[m];"
                              f"[1:a]aformat=channel_layouts=stereo[k];[m][k]amix=inputs=2:normalize=0:duration=first[o]",
                              "-map", "[o]", "-c:a", "pcm_s16le", str(out)], capture_output=True, text=True)
    if run.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {run.stderr.strip()[-300:]}")
    print(f"{len(bars)} bar lines ticked; first at {bars[0]:.3f} s. Ask the user whether every tick falls on the first "
          f"beat of a bar: {out}")
    return 0


def gain_expr(dips: list[dict]) -> str | None:
    """The music is fully down from "from" to "to"; it ramps down before "from" and back up after "to"."""
    terms = []
    for i, d in enumerate(dips, 1):
        try:
            lo, hi, db = float(d["from"]), float(d["to"]), float(d["db"])
            ramp = max(float(d.get("ramp", 0.15)), 0.001)
        except (KeyError, TypeError, ValueError):
            raise RuntimeError(f"dip {i}: needs \"from\", \"to\" and \"db\" as numbers")
        if hi <= lo:
            raise RuntimeError(f"dip {i}: \"to\" {hi} is not after \"from\" {lo}")
        if db >= 0:
            raise RuntimeError(f"dip {i}: \"db\" must be below 0 (a dip lowers the music), got {db}")
        drop = 1 - 10 ** (db / 20)
        terms.append(f"(1-{drop:.6f}*clip((t-{lo - ramp:.4f})/{ramp:.4f},0,1)*clip(({hi + ramp:.4f}-t)/{ramp:.4f},0,1))")
    return "*".join(terms) if terms else None


class _Parser(argparse.ArgumentParser):
    def error(self, message):  # a usage error is exit 1, so exit 2 always means "music written, review it"
        self.print_usage(sys.stderr)
        self.exit(1, f"error: {message}\n")


def main() -> int:
    ap = _Parser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("track", type=Path)
    ap.add_argument("--plan", type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--clicks", type=Path, help="write the track with a tick on every bar line, then stop")
    ap.add_argument("--bars", type=Path)
    ap.add_argument("--beats-per-bar", type=int, default=1)
    ap.add_argument("--first-bar", type=float)
    ap.add_argument("--snap", action="store_true")
    ap.add_argument("--max-stretch", type=float, default=0.03)
    ap.add_argument("--bar-slack", type=float, default=0.03)
    ap.add_argument("--crossfade", type=float, default=0.012)
    args = ap.parse_args()

    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        print("ffmpeg and ffprobe are needed", file=sys.stderr)
        return 1
    if args.first_bar is not None and args.beats_per_bar == 1:
        print("warning: --first-bar does nothing without --beats-per-bar", file=sys.stderr)
    if args.clicks:
        if not args.bars:
            ap.error("--clicks needs --bars")
        try:
            return write_clicks(args.track, load_bars(args.bars, args.beats_per_bar, args.first_bar), args.clicks)
        except (OSError, ValueError, RuntimeError) as e:
            print(f"error: {e}", file=sys.stderr)
            return 1
    if not args.plan or not args.out:
        ap.error("--plan and --out are needed (or --clicks to hear the bar lines)")
    try:
        plan = json.loads(args.plan.read_text())
        film = float(plan["film"])
        if not plan.get("pieces"):
            raise RuntimeError("the plan has no pieces")
        track_len = duration(args.track)
        bars = load_bars(args.bars, args.beats_per_bar, args.first_bar) if args.bars else None
        if args.snap and bars:
            half = (bars[-1] - bars[0]) / (len(bars) - 1) / 2
            for i, p in enumerate(plan["pieces"]):
                if not isinstance(p, dict) or not isinstance(p.get("track"), list) or len(p["track"]) != 2:
                    raise RuntimeError(f"piece {i + 1}: needs \"track\": [from, to]")
                a, b = (float(v) for v in p["track"])
                na = nearest(bars, a) if a > 0.05 and abs(nearest(bars, a) - a) <= half else a
                nb = nearest(bars, b) if b < track_len - 0.05 and abs(nearest(bars, b) - b) <= half else b
                p["track"] = [na, nb]
        pieces = [place(p, i) for i, p in enumerate(plan["pieces"])]
        for i, p in enumerate(pieces):
            if p["track"][1] > track_len + 0.01:
                raise RuntimeError(f"piece {i + 1}: reaches track {p['track'][1]:.2f} s, past the track's end at "
                                   f"{track_len:.2f} s")
        gexpr = gain_expr(plan.get("dips", []))
        fade_out = float(plan.get("fade_out", 0))
        if bars and args.beats_per_bar == 1 and len(bars) > 2:
            gaps = sorted(b - a for a, b in zip(bars, bars[1:]))
            if gaps[len(gaps) // 2] < 1.0:
                print("warning: these bar lines are under 1 s apart, so they look like beats; pass --beats-per-bar "
                      "(4 for most music, 3 for a waltz)", file=sys.stderr)
    except (OSError, KeyError, TypeError, ValueError, RuntimeError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    xf = args.crossfade
    flags: list[str] = []
    order = sorted(range(len(pieces)), key=lambda i: pieces[i]["start"])
    reported: list[float] = []
    for n, i in enumerate(order):
        p = pieces[i]
        a, b = p["track"]
        p["stretch"] = p["speed"] - 1.0
        p["issues"] = []
        if abs(p["stretch"]) > args.max_stretch:
            p["issues"].append(f"stretch: {abs(p['stretch']) * 100:.1f}% "
                               f"({'faster' if p['stretch'] > 0 else 'slower'}), over {args.max_stretch * 100:.0f}%")
        if bars:
            for name, t in (("start", a), ("end", b)):
                if (name == "start" and t <= 0.05) or (name == "end" and t >= track_len - 0.05):
                    continue
                if name == "end" and p["start"] + p["length"] >= film - 0.01:
                    continue  # this end is after the film's end, so it is never heard
                if any(abs(t - c) < 0.001 for c in reported):
                    continue  # the same cut, already reported as the previous piece's end
                reported.append(t)
                off = t - nearest(bars, t)
                if abs(off) > args.bar_slack:
                    p["issues"].append(f"off-bar: cut at track {t:.3f} s ({name}) is {off * 1000:+.0f} ms from "
                                       f"the bar line at {nearest(bars, t):.3f} s")
        p["notes"] = []
        if p["start"] < -0.001:
            p["notes"].append(f"starts {-p['start']:.2f} s before 0:00; that part is left out")
        if p["start"] + p["length"] > film + 0.01:
            p["notes"].append(f"runs {p['start'] + p['length'] - film:.2f} s past the film's end and is cut there")
        for j in order[n + 1:]:
            ov = p["start"] + p["length"] - pieces[j]["start"]
            if ov > xf + 0.001:
                p["issues"].append(f"overlap: plays {ov:.2f} s over piece {j + 1}")
        if n + 1 < len(order):
            q = pieces[order[n + 1]]
            over = p["start"] + p["length"] - q["start"]
            if over < -xf - 0.001:
                p["notes"].append(f"silence for {-over:.2f} s after it, until film {q['start']:.2f} s")
            # carry on past the join by one crossfade so the next piece fades in over it
            p["tail"] = xf if abs(over) <= xf + 0.001 and b + xf * p["speed"] <= track_len else 0.0
        else:
            p["tail"] = 0.0

    for p in pieces:  # a piece placed before 0:00 starts where the film does
        if p["start"] < 0:
            p["track"][0] -= p["start"] * p["speed"]
            p["length"] += p["start"]
            p["start"] = 0.0

    # One ffmpeg graph: trim, stretch, fade and place each piece, add them, dip, fade out, cut to the film's length.
    chains, labels = [], []
    for i, p in enumerate(pieces):
        a, b = p["track"]
        src_end = min(b + p["tail"] * p["speed"], track_len)
        length = p["length"] + p["tail"]
        filt = [f"atrim=start={a:.6f}:end={src_end:.6f}", "asetpts=PTS-STARTPTS", f"aresample={SR}",
                "aformat=sample_fmts=fltp:channel_layouts=stereo"]
        if tempo_chain(p["speed"]):
            filt.append(tempo_chain(p["speed"]))
        filt += [f"atrim=end={length:.6f}", "asetpts=PTS-STARTPTS",
                 f"afade=t=in:d={xf:.4f}:curve=tri", f"afade=t=out:st={max(length - xf, 0):.6f}:d={xf:.4f}:curve=tri"]
        start = p["start"]
        delay = round(start * SR)
        if delay:
            filt.append(f"adelay=delays={delay}S:all=1")
        chains.append(f"[0:a]{','.join(filt)}[p{i}]")
        labels.append(f"[p{i}]")
    mix = f"{''.join(labels)}amix=inputs={len(pieces)}:normalize=0:duration=longest" if len(pieces) > 1 else \
        f"{labels[0]}anull"
    post = [f"apad=whole_dur={film:.6f}", f"atrim=end={film:.6f}", "asetnsamples=n=64"]
    if gexpr:
        post.append(f"volume='{gexpr}':eval=frame")
    if fade_out > 0:
        post.append(f"afade=t=out:st={film - fade_out:.6f}:d={fade_out:.6f}")
    graph = ";".join(chains) + f";{mix},{','.join(post)}[out]"
    args.out.parent.mkdir(parents=True, exist_ok=True)
    run = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(args.track),
                          "-filter_complex", graph, "-map", "[out]", "-ar", str(SR), "-ac", "2",
                          "-c:a", "pcm_s24le", str(args.out)], capture_output=True, text=True)
    if run.returncode != 0:
        print(f"error: ffmpeg failed: {run.stderr.strip()[-400:]}", file=sys.stderr)
        return 1

    for i in order:
        p = pieces[i]
        a, b = p["track"]
        print(f"piece {i + 1}: track {a:7.3f}-{b:7.3f} s -> film {p['start']:6.2f}-{p['start'] + p['length']:6.2f} s, "
              f"stretch {p['stretch'] * 100:+.1f}%")
        for note in p["notes"]:
            print(f"  note: {note}")
        for issue in p["issues"]:
            print(f"  REVIEW {issue}")
            flags.append(f"piece {i + 1}: {issue}")
    report = {"track": str(args.track.resolve()), "track_length": track_len, "film": film, "out": str(args.out.resolve()),
              "bars_checked": bool(bars),
              "pieces": [{"piece": i + 1, "track": pieces[i]["track"], "film_start": round(pieces[i]["start"], 4),
                          "film_end": round(pieces[i]["start"] + pieces[i]["length"], 4),
                          "stretch": round(pieces[i]["stretch"], 5), "issues": pieces[i]["issues"]} for i in order],
              "dips": plan.get("dips", []), "flags": flags}
    args.out.with_suffix(".json").write_text(json.dumps(report, indent=1) + "\n")
    end = max(p["start"] + p["length"] for p in pieces)
    if end < film - 0.01:
        print(f"note: the music ends at film {end:.2f} s, {film - end:.2f} s before the film does")
    if not bars:
        print("REVIEW unchecked: bar lines not checked; pass --bars to check every cut against them.")
        flags.append("unchecked: no --bars, so no cut was checked against the bar lines")
    print(f"{len(flags)} to review; music in {args.out}" if flags else f"All clear; music in {args.out}")
    return 2 if flags else 0


if __name__ == "__main__":
    sys.exit(main())
