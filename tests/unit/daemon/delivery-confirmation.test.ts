import { describe, it, expect, vi } from 'vitest';
import { injectMessageConfirmed, KEYS } from '../../../src/pty/inject.js';

// No real timers: inject a zero-delay sleep and drive confirmation state.
const instantSleep = () => Promise.resolve();

describe('injectMessageConfirmed', () => {
  it('confirms on first Enter when the turn-start signal appears', async () => {
    const writes: string[] = [];
    let submitted = false;
    const res = await injectMessageConfirmed(
      d => {
        writes.push(d);
        if (d === KEYS.ENTER) submitted = true;
      },
      'hello',
      { isConfirmed: () => submitted, sleep: instantSleep },
    );
    expect(res).toEqual({ confirmed: true, enterAttempts: 1 });
    expect(writes[0]).toContain('hello');
    expect(writes.filter(w => w === KEYS.ENTER)).toHaveLength(1);
  });

  it('retries Enter when the first submit is dropped, then confirms', async () => {
    const writes: string[] = [];
    let enters = 0;
    let submitted = false;
    const res = await injectMessageConfirmed(
      d => {
        writes.push(d);
        if (d === KEYS.ENTER) {
          enters++;
          if (enters === 2) submitted = true; // first Enter dropped, second lands
        }
      },
      'stall-class message',
      { isConfirmed: () => submitted, sleep: instantSleep },
    );
    expect(res).toEqual({ confirmed: true, enterAttempts: 2 });
    expect(writes.filter(w => w === KEYS.ENTER)).toHaveLength(2);
  });

  it('gives up after maxEnterAttempts and reports confirmed:false (DELIVERY_FAILED)', async () => {
    const logs: string[] = [];
    const res = await injectMessageConfirmed(
      () => {},
      'never submits',
      { isConfirmed: () => false, sleep: instantSleep, maxEnterAttempts: 3, log: m => logs.push(m) },
    );
    expect(res).toEqual({ confirmed: false, enterAttempts: 3 });
    expect(logs.join('\n')).toMatch(/no turn-start signal/);
  });

  it('chunked paste for large content still runs the confirmation loop', async () => {
    const writes: string[] = [];
    let submitted = false;
    const big = 'x'.repeat(10_000);
    const res = await injectMessageConfirmed(
      d => {
        writes.push(d);
        if (d === KEYS.ENTER) submitted = true;
      },
      big,
      { isConfirmed: () => submitted, sleep: instantSleep },
    );
    expect(res.confirmed).toBe(true);
    expect(writes.join('').includes(big)).toBe(true);
  });

  it('a torn PTY on Enter returns confirmed:false instead of throwing', async () => {
    let pasted = false;
    const res = await injectMessageConfirmed(
      d => {
        if (d === KEYS.ENTER) throw new Error('pty torn down');
        pasted = true;
      },
      'msg',
      { isConfirmed: () => false, sleep: instantSleep, log: () => {} },
    );
    expect(pasted).toBe(true);
    expect(res.confirmed).toBe(false);
  });

  it('worst-case wall clock stays within the 30s delivery gate (3 × 9s + delay)', async () => {
    // Sum the sleeps the loop would take instead of running real timers.
    let totalMs = 0;
    const accountingSleep = (ms: number) => { totalMs += ms; return Promise.resolve(); };
    await injectMessageConfirmed(() => {}, 'x', {
      isConfirmed: () => false,
      sleep: accountingSleep,
    });
    expect(totalMs).toBeLessThanOrEqual(30_000);
  });
});

describe('fast-checker ack-on-confirm contract', () => {
  // The pollCycle ack rule: ack when ok && confirmed !== false.
  const shouldAck = (r: { ok: boolean; confirmed: boolean | null }) => r.ok && r.confirmed !== false;

  it('acks on confirmed delivery', () => {
    expect(shouldAck({ ok: true, confirmed: true })).toBe(true);
  });
  it('acks on legacy path (no confirmation channel)', () => {
    expect(shouldAck({ ok: true, confirmed: null })).toBe(true);
  });
  it('does NOT ack on DELIVERY_FAILED — message must redeliver', () => {
    expect(shouldAck({ ok: true, confirmed: false })).toBe(false);
  });
  it('does NOT ack when injection itself failed', () => {
    expect(shouldAck({ ok: false, confirmed: null })).toBe(false);
  });
});

describe('MessageDedup.forget — redelivery after DELIVERY_FAILED', () => {
  it('forgotten content can inject again; unforgotten stays deduped', async () => {
    const { MessageDedup } = await import('../../../src/pty/inject.js');
    const dedup = new MessageDedup();
    expect(dedup.isDuplicate('msg-a')).toBe(false); // first sight records it
    expect(dedup.isDuplicate('msg-a')).toBe(true);  // redelivery would be dropped
    dedup.forget('msg-a');
    expect(dedup.isDuplicate('msg-a')).toBe(false); // retry path open again
    expect(dedup.isDuplicate('msg-a')).toBe(true);
  });

  it('forget of unseen content is a no-op', async () => {
    const { MessageDedup } = await import('../../../src/pty/inject.js');
    const dedup = new MessageDedup();
    dedup.forget('never-seen');
    expect(dedup.isDuplicate('other')).toBe(false);
  });
});
