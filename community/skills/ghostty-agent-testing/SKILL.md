---
name: ghostty-agent-testing
description: "Operate a live terminal agent inside Ghostty like a human: focus the terminal, type prompts and keystrokes, handle permission/continuation prompts, and observe near-real-time behavior through that agent's native transcript or log stream."
triggers: ["ghostty testing", "terminal agent testing", "live agent control", "agent transcript", "jsonl transcript", "interactive terminal qa", "permission prompts", "terminal agent steering", "operate agent in terminal"]
external_calls: []
---

# Ghostty Agent Testing

Use this skill to operate and test a live terminal agent running in Ghostty. The goal is general human-style control: focus the real terminal, type what a person would type, respond to prompts, watch the agent's output stream, and steer the session iteratively.

Ghostty is the control surface. The agent's native transcript, event stream, PTY capture, or logs are the source of truth.

## Capability Model

- You can interact with the real Ghostty session by focusing a window/terminal and sending typed text, Enter, menu choices, or approval/denial keystrokes through AppleScript.
- You usually observe the session through the agent's native transcript/log stream, not by reading terminal pixels. The exact source is agent-specific: Codex agents should use Codex-native session events/logs, Claude Code should use Claude's JSONL transcript, and other PTY or terminal agents should use their own transcript, PTY capture, or log files.
- The observation stream should expose enough behavior to steer the loop: assistant text, tool calls, tool results, hook output, errors, prompts, and permission/continuation states.
- This supports live back-and-forth with an agent: type a prompt, wait briefly, inspect the output stream, decide the next human-style response, and continue.
- Expect a small delay. Some terminal agents need an extra Enter after tool output or after a visible prompt appears.
- This is strongest for terminal agents that write structured transcripts or logs. It is weaker for purely visual terminal apps with no output stream.

## Safety Rules

- Test in a disposable repo, branch, worktree, or fixture unless the user explicitly asks to use a real project.
- Record repo status before and after any test that edits files.
- Do not change global agent config, host Codex config, private auth material, deploys, external services, or PR/merge state unless the user explicitly asks and any required approval has been handled.
- Prefer reversible fixture edits. Do not use destructive git commands unless the target is clearly disposable or the user has explicitly approved them.
- If a live session requests a risky tool action, deny it or interrupt it unless the test specifically requires that approval path.

## Workflow

1. Identify the target Ghostty terminal.

```bash
osascript <<'APPLESCRIPT'
tell application "Ghostty"
  repeat with w in windows
    log ((id of w as text) & " | " & (name of w as text))
    repeat with t in terminals of w
      log ("  term " & (id of t as text) & " | " & (name of t as text) & " | cwd=" & (working directory of t as text))
    end repeat
  end repeat
end tell
APPLESCRIPT
```

2. Find the active agent-native transcript or log.

Use the transcript source native to the agent you are driving. Do not force every agent into Claude's JSONL shape.

- Codex agent: use Codex-native session events, app-server logs, or the runtime's transcript/session file for that terminal.
- Claude Code: use Claude's JSONL transcript, usually under `~/.claude/projects/` with the project path encoded in the directory name.
- Other PTY or terminal agents: use their native transcript, PTY capture, or session output file.

Prefer recent files and confirm timestamps or session content match the terminal you are driving.

```bash
find ~/.claude/projects -name '*.jsonl' -mmin -60 -print | xargs ls -t | head -20
tail -n 80 /path/to/native-transcript-or-log
```

3. Type into the real terminal.

Replace the IDs and text. Keep prompts short, explicit, and test-oriented.

```bash
osascript <<'APPLESCRIPT'
tell application "Ghostty"
  set w to window id "WINDOW_ID"
  activate window w
  delay 0.2
  set t to terminal id "TERMINAL_ID"
  focus t
  input text "your prompt or command here" to t
  delay 0.1
  send key "enter" to t
end tell
APPLESCRIPT
```

4. Observe the response through the transcript or log.

```bash
tail -n 120 /path/to/native-transcript-or-log
rg -n "hook|error|tool_use|permission|blocked|test" /path/to/native-transcript-or-log
```

Use the output stream to verify the actual assistant message, tool call, hook result, edit, or failure. If the terminal appears stalled after a tool result, send Enter once and tail again.

```bash
osascript <<'APPLESCRIPT'
tell application "Ghostty"
  set t to terminal id "TERMINAL_ID"
  focus t
  send key "enter" to t
end tell
APPLESCRIPT
```

5. Handle permission and continuation prompts.

When the terminal agent waits for a prompt, decide from its native transcript/log and the visible test scope whether a human tester would accept, deny, or continue.

- Accept only safe, local, expected actions in a disposable test session.
- Deny external, auth-dependent, destructive, deploy, PR, merge, or global-config actions unless the user explicitly approved that exact path.
- Record every accepted or denied prompt in the test evidence.
- If the prompt is only a continuation after tool output, send Enter and verify the transcript advances.

Send single-key responses with `send key`. Send text choices with `input text`, then Enter.

```bash
osascript <<'APPLESCRIPT'
tell application "Ghostty"
  set t to terminal id "TERMINAL_ID"
  focus t
  send key "enter"
end tell
APPLESCRIPT
```

```bash
osascript <<'APPLESCRIPT'
tell application "Ghostty"
  set t to terminal id "TERMINAL_ID"
  focus t
  input text "y" to t
  send key "enter" to t
end tell
APPLESCRIPT
```

Use `n` or the visible denial choice for unsafe prompts, then confirm the transcript shows the denial or cancellation.

6. Iterate like a human tester.

- State the next test in the terminal.
- Trigger the command, slash command, hook, or workflow being tested.
- Tail the transcript until the behavior is visible.
- Inspect filesystem or git state from your own shell when needed.
- Fix only the scoped issue, then retest the same path in Ghostty.

7. Capture evidence.

For each tested behavior, record:

- The exact prompt or command typed into Ghostty.
- Any permission or continuation prompt and the keystroke chosen.
- The native transcript/log path and relevant tail/`rg` evidence.
- The expected behavior and observed behavior.
- Any file paths changed.
- The retest result.
- Remaining caveats, especially skipped external-service, auth-dependent, deploy, PR, or merge paths.

## Notes For Interactive Agent Control

This pattern can control a terminal agent in a practical live loop, but the feedback channel is agent-native transcript/log-first. Treat Codex events, Claude JSONL, PTY captures, or equivalent logs as near-real-time telemetry rather than retrospective-only evidence. Do not assume that a blank or unchanged terminal view means the agent is idle; check the transcript, process state, and recent file activity.
