export function resolveSafeSameOriginCallbackUrl(
  callbackUrl: string | null,
  origin: string,
): string {
  if (!callbackUrl) return '/';

  try {
    const parsed = new URL(callbackUrl, origin);
    if (parsed.origin !== origin) {
      return '/';
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || '/';
  } catch {
    return '/';
  }
}

export function isSafeHttpUrl(value: string | null | undefined): boolean {
  if (!value) return false;

  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
