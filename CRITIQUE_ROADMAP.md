# Critique & Roadmap

Date: 2026-09-03. Scoped from the actual codebase (`apps/api`, `apps/web`), not the marketing copy. All four items below are grounded in code that exists today.

---

## 1. Session replay + audit trail

### Current state (from code)

**`audit_log` table** (`apps/api/src/index.ts:3604`):
```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id            SERIAL PRIMARY KEY,
  timestamp     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id    TEXT,
  actor         TEXT NOT NULL DEFAULT 'system',
  action        TEXT NOT NULL,
  detail        TEXT,
  amount        NUMERIC(12,2),
  outcome       TEXT NOT NULL DEFAULT 'info',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- additive migrations
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS transaction_id TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS workspace_id    TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS policy          JSONB;
```

Indexes in place: `idx_audit_log_timestamp`, `idx_audit_txn`, `idx_audit_ws_ts`.

**`trace_events` table** (`apps/api/src/index.ts:2621`):
```sql
CREATE TABLE IF NOT EXISTS trace_events (
  id          SERIAL PRIMARY KEY,
  session_id  TEXT NOT NULL,
  step_index  INTEGER NOT NULL,
  label       TEXT NOT NULL,
  detail      TEXT NOT NULL,
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- idx_trace_events_session on (session_id)
```

Trace events are written inside `BuyerConsole` orchestration (`emitProtocolEvent`, `INSERT INTO audit_log (session_id, ...)` at lines 2832, 2862, 2894).

**What is captured today**:
- Every checkout, policy check, refund, dispute, webhook, human-approval, buyer-query step writes an `audit_log` row with `actor`, `action`, `detail`, `amount`, `outcome`, plus `session_id` (buyer session) and `transaction_id` (when a txn exists).
- `trace_events` captures only the buyer-query flow: `parseIntent` → `scoreProduct` → `policyCheck` → result. Steps are persisted with `step_index` and a free-text `detail`.
- Webhook events go to a separate `webhook_events` table (`event_id`, `event_type`, `received_at`, `payload_hash`) for idempotency, not for replay.

**Gaps**:
- **No `actor_kind` field**. `actor` is free text. A merchant-facing replay UI can't filter "user clicks" from "system events" without parsing strings. Add `actor_kind` enum: `buyer_agent | buyer_user | merchant_user | system | razorpay | protocol`.
- **No `request_id` / `correlation_id`**. When an order goes through `checkout/start → human-approve → webhook → verify`, the trail is correlated only via `transaction_id`. That's enough for order-centric replay, but not for **session-centric** replay (one buyer session may include multiple orders, the in-flight trace, the live protocol events, and the audit row). A `correlation_id` (set per top-level action) would let one query return the full chain.
- **No UI surfaces this today.** `GET /api/audit` exists (`apps/api/src/index.ts:3682`) with `from/to/action/outcome/transactionId/workspaceId/limit/offset` filters, but the merchant dashboard has no replay view — only the activity feed (`/api/activity`).
- **`trace_events.session_id` is the buyer-query session id**, not the buyer's `buyer_sessions.workspace_id`. Joining trace_events to the audit log requires the URL-encoded session id; add a `workspace_id` column to `trace_events` to make it joinable without a second hop through `buyer_sessions`.
- **Page views are not recorded.** Only backend-driven actions are. If the merchant wants to see "user opened checkout page at 12:01, then added item at 12:02", we'd need a client-side beacon. Defer to a "later" milestone unless requested.

### Proposed design

**Schema changes (additive, no rewrite):**
```sql
ALTER TABLE audit_log  ADD COLUMN IF NOT EXISTS actor_kind  TEXT;   -- enum-as-text, see above
ALTER TABLE audit_log  ADD COLUMN IF NOT EXISTS correlation_id TEXT;
ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS workspace_id TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_correlation ON audit_log(correlation_id);
CREATE INDEX IF NOT EXISTS idx_audit_ws_actor_ts ON audit_log(workspace_id, actor_kind, timestamp DESC);
```

**Replay endpoint** — already have `GET /api/audit?transactionId=...`; add:
```
GET /api/replay/session/:sessionId
  →  { session, trace: [...], audit: [...], orders: [...] }
```
The handler does three indexed reads and zips them by timestamp. No SSE, no cursor pagination. Rendered as a vertical timeline on a new merchant route `/merchant/replay/:sessionId`.

**Estimated effort**: **M**. The schema delta is two columns. The endpoint is three indexed queries and a merge. The UI is a new page that reuses the existing audit-row component.

### Decision needed before coding
- Should "page view" beacons be in scope, or is server-side action trail enough for V1?

---

## 2. Real Razorpay test mode (replace `TEST_MODE_NO_RAZORPAY`)

### Current state (from code)

`TEST_MODE_NO_RAZORPAY` is wired in **five places** in `apps/api/src/index.ts`:

| Line | Branch | Behaviour |
|------|--------|-----------|
| 430 | `resolveRazorpayCreds()` | Returns a fake `keyId`/`keySecret`/`webhookSecret` from env so the resolver path is exercised without decrypting the stored credentials. |
| 524 | `RATE_LIMIT_DISABLED` | Bypasses every rate limiter when set. Required for test runs that hammer the API. |
| 1571 | `/api/checkout/start` | Mints a synthetic `rp_test_<orderId>` and writes a `razorpay_attempts` row. The real Razorpay REST call is skipped. |
| 1860 | `/api/orders/:id/refund` | Returns a fake refund id. |
| 2530 | (not read in this slice) | A fifth branch — verify before changing. |

**Webhook signature verification** (line 3273) is **always real** — it uses HMAC-SHA256 with the configured `webhookSecret` regardless of `TEST_MODE_NO_RAZORPAY`. So if we feed it a webhook signed with the same secret the resolver hands out, the verification path is genuine. The bypass flag only affects the *outbound* create-order call and the refund call, not the inbound webhook.

**Credential resolution** (`resolveRazorpayCreds`, line 423):
- Test mode: `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` from env.
- Production: stored row in `merchant_credentials` (encrypted), decrypted via `RAZORPAY_MASTER_KEY`. Falls back to env.

This means **switching to real test-mode keys is mostly env-var work**. The path already exists.

### Proposed fix

1. **Delete the five `TEST_MODE_NO_RAZORPAY` branches.** Or, narrower: delete lines 1571–1610 and 1860 (create-order and refund). Keep line 430 as a doc marker ("in tests we still sign with the env secret; that path is fine"). Or just delete 430 too and let the test suite provide stored credentials.
2. **Add `rzp_test_*` keys to `.env.example`** with a `RAZORPAY_MODE` toggle (`test | live`) and a runtime guard that refuses to start in `live` mode when `RAZORPAY_KEY_ID` is missing the `rzp_live_` prefix.
3. **Use real `rzp_test_...` keys for the demo.** Razorpay's test mode supports test card `4111 1111 1111 1111`, any future expiry, any CVV, and any OTP. The webhook flow runs through Razorpay's dashboard "Webhooks → Send test event" button, which posts a signed payload to our endpoint.
4. **Rate-limit bypass for tests stays**. The flag for *that* is `RATE_LIMIT_DISABLED` (line 524). Rename to a more honest name like `DISABLE_RATE_LIMITS=1` so it can be set without `TEST_MODE_NO_RAZORPAY` being set, and document the two are now independent.

### Env vars needed for real test mode
```env
RAZORPAY_MODE=test
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
RAZORPAY_WEBHOOK_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
```
And one for live mode if/when needed:
```env
RAZORPAY_MODE=live
RAZORPAY_KEY_ID=rzp_live_xxxxxxxxxxxx
# stored creds preferred in live; env fallback removed by guard
```

### What the demo flow looks like end-to-end after the swap
1. Buyer adds to basket, hits checkout.
2. `/api/checkout/start` makes a real `POST https://api.razorpay.com/v1/orders` with `rzp_test_...` auth. Razorpay returns a real `order_xxx` id.
3. Web checkout opens Razorpay's test modal, user pays with `4111 1111 1111 1111`, Razorpay fires `payment.captured` to `/api/checkout/webhook` (signed with the env secret). Our HMAC verification passes.
4. `markPaid` transitions the order, writes an `audit_log` row, fires an ACP event.
5. `/api/checkout/verify/:orderId` confirms `paid` on the next poll.

**Same code path, sandbox money.** No fake ids anywhere except maybe in unit tests.

### Estimated effort: **S**.
The webhook path is already real. Removing the create-order bypass and refund bypass is a 30-line diff. The env work is documentation. The local-dev setup guide (`SETUP_LOCAL_DEV.md`) needs an update.

### Decision needed before coding
- Do you want test-mode keys committed to `.env.example` as placeholders, or kept in `SETUP_LOCAL_DEV.md` as instructions only?

---

## 3. Agent-readable catalog

### Current state (from code)

`GET /api/catalog` (`apps/api/src/index.ts:599`) returns normalized products for the merchant dashboard. `CATALOG_COLS` is a constant column list (id, sku, name, description, price, currency, availability, inventory_quantity, status, image_link, brand, product_category, enable_search). The shape is human-browsing-shaped: free-text `description`, `brand` as a string, `product_category` as a single string.

There is no `attributes` jsonb, no `capabilities` (e.g. "ships internationally", "in stock: 12 units, restock ETA"), no `unit_pricing` (e.g. per-kg), no `negotiation_metadata`, no `seller_agent_url` (the ACP/A2A seller endpoint an agent would call to negotiate). The `enable_search` boolean was clearly designed to hide rows from a feed — that's the existing toggle.

The buyer-query flow (`/api/buyer/query`, line 2724) does **not** call the catalog API. It does a regex parse on the prompt, scores a pre-loaded in-memory `catalogCache` against 18 hard-coded category keywords, and returns the top match. The scoring is brittle (text-substring match on `name + sku + description + category`).

### Why "agent-readable" is a real gap, not marketing

A buyer-agent built on top of this API today has to:
1. Read a free-text `description` and guess the structured attributes.
2. Use the buyer-query endpoint to find products, which can only do "give me 1 product", not "give me 3 candidates and let me pick".
3. Call `/api/catalog/:id` to learn price/stock, then go to checkout.
4. **Cannot negotiate**: there's no seller-agent endpoint, no `min_price` / `negotiable` field, no `bulk_pricing_tiers`.
5. **Cannot subscribe to inventory changes**: no webhook out for `stock_changed`.

A merchant who wants their store to be transactable by AI agents needs an agent endpoint that:
- Returns structured, typed product metadata.
- Exposes negotiation primitives.
- Has stable, machine-readable identifiers (we have `sku` already — good).
- Documents what the agent can and cannot do with the resource.

### Proposed design

**Two-track approach, both end up at the same JSON shape:**

#### Track A — Same service, new namespace (faster)
Add `/agent/catalog*` routes that:
- Project the products table into an agent-shaped JSON.
- Filter on `enable_search = TRUE` (keep the existing toggle).
- Include: structured `attributes` (key/value), `capabilities` array (`"negotiable"`, `"in_stock"`, `"ships_international"`, `"has_warranty"`), `inventory` block (qty, restock_eta if null), `seller_agent` block (URL pointer to a future `/agent/seller` endpoint), and a `schema_version` field.
- Are documented as a stable contract via a single `AGENT_CATALOG_DESIGN.md` file.

#### Track B — Separate service (cleaner, later)
Extract `apps/api/src/agent-catalog.ts` as a sibling module that owns the projection logic. Routes are still mounted on the same Express app, but the projection lives in its own file. A future move to a separate deployable is a router-extract, not a rewrite.

**Track B is the right move**, but only if we expect the agent surface to diverge from the human surface in non-trivial ways (different versioning, separate auth, separate rate limits). For a V1 with one merchant, the file split is enough.

### Proposed schema (`AGENT_CATALOG_DESIGN.md`, to be authored)

```json
{
  "schema_version": "1.0",
  "resource_type": "product",
  "id": "kb-mx-001",
  "sku": "KB-MX-001",
  "name": "Almond MX Mechanical Keyboard",
  "description_short": "Tactile quiet mechanical keyboard, USB-C, hot-swappable.",
  "description_long": null,
  "brand": { "id": "almond", "name": "Almond" },
  "category": { "id": "keyboards", "path": ["electronics", "peripherals", "keyboards"] },
  "price": { "amount": 149.00, "currency": "USD", "per_unit": "each" },
  "inventory": { "available": 12, "restock_eta": null, "low_stock_threshold": 3 },
  "attributes": { "switch_type": "tactile", "layout": "US-ANSI", "backlit": true, "wireless": false },
  "capabilities": ["in_stock", "ships_domestic", "has_warranty"],
  "negotiation": { "negotiable": false, "min_price": null, "bulk_tiers": null },
  "seller_agent": {
    "endpoint": "https://api.example.com/agent/seller",
    "protocol": "ACP/1.0",
    "auth": "bearer"
  },
  "media": [{ "type": "image", "url": "https://cdn.example.com/kb-mx-001.jpg", "alt": "..." }],
  "policy": { "auto_approve_ceiling": 180.00, "currency": "USD" }
}
```

Key differences from `/api/catalog`:
- No `id` integer; primary key is `sku` (stable across migrations).
- `category` is a path, not a single string.
- `price.currency` matches the merchant's policy currency.
- `capabilities` is an array, not a boolean (`enable_search` lives here as `"in_feed": false` for hidden SKUs).
- `seller_agent` is a first-class field that points the buyer-agent at the negotiation surface — **not** implemented yet, but the slot is reserved.
- `schema_version` so we can break shape without breaking consumers.
- Every field has a documented `null` for "unknown", never a missing key.

### Estimated effort
- Design doc only: **S** (one Markdown file + a couple of hand-written JSON examples).
- Track A implementation (same service, new routes, projection): **M**.
- Track B (file split): **M**, can be done in the same PR as Track A.

### Decision needed before coding
- Do you want the **seller-agent endpoint** implemented at the same time, or do we ship the catalog with the `seller_agent` field pointing at a 501 stub and the actual A2A/ACP contract in a separate doc?
- One currency or multi? Today the data model is multi-currency but the policy engine assumes INR. The agent catalog inherits the policy engine's currency.

---

## 4. Realistic demo products

### Current state (from code)

`seedProductsIfEmpty` (`apps/api/src/index.ts:373`) inserts five rows on an empty local DB:
- Almond MX Mechanical Keyboard — $149
- Almond Pebble Mouse — $39
- Almond Studio Headphones — $179
- Almond 11-in-1 USB-C Dock — $129
- Almond Notebook (refurb) — $689 (out of stock)

The `buyer-agent` and `policy-decision` demo flows reference "warm, quiet desk lamp under $180" (`apps/web/src/App.tsx:4037`). **There is no desk lamp in the seeded catalog.** The buyer query's regex parser does match the word "lamp" as a category keyword, but the scored product is the closest text-match, not an actual lamp.

`seedDemoDataIfEmpty` (`apps/api/src/demo.ts:63`) seeds the demo buyer workspace with 2 orders (1 paid, 1 `pending_human_review`) against whichever product is `id` 1. If the catalog is empty, no demo orders get created.

### What's wrong with the current seed
- Single brand ("Almond") on everything. A live demo with one brand looks like a single-SKU Shopify store, not a marketplace.
- "Almond Notebook (refurb)" at $689 is the only item above the policy ceiling of $180. The whole "human approval required" demo flow depends on this one row. Lose it and the flow has no example.
- No image URLs (`image_link` is `NULL` on every row), so the catalog UI renders no thumbnails.
- The "warm quiet desk lamp" sample prompt that the buyer console surfaces on every load has no matching product. The agent returns the closest text-match and the demo audience sees "lamp request → keyboard" — a credibility-destroying mismatch.

### Proposed seed (realistic, demo-friendly)

8–12 SKUs across at least three categories and two brands. At least one item **above** the policy ceiling so the human-approval path lights up. At least one **per category** the buyer-query prompt mentions. Image URLs from a stable CDN (or committed to `apps/api/src/seed-images/` as local files). Each row gets a `description` long enough that the agent's text-scoring has something to work with.

**Minimum viable demo set** (covers the existing buyer-console sample prompt):
1. Desk lamp, warm light, $79
2. Desk lamp, neutral light, $129
3. Desk lamp, premium (above ceiling), $249 — drives human-approval demo
4. Mechanical keyboard, $149 (keep)
5. Wireless mouse, $39 (keep)
6. USB-C dock, $129 (keep)
7. Studio headphones, $179 (keep)
8. Refurb laptop, $689 (keep, for the high-value demo)
9. Notebook stand, $59
10. Cable organizer, $24

Two brands (Almond + a second, e.g. "Northwind"). Real-looking descriptions (~50 words each) and a placeholder image URL on every row.

### Estimated effort: **S**.
A single migration-style seed file, no schema change. Drop the `enable_search=TRUE` filter on a couple of rows to test the "hidden" path. Update the buyer-console sample prompt to match a product that actually exists.

### Decision needed before coding
- Do you want the seed to be **deterministic** (always insert these rows on empty DB) or **idempotent and additive** (insert if missing, update if present)? Today the seed is "insert if empty" — fine for local dev, but doesn't help a demo DB that's been touched by hand.
- Image hosting: real CDN (you set the URL) vs. local placeholder SVGs committed to the repo.

---

## Suggested order of attack

| # | Item | Effort | Unblocks |
|---|------|--------|----------|
| 2 | Real Razorpay test mode | S | #4 (the seed needs a working payment to demo end-to-end) |
| 4 | Realistic seed data | S | — |
| 3 | Agent-readable catalog (design doc first, code second) | S doc / M code | — |
| 1 | Session replay | M | Needs #2 done so the audit log reflects real webhook firings |

**Quick wins this week**: #2 + #4, both S, both ship end-to-end demo credibility.

**Needs a real design call before code**: #3 (what does the agent see, what can't it do, where's the seller endpoint). Don't ship the catalog schema without your sign-off on the JSON shape.

**Defer**: #1, until you decide whether page-view beacons are in scope.
