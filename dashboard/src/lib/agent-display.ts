// Sanitizers for IDENTITY.md-sourced display fields. Authors sometimes leave
// template stubs or write full sentences in the Emoji slot ("None — no emojis
// per user preference."), which would otherwise inflate avatars and bleed text
// across card boundaries.

export function sanitizeEmoji(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  if (/[\w\s]/.test(trimmed)) return '';
  return [...trimmed].slice(0, 2).join('');
}

export function sanitizeName(name: string | undefined, systemName: string): string {
  const trimmed = (name ?? '').trim();
  // Only fall back when the name is unusable: empty or still-template HTML markup.
  // Long but legitimate display names ("Banner (Dr. Bruce Banner — …)") are
  // truncated visually by the consumer, not replaced here.
  if (!trimmed || /[<>]/.test(trimmed)) return systemName;
  return trimmed;
}
