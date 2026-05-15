import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { generateSecret, generateURI, verifySync } from 'otplib';
import { db } from './db';

export { generateSecret };

/** Generate a new TOTP secret and QR code data URL for enrollment. */
export async function generateTotpSetup(username: string): Promise<{
  secret: string;
  otpAuthUrl: string;
  qrDataUrl: string;
}> {
  const secret = generateSecret();
  const otpAuthUrl = generateURI({ label: `cortextOS:${username}`, issuer: 'cortextOS', secret });

  const QRCode = (await import('qrcode')).default;
  const qrDataUrl = await QRCode.toDataURL(otpAuthUrl);

  return { secret, otpAuthUrl, qrDataUrl };
}

/** Verify a TOTP token against a secret. Returns true if valid. */
export function verifyTotp(token: string, secret: string): boolean {
  const result = verifySync({ token, secret });
  return result.valid;
}

/** Generate 10 one-time recovery codes, store hashed, return plain-text. */
export function generateRecoveryCodes(userId: number): string[] {
  const codes: string[] = [];
  for (let i = 0; i < 10; i++) {
    codes.push(crypto.randomBytes(8).toString('hex').toUpperCase());
  }

  db.prepare('DELETE FROM totp_recovery_codes WHERE user_id = ?').run(userId);
  for (const code of codes) {
    const hash = bcrypt.hashSync(code, 10);
    db.prepare(
      'INSERT INTO totp_recovery_codes (user_id, code_hash) VALUES (?, ?)',
    ).run(userId, hash);
  }

  return codes;
}

/**
 * Check a recovery code against stored hashes.
 * Marks it used if valid. Returns true if valid.
 */
export function checkAndConsumeRecoveryCode(userId: number, plainCode: string): boolean {
  const rows = db
    .prepare('SELECT id, code_hash FROM totp_recovery_codes WHERE user_id = ? AND used = 0')
    .all(userId) as { id: number; code_hash: string }[];

  for (const row of rows) {
    if (bcrypt.compareSync(plainCode.toUpperCase(), row.code_hash)) {
      db.prepare('UPDATE totp_recovery_codes SET used = 1 WHERE id = ?').run(row.id);
      return true;
    }
  }
  return false;
}
