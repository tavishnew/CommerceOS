// Live API + DB tests for /api/bootstrap, demo isolation, and debug scrub.

import { describe, expect, test } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';

const BASE = process.env.TEST_API_BASE ?? 'http://127.0.0.1:5000';
const DB_URL = process.env.DATABASE_URL ?? 'postgres://commerce:commerce@localhost:5432/commerce0s';
const pool = new pg.Pool({ connectionString: DB_URL });

async function api<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T; raw: string; allowOrigin: string | null; pna: string | null }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: T;
  try { parsed = text ? (JSON.parse(text) as T) : (undefined as T); } catch { parsed = text as unknown as T; }
  return {
    status: res.status,
    body: parsed,
    raw: text,
    allowOrigin: res.headers.get('access-control-allow-origin'),
    pna: res.headers.get('access-control-allow-private-network'),
  };
}

describe('bootstrap: demo account', () => {
  test('demo email yields demo workspace + isDemo=true', async () => {
    const r = await api<{ workspaceId: string; isDemo: boolean; email: string | null; merchantWorkspaceId: string }>(
      'POST',
      '/api/bootstrap',
      { email: 'tavish350@gmail.com', candidateWorkspaceId: 'ws_attacker' },
    );
    expect(r.status).toBe(200);
    expect(r.body.isDemo).toBe(true);
    expect(r.body.workspaceId).toBe('ws_demo_buyer');
    expect(r.body.email).toBe('tavish350@gmail.com');
    expect(r.body.merchantWorkspaceId).toBe('ws_demo_merchant');
  });

  test('non-demo email yields server-derived anon workspace + isDemo=false', async () => {
    const email = 'new-' + crypto.randomBytes(4).toString('hex') + '@example.com';
    const r = await api<{ workspaceId: string; isDemo: boolean; email: string | null }>(
      'POST',
      '/api/bootstrap',
      { email, candidateWorkspaceId: 'ws_attacker' },
    );
    expect(r.status).toBe(200);
    expect(r.body.isDemo).toBe(false);
    expect(r.body.workspaceId).not.toBe('ws_demo_buyer');
    expect(r.body.email).toBe(email);
    // Idempotency: a second call with the same email returns the same id.
    const r2 = await api<{ workspaceId: string }>('POST', '/api/bootstrap', { email });
    expect(r2.body.workspaceId).toBe(r.body.workspaceId);
  });

  test('browser isDemo=true is rejected at the gate', async () => {
    const r = await api<{ error: { code: string } }>(
      'POST',
      '/api/bootstrap',
      { email: 'attacker@example.com', isDemo: true },
    );
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_REQUEST');
  });

  test('candidateWorkspaceId from browser is ignored when email matches demo', async () => {
    const r = await api<{ workspaceId: string }>(
      'POST',
      '/api/bootstrap',
      { email: 'tavish350@gmail.com', candidateWorkspaceId: 'ws_injected' },
    );
    expect(r.status).toBe(200);
    expect(r.body.workspaceId).toBe('ws_demo_buyer');
  });
});

describe('bootstrap: demo data isolation', () => {
  test('demo workspace has seeded orders; non-demo has none', async () => {
    const { rows: demoRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM orders WHERE workspace_id = 'ws_demo_buyer'`,
    );
    expect(Number(demoRows[0].count)).toBeGreaterThan(0);

    const wsA = 'ws_iso_new_' + crypto.randomBytes(4).toString('hex');
    const r = await api<{ workspaceId: string }>('POST', '/api/bootstrap', {
      email: wsA + '@example.com',
    });
    expect(r.status).toBe(200);
    const { rows: newRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM orders WHERE workspace_id = $1`,
      [r.body.workspaceId],
    );
    expect(Number(newRows[0].count)).toBe(0);
  });

  test('demo buyer session is the only one with the demo cap', async () => {
    const { rows } = await pool.query<{ max_spend: number | string | null }>(
      `SELECT max_spend FROM buyer_sessions WHERE workspace_id = 'ws_demo_buyer'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].max_spend).not.toBeNull();
  });
});

describe('CORS: strict allowlist', () => {
  test('allowlisted origin echoes back exactly', async () => {
    const r = await api<unknown>('GET', '/api/health', undefined, {
      Origin: 'http://localhost:5173',
    });
    expect(r.status).toBe(200);
    expect(r.allowOrigin).toBe('http://localhost:5173');
  });

  test('unknown origin does not get Access-Control-Allow-Origin', async () => {
    const r = await api<unknown>('GET', '/api/health', undefined, {
      Origin: 'https://evil.example.com',
    });
    expect(r.status).toBe(200);
    expect(r.allowOrigin).toBeNull();
  });

  test('PNA opt-in is set on all responses', async () => {
    const r = await api<unknown>('GET', '/api/health');
    expect(r.pna).toBe('true');
  });

  test('OPTIONS preflight from allowlisted origin returns 204 + headers', async () => {
    const res = await fetch(`${BASE}/api/catalog`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('access-control-allow-private-network')).toBe('true');
  });

  test('OPTIONS preflight from non-allowlisted origin still returns 204 but no Allow-Origin', async () => {
    const res = await fetch(`${BASE}/api/catalog`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example.com',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('debug endpoint: secret scrub', () => {
  test('/api/debug/status does NOT echo any secret or env value', async () => {
    const r = await api<Record<string, unknown>>('GET', '/api/debug/status');
    expect(r.status).toBe(200);
    const flat = JSON.stringify(r.body).toLowerCase();
    for (const forbidden of [
      'database_url',
      'postgres://',
      'razorpay_key',
      'razorpay_secret',
      'webhook_secret',
      'encryption_key',
      'admin_token',
      'tavish350',
    ]) {
      expect(flat.includes(forbidden)).toBe(false);
    }
    // The endpoint must only carry the documented allowlist fields.
    const keys = Object.keys(r.body).sort();
    expect(keys).toEqual(['catalogCacheSize', 'catalogCacheTime', 'simulateSupplierFailure'].sort());
  });
});
