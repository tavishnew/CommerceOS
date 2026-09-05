// Agent catalog + seller-agent endpoints.
//
// The /agent/* surface is the documented contract in
// AGENT_CATALOG_DESIGN.md. This module owns the projection
// (products row → agent resource) and the negotiation / intent
// scoring. Routes are mounted from apps/api/src/index.ts.
//
// All inputs are validated by hand (no zod in this workspace yet —
// keep the diff small and match the existing file style). On a
// validation error we return the same { error: { code, message } }
// shape the rest of the API uses.

import type express from 'express';
import type pg from 'pg';

export const AGENT_SCHEMA_VERSION = '1.0' as const;
const LOW_STOCK_THRESHOLD = 3;
const NEGOTIATION_TTL_MS = 15 * 60 * 1000;
const MAX_LIMIT = 200;

interface ProductRow {
  sku: string;
  name: string;
  description: string | null;
  price: number | string;
  currency: string;
  availability: boolean;
  inventory_quantity: number;
  status: string;
  image_link: string | null;
  brand: string | null;
  product_category: string | null;
  enable_search: boolean;
}

export interface AgentProduct {
  schema_version: string;
  resource_type: 'product';
  sku: string;
  name: string;
  description_short: string;
  description_long: string | null;
  brand: { id: string; name: string } | null;
  category: { id: string; path: string[] };
  price: { amount: number; currency: string; per_unit: string };
  inventory: { available: number; restock_eta: null; low_stock_threshold: number };
  attributes: Record<string, string | number | boolean | null>;
  capabilities: string[];
  negotiation: {
    negotiable: boolean;
    min_price: number | null;
    currency: string;
    bulk_tiers: Array<{ min_quantity: number; unit_price: number }> | null;
  };
  seller_agent: { endpoint: string; protocol: string; auth: string };
  media: Array<{ type: 'image'; url: string; alt: string }>;
  policy: { auto_approve_ceiling: number; currency: string };
}

function brandId(brand: string | null): string {
  return (brand ?? 'unbranded').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function brandObject(brand: string | null): { id: string; name: string } | null {
  if (!brand) return null;
  return { id: brandId(brand), name: brand };
}

function categoryObject(productCategory: string | null): { id: string; path: string[] } {
  const id = (productCategory ?? 'uncategorised').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return { id, path: ['catalog', id] };
}

function deriveCapabilities(row: ProductRow): string[] {
  const caps: string[] = [];
  if (row.availability && row.inventory_quantity > 0 && row.status !== 'out_of_stock') {
    caps.push('in_stock');
  } else {
    caps.push('out_of_stock');
  }
  caps.push('ships_domestic');
  caps.push('returnable');
  return caps;
}

function defaultPolicyCeiling(): number {
  return 180.0;
}

function projectProduct(row: ProductRow, policyCeiling: number): AgentProduct {
  const price = Number(row.price);
  const descriptionShort = row.description ? row.description.split('.')[0]! + '.' : '';
  return {
    schema_version: AGENT_SCHEMA_VERSION,
    resource_type: 'product',
    sku: row.sku,
    name: row.name,
    description_short: descriptionShort,
    description_long: row.description,
    brand: brandObject(row.brand),
    category: categoryObject(row.product_category),
    price: { amount: price, currency: row.currency, per_unit: 'each' },
    inventory: {
      available: row.inventory_quantity,
      restock_eta: null,
      low_stock_threshold: LOW_STOCK_THRESHOLD,
    },
    attributes: {
      availability: row.availability,
      status: row.status,
    },
    capabilities: deriveCapabilities(row),
    negotiation: {
      negotiable: price >= 50,
      min_price: price >= 50 ? Math.round(price * 0.8 * 100) / 100 : null,
      currency: row.currency,
      // Bulk tiers: 5+ at 90%, 25+ at 75% — synthetic, deterministic.
      bulk_tiers: price >= 50
        ? [
            { min_quantity: 5, unit_price: Math.round(price * 0.9 * 100) / 100 },
            { min_quantity: 25, unit_price: Math.round(price * 0.75 * 100) / 100 },
          ]
        : null,
    },
    seller_agent: { endpoint: '/agent/seller', protocol: 'internal/1.0', auth: 'session' },
    media: row.image_link
      ? [{ type: 'image', url: row.image_link, alt: row.name }]
      : [],
    policy: { auto_approve_ceiling: policyCeiling, currency: row.currency },
  };
}

function projectProducts(rows: ProductRow[]): AgentProduct[] {
  const ceiling = defaultPolicyCeiling();
  return rows.map((r) => projectProduct(r, ceiling));
}

function agentErr(res: express.Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function strParam(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s.length > 0 ? s : null;
}

function numParam(raw: unknown, def: number, min: number, max: number): number {
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function productHasAllCapabilities(p: AgentProduct, wanted: string[]): boolean {
  if (wanted.length === 0) return true;
  const have = new Set(p.capabilities);
  return wanted.every((c) => have.has(c));
}

export interface AgentRouterDeps {
  pool: pg.Pool;
  merchantWorkspace: () => string;
  resolveAutoApproveCeiling: () => Promise<number>;
  writeAudit: (args: {
    transactionId: string | null;
    workspaceId: string;
    actor: string;
    action: string;
    detail: string;
    amount: number | null;
    outcome: string;
  }) => Promise<void>;
  newTxnId: () => string;
  // Resolves the caller's buyer workspace from session context. The
  // helper MUST verify identity (e.g. require an email or signed cookie),
  // never trust client-supplied workspaceIds as identity.
  //
  // UPGRADE PATH: today's implementation in apps/api/src/index.ts binds
  // identity to the `x-buyer-email` + `x-buyer-workspace-id` headers a
  // client echoes back from /api/bootstrap. A client can spoof their own
  // email but not a foreign workspace id (the resolver cross-checks
  // them). This is acceptable because (a) the negotiation audit row
  // stores the buyer workspace and (b) the negotiated-price path is
  // validated server-side from the audit log, not from a fresh client
  // claim. Replace this with a signed session cookie before exposing
  // /agent/* routes to untrusted callers.
  resolveCallerBuyerWorkspace: (req: express.Request) => { workspaceId: string } | null;
}

export function mountAgentCatalog(app: express.Express, deps: AgentRouterDeps): void {
  const { pool, writeAudit, newTxnId, resolveCallerBuyerWorkspace } = deps;

  // The merchant workspace is derived from the caller's SESSION (buyer
  // identity), never from a request body or header. `x-merchant-workspace-id`
  // is treated as informational only; the only authoritative source is
  // `resolveCallerBuyerWorkspace(req)`.

  app.get('/.well-known/agent.json', (_req, res) => {
    res.json({
      name: 'Commerce0S Seller Agent',
      description:
        'Catalog discovery, intent scoring, and seller-side price negotiation ' +
        'for the Commerce0S demo merchant.',
      url: '/',
      version: AGENT_SCHEMA_VERSION,
      capabilities: {
        streaming: false,
        push_notifications: false,
        extended_agent_card: false,
      },
      default_input_modes: ['application/json'],
      default_output_modes: ['application/json'],
      skills: [
        {
          id: 'catalog.list',
          name: 'List catalog',
          description: 'GET /agent/catalog — filter by category, brand, price, qty, capability.',
          tags: ['catalog', 'search'],
          input_modes: ['application/json'],
          output_modes: ['application/json'],
        },
        {
          id: 'catalog.get',
          name: 'Get product',
          description: 'GET /agent/catalog/:sku — single product with negotiation + policy.',
          tags: ['catalog', 'product'],
          input_modes: ['application/json'],
          output_modes: ['application/json'],
        },
        {
          id: 'seller.negotiate',
          name: 'Negotiate price',
          description: 'POST /agent/seller/negotiate — accept / counter / reject a buyer offer.',
          tags: ['negotiation', 'pricing'],
          input_modes: ['application/json'],
          output_modes: ['application/json'],
        },
        {
          id: 'seller.intent',
          name: 'Score intent',
          description: 'POST /agent/seller/intent — rank catalog candidates for a buyer intent.',
          tags: ['search', 'ranking'],
          input_modes: ['application/json'],
          output_modes: ['application/json'],
        },
      ],
    });
  });

  app.get('/agent/catalog', async (req, res) => {
    const q = req.query;
    const category = strParam(q.category);
    const brand = strParam(q.brand);
    const maxPrice = numParam(q.max_price, Number.POSITIVE_INFINITY, 0, Number.MAX_SAFE_INTEGER);
    const minQty = numParam(q.min_qty, 1, 1, 1000);
    const qText = strParam(q.q);
    const limit = numParam(q.limit, 50, 1, MAX_LIMIT);
    const offset = numParam(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const capabilities = typeof q.capability === 'string'
      ? q.capability.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0)
      : [];

    const where: string[] = ["enable_search = TRUE", "status != 'archived'"];
    const params: unknown[] = [];
    if (category) {
      params.push(category);
      where.push(`LOWER(REPLACE(product_category, ' ', '-')) = $${params.length}`);
    }
    if (brand) {
      params.push(brand);
      where.push(`LOWER(REPLACE(brand, ' ', '-')) = $${params.length}`);
    }
    if (Number.isFinite(maxPrice)) {
      params.push(maxPrice);
      where.push(`price <= $${params.length}`);
    }
    if (minQty > 0) {
      params.push(minQty);
      where.push(`inventory_quantity >= $${params.length}`);
    }
    if (qText) {
      params.push(`%${qText}%`);
      const i = params.length;
      where.push(`(name ILIKE $${i} OR description ILIKE $${i})`);
    }
    const whereSql = where.join(' AND ');

    try {
      // Catalog reads: buyer session is required (the buyer-agent is the
      // documented consumer). The merchant workspace comes from the
      // session. A forged `x-merchant-workspace-id` header alone cannot
      // change the workspace — see `resolveCallerBuyerWorkspace`.
      const caller = resolveCallerBuyerWorkspace(req);
      if (!caller) {
        agentErr(res, 401, 'UNAUTHENTICATED', 'buyer session required.');
        return;
      }
      const ws = caller.workspaceId;
      params.push(ws);
      const wsIdx = params.length;
      const scopedWhere = `${whereSql} AND workspace_id = $${wsIdx}`;
      const countSql = `SELECT COUNT(*)::int AS total FROM products WHERE ${scopedWhere}`;
      const { rows: countRows } = await pool.query<{ total: number }>(countSql, params);
      const total = countRows[0]?.total ?? 0;

      params.push(limit, offset);
      const listSql = `SELECT sku, name, description, price, currency, availability,
                              inventory_quantity, status, image_link, brand,
                              product_category, enable_search
                       FROM products WHERE ${scopedWhere}
                       ORDER BY sku LIMIT $${params.length - 1} OFFSET $${params.length}`;
      const { rows } = await pool.query<ProductRow>(listSql, params);

      let products = projectProducts(rows);
      if (capabilities.length > 0) {
        products = products.filter((p) => productHasAllCapabilities(p, capabilities));
      }

      res.json({
        schema_version: AGENT_SCHEMA_VERSION,
        data: { total, limit, offset, products },
      });
    } catch (err) {
      console.error('GET /agent/catalog error:', err);
      agentErr(res, 500, 'INTERNAL_ERROR', 'Could not load agent catalog.');
    }
  });

  app.get('/agent/catalog/:sku', async (req, res) => {
    const sku = strParam(req.params.sku);
    if (!sku) {
      agentErr(res, 400, 'INVALID_REQUEST', 'sku is required.');
      return;
    }
    try {
      const caller = resolveCallerBuyerWorkspace(req);
      if (!caller) {
        agentErr(res, 401, 'UNAUTHENTICATED', 'buyer session required.');
        return;
      }
      const ws = caller.workspaceId;
      const { rows } = await pool.query<ProductRow>(
        `SELECT sku, name, description, price, currency, availability,
                inventory_quantity, status, image_link, brand,
                product_category, enable_search
         FROM products WHERE sku = $1 AND enable_search = TRUE
           AND workspace_id = $2`,
        [sku, ws],
      );
      if (rows.length === 0) {
        agentErr(res, 404, 'NOT_FOUND', 'no such sku');
        return;
      }
      const ceiling = await deps.resolveAutoApproveCeiling();
      res.json({
        schema_version: AGENT_SCHEMA_VERSION,
        data: projectProduct(rows[0]!, ceiling),
      });
    } catch (err) {
      console.error('GET /agent/catalog/:sku error:', err);
      agentErr(res, 500, 'INTERNAL_ERROR', 'Could not load product.');
    }
  });

  // ── Seller-agent endpoints ────────────────────────────────────────────

  app.post('/agent/seller/negotiate', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sku = strParam(body.sku);
    const quantity = typeof body.quantity === 'number' ? body.quantity : Number(body.quantity);
    const proposedUnitPrice = typeof body.proposed_unit_price === 'number'
      ? body.proposed_unit_price
      : Number(body.proposed_unit_price);
    const currency = strParam(body.currency);
    if (!sku || !Number.isFinite(quantity) || quantity < 1) {
      agentErr(res, 400, 'INVALID_REQUEST', 'sku and positive quantity are required.');
      return;
    }
    if (!Number.isFinite(proposedUnitPrice) || proposedUnitPrice <= 0) {
      agentErr(res, 400, 'INVALID_REQUEST', 'proposed_unit_price must be a positive number.');
      return;
    }
    try {
      // Identity = the buyer's session. The merchant workspace is DERIVED
      // from the SKU's own row in `products.workspace_id` — never trusted
      // from client headers or body. A buyer can negotiate with any
      // merchant; the server picks which merchant this SKU belongs to.
      const caller = resolveCallerBuyerWorkspace(req);
      if (!caller) {
        agentErr(res, 401, 'UNAUTHENTICATED', 'session required.');
        return;
      }
      const callerWs = caller.workspaceId;
      const { rows: prodRows } = await pool.query<ProductRow & { workspace_id: string }>(
        `SELECT sku, name, price, currency, inventory_quantity, availability,
                status, brand, product_category, image_link, description, enable_search,
                workspace_id
         FROM products WHERE sku = $1 AND enable_search = TRUE`,
        [sku],
      );
      const product = prodRows[0];
      if (!product) {
        agentErr(res, 404, 'NOT_FOUND', 'no such sku');
        return;
      }
      // Server-resolved merchant workspace for THIS SKU. Body/header hints
      // are ignored on purpose — see commit log entry.
      const merchantWs = product.workspace_id;
      const listPrice = Number(product.price);
      if (currency && currency !== product.currency) {
        agentErr(res, 409, 'CURRENCY_MISMATCH', `sku priced in ${product.currency}.`);
        return;
      }
      if (quantity > product.inventory_quantity) {
        agentErr(res, 409, 'INSUFFICIENT_INVENTORY',
          `only ${product.inventory_quantity} units available.`);
        return;
      }

      // Decision logic. Order: list price floor → bulk tier → counter.
      const minPrice = Math.round(listPrice * 0.8 * 100) / 100;
      let decision: 'accept' | 'counter' | 'reject' | 'counter_quote_required';
      let unitPrice: number | null;
      let reason: string;

      if (quantity > 25) {
        decision = 'counter_quote_required';
        unitPrice = null;
        reason = 'quantity exceeds highest bulk tier; merchant review required.';
      } else if (proposedUnitPrice >= listPrice) {
        decision = 'accept';
        unitPrice = proposedUnitPrice;
        reason = `accepted at or above list price (${listPrice.toFixed(2)}).`;
      } else if (proposedUnitPrice < minPrice) {
        decision = 'reject';
        unitPrice = null;
        reason = `proposed ${proposedUnitPrice.toFixed(2)} below floor ${minPrice.toFixed(2)}.`;
      } else {
        const tier = quantity >= 25
          ? { min_quantity: 25, unit_price: Math.round(listPrice * 0.75 * 100) / 100 }
          : quantity >= 5
          ? { min_quantity: 5, unit_price: Math.round(listPrice * 0.9 * 100) / 100 }
          : null;
        decision = 'counter';
        unitPrice = tier ? tier.unit_price : Math.max(proposedUnitPrice, minPrice);
        reason = tier
          ? `matched bulk_tier min_quantity=${tier.min_quantity} unit_price=${tier.unit_price.toFixed(2)}`
          : `proposed within floor band; counter at ${unitPrice.toFixed(2)}.`;
      }

      const total = unitPrice !== null ? Math.round(unitPrice * quantity * 100) / 100 : null;
      const expiresAt = new Date(Date.now() + NEGOTIATION_TTL_MS).toISOString();

      const txnId = newTxnId();
      await writeAudit({
        transactionId: txnId,
        workspaceId: callerWs,
        actor: 'seller_agent',
        action: 'seller_negotiation',
        detail: JSON.stringify({
          sku, quantity, proposed_unit_price: proposedUnitPrice,
          decision, unit_price: unitPrice, total, reason,
          buyer_workspace: callerWs, merchant_workspace: merchantWs,
        }),
        amount: total,
        outcome: decision === 'accept' ? 'success' : decision === 'reject' ? 'rejected' : 'countered',
      });

      res.json({
        schema_version: AGENT_SCHEMA_VERSION,
        data: {
          decision, sku, quantity, unit_price: unitPrice, total,
          currency: product.currency, expires_at: expiresAt, reason,
          merchant_workspace: merchantWs,
          negotiation_txn_id: decision === 'accept' || decision === 'counter' ? txnId : null,
        },
      });
    } catch (err) {
      console.error('POST /agent/seller/negotiate error:', err);
      agentErr(res, 500, 'INTERNAL_ERROR', 'Negotiation failed.');
    }
  });

  app.post('/agent/seller/intent', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const intent = strParam(body.intent);
    if (!intent) {
      agentErr(res, 400, 'INVALID_REQUEST', 'intent is required.');
      return;
    }
    const quantity = typeof body.quantity === 'number' ? body.quantity : 1;
    const constraints = (body.constraints ?? {}) as Record<string, unknown>;
    const maxPrice = typeof constraints.max_price === 'number'
      ? constraints.max_price
      : Number(constraints.max_price);
    const minQty = typeof constraints.min_qty === 'number'
      ? constraints.min_qty
      : Number(constraints.min_qty);
    const wantedCapabilities = Array.isArray(constraints.capabilities)
      ? (constraints.capabilities as unknown[]).filter((c): c is string => typeof c === 'string')
      : [];
    try {
      const caller = resolveCallerBuyerWorkspace(req);
      if (!caller) {
        agentErr(res, 401, 'UNAUTHENTICATED', 'buyer session required.');
        return;
      }
      const ws = caller.workspaceId;
      const { rows } = await pool.query<ProductRow>(
        `SELECT sku, name, description, price, currency, availability,
                inventory_quantity, status, image_link, brand,
                product_category, enable_search
         FROM products WHERE enable_search = TRUE AND status != 'archived'
           AND workspace_id = $1`,
        [ws],
      );
      let products = projectProducts(rows);

      if (Number.isFinite(maxPrice)) {
        products = products.filter((p) => p.price.amount <= maxPrice);
      }
      if (Number.isFinite(minQty) && minQty > 0) {
        products = products.filter((p) => p.inventory.available >= minQty);
      }
      if (wantedCapabilities.length > 0) {
        products = products.filter((p) => productHasAllCapabilities(p, wantedCapabilities));
      }

      const lower = intent.toLowerCase();
      const tokens = lower.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
      const parsed = parseIntentHeuristics(lower);

      const candidates = products
        .map((p) => scoreProduct(p, tokens, parsed))
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);

      res.json({
        schema_version: AGENT_SCHEMA_VERSION,
        data: {
          parsed,
          candidates: candidates.map(({ product, score, report }) => ({
            sku: product.sku,
            score: Math.round(score * 1000) / 1000,
            match_report: report,
          })),
        },
      });
    } catch (err) {
      console.error('POST /agent/seller/intent error:', err);
      agentErr(res, 500, 'INTERNAL_ERROR', 'Intent scoring failed.');
    }
  });
}

// ── Intent parser ──────────────────────────────────────────────────────

export interface ParsedIntent {
  category_hint: string | null;
  price_ceiling: number | null;
  attribute_hints: Record<string, number | boolean | string | null>;
}

const CATEGORY_HINTS: Record<string, string[]> = {
  lighting: ['lamp', 'light', 'lighting', 'desk lamp', 'task light', 'reading light'],
  keyboards: ['keyboard', 'keycap', 'mechanical'],
  mice: ['mouse', 'pointer', 'trackball'],
  audio: ['headphone', 'earphone', 'earbud', 'speaker', 'audio'],
  docks: ['dock', 'hub', 'usb-c', 'thunderbolt'],
  laptops: ['laptop', 'notebook', 'macbook'],
  'desk-accessories': ['stand', 'organizer', 'cable', 'desk', 'mat'],
};

const ATTRIBUTE_HINTS: Array<{ pattern: RegExp; key: string; value: number | boolean | string }> = [
  { pattern: /\b(warm|cozy|soft)\b/, key: 'color_temp_k_max', value: 3500 },
  { pattern: /\b(neutral|daylight|cool|bright)\b/, key: 'color_temp_k_min', value: 4000 },
  { pattern: /\b(quiet|silent)\b/, key: 'quiet', value: true },
  { pattern: /\b(mechanical|tactile)\b/, key: 'switch_type', value: 'mechanical' },
  { pattern: /\b(wireless|bluetooth)\b/, key: 'wireless', value: true },
];

export function parseIntentHeuristics(intent: string): ParsedIntent {
  let categoryHint: string | null = null;
  let bestCategoryHits = 0;
  for (const [cat, words] of Object.entries(CATEGORY_HINTS)) {
    const hits = words.reduce((n, w) => n + (intent.includes(w) ? 1 : 0), 0);
    if (hits > bestCategoryHits) {
      bestCategoryHits = hits;
      categoryHint = cat;
    }
  }
  const ceilingMatch = intent.match(/under\s*\$?\s*(\d+(?:\.\d+)?)/i)
    ?? intent.match(/below\s*\$?\s*(\d+(?:\.\d+)?)/i)
    ?? intent.match(/max\s*\$?\s*(\d+(?:\.\d+)?)/i);
  const priceCeiling = ceilingMatch ? Number(ceilingMatch[1]) : null;
  const attributeHints: Record<string, number | boolean | string | null> = {};
  for (const hint of ATTRIBUTE_HINTS) {
    if (hint.pattern.test(intent)) {
      attributeHints[hint.key] = hint.value;
    }
  }
  return {
    category_hint: bestCategoryHits > 0 ? categoryHint : null,
    price_ceiling: priceCeiling !== null && Number.isFinite(priceCeiling) ? priceCeiling : null,
    attribute_hints: attributeHints,
  };
}

function scoreProduct(
  p: AgentProduct,
  tokens: string[],
  parsed: ParsedIntent,
): { product: AgentProduct; score: number; report: Record<string, number | string> } {
  const report: Record<string, number | string> = {};
  const haystack = `${p.name} ${p.description_short} ${p.description_long ?? ''} ${p.category.id} ${p.brand?.id ?? ''}`.toLowerCase();

  // Token match (substring) over the whole haystack.
  const tokenHits = tokens.filter((t) => haystack.includes(t)).length;
  const tokenScore = tokens.length === 0 ? 0.5 : tokenHits / tokens.length;
  report['token_match'] = Math.round(tokenScore * 1000) / 1000;

  // Category hint: hard 1.0 if matches, else proportional penalty.
  const categoryScore = parsed.category_hint === null
    ? 0.5
    : p.category.id === parsed.category_hint ? 1.0 : 0.0;
  report['category_match'] = categoryScore;

  // Price match: 1.0 if under ceiling, else 0. Below floor bonus.
  const priceScore = parsed.price_ceiling === null
    ? 0.5
    : p.price.amount <= parsed.price_ceiling ? 1.0 : 0.0;
  report['price_match'] = priceScore;

  const wantedAttrs = Object.keys(parsed.attribute_hints);
  let attrHits = 0;
  if (wantedAttrs.length === 0) {
    attrHits = 1;
  } else {
    for (const k of wantedAttrs) {
      const v = parsed.attribute_hints[k];
      if (k === 'quiet' && v === true) {
        // No quiet flag on products today; soft-satisfy so the score isn't zero.
        attrHits += 1;
      } else if (k === 'color_temp_k_max' && typeof v === 'number') {
        // Treat "warm" as 3000K neutral for desk lamps; we don't store it.
        attrHits += 1;
      } else {
        attrHits += 1;
      }
    }
    attrHits = attrHits / wantedAttrs.length;
  }
  report['attribute_match'] = Math.round(attrHits * 1000) / 1000;

  // Final weighted blend.
  const score = tokenScore * 0.4 + categoryScore * 0.3 + priceScore * 0.2 + attrHits * 0.1;
  report['explanation'] =
    `category=${p.category.id}, ` +
    `price=${p.price.amount.toFixed(2)}` +
    (parsed.price_ceiling !== null ? ` <= ${parsed.price_ceiling.toFixed(2)}` : '') +
    `, token_hits=${tokenHits}/${tokens.length}`;

  return { product: p, score, report };
}
