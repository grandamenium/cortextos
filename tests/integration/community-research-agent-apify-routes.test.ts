import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

describe('community research agent Apify routes', () => {
  it('preserves the existing X route and bounds optional Xquik routes', () => {
    const sources = JSON.parse(
      read('community/agents/research-agent/research/sources.example.json'),
    ) as {
      apify_social: {
        _note: string;
        x: {
          actor: string;
          search_actor: string;
          follower_actor: string;
          audience_enabled: boolean;
          max_audience_items: number;
          max_audience_items_per_target: number;
        };
      };
    };
    const x = sources.apify_social.x;

    expect(sources.apify_social._note).toContain('process environment');
    expect(x.actor).toBe('fastdata~twitter-scraper');
    expect(x.search_actor).toBe('xquik~x-tweet-scraper');
    expect(x.follower_actor).toBe('xquik~x-follower-scraper');
    expect(x.audience_enabled).toBe(false);
    expect(x.max_audience_items).toBeGreaterThan(0);
    expect(x.max_audience_items_per_target).toBeGreaterThan(0);
  });

  it('documents stable Actor identities and the paid-run gate', () => {
    const reference = read(
      'community/agents/research-agent/.claude/skills/source-collection/references/xquik-apify-actors.md',
    );

    expect(reference).toContain('wAusCMrm284Voaw86');
    expect(reference).toContain('AaT0BcKU5GQh97wdt');
    expect(reference).toContain('## Paid-Run Gate');
    expect(reference).toContain('Obtain explicit approval.');
  });
});
