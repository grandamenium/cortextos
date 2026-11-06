# real-sfx

A Claude Code skill that sound-designs motion videos with **real** recorded sounds from your own library instead of
generated ones. Claude finds the moments in the picture, picks and processes real recordings, puts them on the exact
frame, keeps your music and voice, and hands you a new MP4 plus a separate SFX track.

## Install

Copy this folder to your Claude Code skills folder and restart Claude Code:

- Windows: `%USERPROFILE%\.claude\skills\real-sfx`
- macOS: `~/.claude/skills/real-sfx`

Or install the `.skill` package from the Claude app (Save skill).

## Needs

- Python 3.9+ and FFmpeg (with ffprobe) in PATH.
  - Windows: `winget install Python.Python.3.12` and `winget install Gyan.FFmpeg`.
  - macOS: `brew install ffmpeg-full` and put it first in PATH (`export PATH="$(brew --prefix ffmpeg-full)/bin:$PATH"`).
    The plain `ffmpeg` formula has no `drawtext` and `rubberband` filters, which the frame sheets and pitch shifts use.
- Node.js only for the optional UI-sound package.

## Add your sounds

The skill ships without a sound library. Tell it where yours lives:

```
python scripts/setup.py scan "D:/Sounds"                     # which folders look like sound libraries
python scripts/setup.py init --library main="D:/Sounds/SFX" --library ui="D:/Sounds/UI" --uisfx --index
python scripts/setup.py check
```

No library yet? `--uisfx` alone gives 78 UI cues (CC0). Free real-recording sources worth checking (read each licence):
Freesound (CC0 filter), Sonniss GDC bundles, Mixkit, Pixabay sound effects.

**Main pack and fallbacks.** A library is `"tier": "main"` (default) or `"tier": "extra"`. Extras are used only where the
main libraries have fewer than three fitting sounds. A sorted pack that carries `catalog.json` / `catalog.csv` (columns
`file`, `type`, `source`, `hit`, `hits_in_source`) gives every sound its type and source recording, which is more
reliable than guessing from file names:

```
python scripts/setup.py add-library montage "D:/Sounds_sorted" --tier main --index
python scripts/setup.py add-library old_packs "D:/Packs" --tier extra --index
python scripts/listen.py tag-index          # meaning tags for the new sounds (needs listen.py install --yes once)
```

## Use

Just ask Claude: *"add sound design to this render"*, *"sound-design my HyperFrames project"*, *"озвучь этот ролик"*.
Under the hood:

```
look.py (see the film)  ->  from_cues.py (the project's event list, or the calls of its synthesizer script)
                            ui_events.py (a screen recording, region by region)
                            from_hyperframes.py (data-start timeline)      ->  suggest_cues.py  ->  (you and Claude edit)
                            find_moments.py (frame analysis)                                           ->  mix.py
                                                          ->  verify.py, review.py, critique.py  (loop until 8+)
```

If the project already writes a typed list of its sound events (`docs/cues.json`: whoosh, wipe, click, key, coins ...),
`from_cues.py` swaps the synthesis for real sounds on the same timestamps and cuts real keystrokes out of your typing
recordings. See `references/typed-cues.md`. If the sound is made by a script (`audio.cjs`: `whoosh(4.2)`,
`click(18.35)`), `from_cues.py PROJECT_FOLDER` records those calls as the list, and the synthesized layer is taken OUT of
the render (the project's `sfx.wav` stem subtracted from its mix, or the score rebuilt from the script without the
effects) so music and voice stay and nothing doubles. See `references/project-audio.md`.

The new sounds are placed at the level the author's own sounds had, event by event (`levels.py`; the critique checks it
as `match`, and checks that the synthesized layer is really gone as `doubling`), pitched sounds are tuned to the notes of
the score under them (`tonal.py`), typing written as clicks goes to the real keyboard, and a sound is placed by its
audible start. The beat grid is checked against the kicks before anything snaps to it (`beats.py --plot` draws it), the
film is checked in mono (a sound whose channels cancel vanishes on a phone speaker; `mix.py` plays its louder channel),
and the critique ends with the five moments to listen to.

For a film whose sound is only SFX, `texture.py` voices the picture's small moves that were left quiet and sit in holes,
and `critique.py --style clean-sfx-refs` sets the film against nine finished SFX reels in numbers (gestures per 10 s, gaps,
level spread, low end, the floor, digital silence): no scores, it says where the film differs, not that it is worse.
`bed.py` puts ONE long, dark, steady real recording under such a film.

Claude cannot hear, so the ears are made of two things. `listen_page.py` makes the one pair of ears there is cheap: a page
of blind A/B versions and of the critique's listen-list moments, one tap per verdict (`serve --lan` reaches a phone).
`maskmodel.py` (`mix.py --masking`, needs the skill's venv) turns the mix into numbers about what the ear would miss.
`taste_test.py` turns the same page into a taste test by category; the answers go to `taste.json` (love is preferred,
never is never taken).

You get: `*_sfx.mp4`, `*_sfx_track.wav` (always), optional stems and per-sound clips, a cue report, a critique
scoreboard. Sounds you dislike: `taste.py ban ID`; the next video starts from your taste.

## What it will not do

It does not synthesize sound, and Claude cannot hear: sounds are chosen by measured character, plain words, spectrogram
pictures and (optionally) YAMNet tags. Listen to the five places its critique lists (`critique.py --listen-out FILE.wav`
cuts them into one file). Details: `references/listening.md`.

## Test

```
python tests/selftest.py        # builds a tiny fixture library, runs the whole pipeline (189 checks, 188 without the skill's venv), ~5 min
```

`tests/resound.py` takes finished videos with a professional sound design, strips all audio, lets a fresh agent sound the
picture from `SKILL.md` alone, and sets the result against the original sound in numbers (`tests/resound.md`).

## Licences

Scripts: MIT. uisfx (bundled mp3): code MIT, sounds CC0. Your own sound libraries keep their own licences; this skill
never copies them anywhere, it only reads them.

Made by Alexander Korbanov at [Clipwing](https://clipwing.pro).
