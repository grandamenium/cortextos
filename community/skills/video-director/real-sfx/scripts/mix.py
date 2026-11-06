#!/usr/bin/env python3
"""Turn a cue sheet into a mixed MP4 plus a standalone SFX track, report and (optionally) separate clips.

  python mix.py cues.json --out result/film_sfx.mp4 [--duck | --voice-safe] [--snap-beats] [--stems]
                          [--export-clips result/clips] [--target-lufs -14] [--sfx-trim-db -2]

cues.json
  {
    "video": "C:/path/film.mp4",            # omit for audio-only; then give "duration": 12.0
    "keep_audio": "auto",                   # auto | yes | no  (auto = keep if the video has audio)
    "base_audio": ["stems/voice.wav", "stems/music.wav"],   # optional: the original audio WITHOUT the synthesized
                                            # sound effects (project stems); replaces the video's own audio track
    "cues": [
      {"t": 1.20, "label": "title wipe", "file": "C:/.../Woosh 3.wav", "role": "whoosh",
       "gain_db": 0, "anchor": "peak", "max_dur": 1.5},
      {"t": 3.40, "label": "toggle", "uisfx": "toggle-on", "pack": "studio"},
      {"t": 5.00, "label": "cut", "pick": {"role": "hit", "punchy": true, "max_dur": 1.2}},
      {"t": 6.20, "label": "chosen by eye", "id": 412}
    ]
  }
  t        seconds on the video timeline where the moment happens
  anchor   which point of the sound lands on t: start | peak | arrive | end (default depends on the role). The default of a role
           that is placed by its peak is chosen per sound: one that gets loud fast (a hit with a body, a bleep, a texture)
           goes by its ARRIVAL (the first 60 ms within 6 dB of the loudest), one that builds to a climax (a riser, a swell)
           by its peak; an explicit "peak" or "arrive" is taken as it is (round 9, the sync test)
  gain_db  offset on top of the role's normalised level (negative = quieter)
  max_dur  cut the sound after N seconds with a short fade
  fade_in / fade_out   seconds, to override the role's default fades
  loop_to  repeat a short bed until it lasts N seconds (ambience under a scene)
  bed      true: a cue of bed.py (one long dark real recording under a film whose sound is only SFX). Its level is not
           the role's: this script renders the film without it, as the finished master will have it, and puts the
           bed's own median 250 ms level at `level_dbfs` (bed.py: -54; the listener chose -56, called -50 good and
           -44 and louder loud) or, with `floor_db`, that many dB under the loudest 250 ms (`bed:` line of the output)
  fade_curve  "qsin": equal-power fades, for pieces that overlap (bed.py sets it); default linear

Processing, all optional, applied to the real sample before placement:
  fit_dur  stretch/squeeze (pitch kept) so the sound lasts this many seconds; factor limited to 0.5..2
  pitch    semitones, -12..12, length kept (lower = heavier, higher = lighter)
  reverse  true: play backwards (turns a hit into a swell that lands on t)
  lowpass / highpass   cut-off in Hz (tame a harsh whoosh under a voice, thin out a boomy hit)
  layers   list of extra cues placed relative to this one: {"dt": 0.0, "gain_db": -6, ...any cue field}
  pan      -1 (left) .. 1 (right), constant power: a sound that follows an object across the picture
  mono     true: both sides play the louder channel of a stereo sound; "left" / "right" pick one. A sound whose
           channels are in opposite phase vanishes on a phone speaker: mix.py does this itself for correlation
           under -0.3 (--no-mono-fix keeps them as recorded, "mono": false keeps one)

Which sound: "file" (path), "id" (the number search.py printed), "uisfx" (a UI cue name), or "pick".
Automatic choice: instead of "file"/"uisfx" give "pick", the same spec as search.py / picker.py. Picks are
varied across the sheet (a file already used is penalised) and respect taste.json.

Options that change the mix
  --duck           dip the original audio under the SFX (sidechain): for music-led videos
  --voice-safe     dip the SFX under speech in the original audio: for voice-over videos
  --snap-beats     move hits/clicks to the music's beat when within --snap-tol-ms (only if the pulse is reliable)
  --lead-ms N      shift every cue by N ms (negative = earlier), e.g. to compensate a laggy player
  --target-lufs X  gain the final mix towards X LUFS (limited so that at most 4 dB of limiting is needed);
                   default -14 when the video has no sound of its own, none when it has (author's balance)

Writes: <out>.mp4 (video stream copied, new audio), <stem>_sfx_track.wav (SFX only, 48 kHz 24-bit),
        <stem>_cue_report.md, <stem>_resolved_cues.json (every cue with the file, role and anchor used),
        and with --stems <stem>_stem_<name>.wav, with --export-clips <dir>/sfx_NNN_role.wav + sfx_clips.json/html;
        with a bed also <stem>_sfx_track_nobed.wav (the sounds are judged on it: a bed fills every window).

The file's true peak is checked after the AAC encode. An encoder sometimes throws ONE frame 2-4 dB above its input,
which the limiter in front of it cannot see: that place is dipped by what it overshoots (about 0.1 s, a raised cosine),
and the whole ceiling comes down only when the overshoot is everywhere.
"""
import argparse
import json
import re
import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import beats as beatmod
from common import (show_name, ROLE_ANCHOR, ROLE_TARGET_PEAK_DB, SKILL_DIR, analyse_sound, index_path, load_config,
                    measure_loudness, require_tools, run)
from common import (arrival_landmarks, arrive_offset, channel_count, load_json, louder_channel, norm_path, onset_time, stereo_fmt,
                    venv_python, window_levels)
from picker import load_index, load_taste, pick
from search import uisfx_file

SR = 48000
BATCH = 48            # most cue files ffmpeg is asked to open at once
LIMIT = 0.891         # -1 dBFS ceiling for the limiter
ROLE_FADES = {"ambience": (0.30, 0.60), "vehicle": (0.20, 0.40)}      # (fade in, fade out) in seconds
BEAT_ROLES = {"hit", "sub_drop", "click", "ui", "design", "glass", "coin", "data", "error"}
VOICE_DEPTH = {"light": "threshold=0.05:ratio=2:attack=8:release=160",          # about -3..-5 dB: textures stay heard
               "normal": "threshold=0.025:ratio=3.5:attack=6:release=180",      # about -9 dB at the cues
               "deep": "threshold=0.012:ratio=8:attack=4:release=240"}           # for loud sounds over speech
STEMS = {"impacts": {"hit", "sub_drop", "design"},
         "motion": {"whoosh", "riser", "glitch", "scifi", "camera"},
         "interface": {"click", "ui", "data", "error", "glass", "coin", "paper", "cartoon", "meme", "pop", "chime",
                       "typing", "water"},
         "atmos": {"ambience", "vehicle", "foley"}}


# ------------------------------------------------------------------ cue preparation
def _atempo(factor):
    """atempo chain for any factor (each stage must stay within 0.5..2)."""
    parts = []
    while factor > 2.0:
        parts.append("atempo=2.0")
        factor /= 2.0
    while factor < 0.5:
        parts.append("atempo=0.5")
        factor /= 0.5
    parts.append(f"atempo={factor:.5f}")
    return parts


def process_chain(c, info, warns, n):
    """Return (ffmpeg filter fragments, info as it will be after processing)."""
    f, info = [], dict(info)
    act = info.get("active_dur")
    if act and act < info["duration"] - 0.15 and c.get("role") not in ("ambience", "vehicle") and not c.get("keep_tail"):
        cut = round(min(info["duration"], act + 0.03), 3)   # padded pack file: drop the silence after the sound,
        f += [f"atrim=end={cut:.3f}", "asetpts=PTS-STARTPTS"]   # so fit_dur, loop_to and max_dur act on real content
        info["duration"] = cut
    if c.get("reverse"):
        f.append("areverse")
        info["peak_time"] = max(0.0, info["duration"] - info["peak_time"])
        info["onset_t"] = 0.0
        info["arrival"] = None
    semis = float(c.get("pitch", 0) or 0)
    if semis:
        semis = max(-12.0, min(12.0, semis))
        ratio = 2 ** (semis / 12)
        f += [f"asetrate={int(SR * ratio)}", f"aresample={SR}"] + _atempo(1 / ratio)
    if c.get("fit_dur"):
        want = float(c["fit_dur"])
        factor = info["duration"] / want            # >1 speeds up (shorter), <1 slows down (longer)
        if not 0.5 <= factor <= 2.0:
            warns.append(f"cue {n}: fit_dur {want}s needs a stretch of x{factor:.2f}, limited to 0.5..2 (pick a closer length)")
            factor = max(0.5, min(2.0, factor))
        f += _atempo(factor)
        info["peak_time"] = info["peak_time"] / factor
        info["onset_t"] = float(info.get("onset_t") or 0.0) / factor
        info["duration"] = info["duration"] / factor
        if info.get("arrival"):
            info["arrival"] = {k_: v_ / factor for k_, v_ in info["arrival"].items()}
    if c.get("highpass"):
        f.append(f"highpass=f={float(c['highpass']):.0f}")
    if c.get("lowpass"):
        f.append(f"lowpass=f={float(c['lowpass']):.0f}")
    return f, info


def expand(cues):
    """Flatten 'layers' into ordinary cues placed relative to their parent."""
    out = []
    for c in cues:
        out.append(c)
        for lay in c.get("layers", []):
            l = dict(lay)
            l["t"] = c["t"] + l.pop("dt", 0.0)
            l["_layer"] = True
            l.setdefault("label", (c.get("label", "") + " (layer)").strip())
            out.append(l)
    return out


def resolve_cue(c, cfg, index_by_path):
    if "uisfx" in c:
        f = uisfx_file(cfg, c["uisfx"], c.get("pack"))
        if not f:
            raise SystemExit(f"uisfx cue not found: {c['uisfx']} (pack {c.get('pack') or cfg['uisfx']['default_pack']})")
        c["_source"] = "uisfx"
        c.setdefault("role", "ui")
    else:
        f = Path(norm_path(c["file"]))
        if not f.exists():
            raise SystemExit(f"file not found: {f}  (was the library moved? run scripts/build_index.py)")
        c["_source"] = "library"
        rec = index_by_path.get(str(f))
        if "role" not in c:
            c["role"] = rec["role"] if rec else "default"
    return Path(f)


DUCK_UNDER_VOICE = "threshold=0.04:ratio=4:attack=15:release=350:makeup=1"


def build_base(items, video, has_audio, dur, dst, work, match=True, duck_under=None):
    """Sum the given stems into one 48 kHz stereo bed of length dur and bring it to the loudness of the video's own
    audio (the synthesized layer that was taken out is quiet, so the match is a fraction of a dB). A base built by
    subtraction (unbake.py) keeps the original's level: match=False. duck_under: the items that are NOT speech dip
    under the items whose name says speech (a score rebuilt from stems has lost the author's sidechain)."""
    args, g = [], []
    speech = [i for i, it in enumerate(items)
              if any(w in Path(str(it["file"])).stem.lower() for w in VOICE_STEM_WORDS)] if duck_under else []
    for i, it in enumerate(items):
        args += ["-i", str(it["file"])]
        off, gdb = float(it.get("offset", 0.0)), float(it.get("gain_db", 0.0))
        pre = (f"adelay={int(round(off * 1000))}|{int(round(off * 1000))}," if off > 0.0005 else
               f"atrim=start={-off:.4f},asetpts=PTS-STARTPTS," if off < -0.0005 else "")
        vol = f"volume={gdb:.2f}dB," if abs(gdb) > 0.01 else ""
        g.append(f"[{i}:a]{stereo_fmt(it['file'], SR)},{pre}{vol}apad=whole_dur={dur:.3f},"
                 f"atrim=end={dur:.3f}[b{i}]")
    labels = [f"[b{i}]" for i in range(len(items))]
    if speech and len(speech) < len(items):
        keys = [f"[k{j}]" for j in range(len(speech))]
        outs_ = "".join(f"[v{j}]" for j in range(len(speech)))
        for j, i in enumerate(speech):            # each speech item is heard AND keys the ducking of the rest
            g.append(f"[b{i}]asplit=2[v{j}][k{j}]")
            labels[i] = f"[v{j}]"
        if len(speech) > 1:
            g.append("".join(keys) + f"amix=inputs={len(speech)}:normalize=0:dropout_transition=0[key]")
        else:
            g.append(f"{keys[0]}anull[key]")
        n_k = 0
        for i in range(len(items)):
            if i in speech:
                continue
            n_k += 1
        if n_k > 1:
            g.append("[key]" + f"asplit={n_k}" + "".join(f"[kk{q}]" for q in range(n_k)))
        q = 0
        for i in range(len(items)):
            if i in speech:
                continue
            ksrc = f"[kk{q}]" if n_k > 1 else "[key]"
            g.append(f"[b{i}]{ksrc}sidechaincompress={duck_under}[d{i}]")
            labels[i] = f"[d{i}]"
            q += 1
    if len(items) > 1:
        g.append("".join(labels) + f"amix=inputs={len(items)}:normalize=0:dropout_transition=0[base]")
    else:
        g.append(f"{labels[0]}anull[base]")
    raw = Path(work) / f"{Path(dst).stem}__raw.wav"
    run_ffmpeg(args + ["@@GRAPH@@", "-map", "[base]", "-c:a", "pcm_s24le", "-ar", str(SR), str(raw)],
               ";\n".join(g), work)
    gain = 0.0
    if match and has_audio and video:
        ref, got = measure_loudness(video)["lufs"], measure_loudness(raw)["lufs"]
        if ref is not None and got is not None:
            gain = max(-12.0, min(12.0, ref - got))
    run_ffmpeg(["-i", str(raw), "-af", f"volume={gain:.2f}dB", "-c:a", "pcm_s24le", "-ar", str(SR), str(dst)])
    raw.unlink(missing_ok=True)
    return gain


VOICE_STEM_WORDS = ("voice", "vo_", "_vo", "vox", "dialog", "narrat", "speech", "speak")


def lib_fields(p, by_path):
    """Which library and which recording a placed sound comes from (the report and the critique name them)."""
    c = p["c"]
    src = c.get("_slice_of") or str(p["file"])
    if p["source"] == "uisfx":
        return {"library": "uisfx", "tier": "uisfx", "source_file": src}
    rec = by_path.get(src) or by_path.get(str(p["file"]))
    if rec is None:
        return {"library": "?", "tier": "?", "source_file": src}
    return {"library": rec.get("library", "?"), "tier": rec.get("tier", "main"), "source_file": src}


def build_voice_key(items, dur, gain_db, dst, work):
    """The speech stem(s) alone at the level they have inside the rebuilt base: the key of the ducking. Music under
    a phrase must not duck the effects (the whole base as a key did)."""
    args, g = [], []
    for i, it in enumerate(items):
        args += ["-i", str(it["file"])]
        off = float(it.get("offset", 0.0))
        gdb = float(it.get("gain_db", 0.0)) + gain_db
        pre = (f"adelay={int(round(off * 1000))}|{int(round(off * 1000))}," if off > 0.0005 else
               f"atrim=start={-off:.4f},asetpts=PTS-STARTPTS," if off < -0.0005 else "")
        g.append(f"[{i}:a]{stereo_fmt(it['file'], SR)},{pre}volume={gdb:.2f}dB,"
                 f"apad=whole_dur={dur:.3f},atrim=end={dur:.3f}[k{i}]")
    if len(items) > 1:
        g.append("".join(f"[k{i}]" for i in range(len(items))) +
                 f"amix=inputs={len(items)}:normalize=0:dropout_transition=0[key]")
    else:
        g.append("[k0]anull[key]")
    run_ffmpeg(args + ["@@GRAPH@@", "-map", "[key]", "-c:a", "pcm_s24le", "-ar", str(SR), str(dst)],
               ";\n".join(g), work)


def cut_slice(f, c, slice_dir):
    """cue field "slice": [start_s, length_s]  ->  that piece of the recording as its own small wav."""
    sl = c["slice"]
    if isinstance(sl, (str, dict)):          # "first" | "loudest" | {"onset": 2}: a separate sound of the file
        from common import onsets
        mode = sl if isinstance(sl, str) else "onset"
        k = int(sl.get("onset", 0)) if isinstance(sl, dict) else 0
        ons, _ = onsets(f)
        if not ons:
            # a render must not die for one cue: the first 0.1 s of the recording, and a line that names the file
            print(f"WARN slice {sl!r}: no separate sound found in {show_name(f)} (cue at {c.get('t', 0):.2f}s): "
                  f"its first 0.1 s are used", file=sys.stderr)
            c["slice"] = sl = [0.0, 0.1]
        else:
            if mode == "loudest":                # the biggest hit of the recording
                k = max(range(len(ons)), key=lambda i: ons[i][1])
            elif mode == "first":                # the first SIGNIFICANT one: a rustle before the knock is not it
                top = max(l for _, l in ons)
                k = next((i for i, (_, l) in enumerate(ons) if l >= top - 15.0), 0)
            k = max(0, min(k, len(ons) - 1))
            t0 = ons[k][0]
            nxt = ons[k + 1][0] if k + 1 < len(ons) else t0 + 0.2
            c["slice"] = sl = [max(0.0, t0 - 0.006), round(min(0.12, max(0.04, nxt - t0 - 0.004)), 3)]
    s0, sd = max(0.0, float(sl[0])), max(0.02, float(sl[1]))
    slice_dir.mkdir(parents=True, exist_ok=True)
    out = slice_dir / f"{Path(f).stem[:36].strip()}_{int(s0 * 1000)}_{int(sd * 1000)}.wav"
    if not out.exists():
        # decode first, cut after: input seeking (-ss before -i) drops the first ~45 ms of an MP3 (decoder
        # preroll) and with it the attack of the keystroke
        run_ffmpeg(["-i", str(f), "-vn", "-ac", "2", "-ar", str(SR),
                    "-af", ("pan=stereo|c0=c0|c1=c0," if channel_count(f) == 1 else "") +
                           f"atrim=start={s0:.4f}:duration={sd:.4f},asetpts=PTS-STARTPTS,"
                           f"afade=t=in:d=0.002,afade=t=out:st={max(0.0, sd - 0.012):.3f}:d=0.012",
                    "-c:a", "pcm_s24le", str(out)])
    c["_slice_of"] = str(f)
    if c.get("role") not in ("typing", "click") and not str(c.get("label", "")).startswith("key"):
        try:                                # a recording of a fall holds a hit and its echo: 'tu-dum' is not one knock
            from common import clean_hits
            hs, _ = clean_hits(out, max_len=0.35)
            strong = [h for h in hs if h["level_db"] >= -10.0]
            if len(strong) >= 2 and strong[1]["t"] - strong[0]["t"] <= 0.14:
                print(f"WARN slice: {show_name(f)} [{s0:.2f}, {sd:.2f}] (cue at {c.get('t', 0):.2f}s) holds two hits "
                      f"{1000 * (strong[1]['t'] - strong[0]['t']):.0f} ms apart: shorten it (a length under "
                      f"{1000 * (strong[1]['t'] - strong[0]['t']):.0f} ms) or take another hit "
                      f"(listen.py onsets ID lists the clean ones)", file=sys.stderr)
        except Exception:
            pass
    return out


def guess_role(c, by_path):
    if c.get("role"):
        return c["role"]
    if "pick" in c:
        return c["pick"].get("role")
    if "uisfx" in c:
        return "ui"
    rec = by_path.get(str(c.get("file", "")))
    return rec["role"] if rec else None


def plan_cue(c, f, info, a, warns, n):
    loud_ = None                         # the perceived level of the sound as it is, before any gain
    if info.get("mean_db") is not None:
        dur_ = max(0.02, info["duration"])
        act_ = max(0.02, min(dur_, info.get("active_dur") or dur_))
        loud_ = info["mean_db"] + 10 * math.log10(dur_ / max(act_, 0.2))   # the ear integrates ~200 ms
    proc, info = process_chain(c, info, warns, n)
    role = c["role"]
    anchor = c.get("anchor") or ROLE_ANCHOR.get(role, "peak")
    arr_off = None
    if anchor == "arrive" or (anchor == "peak" and not c.get("anchor")):
        # round 9 (the sync test): a sound that gets loud fast goes by its arrival, one that builds by its peak
        arr_off = arrive_offset(info.get("arrival"), info["peak_time"], forced=(anchor == "arrive"))
        anchor = "arrive" if arr_off is not None else "peak"
    offset = {"start": 0.0, "peak": info["peak_time"], "end": info["duration"], "arrive": arr_off}[anchor]
    onset_shift = 0.0
    if anchor == "start" and role not in ("ambience", "vehicle") and not c.get("loop_to"):
        lead_ = float(info.get("onset_t") or 0.0)
        if lead_ > 0.006:               # a silent lead-in (a breath, 85 ms of nothing) is not the sound
            onset_shift = round(min(0.35, lead_ - 0.003), 3)
            offset = onset_shift
    start = c["t"] - offset
    trim = max(0.0, -start)              # part of the sound that would fall before 0:00
    start = max(0.0, start)
    end = info["duration"]
    loop_to = c.get("loop_to")
    if loop_to:
        end = trim + float(loop_to)
    if c.get("max_dur"):
        end = min(end, trim + float(c["max_dur"]))
    seg = max(0.05, end - trim)
    target = ROLE_TARGET_PEAK_DB.get(role, ROLE_TARGET_PEAK_DB["default"])
    boost = target - info["peak_db"]
    if boost > 12 and c.get("slice") and role not in ("typing", "click"):
        warns.append(f"cue {n}: the slice of {show_name(c.get('_slice_of') or f)} is quiet (+{boost:.0f} dB to reach "
                     f"its level): its noise floor comes up with it; take a louder hit of that recording "
                     f"(listen.py onsets ID) or another sound")
    if boost > 14 and not c.get("slice"):          # a keystroke slice is normalised by design, not a quiet file
        warns.append(f"cue {n}: {show_name(f)} is very quiet in the library (needs +{boost:.0f} dB); its noise floor comes up too")
    # equal peaks are not equal loudness: a 2 ms click is far quieter than a 100 ms pop of the same peak
    act = info.get("active_dur") or info["duration"]
    comp = 0.0
    if act < 0.12 and role not in ("ambience", "vehicle") and not c.get("slice"):
        comp = min(6.0, 5.0 * math.log10(0.12 / max(act, 0.004)))
    want = boost + c.get("gain_db", 0.0) + a.sfx_trim_db + comp
    gain = min(18.0, want)
    capped = max(0.0, want - gain)
    if capped >= 0.5:
        warns.append(f"cue {n}: {show_name(f)} would need {want:+.0f} dB, capped at +18: it sits {capped:.0f} dB under plan "
                     f"(pick a louder recording or give it a layer)")
    fi_def, fo_def = ROLE_FADES.get(role, (0.004, min(0.04, seg / 2)))
    fi = float(c.get("fade_in", fi_def))
    fo = min(float(c.get("fade_out", fo_def)), seg)
    return {"n": n, "c": c, "file": f, "role": role, "anchor": anchor, "start": start, "trim": trim, "end": end,
            "seg": seg, "gain": gain, "proc": proc, "fi": fi, "fo": fo, "loop_to": loop_to, "info": info,
            "t": c["t"], "label": c.get("label", ""), "source": c["_source"], "layer": bool(c.get("_layer")),
            "capped_db": round(capped, 1), "comp_db": round(comp, 1), "loud_pre": loud_,
            "base_want": boost + comp, "onset_shift": onset_shift, "level_adj": 0.0}


TONAL_ROLES = {"chime", "pop", "glass", "coin", "ui"}      # sounds with a pitch: tuned to the score when it is known
EQ_SKIP = {"typing", "click", "ui", "data", "ambience", "vehicle"}     # the author's own per-hit levels, loops


def equalize_roles(plans, a):
    """Equal peak is not equal loudness: a bright swipe at the whoosh's peak target sits 15 dB under a dark whoosh at
    the same peak (a crest of 35 dB against 19). Inside one role the sounds are brought to one perceived level (the
    median, at most 6 dB either way, never above -1.5 dBFS at the peak). This happens BEFORE the author's per-event
    gain_db, which keeps the intended hierarchy. Returns [(plan, adjustment dB)]."""
    if a.no_level_roles:
        return []
    groups = {}
    for p in plans:
        c = p["c"]
        if p["role"] in EQ_SKIP or p.get("loud_pre") is None or c.get("keep_level") or p["layer"]:
            continue
        # the texture layer (texture.py) is quiet on purpose: it is levelled among itself, never against the real
        # events of its role (their median would move)
        groups.setdefault((p["role"], bool(c.get("texture"))), []).append(p)
    done = []
    for (role, _tex), ps in groups.items():
        if len(ps) < 3:
            continue
        lv = [p["loud_pre"] + p["base_want"] for p in ps]
        s = sorted(lv)
        if s[int(0.9 * (len(s) - 1))] - s[int(0.1 * (len(s) - 1))] < 5.0:
            continue
        med = s[len(s) // 2]
        for p, l_ in zip(ps, lv):
            peak_after = p["info"].get("peak_db", -6.0) + p["gain"]
            up_cap = max(0.0, min(6.0, -1.5 - peak_after))
            adj = max(-6.0, min(up_cap, med - l_))
            if abs(adj) >= 0.5:
                p["gain"] += adj
                p["level_adj"] = round(adj, 1)
                done.append((p, adj))
    return done


# ------------------------------------------------------------------ ffmpeg graphs
def chain_for(k, p, out_label, with_delay=True):
    parts = [f"[{k}:a]{stereo_fmt(p['file'], SR)}"]
    mono_ = p["c"].get("mono")
    if mono_ and channel_count(p["file"]) == 2:
        ch_ = (0 if mono_ == "left" else 1 if mono_ == "right" else louder_channel(p["file"]))
        parts.append(f"pan=stereo|c0=c{ch_}|c1=c{ch_}")
    parts += p["proc"]
    if p["loop_to"]:
        parts.append(f"aloop=loop=-1:size={int(p['info']['duration'] * SR) + 1}")
    # fade_curve: "qsin" = equal power, for the cross-fade of two UNCORRELATED sounds (a bed made of overlapping
    # pieces: linear fades of noise dip 3 dB in the middle)
    crv = f":curve={p['c']['fade_curve']}" if p["c"].get("fade_curve") in ("qsin", "esin", "hsin", "log", "par") else ""
    parts += [f"atrim=start={p['trim']:.3f}:end={p['end']:.3f}", "asetpts=PTS-STARTPTS",
              f"afade=t=in:d={p['fi']:.3f}{crv}", f"afade=t=out:st={max(0.0, p['seg'] - p['fo']):.3f}:d={p['fo']:.3f}{crv}",
              f"volume={p['gain']:.2f}dB"]
    pan_ = p["c"].get("pan")
    if pan_:
        ang_ = (max(-1.0, min(1.0, float(pan_))) + 1.0) * math.pi / 4.0       # constant power, centre = unity
        parts.append(f"pan=stereo|c0={math.sqrt(2) * math.cos(ang_):.4f}*c0|c1={math.sqrt(2) * math.sin(ang_):.4f}*c1")
    if with_delay:
        ms = int(round(p["start"] * 1000))
        # asetpts after adelay: a stream that went through asetrate/atempo/rubberband keeps odd timestamps, and
        # without this the delay is lost (sound at 0:00, track shorter by the delay) as soon as it is mixed
        parts.append(f"adelay={ms}|{ms}")
        parts.append("asetpts=N/SR/TB")
    return ",".join(parts) + f"[{out_label}]"


def run_ffmpeg(args, script_text=None, workdir=None):
    """Run ffmpeg; a long filter graph goes through a script file (Windows command lines are short)."""
    base = ["ffmpeg", "-v", "error", "-y", "-nostdin"]
    if script_text is None:
        r = subprocess.run(base + args, capture_output=True, text=True, errors="replace")
        if r.returncode:
            sys.exit("ffmpeg failed:\n" + r.stderr[-2000:])
        return
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, dir=workdir, encoding="utf-8") as tf:
        tf.write(script_text)
        script = tf.name
    try:
        for flag in ("-/filter_complex", "-filter_complex_script"):
            # the script flag has to come right before the outputs, i.e. after all -i inputs
            i = args.index("@@GRAPH@@")
            cmd = base + args[:i] + [flag, script] + args[i + 1:]
            r = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
            if r.returncode == 0:
                return
        sys.exit("ffmpeg failed:\n" + r.stderr[-2000:])
    finally:
        try:
            Path(script).unlink()
        except OSError:
            pass


def render_bus(plans, dur, out_wav, workdir):
    """Sum cue plans into one stereo 48 kHz 24-bit wav of length dur (no limiter)."""
    out_wav = Path(out_wav)
    if not plans:
        run_ffmpeg(["-f", "lavfi", "-t", f"{dur:.3f}", "-i", f"anullsrc=r={SR}:cl=stereo", "-c:a", "pcm_s24le", str(out_wav)])
        return
    chunks = [plans[i:i + BATCH] for i in range(0, len(plans), BATCH)]
    partials = []
    for ci, chunk in enumerate(chunks):
        target = out_wav if len(chunks) == 1 else Path(workdir) / f"{out_wav.stem}_part{ci}.wav"
        args, g, labels = [], [], []
        for k, p in enumerate(chunk):
            args += ["-i", str(p["file"])]
            g.append(chain_for(k, p, f"c{k}"))
            labels.append(f"[c{k}]")
        # A silent bed of the full length is one more amix input: the bus is exactly `dur` long. (Padding with
        # apad=whole_dur after amix was a race in this ffmpeg: about one render in three ended at the last sound.)
        g.append(f"anullsrc=r={SR}:cl=stereo,atrim=end={dur:.3f},asetpts=N/SR/TB[sil]")
        g.append(f"[sil]{''.join(labels)}amix=inputs={len(labels) + 1}:normalize=0:dropout_transition=0,"
                 f"atrim=end={dur:.3f},afade=t=out:st={max(0.0, dur - 0.03):.3f}:d=0.03[bus]")
        run_ffmpeg(args + ["@@GRAPH@@", "-map", "[bus]", "-c:a", "pcm_s24le", "-ar", str(SR), str(target)],
                   ";\n".join(g), workdir)
        partials.append(target)
    if len(chunks) > 1:
        args = []
        for pth in partials:
            args += ["-i", str(pth)]
        g = [f"{''.join(f'[{i}:a]' for i in range(len(partials)))}amix=inputs={len(partials)}:normalize=0"
             f":dropout_transition=0[bus]"]
        run_ffmpeg(args + ["@@GRAPH@@", "-map", "[bus]", "-c:a", "pcm_s24le", "-ar", str(SR), str(out_wav)],
                   ";\n".join(g), workdir)
        for pth in partials:
            pth.unlink(missing_ok=True)


def limit_wav(src, dst, gain_db=0.0):
    vol = f"volume={gain_db:.2f}dB," if abs(gain_db) > 0.005 else ""
    run_ffmpeg(["-i", str(src), "-af", f"{vol}alimiter=limit={LIMIT}:level=0:latency=1", "-c:a", "pcm_s24le",
                "-ar", str(SR), str(dst)])


FRAME_S = 4096 / 192000.0         # the frame of frame_peaks(): 21.3 ms, whatever the file's own frames are
DIP_WIDTH = 0.12                  # a local dip lasts this long (raised cosine): the length of a limiter's release
DIP_MAX_DB = 6.0                  # a place that needs more than this is not a glitch: the whole mix goes down
DIP_MAX_N = 40


def frame_peaks(path):
    """[(t_centre_s, peak_db)] for every 21 ms frame of an audio file: the peak of the 4x oversampled signal, the way a
    true-peak meter sees it."""
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-nostdin", "-i", str(path), "-vn", "-af",
                        "aresample=192000,asetnsamples=n=4096:p=0,astats=metadata=1:reset=1,"
                        "ametadata=print:key=lavfi.astats.Overall.Peak_level:file=-",
                        "-f", "null", "-"], capture_output=True, text=True, errors="replace")
    t_now, rows = 0.0, []
    for line in r.stdout.splitlines():
        m = re.search(r"pts_time:(-?[\d.]+)", line)
        if m:
            t_now = float(m.group(1))
            continue
        m = re.search(r"Peak_level=(-?[\d.]+|-inf)", line)
        if m:
            rows.append((t_now + FRAME_S / 2, float(m.group(1)) if m.group(1) != "-inf" else -200.0))
    return rows


def peak_events(path, above_db):
    """Places of an encoded file whose peak is above `above_db`: [[t_seconds, peak_db], ...], one entry per place, the
    loudest frame of each. The AAC encoder sometimes throws one isolated frame 2-4 dB above what it was given; the
    limiter in front of it cannot see that."""
    events = []
    for t_, pk_ in frame_peaks(path):
        if pk_ <= above_db:
            continue
        if events and t_ - events[-1][2] <= 0.06:          # frames closer than 60 ms are one place
            events[-1][2] = t_
            if pk_ > events[-1][1]:
                events[-1][0], events[-1][1] = t_, pk_
        else:
            events.append([t_, pk_, t_])
    return [[t_, pk_] for t_, pk_, _ in events]


def layer_match_db(sheet, a, bus):
    """(match_db, want_db, measure) for a film that replaces a synthesized layer: the whole SFX bus is raised to the
    loudness that layer had in the mix (only raised, at most 3 dB of limiter work). (0.0, None, None) when the sheet
    does not know the layer or the match is off."""
    layer = (sheet.get("_draft") or {}).get("layer_lufs")
    if layer is None or a.no_match_layer or abs(a.sfx_trim_db) >= 1e-9:
        return 0.0, None, None
    m = measure_loudness(bus)
    if m.get("lufs") is None:
        return 0.0, None, m
    want_db = layer - m["lufs"]
    room = (a.ceiling_db - m["true_peak"] + 3.0) if m.get("true_peak") is not None else 18.0
    return round(max(0.0, min(18.0, want_db, room)), 1), want_db, m      # only raises: real sounds need presence


def master_target(a, keep):
    """The loudness the final master aims at (None = no loudness step), before a rebuilt base changes it."""
    target = a.target_lufs
    if a.loudnorm:
        target = -14.0
    if target is None and not keep and not a.no_loudnorm:
        target = -14.0                    # the video has no sound of its own: the SFX are the whole mix
    if a.no_loudnorm:
        target = None
    return target


def master_gain_db(m_pre, target, ceiling_db):
    """The gain of the final master for a mix measured as `m_pre`: towards the target, and no more than 4 dB of
    limiter work (none at all when there is no target)."""
    gain = 0.0
    if target is not None and m_pre.get("lufs") is not None:
        gain = max(-12.0, min(12.0, target - m_pre["lufs"]))
    if m_pre.get("true_peak") is not None:
        gain = min(gain, ceiling_db - m_pre["true_peak"] + (4.0 if target is not None else 0.0))
    return gain


def master_chain(gain_db, limit, dips=None):
    """The filter of the final master: gain, limiter, and short local dips (after the limiter, so they stay)."""
    chain = f"[1:a]volume={gain_db:.2f}dB,alimiter=limit={limit:.5f}:level=0:latency=1"
    if dips:
        terms = []
        for t_, depth in dips:
            amt = 1.0 - 10 ** (-depth / 20.0)
            a0 = max(0.0, t_ - DIP_WIDTH / 2)
            terms.append(f"between(t,{a0:.4f},{a0 + DIP_WIDTH:.4f})*{amt:.4f}*0.5*"
                         f"(1-cos(2*PI*(t-{a0:.4f})/{DIP_WIDTH:.4f}))")
        # 64-sample frames: the dip is evaluated every 1.3 ms, so it is a smooth curve and not stairs
        chain += f",asetnsamples=n=64:p=0,volume='1-({'+'.join(terms)})':eval=frame"
    return chain + "[aout]"


def run_masking(clips_dir, resolved, gain_db, original, original_gain_db, out_json):
    """The masking model (maskmodel.py) on the exported cues. numpy is needed: this Python's, or the skill's venv.
    -> (path of its JSON or None, the lines to print)."""
    py = sys.executable
    try:
        import numpy  # noqa: F401
    except ImportError:
        vp = venv_python()
        if vp is None:
            return None, ["masking: the model needs numpy, which the skill's venv has: "
                          "python scripts/listen.py install --yes (about 45 MB), then mix.py --masking again"]
        py = str(vp)
    cmd = [py, str(Path(__file__).parent / "maskmodel.py"), str(resolved), str(clips_dir), "--gain-db", f"{gain_db:.2f}",
           "--json", str(out_json)]
    if original is not None and Path(original).exists():
        cmd += ["--original", str(original), "--original-gain-db", f"{original_gain_db:.2f}"]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode or not Path(out_json).exists():
        return None, ["masking: the model failed: " + (r.stderr or r.stdout).strip()[-300:]]
    return Path(out_json), r.stdout.rstrip().splitlines() + [f"masking model: {out_json}"]


def export_clips(plans, outdir):
    """Each cue as its own processed WAV (gain baked in) plus a timing list and a HyperFrames snippet."""
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    lanes, rows = [], []
    for i, p in enumerate(plans):
        name = f"sfx_{i:03d}_{p['role']}.wav"
        g = chain_for(0, p, "x", with_delay=False)
        run_ffmpeg(["-i", str(p["file"]), "-filter_complex", g, "-map", "[x]", "-c:a", "pcm_s24le", "-ar", str(SR),
                    "-t", f"{p['seg']:.3f}", str(outdir / name)])
        lane = next((j for j, end in enumerate(lanes) if end <= p["start"] + 1e-6), None)
        if lane is None:
            lanes.append(0.0)
            lane = len(lanes) - 1
        lanes[lane] = p["start"] + p["seg"]
        rows.append({"id": f"sfx-{i:03d}", "file": name, "start": round(p["start"], 3), "duration": round(p["seg"], 3),
                     "t_moment": round(p["t"], 3), "role": p["role"], "label": p["label"], "lane": lane,
                     "source_file": str(p["file"]), "bed": bool(p["c"].get("bed")),
                     "texture": bool(p["c"].get("texture")), "layer": bool(p["layer"])})
    (outdir / "sfx_clips.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    html = ["<!-- real-sfx: paste inside the root composition; copy this folder to assets/sfx/ -->"]
    for r in rows:
        html.append(f'<audio id="{r["id"]}" src="assets/sfx/{r["file"]}" data-start="{r["start"]:.3f}" '
                    f'data-duration="{r["duration"]:.3f}" data-track-index="{20 + r["lane"]}" data-volume="1"></audio>')
    (outdir / "sfx_clips_hyperframes.html").write_text("\n".join(html) + "\n", encoding="utf-8")
    return rows


# ------------------------------------------------------------------ main
def main():
    global LIMIT
    ap = argparse.ArgumentParser()
    ap.add_argument("cues")
    ap.add_argument("--out", required=True)
    ap.add_argument("--duck", action="store_true", help="dip the original audio under the SFX (sidechain)")
    ap.add_argument("--voice-safe", action="store_true", help="dip the SFX under speech in the original audio")
    ap.add_argument("--voice-depth", choices=sorted(VOICE_DEPTH), default="normal",
                    help="how hard --voice-safe ducks: light (about -4 dB, textures stay heard), normal (about -9 dB) "
                         "or deep (loud sounds over speech: it can take UI ticks out of the mix altogether)")
    ap.add_argument("--snap-beats", action="store_true", help="move hits/clicks onto the music beat when close")
    ap.add_argument("--snap-tol-ms", type=float, default=50)
    ap.add_argument("--beats", help="beats.json from beats.py (computed from the video if omitted)")
    ap.add_argument("--lead-ms", type=float, default=0.0, help="shift all cues, negative = earlier")
    ap.add_argument("--target-lufs", type=float, help="gain the final mix towards this loudness")
    ap.add_argument("--loudnorm", action="store_true", help="same as --target-lufs -14")
    ap.add_argument("--no-loudnorm", action="store_true", help="never gain the final mix (only a -1 dBTP guard)")
    ap.add_argument("--sfx-trim-db", type=float, default=0.0, help="global offset for all SFX")
    ap.add_argument("--stems", action="store_true", help="also write grouped stems (impacts, motion, interface, atmos)")
    ap.add_argument("--export-clips", metavar="DIR", help="write every cue as its own WAV + HyperFrames snippet")
    ap.add_argument("--masking", action="store_true",
                    help="judge which sounds are audible in the mix with the masking model (maskmodel.py; needs the "
                         "skill's venv: listen.py install --yes). Writes <stem>_masking.json; critique.py reads it")
    ap.add_argument("--plan", action="store_true", help="resolve picks and print what would be placed, render nothing")
    ap.add_argument("--ceiling-db", type=float, default=-1.0,
                    help="true-peak ceiling of the finished file in dBTP (default -1; a brief that says -1.5 asks for it)")
    ap.add_argument("--base-audio", nargs="+", metavar="FILE[:GAIN_DB][@OFFSET_S]",
                    help="build the original audio from these stems/files instead of the video's own track; "
                         "'music.wav:-7' lowers it 7 dB, 'vo.wav@0.25' starts it 0.25 s late")
    ap.add_argument("--music-ref", nargs="+", metavar="FILE",
                    help="the score under the film (a music stem, the bed without the effects): pitched sounds "
                         "(chime, pop, glass, coin, ui) are retuned by up to 2 semitones plus cents to its notes (from_cues "
                         "writes it into the sheet when it knows the score)")
    ap.add_argument("--no-tonal-fit", action="store_true", help="leave the pitch of every sound as it is")
    ap.add_argument("--no-mono-fix", action="store_true",
                    help="keep a stereo sound whose channels are in opposite phase as it was recorded (by default it "
                         "plays its louder channel on both sides: on a phone speaker it would cancel)")
    ap.add_argument("--no-level-roles", action="store_true",
                    help="keep every sound at its role's PEAK target (by default sounds of one role are also brought "
                         "to one perceived level: a thin bright swipe is not 15 dB under a dark whoosh)")
    ap.add_argument("--no-match-layer", action="store_true",
                    help="do not bring the new SFX to the loudness of the synthesized layer they replace (from_cues "
                         "measures that layer; a given --sfx-trim-db also switches the match off)")
    ap.add_argument("--duck-music", action="store_true",
                    help="with --base-audio: the files that are not speech (name has voice/vo/narr...) dip under "
                         "the speech files (the author's sidechain is lost when a score is rebuilt from stems)")
    ap.add_argument("--drop-original", action="store_true",
                    help="throw the video's own audio away (it is only the synthesized layer being replaced)")
    a = ap.parse_args()
    LIMIT = 10 ** ((a.ceiling_db - 0.7) / 20.0)      # AAC overshoots the sample peak by up to ~0.8 dB
    require_tools()

    cfg = load_config()
    cues_path = Path(a.cues).resolve()
    sheet = load_json(cues_path)
    parents = sheet["cues"]
    if not parents:
        sys.exit("cue sheet has no cues")

    def abspath(p):
        q = Path(norm_path(p))
        return str(q if q.is_absolute() or q.exists() else (cues_path.parent / q))

    video = abspath(sheet["video"]) if sheet.get("video") else None
    dur = sheet.get("duration")
    has_audio = has_video = False
    if video:
        j = json.loads(run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type",
                            "-of", "json", video]).stdout or "{}")
        if "format" not in j:
            sys.exit(f"cannot read the video: {video}")
        dur = float(j["format"]["duration"])
        kinds = [s["codec_type"] for s in j["streams"]]
        has_audio, has_video = "audio" in kinds, "video" in kinds
    if not dur:
        sys.exit("need \"video\" or \"duration\" in the cue sheet")
    if a.drop_original:
        sheet["keep_audio"] = "no"
    base_items = []
    for x in (a.base_audio or sheet.get("base_audio") or []):
        if isinstance(x, dict):
            it = dict(x)
        else:                                    # "FILE", "FILE:-7", "FILE@0.2", "FILE:-7@0.2" ("C:\\x" is not a gain)
            m_ = re.match(r"^(.*?)(?::(-?\d+(?:\.\d+)?))?(?:@(-?\d+(?:\.\d+)?))?$", str(x))
            it = {"file": m_.group(1) if m_ else str(x)}
            if m_ and m_.group(2) is not None:
                it["gain_db"] = float(m_.group(2))
            if m_ and m_.group(3) is not None:
                it["offset"] = float(m_.group(3))
        it["file"] = abspath(it["file"])
        base_items.append(it)
    for it in base_items:
        if not Path(it["file"]).exists():
            sys.exit(f"base_audio file not found: {it['file']}")
    key_items = [it for it in base_items if it.get("key_only")]        # speech files that only key the ducking
    base_items = [it for it in base_items if not it.get("key_only")]
    base_list = [it["file"] for it in base_items]
    voice_items = key_items + [it for it in base_items
                               if any(w in Path(str(it["file"])).stem.lower() for w in VOICE_STEM_WORDS)]
    keep = {"yes": True, "no": False}.get(sheet.get("keep_audio", "auto"), has_audio) and has_audio
    orig_lufs_ = None
    if base_list:
        keep = sheet.get("keep_audio", "auto") != "no"          # the stems ARE the original audio

    idx_file = index_path(cfg)
    by_path = {}
    if idx_file.exists():
        by_path = {s["path"]: s for s in json.loads(idx_file.read_text(encoding="utf-8"))["sounds"]}

    # --- timing adjustments on the moments themselves (before layers are expanded, so layers follow)
    warns, snapped = [], 0
    if keep and not base_list and (sheet.get("_draft") or {}).get("baked_strong"):
        warns.append("the render's own audio contains the synthesized sounds this sheet replaces and is being KEPT: "
                     "the new sounds will double them. Use base_audio (project stems), --base-audio, or "
                     "--drop-original when that audio is only the synthesized layer.")
    for c in parents:
        c["t"] = max(0.0, c["t"] + a.lead_ms / 1000.0)
    if keep and not base_list and video and has_audio and not (sheet.get("_draft") or {}).get("baked_strong"):
        # whatever made the list, say it when the original audio already has a sound at the cue times: a synthesized
        # layer under the new sounds doubles them
        try:
            from common import onsets as _ons
            on_, _ = _ons(video)
            on_t = [o_[0] for o_ in on_]
            ts_ = sorted({round(c["t"], 2) for c in parents if "uisfx" in c or "file" in c or "pick" in c})
            if len(ts_) >= 6 and on_t:
                import bisect as _bs

                def share_(shift):
                    return sum(1 for t_ in ts_ if (lambda j: j < len(on_t) and on_t[j] <= t_ + shift + 0.03)(
                        _bs.bisect_left(on_t, t_ + shift - 0.03))) / len(ts_)
                s0_, sc_ = share_(0.0), (share_(0.31) + share_(0.53)) / 2
                if s0_ >= 0.5 and s0_ >= sc_ + 0.25:
                    warns.append(f"the original audio has a sound at {s0_:.0%} of the cue times (by chance {sc_:.0%}): "
                                 f"it probably holds the synthesized layer these sounds replace, and the new ones will "
                                 f"DOUBLE it. Take it out: from_cues.py (stems / from_synth), --base-audio, or "
                                 f"--drop-original when that audio is only the synthesized layer.")
        except Exception:
            pass
    grid, beat_info = None, None
    if a.snap_beats:
        if a.beats:
            grid = load_json(a.beats)
        elif video or sheet.get("beats_source"):
            print("detecting beats ...", flush=True)
            grid = beatmod.detect(sheet.get("beats_source") or video, 900)
            grid.pop("_kick_env", None)
        if grid and grid.get("tempo"):
            beat_info = {"tempo": grid.get("tempo"), "usable": bool(grid.get("usable")),
                         "kick_check": grid.get("kick_check"), "unusable_reason": grid.get("unusable_reason")}
            if grid.get("kick_check"):
                print(beatmod.say_check(grid), flush=True)
        if not grid or not grid.get("usable"):
            warns.append("--snap-beats: " + (
                "the beat grid sits beside the kicks and could not be moved onto them (kick check)"
                if grid and grid.get("unusable_reason") == "kick check" else
                "no steady, accented pulse found in the music") + ", nothing was snapped")
            grid = None
    if grid:
        for c in parents:
            role = guess_role(c, by_path)
            if role in BEAT_ROLES:
                b, d = beatmod.nearest(sorted(grid["beats"] + grid.get("half_beats", [])), c["t"])
                if b is not None and abs(d) <= a.snap_tol_ms:
                    c["_snapped_ms"] = -d
                    c["t"] = b
                    snapped += 1

    cues = sorted(expand(parents), key=lambda c: c["t"])
    index = load_index() if any("pick" in c or "id" in c for c in cues) else []
    taste = load_taste()
    for c in cues:                      # {"id": 412}: the id search.py / contact_sheet.py printed
        named = [k for k in ("file", "id", "uisfx") if k in c]
        if "pick" in c and named:       # a sound named on purpose beats an automatic choice
            c.pop("pick")
            warns.append(f"cue at {c['t']:.2f}s has both a pick and {named[0]}: the named sound is used, the pick is "
                         f"ignored (sheet.py set {named[0]}=... does this for you)")
        if "id" in c and "file" not in c and "uisfx" not in c:
            rec = next((s for s in index if s["id"] == c["id"]), None)
            if rec is None:
                sys.exit(f"no sound with id {c['id']} in the index (ids change when the index is rebuilt)")
            c["file"] = rec["path"]
            c.setdefault("role", rec["role"])
    used_paths = {}
    for c in cues:                      # explicit files count as "used" before the automatic picks
        if "file" in c:
            used_paths[c["file"]] = used_paths.get(c["file"], 0) + 1
    for c in cues:
        if "pick" in c:
            rec = pick(index, c["pick"], used_paths, taste)
            if not rec:
                sys.exit(f"nothing in the library matches pick {c['pick']} (cue at {c['t']}s)")
            c["file"] = rec["path"]
            c.setdefault("role", c["pick"].get("role", rec["role"]))
            used_paths[rec["path"]] = used_paths.get(rec["path"], 0) + 1

    out = Path(a.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    stem = out.with_suffix("")
    work = out.parent / "_work"            # cache, slices, partial renders: not next to the deliverables
    work.mkdir(exist_ok=True)
    cache_p = work / "analysis_cache.json"
    cache = json.loads(cache_p.read_text(encoding="utf-8")) if cache_p.exists() else {}

    plans, used, ss_only = [], {}, {}
    music_ref = [norm_path(x) for x in (a.music_ref or (sheet.get("_draft") or {}).get("music_ref")
                                         or sheet.get("music_ref") or [])]
    music_ref = [x for x in music_ref if Path(x).exists()]
    tonal_done, mono_fixed = [], []
    if music_ref and not a.no_tonal_fit:
        import tonal
    for n, c in enumerate(cues):
        f = resolve_cue(c, cfg, by_path)
        if c.get("slice"):
            f = cut_slice(f, c, work / "_slices")
        key = f"{f}|{f.stat().st_mtime_ns}|{f.stat().st_size}"
        rec = by_path.get(str(f))
        info = cache.get(key)
        if info is None and rec and "peak_time" in rec:
            info = {k: rec[k] for k in ("duration", "peak_db", "peak_time", "active_dur", "mean_db", "lr_corr",
                                        "mono_ref") if k in rec}
        if info is not None and ("active_dur" not in info or "mean_db" not in info):
            info = None                     # measured before the fields existed
        if info is not None and (info.get("lr_corr") or 0.0) < -0.3 and "mono_ref" not in info:
            info = None                     # measured on the mono sum of channels that cancel: measure again
        if info is None:
            info = analyse_sound(f)
        if info is None:
            sys.exit(f"cannot decode {f}")
        if "onset_t" not in info:
            info["onset_t"] = onset_time(f)
        if "arrival" not in info and (c.get("anchor") == "arrive" or (
                not c.get("anchor") and not c.get("reverse") and ROLE_ANCHOR.get(c.get("role"), "peak") == "peak")):
            info["arrival"] = arrival_landmarks(f)           # (None when it cannot be read: the peak then)
        cache[key] = info
        if str(f) in taste.get("ban", []):
            warns.append(f"cue {n}: {show_name(f)} is on the user's ban list")
        if music_ref and not a.no_tonal_fit and c.get("role") in TONAL_ROLES and "pitch" not in c \
                and not c.get("reverse") and not c.get("_layer"):
            try:                             # a sound with a pitch over a tonal score: on a note, or off a clash
                parts_ = tonal.sound_partials(f)
                if parts_:
                    chs_ = [tonal.chroma(mf_, c["t"] - 0.1, 0.9) for mf_ in music_ref[:3]]
                    ch_ = [sum(v_) for v_ in zip(*chs_)]
                    top_ = max(ch_) or 1.0
                    s_, g_, why_ = tonal.best_shift(parts_, [v_ / top_ for v_ in ch_])
                    if s_:
                        c["pitch"] = s_
                        c["_tonal"] = tonal.midi_name(max(parts_, key=lambda x_: x_[1])[0])
                        tonal_done.append((c["t"], c["_tonal"], s_))
            except Exception:
                pass
        if c.get("mono") is None and not a.no_mono_fix and channel_count(f) == 2:
            lr_ = (rec or {}).get("lr_corr")
            if lr_ is None:
                lr_ = info.get("lr_corr")
            if lr_ is not None and lr_ < -0.3:       # the channels cancel: -0.3 loses 6 dB in mono, -1 loses the sound
                c["mono"] = True
                mono_fixed.append((c["t"], lr_, show_name(f)))
        p = plan_cue(c, f, info, a, warns, n)
        plans.append(p)
        used[str(f)] = used.get(str(f), 0) + 1
        ss_only[str(f)] = ss_only.get(str(f), True) and bool(c.get("same_source"))
        if c["t"] > dur:
            warns.append(f"cue {n} ({c.get('label', '')}) at {c['t']:.2f}s is after the end of the video")
    if tonal_done:
        print(f"tonal fit: {len(tonal_done)} pitched sound(s) retuned to the score under them (" +
              "; ".join(f"{t_:.2f}s {nm_} {s_:+.1f} st" for t_, nm_, s_ in tonal_done[:6]) +
              (" ..." if len(tonal_done) > 6 else "") + "; --no-tonal-fit leaves them as they are)")
    if mono_fixed:
        print(f"mono: {len(mono_fixed)} sound(s) have channels in opposite phase (they would lose 6+ dB on a phone "
              f"speaker or vanish): each plays its louder channel on both sides (" +
              "; ".join(f"{t_:.2f}s {nm_[:22]} r={r_:+.2f}" for t_, r_, nm_ in mono_fixed[:4]) +
              (" ..." if len(mono_fixed) > 4 else "") + "; --no-mono-fix keeps them as recorded, mono=false on a cue "
              "keeps that one)")
    eq_done = equalize_roles(plans, a)
    if eq_done:
        big_ = max(eq_done, key=lambda x: abs(x[1]))
        print(f"level: {len(eq_done)} cue(s) brought to the perceived level of their role (equal peak is not equal "
              f"loudness; largest {big_[1]:+.1f} dB at {big_[0]['t']:.2f}s; --no-level-roles keeps the peaks equal)")
    hot = [p for p in plans if p["info"].get("peak_db") is not None and p["info"]["peak_db"] + p["gain"] > 0.0]
    if hot:
        warns.append(f"{len(hot)} cue(s) peak above 0 dBFS BEFORE the limiter (e.g. {hot[0]['t']:.2f}s "
                     f"'{hot[0]['label'][:24]}' at {hot[0]['info']['peak_db'] + hot[0]['gain']:+.1f}): the limiter "
                     f"will squash them; lower their gain_db or pick louder recordings")
    klass = {"whoosh": "motion", "riser": "motion", "glitch": "motion", "scifi": "motion", "camera": "motion",
             "hit": "impact", "sub_drop": "impact", "design": "impact"}
    main_plans = [p for p in plans if not p["layer"]]
    smears = []
    i = 0
    while i < len(main_plans) - 1:
        k0 = klass.get(main_plans[i]["role"], main_plans[i]["role"])
        j = i
        while (j + 1 < len(main_plans) and main_plans[j + 1]["t"] - main_plans[j]["t"] < 0.08
               and klass.get(main_plans[j + 1]["role"], main_plans[j + 1]["role"]) == k0):
            j += 1
        if j - i >= 3:
            warns.append(f"cues {main_plans[i]['n']}-{main_plans[j]['n']}: a run of {j - i + 1} {main_plans[i]['role']} "
                         f"sounds, {1000 * (main_plans[j]['t'] - main_plans[i]['t']) / (j - i):.0f} ms apart from "
                         f"{main_plans[i]['t']:.2f}s (typing or ticks are fine if intended, otherwise thin the run)")
        else:
            for q in range(i, j):
                keyish = all(str(main_plans[x]['label']).lower().startswith("key") or main_plans[x]['role'] == "typing"
                             for x in (q, q + 1))
                if keyish:
                    continue                                       # one keyboard: rows of keys are meant to be fast
                if main_plans[q + 1]['t'] - main_plans[q]['t'] < 0.010:
                    continue                                       # the same moment: two layers, on purpose
                smears.append((main_plans[q]['n'], main_plans[q + 1]['n'], main_plans[q]['t'],
                               1000 * (main_plans[q + 1]['t'] - main_plans[q]['t'])))
        i = j + 1 if j > i else i + 1
    if smears:
        warns.append(f"{len(smears)} pair(s) of similar cues are closer than 80 ms and will smear, e.g. " +
                     "; ".join(f"cues {x}-{y} at {t:.2f}s ({ms:.0f} ms)" for x, y, t, ms in smears[:4]) +
                     (" ..." if len(smears) > 4 else "") + " (intended pairs are fine; otherwise move one)")
    for f, cnt in used.items():
        if cnt >= 3 and "_slices" not in str(f) and "uisfx" not in str(f).lower() and not ss_only.get(f):
            warns.append(f"{show_name(f)} is used {cnt} times: vary the sound")
    cache_p.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")

    if a.plan:
        print(f"{'t':>7}  {'role':9s} {'anchor':6s} {'gain dB':>7}  {'len':>5}  file   "
              f"(gain = what is applied to the FILE: role level + your gain_db)")
        for p in plans:
            fx = " ".join(x for x in (("rev" if p["c"].get("reverse") else ""),
                                      (f"{p['c']['pitch']:+g}st" if p["c"].get("pitch") else ""),
                                      (f"fit{p['c']['fit_dur']}" if p["c"].get("fit_dur") else "")) if x)
            print(f"{p['t']:7.2f}  {p['role']:9s} {p['anchor']:6s} {p['gain']:+7.1f}  {p['seg']:5.2f}  "
                  f"{show_name(p['file'])}{'  [' + fx + ']' if fx else ''}{'  (layer)' if p['layer'] else ''}"
                  f"{'  (texture)' if p['c'].get('texture') else ''}{'  (bed)' if p['c'].get('bed') else ''}")
        for w in warns:
            print("WARN", w)
        bk_ = (sheet.get("_draft") or {}).get("base_kind")
        print(f"base: {len(base_list)} stem(s), original audio {'kept' if keep else 'dropped'}"
              f"{' (' + bk_ + ')' if bk_ else ''}; voice-safe {'on, ' + a.voice_depth if a.voice_safe else 'off'}; "
              f"duck-music {'on' if (a.duck_music or sheet.get('duck_music')) else 'off'}; "
              f"layer match {'to ' + format((sheet.get('_draft') or {}).get('layer_lufs'), '.1f') + ' LUFS' if (sheet.get('_draft') or {}).get('layer_lufs') is not None and not a.no_match_layer else 'off'}")
        print(f"{len(plans)} cues planned, nothing rendered")
        return

    # --- a bed (bed.py: cues with "bed": true) is levelled against the LOUDEST place of the film, measured as the
    # finished film will have it: through the limiter AND the master (its gain and its limiter squash the peaks, the
    # bed rises with the gain). The bed's own median level lands at `level_dbfs` (default -54, set by bed.py) in the
    # master, or, when the sheet gives `floor_db` instead, that many dB under the loudest 250 ms.
    bed_plans = [p for p in plans if p["c"].get("bed")]
    bed_info = None
    nobed_raw = None
    if bed_plans:
        rest_ = [p for p in plans if not p["c"].get("bed")]
        if rest_:
            tmp_a, tmp_b = work / f"{stem.name}__nobed.wav", work / f"{stem.name}__bedonly.wav"
            render_bus(rest_, dur, tmp_a, work)
            render_bus(bed_plans, dur, tmp_b, work)
            tmp_l, tmp_m = work / f"{stem.name}__nobed_lim.wav", work / f"{stem.name}__nobed_master.wav"
            match_b = layer_match_db(sheet, a, tmp_a)[0]  # the layer match the SFX track will get (a film with one)
            limit_wav(tmp_a, tmp_l, gain_db=match_b)      # the bus as it leaves the SFX track ...
            g_master = master_gain_db(measure_loudness(tmp_l), master_target(a, keep), a.ceiling_db)
            limit_wav(tmp_l, tmp_m, gain_db=g_master)     # ... and as the master turns it into the film
            lv_a = [v for v in window_levels(tmp_m) if v > -90.0]
            lv_b = sorted(v + match_b + g_master for v in window_levels(tmp_b) if v > -90.0)
            for t_ in (tmp_b, tmp_l, tmp_m):
                t_.unlink(missing_ok=True)
            nobed_raw = tmp_a                             # kept: the track WITHOUT the bed is written below
            if lv_a and lv_b:
                loudest = max(lv_a)
                steady = lv_b[len(lv_b) // 2]                      # the median window: not the fades
                floor_ = float(bed_plans[0]["c"].get("floor_db", -24.0))
                level_ = bed_plans[0]["c"].get("level_dbfs")        # absolute: where the person wants it to sit
                want = float(level_) if level_ is not None else loudest + floor_
                delta = max(-48.0, min(18.0, want - steady))
                for p in bed_plans:
                    p["gain"] += delta
                bed_info = {"loudest_db": round(loudest, 1), "bed_before_db": round(steady, 1), "floor_db": floor_,
                            "level_dbfs": level_, "bed_target_db": round(want, 1),
                            "gain_change_db": round(delta, 1), "master_gain_db": round(g_master, 1),
                            "pieces": len(bed_plans)}
                where_ = (f"to {float(level_):.0f} dBFS (its median 250 ms in the master)" if level_ is not None else
                          f"{floor_:+g} dB under the loudest 250 ms of the film")
                print(f"bed: {len(bed_plans)} piece(s) of {show_name(bed_plans[0]['file'])} levelled {where_} "
                      f"(the loudest 250 ms is {loudest:.1f} dBFS in the master, which adds {g_master:+.1f} dB): "
                      f"{delta:+.1f} dB on the plan")
        else:
            warns.append("bed: the sheet has nothing but the bed; it stays at its role level")

    # --- render the SFX bus, then the stems / clips
    raw = work / f"{stem.name}__bus_raw.wav"
    render_bus(plans, dur, raw, work)
    sfx_wav = Path(f"{stem}_sfx_track.wav")
    # the SOUNDS are matched to the layer they replace, with or without a bed: a quiet floor lifts blocks over the
    # BS.1770 gate and lowers the integrated figure of a sparse film by 0.3 dB, which would raise every sound
    match_db, want_db, m_raw = layer_match_db(sheet, a, nobed_raw if nobed_raw is not None and nobed_raw.exists()
                                              else raw)
    layer = (sheet.get("_draft") or {}).get("layer_lufs")
    if m_raw is not None:
        if m_raw.get("lufs") is not None:
            limited = " (held back by the peak: 3 dB of limiter work at most)" if 0 < match_db < want_db - 0.05 else ""
            if want_db < -0.05:
                print(f"SFX layer: {m_raw['lufs']:.1f} LUFS as planned, the synthesized layer it replaces sat at "
                      f"{layer:.1f} LUFS in the mix: already at least as present, left as planned")
            else:
                print(f"SFX layer: {m_raw['lufs']:.1f} LUFS as planned; the synthesized layer it replaces sat at "
                      f"{layer:.1f} LUFS in the mix -> the whole SFX bus {match_db:+.1f} dB{limited}, on top of each "
                      f"cue's own level. It keeps the layer's loudness: a gain_db raised on EVERY cue is taken back "
                      f"here (raise some against the others, or --no-match-layer to move the layer itself)")
    limit_wav(raw, sfx_wav, gain_db=match_db)
    raw.unlink(missing_ok=True)
    if nobed_raw is not None and nobed_raw.exists():
        # the same track without the bed: verify.py and critique.py judge the sounds on it (a bed fills every
        # window: the onset of a sound is not clear in it, and a sound the render lost would not be missed)
        if bed_info is not None:
            nobed_wav = Path(f"{stem}_sfx_track_nobed.wav")
            limit_wav(nobed_raw, nobed_wav, gain_db=match_db)
            bed_info["track_nobed"] = str(nobed_wav)
        nobed_raw.unlink(missing_ok=True)
    stem_files = {}
    if a.stems:
        known_ = set().union(*STEMS.values())
        stems_ = dict(STEMS)
        left_ = {p["role"] for p in plans if p["role"] not in known_}
        if left_:                                    # a role no stem knows: its own stem, never silently dropped
            stems_["other"] = left_
        for name, roles in stems_.items():
            sub = [p for p in plans if p["role"] in roles]
            if sub:
                tmp = work / f"{stem.name}__stem_raw.wav"
                render_bus(sub, dur, tmp, work)
                dst = Path(f"{stem}_stem_{name}.wav")
                limit_wav(tmp, dst, gain_db=match_db)
                tmp.unlink(missing_ok=True)
                stem_files[name] = str(dst)
    clips = export_clips(plans, a.export_clips) if a.export_clips else None
    mask_dir = None
    if a.masking:                                    # the processed cues, one by one, for the masking model
        mask_dir = Path(a.export_clips) if a.export_clips else work / f"{stem.name}__maskclips"
        if clips is None:
            export_clips(plans, mask_dir)

    # --- combine with the original audio, master, mux
    final_mix = sfx_wav
    pre = None
    ducked_wav = None
    base_wav, base_gain = None, 0.0
    if base_list and keep:
        base_wav = Path(f"{stem}_base.wav")
        keeps_level = all(it.get("keep_level") for it in base_items)
        base_gain = build_base(base_items, video, has_audio, dur, base_wav, work, match=not keeps_level,
                               duck_under=DUCK_UNDER_VOICE if (a.duck_music or sheet.get("duck_music")) else None)
        bk_ = (sheet.get("_draft") or {}).get("base_kind")
        how_ = {"unbaked": "the synthesized layer was subtracted from the render: its level and ducking are the "
                           "original's",
                "script": "rebuilt from the project's script WITHOUT the effects, levels fitted to the render",
                "stems": "rebuilt from the project's stems"}.get(bk_, "levels kept as given")
        print(f"base audio rebuilt from {len(base_list)} file(s): {', '.join(show_name(b) for b in base_list)} "
              + (f"({how_})" if keeps_level else f"({base_gain:+.1f} dB to match the original)")
              + (", music ducked under speech" if (a.duck_music or sheet.get("duck_music")) else ""))
        if abs(base_gain) > 1.5:
            warns.append(f"the rebuilt base was moved {base_gain:+.1f} dB to match the original's loudness: that "
                         f"moves the voice and music against each other too (only a quiet synthesized layer should "
                         f"have been taken out). Check the stems' levels; --base-audio FILE:GAIN_DB sets them.")
    voice_key = None
    if keep and a.voice_safe and base_wav is not None:
        v_items = voice_items
        if v_items:
            voice_key = work / f"{stem.name}__voice_key.wav"
            build_voice_key(v_items, dur, base_gain, voice_key, work)
            print(f"voice-safe keyed by the speech stem: {', '.join(show_name(it['file']) for it in v_items)} "
                  f"(not by the whole base: music under a phrase ducks nothing)")
    if keep:
        pre = work / f"{stem.name}__mix_pre.wav"
        g = ["[0:a]aformat=sample_rates=48000:channel_layouts=stereo[orig]",
             "[1:a]aformat=sample_rates=48000:channel_layouts=stereo[sfx0]"]
        sfx_lbl, orig_lbl = "sfx0", "orig"
        if a.voice_safe and voice_key is not None:
            g += ["[2:a]aformat=sample_rates=48000:channel_layouts=stereo,highpass=f=250,lowpass=f=3800[vsc]",
                  f"[{sfx_lbl}][vsc]sidechaincompress={VOICE_DEPTH[a.voice_depth]}[sfxv0]",
                  "[sfxv0]asplit=2[sfxv][sfxd]"]
            sfx_lbl = "sfxv"
        elif a.voice_safe:
            g += ["[orig]asplit=2[orig_a][orig_b]",
                  "[orig_b]highpass=f=250,lowpass=f=3800[vsc]",
                  f"[{sfx_lbl}][vsc]sidechaincompress={VOICE_DEPTH[a.voice_depth]}[sfxv0]",
                  "[sfxv0]asplit=2[sfxv][sfxd]"]               # sfxd: the ducked SFX alone, for the speech check
            sfx_lbl, orig_lbl = "sfxv", "orig_a"
        if a.duck:
            g += [f"[{sfx_lbl}]asplit=2[sfx_a][sfx_b]",
                  f"[{orig_lbl}][sfx_b]sidechaincompress=threshold=0.05:ratio=3:attack=10:release=300[origd]"]
            sfx_lbl, orig_lbl = "sfx_a", "origd"
        g.append(f"[{orig_lbl}][{sfx_lbl}]amix=inputs=2:normalize=0:duration=first[mixraw]")
        outs = ["-map", "[mixraw]", "-t", f"{dur:.3f}", "-c:a", "pcm_s24le", "-ar", str(SR), str(pre)]
        if a.voice_safe:
            ducked_wav = Path(f"{stem}_sfx_ducked.wav")
            outs += ["-map", "[sfxd]", "-t", f"{dur:.3f}", "-c:a", "pcm_s24le", "-ar", str(SR), str(ducked_wav)]
        run_ffmpeg(["-i", str(base_wav or video), "-i", str(sfx_wav)] +
                   (["-i", str(voice_key)] if voice_key is not None else []) + ["@@GRAPH@@"] + outs,
                   ";\n".join(g), work)
        final_mix = pre
        if voice_key is not None:
            voice_key.unlink(missing_ok=True)
        if ducked_wav is not None and ducked_wav.exists():
            def _mean_vol(p_):
                r_ = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-nostdin", "-i", str(p_), "-af",
                                     "volumedetect", "-f", "null", "-"], capture_output=True, text=True,
                                    errors="replace")
                m_ = re.search(r"mean_volume:\s*(-?[\d.]+) dB", r_.stderr)
                return float(m_.group(1)) if m_ else None
            vd_, vs_ = _mean_vol(ducked_wav), _mean_vol(sfx_wav)
            if vd_ is not None and vs_ is not None:
                cut_ = vs_ - vd_
                print(f"SFX under speech ({a.voice_depth}): {cut_:.1f} dB off the SFX energy on average over the whole "
                      f"film (mean power, not gated)")
                if cut_ > 9.0:
                    print(f"WARN voice-safe takes {cut_:.0f} dB off the SFX on average ({a.voice_depth}): they may be "
                          f"nearly gone in the mix (UI ticks and typing first); --voice-depth light or normal, "
                          f"or move sounds into the pauses instead")

    target = master_target(a, keep)
    m_pre = measure_loudness(final_mix)
    ceil_note = ""
    bk_ = (sheet.get("_draft") or {}).get("base_kind")
    if keep and video and has_audio:
        m_o = measure_loudness(video)
        orig_lufs_ = m_o.get("lufs")
        if target is None and not a.no_loudnorm and bk_ in ("script", "stems") and orig_lufs_ is not None:
            # the base was rebuilt without the author's makeup gain and limiter: the film is as loud as the original
            target = round(float(orig_lufs_), 1)
            ceil_note = f"target = the original's loudness ({target:g} LUFS): the rebuilt base has lost the author's makeup gain"
        if (not base_list or bk_ in ("script", "stems")) and m_o.get("true_peak") is not None \
                and m_o["true_peak"] > a.ceiling_db:
            # the original's own peak is above the ceiling: turning the whole mix down to meet it would change the
            # author's sound; the ceiling follows the original (it was already that loud)
            a.ceiling_db = min(0.0, round(m_o["true_peak"] + 0.05, 2))
            LIMIT = 10 ** ((a.ceiling_db - 0.7) / 20.0)
            ceil_note = ((ceil_note + "; " if ceil_note else "") +
                         f"the ceiling follows the original's own true peak ({m_o['true_peak']:.1f} dBTP): its "
                         f"sound is not turned down")
    gain = master_gain_db(m_pre, target, a.ceiling_db)
    note = ""

    mix_mp4 = None
    if video and has_video:
        # video stream is copied; if the container refuses it the video is re-encoded once, visibly
        vin = ["-i", video, "-i", str(final_mix)]
        af = master_chain(gain, LIMIT)
        copy_args = ["@@GRAPH@@", "-map", "0:v:0", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k",
                     "-movflags", "+faststart", "-t", f"{dur:.3f}", str(out)]
        try:
            run_ffmpeg(vin + copy_args, af, work)
        except SystemExit:
            warns.append("the video stream could not be copied into this container: re-encoded with x264 CRF 16")
            enc = ["@@GRAPH@@", "-map", "0:v:0", "-map", "[aout]", "-c:v", "libx264", "-crf", "16", "-pix_fmt",
                   "yuv420p", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", "-t", f"{dur:.3f}", str(out)]
            run_ffmpeg(vin + enc, af, work)
        mix_mp4 = out
    elif keep or True:
        mix_wav = Path(f"{stem}_mix.wav")
        run_ffmpeg(["-i", str(final_mix), "-af", f"volume={gain:.2f}dB,alimiter=limit={LIMIT}:level=0:latency=1",
                    "-c:a", "pcm_s24le", "-ar", str(SR), str(mix_wav)])
    m_sfx = measure_loudness(sfx_wav)
    m_fin = measure_loudness(mix_mp4 if mix_mp4 else Path(f"{stem}_mix.wav"))
    # AAC (and a sample-peak limiter) can overshoot: the promise is -1 dBTP on the FILE.
    # An overshoot is usually ONE frame the encoder threw 2-4 dB high (a limiter in front of it cannot see that, and
    # lowering the whole ceiling moves it around instead of removing it): it is repaired where it is, with a dip of
    # ~0.1 s that is as deep as it overshoots. Only when it is everywhere does the whole ceiling come down.
    dips, local_n, tp_pulls = [], 0, 0
    for _ in range(6):
        tpk = m_fin.get("true_peak")
        if mix_mp4 is None or tpk is None or tpk <= a.ceiling_db:
            break
        events = peak_events(mix_mp4, a.ceiling_db - 0.1) if tp_pulls == 0 and local_n < 3 else []
        if events:
            need = [(t_, pk_ - (a.ceiling_db - 0.3)) for t_, pk_ in events]
            fresh = [n_ for n_ in need if not any(abs(d_[0] - n_[0]) < 0.15 for d_ in dips)]
            if max(n_[1] for n_ in need) > DIP_MAX_DB or len(dips) + len(fresh) > DIP_MAX_N:
                events = []
        if events:
            for t_, depth in need:
                near = next((d_ for d_ in dips if abs(d_[0] - t_) < 0.15), None)
                if near:
                    near[1] = min(DIP_MAX_DB, near[1] + depth)
                else:
                    dips.append([t_, depth])
            local_n += 1
        elif tp_pulls < 2:
            # everywhere: a heavily limited mix does not get quieter at its peaks when the gain drops, the limiter's
            # own ceiling has to come down by what the encoder added
            LIMIT = LIMIT * 10 ** (-(tpk - (a.ceiling_db - 0.3)) / 20.0)
            tp_pulls += 1
        else:
            break
        run_ffmpeg(vin + copy_args, master_chain(gain, LIMIT, dips), work)
        m_fin = measure_loudness(mix_mp4)
    if dips or tp_pulls:
        how = []
        if dips:
            how.append(f"{len(dips)} place(s) of the encoder's own overshoot dipped locally, up to "
                       f"{max(d_[1] for d_ in dips):.1f} dB for {DIP_WIDTH * 1000:.0f} ms ("
                       + ", ".join(f"{d_[0]:.2f}s" for d_ in dips[:6]) + (" ..." if len(dips) > 6 else "") + ")")
        if tp_pulls:
            how.append(f"the whole ceiling lowered {tp_pulls} step(s)")
        note = (note + "; " if note else "") + (f"true peak of the file pulled to {m_fin['true_peak']} dBTP "
                                                f"(AAC overshoot: {'; '.join(how)}; gain {gain:+.1f} dB)")
        if m_fin.get("true_peak") is not None and m_fin["true_peak"] > a.ceiling_db + 0.05:
            warns.append(f"the file's true peak is {m_fin['true_peak']} dBTP, above the {a.ceiling_db:g} ceiling: "
                         f"the encoder overshoots here by more than the repair could take (--ceiling-db lower)")
    if ceil_note:
        note = (note + "; " if note else "") + ceil_note
    if orig_lufs_ is not None and m_fin.get("lufs") is not None and target is None and a.voice_safe \
            and m_fin["lufs"] < orig_lufs_ - 1.0:
        note = ((note + "; " if note else "") + f"the original audio is {orig_lufs_:.1f} LUFS and this film "
                f"{m_fin['lufs']:.1f}: --target-lufs {orig_lufs_:.0f} brings it back")
    if target is not None and m_fin.get("lufs") is not None and m_fin["lufs"] < target - 1.0:
        note = ((note + "; " if note else "") + f"target {target:g} LUFS not reached: the file measures "
                f"{m_fin['lufs']:.1f} LUFS (sparse sound; going further would need heavy limiting)")
    if pre is not None:
        pre.unlink(missing_ok=True)
    sfx_in_mix = None
    if abs(gain) >= 0.5:                 # the mix was mastered: the SFX track too, at the same level and ceiling
        sfx_in_mix = Path(f"{stem}_sfx_track_in_mix_level.wav")
        run_ffmpeg(["-i", str(sfx_wav), "-af", f"volume={gain:.2f}dB,alimiter=limit={LIMIT}:level=0:latency=1",
                    "-c:a", "pcm_s24le", "-ar", str(SR), str(sfx_in_mix)])

    # --- records
    resolved = []
    for p in plans:
        c = p["c"]
        fx = ", ".join(x for x in (
            "rev" if c.get("reverse") else "", f"{c['pitch']:+g}st" if c.get("pitch") else "",
            f"fit {c['fit_dur']}s" if c.get("fit_dur") else "", f"hp{c['highpass']}" if c.get("highpass") else "",
            f"lp{c['lowpass']}" if c.get("lowpass") else "", f"loop {c['loop_to']}s" if c.get("loop_to") else "") if x)
        resolved.append({"t": round(p["t"], 4), "label": p["label"], "file": str(p["file"]), "role": p["role"],
                         "anchor": p["anchor"], "gain_db": c.get("gain_db", 0.0), "gain_applied_db": round(p["gain"], 2),
                         "peak_time": round(p["info"]["peak_time"], 3), "peak_db": p["info"].get("peak_db"),
                         "arrive_time": (round(p["info"]["arrival"]["arrive"], 3) if p["anchor"] == "arrive" and p["info"].get("arrival")
                                         else None),
                         "start": round(p["start"], 3),
                         "seg": round(p["seg"], 3), "source": p["source"], "fx": fx, "_layer": p["layer"],
                         "pitch": c.get("pitch", 0) or 0, "slice": c.get("slice"), "slice_of": c.get("_slice_of"),
                         "same_source": bool(c.get("same_source")), "texture": bool(c.get("texture")),
                         "bed": bool(c.get("bed")),
                         **lib_fields(p, by_path),
                         "capped_db": p.get("capped_db", 0.0), "comp_db": p.get("comp_db", 0.0),
                         "peak_after_db": (round(p["info"]["peak_db"] + p["gain"], 1)
                                           if p["info"].get("peak_db") is not None else None),
                         "loud_after_db": (round(p["loud_pre"] + p["gain"], 1) if p.get("loud_pre") is not None
                                           else None),
                         "level_adj_db": p.get("level_adj", 0.0), "onset_shift_ms": round(1000 * p.get("onset_shift", 0.0)),
                         "pan": c.get("pan"), "g_author": c.get("_g"),
                         "mono": c.get("mono"), "tonal": c.get("_tonal"),
                         "snapped_ms": c.get("_snapped_ms")})
    Path(f"{stem}_resolved_cues.json").write_text(json.dumps(
        {"video": video, "duration": dur, "keep_audio": keep, "beats_used": bool(grid), "beat_check": beat_info,
         "original_audio": str(base_wav) if base_wav else video,
         "quiet": sheet.get("quiet"), "bed": bed_info,
         "sfx_track_in_mix_level": str(sfx_in_mix) if sfx_in_mix else None,
         "base_audio": base_list or None, "base_gain_db": round(base_gain, 2) if base_wav else None,
         "flags": {"duck": a.duck, "voice_safe": a.voice_safe, "voice_depth": a.voice_depth,
                   "snap_beats": a.snap_beats, "lead_ms": a.lead_ms},
         "sfx_ducked": str(ducked_wav) if ducked_wav is not None else None,
         "loudness": {"sfx": m_sfx, "final": m_fin, "gain_db": round(gain, 2), "note": note},
         "voice_key": bool(voice_key is not None),
         "voice_stems": [it["file"] for it in voice_items] or None,
         "voice_stem_gain_db": (round(float(voice_items[0].get("gain_db", 0.0)) + base_gain, 2)
                                if voice_items else None),
         "output": str(mix_mp4) if mix_mp4 else None,
         "_draft": sheet.get("_draft"),
         "cues": resolved}, ensure_ascii=False, indent=1), encoding="utf-8")

    lines = [f"# SFX cue report: {out.name}", "",
             f"video {dur:.2f}s, original audio {'kept' if keep else 'none'}"
             f"{', music ducked under SFX' if keep and a.duck else ''}{', SFX ducked under speech' if keep and a.voice_safe else ''}"
             f"{f', original rebuilt from {len(base_list)} stem(s) without the synthesized layer' if base_wav else ''}"
             f"{f', {snapped} cues snapped to the beat' if snapped else ''}", "",
             f"loudness: SFX track {m_sfx['lufs']} LUFS (true peak {m_sfx['true_peak']} dBTP); final mix "
             f"{m_fin['lufs']} LUFS (true peak {m_fin['true_peak']} dBTP, gain {gain:+.1f} dB)"
             + (f"  <- {note}" if note else ""), "",
             "| t, s | label | role | library | file | anchor | gain dB | peak dBFS | len s |",
             "|---|---|---|---|---|---|---|---|---|"]
    for r in resolved:
        nm = show_name(r["file"]) + (f" [{r['fx']}]" if r["fx"] else "")
        pa = r.get("peak_after_db")
        lib_ = r["library"] + (" (extra)" if r.get("tier") == "extra" else "")
        lines.append(f"| {r['t']:.2f} | {r['label']} | {r['role']} | {lib_} | {nm} | {r['anchor']} | "
                     f"{r['gain_applied_db']:+.1f}{' (capped)' if r.get('capped_db') else ''} | "
                     f"{'' if pa is None else f'{pa:.0f}'} | {r['seg']:.2f} |")
    lib = sum(1 for r in resolved if r["source"] == "library")
    n_main = sum(1 for r in resolved if r["source"] == "library" and r.get("tier") == "main")
    n_extra = sum(1 for r in resolved if r["source"] == "library" and r.get("tier") == "extra")
    lines += ["", f"{lib} library sounds ({n_main} main pack, {n_extra} fallback libraries, {lib - n_main - n_extra} "
                  f"unknown), {len(resolved) - lib} uisfx cues, {len(used)} distinct files."]
    if warns:
        lines += ["", "## Warnings"] + [f"- {w}" for w in warns]
    Path(f"{stem}_cue_report.md").write_text("\n".join(lines), encoding="utf-8")

    mask_lines = []
    if mask_dir is not None:
        orig_ = base_wav if base_wav is not None else (video if keep and has_audio and video else None)
        mj_, mask_lines = run_masking(mask_dir, Path(f"{stem}_resolved_cues.json"), match_db + gain, orig_, gain,
                                      Path(f"{stem}_masking.json"))
        if mj_ is not None:                           # critique.py finds the model's answer through the sheet
            rp_ = Path(f"{stem}_resolved_cues.json")
            d_ = json.loads(rp_.read_text(encoding="utf-8"))
            d_["masking"] = {"file": str(mj_), "summary": json.loads(mj_.read_text(encoding="utf-8")).get("summary")}
            rp_.write_text(json.dumps(d_, ensure_ascii=False, indent=1), encoding="utf-8")
        if not a.export_clips:
            shutil.rmtree(mask_dir, ignore_errors=True)

    print(f"cues: {len(resolved)} ({lib} library, {len(resolved) - lib} uisfx), {len(used)} distinct files"
          f"{f', {snapped} snapped to beat' if snapped else ''}")
    for w in warns:
        print("WARN", w)
    if mix_mp4:
        print("video:", mix_mp4)
    print("sfx track:", sfx_wav, "(before the master gain; for analysis and for stacking under your own mix)")
    if bed_info and bed_info.get("track_nobed"):
        print("sfx track without the bed:", bed_info["track_nobed"],
              "(verify.py and critique.py judge the sounds on it: a bed fills every window)")
    if sfx_in_mix:
        print(f"sfx track at the level it has in the video ({gain:+.1f} dB, limiter): {sfx_in_mix}")
    for k, v in stem_files.items():
        print(f"stem {k}:", v)
    if clips:
        print(f"clips: {len(clips)} in {a.export_clips} (sfx_clips.json, sfx_clips_hyperframes.html)")
    print(f"loudness: sfx {m_sfx['lufs']} LUFS, final {m_fin['lufs']} LUFS, true peak {m_fin['true_peak']} dBTP"
          + (f"  ({note})" if note else ""))
    print("report:", f"{stem}_cue_report.md")
    print("resolved cues:", f"{stem}_resolved_cues.json   (use this one with verify.py, review.py and critique.py)")
    for ln_ in mask_lines:
        print(ln_)


if __name__ == "__main__":
    main()
