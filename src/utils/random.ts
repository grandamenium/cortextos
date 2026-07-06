import { randomBytes } from 'crypto';

// Lowercase alphanumeric character set used for generating standard unique identifiers.
const ALPHA_NUMERIC = 'abcdefghijklmnopqrstuvwxyz0123456789';
const DIGITS = '0123456789';

export function randomString(length: number): string {
  const bytes = randomBytes(length * 2);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += ALPHA_NUMERIC[bytes[i] % ALPHA_NUMERIC.length];
  }
  return result;
}

export function randomDigits(length: number): string {
  const bytes = randomBytes(length * 2);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += DIGITS[bytes[i] % DIGITS.length];
  }
  return result;
}
