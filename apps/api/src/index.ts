import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import { encryptSecret, decryptSecret } from './crypto.js';

const app = express();
app.use(express.json());

// ── Database ────────────────────────────────────────────────────────────────

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// ── Types ───────────────────────────────────────────────────────────────────

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

// ── Helpers ─────────────────────────────────────────────────────────────────

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

// ── Ensure orders table exists ──────────────────────────────────────────────

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
      dispute_reason      TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // Ponytail: best-effort additive migrations for existing DBs.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS razorpay_payment_id TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS razorpay_refund_id  TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_reason      TEXT`);
}

// ── Merchant credentials (Razorpay, encrypted at rest) ──────────────────────

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
  source: 'merchant_row' | 'env_fallback';
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

// ── Rate limit (in-memory, per IP) — Stage 10 / E ──────────────────────────
// Ponytail: in-memory, single-process. Upgrade to Redis or per-user when the
// API runs > 1 instance or traffic gets serious. Trims 5-minute buckets.

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

const buyerQueryLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
const upsellLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
const checkoutLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

// ── Routes ──────────────────────────────────────────────────────────────────

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

// List all catalog products
app.get('/api/catalog', async (_req, res) => {
  try {
    const { rows } = await pool.query<ProductRow>(
      `SELECT id, sku, name, description, price, currency,
              availability, inventory_quantity, status, created_at,
              image_link, brand, product_category
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

// Single product detail
app.get('/api/catalog/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid product id.' } });
    return;
  }

  try {
    const { rows } = await pool.query<ProductRow>(
      `SELECT id, sku, name, description, price, currency,
              availability, inventory_quantity, status, created_at,
              image_link, brand, product_category
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

// List orders (joins product name)
app.get('/api/orders', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.id, o.product_id, o.buyer_agent_id, o.amount, o.status, o.created_at,
              p.name AS product_name, p.sku AS product_sku
       FROM orders o
       LEFT JOIN products p ON p.id = o.product_id
       ORDER BY o.created_at DESC`,
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/orders error:', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch orders.' } });
  }
});

// Create order
app.post('/api/orders', async (req, res) => {
  const { productId, buyerAgentId, amount } = req.body ?? {};

  if (productId == null || buyerAgentId == null || amount == null) {
    res.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Missing required fields: productId, buyerAgentId, amount.',
      },
    });
    return;
  }

  try {
    const { rows } = await pool.query<OrderRow>(
      `INSERT INTO orders (product_id, buyer_agent_id, amount, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING id, product_id, buyer_agent_id, amount, status, created_at`,
      [Number(productId), String(buyerAgentId), Number(amount)],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /api/orders error:', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create order.' } });
  }
});

// Get single order (for polling)
app.get('/api/orders/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid order id.' } });
    return;
  }
  try {
    const { rows } = await pool.query(
      `SELECT o.id, o.product_id, o.buyer_agent_id, o.amount, o.status, o.created_at,
              p.name AS product_name, p.sku AS product_sku
       FROM orders o
       LEFT JOIN products p ON p.id = o.product_id
       WHERE o.id = $1`,
      [id],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order not found.' } });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/orders/:id error:', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch order.' } });
  }
});

// POST /api/orders/:id/dispute — buyer flags an order as disputed
app.post('/api/orders/:id/dispute', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid order id.' } });
    return;
  }
  const reason = String(req.body?.reason ?? '').trim();
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

  try {
    const { rows } = await pool.query('SELECT id, status FROM orders WHERE id = $1', [id]);
    if (rows.length === 0) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order not found.' } });
      return;
    }
    const current = rows[0].status as string;
    if (current === 'disputed' || current === 'refunded') {
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

    const updated = await pool.query(
      `UPDATE orders SET status = 'disputed', dispute_reason = $2 WHERE id = $1 RETURNING id, status, dispute_reason`,
      [id, reason],
    );
    pool
      .query(
        `INSERT INTO audit_log (session_id, actor, action, detail, amount, outcome)
       VALUES ($1, $2, $3, $4, $5, $6)`,
        [null, 'buyer', 'dispute_opened', `Order ${id} disputed: ${reason}`, null, 'pending'],
      )
      .catch(() => {});

    res.json(updated.rows[0]);
  } catch (err) {
    console.error('POST /api/orders/:id/dispute error:', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to open dispute.' } });
  }
});

// POST /api/orders/:id/refund — merchant processes refund via Razorpay
app.post('/api/orders/:id/refund', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid order id.' } });
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
    const { rows } = await pool.query(
      'SELECT id, status, amount, razorpay_payment_id, razorpay_refund_id FROM orders WHERE id = $1',
      [id],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order not found.' } });
      return;
    }
    const order = rows[0];
    if (order.status === 'refunded') {
      res
        .status(409)
        .json({ error: { code: 'ALREADY_REFUNDED', message: 'Order has already been refunded.' } });
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

    const rp = new Razorpay({ key_id: creds.keyId, key_secret: creds.keySecret });
    const refund = await rp.payments.refund(order.razorpay_payment_id, {
      amount: Math.round(Number(order.amount) * 100),
    });

    const updated = await pool.query(
      `UPDATE orders SET status = 'refunded', razorpay_refund_id = $2 WHERE id = $1 RETURNING id, status, razorpay_refund_id`,
      [id, refund.id],
    );
    pool
      .query(
        `INSERT INTO audit_log (session_id, actor, action, detail, amount, outcome)
       VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          null,
          'merchant',
          'refund_processed',
          `Order ${id} refunded via Razorpay (refund ${refund.id})`,
          Number(order.amount),
          'success',
        ],
      )
      .catch(() => {});

    res.json({ order: updated.rows[0], refundId: refund.id });
  } catch (err) {
    const e = err as { statusCode?: number; message?: string };
    const status = e?.statusCode;
    console.error('POST /api/orders/:id/refund error:', e?.message ?? err);
    pool
      .query(
        `INSERT INTO audit_log (session_id, actor, action, detail, amount, outcome)
       VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          null,
          'merchant',
          'refund_failed',
          `Order ${id} refund failed: ${e?.message ?? 'unknown'}`,
          null,
          'failed',
        ],
      )
      .catch(() => {});

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

// ── Checkout human-approve gate ────────────────────────────────────────────

// POST /api/checkout/human-approve/:orderId — flip an order from pending to human-approved
app.post('/api/checkout/human-approve/:orderId', async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isFinite(orderId)) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid order id.' } });
    return;
  }
  try {
    const { rows } = await pool.query(
      `UPDATE orders SET status = 'human_approved'
       WHERE id = $1 AND status = 'pending_human_review'
       RETURNING id, product_id, buyer_agent_id, amount, status, created_at`,
      [orderId],
    );
    if (rows.length === 0) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Order not found or not awaiting human review.' },
      });
      return;
    }
    // Insert audit log for human override
    pool
      .query(
        `INSERT INTO audit_log (session_id, actor, action, detail, amount, outcome)
       VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          null,
          'merchant',
          'human_override',
          `Manual override for order ${orderId}`,
          rows[0].amount,
          'approved',
        ],
      )
      .catch(() => {});
    res.json(rows[0]);
  } catch (err) {
    console.error('POST /api/checkout/human-approve error:', err);
    res
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to approve order.' } });
  }
});

// ── Buyer query orchestration ──────────────────────────────────────────────

// In-memory SSE session store: sessionId → events[] + listeners[]
interface TraceStep {
  label: string;
  detail: string;
  timestamp: string;
}

interface TraceSession {
  steps: TraceStep[];
  listeners: Array<(step: TraceStep) => void>;
  done: boolean;
  result: {
    recommendedProduct: NormalizedProduct | null;
    confidence: number;
    policyResult: string;
    exceededCeiling?: 'merchant' | 'buyer' | 'both' | null;
    suggestions?: Array<{
      id: number;
      name: string;
      price: number;
      reason: string;
      category: string | null;
    }>;
  } | null;
}

const traceSessions = new Map<string, TraceSession>();

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
  if (/bright|bright/.test(prompt.toLowerCase())) constraints.push('bright output');

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
  const session: TraceSession = { steps: [], listeners: [], done: false, result: null };
  traceSessions.set(sessionId, session);

  const emit = (step: TraceStep) => {
    session.steps.push(step);
    session.listeners.forEach((fn) => fn(step));
    // Persist to DB (fire-and-forget)
    pool
      .query(
        'INSERT INTO trace_events (session_id, step_index, label, detail) VALUES ($1, $2, $3, $4)',
        [sessionId, session.steps.length - 1, step.label, step.detail],
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
    try {
      const res = await fetch(`${RETAILER_URL}/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`Retailer health check returned ${res.status}`);
      // Supplier is reachable — query DB for catalog (as if retailer synced it)
      const { rows } = await pool.query<ProductRow>(
        `SELECT id, sku, name, description, price, currency,
                availability, inventory_quantity, status, created_at,
                image_link, brand, product_category
         FROM products
         WHERE enable_search = TRUE AND status != 'archived'
         ORDER BY id`,
      );
      return rows.map(normalizeProduct);
    } catch (err) {
      clearTimeout(timer);
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
        [sessionId, session.steps.length - 1],
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

  let policyResult = 'auto_approved';
  let exceededCeiling: 'merchant' | 'buyer' | 'both' | null = null;
  if (topMatch) {
    const overMerchant = topMatch.product.price >= maxAutoApprove;
    const overBuyer = buyerSpendCeiling != null && topMatch.product.price > buyerSpendCeiling;
    if (overMerchant && overBuyer) {
      policyResult = 'human_approval_required';
      exceededCeiling = 'both';
    } else if (overMerchant) {
      policyResult = 'human_approval_required';
      exceededCeiling = 'merchant';
    } else if (overBuyer) {
      policyResult = 'human_approval_required';
      exceededCeiling = 'buyer';
    }
  } else if (!topMatch) {
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

  session.done = true;
  session.result = {
    recommendedProduct: recommended,
    confidence: topMatch?.score ?? 0,
    policyResult,
    exceededCeiling,
    suggestions,
  };

  // Insert audit log for policy decision
  if (policyResult === 'auto_approved' || policyResult === 'human_approval_required') {
    pool
      .query(
        `INSERT INTO audit_log (session_id, actor, action, detail, amount, outcome)
       VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          sessionId,
          'buyer.northstar',
          'policy_check',
          `${policyResult}: ${recommended?.name ?? 'N/A'}` +
            (exceededCeiling ? ` (ceiling=${exceededCeiling})` : ''),
          recommended?.price ?? null,
          policyResult === 'auto_approved' ? 'auto_approved' : 'human_approval_required',
        ],
      )
      .catch(() => {});
  }

  // Audit log: upsell_shown (Section A)
  if (suggestions.length > 0 && recommended) {
    pool
      .query(
        `INSERT INTO audit_log (session_id, actor, action, detail, amount, outcome)
       VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          sessionId,
          'buyer.northstar',
          'upsell_shown',
          `${suggestions.length} suggestion(s) for ${recommended.name}: ${suggestions.map((s) => s.name).join(', ')}`,
          suggestedTotal(suggestions),
          'info',
        ],
      )
      .catch(() => {});
  }

  session.listeners.forEach((fn) => fn({ label: '__done', detail: '', timestamp: now() }));

  res.json({
    sessionId,
    steps: session.steps,
    result: session.result,
  });
});

function suggestedTotal(suggestions: Array<{ price: number }>): number {
  return suggestions.reduce((sum, s) => sum + s.price, 0);
}

// POST /api/buyer/upsell/accept — accept a suggestion and re-run the policy
// check against the new combined total (Section A, step 3).
app.post('/api/buyer/upsell/accept', upsellLimiter, async (req, res) => {
  const { sessionId, suggestionId, primaryProductId, buyerMaxSpend } = req.body ?? {};
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
    const buyerCap = Number(buyerMaxSpend);
    const buyerCeiling = Number.isFinite(buyerCap) && buyerCap > 0 ? buyerCap : null;

    const overMerchant = combined >= merchantCap;
    const overBuyer = buyerCeiling != null && combined > buyerCeiling;
    const policyResult = overMerchant || overBuyer ? 'human_approval_required' : 'auto_approved';
    const exceededCeiling: 'merchant' | 'buyer' | 'both' | null =
      overMerchant && overBuyer ? 'both' : overMerchant ? 'merchant' : overBuyer ? 'buyer' : null;

    // Audit log: upsell_accepted
    pool
      .query(
        `INSERT INTO audit_log (session_id, actor, action, detail, amount, outcome)
       VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          sessionId,
          'buyer.northstar',
          'upsell_accepted',
          `Added ${suggestion.name} to order with ${primary.name}; combined $${combined.toFixed(2)}`,
          combined,
          policyResult === 'auto_approved' ? 'auto_approved' : 'human_approval_required',
        ],
      )
      .catch(() => {});

    res.json({
      combinedTotal: combined,
      policyResult,
      exceededCeiling,
      merchantCap,
      buyerCap: buyerCeiling,
    });
  } catch (err) {
    console.error('POST /api/buyer/upsell/accept error:', err);
    res
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'Could not evaluate the upsell.' } });
  }
});

// GET /api/buyer/trace/:sessionId — SSE stream of trace steps
app.get('/api/buyer/trace/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = traceSessions.get(sessionId);

  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Send existing steps
  for (const step of session.steps) {
    res.write(`data: ${JSON.stringify(step)}\n\n`);
  }

  if (session.done) {
    res.write(`data: ${JSON.stringify({ label: '__done', result: session.result })}\n\n`);
    res.end();
    return;
  }

  // Listen for new steps
  const listener = (step: TraceStep) => {
    res.write(`data: ${JSON.stringify(step)}\n\n`);
    if (step.label === '__done') {
      res.write(`data: ${JSON.stringify({ label: '__done', result: session.result })}\n\n`);
      res.end();
    }
  };
  session.listeners.push(listener);

  req.on('close', () => {
    const idx = session.listeners.indexOf(listener);
    if (idx !== -1) session.listeners.splice(idx, 1);
  });
});

// ── Razorpay checkout ────────────────────────────────────────────────────

// POST /api/checkout/create-order — create a Razorpay order in test mode
app.post('/api/checkout/create-order', checkoutLimiter, async (req, res) => {
  const { orderId, amount, currency } = req.body ?? {};

  if (orderId == null || amount == null) {
    res.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'Missing required fields: orderId, amount' },
    });
    return;
  }

  // Resolve credentials for this merchant
  let creds: ResolvedRazorpayCreds | null = null;
  try {
    creds = await resolveRazorpayCreds();
  } catch (err) {
    console.error('create-order: failed to resolve credentials:', err);
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
          'No Razorpay credentials are configured for this merchant yet. Add them in Settings → Payment gateway.',
      },
    });
    return;
  }

  if (!creds.keyId.startsWith('rzp_test_')) {
    console.error(
      `create-order: refusing non-test key prefix for merchant (got ${creds.keyId.slice(0, 10)}…)`,
    );
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Only Razorpay test-mode keys are allowed in this environment.',
      },
    });
    return;
  }

  const rp = new Razorpay({ key_id: creds.keyId, key_secret: creds.keySecret });

  try {
    const rpOrder = await rp.orders.create({
      amount: Math.round(Number(amount) * 100), // Razorpay expects paise
      currency: currency || 'INR',
      receipt: `order_${orderId}`,
      notes: { commerce0s_order_id: String(orderId) },
    });

    res.json({
      razorpayOrderId: rpOrder.id,
      amount: rpOrder.amount,
      currency: rpOrder.currency,
      keyId: creds.keyId,
    });
  } catch (err) {
    // Distinguish Razorpay-auth-rejected from network/5xx.
    // The Razorpay SDK throws RazorpayError with statusCode; raw `fetch` failures
    // don't have a statusCode. We never echo the raw message to the client.
    const e = err as { statusCode?: number; error?: { code?: string }; message?: string };
    const status = e?.statusCode;
    const rawMsg = e?.message ?? String(err);
    console.error('POST /api/checkout/create-order error:', rawMsg);

    if (status === 401 || status === 403) {
      res.status(401).json({
        error: {
          code: 'RAZORPAY_AUTH_FAILED',
          message:
            'Razorpay rejected the saved credentials. Update them in Settings → Payment gateway.',
        },
      });
      return;
    }
    if (status && status >= 500) {
      res.status(502).json({
        error: {
          code: 'RAZORPAY_REQUEST_FAILED',
          message: 'Payment provider is temporarily unreachable. Try again in a few minutes.',
        },
      });
      return;
    }
    res.status(502).json({
      error: {
        code: 'ORDER_CREATE_FAILED',
        message: 'Could not start the payment. Please try again or contact support.',
      },
    });
  }
});

// POST /api/checkout/webhook — Razorpay webhook receiver
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

  // Verify signature
  const signature = req.headers['x-razorpay-signature'] as string | undefined;
  if (!signature) {
    res.status(400).json({ error: 'Missing X-Razorpay-Signature header' });
    return;
  }

  // Reconstruct body from raw request (Express 5 needs rawBody)
  // For simplicity, we re-stringify the parsed body and verify HMAC
  const bodyStr = JSON.stringify(req.body);
  const expectedSig = crypto.createHmac('sha256', webhookSecret).update(bodyStr).digest('hex');

  if (signature !== expectedSig) {
    console.error('Webhook signature mismatch');
    res.status(400).json({ error: 'Invalid webhook signature' });
    return;
  }

  const event = req.body;
  const eventType = event?.event as string | undefined;
  const paymentEntity = event?.payload?.payment?.entity;

  if (eventType === 'payment.captured' && paymentEntity) {
    // Find the order by receipt
    const receipt = paymentEntity.notes?.commerce0s_order_id as string | undefined;
    if (receipt) {
      const orderId = Number(receipt.replace('order_', ''));
      if (Number.isFinite(orderId)) {
        try {
          await pool.query(
            `UPDATE orders SET status = 'paid', razorpay_payment_id = $2 WHERE id = $1 AND status IN ('pending', 'human_approved', 'pending_human_review')`,
            [orderId, paymentEntity.id],
          );
          // Insert audit log
          pool
            .query(
              `INSERT INTO audit_log (session_id, actor, action, detail, amount, outcome)
             VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                null,
                'razorpay_webhook',
                'payment_captured',
                `Razorpay payment ${paymentEntity.id} captured for order ${orderId}`,
                paymentEntity.amount / 100,
                'success',
              ],
            )
            .catch(() => {});
          console.log(`✅ Webhook: order ${orderId} marked as paid`);
        } catch (err) {
          console.error('Webhook: failed to update order:', err);
        }
      }
    }
  } else if (eventType === 'payment.failed' && paymentEntity) {
    const receipt = paymentEntity.notes?.commerce0s_order_id as string | undefined;
    if (receipt) {
      const orderId = Number(receipt.replace('order_', ''));
      if (Number.isFinite(orderId)) {
        try {
          await pool.query(`UPDATE orders SET status = 'failed' WHERE id = $1`, [orderId]);
          pool
            .query(
              `INSERT INTO audit_log (session_id, actor, action, detail, amount, outcome)
             VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                null,
                'razorpay_webhook',
                'payment_failed',
                `Razorpay payment ${paymentEntity.id} failed for order ${orderId}`,
                paymentEntity.amount / 100,
                'failed',
              ],
            )
            .catch(() => {});
          console.log(`❌ Webhook: order ${orderId} marked as failed`);
        } catch (err) {
          console.error('Webhook: failed to update order:', err);
        }
      }
    }
  }

  res.json({ status: 'ok' });
});

// GET /api/checkout/verify/:orderId — fallback reconciliation
app.get('/api/checkout/verify/:orderId', async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isFinite(orderId)) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid order id.' } });
    return;
  }

  try {
    // Get order from DB
    const { rows } = await pool.query(
      'SELECT id, product_id, buyer_agent_id, amount, status, created_at FROM orders WHERE id = $1',
      [orderId],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order not found.' } });
      return;
    }
    const order = rows[0];

    // If already paid/failed, just return it
    if (order.status === 'paid' || order.status === 'failed') {
      res.json(order);
      return;
    }

    // Try to verify with Razorpay REST API directly
    try {
      const creds = await resolveRazorpayCreds();
      if (creds) {
        const auth = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64');
        const rpRes = await fetch(`https://api.razorpay.com/v1/orders?receipt=order_${orderId}`, {
          headers: { Authorization: `Basic ${auth}` },
        });
        if (rpRes.ok) {
          const rpData = (await rpRes.json()) as { items?: Array<{ id: string; status: string }> };
          if (rpData.items && rpData.items.length > 0) {
            const rpOrder = rpData.items[0];
            if (rpOrder.status === 'paid') {
              await pool.query(
                `UPDATE orders SET status = 'paid' WHERE id = $1 AND status != 'paid'`,
                [orderId],
              );
              order.status = 'paid';
            } else if (rpOrder.status === 'failed') {
              await pool.query(
                `UPDATE orders SET status = 'failed' WHERE id = $1 AND status != 'paid'`,
                [orderId],
              );
              order.status = 'failed';
            }
          }
        }
      }
    } catch (rpErr) {
      console.error('Razorpay verification failed:', rpErr);
      // Return the order as-is
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
}

// GET /api/audit — filterable, paginated audit trail
app.get('/api/audit', async (req, res) => {
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const action = req.query.action as string | undefined;
  const outcome = req.query.outcome as string | undefined;
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

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await pool.query(
      `SELECT id, timestamp, session_id, actor, action, detail, amount, outcome
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 API gateway listening on http://localhost:${PORT}`);
  });
}

start();
