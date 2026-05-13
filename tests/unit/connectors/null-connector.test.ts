import { describe, it, expect } from 'vitest';
import { NullConnector } from '../../../src/connectors/index.js';

describe('NullConnector', () => {
  it('validates trivially with a descriptive identity', async () => {
    const c = new NullConnector();
    const result = await c.validateCredentials();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity).toContain('null-connector');
    }
  });

  it('sendMessage is a silent no-op that returns a stable shape', async () => {
    const c = new NullConnector();
    const res = await c.sendMessage('hello world');
    expect(res.id).toBe('noop');
    expect(typeof res.ts).toBe('number');
  });

  it('sendMedia is a silent no-op', async () => {
    const c = new NullConnector();
    const res = await c.sendMedia({ localPath: '/tmp/x.jpg', kind: 'photo' });
    expect(res.id).toBe('noop');
  });

  it('startPolling resolves immediately without throwing', async () => {
    const c = new NullConnector();
    // SYNC handler — the contract is sync ()=>void
    await c.startPolling({ onMessage: () => {} });
  });

  it('stopPolling is a no-op even when startPolling was never called', async () => {
    const c = new NullConnector();
    await c.stopPolling(); // must not throw
  });
});
