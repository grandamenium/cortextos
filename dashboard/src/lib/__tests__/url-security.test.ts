import { describe, expect, it } from 'vitest';
import {
  isSafeHttpUrl,
  resolveSafeSameOriginCallbackUrl,
} from '../url-security';

describe('resolveSafeSameOriginCallbackUrl', () => {
  it('accepts same-origin relative paths', () => {
    expect(
      resolveSafeSameOriginCallbackUrl('/tasks?org=acme', 'https://dashboard.example.com'),
    ).toBe('/tasks?org=acme');
  });

  it('accepts same-origin absolute URLs and normalizes them to a local path', () => {
    expect(
      resolveSafeSameOriginCallbackUrl(
        'https://dashboard.example.com/tasks#details',
        'https://dashboard.example.com',
      ),
    ).toBe('/tasks#details');
  });

  it('rejects cross-origin and script-scheme callback URLs', () => {
    expect(
      resolveSafeSameOriginCallbackUrl(
        '//evil.example.com/phish',
        'https://dashboard.example.com',
      ),
    ).toBe('/');
    expect(
      resolveSafeSameOriginCallbackUrl(
        'javascript:alert(1)',
        'https://dashboard.example.com',
      ),
    ).toBe('/');
  });
});

describe('isSafeHttpUrl', () => {
  it('accepts http and https URLs only', () => {
    expect(isSafeHttpUrl('https://example.com')).toBe(true);
    expect(isSafeHttpUrl('http://example.com')).toBe(true);
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('data:text/html,boom')).toBe(false);
  });
});
