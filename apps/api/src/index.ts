import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import { encryptSecret, decryptSecret } from './crypto.js';
import { evaluateTransactionPolicy, type PolicyResult } from './policy.js';
import { newTxnId, recordEvent, signEvidence, emitProtocolEventTx } from './txn.js';
import { markPaid, markFailed, markRefunded, markRefundRequested, markRefundFailed, markDisputed } from './payment_state.js';
import { ensureOutboxTable, startOutbox } from './outbox.js';
import {
  createBasket,
  addToBasket,
  loadBasket,
  markBasketCheckedOut,
  BasketNotFound,
  BasketClosed,
  ProductMissing,
  InventoryUnavailable,
} from './basket.js';
import {
  reserveInventory,
  restoreInventory,
  ensureInventoryReservationsTable,
  InventoryUnavailable as InvUnav,
} from './inventory.js';
import {
  isDemoAccountEmail,
  resolveBuyerWorkspaceId,
  seedDemoDataIfEmpty,
  DEMO_BUYER_WORKSPACE_ID,
  DEMO_MERCHANT_WORKSPACE,
  DEFAULT_MERCHANT_WORKSPACE_ID,
} from './demo.js';

// Augment Express Request for rawBody (webhook HMAC).
declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

const app = express();
// CORS allowlist — strict, no wildcards. Add a shared frontend origin via
// FRONTEND_ORIGIN (or several via the comma-separated CORS_EXTRA_ORIGINS) when
// exposing the API through ngrok. CORS for credentials / authorization-bearing
// requests MUST be allowlist-based.
const CORS_ALLOWED_ORIGINS: Set<string> = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);
if (process.env.FRONTEND_ORIGIN) {
  for (const o of process.env.FRONTEND_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)) {
    CORS_ALLOWED_ORIGINS.add(o);
  }
}
if (process.env.CORS_EXTRA_ORIGINS) {
  for (const o of process.env.CORS_EXTRA_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)) {
    CORS_ALLOWED_ORIGINS.add(o);
  }
}

// Chrome's Private Network Access blocks public origins (e.g. ngrok HTTPS
// URLs) from calling loopback (localhost/127.0.0.1) unless the server opts
// in. The PNA opt-in header MUST land on the preflight (OPTIONS) 204 too.
// We handle OPTIONS ourselves first (the `cors` package would send a 204
// before we could attach PNA) and use a strict allowlist for non-preflight
// responses. Safe for prod: only widens the explicit PNA opt-in, does not
// relax CORS.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const isAllowed = !!origin && CORS_ALLOWED_ORIGINS.has(origin);
  // Always opt in to PNA — this is the ONLY header that lets a public
  // origin (https://*.ngrok-free.app) call a private target (localhost).
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') {
    if (isAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin as string);
      res.setHeader('Vary', 'Origin, Access-Control-Request-Headers');
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Razorpay-Signature');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    // 204 even when origin is not allowed — the browser will reject the
    // preflight before the user code runs. We do NOT echo an arbitrary
    // origin (that would be `Access-Control-Allow-Origin: *` by another name).
    res.status(204).end();
    return;
  }
  if (isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin as string);
    res.setHeader('Vary', 'Origin');
  }
  next();
});
// `cors` is left in place for any route that wants to inspect req.ip or set
// Vary, but its origin-list logic is bypassed by the preflight handler above.
// We disable it rather than dual-authorize: an `origin: true` cors() would
// re-add the wildcard fallback on non-preflight requests and defeat the
// allowlist. Instead, expose cors() as a no-op for non-OPTIONS via a stub:
// (intentionally NOT calling cors() at all.)

// Webhook: raw body capture before express.json() so HMAC sees signed bytes.
app.post(
  '/api/checkout/webhook',
  express.raw({ type: '*/*', limit: '1mb' }),
  (req, _res, next) => {
    if (Buffer.isBuffer(req.body)) {
      req.rawBody = req.body;
      try {
        req.body = JSON.parse(req.body.toString('utf8') || '{}');
      } catch {
        req.body = {};
      }
    }
    next();
  },
);
app.use(express.json());

// ── Database ──

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// Run `fn(client)` in a tx; commit on resolve, rollback on throw. Network calls must NOT be inside the callback.
async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* swallow */ }
    throw err;
  } finally {
    client.release();
  }
}

// ── Types ──

interface ProductRow {
  id: number;
  sku: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  availability: boolean;
  inventory_quantity: number;
  status: string;
  created_at: string | null;
  image_link: string | null;
  brand: string | null;
  product_category: string | null;
}

const CATALOG_COLS =
  'id, sku, name, description, price, currency, availability, inventory_quantity, status, created_at, image_link, brand, product_category';

interface NormalizedProduct {
  id: number;
  name: string;
  sku: string;
  price: number;
  currency: string;
  inStock: boolean;
  quantity: number;
  sellerId: string;
  description?: string | null;
  imageLink?: string | null;
  brand?: string | null;
  category?: string | null;
  status?: string;
  createdAt?: string | null;
}

interface OrderRow {
  id: number;
  product_id: number;
  buyer_agent_id: string;
  amount: number;
  status: string;
  created_at: string;
}

// ── Helpers ──

function normalizeProduct(row: ProductRow): NormalizedProduct {
  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    price: Number(row.price),
    currency: row.currency ?? 'USD',
    inStock: row.availability && row.inventory_quantity > 0,
    quantity: row.inventory_quantity,
    sellerId: 'seller.almond',
    description: row.description,
    imageLink: row.image_link,
    brand: row.brand,
    category: row.product_category,
    status: row.status,
    createdAt: row.created_at,
  };
}

// ── Orders schema ──

async function ensureOrdersTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id                  SERIAL PRIMARY KEY,
      product_id          INTEGER NOT NULL,
      buyer_agent_id      TEXT   NOT NULL,
      amount              NUMERIC(12,2) NOT NULL,
      status              TEXT NOT NULL DEFAULT 'pending',
      razorpay_payment_id TEXT,
      razorpay_refund_id  TEXT,
      razorpay_refund_amount NUMERIC(12,2),
      dispute_reason      TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // Ponytail: best-effort additive migrations for existing DBs.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS razorpay_payment_id TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS razorpay_refund_id  TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS razorpay_refund_amount NUMERIC(12,2)`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_reason      TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS transaction_id   TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS workspace_id      TEXT NOT NULL DEFAULT 'buyer_demo'`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS basket            JSONB`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS currency          TEXT NOT NULL DEFAULT 'INR'`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS human_approved_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS policy_decision   JSONB`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_by_role   TEXT NOT NULL DEFAULT 'buyer'`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_requested_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS basket_id TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS razorpay_order_id TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_started_at TIMESTAMPTZ`);
  // Razorpay create-order idempotency. Stable per order so retries after a
  // network timeout reuse the same key. Razorpay deduplicates on this and
  // returns the original order id.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS razorpay_create_idem_key TEXT`);
  // payment_pending: intermediate state set when the internal order row
  // commits but the Razorpay call timed out. Webhook / verify / reconciler
  // must converge to paid | failed.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_pending_since TIMESTAMPTZ`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_orders_txn ON orders(transaction_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_orders_ws_ts ON orders(workspace_id, created_at DESC)`,
  );
  // One order per basket. Partial unique index — NULL basket_id rows
  // (legacy / non-basket-created orders) don't conflict.
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_orders_basket_id
     ON orders(basket_id) WHERE basket_id IS NOT NULL`,
  );
}

async function ensureBasketsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS baskets (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      txn_id       TEXT NOT NULL,
      items        JSONB NOT NULL,
      status       TEXT NOT NULL DEFAULT 'open',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function ensureBuyerSessionsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS buyer_sessions (
      workspace_id TEXT PRIMARY KEY,
      max_spend    NUMERIC(12,2),
      autonomy     TEXT NOT NULL DEFAULT 'recommend_only',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function ensureWebhookEventsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      event_id     TEXT PRIMARY KEY,
      event_type   TEXT NOT NULL,
      received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      payload_hash TEXT NOT NULL
    );
  `);
}

// Per-order Razorpay create attempts; idempotency_key dedupes retries after network timeouts.
async function ensureRazorpayAttemptsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS razorpay_attempts (
      order_id           INTEGER NOT NULL,
      attempt_number     INTEGER NOT NULL DEFAULT 1,
      idempotency_key    TEXT NOT NULL,
      razorpay_order_id  TEXT,
      response_status    TEXT,
      response_body      JSONB,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at       TIMESTAMPTZ,
      PRIMARY KEY (order_id, attempt_number)
    );
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_razorpay_attempts_idem
     ON razorpay_attempts(idempotency_key)`,
  );
}

// ── Products ──

async function ensureProductsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id                  SERIAL PRIMARY KEY,
      sku                 TEXT UNIQUE NOT NULL,
      name                TEXT NOT NULL,
      description         TEXT,
      price               NUMERIC(12,2) NOT NULL,
      currency            TEXT NOT NULL DEFAULT 'USD',
      availability        BOOLEAN NOT NULL DEFAULT TRUE,
      inventory_quantity  INTEGER NOT NULL DEFAULT 0,
      status              TEXT NOT NULL DEFAULT 'active',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      image_link          TEXT,
      brand               TEXT,
      product_category    TEXT,
      enable_search       BOOLEAN NOT NULL DEFAULT TRUE
    );
  `);
}

// Local-dev seed; no-op when table pre-populated (Neon).
async function seedProductsIfEmpty(): Promise<void> {
  const { rowCount } = await pool.query('SELECT 1 FROM products LIMIT 1');
  if (rowCount && rowCount > 0) return;

  await pool.query(`
    INSERT INTO products
      (sku, name, description, price, currency, availability, inventory_quantity, status, brand, product_category, image_link, enable_search)
    VALUES
      ('KB-MX-001', 'Almond MX Mechanical Keyboard', 'Tactile quiet mechanical keyboard, USB-C, hot-swappable switches.', 149.00, 'USD', TRUE, 12, 'active', 'Almond', 'keyboards', NULL, TRUE),
      ('MS-Q-014',   'Almond Pebble Mouse',          'Silent click wireless mouse, 18-month battery.',                    39.00,  'USD', TRUE, 40, 'active', 'Almond', 'mice',     NULL, TRUE),
      ('HS-ST-077',  'Almond Studio Headphones',     'Closed-back over-ear studio headphones, 32 ohm.',                  179.00, 'USD', TRUE, 6,  'active', 'Almond', 'audio',    NULL, TRUE),
      ('DK-USC-203', 'Almond 11-in-1 USB-C Dock',    'Dual 4K HDMI, gigabit ethernet, 100W passthrough.',                129.00, 'USD', TRUE, 18, 'active', 'Almond', 'docks',    NULL, TRUE),
      ('LT-NB-512',  'Almond Notebook (refurb)',     '14" refurb business notebook, 16GB / 512GB.',                       689.00, 'USD', FALSE, 0, 'out_of_stock', 'Almond', 'laptops', NULL, TRUE);
  `);
}

// ── Merchant credentials ──

interface MerchantCredentialsRow {
  merchant_id: string;
  razorpay_key_id: string;
  razorpay_key_secret_encrypted: string;
  razorpay_webhook_secret_encrypted: string;
  updated_at: string | null;
}

interface ResolvedRazorpayCreds {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  source: 'merchant_row' | 'env_fallback' | 'env_fallback_test';
}

async function ensureMerchantCredentialsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS merchant_credentials (
      merchant_id                    TEXT PRIMARY KEY DEFAULT 'default',
      razorpay_key_id                TEXT NOT NULL,
      razorpay_key_secret_encrypted  TEXT NOT NULL,
      razorpay_webhook_secret_encrypted TEXT NOT NULL,
      updated_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

/**
 * Resolve Razorpay credentials for a merchant.
 * Order: stored (decrypted) row → .env fallback (local dev only).
 * Returns null when nothing is configured for this merchant.
 */
async function resolveRazorpayCreds(merchantId = 'default'): Promise<ResolvedRazorpayCreds | null> {
  // Test mode short-circuit: never decrypt the stored credentials in tests.
  // The webhook and refund routes already use TEST_MODE_NO_RAZORPAY=1 to
  // bypass the real Razorpay call, so mirroring that here keeps the
  // webhook signature check in sync with the env-supplied secret. The
  // test fixture signs with RAZORPAY_WEBHOOK_SECRET; the API verifies
  // against the same value when this flag is set.
  if (process.env.TEST_MODE_NO_RAZORPAY === '1') {
    const envId = process.env.RAZORPAY_KEY_ID;
    const envSecret = process.env.RAZORPAY_KEY_SECRET;
    const envWebhook = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (envId && envSecret) {
      return {
        keyId: envId,
        keySecret: envSecret,
        webhookSecret: envWebhook ?? '',
        source: 'env_fallback_test',
      };
    }
  }
  const { rows } = await pool.query<MerchantCredentialsRow>(
    `SELECT merchant_id, razorpay_key_id,
            razorpay_key_secret_encrypted, razorpay_webhook_secret_encrypted,
            updated_at
     FROM merchant_credentials WHERE merchant_id = $1`,
    [merchantId],
  );
  if (rows.length > 0) {
    const r = rows[0];
    return {
      keyId: r.razorpay_key_id,
      keySecret: decryptSecret(r.razorpay_key_secret_encrypted),
      webhookSecret: decryptSecret(r.razorpay_webhook_secret_encrypted),
      source: 'merchant_row',
    };
  }
  const envId = process.env.RAZORPAY_KEY_ID;
  const envSecret = process.env.RAZORPAY_KEY_SECRET;
  const envWebhook = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (envId && envSecret) {
    return {
      keyId: envId,
      keySecret: envSecret,
      webhookSecret: envWebhook ?? '',
      source: 'env_fallback',
    };
  }
  return null;
}

// Rate limit: in-memory per IP. Ponytail: upgrade to Redis when multi-instance.

interface RateLimitOptions {
  windowMs: number; // time window
  max: number; // max requests per window per key
}

function createRateLimiter({ windowMs, max }: RateLimitOptions) {
  const hits = new Map<string, number[]>();
  // Periodic cleanup so the map doesn't grow forever
  const cleanup = setInterval(
    () => {
      const cutoff = Date.now() - windowMs;
      for (const [k, arr] of hits) {
        const trimmed = arr.filter((t) => t > cutoff);
        if (trimmed.length === 0) hits.delete(k);
        else hits.set(k, trimmed);
      }
    },
    Math.max(30_000, windowMs),
  );
  cleanup.unref();

  return function rateLimit(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) {
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const cutoff = now - windowMs;
    const arr = (hits.get(key) ?? []).filter((t) => t > cutoff);
    arr.push(now);
    hits.set(key, arr);
    if (arr.length > max) {
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests — slow down and try again in a moment.',
        },
      });
      return;
    }
    next();
  };
}

// Rate limits are bypassed when TEST_MODE_NO_RAZORPAY=1 (tests run hundreds
// of requests against a single local API instance within a minute window —
// the production limits are correct for real traffic, not for suites that
// poke every state transition).
const RATE_LIMIT_DISABLED = process.env.TEST_MODE_NO_RAZORPAY === '1';
const buyerQueryLimiter = createRateLimiter({ windowMs: 60_000, max: RATE_LIMIT_DISABLED ? 100_000 : 30 });
const upsellLimiter = createRateLimiter({ windowMs: 60_000, max: RATE_LIMIT_DISABLED ? 100_000 : 60 });
const checkoutLimiter = createRateLimiter({ windowMs: 60_000, max: RATE_LIMIT_DISABLED ? 100_000 : 20 });

// ── Routes ──

// POST /api/bootstrap — initial handshake. The browser sends an optional
// email and a candidate workspaceId. The server decides what to return:
//   - if the email matches the configured demo account, the caller is
//     bound to the demo buyer workspace and the demo merchant workspace
//   - otherwise the caller gets a server-derived anon workspaceId
// The browser-sent isDemo flag is NEVER accepted — only the email
// determines the demo split. Idempotent: calling twice with the same
// email returns the same workspaceId.
app.post('/api/bootstrap', async (req, res) => {
  // Reject any browser attempt to self-assign the demo flag.
  if (req.body && (req.body.isDemo === true || typeof req.body.isDemo === 'string')) {
    res.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'isDemo cannot be set by the client.',
      },
    });
    return;
  }
  const rawEmail = typeof req.body?.email === 'string' ? req.body.email : null;
  const email = rawEmail && rawEmail.trim() ? rawEmail.toLowerCase().trim() : null;

  const { workspaceId, isDemo } = resolveBuyerWorkspaceId(email);

  // Idempotently ensure the buyer session row exists so the rest of the
  // /api/buyer/* flow has something to read on the very first call.
  try {
    await pool.query(
      `INSERT INTO buyer_sessions (workspace_id, max_spend, autonomy)
       VALUES ($1, NULL, 'recommend_only')
       ON CONFLICT (workspace_id) DO NOTHING`,
      [workspaceId],
    );
  } catch (err) {
    console.error('bootstrap: failed to ensure buyer session:', err);
  }

  res.json({
    workspaceId,
    isDemo,
    email: email ?? null,
    merchantWorkspaceId: isDemo ? DEMO_MERCHANT_WORKSPACE : DEFAULT_MERCHANT_WORKSPACE_ID,
  });
});

// Health check — pings both FastAPI services
app.get('/api/health', async (_req, res) => {
  const supplierUrl = process.env.SUPPLIER_URL ?? 'http://localhost:8080';
  const retailerUrl = process.env.RETAILER_URL ?? 'http://localhost:8082';

  const check = async (url: string): Promise<'up' | 'down'> => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(`${url}/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      return r.ok ? 'up' : 'down';
    } catch {
      return 'down';
    }
  };

  const [supplier, retailer] = await Promise.all([check(supplierUrl), check(retailerUrl)]);

  res.json({ supplier, retailer });
});

// List catalog
app.get('/api/catalog', async (_req, res) => {
  try {
    const { rows } = await pool.query<ProductRow>(
      `SELECT ${CATALOG_COLS}
       FROM products
       WHERE enable_search = TRUE
       ORDER BY id`,
    );
    res.json(rows.map(normalizeProduct));
  } catch (err) {
    console.error('GET /api/catalog error:', err);
    res
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch catalog.' } });
  }
});

// Single product
app.get('/api/catalog/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid product id.' } });
    return;
  }

  try {
    const { rows } = await pool.query<ProductRow>(
      `SELECT ${CATALOG_COLS}
       FROM products
       WHERE id = $1`,
      [id],
    );

    if (rows.length === 0) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Product not found.' } });
      return;
    }

    res.json(normalizeProduct(rows[0]));
  } catch (err) {
    console.error('GET /api/catalog/:id error:', err);
    res
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch product.' } });
  }
});

// Update product
// Create product
app.post('/api/catalog', async (req, res) => {
  const { name, sku, price, stock } = req.body ?? {};
  if (typeof name !== 'string' || name.trim() === '') {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'name is required.' } });
    return;
  }
  if (typeof sku !== 'string' || sku.trim() === '') {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'sku is required.' } });
    return;
  }
  if (price == null || !Number.isFinite(Number(price))) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'price is required.' } });
    return;
  }
  const stockNum = stock != null ? Number(stock) : 0;
  try {
    const { rows } = await pool.query<ProductRow>(
      `INSERT INTO products
         (sku, name, description, price, currency, availability, inventory_quantity, status)
       VALUES ($1, $2, '', $3, 'INR', $4 > 0, $4, 'active')
       RETURNING id, sku, name, description, price, currency,
                 availability, inventory_quantity, status, created_at,
                 image_link, brand, product_category`,
      [sku.trim(), name.trim(), Number(price), stockNum],
    );
    res.status(201).json(normalizeProduct(rows[0]));
  } catch (err) {
    const msg = (err as { code?: string; message?: string }).message ?? '';
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({ error: { code: 'DUPLICATE_SKU', message: 'SKU already exists.' } });
      return;
    }
    console.error('POST /api/catalog error:', err, msg);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create product.' } });
  }
});

app.put('/api/catalog/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid product id.' } });
    return;
  }

  const { name, sku, price, stock, status } = req.body ?? {};

  try {
    const { rows } = await pool.query<ProductRow>(
      `UPDATE products
       SET name = COALESCE($1, name),
           sku = COALESCE($2, sku),
           price = COALESCE($3, price),
           inventory_quantity = COALESCE($4, inventory_quantity),
           availability = CASE WHEN $4 IS NOT NULL THEN $4 > 0 ELSE availability END,
           status = COALESCE($5, status)
       WHERE id = $6
       RETURNING id, sku, name, description, price, currency,
                 availability, inventory_quantity, status, created_at,
                 image_link, brand, product_category`,
      [
        name ?? null,
        sku ?? null,
        price != null ? Number(price) : null,
        stock != null ? Number(stock) : null,
        status ?? null,
        id,
      ],
    );

    if (rows.length === 0) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Product not found.' } });
      return;
    }

    res.json(normalizeProduct(rows[0]));
  } catch (err) {
    console.error('PUT /api/catalog/:id error:', err);
    res
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update product.' } });
  }
});

// Delete product
app.delete('/api/catalog/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid product id.' } });
    return;
  }

  try {
    const { rowCount } = await pool.query('DELETE FROM products WHERE id = $1', [id]);
    if (rowCount === 0) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Product not found.' } });
      return;
    }
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/catalog/:id error:', err);
    res
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete product.' } });
  }
});

// List orders; ?workspaceId= scopes to buyer workspace.
app.get('/api/orders', async (req, res) => {
  const workspaceId = (req.query.workspaceId as string | undefined)?.trim() || merchantWorkspace();
  try {
    const { rows } = await pool.query(
      `SELECT o.id, o.product_id, o.buyer_agent_id, o.amount, o.currency, o.status, o.created_at,
              o.transaction_id, o.workspace_id, o.human_approved_at, o.policy_decision,
              o.razorpay_payment_id, o.razorpay_order_id, o.razorpay_refund_id,
              o.dispute_reason, o.refund_requested_at,
              p.name AS product_name, p.sku AS product_sku
       FROM orders o
       LEFT JOIN products p ON p.id = o.product_id
       WHERE o.workspace_id = $1
       ORDER BY o.created_at DESC`,
      [workspaceId],
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/orders error:', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch orders.' } });
  }
});

// POST /api/orders without basket is rejected; amount must be server-derived.
app.post('/api/orders', async (_req, res) => {
  res.status(400).json({
    error: {
      code: 'USE_BASKET',
      message:
        'Direct order creation is disabled. POST /api/baskets then POST /api/checkout/start.',
    },
  });
});

// Single order; ?expand=true joins product + policy.
app.get('/api/orders/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid order id.' } });
    return;
  }
  const expand = req.query.expand === 'true';
  const workspaceId = (req.query.workspaceId as string | undefined)?.trim();
  try {
    const { rows } = await pool.query(
      `SELECT o.id, o.product_id, o.buyer_agent_id, o.amount, o.currency, o.status, o.created_at,
              o.transaction_id, o.workspace_id, o.human_approved_at, o.policy_decision,
              o.razorpay_payment_id, o.razorpay_refund_id, o.razorpay_refund_amount,
              o.dispute_reason, o.refund_requested_at,
              p.name AS product_name, p.sku AS product_sku, p.brand, p.product_category
       FROM orders o
       LEFT JOIN products p ON p.id = o.product_id
       WHERE o.id = $1`,
      [id],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order not found.' } });
      return;
    }
    const row = rows[0];
    // Workspace isolation: caller must supply matching workspaceId (or default merchant).
    // Same response as not-found — never leak existence across workspaces.
    if (workspaceId && row.workspace_id !== workspaceId && row.workspace_id !== merchantWorkspace()) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order not found.' } });
      return;
    }
    if (!expand) {
      res.json(row);
      return;
    }
    // Attach recent audit rows for this order's transaction.
    const audit = await pool.query(
      `SELECT id, timestamp, actor, action, detail, amount, outcome
       FROM audit_log
       WHERE transaction_id = $1
       ORDER BY timestamp ASC
       LIMIT 50`,
      [row.transaction_id],
    );
    res.json({ ...row, audit: audit.rows });
  } catch (err) {
    console.error('GET /api/orders/:id error:', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch order.' } });
  }
});

// Dispute: workspaceId in body must match order's workspace_id, else 404.
app.post('/api/orders/:id/dispute', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid order id.' } });
    return;
  }
  const reason = String(req.body?.reason ?? '').trim();
  const workspaceId = String(req.body?.workspaceId ?? '').trim();
  if (reason.length === 0) {
    res.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'A reason is required to dispute an order.' },
    });
    return;
  }
  if (reason.length > 500) {
    res
      .status(400)
      .json({ error: { code: 'INVALID_REQUEST', message: 'Reason is too long (max 500 chars).' } });
    return;
  }
  if (!workspaceId) {
    res.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'workspaceId is required.' },
    });
    return;
  }

  try {
    const { rows } = await pool.query<{ id: number; status: string; workspace_id: string; transaction_id: string }>(
      `SELECT id, status, workspace_id, transaction_id FROM orders WHERE id = $1`,
      [id],
    );
    if (rows.length === 0 || rows[0].workspace_id !== workspaceId) {
      // Same response as not-found — never leak existence across workspaces.
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order not found.' } });
      return;
    }
    const current = rows[0].status;
    if (current === 'disputed' || current === 'refunded' || current === 'refund_failed') {
      res
        .status(409)
        .json({ error: { code: 'ALREADY_DISPUTED', message: `Order is already ${current}.` } });
      return;
    }
    if (current !== 'paid') {
      res.status(409).json({
        error: {
          code: 'NOT_PAID',
          message: `Only paid orders can be disputed (current: ${current}).`,
        },
      });
      return;
    }

    const updated = await withTransaction(async (client) => {
      const r = await markDisputed(client, {
        orderId: id,
        transactionId: rows[0].transaction_id,
        workspaceId,
        amount: null,
        reason,
        actor: 'buyer',
        detail: `Order ${id} disputed: ${reason}`,
        outcome: 'pending',
      });
      if (r.outcome !== 'transitioned') return null;
      return { id, status: r.status };
    });
    if (!updated) {
      // Lost the race to a concurrent transition.
      res.status(409).json({
        error: { code: 'STATE_CHANGED', message: 'Order state changed — try again.' },
      });
      return;
    }
    res.json({ id: updated.id, status: updated.status, dispute_reason: reason });
  } catch (err) {
    console.error('POST /api/orders/:id/dispute error:', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to open dispute.' } });
  }
});

// A2A/ACP: persist request/response for trace visibility.
async function emitProtocolEvent(ev: {
  protocol: 'A2A' | 'ACP' | 'REST' | 'RAZORPAY';
  direction: 'outbound' | 'inbound';
  source: string;
  target: string;
  action: string;
  status: 'success' | 'failed' | 'degraded' | 'recovered';
  latencyMs?: number;
  txnId?: string | null;
  workspaceId?: string | null;
  sessionId?: string | null;
  detail?: string;
}): Promise<void> {
  await recordEvent({
    pool,
    txnId: ev.txnId ?? null,
    workspaceId: ev.workspaceId ?? merchantWorkspace(),
    sessionId: ev.sessionId ?? null,
    actor: `${ev.protocol.toLowerCase()}.${ev.direction}`,
    action: ev.action,
    detail: `${ev.source} → ${ev.target}${ev.detail ? ' · ' + ev.detail : ''}${ev.latencyMs != null ? ` · ${ev.latencyMs}ms` : ''}`,
    outcome: ev.status,
  });
}

// ── Baskets ──

// POST /api/baskets — server-authoritative basket creation
app.post('/api/baskets', async (req, res) => {
  const productId = Number(req.body?.productId);
  const workspaceId = String(req.body?.workspaceId ?? '').trim();
  if (!Number.isFinite(productId)) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'productId is required.' } });
    return;
  }
  if (!workspaceId) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'workspaceId is required.' } });
    return;
  }
  try {
    const basket = await withTransaction(async (client) => {
      const b = await createBasket(client, workspaceId, productId);
      await client.query(
        `INSERT INTO audit_log
           (transaction_id, workspace_id, actor, action, detail, amount, outcome)
         VALUES ($1, $2, 'buyer', 'basket_created', $3, $4, 'pending')`,
        [b.txnId, workspaceId, `Basket ${b.id} · 1 item · ₹${b.subtotal.toFixed(2)}`, b.subtotal],
      );
      return b;
    });
    res.json(basket);
  } catch (err) {
    if (err instanceof ProductMissing) {
      res.status(404).json({ error: { code: 'PRODUCT_NOT_FOUND', message: err.message } });
      return;
    }
    if (err instanceof InventoryUnavailable) {
      res.status(409).json({ error: { code: 'INVENTORY_UNAVAILABLE', message: err.message } });
      return;
    }
    console.error('POST /api/baskets error:', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not create basket.' } });
  }
});

// Add upsell item.
app.post('/api/baskets/:id/items', async (req, res) => {
  const basketId = String(req.params.id);
  const productId = Number(req.body?.productId);
  const workspaceId = String(req.body?.workspaceId ?? '').trim();
  if (!Number.isFinite(productId)) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'productId is required.' } });
    return;
  }
  if (!workspaceId) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'workspaceId is required.' } });
    return;
  }
  try {
    const basket = await withTransaction(async (client) => {
      const b = await addToBasket(client, workspaceId, basketId, productId);
      await client.query(
        `INSERT INTO audit_log
           (transaction_id, workspace_id, actor, action, detail, amount, outcome)
         VALUES ($1, $2, 'buyer', 'basket_item_added', $3, $4, 'pending')`,
        [b.txnId, workspaceId, `Basket ${b.id} · ${b.items.length} item(s) · ₹${b.subtotal.toFixed(2)}`, b.subtotal],
      );
      return b;
    });
    res.json(basket);
  } catch (err) {
    if (err instanceof BasketNotFound) {
      res.status(404).json({ error: { code: 'BASKET_NOT_FOUND', message: 'Basket not found.' } });
      return;
    }
    if (err instanceof BasketClosed) {
      res.status(409).json({ error: { code: 'BASKET_CLOSED', message: 'Basket is closed.' } });
      return;
    }
    if (err instanceof ProductMissing) {
      res.status(404).json({ error: { code: 'PRODUCT_NOT_FOUND', message: err.message } });
      return;
    }
    if (err instanceof InventoryUnavailable) {
      res.status(409).json({ error: { code: 'INVENTORY_UNAVAILABLE', message: err.message } });
      return;
    }
    console.error('POST /api/baskets/:id/items error:', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not update basket.' } });
  }
});

// Reload basket.
app.get('/api/baskets/:id', async (req, res) => {
  const basketId = String(req.params.id);
  const workspaceId = String(req.query.workspaceId ?? '').trim();
  try {
    const basket = await loadBasket(pool, basketId);
    if (workspaceId && basket.workspaceId !== workspaceId) {
      res.status(404).json({ error: { code: 'BASKET_NOT_FOUND', message: 'Basket not found.' } });
      return;
    }
    res.json(basket);
  } catch (err) {
    if (err instanceof BasketNotFound) {
      res.status(404).json({ error: { code: 'BASKET_NOT_FOUND', message: 'Basket not found.' } });
      return;
    }
    console.error('GET /api/baskets/:id error:', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not load basket.' } });
  }
});

// ── Buyer session ──

// GET /api/buyer/session?workspaceId=...
app.get('/api/buyer/session', async (req, res) => {
  const workspaceId = String(req.query.workspaceId ?? '').trim();
  if (!workspaceId) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'workspaceId is required.' } });
    return;
  }
  try {
    const { rows } = await pool.query<{ workspace_id: string; max_spend: number | string | null; autonomy: string }>(
      `SELECT workspace_id, max_spend, autonomy FROM buyer_sessions WHERE workspace_id = $1`,
      [workspaceId],
    );
    if (rows.length === 0) {
      // Idempotent create on first read
      await pool.query(
        `INSERT INTO buyer_sessions (workspace_id, max_spend, autonomy) VALUES ($1, NULL, 'recommend_only') ON CONFLICT DO NOTHING`,
        [workspaceId],
      );
      res.json({ workspaceId, maxSpend: null, autonomy: 'recommend_only' });
      return;
    }
    const r = rows[0];
    res.json({
      workspaceId: r.workspace_id,
      maxSpend: r.max_spend != null ? Number(r.max_spend) : null,
      autonomy: r.autonomy,
    });
  } catch (err) {
    console.error('GET /api/buyer/session error:', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not load buyer session.' } });
  }
});

// Update session.
app.put('/api/buyer/session', async (req, res) => {
  const workspaceId = String(req.body?.workspaceId ?? '').trim();
  const maxSpendRaw = req.body?.maxSpend;
  const autonomy = String(req.body?.autonomy ?? '').trim();
  if (!workspaceId) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'workspaceId is required.' } });
    return;
  }
  const allowedAutonomy = ['recommend_only', 'ask_before', 'auto_up_to_limit'];
  if (autonomy && !allowedAutonomy.includes(autonomy)) {
    res.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: `autonomy must be one of ${allowedAutonomy.join(', ')}.`,
      },
    });
    return;
  }
  let maxSpend: number | null = null;
  if (maxSpendRaw != null && maxSpendRaw !== '') {
    const n = Number(maxSpendRaw);
    if (!Number.isFinite(n) || n < 0) {
      res.status(400).json({
        error: { code: 'INVALID_REQUEST', message: 'maxSpend must be a non-negative number.' },
      });
      return;
    }
    maxSpend = n;
  }
  try {
    await pool.query(
      `INSERT INTO buyer_sessions (workspace_id, max_spend, autonomy)
       VALUES ($1, $2, COALESCE(NULLIF($3, ''), 'recommend_only'))
       ON CONFLICT (workspace_id) DO UPDATE SET
         max_spend = EXCLUDED.max_spend,
         autonomy  = EXCLUDED.autonomy,
         updated_at = NOW()`,
      [workspaceId, maxSpend, autonomy],
    );
    res.json({ workspaceId, maxSpend, autonomy: autonomy || 'recommend_only' });
  } catch (err) {
    console.error('PUT /api/buyer/session error:', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not save session.' } });
  }
});

// GET /api/buyer/orders?workspaceId=...
app.get('/api/buyer/orders', async (req, res) => {
  const workspaceId = String(req.query.workspaceId ?? '').trim();
  if (!workspaceId) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'workspaceId is required.' } });
    return;
  }
  try {
    const { rows } = await pool.query(
      `SELECT o.id, o.product_id, o.amount, o.currency, o.status, o.created_at,
              o.transaction_id, o.workspace_id, o.human_approved_at, o.dispute_reason,
              p.name AS product_name, p.sku AS product_sku
       FROM orders o
       LEFT JOIN products p ON p.id = o.product_id
       WHERE o.workspace_id = $1
       ORDER BY o.created_at DESC
       LIMIT 100`,
      [workspaceId],
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/buyer/orders error:', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not load orders.' } });
  }
});

// GET /api/transactions/:txn — single transaction detail (all rows + order).
// workspaceId query param required; must match at least one order's workspace.
app.get('/api/transactions/:txn', async (req, res) => {
  const txnId = String(req.params.txn);
  const workspaceId = (req.query.workspaceId as string | undefined)?.trim();
  try {
    const { rows: orders } = await pool.query(
      `SELECT o.*, p.name AS product_name, p.sku AS product_sku
       FROM orders o LEFT JOIN products p ON p.id = o.product_id
       WHERE o.transaction_id = $1`,
      [txnId],
    );
    if (orders.length === 0) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Transaction not found.' } });
      return;
    }
    // Workspace isolation: caller workspace must match the order owner workspace.
    // Default merchant workspace may read any (admin/operator view).
    const ownerWs = orders[0].workspace_id;
    const callerIsMerchant = !workspaceId || workspaceId === merchantWorkspace();
    if (!callerIsMerchant && ownerWs !== workspaceId) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Transaction not found.' } });
      return;
    }
    const { rows: audit } = await pool.query(
      `SELECT id, timestamp, actor, action, detail, amount, outcome, transaction_id, workspace_id
       FROM audit_log WHERE transaction_id = $1 ORDER BY timestamp ASC LIMIT 200`,
      [txnId],
    );
    res.json({ transactionId: txnId, orders, audit });
  } catch (err) {
    console.error('GET /api/transactions/:txn error:', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not load transaction.' } });
  }
});

// GET /api/activity — recent audit rows scoped to merchant workspace
app.get('/api/activity', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 12, 100);
  const workspaceId = (req.query.workspaceId as string | undefined)?.trim() || merchantWorkspace();
  try {
    const { rows } = await pool.query(
      `SELECT id, timestamp, actor, action, detail, amount, outcome
       FROM audit_log
       WHERE workspace_id = $1
       ORDER BY timestamp DESC
       LIMIT $2`,
      [workspaceId, limit],
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/activity error:', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not load activity.' } });
  }
});

// ── Basket → order flow (replaces old POST /api/checkout/create-order) ───

// POST /api/checkout/start — takes basket, runs policy, creates order.
// `approved` is required only when policy.requiresHumanApproval is true.
app.post('/api/checkout/start', checkoutLimiter, async (req, res) => {
  const basketId = String(req.body?.basketId ?? '').trim();
  const workspaceId = String(req.body?.workspaceId ?? '').trim();
  // Note: `approved` body field is intentionally NOT honored. Approval
  // must come from the dedicated /api/checkout/human-approve/:orderId
  // route so a single audit row (`human_override`) is recorded. Inline
  // approval in /api/checkout/start would let the browser skip the gate.
  if (req.body?.approved !== undefined) {
    res.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'approved must be set via /api/checkout/human-approve/:orderId, not in checkout/start.',
      },
    });
    return;
  }
  // maxSpend is also server-controlled; reject any body override so the
  // browser cannot raise the buyer ceiling at request time.
  if (req.body?.maxSpend !== undefined) {
    res.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'maxSpend is server-controlled. Update via /api/buyer/session.',
      },
    });
    return;
  }
  let buyerMaxSpend: number | null = null;

  if (!basketId || !workspaceId) {
    res.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'basketId and workspaceId are required.' },
    });
    return;
  }

  let basket;
  try {
    basket = await loadBasket(pool, basketId);
  } catch (err) {
    if (err instanceof BasketNotFound) {
      res.status(404).json({ error: { code: 'BASKET_NOT_FOUND', message: 'Basket not found.' } });
      return;
    }
    throw err;
  }
  if (basket.workspaceId !== workspaceId) {
    res.status(404).json({ error: { code: 'BASKET_NOT_FOUND', message: 'Basket not found.' } });
    return;
  }
  if (basket.status !== 'open') {
    res.status(409).json({ error: { code: 'BASKET_CLOSED', message: 'Basket is closed.' } });
    return;
  }
  if (basket.items.length === 0) {
    res.status(400).json({ error: { code: 'EMPTY_BASKET', message: 'Basket is empty.' } });
    return;
  }

  // Pull buyer session ceiling. The body override path is rejected above;
  // the only source of truth for the buyer limit is the buyer_sessions row.
  let buyerCeiling: number | null = null;
  try {
    const { rows } = await pool.query<{ max_spend: number | string | null }>(
      `SELECT max_spend FROM buyer_sessions WHERE workspace_id = $1`,
      [workspaceId],
    );
    if (rows[0]?.max_spend != null) buyerCeiling = Number(rows[0].max_spend);
  } catch {
    /* keep null */
  }

  // Pull merchant ceiling
  let merchantCeiling = 180;
  try {
    const { rows } = await pool.query<{ max_auto_approve: number | string }>(
      `SELECT max_auto_approve FROM merchant_settings WHERE merchant_id = $1`,
      [merchantWorkspace()],
    );
    if (rows[0]) merchantCeiling = Number(rows[0].max_auto_approve);
  } catch {
    /* default */
  }

  // Re-load each item from DB so the price is the server's truth.
  const { rows: dbProducts } = await pool.query<{
    id: number;
    price: number | string;
    name: string;
    availability: boolean;
    inventory_quantity: number;
    status: string;
  }>(
    `SELECT id, price, name, availability, inventory_quantity, status
     FROM products WHERE id = ANY($1::int[])`,
    [basket.items.map((it) => it.productId)],
  );
  if (dbProducts.length !== basket.items.length) {
    res.status(409).json({
      error: { code: 'PRODUCT_CHANGED', message: 'One or more products are no longer available.' },
    });
    return;
  }
  for (const p of dbProducts) {
    if (!p.availability || p.inventory_quantity <= 0 || p.status === 'archived') {
      res.status(409).json({
        error: { code: 'INVENTORY_UNAVAILABLE', message: `${p.name} is out of stock.` },
      });
      return;
    }
  }
  const subtotal = dbProducts.reduce((s, p) => s + Math.round(Number(p.price) * 100), 0) / 100;

  const policy = evaluateTransactionPolicy({
    amount: subtotal,
    buyerLimit: buyerCeiling,
    merchantLimit: merchantCeiling,
  });

  // If policy requires human approval, the order is created in
  // pending_human_review. The dedicated /api/checkout/human-approve/:orderId
  // route is the ONLY way to flip it to human_approved AND create the
  // Razorpay order. There is no inline `approved` body field — see the
  // request-body validation above. Record the gate audit row.
  if (policy.requiresHumanApproval) {
    await recordEvent({
      pool,
      txnId: basket.txnId,
      workspaceId,
      actor: 'buyer',
      action: 'human_approval_required',
      detail: `Subtotal ₹${subtotal.toFixed(2)} needs approval (${policy.ceilingSource})`,
      amount: subtotal,
      outcome: 'human_approval_required',
      policy,
    });
  }

  // Resolve credentials before creating order so we fail fast
  let creds: ResolvedRazorpayCreds | null = null;
  try {
    creds = await resolveRazorpayCreds();
  } catch (err) {
    console.error('checkout/start: failed to resolve credentials:', err);
  }
  if (!creds) {
    res.status(409).json({
      error: {
        code: 'RAZORPAY_NOT_CONFIGURED',
        message: 'No Razorpay credentials configured. Add them in Settings → Payment gateway.',
      },
    });
    return;
  }
  if (!creds.keyId.startsWith('rzp_test_')) {
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Only Razorpay test-mode keys are allowed in this environment.',
      },
    });
    return;
  }

  // Create the order row in a single transaction:
  //   - re-check basket is open (idempotency: a re-submit cannot create two orders)
  //   - INSERT order with status = pending_human_review or human_approved
  //   - mark basket checked_out (guarded by status=open)
  //   - atomically RESERVE inventory (conditional UPDATE on products)
  //   - INSERT audit_log row
  //   - if human-approval path, stamp human_approved_at and set status
  //   - persist razorpay_create_idem_key for retry-safe external call
  // The whole block commits or rolls back as one unit. The external Razorpay
  // call happens AFTER commit; the webhook (or verify) is what flips status
  // to paid, with its own transaction.
  const productId = dbProducts[0].id;
  const buyerAgentId = `buyer.${workspaceId.slice(0, 8)}`;
  let orderId: number;
  let txnId = '';
  let createIdemKey = '';
  try {
    const created = await withTransaction(async (client) => {
      // Idempotency: a previous /api/checkout/start already turned this basket
      // into an order. If so, return 409 — caller should not retry blindly.
      const { rowCount: existing } = await client.query(
        `SELECT 1 FROM orders WHERE basket_id = $1 LIMIT 1`,
        [basketId],
      );
      if (existing && existing > 0) {
        const err = new Error('order already exists for this basket');
        (err as { code?: string }).code = 'BASKET_ALREADY_CHECKED_OUT';
        throw err;
      }

      txnId = newTxnId();
      // Stable per-order idempotency key for the Razorpay create call.
      // Persisting it on the order row makes the external call safe to
      // retry: the SDK passes the key, and if Razorpay already received it
      // it returns the existing order id rather than creating a duplicate.
      createIdemKey = `c0s_ord_${txnId}`;
      const ins = await client.query<{ id: number }>(
        `INSERT INTO orders
           (product_id, buyer_agent_id, amount, currency, status,
            transaction_id, workspace_id, basket_id, basket, policy_decision,
            created_by_role, checkout_started_at, razorpay_create_idem_key)
         VALUES ($1, $2, $3, 'INR', $4, $5, $6, $7, $8::jsonb, $9::jsonb,
                 'buyer', NOW(), $10)
         RETURNING id`,
        [
          productId,
          buyerAgentId,
          subtotal,
          policy.requiresHumanApproval ? 'pending_human_review' : 'human_approved',
          txnId,
          workspaceId,
          basketId,
          JSON.stringify(basket.items),
          JSON.stringify(policy),
          createIdemKey,
        ],
      );
      const oid = ins.rows[0].id;
      console.error('[debug-auto-stamp] oid=', oid, 'requiresHumanApproval=', policy.requiresHumanApproval);
      // Auto-approved orders skip the human-approval route, so the approval
      // timestamp must be stamped here. Without this, downstream queries that
      // distinguish "approved" from "awaiting approval" only by timestamp
      // misclassify the auto path as pending.
      if (!policy.requiresHumanApproval) {
        const { rowCount } = await client.query(
          `UPDATE orders SET human_approved_at = NOW() WHERE id = $1`,
          [oid],
        );
        console.error('[debug-auto-stamp] updated rows=', rowCount);
      }
      // markBasketCheckedOut guarded by status=open — second concurrent submit
      // loses the race here even if the unique index didn't fire.
      const { rowCount: closed } = await client.query(
        `UPDATE baskets SET status = 'checked_out', updated_at = NOW()
         WHERE id = $1 AND status = 'open'`,
        [basketId],
      );
      if (closed === 0) {
        const err = new Error('basket is not open');
        (err as { code?: string }).code = 'BASKET_ALREADY_CHECKED_OUT';
        throw err;
      }

      // Atomic inventory reservation. Decrements exactly the products in
      // this basket by their line quantities. If ANY line is out of stock
      // the throw rolls back the order insert and basket close above.
      // The orderId is passed so the reservation row is keyed (order_id,
      // product_id) — duplicate cancels/restores won't inflate stock.
      const invItems = basket.items.map((it) => ({ productId: it.productId, quantity: 1 }));
      await reserveInventory(client, oid, invItems);

      if (policy.requiresHumanApproval) {
        // Order is created in pending_human_review. The dedicated
        // /api/checkout/human-approve/:orderId route is the ONLY way to
        // flip it to human_approved. This guarantees a human_override
        // audit row is recorded.
        void oid;
      }

      await client.query(
        `INSERT INTO audit_log
           (transaction_id, workspace_id, actor, action, detail, amount, outcome, policy)
         VALUES ($1, $2, 'buyer', 'checkout_started', $3, $4, 'pending', $5::jsonb)`,
        [
          txnId,
          workspaceId,
          `Order ${oid} · ₹${subtotal.toFixed(2)} · ${policy.decision}`,
          subtotal,
          JSON.stringify(policy),
        ],
      );
      return oid;
    });
    orderId = created;
  } catch (err) {
    const code = (err as { code?: string }).code;
    // Pre-check (BASKET_ALREADY_CHECKED_OUT) loses the race when two
    // parallel /api/checkout/start calls both pass the SELECT and only
    // the second hits the unique constraint. The PG error code for a
    // unique_violation is '23505'; map it to the same 409 so callers
    // see a stable contract regardless of which path wins.
    const pgCode = (err as { code?: string }).code;
    if (code === 'BASKET_ALREADY_CHECKED_OUT' || pgCode === '23505') {
      res.status(409).json({
        error: {
          code: 'BASKET_ALREADY_CHECKED_OUT',
          message: 'This basket has already been checked out.',
        },
      });
      return;
    }
    if (err instanceof InvUnav) {
      res.status(409).json({
        error: {
          code: 'INVENTORY_UNAVAILABLE',
          message: `Product ${err.productId} is no longer available (${err.reason}).`,
        },
      });
      return;
    }
    console.error('checkout/start: order insert failed:', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not create order.' } });
    return;
  }

  // Create Razorpay order.
  // Idempotency: the persisted createIdemKey is passed to Razorpay. If the
  // SDK call fails AFTER Razorpay accepted it (network timeout), the next
  // retry of /api/checkout/start on the same order will reuse the key and
  // we never create a duplicate. After the timeout, we stamp
  // payment_pending_since so the reconciler can re-attempt later.
  const tRzp = Date.now();
  let rpOrderId: string | null = null;
  let rpOrderAmount: number | null = null;
  // Test hook: skip the real Razorpay call. Lets the test suite exercise
  // the order/audit state machine without real credentials. The order
  // keeps its current status (pending_human_review or human_approved) and
  // gets a synthetic rp order id; the webhook remains the source of truth
  // for transitions to paid.
  if (process.env.TEST_MODE_NO_RAZORPAY === '1') {
    // When the policy requires human approval, do NOT create the Razorpay
    // order yet. The dedicated /api/checkout/human-approve/:orderId route
    // is the only way to flip the order to human_approved AND mint the
    // Razorpay order id.
    if (policy.requiresHumanApproval) {
      res.json({
        orderId,
        transactionId: txnId,
        razorpayOrderId: null,
        amount: Math.round(subtotal * 100),
        currency: 'INR',
        keyId: creds.keyId,
        policy,
        requiresHumanApproval: true,
        evidence: signEvidence({ orderId, amount: subtotal, currency: 'INR', policy, txnId, status: 'pending_human_review' }),
      });
      return;
    }
    const fakeId = `rp_test_${orderId}`;
    await pool.query(
      `INSERT INTO razorpay_attempts
         (order_id, attempt_number, idempotency_key, razorpay_order_id, response_status, completed_at)
       VALUES ($1, 1, $2, $3, 'success', NOW())
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [orderId, createIdemKey, fakeId],
    );
    await pool.query(
      `UPDATE orders SET razorpay_order_id = $1 WHERE id = $2 AND razorpay_create_idem_key = $3`,
      [fakeId, orderId, createIdemKey],
    );
    res.json({
      orderId,
      transactionId: txnId,
      razorpayOrderId: fakeId,
      amount: Math.round(subtotal * 100),
      currency: 'INR',
      keyId: creds.keyId,
      policy,
      evidence: signEvidence({ orderId, amount: subtotal, currency: 'INR', policy, txnId }),
    });
    return;
  }
  // Even in the real-Razorpay path, if the policy requires human approval
  // we do NOT call Razorpay here. The dedicated human-approve route is the
  // single place that flips the order and mints the external order id.
  if (policy.requiresHumanApproval) {
    res.json({
      orderId,
      transactionId: txnId,
      razorpayOrderId: null,
      amount: Math.round(subtotal * 100),
      currency: 'INR',
      keyId: creds.keyId,
      policy,
      requiresHumanApproval: true,
      evidence: signEvidence({ orderId, amount: subtotal, currency: 'INR', policy, txnId, status: 'pending_human_review' }),
    });
    return;
  }
  try {
    const rp = new Razorpay({ key_id: creds.keyId, key_secret: creds.keySecret });
    // The Razorpay SDK supports `idempotency_key`; pass our stable per-order
    // key so a network-timeout retry does not produce a second order.
    const rpOrder = await (rp.orders as unknown as {
      create: (params: Record<string, unknown>, opts?: { idempotency_key?: string }) => Promise<{
        id: string; amount: number; currency: string;
      }>;
    }).create(
      {
        amount: Math.round(subtotal * 100),
        currency: 'INR',
        receipt: `order_${orderId}`,
        notes: { commerce0s_order_id: String(orderId) },
      },
      { idempotency_key: createIdemKey },
    );
    rpOrderId = rpOrder.id;
    rpOrderAmount = rpOrder.amount;
    await emitProtocolEvent({
      protocol: 'RAZORPAY',
      direction: 'outbound',
      source: 'merchant',
      target: 'api.razorpay.com',
      action: 'razorpay_create_order',
      status: 'success',
      latencyMs: Date.now() - tRzp,
      txnId,
      workspaceId,
      detail: `order=${rpOrder.id} amount=${rpOrder.amount}`,
    }).catch(() => {});
    // Persist the attempt + the external order id. Conditional on
    // razorpay_create_idem_key so concurrent retries can't double-write.
    await pool.query(
      `INSERT INTO razorpay_attempts
         (order_id, attempt_number, idempotency_key, razorpay_order_id, response_status, completed_at)
       VALUES ($1, 1, $2, $3, 'success', NOW())
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [orderId, createIdemKey, rpOrder.id],
    );
    await pool.query(
      `UPDATE orders SET razorpay_order_id = $1 WHERE id = $2 AND razorpay_create_idem_key = $3`,
      [rpOrder.id, orderId, createIdemKey],
    );
    res.json({
      orderId,
      transactionId: txnId,
      razorpayOrderId: rpOrder.id,
      amount: rpOrder.amount,
      currency: rpOrder.currency,
      keyId: creds.keyId,
      policy,
      evidence: signEvidence({ orderId, amount: subtotal, currency: 'INR', policy, txnId }),
    });
  } catch (err) {
    const e = err as { statusCode?: number; message?: string };
    const status = e?.statusCode;
    console.error('checkout/start: Razorpay create failed:', e?.message ?? err);
    await emitProtocolEvent({
      protocol: 'RAZORPAY',
      direction: 'outbound',
      source: 'merchant',
      target: 'api.razorpay.com',
      action: 'razorpay_create_order',
      status: 'failed',
      latencyMs: Date.now() - tRzp,
      txnId,
      workspaceId,
      detail: e?.message ?? 'unknown',
    }).catch(() => {});
    // Record the failed attempt so the reconciler can see what was tried.
    await pool.query(
      `INSERT INTO razorpay_attempts
         (order_id, attempt_number, idempotency_key, response_status, response_body, completed_at)
       VALUES ($1, 1, $2, 'failed', $3::jsonb, NOW())
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [orderId, createIdemKey, JSON.stringify({ message: e?.message ?? 'unknown', statusCode: status ?? null })],
    ).catch(() => {});
    // If the failure looks like a network timeout / 5xx, leave the order
    // in its intermediate state and stamp payment_pending_since so the
    // reconciler can retry. The webhook (when it arrives) will still flip
    // it to paid.
    const isUpstream = !status || status >= 500;
    if (isUpstream) {
      await pool.query(
        `UPDATE orders SET payment_pending_since = NOW()
         WHERE id = $1 AND razorpay_create_idem_key = $2`,
        [orderId, createIdemKey],
      );
    }
    if (status === 401 || status === 403) {
      res.status(401).json({
        error: {
          code: 'RAZORPAY_AUTH_FAILED',
          message: 'Razorpay rejected the saved credentials.',
        },
      });
      return;
    }
    if (status && status >= 500) {
      res.status(502).json({
        error: { code: 'RAZORPAY_REQUEST_FAILED', message: 'Payment provider unreachable.' },
      });
      return;
    }
    res.status(502).json({
      error: { code: 'ORDER_CREATE_FAILED', message: 'Could not start the payment.' },
    });
  }
  // Silence unused locals that exist for future reconciler fields.
  void rpOrderId; void rpOrderAmount;
});
// State machine: paid|disputed → refund_requested → refunded | refund_failed.
// Amount is loaded from the order row — the client never gets to set it.
app.post('/api/orders/:id/refund', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid order id.' } });
    return;
  }
  const workspaceId = String(req.body?.workspaceId ?? '').trim();
  if (!workspaceId) {
    res.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'workspaceId is required.' },
    });
    return;
  }

  let creds: ResolvedRazorpayCreds | null = null;
  try {
    creds = await resolveRazorpayCreds();
  } catch (err) {
    console.error('refund: failed to resolve credentials:', err);
    res
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'Could not read payment credentials.' } });
    return;
  }
  if (!creds) {
    res.status(409).json({
      error: {
        code: 'RAZORPAY_NOT_CONFIGURED',
        message:
          'No Razorpay credentials are configured. Add them in Settings → Payment gateway before refunding.',
      },
    });
    return;
  }

  try {
    const { rows } = await pool.query<{
      id: number;
      status: string;
      amount: number | string;
      razorpay_payment_id: string | null;
      razorpay_refund_id: string | null;
      transaction_id: string | null;
      workspace_id: string;
    }>(
      `SELECT id, status, amount, razorpay_payment_id, razorpay_refund_id,
              transaction_id, workspace_id
       FROM orders WHERE id = $1`,
      [id],
    );
    if (rows.length === 0 || rows[0].workspace_id !== workspaceId) {
      // Same response as not-found — never leak existence across workspaces.
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order not found.' } });
      return;
    }
    const order = rows[0];
    if (order.status === 'refunded' || order.status === 'refund_requested') {
      res.status(409).json({
        error: {
          code: 'ALREADY_REFUNDED',
          message: `Order is already ${order.status}.`,
        },
      });
      return;
    }
    if (order.status !== 'paid' && order.status !== 'disputed') {
      res.status(409).json({
        error: {
          code: 'NOT_REFUNDABLE',
          message: `Only paid or disputed orders can be refunded (current: ${order.status}).`,
        },
      });
      return;
    }
    if (!order.razorpay_payment_id) {
      res.status(409).json({
        error: {
          code: 'NO_PAYMENT',
          message: 'No Razorpay payment recorded for this order — cannot refund.',
        },
      });
      return;
    }

    const refundAmount = Math.round(Number(order.amount) * 100);

    // Move to refund_requested in a transaction. Status + audit log commit
    // together. Two concurrent refund clicks can't both win because the
    // transition is guarded by status IN ('paid','disputed') and the unique
    // row update is the only path.
    const claimed = await withTransaction(async (client) => {
      const r = await markRefundRequested(client, {
        orderId: id,
        transactionId: order.transaction_id,
        workspaceId: merchantWorkspace(),
        amount: refundAmount / 100,
        refundAmount: refundAmount / 100,
        refundRequestedAt: new Date().toISOString(),
        actor: 'merchant',
        detail: `Order ${id} refund requested · ₹${(refundAmount/100).toFixed(2)}`,
        outcome: 'pending',
      });
      if (r.outcome !== 'transitioned') return null;
      return r;
    });
    if (!claimed) {
      res.status(409).json({
        error: { code: 'STATE_CHANGED', message: 'Refund already in progress.' },
      });
      return;
    }

    try {
      // Test hook: short-circuit Razorpay refund. Mirrors the success path
      // with a synthetic refund id so the state machine can be exercised.
      const refund: { id: string } = process.env.TEST_MODE_NO_RAZORPAY === '1'
        ? { id: `rfd_test_${id}` }
        : await (new Razorpay({ key_id: creds.keyId, key_secret: creds.keySecret }).payments as unknown as {
            refund: (id: string, p: { amount: number }) => Promise<{ id: string }>;
          }).refund(order.razorpay_payment_id as string, { amount: refundAmount });

      const updated = await withTransaction(async (client) => {
        const r = await markRefunded(client, {
          orderId: id,
          transactionId: order.transaction_id,
          workspaceId: merchantWorkspace(),
          amount: Number(order.amount),
          razorpayRefundId: refund.id,
          actor: 'merchant',
          detail: `Order ${id} refunded via Razorpay (refund ${refund.id})`,
          outcome: 'success',
        });
        if (r.outcome === 'transitioned') {
          await emitProtocolEventTx({
            pool: client,
            transactionId: order.transaction_id ?? '',
            workspaceId: merchantWorkspace(),
            protocol: 'system',
            action: 'refund_processed',
            payload: { orderId: id, refundId: refund.id, source: 'merchant_api' },
            client,
          });
        }
        return r.outcome === 'transitioned' ? { id, status: 'refunded' as const } : null;
      });
      res.json({ order: updated ?? { id, status: 'refunded' }, refundId: refund.id });
    } catch (rzpErr) {
      const e = rzpErr as { statusCode?: number; message?: string };
      // Atomic flip from refund_requested → refund_failed with audit.
      await withTransaction(async (client) => {
        const r = await markRefundFailed(client, {
          orderId: id,
          transactionId: order.transaction_id,
          workspaceId: merchantWorkspace(),
          amount: refundAmount / 100,
          refundAmount: refundAmount / 100,
          actor: 'merchant',
          detail: `Order ${id} refund failed: ${e?.message ?? 'unknown'}`,
          outcome: 'failed',
        });
        if (r.outcome === 'transitioned') {
          await emitProtocolEventTx({
            pool: client,
            transactionId: order.transaction_id ?? '',
            workspaceId: merchantWorkspace(),
            protocol: 'system',
            action: 'refund_failed',
            payload: { orderId: id, reason: e?.message ?? 'unknown', source: 'merchant_api' },
            client,
          });
        }
      });
      const status = e?.statusCode;
      if (status === 401 || status === 403) {
        res.status(401).json({
          error: { code: 'RAZORPAY_AUTH_FAILED', message: 'Razorpay rejected the saved credentials.' },
        });
        return;
      }
      if (status && status >= 500) {
        res.status(502).json({
          error: {
            code: 'RAZORPAY_REQUEST_FAILED',
            message: 'Payment provider is temporarily unreachable.',
          },
        });
        return;
      }
      res.status(502).json({
        error: {
          code: 'REFUND_FAILED',
          message: 'Could not process the refund. Try again or contact support.',
        },
      });
    }
  } catch (err) {
    console.error('POST /api/orders/:id/refund error:', err);
    res
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to start refund.' } });
  }
});

// ── Merchant settings ─────────────────────────────────────────────────────

interface MerchantSettingsRow {
  merchant_id: string;
  max_auto_approve: number;
  require_human_above_cap: boolean;
}

async function ensureMerchantSettingsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS merchant_settings (
      merchant_id          TEXT PRIMARY KEY DEFAULT 'default',
      max_auto_approve     NUMERIC(12,2) NOT NULL DEFAULT 180.00,
      require_human_above_cap BOOLEAN NOT NULL DEFAULT TRUE
    );
  `);
  // Seed default row if empty
  const { rowCount } = await pool.query('SELECT 1 FROM merchant_settings LIMIT 1');
  if (rowCount === 0) {
    await pool.query(
      `INSERT INTO merchant_settings (merchant_id, max_auto_approve, require_human_above_cap)
       VALUES ('default', 180.00, TRUE)`,
    );
  }
}

// GET /api/settings — read current merchant settings
app.get('/api/settings', async (_req, res) => {
  try {
    const { rows } = await pool.query<MerchantSettingsRow>(
      'SELECT merchant_id, max_auto_approve, require_human_above_cap FROM merchant_settings WHERE merchant_id = $1',
      ['default'],
    );
    if (rows.length === 0) {
      res
        .status(404)
        .json({ error: { code: 'NOT_FOUND', message: 'No settings found for this merchant.' } });
      return;
    }
    const r = rows[0];
    res.json({
      merchantId: r.merchant_id,
      maxAutoApprove: Number(r.max_auto_approve),
      requireHumanAboveCap: r.require_human_above_cap,
    });
  } catch (err) {
    console.error('GET /api/settings error:', err);
    res
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch settings.' } });
  }
});

// PUT /api/settings — update merchant settings
app.put('/api/settings', async (req, res) => {
  const { maxAutoApprove, requireHumanAboveCap } = req.body ?? {};
  try {
    const { rows } = await pool.query<MerchantSettingsRow>(
      `UPDATE merchant_settings
       SET max_auto_approve = COALESCE($1, max_auto_approve),
           require_human_above_cap = COALESCE($2, require_human_above_cap)
       WHERE merchant_id = 'default'
       RETURNING merchant_id, max_auto_approve, require_human_above_cap`,
      [
        maxAutoApprove != null ? Number(maxAutoApprove) : null,
        requireHumanAboveCap != null ? Boolean(requireHumanAboveCap) : null,
      ],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Settings row not found.' } });
      return;
    }
    const r = rows[0];
    res.json({
      merchantId: r.merchant_id,
      maxAutoApprove: Number(r.max_auto_approve),
      requireHumanAboveCap: r.require_human_above_cap,
    });
  } catch (err) {
    console.error('PUT /api/settings error:', err);
    res
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update settings.' } });
  }
});

// ── Razorpay settings (per-merchant, encrypted at rest) ───────────────────

// GET /api/settings/razorpay — return keyId + configured flag, never the secret
app.get('/api/settings/razorpay', async (_req, res) => {
  try {
    const { rows } = await pool.query<MerchantCredentialsRow>(
      `SELECT merchant_id, razorpay_key_id, updated_at
       FROM merchant_credentials WHERE merchant_id = $1`,
      ['default'],
    );
    if (rows.length === 0) {
      res.json({ keyId: null, configured: false, source: 'none', updatedAt: null });
      return;
    }
    const r = rows[0];
    res.json({
      keyId: r.razorpay_key_id,
      configured: true,
      source: 'merchant_row',
      updatedAt: r.updated_at,
    });
  } catch (err) {
    console.error('GET /api/settings/razorpay error:', err);
    res
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to read Razorpay settings.' } });
  }
});

// PUT /api/settings/razorpay — encrypt and upsert credentials
app.put('/api/settings/razorpay', async (req, res) => {
  const { keyId, keySecret, webhookSecret } = req.body ?? {};

  if (!keyId || typeof keyId !== 'string') {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'keyId is required.' } });
    return;
  }
  if (!keySecret || typeof keySecret !== 'string') {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'keySecret is required.' } });
    return;
  }
  if (!webhookSecret || typeof webhookSecret !== 'string') {
    res
      .status(400)
      .json({ error: { code: 'INVALID_REQUEST', message: 'webhookSecret is required.' } });
    return;
  }
  if (!keyId.startsWith('rzp_test_')) {
    res.status(400).json({
      error: {
        code: 'INVALID_KEY_PREFIX',
        message: 'Key ID must start with rzp_test_ — only test-mode keys are accepted.',
      },
    });
    return;
  }

  try {
    const encSecret = encryptSecret(keySecret);
    const encWebhook = encryptSecret(webhookSecret);
    await pool.query(
      `INSERT INTO merchant_credentials
         (merchant_id, razorpay_key_id, razorpay_key_secret_encrypted, razorpay_webhook_secret_encrypted, updated_at)
       VALUES ('default', $1, $2, $3, NOW())
       ON CONFLICT (merchant_id) DO UPDATE SET
         razorpay_key_id = EXCLUDED.razorpay_key_id,
         razorpay_key_secret_encrypted = EXCLUDED.razorpay_key_secret_encrypted,
         razorpay_webhook_secret_encrypted = EXCLUDED.razorpay_webhook_secret_encrypted,
         updated_at = NOW()`,
      [keyId, encSecret, encWebhook],
    );
    res.json({ keyId, configured: true });
  } catch (err) {
    console.error('PUT /api/settings/razorpay error:', err);
    const msg = err instanceof Error ? err.message : String(err);
    res
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: `Failed to save credentials: ${msg}` } });
  }
});

// POST /api/settings/razorpay/test — make one lightweight Razorpay call
app.post('/api/settings/razorpay/test', async (_req, res) => {
  let creds: ResolvedRazorpayCreds | null = null;
  try {
    creds = await resolveRazorpayCreds();
  } catch (err) {
    console.error('test credentials: failed to resolve:', err);
    res
      .status(500)
      .json({ valid: false, message: 'Could not read stored credentials. Check the server log.' });
    return;
  }
  if (!creds) {
    res.status(409).json({
      valid: false,
      message:
        'No Razorpay credentials are saved yet. Add them in Settings → Payment gateway first.',
    });
    return;
  }
  try {
    const auth = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64');
    const r = await fetch('https://api.razorpay.com/v1/orders?count=1', {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (r.ok) {
      res.json({ valid: true, message: 'Razorpay accepted the saved credentials.' });
      return;
    }
    if (r.status === 401 || r.status === 403) {
      res.status(401).json({
        valid: false,
        message: 'Razorpay rejected the saved credentials — check the key pair.',
      });
      return;
    }
    res.status(502).json({ valid: false, message: `Razorpay responded with status ${r.status}.` });
  } catch (err) {
    console.error('test credentials: Razorpay call failed:', err);
    res.status(502).json({
      valid: false,
      message: 'Could not reach Razorpay. Check your network or try again shortly.',
    });
  }
});

// ── Reconciliation + admin actions ─────────────────────────────────────────
//
// These are operator endpoints, not buyer/merchant flows. They require a
// shared admin token from the ADMIN_TOKEN env var (X-Admin-Token header).
// Designed to be safe to call repeatedly — every action is idempotent.

function adminAuthOk(req: { headers: Record<string, unknown> }): boolean {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false; // disabled if not configured
  const supplied = req.headers['x-admin-token'];
  if (typeof supplied !== 'string' || supplied.length === 0) return false;
  if (supplied.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  } catch {
    return false;
  }
}

// POST /api/admin/razorpay/reconcile — scan orders that the API created
// but whose Razorpay response was lost (network timeout, process crash).
// For each, attempt to fetch the external order via the SDK; if it
// already exists, persist the id; otherwise create a new one with the
// same idempotency key. Idempotent: a second call is a no-op for orders
// that already advanced.
app.post('/api/admin/razorpay/reconcile', async (req, res) => {
  if (!adminAuthOk(req)) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Admin token required.' } });
    return;
  }
  let creds: ResolvedRazorpayCreds | null = null;
  try { creds = await resolveRazorpayCreds(); } catch { /* swallow */ }
  if (!creds) {
    res.status(409).json({ error: { code: 'RAZORPAY_NOT_CONFIGURED', message: 'No credentials.' } });
    return;
  }
  try {
    // Find orders that committed internally but never received a Razorpay
    // order id. These are the candidates for reconciliation.
    const { rows: candidates } = await pool.query<{
      id: number; razorpay_create_idem_key: string | null; amount: number | string;
      transaction_id: string | null; workspace_id: string;
    }>(
      `SELECT id, razorpay_create_idem_key, amount, transaction_id, workspace_id
         FROM orders
        WHERE razorpay_order_id IS NULL
          AND razorpay_create_idem_key IS NOT NULL
          AND status IN ('pending_human_review','human_approved')
        ORDER BY created_at ASC
        LIMIT 50`,
    );
    const results: Array<{ orderId: number; action: string; razorpayOrderId?: string }> = [];
    for (const c of candidates) {
      if (!c.razorpay_create_idem_key) continue;
      // Has the attempt table already recorded a success for this key? If
      // so, recover the order id and persist it.
      const { rows: prior } = await pool.query<{ razorpay_order_id: string | null }>(
        `SELECT razorpay_order_id FROM razorpay_attempts
          WHERE idempotency_key = $1 AND response_status = 'success'
          ORDER BY attempt_number DESC LIMIT 1`,
        [c.razorpay_create_idem_key],
      );
      if (prior[0]?.razorpay_order_id) {
        await pool.query(
          `UPDATE orders SET razorpay_order_id = $1
            WHERE id = $2 AND razorpay_order_id IS NULL`,
          [prior[0].razorpay_order_id, c.id],
        );
        results.push({ orderId: c.id, action: 'recovered_from_attempt', razorpayOrderId: prior[0].razorpay_order_id });
        continue;
      }
      // Otherwise, retry the create. The SDK dedupes on idempotency_key.
      try {
        const rp = new Razorpay({ key_id: creds.keyId, key_secret: creds.keySecret });
        const rpOrder = await (rp.orders as unknown as {
          create: (p: Record<string, unknown>, o?: { idempotency_key?: string }) => Promise<{ id: string; amount: number }>;
        }).create(
          {
            amount: Math.round(Number(c.amount) * 100),
            currency: 'INR',
            receipt: `order_${c.id}`,
            notes: { commerce0s_order_id: String(c.id) },
          },
          { idempotency_key: c.razorpay_create_idem_key },
        );
        await pool.query(
          `INSERT INTO razorpay_attempts
             (order_id, attempt_number, idempotency_key, razorpay_order_id, response_status, completed_at)
           VALUES ($1,
             (SELECT COALESCE(MAX(attempt_number),0)+1 FROM razorpay_attempts WHERE order_id = $1),
             $2, $3, 'success', NOW())
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [c.id, c.razorpay_create_idem_key, rpOrder.id],
        );
        await pool.query(
          `UPDATE orders SET razorpay_order_id = $1
            WHERE id = $2 AND razorpay_order_id IS NULL`,
          [rpOrder.id, c.id],
        );
        await recordEvent({
          pool,
          txnId: c.transaction_id,
          workspaceId: c.workspace_id,
          actor: 'admin.reconcile',
          action: 'razorpay_order_recovered',
          detail: `Order ${c.id} reconciled → ${rpOrder.id}`,
          amount: Number(c.amount),
          outcome: 'success',
        });
        results.push({ orderId: c.id, action: 'recreated', razorpayOrderId: rpOrder.id });
      } catch (err) {
        const e = err as { message?: string };
        results.push({ orderId: c.id, action: `reconcile_failed: ${e?.message ?? 'unknown'}` });
      }
    }
    res.json({ reconciled: results.length, results });
  } catch (err) {
    console.error('reconcile error:', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Reconcile failed.' } });
  }
});

// POST /api/admin/razorpay/refunds/reconcile — for orders stuck in
// refund_requested (Razorpay call lost after commit), look up the
// external refund and advance to refunded | refund_failed.
app.post('/api/admin/razorpay/refunds/reconcile', async (req, res) => {
  if (!adminAuthOk(req)) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Admin token required.' } });
    return;
  }
  let creds: ResolvedRazorpayCreds | null = null;
  try { creds = await resolveRazorpayCreds(); } catch { /* swallow */ }
  if (!creds) {
    res.status(409).json({ error: { code: 'RAZORPAY_NOT_CONFIGURED', message: 'No credentials.' } });
    return;
  }
  try {
    const { rows: candidates } = await pool.query<{
      id: number; razorpay_payment_id: string | null; amount: number | string;
      transaction_id: string | null; workspace_id: string;
    }>(
      `SELECT id, razorpay_payment_id, amount, transaction_id, workspace_id
         FROM orders
        WHERE status = 'refund_requested'
          AND razorpay_payment_id IS NOT NULL
        ORDER BY refund_requested_at ASC NULLS LAST
        LIMIT 50`,
    );
    const rp = new Razorpay({ key_id: creds.keyId, key_secret: creds.keySecret });
    const results: Array<{ orderId: number; action: string; refundId?: string }> = [];
    for (const c of candidates) {
      if (!c.razorpay_payment_id) continue;
      try {
        const refunds = await (rp.payments as unknown as {
          fetch: (id: string) => Promise<unknown>;
          refund: (id: string, p: { amount: number }, o?: { idempotency_key?: string }) => Promise<{ id: string }>;
        }).fetch(c.razorpay_payment_id).catch(() => null);
        // List refunds for the payment. The SDK returns either the payment
        // object or null; for an authoritative list we use the dedicated
        // refunds listing when available.
        const list = await fetch(`https://api.razorpay.com/v1/payments/${c.razorpay_payment_id}/refunds`, {
          headers: { Authorization: `Basic ${Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64')}` },
        }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        const items: Array<{ amount: number; status: string; id: string }> =
          (list as { items?: Array<{ amount: number; status: string; id: string }> } | null)?.items ?? [];
        const found = items.find(
          (r) => r.amount === Math.round(Number(c.amount) * 100) && r.status === 'processed',
        );
        if (found) {
          await withTransaction(async (client) => {
            const r = await markRefunded(client, {
              orderId: c.id,
              transactionId: c.transaction_id,
              workspaceId: c.workspace_id,
              amount: Number(c.amount),
              razorpayRefundId: found.id,
              actor: 'admin.reconcile',
              detail: `Refund ${found.id} confirmed for order ${c.id}`,
              outcome: 'success',
            });
            if (r.outcome === 'transitioned') {
              await emitProtocolEventTx({
                pool: client,
                transactionId: c.transaction_id ?? '',
                workspaceId: c.workspace_id,
                protocol: 'system',
                action: 'refund_processed',
                payload: { orderId: c.id, refundId: found.id, source: 'reconcile' },
                client,
              });
            }
          });
          results.push({ orderId: c.id, action: 'recovered', refundId: found.id });
        } else {
          // No matching processed refund yet — either still pending or
          // genuinely failed. We leave the order in refund_requested and
          // do nothing; the next reconcile pass will re-check.
          results.push({ orderId: c.id, action: 'still_pending' });
        }
        void refunds;
      } catch (err) {
        const e = err as { message?: string };
        results.push({ orderId: c.id, action: `reconcile_failed: ${e?.message ?? 'unknown'}` });
      }
    }
    res.json({ reconciled: results.length, results });
  } catch (err) {
    console.error('refund reconcile error:', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Reconcile failed.' } });
  }
});

// POST /api/admin/orders/:id/cancel — cancel an unpaid order and restore
// inventory. Idempotent: a second call on a cancelled or paid order is
// a no-op.
app.post('/api/admin/orders/:id/cancel', async (req, res) => {
  if (!adminAuthOk(req)) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Admin token required.' } });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid order id.' } });
    return;
  }
  try {
    const result = await withTransaction(async (client) => {
      const { rows: o } = await client.query<{
        id: number; status: string; basket: Array<{ productId: number }> | null;
        workspace_id: string; transaction_id: string | null;
      }>(
        `SELECT id, status, basket, workspace_id, transaction_id FROM orders WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (o.length === 0) return null;
      const order = o[0];
      if (order.status === 'paid' || order.status === 'disputed' || order.status === 'refunded') {
        return { orderId: id, action: 'noop_terminal' as const };
      }
      const updated = await transitionOrderWithExtras(
        id,
        ['pending_human_review', 'human_approved', 'pending', 'failed'],
        'cancelled',
        {},
        client,
      );
      if (!updated) return { orderId: id, action: 'noop_already' as const };
      // Restore stock.
      if (order.basket && Array.isArray(order.basket)) {
        for (const it of order.basket) {
          if (typeof it.productId === 'number') {
            await restoreInventory(client, id, [{ productId: it.productId, quantity: 1 }]);
          }
        }
      }
      await client.query(
        `INSERT INTO audit_log
           (transaction_id, workspace_id, actor, action, detail, outcome)
         VALUES ($1, $2, 'admin', 'order_cancelled', $3, 'success')`,
        [order.transaction_id, order.workspace_id, `Order ${id} cancelled by admin; stock restored`],
      );
      return { orderId: id, action: 'cancelled' as const };
    });
    if (!result) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order not found.' } });
      return;
    }
    res.json(result);
  } catch (err) {
    console.error('cancel error:', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Cancel failed.' } });
  }
});

// ── Checkout human-approve gate ────────────────────────────────────────────

// POST /api/checkout/human-approve/:orderId — flip an order from pending to human-approved
app.post('/api/checkout/human-approve/:orderId', async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isFinite(orderId)) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid order id.' } });
    return;
  }
  // Workspace isolation: the merchant must be in the same workspace as the
  // order, or a member of the merchant workspace (cross-workspace approval
  // returns the same 404 as a not-found order).
  const requestWs = (req.body?.workspaceId as string | undefined)?.trim() || merchantWorkspace();
  try {
    const result = await withTransaction(async (client) => {
      // Workspace check FIRST so a cross-workspace attacker never observes
      // the difference between "no such order" and "wrong workspace".
      const { rows: wsRows } = await client.query<{ workspace_id: string | null; status: string }>(
        `SELECT workspace_id, status FROM orders WHERE id = $1`,
        [orderId],
      );
      if (wsRows.length === 0) return { blocked: 'NOT_FOUND' as const };
      if (
        wsRows[0].workspace_id !== requestWs &&
        wsRows[0].workspace_id !== merchantWorkspace()
      ) {
        return { blocked: 'NOT_FOUND' as const };
      }
      if (wsRows[0].status !== 'pending_human_review') {
        return { blocked: 'NOT_FOUND' as const };
      }
      // Atomic transition: status flip + audit row + outbox event commit
      // together. Two simultaneous merchant clicks both call this — only
      // one UPDATE will return a row because the WHERE clause excludes
      // already-approved orders. The other gets rowCount=0 and we return
      // null. The outbox row is written inside the same tx so a protocol
      // event can never exist without its business state.
      const upd = await client.query<{
        id: number; product_id: number; buyer_agent_id: string;
        amount: string; status: string; created_at: string; transaction_id: string | null;
        workspace_id: string | null; razorpay_create_idem_key: string | null;
      }>(
        `UPDATE orders SET status = 'human_approved', human_approved_at = NOW()
         WHERE id = $1 AND status = 'pending_human_review'
         RETURNING id, product_id, buyer_agent_id, amount, status, created_at, transaction_id, workspace_id, razorpay_create_idem_key`,
        [orderId],
      );
      if (upd.rowCount === 0) return { blocked: 'NOT_FOUND' as const };
      const r = upd.rows[0];
      // STRICT audit: failure rolls the transition back.
      await recordEvent({
        pool: client,
        strict: true,
        txnId: r.transaction_id,
        workspaceId: r.workspace_id,
        actor: 'merchant',
        action: 'human_override',
        detail: `Manual override for order ${orderId}`,
        amount: Number(r.amount),
        outcome: 'approved',
      });
      // Outbox event for downstream A2A/ACP notification.
      await emitProtocolEventTx({
        pool: client,
        transactionId: r.transaction_id ?? '',
        workspaceId: r.workspace_id ?? requestWs,
        protocol: 'system',
        action: 'human_override',
        payload: { orderId, amount: Number(r.amount), status: 'human_approved' },
        client,
      });
      return { row: r };
    });
    if ('blocked' in result) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Order not found or not awaiting human review.' },
      });
      return;
    }
    const r = result.row;
    if (!result) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Order not found or not awaiting human review.' },
      });
      return;
    }

    // After approval, mint the Razorpay order (or a synthetic one in test
    // mode). This is the ONLY place the external order id is created for
    // an approval-required basket.
    const idemKey = r.razorpay_create_idem_key;
    const amountPaise = Math.round(Number(r.amount) * 100);
    let razorpayOrderId: string | null = null;
    let keyId: string | null = null;

    if (process.env.TEST_MODE_NO_RAZORPAY === '1') {
      razorpayOrderId = `rp_test_${r.id}`;
      try {
        const creds = await resolveRazorpayCreds();
        if (creds) keyId = creds.keyId;
      } catch { /* keyId stays null; client will surface error */ }
    } else {
      try {
        const creds = await resolveRazorpayCreds();
        if (!creds) {
          res.status(409).json({
            error: {
              code: 'RAZORPAY_NOT_CONFIGURED',
              message: 'No Razorpay credentials configured. Add them in Settings → Payment gateway.',
            },
          });
          return;
        }
        keyId = creds.keyId;
        const rp = new Razorpay({ key_id: creds.keyId, key_secret: creds.keySecret });
        const rpOrder = await (rp.orders as unknown as {
          create: (params: Record<string, unknown>, opts?: { idempotency_key?: string }) => Promise<{ id: string; amount: number; currency: string }>;
        }).create(
          {
            amount: amountPaise,
            currency: 'INR',
            receipt: `order_${r.id}`,
            notes: { commerce0s_order_id: String(r.id) },
          },
          { idempotency_key: idemKey ?? `c0s_ord_${r.transaction_id}` },
        );
        razorpayOrderId = rpOrder.id;
      } catch (err) {
        console.error('human-approve: Razorpay create failed:', err);
        res.status(502).json({
          error: { code: 'RAZORPAY_CREATE_FAILED', message: 'Could not create Razorpay order after approval.' },
        });
        return;
      }
    }

    if (razorpayOrderId && idemKey) {
      await pool.query(
        `INSERT INTO razorpay_attempts
           (order_id, attempt_number, idempotency_key, razorpay_order_id, response_status, completed_at)
         VALUES ($1, 1, $2, $3, 'success', NOW())
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [r.id, idemKey, razorpayOrderId],
      );
      await pool.query(
        `UPDATE orders SET razorpay_order_id = $1 WHERE id = $2 AND razorpay_create_idem_key = $3`,
        [razorpayOrderId, r.id, idemKey],
      );
    }

    res.json({
      ...r,
      razorpayOrderId,
      keyId,
      amount: amountPaise,
      currency: 'INR',
    });
  } catch (err) {
    console.error('POST /api/checkout/human-approve error:', err);
    res
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to approve order.' } });
  }
});

// ── Buyer query orchestration ──────────────────────────────────────────────

// Trace steps are persisted to trace_events for the audit log; the response
// carries the same array so the client renders it directly. No SSE — the
// POST returns everything the trace page needs.
interface TraceStep {
  label: string;
  detail: string;
  timestamp: string;
}

// ── In-memory catalog cache (for fallback when supplier is unreachable) ──
let catalogCache: NormalizedProduct[] = [];
let catalogCacheTime: Date | null = null;

// ── Debug toggle: simulate supplier agent failure ──────────────────────────
let simulateSupplierFailure = false;

// Ensure trace_events table exists
async function ensureTraceEventsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trace_events (
      id          SERIAL PRIMARY KEY,
      session_id  TEXT NOT NULL,
      step_index  INTEGER NOT NULL,
      label       TEXT NOT NULL,
      detail      TEXT NOT NULL,
      timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_trace_events_session ON trace_events(session_id)',
  );
}

// Parse intent from a natural language prompt
function parseIntent(prompt: string): { constraints: string[]; keywords: string[] } {
  const constraints: string[] = [];
  const keywords: string[] = [];

  // Price ceiling
  const priceMatch = prompt.match(/under\s+\$?(\d+)/i);
  if (priceMatch) {
    constraints.push(`price ≤ $${priceMatch[1]}`);
  }

  // Category keywords
  const categoryWords = [
    'lamp',
    'light',
    'desk',
    'chair',
    'table',
    'monitor',
    'keyboard',
    'mouse',
    'notebook',
    'pen',
    'organizer',
    'speaker',
    'headphone',
    'charger',
    'stand',
    'holder',
    'cable',
    'adapter',
  ];
  for (const word of categoryWords) {
    if (prompt.toLowerCase().includes(word)) {
      keywords.push(word);
      constraints.push(`category includes "${word}"`);
    }
  }

  // Quality signals
  if (/quiet|silent|noise/.test(prompt.toLowerCase())) constraints.push('quiet / silent operation');
  if (/warm|cozy/.test(prompt.toLowerCase())) constraints.push('warm tone');
  if (/bright/.test(prompt.toLowerCase())) constraints.push('bright output');

  // Delivery
  if (/this week|soon|fast|quick/.test(prompt.toLowerCase()))
    constraints.push('delivery this week');

  return { constraints, keywords };
}

// Score a product against the parsed intent
function scoreProduct(
  product: NormalizedProduct,
  constraints: string[],
  keywords: string[],
): { score: number; matches: number } {
  let score = 0;
  let matches = 0;
  const text =
    `${product.name} ${product.sku} ${product.description ?? ''} ${product.category ?? ''}`.toLowerCase();

  // Price constraint
  for (const c of constraints) {
    const priceMatch = c.match(/price ≤ \$?(\d+)/);
    if (priceMatch) {
      const ceiling = Number(priceMatch[1]);
      if (product.price <= ceiling) {
        score += 0.3;
        matches++;
      }
    }
  }

  // Keyword matches
  for (const kw of keywords) {
    if (text.includes(kw)) {
      score += 0.15;
      matches++;
    }
  }

  // Stock bonus
  if (product.inStock) score += 0.1;

  return { score: Math.min(score, 1), matches };
}

// POST /api/buyer/query — orchestrates buyer intent → catalog search → policy check → decision
app.post('/api/buyer/query', buyerQueryLimiter, async (req, res) => {
  const { prompt, maxSpend } = req.body ?? {};
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    res.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Please type what you want the agent to find before submitting.',
      },
    });
    return;
  }
  // Buyer-side ceiling (Section B). Optional; ignored when not finite or <= 0.
  const buyerMax = Number(maxSpend);
  const buyerSpendCeiling = Number.isFinite(buyerMax) && buyerMax > 0 ? buyerMax : null;

  const sessionId = `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const steps: TraceStep[] = [];

  const emit = (step: TraceStep) => {
    steps.push(step);
    // Persist to DB (fire-and-forget)
    pool
      .query(
        'INSERT INTO trace_events (session_id, step_index, label, detail) VALUES ($1, $2, $3, $4)',
        [sessionId, steps.length - 1, step.label, step.detail],
      )
      .catch(() => {});
  };

  const now = () => new Date().toISOString().replace('T', ' ').slice(0, 8);

  // Step 1: Intent parsed
  const { constraints, keywords } = parseIntent(prompt);
  emit({
    label: 'Intent received',
    detail: `${constraints.length} constraints extracted`,
    timestamp: now(),
  });

  // Step 2: Search catalog — with supplier connectivity check, retry, and cache fallback
  const RETAILER_URL = process.env.RETAILER_URL ?? 'http://localhost:8082';
  let products: NormalizedProduct[] = [];
  let catalogSource: 'live' | 'retry' | 'cache' = 'live';

  const fetchCatalogFromSupplier = async (): Promise<NormalizedProduct[]> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const t0 = Date.now();
    try {
      const res = await fetch(`${RETAILER_URL}/health`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`Retailer health check returned ${res.status}`);
      // Supplier is reachable — query DB for catalog (as if retailer synced it)
      const { rows } = await pool.query<ProductRow>(
        `SELECT ${CATALOG_COLS}
         FROM products
         WHERE enable_search = TRUE AND status != 'archived'
         ORDER BY id`,
      );
      clearTimeout(timer);
      await emitProtocolEvent({
        protocol: 'A2A',
        direction: 'outbound',
        source: 'buyer_agent',
        target: RETAILER_URL,
        action: 'a2a_request',
        status: 'success',
        latencyMs: Date.now() - t0,
        sessionId,
        detail: `catalog health check, ${rows.length} products`,
      }).catch(() => {});
      return rows.map(normalizeProduct);
    } catch (err) {
      clearTimeout(timer);
      await emitProtocolEvent({
        protocol: 'A2A',
        direction: 'outbound',
        source: 'buyer_agent',
        target: RETAILER_URL,
        action: 'a2a_request',
        status: 'failed',
        latencyMs: Date.now() - t0,
        sessionId,
        detail: (err as Error).message,
      }).catch(() => {});
      throw err;
    }
  };

  // Check if we should simulate a failure
  const failThisQuery = simulateSupplierFailure;

  if (failThisQuery) {
    // Simulate failure: emit failure trace event
    emit({
      label: 'Catalog query failed',
      detail: 'Supplier agent unreachable — retrying once',
      timestamp: now(),
    });
    // Persist failure as audit event
    pool
      .query(
        `INSERT INTO trace_events (session_id, step_index, label, detail)
       VALUES ($1, $2, 'catalog_query_failed', 'Supplier unreachable, attempting retry')`,
        [sessionId, steps.length - 1],
      )
      .catch(() => {});
    pool
      .query(
        `INSERT INTO audit_log (session_id, actor, action, detail, amount, outcome)
       VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          sessionId,
          'system',
          'catalog_query_failed',
          'Supplier unreachable, attempting retry',
          null,
          'degraded',
        ],
      )
      .catch(() => {});

    // Retry once after 1s
    await new Promise((r) => setTimeout(r, 1000));
    try {
      products = await fetchCatalogFromSupplier();
      catalogSource = 'retry';
    } catch {
      // Retry also failed — fall back to cache
      emit({
        label: 'Retry failed',
        detail: 'Using cached catalog data from last successful sync',
        timestamp: now(),
      });
      products = catalogCache;
      catalogSource = 'cache';
    }
    pool
      .query(
        `INSERT INTO audit_log (session_id, actor, action, detail, amount, outcome)
       VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          sessionId,
          'system',
          'catalog_retry_failed',
          'Retry failed, falling back to cached catalog',
          null,
          'degraded',
        ],
      )
      .catch(() => {});
  } else {
    // Normal path: fetch from supplier/DB
    try {
      products = await fetchCatalogFromSupplier();
      // Update cache on success
      catalogCache = products;
      catalogCacheTime = new Date();
    } catch (err) {
      console.error('Buyer query catalog fetch error:', err);
      // Fallback to cache if available
      if (catalogCache.length > 0) {
        products = catalogCache;
        catalogSource = 'cache';
        emit({
          label: 'Catalog fallback',
          detail: `Live fetch failed — using ${catalogCache.length} cached products (synced ${catalogCacheTime?.toISOString() ?? 'unknown'})`,
          timestamp: now(),
        });
        pool
          .query(
            `INSERT INTO audit_log (session_id, actor, action, detail, amount, outcome)
           VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              sessionId,
              'system',
              'catalog_fallback',
              `Live fetch failed, using ${catalogCache.length} cached products`,
              null,
              'recovered',
            ],
          )
          .catch(() => {});
      }
    }
  }

  const sourceLabel =
    catalogSource === 'cache' ? ' (cached)' : catalogSource === 'retry' ? ' (retry succeeded)' : '';
  emit({
    label: 'Network searched',
    detail: `${products.length} seller surfaces queried${sourceLabel}`,
    timestamp: now(),
  });

  // Step 3: Score candidates
  const scored = products.map((p) => ({
    product: p,
    ...scoreProduct(p, constraints, keywords),
  }));
  scored.sort((a, b) => b.score - a.score);
  const shortlisted = scored.filter((s) => s.score > 0);
  const topMatch = shortlisted[0] ?? null;

  emit({
    label: 'Candidates scored',
    detail: topMatch
      ? `${shortlisted.length} match${shortlisted.length === 1 ? '' : 'es'} above confidence threshold`
      : 'No matches found above threshold',
    timestamp: now(),
  });

  // Step 4: Policy check — read maxAutoApprove from merchant settings
  let maxAutoApprove = 180;
  try {
    const { rows } = await pool.query<MerchantSettingsRow>(
      'SELECT max_auto_approve, require_human_above_cap FROM merchant_settings WHERE merchant_id = $1',
      ['default'],
    );
    if (rows.length > 0) {
      maxAutoApprove = Number(rows[0].max_auto_approve);
    }
  } catch {
    /* use default */
  }

  let policyResult: 'auto_approved' | 'human_approval_required' | 'no_match' = 'auto_approved';
  let exceededCeiling: 'merchant' | 'buyer' | 'both' | null = null;
  let policy: ReturnType<typeof evaluateTransactionPolicy> | null = null;
  if (topMatch) {
    policy = evaluateTransactionPolicy({
      amount: topMatch.product.price,
      buyerLimit: buyerSpendCeiling,
      merchantLimit: maxAutoApprove,
    });
    policyResult = policy.decision;
    if (policy.ceilingSource === 'both') exceededCeiling = 'both';
    else if (policy.ceilingSource === 'merchant_ceiling') exceededCeiling = 'merchant';
    else if (policy.ceilingSource === 'buyer_ceiling') exceededCeiling = 'buyer';
  } else {
    policyResult = 'no_match';
  }
  emit({
    label: 'Policy checked',
    detail:
      policyResult === 'auto_approved'
        ? `Spend approved · merchant cap $${maxAutoApprove.toFixed(2)}` +
          (buyerSpendCeiling != null ? ` · your cap $${buyerSpendCeiling.toFixed(2)}` : '')
        : policyResult === 'human_approval_required'
          ? exceededCeiling === 'buyer'
            ? `Above your session cap of $${buyerSpendCeiling!.toFixed(2)} · requires your approval`
            : exceededCeiling === 'both'
              ? `Above both caps (merchant $${maxAutoApprove.toFixed(2)}, you $${buyerSpendCeiling!.toFixed(2)}) · requires your approval`
              : `Above merchant cap of $${maxAutoApprove.toFixed(2)} · requires human approval`
          : 'No candidates to evaluate',
    timestamp: now(),
  });

  // Step 5: Recommendation
  const recommended =
    (policyResult === 'auto_approved' || policyResult === 'human_approval_required') && topMatch
      ? topMatch.product
      : null;
  emit({
    label: 'Recommendation made',
    detail: recommended
      ? `${recommended.name} · $${recommended.price.toFixed(2)}`
      : 'No product meets all constraints',
    timestamp: now(),
  });

  // Step 6: Growth suggestions — 1-2 related items from the same category/group,
  // distinct from the primary pick. Section A of Stage 10.
  let suggestions: Array<{
    id: number;
    name: string;
    price: number;
    reason: string;
    category: string | null;
  }> = [];
  if (recommended) {
    try {
      const { rows } = await pool.query<{
        id: number;
        name: string;
        price: number | string;
        product_category: string | null;
        item_group_id: string | null;
      }>(
        `SELECT id, name, price, product_category, item_group_id
         FROM products
         WHERE enable_search = TRUE
           AND status != 'archived'
           AND availability = TRUE
           AND inventory_quantity > 0
           AND id <> $1
           AND (product_category = $2 OR (item_group_id IS NOT NULL AND item_group_id = $3))
         ORDER BY price ASC
         LIMIT 2`,
        [recommended.id, recommended.category ?? '', null],
      );
      suggestions = rows.map((r, idx) => ({
        id: r.id,
        name: r.name,
        price: Number(r.price),
        reason:
          idx === 0 ? 'Often paired with the primary pick' : 'Higher-tier option in the same group',
        category: r.product_category,
      }));
    } catch (err) {
      console.error('suggestions query failed:', err);
      // Suggestions are best-effort; never fail the whole query because of them.
    }
    if (suggestions.length > 0) {
      emit({
        label: 'Growth suggestions',
        detail: `${suggestions.length} complementary option${suggestions.length === 1 ? '' : 's'} found`,
        timestamp: now(),
      });
    }
  }

  const result = {
    recommendedProduct: recommended,
    confidence: topMatch?.score ?? 0,
    policyResult,
    exceededCeiling,
    suggestions,
    policy,
  };

  // Insert audit log for policy decision
  if (policyResult === 'auto_approved' || policyResult === 'human_approval_required') {
    await recordEvent({
      pool,
      sessionId,
      actor: 'buyer.northstar',
      action: 'policy_check',
      detail: `${policyResult}: ${recommended?.name ?? 'N/A'}` +
        (exceededCeiling ? ` (ceiling=${exceededCeiling})` : ''),
      amount: recommended?.price ?? null,
      outcome: policyResult,
      policy: policy ?? undefined,
    });
  }

  // Audit log: upsell_shown (Section A)
  if (suggestions.length > 0 && recommended) {
    await recordEvent({
      pool,
      sessionId,
      actor: 'buyer.northstar',
      action: 'upsell_shown',
      detail: `${suggestions.length} suggestion(s) for ${recommended.name}: ${suggestions.map((s) => s.name).join(', ')}`,
      amount: suggestedTotal(suggestions),
      outcome: 'info',
    });
  }

  const evidencePayload = {
    sessionId,
    amount: recommended?.price ?? null,
    policy,
    decision: policyResult,
  };
  res.json({
    sessionId,
    steps,
    result,
    evidence: signEvidence(evidencePayload),
  });
});

function suggestedTotal(suggestions: Array<{ price: number }>): number {
  return suggestions.reduce((sum, s) => sum + s.price, 0);
}

// POST /api/buyer/upsell/accept — accept a suggestion and re-run the policy
// check against the new combined total (Section A, step 3).
app.post('/api/buyer/upsell/accept', upsellLimiter, async (req, res) => {
  const { sessionId, suggestionId, primaryProductId } = req.body ?? {};
  if (!sessionId || !suggestionId || !primaryProductId) {
    res.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'sessionId, suggestionId, and primaryProductId are required.',
      },
    });
    return;
  }

  try {
    // Re-read the two products so we can compute the actual combined total.
    const { rows } = await pool.query<{ price: number | string; name: string; id: number }>(
      `SELECT id, name, price FROM products WHERE id = ANY($1::int[])`,
      [[Number(primaryProductId), Number(suggestionId)]],
    );
    if (rows.length < 2) {
      res
        .status(404)
        .json({ error: { code: 'NOT_FOUND', message: 'Primary or suggested product not found.' } });
      return;
    }
    const primary = rows.find((r) => r.id === Number(primaryProductId));
    const suggestion = rows.find((r) => r.id === Number(suggestionId));
    if (!primary || !suggestion) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Could not match primary and suggested products.' },
      });
      return;
    }
    const combined = Number(primary.price) + Number(suggestion.price);

    // Pull merchant ceiling (Stage 5) and re-run both checks.
    let merchantCap = 180;
    try {
      const r = await pool.query<MerchantSettingsRow>(
        'SELECT max_auto_approve FROM merchant_settings WHERE merchant_id = $1',
        ['default'],
      );
      if (r.rows.length > 0) merchantCap = Number(r.rows[0].max_auto_approve);
    } catch {
      /* keep default */
    }
    // Read buyer cap from the persistent buyer_sessions row. Body
    // overrides are NOT accepted; the spec requires the buyer ceiling
    // to be server-controlled. We look up the most-recent session
    // (single buyer in this deployment). Future multi-tenant: take
    // workspaceId from the caller's request context.
    let buyerCeiling: number | null = null;
    try {
      const { rows: ses } = await pool.query<{ max_spend: number | string | null }>(
        `SELECT max_spend FROM buyer_sessions ORDER BY updated_at DESC LIMIT 1`,
      );
      if (ses[0]?.max_spend != null) {
        const n = Number(ses[0].max_spend);
        if (Number.isFinite(n) && n > 0) buyerCeiling = n;
      }
    } catch {
      /* keep null */
    }

    const policy = evaluateTransactionPolicy({
      amount: combined,
      buyerLimit: buyerCeiling,
      merchantLimit: merchantCap,
    });

    // ACP: buyer_agent <-> pricing_service — upsell evaluated against policy.
    await emitProtocolEvent({
      protocol: 'ACP',
      direction: 'outbound',
      source: 'buyer_agent',
      target: 'pricing_service',
      action: 'acp_request',
      status: 'success',
      sessionId: String(sessionId),
      detail: `upsell suggestionId=${suggestionId} primary=${primaryProductId} combined=${combined}`,
    }).catch(() => {});
    await emitProtocolEvent({
      protocol: 'ACP',
      direction: 'inbound',
      source: 'pricing_service',
      target: 'buyer_agent',
      action: 'acp_response',
      status: policy.decision === 'auto_approved' ? 'success' : 'degraded',
      sessionId: String(sessionId),
      detail: `decision=${policy.decision} ceilingSource=${policy.ceilingSource}`,
    }).catch(() => {});
    const exceededCeiling: 'merchant' | 'buyer' | 'both' | null =
      policy.ceilingSource === 'both'
        ? 'both'
        : policy.ceilingSource === 'merchant_ceiling'
          ? 'merchant'
          : policy.ceilingSource === 'buyer_ceiling'
            ? 'buyer'
            : null;

    await recordEvent({
      pool,
      sessionId: String(sessionId),
      actor: 'buyer.northstar',
      action: 'upsell_accepted',
      detail: `Added ${suggestion.name} to order with ${primary.name}; combined $${combined.toFixed(2)}`,
      amount: combined,
      outcome: policy.decision,
      policy,
    });

    res.json({
      combinedTotal: combined,
      policyResult: policy.decision,
      exceededCeiling,
      merchantCap,
      buyerCap: buyerCeiling,
      policy,
    });
  } catch (err) {
    console.error('POST /api/buyer/upsell/accept error:', err);
    res
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'Could not evaluate the upsell.' } });
  }
});

// GET /api/buyer/trace/:sessionId — removed; trace is delivered in POST response.

// ── Razorpay checkout ────────────────────────────────────────────────────

// POST /api/checkout/create-order — REMOVED. Use POST /api/checkout/start
// with a basketId so the amount is server-derived.
app.post('/api/checkout/create-order', (_req, res) => {
  res.status(410).json({
    error: {
      code: 'DEPRECATED',
      message: 'POST /api/checkout/create-order is removed. Use POST /api/checkout/start.',
    },
  });
});

// POST /api/checkout/webhook — Razorpay webhook receiver.
// Verifies HMAC over the exact raw bytes (req.rawBody), idempotency via
// webhook_events, server-authoritative state transition, structured audit.
app.post('/api/checkout/webhook', async (req, res) => {
  let creds: ResolvedRazorpayCreds | null = null;
  try {
    creds = await resolveRazorpayCreds();
  } catch (err) {
    console.error('webhook: failed to resolve credentials:', err);
  }
  const webhookSecret = creds?.webhookSecret ?? process.env.RAZORPAY_WEBHOOK_SECRET ?? '';
  if (!webhookSecret) {
    console.error('RAZORPAY_WEBHOOK_SECRET not configured');
    res.status(500).json({
      error: { code: 'WEBHOOK_NOT_CONFIGURED', message: 'Webhook secret is not configured.' },
    });
    return;
  }

  const signature = req.headers['x-razorpay-signature'] as string | undefined;
  if (!signature) {
    res.status(400).json({ error: 'Missing X-Razorpay-Signature header' });
    return;
  }
  if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) {
    res.status(400).json({ error: 'Raw body unavailable — cannot verify signature.' });
    return;
  }

  // HMAC over the exact raw bytes Razorpay signed. NEVER JSON.stringify(req.body).
  const expectedSig = crypto.createHmac('sha256', webhookSecret).update(req.rawBody).digest('hex');
  const sigOk =
    signature.length === expectedSig.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig));
  if (!sigOk) {
    console.error('Webhook signature mismatch');
    res.status(400).json({ error: 'Invalid webhook signature' });
    return;
  }

  const event = req.body as { event?: string; id?: string; payload?: { payment?: { entity?: { id?: string; amount?: number; notes?: { commerce0s_order_id?: string } } } } };
  const eventType = event?.event;
  const paymentEntity = event?.payload?.payment?.entity;
  // Idempotency key: prefer the canonical Razorpay event id from the body,
  // fall back to the X-Razorpay-Event-Id header (some clients use it), and
  // only then synthesise a marker. Without this, every replay would get a
  // fresh key and the dedup INSERT would always insert a new row.
  const headerEventId = req.headers['x-razorpay-event-id'];
  const eventId =
    event?.id ??
    (typeof headerEventId === 'string' && headerEventId ? headerEventId : null) ??
    `synth_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const payloadHash = crypto.createHash('sha256').update(req.rawBody).digest('hex');

  // Atomic claim-and-apply. The whole block (idempotency insert, state
  // transition, audit row) is one transaction. Two concurrent deliveries of
  // the same event_id race: only one wins the ON CONFLICT insert; the other
  // sees rowCount=0 and returns 200 duplicate without touching orders or
  // audit. A new event_id for the same order still applies, but the state
  // machine guards prevent double-flipping (e.g. paid→paid is not allowed
  // because the WHERE clause excludes status='paid').
  let duplicate = false;
  try {
    duplicate = await withTransaction(async (client) => {
      const claim = await client.query(
        `INSERT INTO webhook_events (event_id, event_type, payload_hash)
         VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [eventId, eventType ?? 'unknown', payloadHash],
      );
      if (claim.rowCount === 0) return true; // duplicate — bail inside the tx

      if (eventType === 'payment.captured' && paymentEntity) {
        const receipt = paymentEntity.notes?.commerce0s_order_id as string | undefined;
        if (receipt) {
          const orderId = Number(String(receipt).replace('order_', ''));
          if (Number.isFinite(orderId)) {
            const { rows: ordRows } = await client.query<{ transaction_id: string | null; workspace_id: string | null }>(
              `SELECT transaction_id, workspace_id FROM orders WHERE id = $1`,
              [orderId],
            );
            const r = await markPaid(client, {
              orderId,
              transactionId: ordRows[0]?.transaction_id ?? null,
              workspaceId: ordRows[0]?.workspace_id ?? null,
              amount: Number(paymentEntity.amount ?? 0) / 100,
              razorpayPaymentId: String(paymentEntity.id ?? ''),
              actor: 'razorpay_webhook',
              detail: `Razorpay payment ${paymentEntity.id} captured for order ${orderId}`,
              outcome: 'success',
            });
            if (r.outcome === 'transitioned') {
              await emitProtocolEventTx({
                pool: client,
                transactionId: ordRows[0]?.transaction_id ?? '',
                workspaceId: ordRows[0]?.workspace_id ?? '',
                protocol: 'system',
                action: 'payment_captured',
                payload: { orderId, paymentId: paymentEntity.id, source: 'webhook' },
                client,
              });
              console.log(`✅ Webhook: order ${orderId} marked as paid`);
            } else if (r.outcome === 'blocked') {
              // pending_human_review: webhook cannot auto-promote. Order
              // must be human_approved first. Audit the rejection so it is
              // visible in /api/activity.
              await recordEvent({
                pool: client, strict: false,
                txnId: ordRows[0]?.transaction_id ?? null,
                workspaceId: ordRows[0]?.workspace_id ?? null,
                actor: 'razorpay_webhook',
                action: 'payment_blocked',
                detail: `Razorpay captured for order ${orderId} but order is in '${r.status}' — refused to mark paid`,
                amount: Number(paymentEntity.amount ?? 0) / 100,
                outcome: 'blocked',
              });
            }
          }
        }
      } else if (eventType === 'payment.failed' && paymentEntity) {
        const receipt = paymentEntity.notes?.commerce0s_order_id as string | undefined;
        if (receipt) {
          const orderId = Number(String(receipt).replace('order_', ''));
          if (Number.isFinite(orderId)) {
            const { rows: ordRows } = await client.query<{ transaction_id: string | null; workspace_id: string | null }>(
              `SELECT transaction_id, workspace_id FROM orders WHERE id = $1`,
              [orderId],
            );
            const r = await markFailed(client, {
              orderId,
              transactionId: ordRows[0]?.transaction_id ?? null,
              workspaceId: ordRows[0]?.workspace_id ?? null,
              amount: Number(paymentEntity.amount ?? 0) / 100,
              actor: 'razorpay_webhook',
              detail: `Razorpay payment ${paymentEntity.id} failed for order ${orderId}`,
              outcome: 'failed',
            });
            if (r.outcome === 'transitioned') {
              console.log(`❌ Webhook: order ${orderId} marked as failed`);
            }
          }
        }
      } else if (eventType === 'refund.processed') {
        // Razorpay sends refund events under payload.refund.entity. Older
        // formats and the SDK sometimes mirror the refund into payload.payment
        // — accept either. We look up by razorpay_refund_id (set when the
        // merchant issued the refund) and require status = 'refund_requested'
        // so a duplicate event can't re-flip a terminal refunded order.
        const ev = event as {
          payload?: {
            refund?: { entity?: { id?: string; payment_id?: string; order_id?: string } };
            payment?: { entity?: { id?: string } };
          };
        };
        const refundEntity = ev.payload?.refund?.entity;
        const rpRefundId = refundEntity?.id ?? paymentEntity?.id;
        if (rpRefundId) {
          // Look up the order by its already-issued razorpay_refund_id OR by
          // the order_id embedded in the refund event. Either path is
          // authoritative for "which order did this refund confirm?".
          let o: { id: number; transaction_id: string | null; workspace_id: string; amount: number | string } | null = null;
          {
            const { rows: byRefund } = await client.query<{ id: number; transaction_id: string | null; workspace_id: string; amount: number | string }>(
              `SELECT id, transaction_id, workspace_id, amount FROM orders
               WHERE razorpay_refund_id = $1 AND status = 'refund_requested'`,
              [rpRefundId],
            );
            if (byRefund.length > 0) {
              o = byRefund[0];
            } else if (refundEntity?.order_id || paymentEntity?.id) {
              const ord = await client.query<{ id: number; transaction_id: string | null; workspace_id: string; amount: number | string }>(
                `SELECT id, transaction_id, workspace_id, amount FROM orders
                 WHERE razorpay_order_id = $1 AND status = 'refund_requested'`,
                [refundEntity?.order_id ?? ''],
              );
              if (ord.rows.length > 0) o = ord.rows[0];
            }
          }
          if (o) {
            const r = await markRefunded(client, {
              orderId: o.id,
              transactionId: o.transaction_id,
              workspaceId: o.workspace_id,
              amount: Number(o.amount),
              razorpayRefundId: rpRefundId,
              actor: 'razorpay_webhook',
              detail: `Refund ${rpRefundId} confirmed for order ${o.id}`,
              outcome: 'success',
            });
            if (r.outcome === 'transitioned') {
              await emitProtocolEventTx({
                pool: client,
                transactionId: o.transaction_id ?? '',
                workspaceId: o.workspace_id,
                protocol: 'system',
                action: 'refund_processed',
                payload: { orderId: o.id, refundId: rpRefundId, source: 'webhook' },
                client,
              });
            }
          }
        }
      }
      return false;
    });
  } catch (err) {
    console.error('webhook transaction failed:', err);
  }

  if (duplicate) {
    res.json({ status: 'duplicate', eventId });
    return;
  }
  res.json({ status: 'ok', eventId });
});

// GET /api/checkout/verify/:orderId — fallback reconciliation
//
// Routes through the same canonical payment-state machine as the webhook.
// State mutation + audit + (optionally) outbox all commit atomically; a
// direct SQL `UPDATE orders SET status = ...` is no longer used here.
app.get('/api/checkout/verify/:orderId', async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isFinite(orderId)) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid order id.' } });
    return;
  }
  const workspaceId =
    (req.query.workspaceId as string | undefined)?.trim() || merchantWorkspace();

  type VerifyOrderRow = {
    id: number; product_id: number; buyer_agent_id: string; amount: string;
    status: string; created_at: string; razorpay_payment_id: string | null;
    razorpay_order_id: string | null; transaction_id: string | null; workspace_id: string | null;
  };
  let order: VerifyOrderRow | null = null;

  try {
    const { rows } = await pool.query<VerifyOrderRow>(
      `SELECT id, product_id, buyer_agent_id, amount, status, created_at,
              razorpay_payment_id, razorpay_order_id, transaction_id, workspace_id
         FROM orders WHERE id = $1`,
      [orderId],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order not found.' } });
      return;
    }
    order = rows[0];
    if (order && order.workspace_id !== workspaceId && order.workspace_id !== merchantWorkspace()) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order not found.' } });
      return;
    }

    // Idempotent terminal states: just return.
    if (order && (order.status === 'paid' || order.status === 'failed' || order.status === 'refunded')) {
      res.json(order);
      return;
    }

    // Reconcile via Razorpay REST. We only commit a state change when the
    // canonical payment_state helper returns outcome='transitioned' — this
    // is the SAME function the webhook uses, so a verify cannot bypass the
    // human-approval gate (markPaid refuses pending_human_review).
    try {
      const creds = await resolveRazorpayCreds();
      if (creds) {
        const auth = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64');
        const rpRes = await fetch(`https://api.razorpay.com/v1/orders?receipt=order_${orderId}`, {
          headers: { Authorization: `Basic ${auth}` },
        });
        if (rpRes.ok) {
          const rpData = (await rpRes.json()) as {
            items?: Array<{ id: string; status: string; amount_paid?: number; amount?: number }>;
          };
          if (rpData.items && rpData.items.length > 0) {
            const rpOrder = rpData.items[0];
            const amount =
              typeof rpOrder.amount_paid === 'number'
                ? rpOrder.amount_paid / 100
                : Number(order!.amount);
            await withTransaction(async (client) => {
              if (rpOrder.status === 'paid') {
                const r = await markPaid(client, {
                  orderId,
                  transactionId: order!.transaction_id,
                  workspaceId: order!.workspace_id,
                  amount,
                  razorpayPaymentId: rpOrder.id,
                  actor: 'system',
                  detail: `Verify reconciled order ${orderId} via Razorpay lookup (status=paid)`,
                  outcome: 'success',
                });
                if (r.outcome === 'transitioned') {
                  order!.status = 'paid';
                  await emitProtocolEventTx({
                    pool: client,
                    transactionId: order!.transaction_id ?? '',
                    workspaceId: order!.workspace_id ?? workspaceId,
                    protocol: 'system',
                    action: 'payment_verified',
                    payload: { orderId, source: 'verify' },
                    client,
                  });
                }
              } else if (rpOrder.status === 'failed') {
                const r = await markFailed(client, {
                  orderId,
                  transactionId: order!.transaction_id,
                  workspaceId: order!.workspace_id,
                  amount,
                  actor: 'system',
                  detail: `Verify reconciled order ${orderId} via Razorpay lookup (status=failed)`,
                  outcome: 'failed',
                });
                if (r.outcome === 'transitioned') {
                  order!.status = 'failed';
                }
              }
            });
          }
        }
      }
    } catch (rpErr) {
      console.error('Razorpay verification failed:', rpErr);
      // Return the order as-is; verify never mutates a non-terminal order
      // when the upstream call fails.
    }

    res.json(order);
  } catch (err) {
    console.error('GET /api/checkout/verify error:', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to verify order.' } });
  }
});

// ── Debug endpoints ───────────────────────────────────────────────────────

// POST /api/debug/simulate-failure — toggle simulated supplier failure
app.post('/api/debug/simulate-failure', (req, res) => {
  const { enabled } = req.body ?? {};
  simulateSupplierFailure = Boolean(enabled);
  console.log(`🔧 Debug: simulate supplier failure = ${simulateSupplierFailure}`);
  res.json({ simulateSupplierFailure });
});

app.get('/api/debug/status', (_req, res) => {
  // Explicit allowlist — never echo env, never echo process info. Any new
  // field must be added here intentionally; grep rejects patterns like
  // `process.env` and `DATABASE_URL` in this file.
  res.json({
    simulateSupplierFailure,
    catalogCacheSize: catalogCache.length,
    catalogCacheTime: catalogCacheTime?.toISOString() ?? null,
  });
});

// ── Audit log ─────────────────────────────────────────────────────────────

async function ensureAuditLogTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id          SERIAL PRIMARY KEY,
      timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      session_id  TEXT,
      actor       TEXT NOT NULL DEFAULT 'system',
      action      TEXT NOT NULL,
      detail      TEXT,
      amount      NUMERIC(12,2),
      outcome     TEXT NOT NULL DEFAULT 'info',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp DESC)',
  );
  // Additive columns for cross-system correlation.
  await pool.query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS transaction_id TEXT`);
  await pool.query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS workspace_id    TEXT`);
  await pool.query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS policy          JSONB`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_audit_txn ON audit_log(transaction_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_audit_ws_ts ON audit_log(workspace_id, timestamp DESC)`,
  );
}

// ── Workspace + state-machine helpers ─────────────────────────────────────

// One boundary for future multi-tenant work. Today every merchant request
// resolves to 'default'; tomorrow this becomes a header- or JWT-derived id.
const MERCHANT_WORKSPACE_ID = 'default';
function merchantWorkspace(): string {
  return MERCHANT_WORKSPACE_ID;
}

// Server-authoritative status transitions. UPDATE ... WHERE status = ANY($from)
// so the client cannot jump from pending → refunded in one request.
type TxClient = pg.PoolClient | typeof pool;

async function transitionOrder(
  orderId: number,
  from: string[],
  to: string,
  client: TxClient = pool,
): Promise<{ id: number; status: string } | null> {
  const { rows } = await client.query<{ id: number; status: string }>(
    `UPDATE orders SET status = $1
     WHERE id = $2 AND status = ANY($3::text[])
     RETURNING id, status`,
    [to, orderId, from],
  );
  return rows[0] ?? null;
}

async function transitionOrderWithExtras(
  orderId: number,
  from: string[],
  to: string,
  extras: Record<string, unknown>,
  client: TxClient = pool,
): Promise<{ id: number; status: string } | null> {
  const keys = Object.keys(extras);
  const setSql = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
  const sql = `UPDATE orders
               SET status = $1${keys.length === 0 ? '' : ', ' + setSql}
               WHERE id = $2 AND status = ANY($${keys.length + 3}::text[])
               RETURNING id, status`;
  const { rows } = await client.query<{ id: number; status: string }>(sql, [
    to,
    orderId,
    ...keys.map((k) => extras[k]),
    from,
  ]);
  return rows[0] ?? null;
}

// GET /api/audit — filterable, paginated audit trail
app.get('/api/audit', async (req, res) => {
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const action = req.query.action as string | undefined;
  const outcome = req.query.outcome as string | undefined;
  const transactionId = (req.query.transactionId as string | undefined)?.trim();
  const workspaceId = (req.query.workspaceId as string | undefined)?.trim() || merchantWorkspace();
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;

  const conditions: string[] = [];
  const params: Array<string | number> = [];
  let idx = 1;

  if (from) {
    conditions.push(`timestamp >= $${idx++}`);
    params.push(from);
  }
  if (to) {
    conditions.push(`timestamp <= $${idx++}`);
    params.push(to);
  }
  if (action) {
    conditions.push(`action = $${idx++}`);
    params.push(action);
  }
  if (outcome) {
    conditions.push(`outcome = $${idx++}`);
    params.push(outcome);
  }
  if (transactionId) {
    conditions.push(`transaction_id = $${idx++}`);
    params.push(transactionId);
  }
  // workspaceId is now always set (defaulted to merchantWorkspace above),
  // so every audit read is workspace-scoped by default.
  conditions.push(`workspace_id = $${idx++}`);
  params.push(workspaceId);

  const where = `WHERE ${conditions.join(' AND ')}`;

  try {
    const { rows } = await pool.query(
      `SELECT id, timestamp, session_id, actor, action, detail, amount, outcome,
              transaction_id, workspace_id, policy
       FROM audit_log ${where}
       ORDER BY timestamp DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    );
    const {
      rows: [{ count }],
    } = await pool.query(`SELECT COUNT(*)::int AS count FROM audit_log ${where}`, params);
    res.json({ rows, total: count, limit, offset });
  } catch (err) {
    console.error('GET /api/audit error:', err);
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

// GET /api/audit/export — JSON download of filtered audit rows
app.get('/api/audit/export', async (req, res) => {
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const action = req.query.action as string | undefined;
  const outcome = req.query.outcome as string | undefined;

  const conditions: string[] = [];
  const params: Array<string | number> = [];
  let idx = 1;

  if (from) {
    conditions.push(`timestamp >= $${idx++}`);
    params.push(from);
  }
  if (to) {
    conditions.push(`timestamp <= $${idx++}`);
    params.push(to);
  }
  if (action) {
    conditions.push(`action = $${idx++}`);
    params.push(action);
  }
  if (outcome) {
    conditions.push(`outcome = $${idx++}`);
    params.push(outcome);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await pool.query(
      `SELECT id, timestamp, session_id, actor, action, detail, amount, outcome
       FROM audit_log ${where}
       ORDER BY timestamp DESC LIMIT 1000`,
      params,
    );
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="audit_log.json"');
    res.json(rows);
  } catch (err) {
    console.error('GET /api/audit/export error:', err);
    res.status(500).json({ error: 'Failed to export audit log' });
  }
});

// ── Start ───────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 5000);

async function start() {
  // Verify DB connection
  try {
    await pool.query('SELECT 1');
    console.log('✅ Connected to Neon Postgres');
  } catch (err) {
    console.error('❌ Database connection failed:', err);
    process.exit(1);
  }

  await ensureOrdersTable();
  console.log('✅ Orders table ready');

  await ensureBasketsTable();
  console.log('✅ Baskets table ready');

  await ensureBuyerSessionsTable();
  console.log('✅ Buyer sessions table ready');

  await ensureWebhookEventsTable();
  console.log('✅ Webhook events table ready');

  await ensureRazorpayAttemptsTable();
  console.log('✅ Razorpay attempts table ready');

  await ensureProductsTable();
  await seedProductsIfEmpty();
  console.log('✅ Products table ready');

  await ensureTraceEventsTable();
  console.log('✅ Trace events table ready');

  await ensureMerchantSettingsTable();
  console.log('✅ Merchant settings table ready');

  await ensureMerchantCredentialsTable();
  console.log('✅ Merchant credentials table ready');

  // Crypto must be ready before any /api/checkout/* route is hit.
  if (!process.env.ENCRYPTION_KEY) {
    console.warn(
      '⚠️  ENCRYPTION_KEY not set — per-merchant credential encryption is disabled until it is.',
    );
  } else {
    console.log('✅ Encryption key loaded');
  }

  await ensureAuditLogTable();
  console.log('✅ Audit log table ready');

  await ensureOutboxTable(pool);
  console.log('✅ Outbox table ready');

  await ensureInventoryReservationsTable(pool);
  console.log('✅ Inventory reservations table ready');

  // Demo workspace seed — runs only when DEMO_ACCOUNT_EMAIL is configured
  // (default tavish350@gmail.com). Idempotent: re-runs are a no-op once
  // the demo buyer workspace has any orders.
  await seedDemoDataIfEmpty(pool);
  console.log('✅ Demo workspace seeded (or already populated)');

  // Outbox publisher: default no-op transport. Wire a real `dispatch` here
  // when a downstream A2A/ACP endpoint is configured. The audit log is the
  // source of truth for /api/activity; the outbox is the durability channel
  // for protocol events that must outlive a process restart.
  startOutbox(pool, { intervalMs: 5_000 });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 API gateway listening on http://localhost:${PORT}`);
  });
}

start();
