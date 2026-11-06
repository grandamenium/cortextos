# The blind "resound" test (`tests/resound.py`)

The selftest (`selftest.py`) answers "did anything break". This test answers another question: **"which sound does the
skill put in when nobody tells it"**. Finished films with good sound are taken, all their audio is removed, a fresh agent
voices the picture from `SKILL.md` alone, and then both sounds, the real one and the skill's, are measured by the same
code and set side by side. In round 1 this found what all four agents named independently (no recipe for silent animation
without a list, three different "density norms", nine code bugs), which the selftest cannot see: it checks what we
already know how to check.

Run it when what decides WHICH sound lands changes: sound choice, density, the bed, the small-sound layer, the critique,
the docs of the "Find the moments" step. For an edit that does not change the script's decisions, the selftest is enough.

## What is needed

- Python 3 and ffmpeg, like the rest of the skill. numpy is not needed. Pillow (if present) draws the pictures.
- A list of references in the `learn_style.py` format: one line per film, `path | | x0,y0,x1,y1` when the animation is only
  part of the frame (a reel with an After Effects timeline under the animation: the timeline shows the sound clips, which
  leaks the answer, so it is cut out).
- A learned style `styles/clean-sfx-refs.json` (`learn_style.py LIST --name clean-sfx-refs`): a copy of the references
  WITHOUT the film under test is made from it, otherwise the agent would see its own numbers in `critique.py --style`.
- Fresh agents: one per film, in Claude Code an `Agent` with the text from `prompt`. The script does not launch agents.

## Steps

```
python tests/resound.py prepare  ROOT --refs refs.txt [--n 4] [--seed N]   # n random films, a silent crop, the truth kept apart
python tests/resound.py snapshot ROOT                                     # a hash of the skill folder BEFORE the agents
python tests/resound.py prompt   ROOT [--run run1] [--reel reel_a]        # the text for an agent; one per film
#   ... agents work in ROOT/run1/reel_a/{work,result}, result ROOT/run1/reel_a/result/reel_a_sfx.mp4 ...
python tests/resound.py eval     ROOT [--run run1] [--out eval1]          # numbers, A/B pairs, REPORT.md, pictures
python tests/resound.py check    ROOT                                     # the skill folder is untouched
```

`prepare` writes `inputs/reel_a.mp4` (the animation only, **with no audio track at all**), `truth/reel_a_original.mp4`
(the same frame with the original sound, for listening) and a `.wav` (for measuring), `truth/mapping.json` (seed, source,
frame, `style_dir`) and `styles/reel_a/clean-sfx-refs.json`. The agents get only `inputs/`.

What the agent does is defined by `prompt`: read `SKILL.md` and go through the whole process up to and including the
critique (all axes 8+, at least three rounds), in its film's `work` and `result`, without looking into `truth/`, the folders
the originals came from, or other runs; set `REAL_SFX_STYLES` to the copy of the references without its own film before
running scripts (a folder with that name in the environment beats `styles/` and `references/profiles/`); change nothing in
the skill folder; synthesize nothing. At the end return as text: rounds and final axes, time and number of calls, how many
sounds from which libraries, a list of what is wrong or missing in the skill (a code defect with a reproduction, a gap in
the docs, what is lacking), naming the file or step. Agents cannot always write report files: a person puts the text into
`REPORT.md` (section 7).

## How to read `REPORT.md`

1. **What came out**: sounds, distinct files, by library, **synthesized** (should be 0), whether there is a bed, final
   loudness, the skill critique's lowest axis.
2. **The same measurements for the original and the skill** (`original \| skill`) and the median of the other references
   (those not in the test): gestures per 10 s, pauses between gestures (median, P90, longest), the spread of levels, the
   typical gesture against the loudest, the first sound, the share of gestures with lows, the 30–100 Hz bed, the quietest
   tenth under the loudest, digital silence, loudness. The same code on both sides: a difference is a difference in the
   SOUND, not in the ruler.
3. **Timing agreement**: the share of the original's gestures that have a skill gesture within ±100 ms and, in brackets,
   **the same share by chance** (the skill's sound shifted by 0.35…1.3 s). Read the difference from chance, not the number
   itself: in dense films chance is 20–30 % and the test is weak. A gesture's time is the **start** of its loudest sound
   (when it came within 10 dB of the peak): a designer puts the start on the picture, and a whoosh's peak lands wherever
   its length carries it. Next to it, the same by the loudest point. The correlation of the loudness shape over time
   (250 ms) with the same chance baseline.
4. **Presence and silence**: the median, P10 and the share of digital silence of the 250 ms envelope.
5. **Tonal balance**: the share of energy by band, original and skill.
6. **The picture as a support**: how many picture moves each sound voiced.
7. **What the agents found** (by hand from their reports). Reproduce each claim first, then fix.
8. **What the test does not tell you.**

`listen/reel_a_A_original.mp4` (A = original) and `reel_a_B_skill.mp4` (B = skill): one frame, only the sound differs.
**The ear decides**; the numbers show where the sounds differ, not which is better. The script cannot listen. Listening
blind is easier: `eval` builds a `listen_page/` page (original and skill under 1 and 2 in random order, a one-tap verdict),
`python scripts/listen_page.py serve OUT/listen_page`, then `results` unblinds where the original was and who won.

## Traps (all caught in round 1)

- Leaking the answer: an After Effects timeline under the animation (cut out with a region), a reference profile with film
  names (`references/profiles` is anonymous, `styles/` with names is not installed with the skill), the film's own numbers
  in `--style` (a copy without it via `REAL_SFX_STYLES`).
- Dense sounds on both sides: chance agreement is 20–30 %, a difference of 5–10 points is noise. Several rounds with
  different seeds are more reliable than one.
- The originals are showcases, often with a musical or tonal bed (by YAMNet 77–88 % "music/synth" in three of four): "no
  bed" in the skill is a difference in the task, not necessarily a mistake.
- The first conclusion "the original is systematically later than the picture" (cross-correlation) was NOT confirmed by
  the nearest-burst method (median −27…+14 ms). Do not claim a systematic offset without a second method.
- Numbers from two versions of the test cannot be compared if the detector changed (`refstyle.py`): rerun `eval` on the
  same `run` before comparing rounds.

## Round 1 (skill 0.12.0, seed 635056751), as an example of reading

Four films (13.1 / 10.7 / 67.5 / 13.0 s), four agents, 30–52 minutes and 144–182 calls each; all passed the skill's
critique (axes 8.2+), `--ui library`, no synthesis. Gestures per 10 s: originals 11.4 / 12.2 / 15.1 / 6.9, skill 12.9 /
10.3 / 10.5 / 9.2. Agreement by starts within ±100 ms: 53 % (chance 26), 8 (31), 24 (20), 22 (22): above chance in one
film of four. Digital silence in the originals 0 / 20 / 0 / 0 %, in the skill 22 / 5 / 9 / 4 %. This led to 0.12.1
(defects, silent animation without a list, one density) and 0.13.0 (the bed).
