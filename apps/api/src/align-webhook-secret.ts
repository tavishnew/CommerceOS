// Align the merchant_credentials.webhook_secret with the test secret.
// Run inside the api container with the same ENCRYPTION_KEY the API uses.

import crypto from 'crypto';
import pg from 'pg';

const TARGET = process.argv[2] ?? 'XXXXXXXXXXXXXXXX';
const KEY = process.env.ENCRYPTION_KEY ?? 'devkey-devkey-devkey-devkey-devkey-devkey01';

function loadKey(): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(KEY)) return Buffer.from(KEY, 'hex');
  return crypto.createHash('sha256').update(KEY, 'utf8').digest();
}
function encryptSecret(plaintext: string): string {
  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to align the webhook secret.');
}
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});
const enc = encryptSecret(TARGET);
await pool.query(
  `UPDATE merchant_credentials
      SET razorpay_webhook_secret_encrypted = $1,
          updated_at = NOW()
    WHERE merchant_id = 'default'`,
  [enc],
);
console.log('updated merchant_credentials to align with', TARGET);
await pool.end();
