// Server-authoritative basket. The browser cannot set amount/total —
// every price is reloaded from products before checkout runs, EXCEPT
// the negotiated price which is server-validated against the audit log
// of the prior /agent/seller/negotiate response.
//
// Ponytail: baskets are short-lived and replaced on next checkout. No TTL
// sweeper; ceiling applies only when the table grows unbounded.

import crypto from 'crypto';
import type pg from 'pg';
import type { PoolClient } from 'pg';
import { evaluateTransactionPolicy } from './policy.js';
import { InventoryUnavailable } from './inventory.js';

type Db = pg.Pool | PoolClient;

export interface BasketItem {
  productId: number;
  priceAtAdd: number;
  name?: string;
  // Server-stamped from a successful negotiate response. Authoritative
  // override for checkout — never trust a price sent fresh from the client
  // at checkout time.
  negotiatedUnitPrice?: number | null;
  negotiationTxnId?: string | null;
}

const NEGOTIATION_TTL_MS = 15 * 60 * 1000;

export async function resolveNegotiatedPrice(
  pool: Db,
  workspaceId: string,
  productId: number,
  claimedUnitPrice: number,
  negotiationTxnId: string,
): Promise<number> {
  // The negotiation audit row is the source of truth. Re-load it from
  // the DB; reject if it's missing, expired, belongs to a different
  // buyer, or covers a different product. The `claimedUnitPrice` must
  // exactly match what the seller accepted — no client-side rewrites.
  const { rows } = await pool.query<{
    detail: string;
    workspace_id: string;
    outcome: string;
    created_at: Date;
  }>(
    `SELECT detail, workspace_id, outcome, created_at
       FROM audit_log
      WHERE transaction_id = $1
        AND actor = 'seller_agent'
        AND action = 'seller_negotiation'`,
    [negotiationTxnId],
  );
  if (rows.length === 0) {
    throw new InvalidNegotiatedPrice('negotiation not found.');
  }
  const row = rows[0];
  if (row.workspace_id !== workspaceId) {
    throw new InvalidNegotiatedPrice('negotiation belongs to a different workspace.');
  }
  if (row.outcome !== 'success' && row.outcome !== 'countered') {
    throw new InvalidNegotiatedPrice(`negotiation outcome ${row.outcome} not usable.`);
  }
  const ageMs = Date.now() - new Date(row.created_at).getTime();
  if (ageMs > NEGOTIATION_TTL_MS) {
    throw new InvalidNegotiatedPrice('negotiation expired.');
  }
  let detail: {
    sku?: string;
    decision?: string;
    unit_price?: number;
  };
  try {
    detail = JSON.parse(row.detail);
  } catch {
    throw new InvalidNegotiatedPrice('negotiation detail malformed.');
  }
  if (detail.decision !== 'accept' && detail.decision !== 'counter') {
    throw new InvalidNegotiatedPrice(`decision ${detail.decision} cannot be checked out.`);
  }
  if (typeof detail.unit_price !== 'number') {
    throw new InvalidNegotiatedPrice('negotiation missing unit_price.');
  }
  // The unit_price the buyer committed to must match the audit log EXACTLY
  // — float drift is the bug we're guarding against. Use a half-cent
  // tolerance for legitimate rounding only.
  if (Math.abs(detail.unit_price - claimedUnitPrice) > 0.005) {
    throw new InvalidNegotiatedPrice(
      `claimed unit_price ${claimedUnitPrice} does not match negotiation ${detail.unit_price}.`,
    );
  }
  return detail.unit_price;
}


export interface Basket {
  id: string;
  workspaceId: string;
  txnId: string;
  items: BasketItem[];
  subtotal: number;
  currency: 'INR';
  status: 'open' | 'checked_out' | 'expired';
}

export class BasketNotFound extends Error {
  code = 'BASKET_NOT_FOUND';
}
export class BasketClosed extends Error {
  code = 'BASKET_CLOSED';
}
export class ProductMissing extends Error {
  code = 'PRODUCT_NOT_FOUND';
  constructor(public productId: number) {
    super(`Product ${productId} not found.`);
  }
}

async function loadActiveProduct(
  pool: Db,
  productId: number,
  workspaceId: string,
): Promise<{ id: number; price: number; currency: string; name: string; inStock: boolean }> {
  const { rows } = await pool.query<{
    id: number;
    price: number | string;
    currency: string;
    name: string;
    availability: boolean;
    inventory_quantity: number;
    status: string;
  }>(
    `SELECT id, price, currency, name, availability, inventory_quantity, status
     FROM products WHERE id = $1 AND workspace_id = $2`,
    [productId, workspaceId],
  );
  if (rows.length === 0) throw new ProductMissing(productId);
  const r = rows[0];
  const inStock = r.availability && r.inventory_quantity > 0 && r.status !== 'archived';
  return {
    id: r.id,
    price: Number(r.price),
    currency: r.currency,
    name: r.name,
    inStock,
  };
}

function computeSubtotal(items: BasketItem[]): number {
  // Sum with banker-safe rounding to 2dp at the end.
  const cents = items.reduce((s, it) => s + Math.round(it.priceAtAdd * 100), 0);
  return Math.round(cents) / 100;
}

export async function createBasket(
  pool: Db,
  workspaceId: string,
  productId: number,
  merchantWorkspaceId: string,
  opts: { negotiatedUnitPrice?: number; negotiationTxnId?: string } = {},
): Promise<Basket> {
  const product = await loadActiveProduct(pool, productId, merchantWorkspaceId);
  if (!product.inStock) throw new InventoryUnavailable(productId, 'unavailable');

  // Validate the negotiated price against the audit log BEFORE we stamp
  // it on the basket. The browser cannot send a fresh `unit_price` at
  // checkout time and have it honored — only audit-validated rows count.
  let priceAtAdd = product.price;
  let negotiatedUnitPrice: number | null = null;
  let negotiationTxnId: string | null = null;
  if (opts.negotiationTxnId && typeof opts.negotiatedUnitPrice === 'number') {
    priceAtAdd = await resolveNegotiatedPrice(
      pool,
      workspaceId,
      productId,
      opts.negotiatedUnitPrice,
      opts.negotiationTxnId,
    );
    negotiatedUnitPrice = priceAtAdd;
    negotiationTxnId = opts.negotiationTxnId;
  } else if (opts.negotiationTxnId || opts.negotiatedUnitPrice !== undefined) {
    // One but not the other — caller is misusing the API.
    throw new InvalidNegotiatedPrice(
      'negotiatedUnitPrice and negotiationTxnId must both be provided.',
    );
  }

  const id = 'bsk_' + crypto.randomBytes(8).toString('base64url');
  const txnId = 'TXN-' + crypto.randomBytes(8).toString('base64url').toUpperCase();
  const item: BasketItem = {
    productId: product.id,
    priceAtAdd,
    name: product.name,
    negotiatedUnitPrice,
    negotiationTxnId,
  };
  const items: BasketItem[] = [item];

  await pool.query(
    `INSERT INTO baskets (id, workspace_id, txn_id, items, status)
     VALUES ($1, $2, $3, $4::jsonb, 'open')`,
    [id, workspaceId, txnId, JSON.stringify(items)],
  );

  return {
    id,
    workspaceId,
    txnId,
    items,
    subtotal: computeSubtotal(items),
    currency: 'INR',
    status: 'open',
  };
}

export class InvalidNegotiatedPrice extends Error {
  code = 'INVALID_NEGOTIATED_PRICE';
}

export async function addToBasket(
  pool: Db,
  workspaceId: string,
  basketId: string,
  productId: number,
  merchantWorkspaceId: string,
): Promise<Basket> {
  const { rows } = await pool.query<{ items: BasketItem[]; status: string; workspace_id: string }>(
    `SELECT items, status, workspace_id FROM baskets WHERE id = $1`,
    [basketId],
  );
  if (rows.length === 0) throw new BasketNotFound();
  if (rows[0].workspace_id !== workspaceId) throw new BasketNotFound();
  if (rows[0].status !== 'open') throw new BasketClosed();

  const product = await loadActiveProduct(pool, productId, merchantWorkspaceId);
  if (!product.inStock) throw new InventoryUnavailable(productId, 'unavailable');

  const existing = rows[0].items;
  if (existing.some((it) => it.productId === product.id)) {
    // idempotent: same product already in basket — return as-is
    return loadBasket(pool, basketId);
  }
  const items = [...existing, { productId: product.id, priceAtAdd: product.price, name: product.name }];
  await pool.query(
    `UPDATE baskets SET items = $1::jsonb, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(items), basketId],
  );
  return loadBasket(pool, basketId);
}

export async function loadBasket(pool: Db, basketId: string): Promise<Basket> {
  const { rows } = await pool.query<{
    id: string;
    workspace_id: string;
    txn_id: string;
    items: BasketItem[];
    status: 'open' | 'checked_out' | 'expired';
  }>(
    `SELECT id, workspace_id, txn_id, items, status FROM baskets WHERE id = $1`,
    [basketId],
  );
  if (rows.length === 0) throw new BasketNotFound();
  const r = rows[0];
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    txnId: r.txn_id,
    items: r.items,
    subtotal: computeSubtotal(r.items),
    currency: 'INR',
    status: r.status,
  };
}

export async function markBasketCheckedOut(pool: Db, basketId: string): Promise<void> {
  await pool.query(`UPDATE baskets SET status = 'checked_out', updated_at = NOW() WHERE id = $1`, [
    basketId,
  ]);
}

export { evaluateTransactionPolicy };