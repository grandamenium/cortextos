# Before you show anything

For every page or render you send, go through each frame and confirm, in writing to yourself:

1. Cards, sidebars, accent borders or "headline left, product right"? Fix.
2. From stage 8: render check findings fixed or recorded as exceptions with a reason; every motion strip opened.
3. The type's numbers: text position, safe area, scene length, close.
4. What carries into the next shot?
5. Logo: does each use have a job?
6. People (if used): named people have faces; the cast is diverse; nothing reads as stock.
7. All text readable at phone size; nothing in the picture reads like script.
8. Colors come from the brand, each with a job.
9. Each picture says its line before it is read, and one drawing style holds across every frame.
10. Renders: the scenes covered and every placeholder are listed first; in a film with people shown as footage, no person's action is a still with a push.
11. Renders: every cut strip opened; the motion watch's findings confirmed or dismissed in frames, or the render reported as "not watched in motion". A clean watch is not reported as proof.
12. Renders of films with a click, press or touch inside a shot: every action strip opened and every pointer check passing (`action_frames.py`), with an action listed for each one in the motion spec. Films with none: `actions.json` is `[]` and the report says so.
13. Films with generated clips of recurring people, places or props: every continuity sheet opened and `continuity_sheet.py --verify` passing (a `same:` or `accepted:` line for every recurring prop and garment).
14. Films with effects or voice: `sound_balance.py` run on the stems; each flag fixed or put to the user with its number; the labeled events' numbers listed for the user to listen for.
15. Films with library effects: every effect in `build/audio/sound-plan.json`, made by Sound engineering (`sound-stage.md`); `sound_handoff.py collect` run on this render's resolved cues, each REVIEW line fixed or put to the user; `verify.py` with no sound off its moment; every pick checked against its moment at `mix.py --plan`, and the user's approved picks written into the plan.
16. Films with sound: made by the path chosen in `sound-stage.md`; every sound and music file has its row in `assets/audio/SOURCES.md`; no downloaded sound file is in a public repository; generated clip sound checked with speech-to-text, or reported as not checked; music pieces stretched 3% or less, with every cut checked against bar lines the user confirmed from the clicks file (`fit_music.py --bars`); `check_sources.py assets/audio` passing.
17. Renders: a phone copy under 30 MB beside the full file (`check_delivery.py --max-mb 30`), so the user can review on a phone.
18. Renders: the fresh read done by a new agent and its worst problems fixed, or the build log saying it was skipped and why (and the user told).

Then tell the user, in plain language: what changed since the last version, what you could not do or check, and the open questions. Put questions for the user at the bottom of the page as well.
