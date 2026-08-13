/**
 * Slack Web API client using built-in fetch (Node.js 20+).
 * No external dependencies.
 *
 * Only the subset we need for SP3a: postMessage, update, files.upload,
 * conversations.list. SP3b adds Socket Mode; SP3c adds Block Kit + interactive
 * acks via this same client.
 */

export interface PostMessageRequest {
  channel: string;
  text: string;
  /** Per-agent visual identity override; requires chat:write.customize scope. */
  username?: string;
  icon_emoji?: string;
  icon_url?: string;
  thread_ts?: string;
  /** Block Kit blocks; SP3c uses these for interactive approvals. */
  blocks?: unknown[];
}

export interface PostMessageResponse {
  ok: true;
  channel: string;
  ts: string;
}

export interface Channel {
  id: string;
  name: string;
  is_channel?: boolean;
  is_private?: boolean;
  is_member?: boolean;
}

export interface SlackUserInfo {
  id: string;
  name?: string;
  real_name?: string;
}

export class SlackAPI {
  constructor(private readonly token: string) {
    if (!token) throw new Error('SlackAPI: token is required');
  }

  /** Generic Slack API call helper — handles auth, JSON, and ok=false errors. */
  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!json.ok) {
      throw new Error(`slack ${method}: ${json.error ?? 'unknown error'}`);
    }
    return json;
  }

  async postMessage(req: PostMessageRequest): Promise<PostMessageResponse> {
    return this.call<PostMessageResponse>('chat.postMessage', req as unknown as Record<string, unknown>);
  }

  /** Used by SP3b's dispatcher to resolve a display name for the injected header. */
  async getUserInfo(userId: string): Promise<SlackUserInfo> {
    const resp = await this.call<{ user: SlackUserInfo }>('users.info', { user: userId });
    return resp.user;
  }

  async listChannels(): Promise<Channel[]> {
    const out: Channel[] = [];
    let cursor: string | undefined = undefined;
    do {
      const body: Record<string, unknown> = { limit: 200, types: 'public_channel,private_channel' };
      if (cursor) body.cursor = cursor;
      const resp = await this.call<{
        channels: Channel[];
        response_metadata?: { next_cursor?: string };
      }>('conversations.list', body);
      out.push(...resp.channels);
      cursor = resp.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out;
  }
}
