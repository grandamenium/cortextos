# How the skill "hears" sound

The honest baseline: in this environment the model has no audio input. Files, pictures and PDFs are read, sound is not.
So "hearing" here means ways to turn sound into something readable: numbers, words, pictures, classifier tags, or the
report of another model that does perceive sound.

## Levels

| Level | What it gives | Cost | Status |
|---|---|---|---|
| 0. Numbers | attack, tail, brightness, share of lows, noisiness, pulsing, peak, duration | none | always works |
| 1. Words and pictures | `words` (punchy, dark, heavy, long-tail, pulsing…), `--says`, `contact_sheet.py`, `review.py`: waveform + spectrogram for the model to look at | none | always works |
| 2. Tags and meaning | YAMNet: 521 AudioSet classes for every second (Whoosh, Explosion, Click, Glass, Typing…) and a 1024-number vector for "find a similar one by meaning" | ~45 MB, CPU, its own venv | optional: `listen.py install --yes` (on the author's machine: 31 s to install, ~4 min to tag 1,627 sounds) |
| 3. An external "listener" | Gemini (or another model with audio input) describes and critiques the sound in words | an API key, the audio leaves the machine | optional, see below |

### How to read a spectrogram (level 1)
Time to the right, pitch up, brightness is energy.
- a bright spot at the bottom: sub, boom, weight; a bright band at the top: air, hiss
- a diagonal going up: a riser or a sweep; vertical strokes: clicks, glitches, ticks
- horizontal lines: a tone, a bell, a hum; blurred noise: a whoosh, wind, a texture
- a long plateau in the waveform: a bed; a sharp peak and a fast decay: a hit

### What is left to the human ear
The critique ends with a list of five moments (`critique.py --listen-out FILE.wav` cuts them into one file, 3 s each). The
list is built from measurements of this particular render: the hook, the loudest sound, misses in sync, balance, speech
and mono, sounds pulled up by 4+ dB or retuned in pitch; different kinds of risk, not one. The script cannot hear and
does not say "sounds good": each line is a question for the ear (is it harsh, is it thin, is it in tune with the music,
can the words be heard). The beat grid is checked against the kick by a number, but look at the `beats.py --plot`
picture yourself: the green kick marks sit on the red grid lines. One listen on a phone speaker checks what headphones do
not reveal: mono.

## Level 2: what gets installed and from where

`python scripts/listen.py status` shows the state. Installation only on an explicit command:

```
python scripts/listen.py install --yes
python scripts/listen.py tag-index          # tags + embeddings of the whole library, ~5-10 minutes on a CPU
```

Downloaded (all into the skill folder, the system is not touched):
- `onnxruntime` and `numpy` from PyPI into `vendor/venv`: ~25 MB
- `yamnet.onnx` 16.1 MB and `yamnet_class_map.csv`: https://huggingface.co/audiomagic/yamnet-onnx,
  licence Apache-2.0, AudioSet labels CC BY 4.0. This is a third-party conversion of Google's model, so the script
  checks the file size. The model takes a raw 16 kHz waveform, the spectrogram is built into the graph.

After `tag-index`, every sound in the index has `tags` with confidence (`tag_scores`), and `--says "glass"` and
`--like ID` also work by meaning: a word counts if the model is at least 30 % sure of the tag, and the surer it is, the
higher the result. Only the **audible** part of a file is listened to (pack files with seconds of silence would give
"Silence 100 %", this is cut off), and environment classes (Silence, Sound effect, Inside small room) do not become tags.

What this gives in picking, checked on the author's library:
- `--says typing` / `glass` / `ding` find typing recordings, glass and bells by meaning, not by folder name.
- Duplicates of a recording under different names show in the embedding: four takes of "Glass Crack 01–04" (six pairs)
  give a cosine of 0.83–0.92, two random whooshes 0.55 on average (90th percentile 0.78). The picker pushes a candidate
  back if it is closer than 0.82 to a sound already on the sheet, so variety is counted by meaning.
- Weak spots: YAMNet tags short single clicks at random ("Rodents", "Mouse"); do not use tags for them, look at the
  words and the picture. Camera, coin and click often get junk tags. YAMNet is smaller and less accurate than AST/PANN
  (mAP 0.31 against 0.44–0.46 on AudioSet), but it has 3.7 M parameters instead of 80+ and runs on any CPU.

## Level 3: external "listeners"

Only if the user explicitly wants it and understands that the audio leaves the computer.

- **Claudio** (MCP, Gemini): the tool `listen_to_audio(path, question)`, `ask_about_audio` to follow up. Needs
  `GEMINI_API_KEY`; files up to 20 MB go inline, larger ones through the Files API.
  The user connects it: `claude mcp add claudio -e GEMINI_API_KEY=... -- uvx claudio`.
  Package: https://pypi.org/project/claudio/ (one maintainer, version 0.2.3, no trusted publishing: check the code
  before installing).
- **audio-analysis MCP** (librosa, Claude Code): onsets, spectra, pitch, file comparison, pictures. Nothing new beyond
  `scripts/`, but may help those who already use it.
- **Freesound MCP** (there are several, e.g. mushan-bit/freesound-mcp): search and download CC sounds with a Freesound
  API key. Useful for those without their own library; check the licence of every sound.

Send only `*_sfx_track.wav` and specific short pieces to such a model, not the whole project, and ask the user first.

## Separating "music / effects / speech" in references (researched, not built in)

This is what learning from finished films lacks: in them the music buries the SFX. What was found:
- **Bandit / Bandit v2** (cinematic audio source separation, trained on DnR): three stems speech/music/effects. Code
  https://github.com/kwatcharasupat/bandit-v2 (Apache-2.0), weights on Zenodo (https://zenodo.org/records/12701995).
  Research code, needs PyTorch, the API is unstable. Paper: https://arxiv.org/abs/2407.07275
- **MVSep** (a web service) offers DnR v3 (SCNet, MelBand RoFormer, Bandit v2) with no install, but it means uploading
  films to a third-party cloud.
- For the SFX stem of references the simplest thing works best: take versions **without music** or **with a separate
  SFX track**; authors often have them.

If such references appear, `learn_style.py` computes an exact profile from them in a minute.

## What else was found online (researched 2026-10-14, not adopted)

- **songsee** (a skill/CLI, steipete/songsee): draws spectrograms and feature panels (mel, chroma, MFCC). Does the same
  as `review.py` / `contact_sheet.py` / `zoom.py`, only without ties to frames and the cue sheet.
- **A local audio LLM**: Qwen3-Omni (30B MoE, 3B active) runs through llama.cpp in GGUF and can describe sound effects in
  words. A quantized version takes about 17–20 GB, more than 8 GB VRAM + 16 GB RAM allow without heavy speed
  compromises. Check the model page and llama.cpp releases before trying.
- **Hosted models** (Qwen3-Omni-Captioner via Alibaba's API, Gemini): describe sound with no install, but the audio
  leaves the machine and a key is needed.
- No ready "skill that listens" was found: every option is either spectrogram pictures or a call to an external model.
  Hence the chosen path: numbers, words, pictures, optionally YAMNet.
