#!/usr/bin/env python3
"""Learn a sound-design style from finished reference videos.

  python learn_style.py refs.txt --name my-style            # refs.txt: one video path per line
  python learn_style.py a.mp4 b.mp4 c.mp4 --name punchy
  refs.txt line with an SFX-only stem:   C:/refs/launch.mp4 | C:/refs/launch_sfx_only.wav
  refs.txt line with a picture region:   C:/refs/reel.mp4 | | 0,0.05,1,0.5     (x0,y0,x1,y1 as fractions: a reel with
                                         the After Effects timeline under the animation; stem may stay empty)

Writes styles/<name>.json and prints a readable summary. The file also carries `measures` (median and range over the
references of the numbers `refstyle.py` / `critique.py --style NAME` set a film against: gestures per 10 s, gaps,
level spread, low end, sub bed, loudness). For every reference it measures, from the
finished mix, using the same frame analysis as find_moments.py:
  * how many sound events per 10 s, and how many of them sit on a picture event (cut/burst/onset/settle)
  * where a sound's loudest point lands relative to the picture event (lead_ms; negative = sound first)
  * how often a cut carries a low-end impact (hit + sub layering)
  * hook: is there a sound in the first 2 s; longest silent gap
  * loudness and dynamic range of the whole mix
  * character of the sounds on each kind of picture event (brightness, attack, low-end, noisiness)

Limits, stated honestly: the reference mix contains music, so "sound events" are anything that rises
sharply above the surrounding level: SFX but also music hits. Timing and density are reliable;
"which exact sound it is" is only approximated by its measured character.
"""
import argparse
import json
import math
import statistics
import subprocess
import sys
import array
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import SKILL_DIR, avg_power, character_from_power
from find_moments import probe, visual_moments

RATE = 16000


def decode(video, af=None):
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-i", str(video), "-vn", "-ac", "1", "-ar", str(RATE)]
    if af:
        cmd += ["-af", af]
    r = subprocess.run(cmd + ["-f", "s16le", "-"], capture_output=True)
    a = array.array("h")
    a.frombytes(r.stdout[: len(r.stdout) // 2 * 2])
    return a


def env_db(x, ms=10):
    w = RATE * ms // 1000
    out = []
    for i in range(0, len(x) - w + 1, w):
        e = math.sqrt(sum(v * v for v in x[i:i + w]) / w) / 32768.0
        out.append(20 * math.log10(e) if e > 1e-5 else -100.0)
    return out


def local_base(env, i, back=40, gap=5):
    seg = env[max(0, i - back):max(0, i - gap)]
    return statistics.median(seg) if seg else env[i]


def audio_events(env, lo_env, min_rise=9.0, floor=-48.0):
    """Sharp rises above the recent level. Returns events with the time of their loudest point."""
    ev, last = [], -99
    n = len(env)
    for i in range(6, n - 6):
        if env[i] < floor:
            continue
        rise = env[i] - local_base(env, i)
        if rise < min_rise:
            continue
        window = env[i - 5:i + 6]
        if env[i] < max(window):
            continue                                   # not the local peak
        if i - last < 12:                              # 120 ms spacing
            if ev and env[i] > ev[-1]["level"]:
                ev.pop()
            else:
                continue
        # when did the rise start? walk back until 10 dB below the peak
        j = i
        while j > 0 and env[j] > env[i] - 10 and i - j < 80:
            j -= 1
        lo_rise = lo_env[i] - local_base(lo_env, i) if i < len(lo_env) else 0.0
        ev.append({"i": i, "t": round(i * 0.01, 3), "rise": round(rise, 1), "level": env[i],
                   "build_ms": (i - j) * 10, "lo_rise": round(lo_rise, 1)})
        last = i
    return ev


def median(v, default=None):
    v = [x for x in v if x is not None]
    return round(statistics.median(v), 3) if v else default


def merge_events(hi, lo):
    """Combine high-band and low-band events; a sound with both is an impact with air on top."""
    out = []
    for e in hi:
        out.append(dict(e, band="hi"))
    for e in lo:
        mate = next((o for o in out if abs(o["t"] - e["t"]) <= 0.06), None)
        if mate:
            mate["band"] = "both"
            mate["lo_rise"] = e["rise"]
        else:
            out.append(dict(e, band="lo", lo_rise=e["rise"]))
    for e in out:
        e.setdefault("lo_rise", 0.0)
    return sorted(out, key=lambda e: e["t"])


BANDS = (("sub", 20, 120), ("low", 120, 400), ("mid", 400, 2000), ("high", 2000, 7500))


def band_db(power, n=1024, rate=16000):
    hz = rate / n
    return {name: 10 * math.log10(sum(p for k, p in enumerate(power) if lo <= k * hz < hi) + 1e-6)
            for name, lo, hi in BANDS}


def added_character(full, t):
    """What the event adds, per frequency band, in dB above the sound just before it.
    The music keeps playing under the event, so a band that did not change shows ~0 dB and the
    bands that jump are the sound effect: sub +15 = impact, high +10 = air/whoosh/click."""
    bg = avg_power(full[max(0, int((t - 0.7) * RATE)):max(0, int((t - 0.15) * RATE))])
    ev = avg_power(full[max(0, int((t - 0.05) * RATE)):int((t + 0.40) * RATE)])
    if not bg or not ev:
        return None
    b0, b1 = band_db(bg), band_db(ev)
    # against silence (an SFX-only stem) the difference is meaningless and huge: cap it
    return {f"d_{k}": round(max(-40.0, min(40.0, b1[k] - b0[k])), 1) for k in b0}


def analyse(video, stem=None, roi=None):
    """stem: an audio file with ONLY the sound effects (no music) for this video; far more reliable.
    roi: (x0, y0, x1, y1) as fractions of the picture: look only there (a reel with the After Effects timeline under
    the animation: the timeline's own movement is not a picture event). Cuts are not searched inside a region."""
    info = probe(video)
    dur = info["duration"]
    roi_px = None
    if roi:
        w_, h_ = info["width"], info["height"]
        x0, y0, x1, y1 = roi
        roi_px = (int(x0 * w_) // 2 * 2, int(y0 * h_) // 2 * 2, max(2, int((x1 - x0) * w_) // 2 * 2),
                  max(2, int((y1 - y0) * h_) // 2 * 2))
    moments, act = visual_moments(video, max_other=60, roi=roi_px)
    src = stem or video
    full = decode(src)
    hi_env = env_db(decode(src, "highpass=f=400"))
    lo_env = env_db(decode(src, "lowpass=f=150"))
    ev = merge_events(audio_events(hi_env, lo_env, min_rise=9.0, floor=-55.0),
                      audio_events(lo_env, lo_env, min_rise=10.0, floor=-45.0))

    rows, used = [], set()
    for m in moments:
        best = None
        for k, e in enumerate(ev):
            d = (e["t"] - m["t"]) * 1000
            if -200 <= d <= 200 and (best is None or abs(d) < abs(best[0])):
                best = (d, k)
        row = {"t": m["t"], "kind": m["kind"], "strength": m["strength"], "matched": best is not None}
        if best:
            d, k = best
            e = ev[k]
            used.add(k)
            row.update({"lead_ms": round(d), "band": e["band"], "rise": e["rise"], "build_ms": e["build_ms"]})
            ch = added_character(full, e["t"])
            if ch:
                row.update(ch)
        rows.append(row)

    # chance level: how often a sound peak sits within +-200 ms of a picture event that is NOT there
    etimes = [e["t"] for e in ev]

    def hit(t):
        return any(abs(x - t) <= 0.2 for x in etimes)
    shifts = (-1.1, -0.6, 0.6, 1.1)
    chance_n = chance_hit = 0
    for m in moments:
        for sh in shifts:
            t2 = m["t"] + sh
            if 0.2 < t2 < dur - 0.2:
                chance_n += 1
                chance_hit += hit(t2)

    times = [e["t"] for e in ev]
    gaps = [b - a for a, b in zip([0.0] + times, times + [dur])]
    sec = [20 * math.log10(max(1e-5, math.sqrt(sum(v * v for v in full[i:i + RATE]) / RATE) / 32768)) for i in
           range(0, max(1, len(full) - RATE), RATE)]
    sec = [x for x in sec if x > -60]
    per10 = lambda n: round(n / dur * 10, 2)

    def rate(sel):
        r = [x for x in rows if sel(x)]
        return (round(sum(1 for x in r if x["matched"]) / len(r), 2), len(r)) if r else (None, 0)

    # the numbers `critique.py --style` and `refstyle.py` compare a film with (same code on both sides)
    measures = {}
    try:
        import refstyle
        from common import measure_loudness
        measures = refstyle.measure(src, lufs=measure_loudness(video).get("lufs"))
    except Exception as ex:                       # the older numbers above are still worth keeping
        print(f"   measures failed: {ex}", file=sys.stderr)

    return {
        "video": str(video), "duration": round(dur, 1), "w": info["width"], "h": info["height"],
        "roi": list(roi) if roi else None, "measures": measures,
        "visual_per10": per10(len(moments)), "events_per10": per10(len(ev)),
        "synced_per10": per10(len(used)), "free_events_per10": per10(len(ev) - len(used)),
        "hook": any(t <= 2.0 for t in times), "first_event_s": times[0] if times else None,
        "max_gap_s": round(max(gaps), 1), "median_gap_s": round(statistics.median(gaps), 2),
        "mean_db": round(statistics.mean(sec), 1) if sec else None,
        "dyn_range_db": round(sorted(sec)[int(0.9 * (len(sec) - 1))] - sorted(sec)[int(0.1 * (len(sec) - 1))], 1) if len(sec) > 3 else None,
        "band_mix": {b: sum(1 for e in ev if e["band"] == b) for b in ("hi", "lo", "both")},
        "motion_activity": round(act, 2), "chance_hits": chance_hit, "chance_n": chance_n, "rows": rows,
        "stem": str(stem) if stem else None,
    }


def aggregate(per_ref):
    out = {}
    for key in ("visual_per10", "events_per10", "synced_per10", "free_events_per10", "max_gap_s", "median_gap_s",
                "mean_db", "dyn_range_db"):
        out[key] = median([r[key] for r in per_ref])
    out["hook_rate"] = round(sum(1 for r in per_ref if r["hook"]) / len(per_ref), 2)
    # pool all picture events so strong ones are judged over hundreds of samples, not over 13 medians
    rows = [x for r in per_ref for x in r["rows"]]
    out["n_picture_events"] = len(rows)
    cn, ch = sum(r["chance_n"] for r in per_ref), sum(r["chance_hits"] for r in per_ref)
    obs = sum(1 for x in rows if x["matched"]) / max(1, len(rows))
    out["chance_rate"] = round(ch / cn, 2) if cn else None
    out["observed_rate"] = round(obs, 2)
    # share of picture events that really carry their own sound = (obs - chance) / (1 - chance)
    out["lift_rate"] = round(max(0.0, (obs - out["chance_rate"]) / (1 - out["chance_rate"])), 2) if cn else None
    sb = {}
    for name, lo, hi in (("weak<0.4", 0, 0.4), ("mid", 0.4, 0.7), ("strong>=0.7", 0.7, 1.01)):
        r = [x for x in rows if lo <= x["strength"] < hi]
        sb[name] = {"n": len(r), "sync_rate": round(sum(x["matched"] for x in r) / len(r), 2) if r else None}
    out["sync_by_strength"] = sb
    kinds = {}
    for k in ("cut", "burst", "onset", "settle"):
        r = [x for x in rows if x["kind"] == k]
        got = [x for x in r if x["matched"]]
        if not r:
            continue
        strong = [x for x in r if x["strength"] >= 0.7]
        leads = [x["lead_ms"] for x in got]
        kinds[k] = {
            "n": len(r), "sync_rate": round(len(got) / len(r), 2),
            "strong_sync_rate": round(sum(x["matched"] for x in strong) / len(strong), 2) if strong else None,
            "lead_ms": median(leads),
            "lead_p25": round(statistics.quantiles(leads, n=4)[0]) if len(leads) >= 4 else None,
            "lead_p75": round(statistics.quantiles(leads, n=4)[2]) if len(leads) >= 4 else None,
            "lo_share": round(sum(1 for x in got if x["band"] in ("lo", "both")) / len(got), 2) if got else None,
            "d_sub": median([x.get("d_sub") for x in got]), "d_low": median([x.get("d_low") for x in got]),
            "d_mid": median([x.get("d_mid") for x in got]), "d_high": median([x.get("d_high") for x in got]),
            "build_ms": median([x["build_ms"] for x in got]),
            "within60": round(sum(1 for l in leads if abs(l) <= 60) / len(leads), 2) if leads else None,
        }
    out["kinds"] = kinds
    bands = {"hi": 0, "lo": 0, "both": 0}
    for r in per_ref:
        for b in bands:
            bands[b] += r["band_mix"][b]
    out["band_mix"] = bands
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("videos", nargs="+", help="video files, or one text file with a path per line")
    ap.add_argument("--name", required=True)
    a = ap.parse_args()

    paths = []
    for v in a.videos:
        p = Path(v)
        if p.suffix.lower() in (".txt", ".list"):
            paths += [l.strip() for l in p.read_text(encoding="utf-8-sig").splitlines()     # a PowerShell BOM is fine
                      if l.strip() and not l.strip().startswith("#")]
        else:
            paths.append(v)
    per_ref = []
    for i, line in enumerate(paths, 1):
        # "video.mp4 | sfx_only.wav | 0,0.05,1,0.5": the stem and the picture region (fractions x0,y0,x1,y1) are optional
        parts = [x.strip() for x in line.split("|")]
        p, stem = parts[0], (parts[1] if len(parts) > 1 else "")
        roi = None
        if len(parts) > 2 and parts[2]:
            try:
                roi = tuple(float(v) for v in parts[2].split(","))
                if len(roi) != 4 or not (0 <= roi[0] < roi[2] <= 1 and 0 <= roi[1] < roi[3] <= 1):
                    raise ValueError
                if roi == (0.0, 0.0, 1.0, 1.0):
                    roi = None                        # the whole picture: cuts are searched as usual
            except ValueError:
                print(f"skip (region must be x0,y0,x1,y1 as fractions): {line}", file=sys.stderr)
                continue
        if not Path(p).exists() or (stem and not Path(stem).exists()):
            print(f"skip (missing): {line}", file=sys.stderr)
            continue
        print(f"[{i}/{len(paths)}] {Path(p).name[:70]}{'  (with SFX stem)' if stem else ''}"
              f"{'  (region ' + str(roi) + ')' if roi else ''}", flush=True)
        try:
            per_ref.append(analyse(p, stem or None, roi))
        except Exception as ex:                       # one broken file must not lose the others
            print(f"   failed: {ex}", file=sys.stderr)
    if not per_ref:
        sys.exit("no reference could be analysed")

    style = {"name": a.name, "n_refs": len(per_ref), "profile": aggregate(per_ref), "per_ref": per_ref}
    try:
        import refstyle
        style["measures"] = refstyle.aggregate([r.get("measures") or {} for r in per_ref])
        n_stem = sum(1 for r in per_ref if r.get("stem"))
        style["basis"] = ("SFX-only stems" if n_stem == len(per_ref) else "finished mix of each video" if not n_stem
                          else f"{n_stem} SFX-only stems, the rest finished mixes")
        style["note"] = ("The references' own music, if any, is part of what was measured; a film that keeps its own "
                         "music and voice is not meant to match a reel that is only sound design.")
    except Exception as ex:
        print(f"measures not aggregated: {ex}", file=sys.stderr)
    stems = [r for r in per_ref if r.get("stem")]
    if stems:
        # references that came with an SFX-only stem give clean numbers: keep them apart from the music-masked ones
        style["profile_stems"] = aggregate(stems)
    out_dir = SKILL_DIR / "styles"
    out_dir.mkdir(exist_ok=True)
    out = out_dir / f"{a.name}.json"
    out.write_text(json.dumps(style, ensure_ascii=False, indent=1), encoding="utf-8")

    P = style["profile"]
    print(f"\nstyle '{a.name}' from {len(per_ref)} references, {P['n_picture_events']} picture events -> {out}")
    print(f"  sound events per 10 s: {P['events_per10']}  (on a picture event: {P['synced_per10']}, free/music: {P['free_events_per10']})")
    print(f"  picture events per 10 s: {P['visual_per10']}   hook in first 2 s: {int(P['hook_rate'] * 100)}%   "
          f"median gap: {P['median_gap_s']} s, longest: {P['max_gap_s']} s")
    print(f"  loudness: mean {P['mean_db']} dB, dynamic range {P['dyn_range_db']} dB")
    print(f"  picture events with a sound peak within +-200 ms: {int(P['observed_rate'] * 100)}%   by chance alone: "
          f"{int((P['chance_rate'] or 0) * 100)}%   => really sounded: ~{int((P['lift_rate'] or 0) * 100)}%")
    print("  by event strength: " +
          ", ".join(f"{k} {int((v['sync_rate'] or 0) * 100)}% (n={v['n']})" for k, v in P["sync_by_strength"].items()))
    print(f"  sound bands: high-only {P['band_mix']['hi']}, low-only {P['band_mix']['lo']}, both {P['band_mix']['both']}")
    if style.get("measures"):
        print("  measures for critique.py --style (median, range):")
        for k, v in style["measures"].items():
            print(f"    {k:10s} {v['median']:8.2f}   {v['min']} .. {v['max']}   (n={v['n']})")
    for k, v in P["kinds"].items():
        ss = v["strong_sync_rate"]
        print(f"  {k:7s} n={v['n']:4d} matched {int(v['sync_rate'] * 100):3d}% (strong {int(ss * 100) if ss is not None else '-'}%)  "
              f"lead {v['lead_ms']} ms, within 60 ms: {int((v['within60'] or 0) * 100)}%  low-end {int((v['lo_share'] or 0) * 100)}%  "
              f"added dB: sub {v['d_sub']:+.0f} low {v['d_low']:+.0f} mid {v['d_mid']:+.0f} high {v['d_high']:+.0f}"
              if v["d_sub"] is not None else f"  {k:7s} n={v['n']:4d} matched {int(v['sync_rate'] * 100):3d}%")


if __name__ == "__main__":
    main()
