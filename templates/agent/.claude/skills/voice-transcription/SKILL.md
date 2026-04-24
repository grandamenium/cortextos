---
name: voice-transcription
description: "A Telegram voice note has arrived. Transcribe the audio file to text using Whisper so you can act on what Rob said."
triggers: ["voice message", "voice note", "telegram voice", "local_file:", "audio message", "transcribe", "whisper"]
---

# Handling Telegram Voice Messages

Telegram voice messages are delivered with a `local_file:` path. Use Whisper to transcribe before processing.

## Incoming Format

```
=== TELEGRAM from <name> (chat_id:<id>) ===
[Voice message]
local_file: /tmp/cortextos-voice-<hash>.ogg
Duration: <N>s
Reply using: cortextos bus send-telegram <chat_id> "<reply>"
```

## Transcription

Run this inline — no script file needed:

```bash
python3 - << 'EOF'
import sys, subprocess, json, os, tempfile

audio_file = "/tmp/cortextos-voice-<hash>.ogg"  # replace with actual local_file path

result = subprocess.run(
    ["python3", "-c", f"""
import whisper, json
model = whisper.load_model("base")
r = model.transcribe("{audio_file}")
print(r["text"].strip())
"""],
    capture_output=True, text=True, timeout=120
)
print(result.stdout.strip())
if result.returncode != 0:
    print("ERROR:", result.stderr[:200], file=sys.stderr)
EOF
```

Or as a one-liner after reading the `local_file:` path:

```bash
LOCAL_FILE="/tmp/cortextos-voice-<hash>.ogg"
TRANSCRIPT=$(python3 -c "
import whisper
model = whisper.load_model('base')
r = model.transcribe('$LOCAL_FILE')
print(r['text'].strip())
")
echo "$TRANSCRIPT"
```

## Dependencies

- `ffmpeg` at `/usr/local/bin/ffmpeg` (required by Whisper for audio decoding)
- `openai-whisper` installed via `pip3`
- Model `base` (~140 MB) downloads on first use to `~/.cache/whisper/`

If Whisper is not installed: `pip3 install openai-whisper`

## After Transcription

Process the transcript text as if it were a typed Telegram message. Reply to the user confirming what you heard:

```bash
cortextos bus send-telegram <chat_id> "Heard: \"$TRANSCRIPT\""
```

Then act on the content.

## Troubleshooting

- **`ffmpeg not found`**: ensure `/usr/local/bin/ffmpeg` exists. If not: `which ffmpeg` to locate, then symlink: `ln -s $(which ffmpeg) /usr/local/bin/ffmpeg`
- **Slow first run**: Whisper downloads the model on first use — takes ~30s on a fast connection
- **Garbled output**: try `model = whisper.load_model("small")` for better accuracy on noisy recordings
