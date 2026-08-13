import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SlackAPI } from '../../../src/slack/api';

describe('SlackAPI', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as any;
  });

  describe('postMessage', () => {
    it('POSTs to chat.postMessage with the bot token and json body', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, channel: 'C1', ts: '1.0' }),
      });
      const api = new SlackAPI('xoxb-abc');
      const res = await api.postMessage({ channel: 'C1', text: 'hello' });
      expect(res).toEqual({ ok: true, channel: 'C1', ts: '1.0' });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://slack.com/api/chat.postMessage',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer xoxb-abc',
            'Content-Type': 'application/json; charset=utf-8',
          }),
          body: JSON.stringify({ channel: 'C1', text: 'hello' }),
        }),
      );
    });

    it('throws on Slack API error (ok=false)', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ ok: false, error: 'channel_not_found' }),
      });
      const api = new SlackAPI('xoxb-abc');
      await expect(api.postMessage({ channel: 'C1', text: 'x' })).rejects.toThrow(
        /channel_not_found/,
      );
    });

    it('passes through username and icon_emoji overrides', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, channel: 'C1', ts: '1' }) });
      const api = new SlackAPI('xoxb-abc');
      await api.postMessage({
        channel: 'C1', text: 'hi', username: 'boss', icon_emoji: ':robot_face:',
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.username).toBe('boss');
      expect(body.icon_emoji).toBe(':robot_face:');
    });
  });

  describe('listChannels', () => {
    it('paginates with next_cursor until empty', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            channels: [{ id: 'C1', name: 'general' }],
            response_metadata: { next_cursor: 'CURSOR' },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            channels: [{ id: 'C2', name: 'random' }],
            response_metadata: { next_cursor: '' },
          }),
        });
      const api = new SlackAPI('xoxb-abc');
      const channels = await api.listChannels();
      expect(channels.map((c) => c.id)).toEqual(['C1', 'C2']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
