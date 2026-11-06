# Screen recordings: events by region

A screen recording has no event list, and its picture is noisy: a blinking indicator, a caret, the cursor, the
recorder's duplicate frames. Over the whole frame `find_moments.py` calls such noise "the strongest moment", so events are
searched **by region**: each with its own threshold and its own event kind. `suggest_cues.py` on a whole screen recording
does not work (dozens of sounds on blinking indicators).

## 1. Find the regions

```
python scripts/look.py FILM --out work/look                                  # frames + the original sound
python scripts/look.py FILM --at 12.4 --crop x,y,w,h --tile-w 480 --out work/at12.png
python scripts/ui_events.py FILM --out work/ui --grid 6x4 [--from A --to B]  # where the picture is alive
```
The grid prints a "share of time / events" table by cell and **suggests regions** (`--roi area1=x,y,w,h`): neighbouring
cells with events are merged, video and animation (changing almost all the time without events) are dropped. This is a
starting point: refine the box from the frames with `look.py --at ... --crop`. A `--from/--to` window cuts the recording
before the analysis (seconds instead of minutes); on a short window the grid may suggest nothing (this is not an error).
**You set the regions from the frames**: for a chat the grid will suggest the whole feed column (600 events), while what
is needed is the input field as one line (`typing`), the corners with toasts (`popup`), the feed column as `scroll@A-B`,
the tab bar (`click`). `timeline.png` and the cell table help decide where and when.

## 2. Regions and their kinds

```
python scripts/ui_events.py FILM --out work/ui \
   --roi input=x,y,w,h:typing@0-91  --roi toast=x,y,w,h:popup  --roi layers=x,y,w,h:scroll@93-173 \
   --roi dialog=x,y,w,h:toggle@18-22  [--roi play=x,y,w,h:click --roi screen=0,0,W,H:window]
```
| kind | what counts | sound |
|---|---|---|
| `typing` | a pulse per keystroke; caret, spinners, blinking dots are dropped by position; big changes (clearing the field) are not keystrokes | `key` (−30 ms: the picture lags) |
| `popup` | something appeared (a toast, a dialog, a menu); `len` how long it stays | `pop` |
| `toggle` | like `popup`, and **disappearing** is an event too (a dialog closed, an option chosen) | `pop` + a quiet `click` |
| `scroll` | continuous motion, one event per stretch, with a length | `whoosh` |
| `click` | a short local change (a button, a highlight) | `click` |
| `window` | the whole picture changed (ffmpeg scene score); echoes in other regions do not count | `wipe` |

`@A-B` goes anywhere after the box (`box@0-91:typing` and `box:typing@0-91` are the same): the range cuts the recording to
the scene before the analysis, and noise and threshold are taken where the region means something. **Start a typing
range before the first letter**: `NOTE: keys already run at the very start of the range` means typing began earlier (the
first word was eaten, the count is low). Take the typing region along the **line of text**, without the icons on the
right and the panel under the field. `NOTE: something was already showing at the start` means the first change may be a
disappearance and the threshold is inflated by noise: narrow `@A-B` to a few seconds around the event (on a dialog at
18–22 s the threshold missed the opening at 19.17 s, with `@19-20.5` it found it). A third part `:kind:sound` changes the
sound (`toast=...:popup:chime`).

**The kind is chosen by the region's type, not by the picture.** Answer text growing in a `scroll` region gives a
"scroll", scrolling a layer list in a `click` region gives a run of clicks, a player in the chat gives a "scroll": look at
the frames around the events and reassign the kind (`--kind` in from_cues) or replace the run with one layer (a scroll
wheel recording from the library: `search.py --query wheel`, role `click`; a layer with `loop_to`/the event's length).

## 3. What the script cleans up itself and what to check

- events of several regions in the same frame (a redraw) are merged into one; an echo two frames later is removed;
- **timers and spinners**: a run of 6 or more (8 for clicks) evenly spaced pulses in `scroll`/`click` (period
  0.25–2.5 s) is not a scroll and not a click; dropped, times named (`--keep-periodic` keeps them); for typing there is
  `--drop-periodic`;
- **the sound of clips playing in the recording's window** (`native sound`): if the recording's own sound plays rarely
  (up to 40 % of the time) and without speech, events inside its windows are dropped: those moments already have sound
  (`--no-native-gate` turns this off); the window times are printed and stored in `ui_events.json` (`native_windows`);
- **windows** (`window`): an event's scene score is in `NOTE: scene scores ...`; weak ones (< 0.5) are a redraw of one
  window, not a change (`--scene 0.5` keeps the strong ones); the event's loudness follows the score;
- `timeline.png`: one row per region (activity, threshold, events in red); `checkpoints.png`: the input field at several
  places with a keystroke count (`--check 50,60,70,85`, any times). **Count the characters on screen and compare.**
  Fewer keystrokes: the recording was sped up, frames merged keystrokes (the count is a lower bound). More: deletions
  and spaces (keystrokes too), spell-check underlines, icons or another scene inside the region. Animated typing (the
  film draws text at 50 characters a second) gives few pulses: write a stretch by hand
  (`{"t":19.99,"type":"typing","len":0.36,"n":99}`), `from_cues` unfolds it into keystrokes (`--type-rate`, 8–14 a
  second).
- **Look at the events with your own eyes before `from_cues`**: `look.py FILM --moments work/ui/events.json --out
  work/ev.png [--crop x,y,w,h --tile-w 320]` draws the frame BEFORE and AFTER each event (sampled by kind and region). A
  raw list for a 170 s recording holds dozens of false ones (mouse hover, the chat redrawing after Enter, a status timer);
  you see them at once, and the critique will not show them (the sound sits on its event).

## 4. Next

```
python scripts/from_cues.py work/ui/events.json --video FILM --ui library --out work/cues.json
```
The "is this the right render" check is skipped for a list that was itself measured from the picture. `--ui library`:
clicks from the main pack (double-click recordings: the press is the first click, `"slice": "first"` is set
automatically), keys from typing recordings. One mouse, one keyboard and one wheel are marked `same_source` by
themselves: variety is not judged for them. A missing moment (Enter, Space, a missed click): `sheet.py add SHEET --event
key@89.37`.

## 5. What the script cannot see

- **Animation in a window that plays without sound** (silent preview runs in After Effects): there is no sound, but the
  picture carries events. `find_moments.py FILM --roi x,y,w,h --from A --to B` on the player's region gives moments
  (calibrate on bursts of native sound where there is some; `ui_events.py` prints the native sound windows); write the
  events in by hand (`sheet.py add --event` or `--from`). Ask the user whether those windows need sound: they were silent
  in the original too.
- Space, Enter, Backspace, paste rarely exist as separate recordings in a library: they are taken from the general
  keyboard pool.
- "A dialog opened" has no sound of its own: a `pop` from the library.

## 6. Screen recording metrics

The critique counts the hook from the picture's first event (`first_event_t`: the frames are still until then, a sound on
it is a hook of 10), a long layer (the wheel) holds its place while it sounds, a run of keystrokes counts as one event.
`pacing` is not judged for a screen recording (`n/a`): the pace is the person's work, the agent waits for a model's
answer, 10 s of silence in the feed is right. Axes that may fall short with the right sound: `loudness` (BS.1770 gating:
new quiet sounds in the original's silence pull the integrated loudness down while the native sound is untouched; the
critique compares the original's windows and will say it is gating). `--ceiling-db -0.5` if the native sound peaks above
−1 dB: otherwise the master gain moves the native sound.
