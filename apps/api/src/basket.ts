// Server-authoritative basket. The browser cannot set amount/total —
// every price is reloaded from products before checkout runs.
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
): Promise<Basket> {
  const product = await loadActiveProduct(pool, productId, merchantWorkspaceId);
  if (!product.inStock) throw new InventoryUnavailable(productId, 'unavailable');

  const id = 'bsk_' + crypto.randomBytes(8).toString('base64url');
  const txnId = 'TXN-' + crypto.randomBytes(8).toString('base64url').toUpperCase();
  const items: BasketItem[] = [{ productId: product.id, priceAtAdd: product.price, name: product.name }];

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