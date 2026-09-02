// PG outbox for A2A/ACP events.
//
// Schema:
//   outbox_events(
//     id            BIGSERIAL PRIMARY KEY,
//     transaction_id TEXT NOT NULL,
//     workspace_id   TEXT NOT NULL,
//     protocol       TEXT NOT NULL,  -- 'a2a' | 'acp' | 'system'
//     action         TEXT NOT NULL,
//     payload        JSONB NOT NULL,
//     created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
//     published_at   TIMESTAMPTZ,
//     attempts       INT NOT NULL DEFAULT 0,
//     last_error     TEXT,
//     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
//   );
//
// Lifecycle:
//   1. emitProtocolEventTx(client, ev) inserts inside the business tx.
//   2. publishOutboxBatch() picks up rows with published_at IS NULL AND
//      next_attempt_at <= NOW(), dispatches via the configured transport,
//      marks published_at on success, schedules retry on failure.
//   3. Transport is pluggable; default is a no-op that just marks rows
//      published (the audit_log row already exists for /api/activity).
//      Real A2A/ACP delivery is wired in by passing `dispatch` to startOutbox().

import type { Pool, PoolClient } from 'pg';

export type OutboxProtocol = 'a2a' | 'acp' | 'system';

export interface OutboxRow {
  id: number;
  transactionId: string;
  workspaceId: string;
  protocol: OutboxProtocol;
  action: string;
  payload: unknown;
  attempts: number;
}

export interface OutboxDispatch {
  (row: OutboxRow): Promise<void>;
}

export async function ensureOutboxTable(pool: Pool | PoolClient): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outbox_events (
      id              BIGSERIAL PRIMARY KEY,
      transaction_id  TEXT NOT NULL,
      workspace_id    TEXT NOT NULL,
      protocol        TEXT NOT NULL,
      action          TEXT NOT NULL,
      payload         JSONB NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      published_at    TIMESTAMPTZ,
      attempts        INT NOT NULL DEFAULT 0,
      last_error      TEXT,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_outbox_pending
       ON outbox_events (next_attempt_at)
     WHERE published_at IS NULL`,
  );
}

export async function publishOutboxBatch(
  pool: Pool,
  dispatch: OutboxDispatch,
  batchSize = 25,
): Promise<{ published: number; failed: number }> {
  // Lock the next batch. SKIP LOCKED keeps concurrent publishers from
  // stepping on each other.
  const client = await pool.connect();
  let published = 0;
  let failed = 0;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{
      id: number;
      transaction_id: string;
      workspace_id: string;
      protocol: OutboxProtocol;
      action: string;
      payload: unknown;
      attempts: number;
    }>(
      `SELECT id, transaction_id, workspace_id, protocol, action, payload, attempts
         FROM outbox_events
        WHERE published_at IS NULL AND next_attempt_at <= NOW()
        ORDER BY id
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );

    for (const r of rows) {
      try {
        await dispatch({
          id: r.id,
          transactionId: r.transaction_id,
          workspaceId: r.workspace_id,
          protocol: r.protocol,
          action: r.action,
          payload: r.payload,
          attempts: r.attempts,
        });
        await client.query(
          `UPDATE outbox_events
              SET published_at = NOW(), attempts = attempts + 1
            WHERE id = $1`,
          [r.id],
        );
        published += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Exponential backoff capped at 5 min, jitter ±10%.
        const backoffSec = Math.min(300, 5 * Math.pow(2, r.attempts));
        const jitter = backoffSec * (0.9 + Math.random() * 0.2);
        await client.query(
          `UPDATE outbox_events
              SET attempts = attempts + 1,
                  last_error = $2,
                  next_attempt_at = NOW() + ($3 || ' seconds')::interval
            WHERE id = $1`,
          [r.id, msg.slice(0, 1000), String(Math.round(jitter))],
        );
        failed += 1;
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* swallow */ }
    throw err;
  } finally {
    client.release();
  }
  return { published, failed };
}

/**
 * Start the outbox publisher loop. Default: no-op dispatcher (rows are
 * marked published, the audit log is the source of truth for /api/activity).
 * Pass a real `dispatch` to wire A2A/ACP HTTP delivery.
 */
export function startOutbox(
  pool: Pool,
  opts: { dispatch?: OutboxDispatch; intervalMs?: number } = {},
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? 5_000;
  const dispatch: OutboxDispatch =
    opts.dispatch ??
    (async () => {
      // Default transport: the audit row already records the event; we
      // just acknowledge the outbox row so it doesn't pile up.
    });
  let running = true;
  const tick = async () => {
    if (!running) return;
    try {
      await publishOutboxBatch(pool, dispatch);
    } catch (err) {
      console.error('outbox publish error:', err);
    }
    if (running) setTimeout(tick, intervalMs);
  };
  setTimeout(tick, intervalMs);
  return {
    stop: () => {
      running = false;
    },
  };
}
