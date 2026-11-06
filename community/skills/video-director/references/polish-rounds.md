# Polish rounds

After the full build, the film improves through rounds of notes, usually written against timestamps ("0:47 the call feels late", "the text at 1:02 stops"). Most mistakes in this stage come from changing the wrong thing, so every note is located in the frames before anything is edited.

## 1. Read each note against the frames

For every note with a time in it:

1. Pull frames at that time, 1 s either side:
   ```bash
   ffmpeg -v error -ss <t-1> -t 2 -i output/cut-vN.mp4 -vf fps=8 output/notes-vN/<t>-%02d.png
   ```
2. Say back the moment by what is on screen, not by its time alone: "at 0:47, the share sheet closes and the client's approval arrives". Then say what you will change.
3. When a word in the note could mean a line of text or an object on screen, say which one you took it to mean. "Call" can be the word "call" in a line or a person's "calling" chip; "1" can be option 1 or look A. Times can also be off by a second or two, so match the note to the nearest moment that fits it.
4. If the frames don't show what the note describes, ask in one line before changing anything.

Answer every note in a numbered list, in the user's order, before rendering again.

## 2. Show design changes as stills first

A note that changes how something looks (a new end card, a different ground, a new layout for a scene) gets 2-3 labeled stills beside the current frame before anything is built: "Now", "A", "B". Recommend one in a sentence. Build only after the user picks. Timing-only fixes skip this.

## 3. One render per round

- Each round produces one new render with the next version number (`output/cut-v17.mp4`); never overwrite an earlier one.
- Make a phone copy the user can open anywhere, under 30 MB:
  ```bash
  ffmpeg -v error -i output/cut-v17.mp4 -c:v libx264 -crf 25 -preset slow -c:a aac -b:a 128k -movflags +faststart output/cut-v17-phone.mp4
  ```
  Raise the crf by 2 and run it again if the file is still over 30 MB.
- Add one line to the project's build log: the version, the notes it answers, and what changed. For a film with library effects, add the sound line from `sound_handoff.py collect` (planned, placed, quiet, unplanned) and which picks the user chose; if the picture moved, Sound engineering ran again from step 2.
- Every round runs the same checks before the render goes out (`build-and-qa.md`): the render check, cut strips, action strips at every click, press or touch inside a shot (films that have them), the continuity sheets with a verdict per item (films with generated clips of recurring people, places or props), sound balance from the stems (films with effects or voice), the fresh read, and the motion watch when allowed. A note that touched one scene doesn't make the others safe: a remade clip can change a prop, a retime can move a pointer off its target, a level change can bury another effect. Report the watch as watched (with the frame rate it used) or "not watched in motion", and never as proof the cut is clean.
- When the user finds a problem by eye that the checks passed, add the moment to `build/actions.json` or the item to `build/continuity.json` (or the sound to `build/audio/events.json`) so every later round checks it.

## 4. When a check disagrees with a user choice

The render check, a slop check or a fresh-eyes review will sometimes flag something the user chose on purpose (a long hold, a line kept on screen longer, a color they asked for). Don't undo it quietly. List it under "your call", with the rule, the measured number and what the user chose. If the rule itself looks too strict for this kind of film, compare it with 3 or more strong reference films of the same type before changing anything, and report what they do. For a film built from scratch, ask the user before studying films; otherwise check the rule against the type file's numbers.

## 5. Choppiness the check didn't catch

When the user still sees choppy motion after the render check passes, find the cause before changing timing:

1. Look for repeated frames around the time the user named. This lists the frames that differ from the one before:
   ```bash
   ffmpeg -v info -ss <t-2> -t 4 -i output/cut-vN.mp4 -vf mpdecimate,showinfo -f null - 2>&1 | grep -o "pts_time:[0-9.]*"
   ```
   The times are counted from `<t-2>`. A gap of more than one frame between listed times while something should be moving means the render repeated frames there. Gaps during a hold are expected.
2. Pull 8 fps strips at the time the user named (section 1) and look at every frame. If a key is set up, run `watch_cut.py` on a short clip around that time and compare its findings with the strips.
3. Compare the render with the composition's own snapshot at the same frame (`npx hyperframes snapshot`). If they differ, something set earlier in the timeline has stayed applied in the render (a crop, a mask, a transform). Fix that state, not the timing. If they match, the move itself is the problem: see the motion findings table in `build-and-qa.md`.

## 6. An ideas pass every third round

Rounds that only answer notes make a film smoother, not stronger. A long run of rounds can pass without one new idea, while the strongest missing idea (a counter that proves a claim, a camera move through the real interface) sits in a strong film of the same type.

After every third round, and before calling a cut final:

1. Go through the script line by line and run the beat method in `visual-ideas.md` on each: at least 8 ideas for the key lines, then the two checks. Include moves seen in the reference films, if any were studied.
2. Pick the best one to three ideas. Show each as stills beside the current frame ("Now", "A", "B", as in section 2), with one sentence on what it would add.
3. Build nothing until the user picks. If the user says no to all of them, record that in `direction-notes.md` and carry on with notes.

Verify the phone copy with `python3 <skill>/scripts/check_delivery.py output/cut-vN-phone.mp4 --max-mb 30` before sending it. For a GIF with a 400-frame limit, add `--max-frames 400`; missing ffprobe coverage is a hold.
