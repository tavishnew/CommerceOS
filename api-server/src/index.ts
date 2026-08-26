import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import crypto from 'crypto';
import Razorpay from 'razorpay';

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
      id            SERIAL PRIMARY KEY,
      product_id    INTEGER NOT NULL,
      buyer_agent_id TEXT   NOT NULL,
      amount        NUMERIC(12,2) NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

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

  const [supplier, retailer] = await Promise.all([
    check(supplierUrl),
    check(retailerUrl),
  ]);

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
       ORDER BY id`
    );
    res.json(rows.map(normalizeProduct));
  } catch (err) {
    console.error('GET /api/catalog error:', err);
    res.status(500).json({ error: 'Failed to fetch catalog' });
  }
});

// Single product detail
app.get('/api/catalog/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid product id' });
    return;
  }

  try {
    const { rows } = await pool.query<ProductRow>(
      `SELECT id, sku, name, description, price, currency,
              availability, inventory_quantity, status, created_at,
              image_link, brand, product_category
       FROM products
       WHERE id = $1`,
      [id]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    res.json(normalizeProduct(rows[0]));
  } catch (err) {
    console.error('GET /api/catalog/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// Update product
app.put('/api/catalog/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid product id' });
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
      [name ?? null, sku ?? null, price != null ? Number(price) : null,
       stock != null ? Number(stock) : null, status ?? null, id]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    res.json(normalizeProduct(rows[0]));
  } catch (err) {
    console.error('PUT /api/catalog/:id error:', err);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// Delete product
app.delete('/api/catalog/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid product id' });
    return;
  }

  try {
    const { rowCount } = await pool.query('DELETE FROM products WHERE id = $1', [id]);
    if (rowCount === 0) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/catalog/:id error:', err);
    res.status(500).json({ error: 'Failed to delete product' });
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
       ORDER BY o.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/orders error:', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Create order
app.post('/api/orders', async (req, res) => {
  const { productId, buyerAgentId, amount } = req.body ?? {};

  if (productId == null || buyerAgentId == null || amount == null) {
    res.status(400).json({ error: 'Missing required fields: productId, buyerAgentId, amount' });
    return;
  }

  try {
    const { rows } = await pool.query<OrderRow>(
      `INSERT INTO orders (product_id, buyer_agent_id, amount, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING id, product_id, buyer_agent_id, amount, status, created_at`,
      [Number(productId), String(buyerAgentId), Number(amount)]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /api/orders error:', err);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// Get single order (for polling)
app.get('/api/orders/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid order id' });
    return;
  }
  try {
    const { rows } = await pool.query(
      `SELECT o.id, o.product_id, o.buyer_agent_id, o.amount, o.status, o.created_at,
              p.name AS product_name, p.sku AS product_sku
       FROM orders o
       LEFT JOIN products p ON p.id = o.product_id
       WHERE o.id = $1`,
      [id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/orders/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch order' });
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
       VALUES ('default', 180.00, TRUE)`
    );
  }
}

// GET /api/settings — read current merchant settings
app.get('/api/settings', async (_req, res) => {
  try {
    const { rows } = await pool.query<MerchantSettingsRow>(
      'SELECT merchant_id, max_auto_approve, require_human_above_cap FROM merchant_settings WHERE merchant_id = $1',
      ['default']
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'No settings found' });
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
    res.status(500).json({ error: 'Failed to fetch settings' });
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
      ]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Settings row not found' });
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
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ── Checkout human-approve gate ────────────────────────────────────────────

// POST /api/checkout/human-approve/:orderId — flip an order from pending to human-approved
app.post('/api/checkout/human-approve/:orderId', async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isFinite(orderId)) {
    res.status(400).json({ error: 'Invalid order id' });
    return;
  }
  try {
    const { rows } = await pool.query(
      `UPDATE orders SET status = 'human_approved'
       WHERE id = $1 AND status = 'pending_human_review'
       RETURNING id, product_id, buyer_agent_id, amount, status, created_at`,
      [orderId]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Order not found or not in human_review state' });
      return;
    }
    // Insert audit log for human override
    pool.query(
      `INSERT INTO audit_log (session_id, actor, action, detail, amount, outcome)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        null,
        'merchant',
        'human_override',
        `Manual override for order ${orderId}`,
        rows[0].amount,
        'approved',
      ]
    ).catch(() => {});
    res.json(rows[0]);
  } catch (err) {
    console.error('POST /api/checkout/human-approve error:', err);
    res.status(500).json({ error: 'Failed to approve order' });
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
    'CREATE INDEX IF NOT EXISTS idx_trace_events_session ON trace_events(session_id)'
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
  const categoryWords = ['lamp', 'light', 'desk', 'chair', 'table', 'monitor', 'keyboard', 'mouse', 'notebook', 'pen', 'organizer', 'speaker', 'headphone', 'charger', 'stand', 'holder', 'cable', 'adapter'];
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
  if (/this week|soon|fast|quick/.test(prompt.toLowerCase())) constraints.push('delivery this week');

  return { constraints, keywords };
}

// Score a product against the parsed intent
function scoreProduct(
  product: NormalizedProduct,
  constraints: string[],
  keywords: string[]
): { score: number; matches: number } {
  let score = 0;
  let matches = 0;
  const text = `${product.name} ${product.sku} ${product.description ?? ''} ${product.category ?? ''}`.toLowerCase();

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
app.post('/api/buyer/query', async (req, res) => {
  const { prompt } = req.body ?? {};
  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: 'Missing required field: prompt' });
    return;
  }

  const sessionId = `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const session: TraceSession = { steps: [], listeners: [], done: false, result: null };
  traceSessions.set(sessionId, session);

  const emit = (step: TraceStep) => {
    session.steps.push(step);
    session.listeners.forEach(fn => fn(step));
    // Persist to DB (fire-and-forget)
    pool.query(
      'INSERT INTO trace_events (session_id, step_index, label, detail) VALUES ($1, $2, $3, $4)',
      [sessionId, session.steps.length - 1, step.label, step.detail]
    ).catch(() => {});
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
         ORDER BY id`
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
    pool.query(
      `INSERT INTO trace_events (session_id, step_index, label, detail)
       VALUES ($1, $2, 'catalog_query_failed', 'Supplier unreachable, attempting retry')`,
      [sessionId, session.steps.length - 1]
    ).catch(() => {});
    pool.query(
      `INSERT INTO audit_log (session_id, actor, action, detail, amount, outcome)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, 'system', 'catalog_query_failed', 'Supplier unreachable, attempting retry', null, 'degraded']
    ).catch(() => {});

    // Retry once after 1s
    await new Promise(r => setTimeout(r, 1000));
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
    pool.query(
      `INSERT INTO audit_log (session_id, actor, action, detail, amount, outcome)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, 'system', 'catalog_retry_failed', 'Retry failed, falling back to cached catalog', null, 'degraded']
    ).catch(() => {});
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
        pool.query(
          `INSERT INTO audit_log (session_id, actor, action, detail, amount, outcome)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [sessionId, 'system', 'catalog_fallback', `Live fetch failed, using ${catalogCache.length} cached products`, null, 'recovered']
        ).catch(() => {});
      }
    }
  }

  const sourceLabel = catalogSource === 'cache'
    ? ' (cached)' : catalogSource === 'retry'
      ? ' (retry succeeded)' : '';
  emit({
    label: 'Network searched',
    detail: `${products.length} seller surfaces queried${sourceLabel}`,
    timestamp: now(),
  });

  // Step 3: Score candidates
  const scored = products.map(p => ({
    product: p,
    ...scoreProduct(p, constraints, keywords),
  }));
  scored.sort((a, b) => b.score - a.score);
  const shortlisted = scored.filter(s => s.score > 0);
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
      ['default']
    );
    if (rows.length > 0) {
      maxAutoApprove = Number(rows[0].max_auto_approve);
    }
  } catch { /* use default */ }

  let policyResult = 'auto_approved';
  if (topMatch && topMatch.product.price >= maxAutoApprove) {
    policyResult = 'human_approval_required';
  } else if (!topMatch) {
    policyResult = 'no_match';
  }
  emit({
    label: 'Policy checked',
    detail: policyResult === 'auto_approved'
      ? `Spend approved · cap $${maxAutoApprove.toFixed(2)}`
      : policyResult === 'human_approval_required'
        ? `Above $${maxAutoApprove.toFixed(2)} cap · requires human approval`
        : 'No candidates to evaluate',
    timestamp: now(),
  });

  // Step 5: Recommendation
  const recommended = (policyResult === 'auto_approved' || policyResult === 'human_approval_required') && topMatch
    ? topMatch.product
    : null;
  emit({
    label: 'Recommendation made',
    detail: recommended
      ? `${recommended.name} · $${recommended.price.toFixed(2)}`
      : 'No product meets all constraints',
    timestamp: now(),
  });

  session.done = true;
  session.result = {
    recommendedProduct: recommended,
    confidence: topMatch?.score ?? 0,
    policyResult,
  };

  // Insert audit log for policy decision
  if (policyResult === 'auto_approved' || policyResult === 'human_approval_required') {
    pool.query(
      `INSERT INTO audit_log (session_id, actor, action, detail, amount, outcome)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        sessionId,
        'buyer.northstar',
        'policy_check',
        `${policyResult}: ${recommended?.name ?? 'N/A'}`,
        recommended?.price ?? null,
        policyResult === 'auto_approved' ? 'auto_approved' : 'human_approval_required',
      ]
    ).catch(() => {});
  }

  session.listeners.forEach(fn => fn({ label: '__done', detail: '', timestamp: now() }));

  res.json({
    sessionId,
    steps: session.steps,
    result: session.result,
  });
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
    'Connection': 'keep-alive',
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

// Lazy-init Razorpay client (needs env vars at runtime)
let razorpay: Razorpay | null = null;
function getRazorpay(): Razorpay {
  if (!razorpay) {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set');
    }
    if (!keyId.startsWith('rzp_test_')) {
      throw new Error('Only TEST mode keys allowed (RAZORPAY_KEY_ID must start with rzp_test_)');
    }
    razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
  }
  return razorpay;
}

// POST /api/checkout/create-order — create a Razorpay order in test mode
app.post('/api/checkout/create-order', async (req, res) => {
  const { orderId, amount, currency } = req.body ?? {};

  if (orderId == null || amount == null) {
    res.status(400).json({ error: 'Missing required fields: orderId, amount' });
    return;
  }

  try {
    const rp = getRazorpay();
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
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error('POST /api/checkout/create-order error:', err);
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `Razorpay order creation failed: ${msg}` });
  }
});

// POST /api/checkout/webhook — Razorpay webhook receiver
app.post('/api/checkout/webhook', async (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('RAZORPAY_WEBHOOK_SECRET not configured');
    res.status(500).json({ error: 'Webhook not configured' });
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
  const expectedSig = crypto
    .createHmac('sha256', webhookSecret)
    .update(bodyStr)
    .digest('hex');

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
            `UPDATE orders SET status = 'paid' WHERE id = $1 AND status IN ('pending', 'human_approved', 'pending_human_review')`,
            [orderId]
          );
          // Insert audit log
          pool.query(
            `INSERT INTO audit_log (session_id, actor, action, detail, amount, outcome)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              null,
              'razorpay_webhook',
              'payment_captured',
              `Razorpay payment ${paymentEntity.id} captured for order ${orderId}`,
              paymentEntity.amount / 100,
              'success',
            ]
          ).catch(() => {});
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
          await pool.query(
            `UPDATE orders SET status = 'failed' WHERE id = $1`,
            [orderId]
          );
          pool.query(
            `INSERT INTO audit_log (session_id, actor, action, detail, amount, outcome)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              null,
              'razorpay_webhook',
              'payment_failed',
              `Razorpay payment ${paymentEntity.id} failed for order ${orderId}`,
              paymentEntity.amount / 100,
              'failed',
            ]
          ).catch(() => {});
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
    res.status(400).json({ error: 'Invalid order id' });
    return;
  }

  try {
    // Get order from DB
    const { rows } = await pool.query(
      'SELECT id, product_id, buyer_agent_id, amount, status, created_at FROM orders WHERE id = $1',
      [orderId]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Order not found' });
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
      const keyId = process.env.RAZORPAY_KEY_ID;
      const keySecret = process.env.RAZORPAY_KEY_SECRET;
      if (keyId && keySecret) {
        const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
        const rpRes = await fetch(`https://api.razorpay.com/v1/orders?receipt=order_${orderId}`, {
          headers: { Authorization: `Basic ${auth}` },
        });
        if (rpRes.ok) {
          const rpData = await rpRes.json() as { items?: Array<{ id: string; status: string }> };
          if (rpData.items && rpData.items.length > 0) {
            const rpOrder = rpData.items[0];
            if (rpOrder.status === 'paid') {
              await pool.query(`UPDATE orders SET status = 'paid' WHERE id = $1 AND status != 'paid'`, [orderId]);
              order.status = 'paid';
            } else if (rpOrder.status === 'failed') {
              await pool.query(`UPDATE orders SET status = 'failed' WHERE id = $1 AND status != 'paid'`, [orderId]);
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
    res.status(500).json({ error: 'Failed to verify order' });
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
    'CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp DESC)'
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

  if (from) { conditions.push(`timestamp >= $${idx++}`); params.push(from); }
  if (to) { conditions.push(`timestamp <= $${idx++}`); params.push(to); }
  if (action) { conditions.push(`action = $${idx++}`); params.push(action); }
  if (outcome) { conditions.push(`outcome = $${idx++}`); params.push(outcome); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await pool.query(
      `SELECT id, timestamp, session_id, actor, action, detail, amount, outcome
       FROM audit_log ${where}
       ORDER BY timestamp DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset]
    );
    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM audit_log ${where}`,
      params
    );
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

  if (from) { conditions.push(`timestamp >= $${idx++}`); params.push(from); }
  if (to) { conditions.push(`timestamp <= $${idx++}`); params.push(to); }
  if (action) { conditions.push(`action = $${idx++}`); params.push(action); }
  if (outcome) { conditions.push(`outcome = $${idx++}`); params.push(outcome); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await pool.query(
      `SELECT id, timestamp, session_id, actor, action, detail, amount, outcome
       FROM audit_log ${where}
       ORDER BY timestamp DESC LIMIT 1000`,
      params
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

  await ensureAuditLogTable();
  console.log('✅ Audit log table ready');

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 API gateway listening on http://localhost:${PORT}`);
  });
}

start();
