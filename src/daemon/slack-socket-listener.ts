// Slack team-surface P1 (transport swap) — adapter from Socket Mode onto the
// existing inbox-write sink. Produces inbox writes byte-identical in format to
// the legacy checkSlackWatch poll path in fast-checker.ts.

import { SlackSocketClient, type SlackMessageEvent } from '../slack/slack-socket.js';
import { SlackAPI } from '../slack/api.js';
import { sendMessage } from '../bus/message.js';
import {
  resolveSlackIdentity,
  evaluateSlackTrust,
  formatSlackOriginator,
} from '../slack/slack-identity.js';
import type { BusPaths, TeamMember } from '../types/index.js';

export interface SlackSocketListenerOptions {
  appToken: string;
  botToken: string;
  channel: string;
  agentName: string;
  paths: BusPaths;
  log: (msg: string) => void;
  signingSecret?: string;
  trustedSlackUsers?: string[];
  teamMembers?: TeamMember[];
}

/**
 * Adapts {@link SlackSocketClient} onto the bus inbox-write sink.
 *
 * Each incoming Slack message event is resolved to a display name and written
 * to the agent's inbox via {@link sendMessage} using the EXACT same format,
 * sender ('fast-checker'), recipient (agentName), and priority ('normal') as
 * the legacy poll-based checkSlackWatch path.
 */
export class SlackSocketListener {
  private readonly channel: string;
  private readonly agentName: string;
  private readonly paths: BusPaths;
  private readonly log: (msg: string) => void;
  private readonly slackApi: SlackAPI;
  private readonly client: SlackSocketClient;
  private readonly trustedSlackUsers?: string[];
  private readonly teamMembers?: TeamMember[];
  // userId -> resolved identity; populated by resolveSlackIdentity on cache miss
  // so repeat senders never re-hit users.info.
  private readonly identityCache = new Map<
    string,
    { handle: string | null; displayName: string }
  >();
  // Loudly-open warning is logged at most once per listener instance.
  private slackOpenWarned = false;
  // Own bot user id (resolved once via auth.test) for the self-echo guard.
  // `undefined` = not yet resolved; `null` = resolved-but-unavailable (auth.test
  // failed), in which case the own-id check is skipped and shouldDeliverSlackMessage's
  // bot_id guard still applies. A non-null value drops events authored by our own bot.
  private ownBotUserId: string | null | undefined = undefined;

  constructor(opts: SlackSocketListenerOptions) {
    this.channel = opts.channel;
    this.agentName = opts.agentName;
    this.paths = opts.paths;
    this.log = opts.log;
    this.trustedSlackUsers = opts.trustedSlackUsers;
    this.teamMembers = opts.teamMembers;
    this.slackApi = new SlackAPI(opts.botToken);
    this.client = new SlackSocketClient(
      {
        appToken: opts.appToken,
        botToken: opts.botToken,
        channelId: opts.channel,
        signingSecret: opts.signingSecret,
      },
      (event) => this.handleMessage(event),
      opts.log,
    );
  }

  /** Start the underlying Socket Mode connection. */
  async start(): Promise<void> {
    await this.client.start();
  }

  /** Gracefully shut down the underlying Socket Mode connection. */
  stop(): void {
    this.client.stop();
  }

  /**
   * Handle a single Slack message event: resolve the display name and write
   * the formatted message to the agent's inbox. PUBLIC for unit testing.
   *
   * Never throws — inbox-write failures are swallowed and logged, mirroring
   * the legacy poll's try/catch behavior.
   */
  async handleMessage(event: SlackMessageEvent): Promise<void> {
    const userId = event.user;

    // Self-echo guard (belt-and-suspenders alongside shouldDeliverSlackMessage's
    // bot_id drop): never process our own bot user's messages. Resolve the own
    // bot user id once via auth.test and cache it. If auth.test is unavailable
    // (null), skip this check — the bot_id gate already covers the observed case,
    // and a lookup failure must not kill inbound.
    if (this.ownBotUserId === undefined) {
      this.ownBotUserId = await this.slackApi.getBotUserId();
    }
    if (this.ownBotUserId && userId === this.ownBotUserId) {
      this.log(`Slack message from own bot user ${userId} dropped (self-echo guard)`);
      return;
    }

    const identity = await resolveSlackIdentity(
      userId,
      (id) => this.slackApi.getUserInfo(id),
      this.teamMembers,
      this.identityCache,
    );
    const trust = evaluateSlackTrust(identity.handle, this.trustedSlackUsers);
    if (trust.openWarning && !this.slackOpenWarned) {
      this.log('Slack allowlist not configured — all workspace users can drive the agent.');
      this.slackOpenWarned = true;
    }
    if (!trust.allowed) {
      this.log(`Slack message from untrusted user ${identity.handle ?? userId} dropped (not in allowlist)`);
      return;
    }
    const from = formatSlackOriginator(identity);

    // Coerce text: captionless file/photo shares deliver with no text field,
    // so interpolating event.text directly would render the literal string
    // "undefined" in the inbox body. Match the poll's empty-body behavior.
    const body = event.text ?? '';
    const inboxText =
      `=== SLACK from ${from} (channel:${this.channel} ts:${event.ts}) ===\n` +
      `${body}\n` +
      `Reply using: cortextos bus send-slack ${this.channel} "<reply>"`;

    try {
      sendMessage(this.paths, 'fast-checker', this.agentName, 'normal', inboxText);
    } catch (err) {
      this.log('Slack socket inbox write failed: ' + err);
    }
  }
}
