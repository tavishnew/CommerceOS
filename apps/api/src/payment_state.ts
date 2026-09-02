// Canonical payment-state transitions.
//
// ONE implementation. Webhook, /api/checkout/verify, and reconciliation all
// route through `markPaid` / `markFailed` / `markRefunded`. The transaction
// caller is responsible for the surrounding tx (so the state mutation, the
// audit row, and (optionally) the outbox row commit atomically).
//
// Source states are an explicit allowlist. A webhook on a pending_human_review
// order CANNOT flip it to paid — only human_approved or pending can. This
// matches the human-approval gate: a buyer agent that puts a basket in
// pending_human_review must wait for a real human to flip it before Razorpay
// can confirm the charge.

import type { PoolClient } from 'pg';

export interface PaymentEvent {
  orderId: number;
  transactionId: string | null;
  workspaceId: string | null;
  amount: number | null;
  razorpayPaymentId?: string | null;
  razorpayRefundId?: string | null;
  actor: string;            // 'razorpay_webhook' | 'merchant' | 'system' | 'buyer'
  detail: string;
  outcome: string;          // 'success' | 'failed' | 'recovered' | 'info'
}

export interface TransitionResult {
  /** 'transitioned' if a row flipped; 'noop' if the order was already in the target state or in a non-allowlisted source state. */
  outcome: 'transitioned' | 'noop' | 'blocked';
  status: string;           // the order's current status after the call
  reason?: string;
}

async function insertAudit(
  client: PoolClient,
  ev: PaymentEvent,
  action: string,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log
       (transaction_id, workspace_id, actor, action, detail, amount, outcome)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [ev.transactionId, ev.workspaceId, ev.actor, action, ev.detail, ev.amount, ev.outcome],
  );
}

export async function markPaid(
  client: PoolClient,
  ev: PaymentEvent,
): Promise<TransitionResult> {
  const updated = await client.query<{ id: number; status: string }>(
    `UPDATE orders
        SET status = 'paid',
            razorpay_payment_id = COALESCE($2, razorpay_payment_id)
      WHERE id = $1
        AND status = ANY($3::text[])
      RETURNING id, status`,
    [ev.orderId, ev.razorpayPaymentId ?? null, ['human_approved', 'pending']],
  );
  if (updated.rowCount === 0) {
    // Distinguish "already paid" (noop) from "blocked by state" (e.g.
    // pending_human_review). Caller decides how to surface.
    const cur = await client.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1`,
      [ev.orderId],
    );
    const status = cur.rows[0]?.status ?? 'unknown';
    if (status === 'paid') return { outcome: 'noop', status };
    return { outcome: 'blocked', status, reason: `paid requires source ∈ {human_approved, pending}; got ${status}` };
  }
  await insertAudit(client, ev, 'payment_captured');
  return { outcome: 'transitioned', status: 'paid' };
}

export async function markFailed(
  client: PoolClient,
  ev: PaymentEvent,
): Promise<TransitionResult> {
  const updated = await client.query<{ id: number; status: string }>(
    `UPDATE orders
        SET status = 'failed'
      WHERE id = $1
        AND status = ANY($2::text[])
      RETURNING id, status`,
    [ev.orderId, ['human_approved', 'pending_human_review', 'pending']],
  );
  if (updated.rowCount === 0) {
    const cur = await client.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1`,
      [ev.orderId],
    );
    const status = cur.rows[0]?.status ?? 'unknown';
    if (status === 'failed') return { outcome: 'noop', status };
    return { outcome: 'blocked', status, reason: `failed requires source ∈ {human_approved, pending_human_review, pending}; got ${status}` };
  }
  await insertAudit(client, { ...ev, outcome: ev.outcome || 'failed' }, 'payment_failed');
  return { outcome: 'transitioned', status: 'failed' };
}

export async function markRefunded(
  client: PoolClient,
  ev: PaymentEvent,
): Promise<TransitionResult> {
  const updated = await client.query<{ id: number; status: string }>(
    `UPDATE orders
        SET status = 'refunded',
            razorpay_refund_id = COALESCE($2, razorpay_refund_id),
            razorpay_refund_amount = COALESCE($3, razorpay_refund_amount)
      WHERE id = $1
        AND status = ANY($4::text[])
      RETURNING id, status`,
    [ev.orderId, ev.razorpayRefundId ?? null, ev.amount, ['paid', 'shipped']],
  );
  if (updated.rowCount === 0) {
    const cur = await client.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1`,
      [ev.orderId],
    );
    const status = cur.rows[0]?.status ?? 'unknown';
    if (status === 'refunded') return { outcome: 'noop', status };
    return { outcome: 'blocked', status, reason: `refund requires source ∈ {paid, shipped}; got ${status}` };
  }
  await insertAudit(client, { ...ev, outcome: ev.outcome || 'success' }, 'refund_processed');
  return { outcome: 'transitioned', status: 'refunded' };
}

/**
 * Mark an order as refund_requested. This is the FIRST half of a two-phase
 * refund: we flip `paid|disputed → refund_requested`, then Razorpay's
 * async confirm drives the second transition (`refund_requested → refunded`).
 */
export async function markRefundRequested(
  client: PoolClient,
  ev: PaymentEvent & {
    refundAmount: number;
    refundRequestedAt: string;
  },
): Promise<TransitionResult> {
  const updated = await client.query<{ id: number; status: string }>(
    `UPDATE orders
        SET status = 'refund_requested',
            refund_requested_at = $2,
            razorpay_refund_amount = $3
      WHERE id = $1
        AND status = ANY($4::text[])
      RETURNING id, status`,
    [ev.orderId, ev.refundRequestedAt, ev.refundAmount, ['paid', 'disputed']],
  );
  if (updated.rowCount === 0) {
    const cur = await client.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1`,
      [ev.orderId],
    );
    const status = cur.rows[0]?.status ?? 'unknown';
    if (status === 'refund_requested') return { outcome: 'noop', status };
    return { outcome: 'blocked', status, reason: `refund_requested requires source ∈ {paid, disputed}; got ${status}` };
  }
  await insertAudit(client, { ...ev, outcome: ev.outcome || 'pending' }, 'refund_requested');
  return { outcome: 'transitioned', status: 'refund_requested' };
}

/**
 * Mark an order as refund_failed. Razorpay rejected (or never saw) the
 * refund — surface that as a terminal failure so the merchant can retry.
 */
export async function markRefundFailed(
  client: PoolClient,
  ev: PaymentEvent & { refundAmount: number },
): Promise<TransitionResult> {
  const updated = await client.query<{ id: number; status: string }>(
    `UPDATE orders
        SET status = 'refund_failed',
            razorpay_refund_amount = COALESCE($2, razorpay_refund_amount)
      WHERE id = $1
        AND status = ANY($3::text[])
      RETURNING id, status`,
    [ev.orderId, ev.refundAmount, ['refund_requested']],
  );
  if (updated.rowCount === 0) {
    const cur = await client.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1`,
      [ev.orderId],
    );
    const status = cur.rows[0]?.status ?? 'unknown';
    if (status === 'refund_failed') return { outcome: 'noop', status };
    return { outcome: 'blocked', status, reason: `refund_failed requires source ∈ {refund_requested}; got ${status}` };
  }
  await insertAudit(client, { ...ev, outcome: ev.outcome || 'failed' }, 'refund_failed');
  return { outcome: 'transitioned', status: 'refund_failed' };
}

/**
 * Mark an order as disputed. A dispute is the buyer's escalation of a paid
 * order, which the merchant must then resolve (refund, replace, or reject).
 */
export async function markDisputed(
  client: PoolClient,
  ev: PaymentEvent & { reason: string },
): Promise<TransitionResult> {
  const updated = await client.query<{ id: number; status: string }>(
    `UPDATE orders
        SET status = 'disputed',
            dispute_reason = $2
      WHERE id = $1
        AND status = ANY($3::text[])
      RETURNING id, status`,
    [ev.orderId, ev.reason, ['paid']],
  );
  if (updated.rowCount === 0) {
    const cur = await client.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1`,
      [ev.orderId],
    );
    const status = cur.rows[0]?.status ?? 'unknown';
    if (status === 'disputed') return { outcome: 'noop', status };
    return { outcome: 'blocked', status, reason: `disputed requires source ∈ {paid}; got ${status}` };
  }
  await insertAudit(client, { ...ev, outcome: ev.outcome || 'pending' }, 'dispute_opened');
  return { outcome: 'transitioned', status: 'disputed' };
}
