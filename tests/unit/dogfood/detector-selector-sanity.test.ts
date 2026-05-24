import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(__dirname, '../../..');

const detectorFiles = [
  'scripts/dogfood-band-a.ts',
  'scripts/dogfood-band-b.ts',
  'scripts/dogfood-band-c.ts',
  'scripts/dogfood-band-d.ts',
  'scripts/dogfood-band-e.ts',
  'scripts/dogfood-band-f.ts',
  'scripts/estate-visual-qa.ts',
  'scripts/check-listening-pill-detector.ts',
];

const riskyPatterns = [
  /\[class\*=["'][^"']*(?:card|button|modal|pill)/i,
  /\[class\*=[^,\]\s]*(?:card|button|modal|pill)/i,
  /querySelectorAll\([^)]*\[class\*=["'][^"']*(?:card|button|modal|pill)/i,
];

describe('hub-dogfood detector selector sanity', () => {
  it('does not use broad substring class selectors for detector-critical card/button/modal/pill matches', () => {
    const offenders: string[] = [];

    for (const file of detectorFiles) {
      const source = readFileSync(join(repoRoot, file), 'utf8')
        .split('\n')
        .filter(line => !line.trim().startsWith('//'))
        .join('\n');

      for (const pattern of riskyPatterns) {
        if (pattern.test(source)) offenders.push(`${file}: ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
