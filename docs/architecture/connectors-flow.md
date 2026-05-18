# Connector data flow diagrams

Companion to `docs/architecture/connectors.md`. Shows every call path
between the agent's PTY, the bus CLI, the pluggable connector layer,
and the external messaging provider (Telegram today; Discord /
Mattermost / RocketChat / Matrix shown as the same shape).

The diagrams use Telegram as the concrete provider because it's the
only one implemented. To see how a future provider plugs in, mentally
substitute the orange "Provider boundary" box with the target's
client. The provider-agnostic boxes (everything between agent and
boundary) don't change.

---

## 1. Outbound flow — agent sends a message / reaction

```mermaid
sequenceDiagram
  autonumber
  participant U as User (Telegram client)
  participant TG as Telegram Bot API
  participant API as TelegramAPI<br/>(provider client)
  participant TC as TelegramConnector<br/>(MessageConnector impl)
  participant CLI as cortextos bus CLI<br/>(send / send-telegram / react)
  participant FC as FastChecker<br/>(daemon)
  participant AG as Agent PTY<br/>(Claude Code)

  Note over AG,CLI: Two outbound paths converge on the connector

  AG->>CLI: cortextos bus react 21 ✅<br/>(spawned shell)
  CLI->>CLI: resolveEnv + readConnectorKindFromAgent<br/>+ parseEnvFile(agent .env)
  CLI->>TC: getConnector('telegram', agentDir, mergedEnv)
  TC->>TC: capability gate:<br/>outboundReactions?
  TC->>API: sendReaction(msg_id, '✅')
  API->>TG: POST setMessageReaction<br/>{chat_id, message_id, reaction:[{type:'emoji',emoji:'✅'}]}
  TG-->>U: emoji appears on user's message
  API-->>TC: { ok: true }
  TC-->>CLI: resolves
  CLI-->>AG: stdout: "Reacted ✅ on message 21"

  Note over FC,CLI: Daemon-initiated path (no agent involvement)

  FC->>TC: connector.sendMessage("Agent crashed",<br/>{parseMode:'plain'})
  TC->>API: sendMessage(chatId, text)
  API->>TG: POST sendMessage<br/>{chat_id, text, parse_mode:HTML?}
  TG-->>U: chat shows message
```

**Key seams** (orange = provider boundary, blue = generic):

- `cortextos bus react`, `bus send`, `bus send-telegram` are all generic
  CLI surfaces — they all route through `getConnector()`.
- `getConnector(kind, agentDir, env)` is the dispatch point. Replacing
  the `'telegram'` literal with `'discord'` (or `'matrix'`, etc.)
  swaps the TelegramConnector box for the future provider's
  connector, and the rest of the diagram is unchanged.
- The daemon's crash-notification path bypasses the CLI entirely —
  it holds a connector reference from `startAgent` time and calls
  `connector.sendMessage` directly.

---

## 2. Inbound flow — Telegram message reaches the agent

```mermaid
sequenceDiagram
  autonumber
  participant U as User (Telegram client)
  participant TG as Telegram Bot API
  participant POLL as TelegramPoller<br/>(long-poll loop)
  participant TC as TelegramConnector
  participant AM as AgentManager<br/>onMessage handler
  participant FC as FastChecker<br/>queueTelegramMessage
  participant AG as Agent PTY

  loop every 1s
    POLL->>TG: GET getUpdates?offset=X<br/>&allowed_updates=[message,message_reaction,callback_query]
    TG-->>POLL: [updates]
  end

  Note over POLL,TC: Update arrives

  TG-->>POLL: { message: { text, photo, voice, ... } }
  POLL->>TC: handler(tgMsg) // sync OR async

  alt has media + downloadDir set
    TC->>TC: processMediaMessage(tgMsg)
    TC->>TG: getFile + downloadFile (with maxBytes cap)
    TG-->>TC: file bytes
    TC->>TC: write to agentDir/telegram-images/<br/>msg<id>_<filename>
    opt voice/audio
      TC->>TC: transcribeVoice(oggPath)<br/>ffmpeg + whisper-cli
    end
  end

  TC->>TC: toNormalizedMessage(tgMsg)<br/>chat_id, message_id, reply_to.text,<br/>media{kind, localPath, transcription?}
  TC->>AM: handlers.onMessage(NormalizedMessage)

  AM->>AM: allowedUserId gate<br/>(string-equality on from.id)

  AM->>FC: formatTelegramTextMessage(...,<br/>messageId=m.id)
  FC->>FC: isDuplicate? + queueTelegramMessage

  par
    FC->>AG: PTY inject<br/>"=== TELEGRAM from [USER: X]<br/>(chat_id:Y, message_id:Z) ==="
  and auto-eyes-ack (parallel, fire-and-forget)
    AM->>TC: connector.sendReaction(m.id, '👀')
    TC->>TG: POST setMessageReaction
    TG-->>U: 👀 appears on user's message<br/>within ~1s
  end

  AG->>AG: Claude Code processes...
  AG->>FC: (bus react 21 ✅)<br/>swap eyes to terminal state
```

---

## 3. Callback round-trip — inline buttons (AskUserQuestion path)

```mermaid
sequenceDiagram
  autonumber
  participant U as User (Telegram client)
  participant TG as Telegram Bot API
  participant POLL as TelegramPoller
  participant TC as TelegramConnector
  participant AM as AgentManager<br/>onCallback handler
  participant FC as FastChecker
  participant HOOK as cortextos bus<br/>hook-ask-user
  participant AG as Agent PTY (Claude Code)

  AG->>HOOK: AskUserQuestion tool invocation<br/>(PreToolUse hook fires)
  HOOK->>HOOK: writeFile ask-state.json<br/>{questions, current:0, total:1}
  HOOK->>TC: connector.sendMessage(text, {buttons: [[<br/>  {kind:'callback', label:'Joke', actionId:'askopt_0_0'},<br/>  {kind:'callback', label:'Fun fact', actionId:'askopt_0_1'}<br/>]]})
  TC->>TC: toTelegramButton: ConnectorAction →<br/>{text, callback_data}
  TC->>TG: POST sendMessage<br/>reply_markup={inline_keyboard}
  TG-->>U: chat shows buttons

  U->>TG: tap "Joke" button
  TG-->>POLL: { callback_query: { id, data:'askopt_0_0',<br/>message:{message_id}, from:{id,first_name,username} } }
  POLL->>TC: callback handler(tgCallbackQuery)
  TC->>TC: toCallbackPayload (typed CallbackPayload)
  TC->>AM: handlers.onCallback(CallbackPayload)
  AM->>FC: handleCallback(callbackPayload)
  FC->>FC: parse askopt_0_0 → qIdx=0 optIdx=0
  FC->>TC: connector.acknowledgeCallback(id, 'Got it')
  TC->>TG: POST answerCallbackQuery
  TG-->>U: toast "Got it" + spinner dismisses
  FC->>TC: connector.editMessage(message_id, 'Answered')
  TC->>TG: POST editMessageText
  TG-->>U: button message becomes "Answered"
  FC->>FC: writeFile state/hook-response.json<br/>{decision:'option:0'}
  FC->>AG: PTY inject KEYS.DOWN * 0 + KEYS.ENTER<br/>(Claude Code's TUI sees the selection)
  AG->>AG: AskUserQuestion tool returns option 0
```

---

## 4. Pluggability — same diagrams, different provider

```mermaid
graph LR
  subgraph "Agent layer (provider-agnostic)"
    A[Agent PTY]
    B[cortextos bus CLI]
    F[FastChecker]
    D[AgentManager / daemon]
  end

  subgraph "Connector layer (provider-agnostic interface)"
    I[MessageConnector interface<br/>capabilities + lifecycle]
    FAC[getConnector factory<br/>+ CONNECTOR_ALLOWLIST]
  end

  subgraph "Telegram (shipped)"
    TC[TelegramConnector]
    TPI[TelegramAPI / TelegramPoller]
    TG[Telegram Bot API]
  end

  subgraph "Discord (TBD)"
    DC[DiscordConnector<br/>placeholder]
    DG[Discord gateway WS<br/>+ REST]
  end

  subgraph "Mattermost (TBD)"
    MC[MattermostConnector<br/>placeholder]
    MM[Mattermost REST or WS]
  end

  subgraph "RocketChat (TBD)"
    RC[RocketChatConnector<br/>placeholder]
    DDP[RocketChat DDP / REST]
  end

  subgraph "Matrix (TBD)"
    XC[MatrixConnector<br/>placeholder]
    MX[Matrix Client-Server /sync]
  end

  A --> B
  B --> FAC
  D --> FAC
  F --> FAC
  FAC -.kind:'telegram'.-> TC
  FAC -.kind:'discord'.-> DC
  FAC -.kind:'mattermost'.-> MC
  FAC -.kind:'rocketchat'.-> RC
  FAC -.kind:'matrix'.-> XC

  TC --> I
  DC --> I
  MC --> I
  RC --> I
  XC --> I

  TC <--> TPI
  DC <--> DG
  MC <--> MM
  RC <--> DDP
  XC <--> MX

  TPI <--> TG

  style I fill:#cce,stroke:#339,stroke-width:2px,color:#000
  style FAC fill:#cce,stroke:#339,stroke-width:2px,color:#000
  style TC fill:#9c9,stroke:#363,color:#000
  style DC fill:#fc9,stroke:#963,stroke-dasharray: 5 5,color:#000
  style MC fill:#fc9,stroke:#963,stroke-dasharray: 5 5,color:#000
  style RC fill:#fc9,stroke:#963,stroke-dasharray: 5 5,color:#000
  style XC fill:#fc9,stroke:#963,stroke-dasharray: 5 5,color:#000
```

**Legend:**
- Solid blue boxes (`MessageConnector`, `getConnector`) — provider-agnostic interface points. These are the load-bearing seams; everything below them is swappable.
- Green box (`TelegramConnector`) — the only implementation shipped today.
- Dashed orange boxes — placeholder connectors. Each lands as a single
  PR per the §13 checklist (13-15 files touched, no interface
  changes required).

Adding a new connector means adding **one orange box + edge** to this
diagram. No edge above the connector layer needs to change.

---

## 5. Bidirectional summary — what the connector layer guarantees

```mermaid
flowchart TB
    subgraph In["Inbound (provider → agent)"]
        direction TB
        i1[Provider event<br/>raw wire format]
        i2[Connector normalizer<br/>raw → NormalizedMessage<br/>/NormalizedReactionPayload<br/>/CallbackPayload]
        i3[Daemon handler<br/>allowedUser gate + format<br/>+ auto-eyes-ack]
        i4[Agent PTY<br/>generic prompt format]
        i1 --> i2 --> i3 --> i4
    end

    subgraph Out["Outbound (agent → provider)"]
        direction TB
        o1[Agent invokes CLI<br/>cortextos bus send/react/edit]
        o2[Factory dispatch<br/>getConnector kind, agentDir, env]
        o3[Connector method<br/>sendMessage / sendReaction /<br/>editMessage / acknowledgeCallback]
        o4[Provider API<br/>HTTPS POST → provider]
        o1 --> o2 --> o3 --> o4
    end

    Out -. "agent's reply triggers<br/>provider event" .-> In
    In -. "inbound message<br/>prompts agent reply" .-> Out

    classDef agnostic fill:#cce,stroke:#339,color:#000
    classDef provider fill:#9c9,stroke:#363,color:#000
    class i2,i3,i4,o1,o2,o3 agnostic
    class i1,o4 provider
```

The four blue boxes on each side (i2/i3/i4/o1, o2/o3) are
provider-agnostic and stay byte-identical across all connectors.
Only the two green endpoints (i1 raw provider event, o4 provider
API) are provider-specific — and those live inside the
connector's own directory under `src/connectors/<kind>/`.
