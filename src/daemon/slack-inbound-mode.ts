// Slack inbound transport decision (Slack team-surface P1).
//
// Socket Mode is the real-time primary, but it requires native WebSocket
// (Node 22+). package.json allows node >=20, so on a Node 20/21 box Socket
// Mode cannot run. If we disabled the poll whenever both tokens are present
// (without checking WebSocket availability), such a box would have NO inbound
// at all — a silent no-inbound gap. This helper keeps Socket primary only when
// it can actually run, and falls back to the poll otherwise, so there is never
// a silent gap (no-silent-failure-half-ship rule).
//
// `webSocketAvailable` is injected (rather than read here) so the decision is a
// pure function and the Node-<22 fallback path is directly unit-testable.

export type SlackInboundDecision =
  | { mode: 'socket'; channel: string; botToken: string; appToken: string }
  | { mode: 'poll'; channel: string; botToken: string; intervalMs: number; reason?: string }
  | { mode: 'none'; reason: string };

export interface SlackInboundInput {
  botToken: string;
  appToken: string;
  channel: string;
  intervalMs: number;
  /** typeof WebSocket !== 'undefined' at the call site (true on Node 22+). */
  webSocketAvailable: boolean;
}

/**
 * Decide the Slack inbound transport.
 *
 * - No bot token        → 'none' (cannot do inbound at all).
 * - App token + WebSocket available → 'socket' (real-time primary; poll dormant).
 * - App token but WebSocket UNavailable → 'poll' fallback (Socket needs Node 22+);
 *   carries a `reason` so the caller can log the degraded mode loudly.
 * - Bot token only      → 'poll' (legacy behavior; no app token configured).
 */
export function resolveSlackInboundMode(input: SlackInboundInput): SlackInboundDecision {
  const { botToken, appToken, channel, intervalMs, webSocketAvailable } = input;

  if (!botToken) {
    return { mode: 'none', reason: 'SLACK_BOT_TOKEN not found' };
  }

  if (appToken && webSocketAvailable) {
    return { mode: 'socket', channel, botToken, appToken };
  }

  if (appToken && !webSocketAvailable) {
    // Both tokens present but Socket Mode cannot run on this runtime. Keep the
    // poll alive rather than going silent.
    return {
      mode: 'poll',
      channel,
      botToken,
      intervalMs,
      reason:
        'SLACK_APP_TOKEN is set but native WebSocket is unavailable (Socket Mode needs Node 22+) — using the 60s poll fallback',
    };
  }

  return { mode: 'poll', channel, botToken, intervalMs };
}
