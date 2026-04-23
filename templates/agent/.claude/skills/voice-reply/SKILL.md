---
name: voice-reply
description: "Send a voice message to a Telegram chat (and simultaneously render text + an inline audio player in the dashboard /comms chat), or speak aloud through Mac speakers. Uses the agent's configured voice persona (edge-tts) to convert text to MP3."
triggers: ["voice reply", "speak", "send audio", "voice message", "text to speech", "tts", "say it", "send voice", "play out loud", "speak aloud", "afplay"]
---

# Sending a Voice Reply

Each agent has a `voice` field in their `config.json`. Use it to generate audio from text and send to Telegram or play through Mac speakers.

## Preferred: one command, Telegram + dashboard /comms together

```bash
cortextos bus voice-reply "$CHAT_ID" "Your message text"
```

This generates the MP3 using the agent's configured voice, sends it to Telegram, and also publishes the file to `{CTX_ROOT}/dashboard-uploads/` so the dashboard `/comms` channel with the user shows the text plus an inline audio player in the same message bubble. Add `--local` to also play through Mac speakers at the same time, or `--voice <name>` to override the voice.

## Send via Telegram

```bash
CHAT_ID="<chat_id>"
TEXT="<your message text>"
VOICE=$(python3 -c "import json; print(json.load(open('config.json')).get('voice','en-US-AndrewNeural'))")
OUTFILE="/tmp/voice-reply-$$.mp3"

python3 -m edge_tts --voice "$VOICE" --text "$TEXT" --write-media "$OUTFILE" \
  && cortextos bus send-telegram "$CHAT_ID" "" --file "$OUTFILE" \
  && rm -f "$OUTFILE"
```

With a caption:
```bash
cortextos bus send-telegram "$CHAT_ID" "Here's the summary:" --file "$OUTFILE"
```

## Play through Mac speakers (local)

```bash
TEXT="<your message text>"
VOICE=$(python3 -c "import json; print(json.load(open('config.json')).get('voice','en-US-AndrewNeural'))")
OUTFILE="/tmp/voice-reply-$$.mp3"

python3 -m edge_tts --voice "$VOICE" --text "$TEXT" --write-media "$OUTFILE" \
  && afplay "$OUTFILE" \
  && rm -f "$OUTFILE"
```

## Both — Telegram + speakers simultaneously

```bash
TEXT="<your message text>"
VOICE=$(python3 -c "import json; print(json.load(open('config.json')).get('voice','en-US-AndrewNeural'))")
OUTFILE="/tmp/voice-reply-$$.mp3"

python3 -m edge_tts --voice "$VOICE" --text "$TEXT" --write-media "$OUTFILE" \
  && afplay "$OUTFILE" \
  && cortextos bus send-telegram "$CHAT_ID" "" --file "$OUTFILE" \
  && rm -f "$OUTFILE"
```

## Dependencies

- `edge-tts` installed via `pip3` (globally available)
- `afplay` built into macOS — no install needed
- No API key required

## Voice assignments

| Agent    | Voice                          | Character          |
|----------|--------------------------------|--------------------|
| mozart   | en-US-AndrewNeural             | authoritative, clear |
| coder    | en-US-EricNeural               | focused, technical  |
| dexter   | en-US-ChristopherNeural        | measured, analytical |
| sherlock | en-US-SteffanNeural            | precise, investigative |
| picasso  | en-US-BrianNeural              | warm, expressive    |
| gary     | en-US-RogerNeural              | friendly, professional |
| methy    | en-US-GuyNeural                | energetic, engaging |
| googli   | en-US-AndrewMultilingualNeural | capable, data-driven |
| chad     | en-US-AriaNeural               | confident, approachable |
| russel   | en-US-JennyNeural              | clear, friendly     |
| sesio    | en-US-AvaNeural                | professional, precise |

## Listing all available en-US voices

```bash
python3 -m edge_tts --list-voices | grep en-US
```
