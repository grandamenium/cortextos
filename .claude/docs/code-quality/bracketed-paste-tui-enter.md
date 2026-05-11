---
domain: [tui, automation, terminal]
applies_to: [engineer, devops]
severity: should-know
---

# Bracketed-paste TUIs need a separate Enter to submit

**`tmux send-keys "<text>" Enter` looks like submit but Claude Code v2.1+ buffers the burst as paste — Enter gets absorbed.** Symptom is silent: the command appears to send but the TUI never submits.

## Pattern fix

```bash
send_keys "$prompt"
sleep 1
send_keys ""        # standalone Enter, not bundled with text
```

The 1-second gap lets the TUI's bracketed-paste mode end before the standalone Enter fires.

## Rule of thumb

If your tmux/expect automation sends text-then-Enter and the TUI doesn't submit, the Enter was eaten by paste-mode. Split into two `send_keys` calls with a delay.
