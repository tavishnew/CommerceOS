-- 2026-09-03-razorpay-workspace-scoping.sql
--
-- Multi-tenant scoping for the Razorpay credential + merchant settings tables.
-- Today both tables are singletons keyed by `merchant_id` (DEFAULT 'default'),
-- so every workspace reads the same Razorpay creds and the same policy.
-- This migration introduces a `workspace_id` column and switches the PK.
--
-- The `merchant_id` column is preserved (so logs / audit rows that reference
-- it by string still resolve) but is no longer the lookup key. The new
-- `workspace_id` is the lookup key, and it MUST match what the API computes
-- at runtime via `merchantWorkspace()` for merchant calls or
-- `resolveBuyerWorkspaceId(email).workspaceId` for buyer calls.
--
-- PREREQUISITE: Take a backup of the Neon database before running.
--   pg_dump --schema-only --no-owner ... (or use Neon's branch snapshot).
--
-- IDEMPOTENCY: every step uses IF NOT EXISTS / DO blocks where possible. The
-- final PRIMARY KEY drop+add is NOT idempotent and will fail on second run
-- with "constraint already exists" — that is fine, do not re-run.

BEGIN;

-- ---------------------------------------------------------------------------
-- Step 1: Add nullable workspace_id to both tables.
-- ---------------------------------------------------------------------------
ALTER TABLE merchant_credentials
  ADD COLUMN IF NOT EXISTS workspace_id TEXT;

ALTER TABLE merchant_settings
  ADD COLUMN IF NOT EXISTS workspace_id TEXT;

-- ---------------------------------------------------------------------------
-- Step 2: Backfill workspace_id from the existing merchant_id values.
-- Known ids in the current code:
--   'default'             -> MERCHANT_WORKSPACE_ID (today's singleton)
--   'ws_demo_merchant'    -> DEMO_MERCHANT_WORKSPACE_ID
-- Any other merchant_id that exists from a past run keeps itself as its
-- own workspace_id (defensive — no data loss).
-- ---------------------------------------------------------------------------
UPDATE merchant_credentials
  SET workspace_id = merchant_id
  WHERE workspace_id IS NULL;

UPDATE merchant_settings
  SET workspace_id = merchant_id
  WHERE workspace_id IS NULL;

-- ---------------------------------------------------------------------------
-- Step 3: Enforce NOT NULL on workspace_id now that the column is populated.
-- ---------------------------------------------------------------------------
ALTER TABLE merchant_credentials
  ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE merchant_settings
  ALTER COLUMN workspace_id SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Step 4: Drop the existing singleton PK (merchant_id) and replace with
-- workspace_id. We keep merchant_id as a regular column for legacy
-- references.
-- ---------------------------------------------------------------------------
ALTER TABLE merchant_credentials
  DROP CONSTRAINT IF EXISTS merchant_credentials_pkey;

ALTER TABLE merchant_credentials
  ADD CONSTRAINT merchant_credentials_pkey PRIMARY KEY (workspace_id);

ALTER TABLE merchant_settings
  DROP CONSTRAINT IF EXISTS merchant_settings_pkey;

ALTER TABLE merchant_settings
  ADD CONSTRAINT merchant_settings_pkey PRIMARY KEY (workspace_id);

-- ---------------------------------------------------------------------------
-- Step 5: Index for the new lookup key (PK already has one, but be explicit
-- for documentation purposes — the PK btree IS the index).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Step 6: Sanity check. After migration, both tables should have one row
-- per existing merchant_id. If you see > 1 row here for 'default' or
-- 'ws_demo_merchant' you had a stale row — clean it up by hand before
-- continuing.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  cred_count   INTEGER;
  setting_count INTEGER;
  dup_creds    INTEGER;
  dup_settings INTEGER;
BEGIN
  SELECT COUNT(*) INTO cred_count     FROM merchant_credentials;
  SELECT COUNT(*) INTO setting_count FROM merchant_settings;

  SELECT COUNT(*) INTO dup_creds
    FROM (SELECT workspace_id, COUNT(*) c FROM merchant_credentials
          GROUP BY workspace_id HAVING COUNT(*) > 1) d;

  SELECT COUNT(*) INTO dup_settings
    FROM (SELECT workspace_id, COUNT(*) c FROM merchant_settings
          GROUP BY workspace_id HAVING COUNT(*) > 1) d;

  RAISE NOTICE 'merchant_credentials rows = %, merchant_settings rows = %',
               cred_count, setting_count;

  IF dup_creds > 0 THEN
    RAISE EXCEPTION 'merchant_credentials has duplicate workspace_id values after backfill — resolve manually';
  END IF;
  IF dup_settings > 0 THEN
    RAISE EXCEPTION 'merchant_settings has duplicate workspace_id values after backfill — resolve manually';
  END IF;
END
$$;

COMMIT;

-- ---------------------------------------------------------------------------
-- Post-migration verification queries (run by hand, do NOT commit results):
--
--   SELECT merchant_id, workspace_id, razorpay_key_id
--     FROM merchant_credentials ORDER BY workspace_id;
--   SELECT merchant_id, workspace_id, max_auto_approve
--     FROM merchant_settings ORDER BY workspace_id;
--
-- Expected after a clean run:
--   merchant_credentials: 1 row per distinct merchant_id that existed before.
--   merchant_settings:    1 row per distinct merchant_id that existed before.
--   For tavish350@gmail.com demo: workspace_id = 'ws_demo_merchant'.
--   For everyone else:              workspace_id = 'default'.
-- ---------------------------------------------------------------------------
