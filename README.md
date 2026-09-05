# CommerceOS

Multi-tenant commerce backend with an agent-to-agent (A2A) catalog, a buyer-side
agent that orchestrates checkout, and a React storefront. The demo runs
end-to-end against Razorpay in test mode and against a local Postgres for data.

## What's in the box

```
apps/
  api/      Express 5 + TypeScript API server. Postgres via pg. Razorpay SDK 2.9.8.
  web/      React + Vite storefront. wouter routing, framer-motion, @hugeicons.
services/
  agents/   Python A2A agents. Retailer (catalog) and supplier (inventory feed).
            ACP discovery for cross-agent task negotiation.
reference/
  a2a-protocol/  Protocol design notes used by the Python + TS surfaces.
```

## Quick start (Docker)

The recommended path. Postgres, API, and Web come up together.

```bash
docker-compose up --build
```

URLs once up:

| Service  | URL                       |
|----------|---------------------------|
| Web      | http://localhost:5173     |
| API      | http://localhost:5000     |
| Postgres | localhost:5432            |

Edit `.env.local` (root) to inject Razorpay test keys. The compose file
reads them and forwards to the API container.

## Quick start (native)

Requires Node 18+ and pnpm on the host, Postgres 16 running locally.

```bash
# 1. install
pnpm install
pnpm install --recursive

# 2. env
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
# edit apps/api/.env with your DATABASE_URL and Razorpay test keys

# 3. migrate + run
(cd apps/api && pnpm run dev)        # tsx watch on :5000
(cd apps/web && pnpm run dev)        # Vite on :5173
```

More detail in `SETUP_LOCAL_DEV.md`.

## Demo account

The server is the source of truth. The browser cannot self-assign the demo
flag.

- **Demo email**: set via `DEMO_ACCOUNT_EMAIL` in your environment.
- Demo buyer lands on `ws_demo_buyer`, demo merchant on `ws_demo_merchant`.
- Other emails get a stable `ws_live_<hash>` derived from the address so the
  same browser reuses the same merchant workspace.
- A new sign-up sees an empty catalog until they `POST /api/catalog` — the
  seeded products (`Almond`, `Northwind`) live only under `ws_demo_merchant`.
  No auto-seed copy on signup; the empty state is the honest state.

The single-tenant merchant workspace id is `default`, used as the fallback
for server-to-server callers (admin scripts, webhooks). It does not leak to
non-demo browsers.

## Key API surface

All merchant-scoped reads/writes honor the `X-Merchant-Workspace-Id` header
that `/api/bootstrap` hands out. No header → public landing view (demo trail
on `/api/activity`).

```
POST   /api/bootstrap                       — email → workspace ids
GET    /api/health                           — liveness
GET    /api/catalog                          — caller's merchant products
POST   /api/catalog                          — add product (assigned to caller)
GET    /api/orders                           — caller's orders
POST   /api/baskets                          — create basket from productId
POST   /api/checkout/start                   — start Razorpay checkout
POST   /api/checkout/webhook                 — Razorpay webhook
POST   /api/checkout/human-approve/:orderId  — human override gate
GET    /api/activity                         — audit trail (caller's merchant)
GET    /api/settings                         — merchant settings
PUT    /api/settings                         — update merchant settings
GET    /api/settings/razorpay                — show (masked) Razorpay creds
PUT    /api/settings/razorpay                — save Razorpay test/live keys
POST   /api/settings/razorpay/test           — verify a test key
GET    /api/audit /api/audit/export          — full audit (admin)

GET    /agent/catalog                        — A2A product discovery
GET    /agent/catalog/:sku                   — A2A single product
POST   /agent/seller/negotiate               — bulk/price negotiation
POST   /agent/seller/intent                  — rank products for a buyer intent
GET    /.well-known/agent.json               — A2A agent card
```

## A2A agents

`/agent/*` is a public A2A discovery + negotiation surface. Other agents
(including the buyer-agent inside the same API) discover products, rank
candidates, and negotiate price through these endpoints. Scoped to the
caller's merchant workspace by `X-Merchant-Workspace-Id`.

The Python side (`services/agents/`) provides the same surface in a
different stack: a retailer agent (catalog server, ACP discovery) and a
supplier agent (inventory feed). Run them with `python run_retailer_agent.py`
and `python run_supplier_agent.py`.

## Data model (per-merchant isolation)

Every merchant-owned table is scoped to a workspace id:

| Table                | Scoped via          | Notes |
|----------------------|---------------------|-------|
| products             | `workspace_id`      | NOT NULL, indexed. Backfilled to `ws_demo_merchant` on schema migration. |
| merchant_credentials | `workspace_id` (UNIQUE) | Razorpay key/secret/webhook, AES-encrypted at rest. |
| merchant_settings    | `workspace_id` (UNIQUE) | Max auto-approve ceiling, human-above-cap toggle. |
| buyer_sessions       | `workspace_id` (UNIQUE) | Per-buyer cap, autonomy mode. |
| orders               | `workspace_id`      | Buyer's workspace. Joined products must match the buyer's merchant ws. |
| baskets              | `workspace_id`      | Open baskets keyed to buyer. |
| audit_log            | `workspace_id`      | Every action lands here for `/api/activity`. |
| inventory_reservations | (order_id, product_id) UNIQUE | One active reservation per (order, product). |

A single `ws_live_<hash>` per non-demo email means a fresh sign-up starts
with no products, no orders, no settings, no creds — the empty state is
the literal state, not a bug.

## Razorpay

- **Mode** is set at boot via `RAZORPAY_MODE` (`test` | `live` | unset).
  - `test` requires `RAZORPAY_KEY_ID` to start with `rzp_test_`.
  - `live` requires it to start with `rzp_live_`. Live mode will not boot
    with test keys.
- **Per-merchant credentials** are preferred and stored in
  `merchant_credentials` (encrypted with `ENCRYPTION_KEY`). The fallback
  to env keys only fires when the merchant has no row.
- The Settings → Payment gateway UI lets you paste test or live keys and
  verifies them before saving.
- Reconciliation endpoints: `POST /api/admin/razorpay/reconcile`,
  `POST /api/admin/razorpay/refunds/reconcile`.

## Rate limits

Every limiter is on by default. `DISABLE_RATE_LIMITS=1` switches them all
off — used for automated tests and load demos. Independent of Razorpay
mode.

## Tests

```bash
(cd apps/api && pnpm run test)        # vitest
(cd services/agents && pytest)         # python agents
```

The API tests run against a temp Postgres (the suite provisions and tears
down its own schema). Don't run them against prod.

## Where things live

- `apps/api/src/index.ts` — every HTTP route lives here. The file is long
  by design; each route block has a header comment explaining the contract.
- `apps/api/src/agent-catalog.ts` — `/agent/*` surface.
- `apps/api/src/basket.ts`, `inventory.ts`, `demo.ts` — domain modules.
- `apps/api/scripts/` — one-off SQL migrations and tooling.
- `apps/web/src/App.tsx` — single-file router. Pages and components live
  in `apps/web/src/pages/` and `apps/web/src/components/`.

## Conventions

- **Per-tenant isolation** is the rule. Any new table that holds merchant
  data needs a `workspace_id` column and the matching index before it
  goes near a route.
- **Destructive SQL is gated.** Migrations are additive; DROP/TRUNCATE
  requires an explicit ask. The script in `apps/api/scripts/2026-09-05-products-workspace-id.ts`
  shows the shape of an idempotent additive migration.

## License

Private. No license granted.