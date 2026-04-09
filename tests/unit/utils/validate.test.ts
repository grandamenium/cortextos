import { describe, it, expect } from 'vitest';
import {
  validateAgentName,
  validateInstanceId,
  validatePriority,
  validateEventCategory,
  validateEventSeverity,
  validateApprovalCategory,
  validateModel,
  isValidJson,
  stripControlChars,
} from '../../../src/utils/validate';

describe('validateInstanceId', () => {
  it('accepts valid instance IDs', () => {
    expect(() => validateInstanceId('default')).not.toThrow();
    expect(() => validateInstanceId('e2e-test')).not.toThrow();
    expect(() => validateInstanceId('ci_test')).not.toThrow();
    expect(() => validateInstanceId('prod')).not.toThrow();
  });

  it('rejects invalid instance IDs', () => {
    expect(() => validateInstanceId('')).toThrow();
    expect(() => validateInstanceId('My Instance')).toThrow(); // spaces
    expect(() => validateInstanceId('instance/bad')).toThrow(); // forward slash breaks Unix socket path
    expect(() => validateInstanceId('instance\\bad')).toThrow(); // backslash breaks Windows named pipe
    expect(() => validateInstanceId('../traversal')).toThrow(); // path traversal
    expect(() => validateInstanceId('Instance')).toThrow(); // uppercase
  });
});

describe('validateAgentName', () => {
  it('accepts valid names', () => {
    expect(() => validateAgentName('paul')).not.toThrow();
    expect(() => validateAgentName('boris-dev')).not.toThrow();
    expect(() => validateAgentName('agent_1')).not.toThrow();
    expect(() => validateAgentName('m2c1-worker')).not.toThrow();
  });

  it('rejects invalid names', () => {
    expect(() => validateAgentName('')).toThrow();
    expect(() => validateAgentName('Agent')).toThrow(); // uppercase
    expect(() => validateAgentName('agent name')).toThrow(); // space
    expect(() => validateAgentName('../traversal')).toThrow(); // path traversal
    expect(() => validateAgentName('agent/path')).toThrow(); // slash
  });

  it('rejects mixed-case / PascalCase / CamelCase (BUG-041 regression)', () => {
    // BUG-041: these names passed through `cortextos add-agent` before the fix,
    // got written to disk, and then failed every `cortextos bus *` command at
    // runtime because `resolveEnv()` validates with the same regex. Lock in
    // the rejection at the validator level so add-agent can rely on it.
    expect(() => validateAgentName('CortextDesigner')).toThrow();
    expect(() => validateAgentName('MyAgent')).toThrow();
    expect(() => validateAgentName('camelCase')).toThrow();
    expect(() => validateAgentName('Agent1')).toThrow();
    expect(() => validateAgentName('tally-Bot')).toThrow();
    expect(() => validateAgentName('snake_Case')).toThrow();
  });
});

describe('validatePriority', () => {
  it('accepts valid priorities', () => {
    expect(() => validatePriority('urgent')).not.toThrow();
    expect(() => validatePriority('high')).not.toThrow();
    expect(() => validatePriority('normal')).not.toThrow();
    expect(() => validatePriority('low')).not.toThrow();
  });

  it('rejects invalid priorities', () => {
    expect(() => validatePriority('medium')).toThrow();
    expect(() => validatePriority('')).toThrow();
  });
});

describe('validateEventCategory', () => {
  it('accepts valid categories', () => {
    const valid = ['action', 'error', 'metric', 'milestone', 'heartbeat', 'message', 'task', 'approval'];
    for (const cat of valid) {
      expect(() => validateEventCategory(cat)).not.toThrow();
    }
  });

  it('rejects invalid categories', () => {
    expect(() => validateEventCategory('invalid')).toThrow();
  });
});

describe('validateEventSeverity', () => {
  it('accepts valid severities', () => {
    for (const sev of ['info', 'warning', 'error', 'critical']) {
      expect(() => validateEventSeverity(sev)).not.toThrow();
    }
  });
});

describe('validateApprovalCategory', () => {
  it('accepts valid categories', () => {
    for (const cat of ['external-comms', 'financial', 'deployment', 'data-deletion', 'other']) {
      expect(() => validateApprovalCategory(cat)).not.toThrow();
    }
  });
});

describe('validateModel', () => {
  it('accepts valid models', () => {
    expect(() => validateModel('claude-opus-4-5-20250514')).not.toThrow();
    expect(() => validateModel('claude-haiku-4-5-20251001')).not.toThrow();
  });

  it('rejects invalid models', () => {
    expect(() => validateModel('model; rm -rf /')).toThrow();
  });
});

describe('stripControlChars', () => {
  it('passes through clean strings unchanged', () => {
    expect(stripControlChars('Hello World')).toBe('Hello World');
    expect(stripControlChars('World')).toBe('World');
    expect(stripControlChars('')).toBe('');
  });

  it('strips ANSI CSI escape sequences', () => {
    expect(stripControlChars('\x1b[31mRed\x1b[0m')).toBe('Red');
    expect(stripControlChars('\x1b[1;32mBold Green\x1b[0m')).toBe('Bold Green');
  });

  it('strips OSC sequences', () => {
    expect(stripControlChars('\x1b]0;title\x07text')).toBe('text');
  });

  it('strips other ESC sequences', () => {
    expect(stripControlChars('\x1bcReset')).toBe('Reset');
  });

  it('strips C0 control characters but preserves newlines and tabs', () => {
    // null byte stripped
    expect(stripControlChars('a\x00b')).toBe('ab');
    // bell stripped
    expect(stripControlChars('a\x07b')).toBe('ab');
  });

  it('protects against Telegram sender name injection', () => {
    const malicious = '\x1b[31mEvil\x1b[0m';
    expect(stripControlChars(malicious)).toBe('Evil');
  });
});

describe('isValidJson', () => {
  it('detects valid JSON', () => {
    expect(isValidJson('{}')).toBe(true);
    expect(isValidJson('{"key":"value"}')).toBe(true);
    expect(isValidJson('[]')).toBe(true);
  });

  it('detects invalid JSON', () => {
    expect(isValidJson('')).toBe(false);
    expect(isValidJson('not json')).toBe(false);
    expect(isValidJson('{invalid}')).toBe(false);
  });
});
