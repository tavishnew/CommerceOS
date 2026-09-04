// Transaction correlation + canonical event recording + HMAC evidence.

import crypto from 'crypto';
import type pg from 'pg';

export interface RecordEvent {
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
  return 'TXN-' + crypto.randomBytes(8).toString('base64url').toUpperCase();
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
