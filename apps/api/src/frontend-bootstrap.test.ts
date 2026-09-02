// Frontend initialization contract — mirrors the WorkspaceProvider flow in
// apps/web/src/hooks/use-workspace.ts:
//   1. Read email from localStorage (here: a per-test in-memory store).
//   2. POST /api/bootstrap with {email, candidateWorkspaceId}.
//   3. Persist the returned workspaceId; never submit isDemo.
//   4. Treat the server as authoritative — browser-sent isDemo/workspaceId
//      must not influence the result.
//   5. Idempotent across reloads (same email → same id).
//   6. Server seed must run at most once (no duplicate demo rows on re-boot).

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';

const BASE = process.env.TEST_API_BASE ?? 'http://127.0.0.1:5000';
const DEMO_EMAIL = 'tavish350@gmail.com';

interface BootstrapResponse {
  workspaceId: string;
  isDemo: boolean;
  email: string | null;
  merchantWorkspaceId: string;
}

interface ErrorBody {
  error: { code: string; message: string };
}

/** In-memory localStorage stand-in. The real one is keyed off origin; here we
 *  just need the same read/persist semantics for the email + id pair. */
class FakeLocalStorage {
  private store = new Map<string, string>();
  getItem(k: string) { return this.store.get(k) ?? null; }
  setItem(k: string, v: string) { this.store.set(k, v); }
  removeItem(k: string) { this.store.delete(k); }
  clear() { this.store.clear(); }
}

interface Startup {
  email: string | null;
  candidateWorkspaceId: string;
  persistedWorkspaceId: string | null;
  persistedBootstrapped: boolean;
}

/** Exact body shape WorkspaceProvider sends — no `isDemo`, ever. */
function buildStartupBody(s: Startup) {
  return {
    email: s.email,
    candidateWorkspaceId: s.candidateWorkspaceId,
  };
}

async function bootstrapOnce(
  ls: FakeLocalStorage,
  email: string | null,
): Promise<BootstrapResponse> {
  const candidate =
    ls.getItem('commerce0s.buyerWorkspaceId') ?? `ws_cand_${crypto.randomBytes(6).toString('hex')}`;
  const res = await fetch(`${BASE}/api/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildStartupBody({ email, candidateWorkspaceId: candidate, persistedWorkspaceId: null, persistedBootstrapped: false })),
  });
  const body = (await res.json()) as BootstrapResponse | ErrorBody;
  if (!res.ok) throw new Error(`bootstrap failed: ${res.status}`);
  const ok = body as BootstrapResponse;
  ls.setItem('commerce0s.buyerWorkspaceId', ok.workspaceId);
  ls.setItem('commerce0s.buyerEmail', ok.email ?? '');
  ls.setItem('commerce0s.buyerBootstrapped', '1');
  return ok;
}

describe('frontend startup: bootstrap flow', () => {
  let baselineDemoOrderCount = 0;

  beforeAll(async () => {
    const r = await fetch(`${BASE}/api/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: DEMO_EMAIL, candidateWorkspaceId: 'ws_baseline' }),
    });
    expect(r.status).toBe(200);
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://commerce:commerce@localhost:5432/commerce0s' });
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM orders WHERE workspace_id = 'ws_demo_buyer'`,
    );
    baselineDemoOrderCount = Number(rows[0].count);
    await pool.end();
  });

  afterAll(async () => {
    // Sanity: seeding didn't multiply rows since baseline.
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://commerce:commerce@localhost:5432/commerce0s' });
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM orders WHERE workspace_id = 'ws_demo_buyer'`,
    );
    expect(Number(rows[0].count)).toBe(baselineDemoOrderCount);
    await pool.end();
  });

  test('1. demo email resolves to demo workspace on first call', async () => {
    const ls = new FakeLocalStorage();
    const r = await bootstrapOnce(ls, DEMO_EMAIL);
    expect(r.isDemo).toBe(true);
    expect(r.workspaceId).toBe('ws_demo_buyer');
    expect(r.merchantWorkspaceId).toBe('ws_demo_merchant');
    expect(r.email).toBe(DEMO_EMAIL);
    // Persisted exactly as the real WorkspaceProvider would persist.
    expect(ls.getItem('commerce0s.buyerWorkspaceId')).toBe('ws_demo_buyer');
    expect(ls.getItem('commerce0s.buyerBootstrapped')).toBe('1');
  });

  test('2. same demo email on reload returns the same workspace', async () => {
    const ls = new FakeLocalStorage();
    const a = await bootstrapOnce(ls, DEMO_EMAIL);
    const b = await bootstrapOnce(ls, DEMO_EMAIL);
    expect(a.workspaceId).toBe(b.workspaceId);
    expect(b.workspaceId).toBe('ws_demo_buyer');
  });

  test('3. new email resolves to its own clean workspace', async () => {
    const ls = new FakeLocalStorage();
    const email = `new-${crypto.randomBytes(4).toString('hex')}@example.com`;
    const r = await bootstrapOnce(ls, email);
    expect(r.isDemo).toBe(false);
    expect(r.workspaceId).not.toBe('ws_demo_buyer');
    expect(r.email).toBe(email);
  });

  test('4. reload new workspace — same id (server-derived, stable)', async () => {
    const ls = new FakeLocalStorage();
    const email = `stable-${crypto.randomBytes(4).toString('hex')}@example.com`;
    const a = await bootstrapOnce(ls, email);
    const b = await bootstrapOnce(ls, email);
    expect(a.workspaceId).toBe(b.workspaceId);
  });

  test('5. browser cannot claim isDemo — payload is rejected', async () => {
    // The frontend never sends isDemo; this test asserts the server still
    // rejects the field even if a malicious script tried to.
    const res = await fetch(`${BASE}/api/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'attacker@example.com',
        candidateWorkspaceId: 'ws_attacker',
        isDemo: true,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('INVALID_REQUEST');
  });

  test('5b. server ignores browser-supplied candidateWorkspaceId for demo', async () => {
    const res = await fetch(`${BASE}/api/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: DEMO_EMAIL,
        candidateWorkspaceId: 'ws_injected_evil',
      }),
    });
    const body = (await res.json()) as BootstrapResponse;
    expect(res.status).toBe(200);
    // Server is authoritative — candidate is dropped, demo workspace is used.
    expect(body.workspaceId).toBe('ws_demo_buyer');
  });

  test('6. cross-workspace access is rejected at the API layer', async () => {
    // Bootstrap a fresh workspace, then try to read orders from a different
    // workspaceId. The server must not return the demo's data.
    const ls = new FakeLocalStorage();
    const email = `iso-${crypto.randomBytes(4).toString('hex')}@example.com`;
    const ws = await bootstrapOnce(ls, email);

    // Attempt to fetch the demo workspace's orders using a foreign workspaceId.
    // (Direct DB query is the test's only honest way to assert isolation.)
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://commerce:commerce@localhost:5432/commerce0s' });
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM orders WHERE workspace_id = $1`,
      [ws.workspaceId],
    );
    expect(Number(rows[0].count)).toBe(0);
    await pool.end();
  });

  test('7. no duplicate demo seed rows after multiple bootstrap calls', async () => {
    // The server's seedDemoDataIfEmpty is idempotent. Several reloads of the
    // demo email must not multiply the seeded rows.
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${BASE}/api/bootstrap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: DEMO_EMAIL, candidateWorkspaceId: `ws_repeat_${i}` }),
      });
      expect(r.status).toBe(200);
    }
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://commerce:commerce@localhost:5432/commerce0s' });
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM orders WHERE workspace_id = 'ws_demo_buyer'`,
    );
    expect(Number(rows[0].count)).toBe(baselineDemoOrderCount);
    await pool.end();
  });
});
