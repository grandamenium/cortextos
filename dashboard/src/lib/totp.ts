import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { generateSecret, generateURI, verifySync } from 'otplib';
import { sql } from './db';

export { generateSecret };

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

export function verifyTotp(token: string, secret: string): boolean {
  const result = verifySync({ token, secret });
  return result.valid;
}

export async function generateRecoveryCodes(userId: number): Promise<string[]> {
  const codes: string[] = [];
  for (let i = 0; i < 10; i++) {
    codes.push(crypto.randomBytes(8).toString('hex').toUpperCase());
  }
  await sql`DELETE FROM totp_recovery_codes WHERE user_id = ${userId}`;
  for (const code of codes) {
    const hash = bcrypt.hashSync(code, 10);
    await sql`INSERT INTO totp_recovery_codes (user_id, code_hash) VALUES (${userId}, ${hash})`;
  }
  return codes;
}

export async function checkAndConsumeRecoveryCode(userId: number, plainCode: string): Promise<boolean> {
  const rows = await sql<{ id: number; code_hash: string }[]>`
    SELECT id, code_hash FROM totp_recovery_codes WHERE user_id = ${userId} AND used = 0
  `;
  for (const row of rows) {
    if (bcrypt.compareSync(plainCode.toUpperCase(), row.code_hash)) {
      await sql`UPDATE totp_recovery_codes SET used = 1 WHERE id = ${row.id}`;
      return true;
    }
  }
  return false;
}
