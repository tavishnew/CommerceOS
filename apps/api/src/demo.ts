// Demo-account / workspace-bootstrap helpers.
//
// One source of truth for "is this caller the designated demo account?" so
// every endpoint that needs the answer uses the same comparison. The email
// match is the ONLY trigger; the browser cannot self-assign the demo flag.

import type pg from 'pg';

export const DEMO_BUYER_EMAIL = (
  process.env.DEMO_ACCOUNT_EMAIL ?? 'tavish350@gmail.com'
).toLowerCase().trim();

// Stable, server-controlled workspace ids. These are NOT derived from the
// email — they are constants so a misconfigured client cannot fabricate a
// workspace id that lands on the demo data.
export const DEMO_BUYER_WORKSPACE_ID = 'ws_demo_buyer';
export const DEMO_MERCHANT_WORKSPACE_ID = 'ws_demo_merchant';

export const DEFAULT_MERCHANT_WORKSPACE_ID = 'default';

export function isDemoAccountEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return email.toLowerCase().trim() === DEMO_BUYER_EMAIL;
}

/** Resolve the buyer workspaceId for a given email. The browser-sent
 *  `candidateWorkspaceId` is intentionally IGNORED — only the email
 *  determines the demo/non-demo split. This is what prevents a browser
 *  from sending isDemo=true or picking a foreign workspace id. */
export function resolveBuyerWorkspaceId(email: string | null | undefined): {
  workspaceId: string;
  isDemo: boolean;
} {
  if (isDemoAccountEmail(email)) {
    return { workspaceId: DEMO_BUYER_WORKSPACE_ID, isDemo: true };
  }
  return { workspaceId: `ws_anon_${hashEmail(email)}`, isDemo: false };
}

/** Cheap, stable hash for the non-demo case. Not cryptographic; the
 *  output is just a deterministic id keyed off the email so repeated
 *  visits from the same browser reuse the same workspace. */
function hashEmail(email: string | null | undefined): string {
  if (!email) {
    return 'guest';
  }
  let h = 5381;
  for (let i = 0; i < email.length; i++) {
    h = ((h << 5) + h + email.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

export const DEMO_MERCHANT_WORKSPACE = DEMO_MERCHANT_WORKSPACE_ID;

/** Idempotently seed the demo buyer's workspace so the user lands on a
 *  populated view. Skips silently when the workspace already has rows. */
export async function seedDemoDataIfEmpty(pool: pg.Pool): Promise<void> {
  const { rowCount: mc } = await pool.query(
    `SELECT 1 FROM merchant_settings WHERE workspace_id = $1`,
    [DEMO_MERCHANT_WORKSPACE],
  );
  if (!mc || mc === 0) {
    await pool.query(
      `INSERT INTO merchant_settings (merchant_id, workspace_id, max_auto_approve, require_human_above_cap)
       VALUES ($1, $2, 180.00, TRUE)
       ON CONFLICT (workspace_id) DO NOTHING`,
      [DEMO_MERCHANT_WORKSPACE, DEMO_MERCHANT_WORKSPACE],
    );
  }

  // Demo buyer session with a sensible default cap.
  await pool.query(
    `INSERT INTO buyer_sessions (workspace_id, max_spend, autonomy)
     VALUES ($1, 250.00, 'ask_before')
     ON CONFLICT (workspace_id) DO NOTHING`,
    [DEMO_BUYER_WORKSPACE_ID],
  );

  const { rowCount: oc } = await pool.query(
    `SELECT 1 FROM orders WHERE workspace_id = $1 LIMIT 1`,
    [DEMO_BUYER_WORKSPACE_ID],
  );
  if (oc && oc > 0) return;

  const { rows: paidProds } = await pool.query<{ id: number; price: number | string; name: string }>(
    `SELECT id, price, name FROM products WHERE sku = 'LP-WW-079' LIMIT 1`,
  );
  const { rows: reviewProds } = await pool.query<{ id: number; price: number | string; name: string }>(
    `SELECT id, price, name FROM products WHERE sku = 'LP-PR-249' LIMIT 1`,
  );
  const { rows: anyProds } = await pool.query<{ id: number; price: number | string; name: string }>(
    `SELECT id, price, name FROM products WHERE enable_search = TRUE
       AND status != 'archived' AND availability = TRUE
     ORDER BY id LIMIT 1`,
  );
  const paidProd = paidProds[0] ?? anyProds[0];
  const reviewProd = reviewProds[0] ?? anyProds[0];

  const txn1 = 'TXN-DEMO-' + Date.now().toString(36) + '-001';
  const txn2 = 'TXN-DEMO-' + Date.now().toString(36) + '-002';

  if (paidProd && reviewProd) {
    await pool.query(
      `INSERT INTO orders
         (product_id, buyer_agent_id, amount, currency, status, transaction_id,
          workspace_id, razorpay_payment_id, human_approved_at, created_by_role, policy_decision)
       VALUES ($1, 'buyer.demo', $2, 'INR', 'paid', $3, $4, $5, NOW(), 'buyer', '{}'::jsonb),
              ($6, 'buyer.demo', $7, 'INR', 'pending_human_review', $8, $4, NULL, NULL, 'buyer', '{}'::jsonb)`,
      [
        paidProd.id,
        Number(paidProd.price),
        txn1,
        DEMO_BUYER_WORKSPACE_ID,
        'pay_demo_' + Date.now().toString(36),
        reviewProd.id,
        Number(reviewProd.price),
        txn2,
      ],
    );
  }

  // Audit / activity rows so the merchant-side agent-activity panel and
  // audit log have something to render on first load. We tag the rows with
  // the demo MERCHANT workspace (not the buyer workspace) because the
  // merchant landing reads from `merchantWorkspace()`. The buyer-side views
  // query the buyer workspace separately.
  await pool.query(
    `INSERT INTO audit_log (transaction_id, workspace_id, actor, action, detail, amount, outcome)
     VALUES
       ($1, $2, 'buyer.demo', 'policy_check', 'auto_approved: ' || $3, $4, 'auto_approved'),
       ($1, $2, 'buyer.demo', 'checkout_started', 'Demo order · paid', $4, 'success'),
       ($1, $2, 'razorpay_webhook', 'payment_captured', 'Demo payment captured', $4, 'success'),
       ($5, $2, 'buyer.demo', 'policy_check', 'pending_human_review: ' || $3, $4, 'human_approval_required')`,
    [
      txn1,
      DEMO_MERCHANT_WORKSPACE,
      paidProd?.name ?? 'demo item',
      paidProd ? Number(paidProd.price) : 0,
      txn2,
    ],
  );
}
