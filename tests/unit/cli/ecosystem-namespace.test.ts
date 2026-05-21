import { describe, it, expect } from 'vitest';
import { pm2ProcessName } from '../../../src/cli/ecosystem';

describe('pm2ProcessName', () => {
  it('uses the bare name for a shared agent', () => {
    expect(pm2ProcessName('wyre', 'boss')).toBe('wyre-boss');
  });

  it('qualifies a namespaced agent with the engineer segment', () => {
    expect(pm2ProcessName('wyre', 'aaron/dev')).toBe('wyre-aaron-dev');
  });

  it('never collides a shared agent with a namespaced one of the same leaf', () => {
    expect(pm2ProcessName('wyre', 'dev')).not.toBe(pm2ProcessName('wyre', 'aaron/dev'));
  });
});
