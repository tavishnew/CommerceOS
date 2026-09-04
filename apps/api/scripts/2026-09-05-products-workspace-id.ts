// Additive migration: add products.workspace_id, backfill to demo merchant, enforce NOT NULL.
// Idempotent — safe to re-run.
// Not destructive: no DROP, no TRUNCATE, no DELETE.

import 'dotenv/config';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(2);
}

const DEMO_MERCHANT_WORKSPACE = 'ws_demo_merchant';

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function main() {
  // Step 0: confirm pre-state. If workspace_id already exists, log and proceed.
  const before = await pool.query<{ count: number; has_col: boolean }>(
    `SELECT COUNT(*)::int AS count,
            EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'products' AND column_name = 'workspace_id'
            ) AS has_col
       FROM products`,
  );
  console.log('pre-state:', before.rows[0]);

  // Step 1: add column (nullable, no row rewrite)
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS workspace_id TEXT`);
  console.log('step 1 done: column added (or already present)');

  // Step 2: backfill
  const upd = await pool.query<{ rowCount: number | null }>(
    `WITH upd AS (
       UPDATE products
          SET workspace_id = $1
        WHERE workspace_id IS NULL
        RETURNING 1
     )
     SELECT COUNT(*)::int AS rowCount FROM upd`,
    [DEMO_MERCHANT_WORKSPACE],
  );
  console.log(`step 2 done: backfilled ${upd.rows[0]?.rowCount ?? 0} row(s) to ${DEMO_MERCHANT_WORKSPACE}`);

  // Step 3: enforce NOT NULL
  await pool.query(`ALTER TABLE products ALTER COLUMN workspace_id SET NOT NULL`);
  console.log('step 3 done: column set NOT NULL');

  // Step 4: index
  await pool.query(`CREATE INDEX IF NOT EXISTS products_workspace_id_idx ON products (workspace_id)`);
  console.log('step 4 done: index created (or already present)');

  // Step 5: post-state
  const after = await pool.query<{ workspace_id: string; n: number }>(
    `SELECT workspace_id, COUNT(*)::int AS n FROM products GROUP BY workspace_id ORDER BY workspace_id`,
  );
  console.log('post-state rows by workspace:', after.rows);

  // Step 6: confirm not-null + index
  const verify = await pool.query<{ notnull: boolean; idx: boolean }>(
    `SELECT
       (is_nullable = 'NO') AS notnull,
       EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE tablename = 'products' AND indexname = 'products_workspace_id_idx'
       ) AS idx
     FROM information_schema.columns
     WHERE table_name = 'products' AND column_name = 'workspace_id'`,
  );
  console.log('post-state column verify:', verify.rows[0]);

  // Step 7: dump every row's workspace_id
  const rows = await pool.query<{ id: number; sku: string; brand: string; workspace_id: string }>(
    `SELECT id, sku, brand, workspace_id FROM products ORDER BY id`,
  );
  console.log('all products:');
  for (const r of rows.rows) {
    console.log(`  id=${r.id} sku=${r.sku} brand=${r.brand} workspace_id=${r.workspace_id}`);
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('migration failed:', err);
    pool.end().finally(() => process.exit(1));
  });
