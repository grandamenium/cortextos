---
name: bus-rpc
description: Synchronous request-reply over the cortextos bus. send → poll caller inbox for reply with matching reply_to → ack → return. Used by orchestrator-style skills (e.g. orchestrate-research-query) that need a synchronous answer from a peer agent.
allowed_tools: [Bash, Read]
---

# bus-rpc

The cortextos bus is fire-and-forget by default. Most agent-to-agent comms ARE async — that's the right pattern for long-running work. But orchestrators (research-director, chief during multi-agent dispatches, etc.) need a **synchronous** request-reply primitive: "ask agent X this question, wait for the answer, time out cleanly."

This skill provides that primitive.

## Contract

`bin/rpc.sh <target-agent> "<query>" [--timeout 120] [--priority high] [--from <caller>]`

- Sends a message to `target-agent` via `cortextos bus send-message`.
- Polls the **caller's** inbox at 2-second intervals for a message whose `reply_to == sent_msg_id`.
- ACKs the reply on receipt.
- Returns the reply text (or a timeout envelope) as JSON to stdout.

`--from` defaults to `$CTX_AGENT_NAME`. Override only for testing.

## Output

```json
{
  "verdict": "ok | timeout | error",
  "target": "research",
  "sent_msg_id": "1778698... id",
  "elapsed_s": 23,
  "reply": {
    "id": "1778698... reply id",
    "from": "research",
    "reply_to": "1778698... id",
    "text": "the reply body"
  }
}
```

On timeout: `verdict: "timeout"`, no reply field, sent_msg_id still surfaced (the target may still answer eventually — caller can re-poll later by msg_id).

On error: `verdict: "error"`, with `error` field carrying the cause (e.g. unknown agent, bus daemon down, malformed args).

## When to use

- Orchestrator skills that need an answer from a single peer before proceeding (research-director → research lane).
- Fan-out + collect patterns (research-director → claude AND codex; poll both inboxes for matching reply_to ids).
- Workflows where ACK-but-no-reply is a meaningful outcome (use `--timeout 0` to send without waiting — but at that point you don't need this skill, just `cortextos bus send-message` directly).

## When NOT to use

- Long-running multi-turn coordination (use the regular fire-and-forget bus with explicit state).
- High-volume request bursts (the 2s polling cadence is fine for 1-10 concurrent requests; >50 should switch to inotify-based watching).
- Cross-instance RPC where the target lives on the other instance (bus-relay forwards messages, but the round-trip latency is ~60-90s end-to-end via the 30s relay tick — be patient with --timeout).

## The receiving agent's contract

For RPC to work, the receiving agent MUST reply with `reply_to` set to the original message id. The convention `cortextos bus send-message <caller> <priority> '<reply>' <original-msg-id>` (the last positional arg is reply_to) handles this. Agent prompts should be explicit:

> When you receive an RPC-style message (text starts with `RPC: ` or has clear question shape), reply via `cortextos bus send-message <caller> normal '<answer>' <msg_id>` so the caller can correlate.

Both `cortextos bus send-message` positional and `--reply-to <id>` forms are accepted.

## Edge cases handled

1. **Multiple replies** — if the target sends 2+ messages with the same reply_to, the first arrival wins (rpc.sh acks all matches it sees to avoid inbox accumulation).
2. **Out-of-order arrival** — replies to earlier RPCs sitting in the inbox don't interfere; rpc.sh only matches on exact sent_msg_id.
3. **Caller-agent name mismatch** — if `--from` doesn't match the actual agent dir, the reply lands somewhere else; rpc.sh detects this by listing target inboxes and warning.
4. **Bus daemon down** — `cortextos bus send-message` exits non-zero; rpc.sh propagates with `verdict=error`.

## Integration with orchestrate-research-query

```bash
# Inside orchestrate.sh stage 1, replace the stub:
claude_reply=$(/path/to/bus-rpc/bin/rpc.sh research "$QUERY" --timeout 120)
codex_reply=$(/path/to/bus-rpc/bin/rpc.sh research-codex "$QUERY" --timeout 120) &
wait
```

Both lanes dispatched concurrently; each polls its own RPC return. Synth-compare consumes both outputs.

## Limits

- Reply text is currently treated as opaque blob. For structured replies, the convention is the receiving agent emits JSON in the text field; caller json-parses.
- 2s polling cadence means worst-case 2s extra latency on top of the agent's processing time. Acceptable for human-tempo RPCs.
- No reply de-dup beyond first-wins. If the agent sends 3 replies (bug or retry), you see the first; others get ACKed silently.
