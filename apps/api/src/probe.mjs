// Internal probe — never ships. Used only by the runtime cert harness.
// Decrypts the merchant webhook secret inside the api process, signs the
// supplied body, and POSTs to /api/checkout/webhook. The plaintext secret
// and the signature never leave the process; only the HTTP response is
// returned on stdout.
import crypto from 'node:crypto';
import pg from '/repo/apps/api/node_modules/pg/lib/index.js';

const body = process.argv[2];
const eventId = process.argv[3];
const url = process.argv[4] ?? 'http://127.0.0.1:5000/api/checkout/webhook';

const KEY = process.env.ENCRYPTION_KEY ?? 'devkey-devkey-devkey-devkey-devkey-devkey01';
const KEY_BUF = crypto.createHash('sha256').update(KEY).digest();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { rows } = await pool.query(
  'SELECT razorpay_webhook_secret_encrypted FROM merchant_credentials LIMIT 1',
);
const blob = rows[0]?.razorpay_webhook_secret_encrypted;
if (!blob) { console.error('no credentials'); process.exit(2); }
const buf = Buffer.from(blob, 'base64');
const iv = buf.subarray(0, 12);
const tag = buf.subarray(12, 28);
const ct = buf.subarray(28);
const dec = crypto.createDecipheriv('aes-256-gcm', KEY_BUF, iv);
dec.setAuthTag(tag);
const secret = Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');

const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');

const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Razorpay-Event-Id': eventId,
    'X-Razorpay-Signature': sig,
  },
  body,
});
const text = await res.text();
console.log('HTTP', res.status, text);
process.exit(0);
