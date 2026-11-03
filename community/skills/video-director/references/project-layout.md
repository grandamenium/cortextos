# Project layout

Create this layout at stage 1. Every later stage writes into it.

```
<project>/
  brief.md                  type, format, narration, people, footage, length, viewer,
                            reference videos or from scratch (and any named film or style)
  script.md                 locked lines (and narration), one row per scene
  direction-notes.md        every decision, dated, with exact values
  ideas.md                  the 8+ ideas per key line, what each picture says, the pick
  references/               notes and measured stills from reference films, the one kept
                            reference file, and blind-compare-<version>.md for each comparison
                            (type-check-<version>.md instead for a film built from scratch)
  storyboard/
    frame-kit.js            copied from this skill's assets/
    frames.html             every frame design (from assets/frames-starter.html)
    frames-v0.N/            rendered PNGs for one round
    options-<decision>-v0.N.json / .html
    storyboard-v0.N.json / .html
  motion-spec.md            the motion plan (also written into the storyboard JSON)
  assets/images/            generated stills, with the BRIEF file that made each set,
                            or the user's own photos
  assets/video/             generated clips and any supplied footage, with LEDGER.md
  assets/logos/             official marks, with where each came from
  assets/audio/             music, voiceover, effects, with source and rights
  build/                    the HyperFrames project
  output/                   rendered cuts
  output/build-log.md       one line per render: version, notes answered, what changed
```
