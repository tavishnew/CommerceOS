// Negotiate flow integration test — verifies the workspace-bound
// authentication on /agent/seller/negotiate, the persisted negotiated
// price on /api/baskets, and that /api/checkout/start honors the
// negotiated price (not the live DB list price) when computing
// subtotal. Unique workspaceId per test run.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.TEST_API_BASE ?? 'http://127.0.0.1:5000';

// Load DATABASE_URL from apps/api/.env when it isn't already in the
// environment, so vitest doesn't need a separate secrets wiring.
function loadDbUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const text = readFileSync(resolve(__dirname, '..', '.env'), 'utf8');
    const match = text.match(/^DATABASE_URL\s*=\s*(.+)\s*$/m);
    if (match) return match[1]!.replace(/^['"]|['"]$/g, '');
  } catch {
    /* fall through */
  }
  return 'postgres://commerce:commerce@localhost:5432/commerce0s';
}
const pool = new pg.Pool({ connectionString: loadDbUrl() });

// Mirror resolveBuyerWorkspaceId from apps/api/src/demo.ts: the
// non-demo workspace id is `ws_anon_<hash>` where hash = djb2(email).
// We compute it inline so the test doesn't depend on /api/bootstrap.
function buyerWorkspaceFor(email: string): string {
  let h = 5381;
  for (let i = 0; i < email.length; i++) {
    h = ((h << 5) + h + email.charCodeAt(i)) | 0;
  }
  return `ws_anon_${Math.abs(h).toString(36)}`;
}

const BUYER_EMAIL = `neg-${crypto.randomBytes(3).toString('hex')}@example.com`;
const buyerWs = buyerWorkspaceFor(BUYER_EMAIL);
let productId = 0;
let merchantWs = '';
const sku = 'NEG-' + crypto.randomBytes(4).toString('hex').toUpperCase();
const LIST_PRICE = 200;

async function api<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(headers ?? {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: T;
  try {
    parsed = text ? (JSON.parse(text) as T) : (undefined as T);
  } catch {
    parsed = text as unknown as T;
  }
  return { status: res.status, body: parsed };
}

beforeAll(async () => {
  // The merchant workspace is `ws_live_<hash>` derived from the email.
  // Mirror that here so we can plant a product in the right workspace.
  let h = 5381;
  for (let i = 0; i < BUYER_EMAIL.length; i++) {
    h = ((h << 5) + h + BUYER_EMAIL.charCodeAt(i)) | 0;
  }
  merchantWs = `ws_live_${Math.abs(h).toString(36)}`;

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO products (sku, name, price, currency, availability, inventory_quantity,
                           status, enable_search, workspace_id)
     VALUES ($1, $2, $3, 'INR', TRUE, 50, 'active', TRUE, $4)
     RETURNING id`,
    [sku, `Negotiate test ${sku}`, LIST_PRICE, merchantWs],
  );
  productId = rows[0].id;

  await api('PUT', '/api/buyer/session', {
    workspaceId: buyerWs,
    maxSpend: 5000,
    autonomy: 'auto_up_to_limit',
  });
});

afterAll(async () => {
  if (productId) await pool.query('DELETE FROM products WHERE id = $1', [productId]);
  await pool.query('DELETE FROM baskets WHERE workspace_id = $1', [buyerWs]);
  await pool.query('DELETE FROM orders WHERE workspace_id = $1', [buyerWs]);
  await pool.query('DELETE FROM audit_log WHERE workspace_id = $1', [buyerWs]);
  await pool.end();
});

function buyerHeaders(): Record<string, string> {
  return {
    'x-buyer-email': BUYER_EMAIL,
    'x-buyer-workspace-id': buyerWs,
    // Basket/checkout use `merchantWorkspaceFor(req)` which trusts this
    // header to find the merchant's product catalog. The negotiate
    // route ignores it (it derives merchant workspace from the SKU row),
    // so sending it is harmless there.
    'x-merchant-workspace-id': merchantWs,
  };
}

describe('Auth: /agent/seller/negotiate', () => {
  test('rejects callers without a buyer session (no headers)', async () => {
    const r = await api<{ error: { code: string } }>(
      'POST',
      '/agent/seller/negotiate',
      { sku, quantity: 1, proposed_unit_price: 100, currency: 'INR' },
    );
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('UNAUTHENTICATED');
  });

  test('rejects callers whose email/workspace headers disagree', async () => {
    const r = await api<{ error: { code: string } }>(
      'POST',
      '/agent/seller/negotiate',
      { sku, quantity: 1, proposed_unit_price: 100, currency: 'INR' },
      {
        'x-buyer-email': BUYER_EMAIL,
        'x-buyer-workspace-id': 'ws_attacker',
      },
    );
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('Negotiation decisions', () => {
  test('accept: proposed >= list price', async () => {
    const r = await api<{ data: { decision: string; unit_price: number; negotiation_txn_id: string | null } }>(
      'POST',
      '/agent/seller/negotiate',
      { sku, quantity: 1, proposed_unit_price: LIST_PRICE, currency: 'INR' },
      buyerHeaders(),
    );
    expect(r.status).toBe(200);
    expect(r.body.data.decision).toBe('accept');
    expect(r.body.data.unit_price).toBe(LIST_PRICE);
    expect(r.body.data.negotiation_txn_id).toBeTruthy();
  });

  test('counter: proposed within floor band, qty >= 5 hits bulk tier', async () => {
    const r = await api<{ data: { decision: string; unit_price: number; negotiation_txn_id: string | null } }>(
      'POST',
      '/agent/seller/negotiate',
      { sku, quantity: 10, proposed_unit_price: LIST_PRICE * 0.85, currency: 'INR' },
      buyerHeaders(),
    );
    expect(r.status).toBe(200);
    expect(r.body.data.decision).toBe('counter');
    expect(r.body.data.unit_price).toBe(Math.round(LIST_PRICE * 0.9 * 100) / 100);
    expect(r.body.data.negotiation_txn_id).toBeTruthy();
  });

  test('reject: proposed below floor', async () => {
    const r = await api<{ data: { decision: string; unit_price: number | null } }>(
      'POST',
      '/agent/seller/negotiate',
      { sku, quantity: 1, proposed_unit_price: 1, currency: 'INR' },
      buyerHeaders(),
    );
    expect(r.status).toBe(200);
    expect(r.body.data.decision).toBe('reject');
    expect(r.body.data.unit_price).toBeNull();
  });
});

describe('Negotiated price → basket → checkout', () => {
  test('checkout subtotal uses the negotiated price, not the live list price', { timeout: 20_000 }, async () => {
    const neg = await api<{ data: { decision: string; unit_price: number; negotiation_txn_id: string } }>(
      'POST',
      '/agent/seller/negotiate',
      { sku, quantity: 10, proposed_unit_price: LIST_PRICE * 0.85, currency: 'INR' },
      buyerHeaders(),
    );
    expect(neg.status).toBe(200);
    expect(neg.body.data.decision).toBe('counter');
    const negotiatedPrice = neg.body.data.unit_price;
    const txnId = neg.body.data.negotiation_txn_id;
    expect(txnId).toBeTruthy();

    const b = await api<{ id: string; subtotal: number; items: Array<{ negotiatedUnitPrice: number | null }>; error?: { code: string; message: string } }>(
      'POST',
      '/api/baskets',
      {
        workspaceId: buyerWs,
        productId,
        negotiatedUnitPrice: negotiatedPrice,
        negotiationTxnId: txnId,
      },
      buyerHeaders(),
    );
    if (b.status !== 200) {
      console.error('basket create failed:', JSON.stringify(b.body), 'pid=', productId, 'mw=', merchantWs, 'bw=', buyerWs, 'txn=', txnId);
    }
    expect(b.status).toBe(200);
    expect(b.body.items[0]!.negotiatedUnitPrice).toBe(negotiatedPrice);
    expect(b.body.subtotal).toBe(negotiatedPrice);

    const tamper = await api<{ error: { code: string } }>(
      'POST',
      '/api/baskets',
      {
        workspaceId: buyerWs,
        productId,
        negotiatedUnitPrice: LIST_PRICE,
        negotiationTxnId: txnId,
      },
      buyerHeaders(),
    );
    expect(tamper.status).toBe(400);
    expect(tamper.body.error.code).toBe('INVALID_NEGOTIATED_PRICE');

    const forged = await api<{ error: { code: string } }>(
      'POST',
      '/api/baskets',
      {
        workspaceId: buyerWs,
        productId,
        negotiatedUnitPrice: negotiatedPrice,
        negotiationTxnId: 'TXN-NOT-REAL',
      },
      buyerHeaders(),
    );
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe('INVALID_NEGOTIATED_PRICE');

    const start = await api<{ orderId: number }>(
      'POST',
      '/api/checkout/start',
      { basketId: b.body.id, workspaceId: buyerWs },
      buyerHeaders(),
    );
    expect(start.status).toBe(200);
    const { rows } = await pool.query<{ amount: string | number }>(
      `SELECT amount FROM orders WHERE id = $1`,
      [start.body.orderId],
    );
    expect(Number(rows[0]!.amount)).toBe(negotiatedPrice);
  });
});
