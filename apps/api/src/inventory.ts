// Inventory reservation + idempotent restoration.
//
// Two primitives:
//   reserveInventory — atomic conditional UPDATE; throws InventoryUnavailable.
//   restoreInventory — marks an inventory_reservation row as 'restored'.
//                      The actual `inventory_quantity + qty` UPDATE only runs
//                      when the row is first flipped to 'restored', so a
//                      duplicate cancel/retry never inflates stock twice.
//
// Schema:
//   inventory_reservations(
//     id BIGSERIAL PRIMARY KEY,
//     order_id BIGINT NOT NULL,
//     product_id BIGINT NOT NULL,
//     quantity INT NOT NULL,
//     state TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'restored'
//     created_at TIMESTAMPTZ DEFAULT NOW(),
//     restored_at TIMESTAMPTZ,
//     UNIQUE (order_id, product_id)         -- one reservation per (order, product)
//   );

import type { Pool, PoolClient } from 'pg';

export class InventoryUnavailable extends Error {
  code = 'INVENTORY_UNAVAILABLE';
  constructor(public productId: number, public reason: 'out_of_stock' | 'archived' | 'unavailable') {
    super(`Product ${productId} cannot be reserved (${reason}).`);
  }
}

export interface InventoryItem {
  productId: number;
  quantity: number;
}

export async function ensureInventoryReservationsTable(pool: Pool | PoolClient): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory_reservations (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL,
      product_id BIGINT NOT NULL,
      quantity INT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      restored_at TIMESTAMPTZ,
      UNIQUE (order_id, product_id)
    );
  `);
}

export async function reserveInventory(
  client: PoolClient,
  orderId: number,
  items: InventoryItem[],
  merchantWorkspaceId: string,
): Promise<void> {
  for (const it of items) {
    if (it.quantity <= 0) continue;
    const { rowCount } = await client.query(
      `UPDATE products
          SET inventory_quantity = inventory_quantity - $1
        WHERE id = $2
          AND inventory_quantity >= $1
          AND availability = TRUE
          AND status <> 'archived'
          AND workspace_id = $3`,
      [it.quantity, it.productId, merchantWorkspaceId],
    );
    if (rowCount === 0) {
      const { rows: rs } = await client.query<{
        availability: boolean; status: string; inventory_quantity: number;
      }>(
        `SELECT availability, status, inventory_quantity FROM products
         WHERE id = $1 AND workspace_id = $2`,
        [it.productId, merchantWorkspaceId],
      );
      const row = rs[0];
      let reason: 'out_of_stock' | 'archived' | 'unavailable' = 'unavailable';
      if (row) {
        if (row.status === 'archived') reason = 'archived';
        else if (row.inventory_quantity < it.quantity) reason = 'out_of_stock';
        else if (!row.availability) reason = 'unavailable';
      }
      throw new InventoryUnavailable(it.productId, reason);
    }
    await client.query(
      `INSERT INTO inventory_reservations (order_id, product_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (order_id, product_id) DO NOTHING`,
      [orderId, it.productId, it.quantity],
    );
  }
}

/**
 * Restore stock for an order. Idempotent: the unique key on
 * (order_id, product_id) + the state column means the same order can be
 * "cancelled" or "refunded" repeatedly without restoring stock more than once.
 * Returns the number of product lines actually restored.
 */
export async function restoreInventory(
  client: PoolClient,
  orderId: number,
  items: InventoryItem[],
): Promise<number> {
  let restored = 0;
  for (const it of items) {
    if (it.quantity <= 0) continue;
    // Flip the reservation row from 'active' to 'restored'. Only the first
    // writer wins; subsequent attempts see state='restored' and the UPDATE
    // touches 0 rows so the stock increment never re-runs.
    const { rowCount: flipped } = await client.query<{ id: number; quantity: number }>(
      `UPDATE inventory_reservations
          SET state = 'restored', restored_at = NOW()
        WHERE order_id = $1 AND product_id = $2 AND state = 'active'
        RETURNING id, quantity`,
      [orderId, it.productId],
    );
    if (flipped === 0) continue;
    await client.query(
      `UPDATE products
          SET inventory_quantity = inventory_quantity + $1
        WHERE id = $2`,
      [it.quantity, it.productId],
    );
    restored += 1;
  }
  return restored;
}
