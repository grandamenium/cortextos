# iOS Shortcuts for Voice Conversation

Two iOS Shortcuts complete the voice conversation loop. Both are configured on the device (you cannot set them up from a cortextos agent - Apple controls the Shortcuts surface), so this doc walks through the steps you take on your iPhone.

Together with the bot-side `send-telegram --voice` flag (which delivers voice replies from agents *to* you), these Shortcuts give you a fully hands-free back-and-forth.

| Component | Direction | What it does |
|---|---|---|
| 1. Message Agent Shortcut | You → Agent | "Hey Siri, message Atlas" → record voice → transcribe → POST text to Atlas's Telegram bot |
| 2. Read with TTS Shortcut | iOS → Speaker | Select text anywhere on iPhone → Share Sheet → ElevenLabs/OpenAI playback through headphones |

Component 3 in the spec ("voice-stop / end-message VAD") is **NOT** built in v1 - native Shortcuts cannot watch for a stop-word in audio. The fallback is the single tap-to-stop button in the Dictate Text action, which works fine for messages up to a few minutes.

---

## Component 1: Message Agent Shortcut (FROM you TO agents)

You record a voice memo, Siri transcribes it, the Shortcut POSTs the text to the agent's Telegram bot. The agent receives it through the normal fast-checker poll and replies (voice + text) using the `--voice` flag on the bot side.

### Steps

1. Open the **Shortcuts** app on iPhone → tap **+** to create a new Shortcut.
2. Name it "Message Atlas" (the exact title is what Siri will match).
3. Add these actions in order:

   | # | Action (from action library) | Configuration |
   |---|---|---|
   | 1 | **Dictate Text** | Language: English. Stop Listening: After Pause |
   | 2 | **URL** | `https://api.telegram.org/bot<ATLAS_BOT_TOKEN>/sendMessage` |
   | 3 | **Get Contents of URL** | Method: POST. Request Body: JSON. Add Fields:<br>• `chat_id` (Text) → your chat_id (numeric)<br>• `text` (Text) → tap the variable picker and select **Dictated Text** |

4. **Add to Siri**: tap the Shortcut settings (top right) → **Add to Siri** → record the phrase **"message Atlas"** (or "hey Atlas" if that feels more natural).

5. (Optional but recommended) **Enable on Lock Screen**: in the Shortcut settings, turn on **Show in Share Sheet** AND **Use on Lock Screen** so the workflow runs even with the phone locked.

6. Duplicate the Shortcut and rename it "Message Sage" with Sage's bot token + chat_id, then add to Siri as "message Sage". Repeat for each agent that should receive voice messages.

### Where to find each field

- **`<ATLAS_BOT_TOKEN>`**: from the agent's `orgs/<org>/agents/<agent>/.env` file, the `BOT_TOKEN` value. Or pull from 1Password Automation vault, item "Telegram Bot (Atlas - <org>)".
- **`chat_id`**: your numeric Telegram chat id. Found via `curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq '.result[-1].message.chat.id'` after sending one message to the bot from your account.

### What it looks like in use

> "Hey Siri, message Atlas."
> 
> *(iPhone plays a chime, listens until you pause)*
> 
> "Heads up I just got off a call with Dr. Saylor and we agreed on the December reschedule. Please draft the email to staff and run it past me before sending."
> 
> *(iPhone plays a confirmation tone, Shortcut completes)*
> 
> *(Atlas receives the text, processes, replies with a voice TL;DR via the `--voice` flag plus the full text)*

### Failure modes + fixes

- **Siri does not respond to the phrase**: the Add to Siri recording was either too quiet or too noisy. Re-record in the Shortcut settings.
- **Shortcut runs but agent never receives the message**: usually a wrong chat_id. Re-run the `getUpdates` curl, confirm the numeric id matches the one in the Shortcut.
- **"Bad Request: message text is empty"** in the Telegram response: Dictated Text returned nothing (background too noisy). Re-record.
- **Agent replies via text only, no voice**: the agent has no `voice` configured in `config.json` or `orgs/<org>/voices.json`. See `templates/agent/TOOLS.md` "When to use voice" for setup.

---

## Component 2: Read with TTS Shortcut (iOS-only)

iOS system-wide Speak Selection cannot use ElevenLabs or OpenAI TTS - Apple controls that layer. This is a Shortcut workaround for when you want OpenAI-quality playback on specific selected text.

The user-facing pattern: select text anywhere on iPhone → Share Sheet → "Read with TTS" → audio plays through wired headphones.

### Steps

1. Open **Shortcuts** → tap **+**.
2. Name it "Read with TTS".
3. Add these actions in order:

   | # | Action | Configuration |
   |---|---|---|
   | 1 | **Get Shortcut Input** | Accept: Text. From: Share Sheet |
   | 2 | **URL** | `https://api.openai.com/v1/audio/speech` |
   | 3 | **Get Contents of URL** | Method: POST.<br>Headers:<br>• `Authorization` = `Bearer <YOUR_OPENAI_API_KEY>`<br>• `Content-Type` = `application/json`<br>Request Body: JSON. Add Fields:<br>• `model` (Text) → `tts-1`<br>• `voice` (Text) → `cedar` (or your pick - see voice-conversation-spec.md)<br>• `input` (Text) → Shortcut Input variable<br>• `response_format` (Text) → `opus` |
   | 4 | **Play Sound** | (input: result of Get Contents of URL) |

4. In the Shortcut settings: **Show in Share Sheet** → on, **Accept**: Text only.

### Usage

- Highlight any text on iPhone (article, email, message, anything)
- Tap **Share** → scroll the action row → tap **Read with TTS**
- Audio plays through whatever audio output is active (wired headphones, AirPods, speaker)

### Notes + limits

- The OpenAI API key in this Shortcut is local to the device. Storing it in a Shortcut is acceptable for personal use; do NOT share this Shortcut with anyone else without removing the key first.
- Apple does not currently surface a clean way to stream audio - the Shortcut waits for the full OGG to download before playback starts. Latency for a 200-word selection is ~3-5 seconds. For longer texts, chunk before Reading.
- Wired headphones work natively. AirPods sometimes route through Apple's audio processing path with a small delay; usable but not as crisp.
- The voice picked here can be different from any agent's voice (or the same). Use `orgs/<org>/voices.json` `_read_aloud` key to declare an org default for which voice this Shortcut should use - then change the Shortcut to read that variable through your team's preferred sync mechanism.

---

## Voice picks per agent

After running `scripts/generate-voice-samples.ts`, listen to the samples in `/tmp/voice-samples/` and assign:

- **One voice to each agent** that should send voice replies. Add to `orgs/<org>/agents/<agent>/config.json` as `"voice": "cedar"` (or whichever you pick).
- **One voice for Read-Aloud** if you set up Component 2 above. Add to `orgs/<org>/voices.json` as `"_read_aloud": "fable"` (or your pick).

Pick distinct voices for agents that talk to you frequently, so you can ID the agent by ear without looking at your phone.

Suggested distinctions per the spec author:
- Orchestrator/chief-of-staff voice: warm + slightly faster (e.g. `alloy`, `cedar`)
- Analyst voice: calm + measured (e.g. `fable`, `onyx`)
- Read-Aloud voice: clear + conversational (e.g. `nova`, `shimmer`)

---

## Out of scope (v1)

- **Voice-stop / end-message VAD**: would require a custom listening service watching the audio stream for a stop-word. Not achievable with native Shortcuts. v1 uses the Dictate Text tap-to-stop fallback.
- **System-wide ElevenLabs replacement for iOS Speak Selection**: Apple controls that layer. Component 2 above is the workaround.
- **Streaming TTS playback**: full file downloads first. Acceptable for ≤30-sec clips, awkward for long-form. Chunk paragraph-by-paragraph for longer texts.
- **Voice cloning**: not relevant - we use OpenAI's stock voices, no custom voice training.
