# 2026-09-03 — Razorpay workspace scoping

Migration file: `2026-09-03-razorpay-workspace-scoping.sql`

## What this migration does

Today `merchant_credentials` and `merchant_settings` are singletons keyed by `merchant_id TEXT PRIMARY KEY DEFAULT 'default'`. Every workspace reads the same Razorpay credentials and the same policy. This migration:

1. Adds a nullable `workspace_id` column to both tables.
2. Backfills `workspace_id = merchant_id` for existing rows (covers `'default'` and `'ws_demo_merchant'`).
3. Sets `workspace_id NOT NULL` and switches the primary key to `workspace_id`.
4. Keeps the `merchant_id` column for legacy string references (audit logs, etc).

## Pre-flight checklist (you do this)

- [ ] Take a Neon branch snapshot, OR a `pg_dump` of the production DB.
- [ ] Confirm no running API instances are mid-mutation. (Render auto-restarts on crash, so a brief downtime is fine.)
- [ ] Open `psql` (or Neon's SQL editor) connected to the production DB.
- [ ] Read the full migration file once. Step 4 (PK drop/add) is the only non-idempotent step.

## Run

```bash
psql "$NEON_DATABASE_URL" -f apps/api/migrations/2026-09-03-razorpay-workspace-scoping.sql
```

The script `BEGIN; ... COMMIT;`s as one transaction. The final `DO $$ ... $$` block raises an exception if duplicate `workspace_id` values exist — that means you had a stale row from a previous run; resolve manually before re-running.

Expected output:
```
NOTICE: merchant_credentials rows = N, merchant_settings rows = M
COMMIT
```

Where N and M equal the number of distinct `merchant_id` values that existed before.

## Post-flight verification

Run these by hand, do not commit results:

```sql
SELECT merchant_id, workspace_id, razorpay_key_id
  FROM merchant_credentials ORDER BY workspace_id;
SELECT merchant_id, workspace_id, max_auto_approve
  FROM merchant_settings ORDER BY workspace_id;
```

Expected:
- One row per `merchant_id` that existed before.
- `tavish350@gmail.com` demo workspace: `workspace_id = 'ws_demo_merchant'`.
- Everyone else: `workspace_id = 'default'`.

## Code changes (ship after migration lands)

These are the diffs you'll apply to `apps/api/src/index.ts` once the schema is correct. **Do NOT deploy these code changes before the migration is applied** — the new code looks up by `workspace_id` and will return `null` (silent checkout failure) until the column exists.

### 1. `resolveRazorpayCreds(workspaceId)` — drop the `'default'` default

```ts
// OLD: apps/api/src/index.ts:523
async function resolveRazorpayCreds(merchantId = 'default'): Promise<ResolvedRazorpayCreds | null> {
  const { rows } = await pool.query<MerchantCredentialsRow>(
    `SELECT merchant_id, razorpay_key_id, ...
     FROM merchant_credentials WHERE merchant_id = $1`,
    [merchantId],
  );
  ...
}

// NEW: workspaceId is required, query by workspace_id
async function resolveRazorpayCreds(workspaceId: string): Promise<ResolvedRazorpayCreds | null> {
  const { rows } = await pool.query<MerchantCredentialsRow>(
    `SELECT merchant_id, workspace_id, razorpay_key_id,
            razorpay_key_secret_encrypted, razorpay_webhook_secret_encrypted,
            updated_at
     FROM merchant_credentials WHERE workspace_id = $1`,
    [workspaceId],
  );
  ...
}
```

### 2. Update all 8 callers — pass real workspace id

Each of these lines is currently `creds = await resolveRazorpayCreds();` with no arg. Replace with `await resolveRazorpayCreds(<local-workspace-id>)` where `<local-workspace-id>` is the variable already in scope (look at the surrounding function — every caller has `workspaceId` or `merchantWorkspace()` in scope).

Callers to update:
- `apps/api/src/index.ts:1470` — inside `/api/checkout/start` POST handler. `workspaceId` is in scope from request body.
- `:1794` — refund path. `workspaceId` from the order row.
- `:2171` — settings/razorpay/test endpoint. `workspaceId` from request body.
- `:2244` — admin reconcile. `workspaceId` from order row.
- `:2344` — admin refund reconcile. `workspaceId` from order row.
- `:2564` — human-approve order. `workspaceId` from order row.
- `:3272` — webhook receiver. Webhooks don't carry a workspace, so look up the workspace from the order row (which the webhook already loads at `:3343–3344`).
- `:3513` — checkout verify. `workspaceId` already in scope from request body.

### 3. Drop the singleton DELETE/SELECT/INSERT literals

```ts
// OLD: apps/api/src/index.ts:1980 (seed insert)
INSERT INTO merchant_settings (merchant_id, ...) VALUES ('default', ...)

// NEW: pass workspaceId; remove the literal 'default'
// Use merchantWorkspace() (which returns 'default' today) or the caller's
// workspaceId. The settings table is global per merchant workspace.
```

```ts
// OLD: apps/api/src/index.ts:2020 (settings GET)
WHERE merchant_id = 'default'

// NEW:
WHERE merchant_id = $1  // with [workspaceId] bound
// OR switch to workspace_id if you have the column populated.
```

```ts
// OLD: apps/api/src/index.ts:2155 (settings DELETE)
DELETE FROM merchant_credentials WHERE merchant_id = 'default'

// NEW:
DELETE FROM merchant_credentials WHERE workspace_id = $1  // with [workspaceId] bound
```

### 4. Frontend: remove the `?? 'default'` fallbacks

```ts
// OLD: apps/web/src/App.tsx:2042
refundOrder(order.id, order.workspace_id ?? 'default')

// NEW: surface the missing-workspace as an error
refundOrder(order.id, order.workspace_id)
if (!order.workspace_id) {
  toast.error('Cannot refund: order is missing workspace context.');
  return;
}
```

Same for `:2267` and `:2285`.

### 5. Verify with a fresh workspace

1. Sign up with a non-demo email (anything except `tavish350@gmail.com`).
2. Confirm dashboard shows empty catalog (catalog is global — by design).
3. Confirm orders = 0, activity = 0, audit = 0.
4. Confirm Razorpay Settings shows "Not configured", no test keys visible, all three input fields empty.
5. Configure test keys via the Settings page.
6. Hit `GET /api/settings/razorpay` with the new workspace's session — confirm the keys you just saved come back masked.
7. Sign in as `tavish350@gmail.com` (demo). Confirm the original test credentials still appear and the demo data is intact.

### 5b. Verify the buyer-side workspace boundary (post-T1 code)

The frontend `?? 'default'` fallbacks are removed — orders without a
`workspace_id` no longer silently call the singleton. Confirm:

1. As the new non-demo user, try to refund or dispute an order whose
   `workspace_id` is somehow `null` (no normal flow produces this, but a
   manual DB poke is fine). The action must show a destructive toast
   "Order is missing workspace context. Refresh and try again." and NOT
   call the API. Server logs should contain
   `refund aborted: order is missing workspace_id`.
2. As the demo user, the existing refund / dispute flow on the demo
   orders still works (orders have `workspace_id = 'ws_demo_buyer'`).
3. `POST /api/admin/razorpay/reconcile` and
   `POST /api/admin/razorpay/refunds/reconcile` continue to work with
   `X-Admin-Token`. They now resolve creds from
   `merchantWorkspace()` (= `'default'`) — a freshly seeded merchant
   workspace row in `merchant_credentials` must exist for them to find
   the keys. The `ensureMerchantCredentialsTable` + `ensureMerchantSettingsTable`
   boot path seeds that row idempotently.

### 5c. Verify per-workspace settings isolation

With the migration applied, `merchant_settings` and
`merchant_credentials` are PK-keyed by `workspace_id`. Confirm:

1. As the demo user, `GET /api/settings` returns the demo's
   `max_auto_approve` (180) and `require_human_above_cap` (true).
2. As the demo user, `GET /api/settings/razorpay` returns the demo's
   saved Razorpay key id (masked) or the env fallback if the row is
   absent.
3. As the new non-demo user, after configuring keys via the UI,
   `GET /api/settings/razorpay` returns the just-saved keys masked.
4. After deleting the non-demo's settings via the UI, a second
   non-demo signup does NOT see the same keys — the previous
   workspace's row is gone, the new workspace is unconfigured.

## Rollback

If something goes wrong:

```sql
-- Revert the PK swap
ALTER TABLE merchant_credentials
  DROP CONSTRAINT merchant_credentials_pkey,
  ADD CONSTRAINT merchant_credentials_pkey PRIMARY KEY (merchant_id);
ALTER TABLE merchant_settings
  DROP CONSTRAINT merchant_settings_pkey,
  ADD CONSTRAINT merchant_settings_pkey PRIMARY KEY (merchant_id);

-- Drop the new column
ALTER TABLE merchant_credentials DROP COLUMN workspace_id;
ALTER TABLE merchant_settings DROP COLUMN workspace_id;
```

Then revert the code change (single git revert).

## Open follow-ups (NOT in this migration)

- `MERCHANT_WORKSPACE_ID = 'default'` constant at `apps/api/src/index.ts:3631` — still hardcoded. Real multi-tenant work needs this to derive from a request header or JWT claim. Out of scope for the buildathon.
- `apps/web/src/lib/api.ts:212–243` — no auth header. Workspace id flows in body fields. Forgeable. Single-tenant demo OK; multi-tenant needs real auth.
- `/.well-known/agent.json` not implemented. See `SUBMISSION_READINESS.md` §6.
- AGENT_CATALOG_DESIGN.md overclaims capabilities + attributes. Trim the doc to match code, or implement the missing values.
