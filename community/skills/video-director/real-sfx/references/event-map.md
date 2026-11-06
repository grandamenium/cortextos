# What happens on screen → which sound

Roles (`search.py --roles`): whoosh, hit, design, sub_drop, riser, click, ui, pop, chime, typing, water, meme, glitch,
error, data, paper, glass, coin, camera, ambience, foley, scifi, vehicle, cartoon. `design` is screams/sustains/textures
for trailer accents, `meme` is reactions and meme sounds, `pop` bubbles and soft pop-ins, `chime` bells, rings, sparkles,
harp, `typing` keystrokes, `water` drops and splashes. A sound can have several roles; `--role X` finds every sound with
X among its tags, the ones where X is the main role first. A sorted library with a catalog (`catalog.json` /
`catalog.csv`) gets its roles from the catalog's types, other libraries from the words in their file and folder names.

## The map

| Event on screen | kind from find_moments | Source | What to look for |
|---|---|---|---|
| A hard cut, a scene change | cut | library | `whoosh` 0.3–0.8 s (fast), `hit` if the cut is heavy |
| A smooth or long transition | cut + burst | library | `whoosh` 0.8–1.5 s, the peak anchored to the middle of the transition (`anchor: peak`) |
| A big title / logo lands | settle | library, in layers | `hit` + a `sub_drop` under it (−6 dB, `anchor: peak`), at most 2 layers. **A product / UI film: a light bright accent** (`chime`, a ringing short `hit` up to 1.5 s, a ding); `sub_drop` only if the person asks for cinematic lows: a taste test on 2026-10-15 on a cut to a title gave "love" to a music box (as the hit) and "not here" to 5 of 9 sub drops (long ones); a short 1.2 s bass and a bright rumble were loved |
| A build to a reveal (a card grows, a counter speeds up) | onset … settle | library | a `riser` lasting until the moment, `anchor: end` puts its end on t |
| An interface element appeared | onset | uisfx | `open`, `select`, `notification`, `expand`; in a "cinematic" film `ui`/`glass` from the library |
| A click, a button press, the cursor | onset | uisfx or library | uisfx `press`, `toggle-on`; library `click` (mouse clicks, button presses). A mouse click recording is two clicks (press, release, the second louder): `"slice": "first"` or `"anchor": "peak"` |
| Typing text | a run of onsets | library (pieces of typing recordings) | Each key is a separate piece of a real recording (`slice`), 8–14 per second, no more: `from_cues.py` cuts them itself. Live typing from a screen recording: one sound per character, `ui_events.py`. Without an event list: 2–4 sounds per phrase or uisfx `typing` |
| A bubble, a soft appearance, a drop | onset | library | `pop` (plop, bubble), `water` (drops of 0.1–0.7 s as a soft tick) |
| Small plastic, a bead, a clasp | onset | library | an exact recording is rare: `--query lego` (spilling Lego blocks, cut into single hits), `--query plastic`, single `click`s |
| A bouncing ball, a step, an object on the floor | contact | library, **one family** | a dull thud: `--says "thunk\|thump"`, the surface at the end of the name (wood / concrete / carpet); `from_cues.py --one-source thump,pop` |
| Sparkles, magic, a reveal, "restoring" | onset/settle | library | `chime`, `--query magic` / `harp` / `music`; a success "ding": `chime` with the Ding tag |
| A counter, digits, data | burst/onset | library | `data`; uisfx `progress-step` for steps |
| Success, done | settle | uisfx | `success`, `complete`, `achievement`, `reward` |
| An error, a warning | burst | uisfx or library | uisfx `error`, `warning`, `blocked`; library `error` |
| A glitch, interference, VHS | burst | library | `glitch` |
| Paper, a sticker, tape, a page | onset/burst | library | `paper` (seal & peel, textured elements) |
| A flash, a photo | burst | library | `camera` (flash/shutter) |
| Money, a price, a purchase | onset | uisfx or library | uisfx `purchase`, `add-to-cart`; library `coin` |
| A glass ping (a panel or layer turned to glass) | onset | library | `chime` (star, music box ding), kind `glass`; the `glass` role in a library is breaking glass (`shatter`) |
| Contact: a ball on the floor, a step, an object knocking | contact | library, **clean single hits** | `--one-source thump,pop`; `listen.py onsets ID` shows a recording's clean hits; rolling and rubber are rare in libraries |
| The scene's background, a sense of place | no moment | library | `ambience` at −24 dB peak, only if the film has no music |

The full list of uisfx signals: `python scripts/search.py --uisfx`. Looping signals (`loading`, `processing`,
`recording`, `connecting`, `scanning`, `streaming`) sound forever: take them into a film only with `max_dur` and
deliberately.

## Libraries: what to watch for

- **Main and fallback.** One sorted library as `tier: main`; older or rougher packs as `tier: extra`, used only where the
  main library has fewer than three fitting sounds.
- **Long files.** Cinematic packs hold many long (10–40 s) ambiences and whooshes: for one-shots set `--max-dur`.
- **Names lie.** A folder called "transitions" can hold 20–40 ms clicks, not whooshes; a UI pack's "swipe" can be a
  ratchet. Check tags (`search.py --paths`) before trusting a name.
- **Pack files with silence.** Some packs pad files to 1.07 / 2.09 / 3.06 s while the sound inside takes 0.06–0.4 s. The
  index stores `active_dur` (until the decay 40 dB under the peak); picking by length, `fit_dur`, `loop_to` and `words`
  use it, and the mixer cuts off the silent tail. In search results `0.36*` means "the file is longer, the audible part is
  0.36 s".

The index skips preview PNGs, HTML ads and folders named in `skip_dir_names` (`config.json`). Files like `X.wav new` are
deduplicated: they are a re-export of `X`.
