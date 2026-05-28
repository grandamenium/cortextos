import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

interface AgentConfig {
  crons: Array<{
    name: string;
    cron?: string;
    prompt?: string;
    metadata?: Record<string, unknown>;
  }>;
}

describe('analyst theta cron config', () => {
  const config = JSON.parse(readFileSync(
    resolve(process.cwd(), 'orgs/revops-global/agents/analyst/config.json'),
    'utf8',
  )) as AgentConfig;

  it('theta-wave cron fires nightly via skill', () => {
    const theta = config.crons.find(cron => cron.name === 'theta-wave');

    expect(theta).toMatchObject({ cron: '0 22 * * *' });
    expect(theta?.prompt).toBeTruthy();
  });
});
