// Transaction correlation + canonical event recording + HMAC evidence.

import crypto from 'crypto';
import type pg from 'pg';
import type { PoolClient } from 'pg';

export interface RecordEvent {
  // Either a pool or a pool client. Client is used when the event must
  // commit atomically with another state change; the helper writes
  // through whichever handle is supplied.
  pool: pg.Pool | pg.PoolClient;
  txnId?: string | null;
  workspaceId?: string | null;
  sessionId?: string | null;
  actor: string;
  action: string;
  detail?: string | null;
  amount?: number | null;
  outcome?: string;
  policy?: unknown;
  // When true, a DB error during insert THROWS so the surrounding tx
  // rolls back. Use for money / state-critical events.
  // When false (default), the error is logged and the function returns —
  // best-effort for trace/activity/observability emissions.
  strict?: boolean;
}

export function newTxnId(): string {
  // 8 random bytes → 13-char base32 (no padding). No Math.random — uses
  // node:crypto so the value is unpredictable across processes.
  return 'TXN-' + crypto.randomBytes(8).toString('base64url').toUpperCase();
}

// Stable JSON serialisation — sort keys recursively so HMAC is reproducible.
function canonicalize(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) throw new Error('cycle in canonical input');
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = walk((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

function evidenceSecret(): string {
  // Derive a deterministic sub-key from ENCRYPTION_KEY so rotating the master
  // also rotates evidence signatures. Falls back to a fixed dev key when
  // ENCRYPTION_KEY is not set; behaviour is identical locally.
  const base = process.env.ENCRYPTION_KEY ?? 'dev-evidence-secret';
  return crypto.createHash('sha256').update('evidence:' + base).digest('hex');
}

export function signEvidence(payload: unknown): string {
  const json = canonicalize(payload);
  return crypto.createHmac('sha256', evidenceSecret()).update(json).digest('hex');
}

export function verifyEvidence(payload: unknown, signature: string): boolean {
  const expected = signEvidence(payload);
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export async function recordEvent(ev: RecordEvent): Promise<void> {
  try {
    await ev.pool.query(
      `INSERT INTO audit_log
         (transaction_id, workspace_id, session_id, actor, action, detail, amount, outcome, policy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        ev.txnId ?? null,
        ev.workspaceId ?? null,
        ev.sessionId ?? null,
        ev.actor,
        ev.action,
        ev.detail ?? null,
        ev.amount ?? null,
        ev.outcome ?? 'info',
        ev.policy != null ? JSON.stringify(ev.policy) : null,
      ],
    );
  } catch (err) {
    if (ev.strict) throw err;
    console.error('recordEvent failed:', err);
  }
}

/**
 * Outbox helpers. Persist a protocol/A2A/ACP event into the same DB
 * transaction as the business mutation. The publisher polls
 * outbox_events and dispatches them. This guarantees a business commit
 * either happens with its outbound event or neither.
 */
export interface OutboxEvent {
  pool: pg.Pool | pg.PoolClient;
  transactionId: string;
  workspaceId: string;
  protocol: 'a2a' | 'acp' | 'system';
  action: string;
  payload: unknown;
  /** Caller's tx client if writing inside an outer tx. */
  client?: PoolClient;
}

export async function emitProtocolEventTx(ev: OutboxEvent): Promise<void> {
  const handle = ev.client ?? ev.pool;
  await handle.query(
    `INSERT INTO outbox_events
       (transaction_id, workspace_id, protocol, action, payload, attempts)
     VALUES ($1, $2, $3, $4, $5::jsonb, 0)`,
    [ev.transactionId, ev.workspaceId, ev.protocol, ev.action, JSON.stringify(ev.payload)],
  );
}