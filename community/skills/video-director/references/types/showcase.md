# Showcase

A visual tour of something built (a web page, an app, a dashboard, an interactive piece) that shows off its best moments with energy and no explanation. No captions, no teaching beats, no narration. When the user asks for a "tour" or a "video of" something they made, this is the default unless they ask for an explainer.

## Confirm in one line

State the type before planning: "visual showcase, no captions" or "explainer with captions". Default to showcase for a tour of something the user built.

## How to make it

- **Show the thing at its native size.** Zoomed crops and pull-backs of a built page read as "so tiny". The strongest result is often a living screenshot: the whole piece at native size, no camera moves, only its own motion.
- **Only the subject's own motion.** Hover states, animations, data updating, scrolling through it. Add nothing the piece doesn't do.
- **Pick the flashy moments** and cut between them with energy; drop anything that needs explaining.
- **No explaining words.** No captions, labels or teaching text.
- **Open and close on the name or logo.** 6 of 8 showcase films studied open on a logo or title card and 8 of 8 end on one, on flat black, white or one brand color. The close may add one short line when it is the viewer's next step: a web address for an agency or portfolio reel, "Out now" for a game. Otherwise the logo alone; never a tagline sentence. For a quick loop of something the user made (a GIF), skip the cards unless the user asks.
- **Format**: keep the format the user set. When unsure between two (square and horizontal), render both from the same capture and let them pick; it's cheap.
- **Loops**: for a LinkedIn GIF, stay under about 5 MB and 400 frames; make the last frame lead back into the first.

## What carries over from the main rules

The continuity rules still apply between moments (something survives each change), and no crossfades. The text rules apply only to the title and end cards. The storyboard stage can be short: one options page showing the candidate moments and the format.

For a GIF loop, verify its exact frame count with `python3 <skill>/scripts/check_delivery.py output/loop.gif --max-frames 400`. A missing frame measurement does not establish compliance.
