import { afterEach, describe, expect, it } from 'vitest';
import { resolveInstanceId } from '../../../src/cli/resolve-instance-id';
import { startCommand } from '../../../src/cli/start';
import { stopCommand } from '../../../src/cli/stop';
import { restartCommand } from '../../../src/cli/restart';
import { enableAgentCommand, disableAgentCommand } from '../../../src/cli/enable-agent';
import { notifyAgentCommand } from '../../../src/cli/notify-agent';
import { doctorCommand } from '../../../src/cli/doctor';

describe('CLI instance resolution hardening', () => {
  const originalInstance = process.env.CTX_INSTANCE_ID;

  afterEach(() => {
    if (originalInstance === undefined) {
      delete process.env.CTX_INSTANCE_ID;
    } else {
      process.env.CTX_INSTANCE_ID = originalInstance;
    }
  });

  it('prefers the explicit CLI option over the environment', () => {
    process.env.CTX_INSTANCE_ID = 'from-env';
    expect(resolveInstanceId('from-cli')).toBe('from-cli');
  });

  it('falls back to CTX_INSTANCE_ID when the CLI option is omitted', () => {
    process.env.CTX_INSTANCE_ID = 'from-env';
    expect(resolveInstanceId(undefined)).toBe('from-env');
  });

  it('falls back to "default" only when both CLI and env are absent', () => {
    delete process.env.CTX_INSTANCE_ID;
    expect(resolveInstanceId(undefined)).toBe('default');
  });

  it('leaves --instance unset on command objects so env resolution can win', () => {
    expect(startCommand.opts().instance).toBeUndefined();
    expect(stopCommand.opts().instance).toBeUndefined();
    expect(restartCommand.opts().instance).toBeUndefined();
    expect(enableAgentCommand.opts().instance).toBeUndefined();
    expect(disableAgentCommand.opts().instance).toBeUndefined();
    expect(notifyAgentCommand.opts().instance).toBeUndefined();
    expect(doctorCommand.opts().instance).toBeUndefined();
  });
});
