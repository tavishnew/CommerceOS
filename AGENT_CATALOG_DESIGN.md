# Agent Catalog & Seller Agent — Design

Date: 2026-09-03. This document is the stable contract for the
`/agent/*` HTTP surface. It is the single source of truth for the
JSON shape; the implementation in `apps/api/src/agent-catalog.ts`
and the seed image URLs in `seedProductsIfEmpty` are the only places
that should diverge from this file, and only for forward-compat
additive fields.

The goal is to let an autonomous buyer-agent do three things end to
end without scraping human-shaped HTML:

1. **Find** — query the catalog with structured filters, get back
   JSON-LD-style product resources.
2. **Negotiate** — call a single seller-agent endpoint with a
   proposed price and quantity; the seller responds accept / counter
   / reject.
3. **Act on intent** — describe a buy in natural language; the
   server returns ranked candidates with a structured match report,
   replacing today's regex buyer-query scoring.

## Stability

- The route namespace is `/agent/*`. Anything outside that prefix is
  out of scope for buyer-agents and may break without notice.
- Every response object carries `schema_version` as a string
  (`"1.0"`). A future breaking change bumps the major version;
  additive fields do not.
- `sku` is the primary key for products. The legacy integer `id`
  is omitted from the agent surface entirely.
- Unknown / not-applicable fields are returned as `null`, never
  omitted. A consumer that walks keys does not need nullability
  guards.

## Resource: `Product`

```json
{
  "schema_version": "1.0",
  "resource_type": "product",
  "sku": "LP-WW-079",
  "name": "Northwind Warm Desk Lamp",
  "description_short": "Compact 8W LED desk lamp, 3000K warm white, brass-finish arm.",
  "description_long": "Full 50-word marketing description here...",
  "brand": { "id": "northwind", "name": "Northwind" },
  "category": { "id": "lighting", "path": ["home", "lighting", "desk-lamps"] },
  "price": { "amount": 79.00, "currency": "USD", "per_unit": "each" },
  "inventory": { "available": 24, "restock_eta": null, "low_stock_threshold": 3 },
  "attributes": {
    "wattage_w": 8,
    "color_temp_k": 3000,
    "dimmable": false,
    "material": "brass + aluminium",
    "usb_charging": true
  },
  "capabilities": ["in_stock", "ships_domestic", "has_warranty"],
  "negotiation": {
    "negotiable": true,
    "min_price": 63.20,
    "currency": "USD",
    "bulk_tiers": [
      { "min_quantity": 5,  "unit_price": 71.10 },
      { "min_quantity": 25, "unit_price": 59.25 }
    ]
  },
  "seller_agent": {
    "endpoint": "/agent/seller",
    "protocol": "internal/1.0",
    "auth": "session"
  },
  "media": [
    { "type": "image", "url": "https://picsum.photos/seed/lp-ww-079/640/480", "alt": "Northwind Warm Desk Lamp" }
  ],
  "policy": { "auto_approve_ceiling": 180.00, "currency": "USD" }
}
```

Field notes:

- `capabilities` is an array of strings from a controlled vocabulary:
  `in_stock`, `out_of_stock`, `ships_domestic`, `ships_international`,
  `has_warranty`, `returnable`, `negotiable`. The buyer-agent should
  treat unknown strings as a soft "no" rather than a hard error.
- `negotiation.bulk_tiers` is `null` for non-negotiable SKUs.
- `policy.auto_approve_ceiling` is the merchant's per-workspace cap;
  the agent uses it to decide whether to call `/agent/seller/negotiate`
  or just buy outright.
- `media[]` is image-only for V1. The slot reserves room for video /
  3D-model later.
- `attributes` is free-form `Record<string, string | number | boolean | null>`.
  The contract is "type these at the application layer". A schema
  registry is a future addition.

## Endpoints

All endpoints respond with `{ schema_version, data | error }`. Errors
follow the same shape as the existing API:

```json
{ "schema_version": "1.0", "error": { "code": "NOT_FOUND", "message": "no such sku" } }
```

### `GET /agent/catalog`

List products the buyer-agent can transact. Filters:

| Param         | Type             | Default | Notes |
|---------------|------------------|---------|-------|
| `category`    | string           | —       | Matches `category.id` (lighting, keyboards, …) |
| `brand`       | string           | —       | Matches `brand.id` (almond, northwind) |
| `max_price`   | number           | —       | Upper bound on `price.amount` |
| `min_qty`     | integer          | 1       | Filter by inventory; returns SKUs with `inventory.available >= min_qty` |
| `capability`  | string           | —       | Repeated. Product must have every listed capability. |
| `q`           | string           | —       | Substring match against `name` and `description_short`. |
| `limit`       | integer          | 50      | Max 200. |
| `offset`      | integer          | 0       | |

Response:
```json
{
  "schema_version": "1.0",
  "data": {
    "total": 10,
    "limit": 50,
    "offset": 0,
    "products": [ /* Product, ... */ ]
  }
}
```

### `GET /agent/catalog/:sku`

Single product. `404` with `code: "NOT_FOUND"` when the sku is
hidden (`enable_search = FALSE`) or unknown.

### `POST /agent/seller/negotiate`

Request:
```json
{
  "sku": "LP-WW-079",
  "quantity": 5,
  "proposed_unit_price": 65.00,
  "currency": "USD"
}
```

Response:
```json
{
  "schema_version": "1.0",
  "data": {
    "decision": "counter",
    "sku": "LP-WW-079",
    "quantity": 5,
    "unit_price": 71.10,
    "total": 355.50,
    "currency": "USD",
    "expires_at": "2026-09-03T18:00:00Z",
    "reason": "matched bulk_tier min_quantity=5 unit_price=71.10"
  }
}
```

Decision semantics:
- `accept` — server accepts the proposed price. `unit_price` mirrors
  the request. `expires_at` is 15 minutes.
- `counter` — server returns a counter-offer. The buyer can re-call
  with the new price or walk away. `expires_at` is 15 minutes.
- `reject` — server refuses. `reason` is human-readable.
- `counter_quote_required` — quantity is over the highest bulk tier
  and the seller-agent needs explicit human input; `unit_price` is
  `null`. Treat as a soft reject.

### `POST /agent/seller/intent`

Structured / semi-structured buy request. The server parses the
intent against the catalog, runs the same scoring the human
buyer-query uses today, and returns ranked candidates with a
per-product `match_report` so the agent can explain *why* each
candidate ranked.

Request:
```json
{
  "intent": "warm quiet desk lamp under $180",
  "quantity": 1,
  "constraints": {
    "max_price": 180.00,
    "min_qty": 1,
    "capabilities": ["in_stock"]
  }
}
```

Response:
```json
{
  "schema_version": "1.0",
  "data": {
    "parsed": {
      "category_hint": "lighting",
      "price_ceiling": 180.00,
      "attribute_hints": { "color_temp_k_max": 3500 }
    },
    "candidates": [
      {
        "sku": "LP-WW-079",
        "score": 0.92,
        "match_report": {
          "category_match": 1.0,
          "price_match": 1.0,
          "attribute_match": 0.8,
          "explanation": "category=lighting, price=79.00 <= 180.00, color_temp_k=3000 <= 3500"
        }
      },
      { "sku": "LP-NL-129", "score": 0.71, "match_report": { "...": "..." } }
    ]
  }
}
```

The intent endpoint does NOT auto-checkout. It is read-only and
replaces the regex parser in `apps/api/src/index.ts` that today
scores an in-memory cache. The new implementation projects the
catalog into the agent shape, then scores the structured intent
against the same shape.

## Auth

All `/agent/*` routes use the existing per-workspace auth. The
buyer-agent and seller-agent are conceptually two roles over the
same workspace:

- `GET /agent/catalog*` and `POST /agent/seller/intent` are
  read-only and use the same buyer-workspace auth as `/api/catalog`.
- `POST /agent/seller/negotiate` is write-shaped. It requires the
  merchant-workspace auth header and writes a negotiation event to
  `audit_log` (action `seller_negotiation`, with the structured
  request and response in `detail`).

For V1 we treat the merchant and buyer as operating on a single
shared workspace, so a demo call to `/agent/seller/negotiate` is
authenticated the same way the rest of the API is today.

## Versioning

- Additive: new fields, new `capabilities` strings, new endpoints
  under `/agent/*` — no `schema_version` bump, no breakage.
- Breaking: renaming a field, removing a field, changing a
  decision's semantics, changing the auth requirement — bump
  `schema_version` to `"2.0"` and run the routes side-by-side until
  consumers move.

## Out of scope (V1)

- Streaming / webhook subscriptions for `inventory.available`
  changes.
- A formal A2A / ACP envelope. The `seller_agent.protocol` field
  is a placeholder; the negotiation endpoint is HTTP/JSON.
- A2A capability advertisement. We document what the server can
  do; we do not serve a `/.well-known/agent.json` yet.
- Multi-currency. Today's data model is single-currency per
  merchant workspace; the agent surface inherits that.
