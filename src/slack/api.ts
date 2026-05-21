/**
 * Slack Web API client using built-in fetch (Node.js 20+).
 * No external dependencies beyond Node built-ins.
 *
 * Covers:
 *   chat.postMessage  - text + blocks + thread_ts
 *   files.uploadV2    - file upload with optional initial_comment caption
 */

export interface SlackPostResult {
  ok: true;
  ts: string;
  channel: string;
  message: { text: string };
}

export interface SlackErrorResult {
  ok: false;
  error: string;
}

export type SlackResult = SlackPostResult | SlackErrorResult;

export class SlackAPI {
  private readonly baseUrl = 'https://slack.com/api';

  constructor(private readonly token: string) {}

  async postMessage(opts: {
    channel: string;
    text: string;
    blocks?: unknown[];
    threadTs?: string;
    mrkdwn?: boolean;
  }): Promise<SlackResult> {
    const body: Record<string, unknown> = {
      channel: opts.channel,
      text: opts.text,
      mrkdwn: opts.mrkdwn ?? true,
    };
    if (opts.blocks) body.blocks = opts.blocks;
    if (opts.threadTs) body.thread_ts = opts.threadTs;

    const resp = await fetch(`${this.baseUrl}/chat.postMessage`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      return { ok: false, error: `http_${resp.status}` };
    }
    return resp.json() as Promise<SlackResult>;
  }

  async uploadFile(opts: {
    channel: string;
    filePath: string;
    initialComment?: string;
    threadTs?: string;
  }): Promise<SlackResult> {
    const { readFileSync, statSync } = await import('fs');
    const { basename } = await import('path');

    // Step 1: get upload URL
    const filename = basename(opts.filePath);
    const fileBytes = readFileSync(opts.filePath);
    const length = statSync(opts.filePath).size;

    const urlResp = await fetch(`${this.baseUrl}/files.getUploadURLExternal`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ filename, length }),
    });
    if (!urlResp.ok) return { ok: false, error: `http_${urlResp.status}` };
    const urlData = await urlResp.json() as { ok: boolean; upload_url?: string; file_id?: string; error?: string };
    if (!urlData.ok || !urlData.upload_url || !urlData.file_id) {
      return { ok: false, error: urlData.error ?? 'get_upload_url_failed' };
    }

    // Step 2: upload bytes
    const uploadResp = await fetch(urlData.upload_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: fileBytes,
    });
    if (!uploadResp.ok) return { ok: false, error: `upload_http_${uploadResp.status}` };

    // Step 3: complete upload
    const completeBody: Record<string, unknown> = {
      files: [{ id: urlData.file_id }],
      channel_id: opts.channel,
    };
    if (opts.initialComment) completeBody.initial_comment = opts.initialComment;
    if (opts.threadTs) completeBody.thread_ts = opts.threadTs;

    const completeResp = await fetch(`${this.baseUrl}/files.completeUploadExternal`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(completeBody),
    });
    if (!completeResp.ok) return { ok: false, error: `complete_http_${completeResp.status}` };
    const completeData = await completeResp.json() as { ok: boolean; files?: Array<{ id: string }>; error?: string };
    if (!completeData.ok) return { ok: false, error: completeData.error ?? 'complete_failed' };
    return { ok: true, ts: Date.now().toString(), channel: opts.channel, message: { text: opts.initialComment ?? '' } };
  }
}
