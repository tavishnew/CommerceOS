import crypto from 'crypto';

// AES-256-GCM symmetric encryption for at-rest secrets.
// The key is supplied by a single infra-level env var: ENCRYPTION_KEY.
// Format we accept: either a 64-char hex string, or any string ≥ 32 chars
// which we hash to 32 bytes. The hex form is preferred for clarity.

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || raw.length < 16) {
    throw new Error(
      'ENCRYPTION_KEY is not set or too short — set a 32+ char secret in api-server/.env',
    );
  }

  // If it's a 64-char hex string, use it directly; otherwise SHA-256 it.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    cachedKey = Buffer.from(raw, 'hex');
  } else {
    cachedKey = crypto.createHash('sha256').update(raw, 'utf8').digest();
  }
  return cachedKey;
}

/**
 * Encrypt a UTF-8 plaintext string.
 * Output format: base64( iv (12) || tag (16) || ciphertext )
 */
export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

/**
 * Decrypt a value previously produced by encryptSecret().
 * Throws on tamper or wrong key.
 */
export function decryptSecret(payload: string): string {
  const key = loadKey();
  const buf = Buffer.from(payload, 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('Encrypted payload is too short to be valid');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
  return dec.toString('utf8');
}

/**
 * Helper for tests / startup checks.
 */
export function cryptoReady(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}
