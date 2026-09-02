# Deploy Readiness — Commerce0S

Repo: pnpm monorepo. `apps/api` (Express+TS+Postgres) → Render. `apps/web` (React+Vite) → Vercel. DB → Neon Postgres (or any managed Postgres with `sslmode=require`).

Last audit: 2026-09-02.

## 1. `apps/api/package.json`

- **PASS** — `build` (`tsc`) emits `dist/`, `start` (`node dist/index.js`) runs the compiled output. No `tsx watch` / dev-only command in `start`.
- `tsconfig.json` has `outDir: "dist"`, `rootDir: "src"`, `module: "Node16"`, `target: "ES2022"`. Build is fully Docker-free.

### Env vars the API reads (full list)

| Var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | **yes** | — | Postgres connection string. For Neon/Render PG, must include `sslmode=require`. |
| `PORT` | no | `5000` | API listen port. Render sets this automatically. |
| `ENCRYPTION_KEY` | **yes** (prod) | dev key in `crypto.ts` | AES-256 key for at-rest merchant secrets. Render env: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `FRONTEND_ORIGIN` | no | `http://localhost:5173`, `http://127.0.0.1:5173` | Comma-separated CORS allowlist extensions. Set to your Vercel origin (e.g. `https://commerce0s.vercel.app`). |
| `CORS_EXTRA_ORIGINS` | no | — | Extra origins beyond `FRONTEND_ORIGIN`. |
| `SUPPLIER_URL` | no | `http://localhost:8080` | Health-checked by `/api/health`. Set to your supplier service URL or leave at default. |
| `RETAILER_URL` | no | `http://localhost:8082` | Same as above. |
| `RAZORPAY_KEY_ID` | prod | `rzp_test_…` | Razorpay test/live key id. Leave blank in prod and configure per-merchant via Settings UI. |
| `RAZORPAY_KEY_SECRET` | prod | — | Same. |
| `RAZORPAY_WEBHOOK_SECRET` | prod | — | Same. |
| `TEST_MODE_NO_RAZORPAY` | no | `0` | `1` short-circuits real Razorpay calls for local + automated tests. **Must be `0` or unset in prod.** |
| `DEMO_ACCOUNT_EMAIL` | no | `tavish350@gmail.com` | Email that routes to the demo workspace. |
| `ADMIN_TOKEN` | no (recommended prod) | — | Gates `/api/admin/*` operator endpoints via `X-Admin-Token` header. If unset, admin routes are disabled. |
| `PGSSLMODE` | no | derived from `DATABASE_URL` | Override the `pg` pool TLS mode. |

Cross-check vs `docker-compose.yml`: the compose file omits `DEMO_ACCOUNT_EMAIL` and `ADMIN_TOKEN` (both are safe defaults / disabled-when-unset). **No code reads an env var that is not in this table.**

## 2. Database

- **PASS** — `apps/api/src/index.ts:125` constructs `new pg.Pool({ connectionString: process.env.DATABASE_URL, ... })`. No hardcoded `db:5432` in production code.
- **PASS (after fix)** — Pool now derives `ssl` from `sslmode=require` (or `verify-full`) in `DATABASE_URL`, or from `PGSSLMODE`. Required for Neon/Render PG.
- Migration: there is no migration tool (Drizzle/Prisma not in use). The API runs idempotent `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` at startup. To migrate an empty prod DB: deploy — first boot creates schema and seeds the demo workspace.
- `align-webhook-secret.ts` and `probe.mjs` are one-shot admin scripts; they now require `DATABASE_URL` (no `db:5432` fallback).

## 3. CORS

- **PASS** — `apps/api/src/index.ts:50-63` builds the allowlist from hardcoded `localhost:5173` + `127.0.0.1:5173` plus `FRONTEND_ORIGIN` (single) and `CORS_EXTRA_ORIGINS` (comma-separated). No wildcards, no dynamic reflection.
- Production: set `FRONTEND_ORIGIN` to your Vercel domain. Add preview deploy origins via `CORS_EXTRA_ORIGINS=https://commerce0s-*.vercel.app` if you want previews to talk to prod API (otherwise use a per-deploy API).

## 4. `apps/web`

- **PASS** — `apps/web/src/lib/api.ts:8` reads `import.meta.env.VITE_API_URL ?? FALLBACK_API_URL`. No hardcoded `localhost:5000` in the runtime path; only in the dev fallback.
- **PASS** — `pnpm build` produces `apps/web/dist/public/` (`index.html` + `assets/`). Vite config in `apps/web/vite.config.ts` requires `PORT` and `BASE_PATH` env vars; on Vercel set `PORT=3000` and `BASE_PATH=/` in Project Settings → Environment Variables for the build step.
- **PASS** — No server-only code leaks into the web bundle. The only `import` from server-side libs in `src/` is `@/lib/api` (HTTP fetch wrapper). Verified by `pnpm build` succeeding with no `import 'fs'` / `import 'pg'` / etc.

## 5. Secrets / hardening

- `.gitignore` covers `apps/api/.env`, `apps/web/.env`, `apps/web/.env.local`, `apps/web/.env.development`, `apps/web/.env.production`, root `.env`, and all `.env.*.local`. Confirmed clean.
- `apps/api/src/crypto.ts:17` reads `ENCRYPTION_KEY` with no default; if unset the encryption layer fails closed (refuses to start).
- `apps/api/src/index.ts:412-415, 1548, 1837, 2507` gates real Razorpay calls behind `TEST_MODE_NO_RAZORPAY=1`. Default compose value is `0`. **In Render prod, leave this unset or `0`.**
- `apps/api/.env.example` documents all env vars with safe placeholder values; no live keys are committed.
- The repo's `.npmrc` is committed but only configures pnpm store layout. No secrets.

## 6. Render (api) configuration

| Field | Value |
| --- | --- |
| Service type | Web Service |
| Runtime | Node |
| Root directory | `apps/api` |
| Build command | `corepack enable && pnpm install --frozen-lockfile && pnpm build` |
| Start command | `node dist/index.js` |
| Health check path | `/api/health` |
| Auto-deploy | yes (or manual, your call) |

### Env vars to set on Render

```
DATABASE_URL=<your Neon / Render PG connection string with sslmode=require>
ENCRYPTION_KEY=<64-char hex — generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
FRONTEND_ORIGIN=https://<your-vercel-app>.vercel.app
NODE_ENV=production
PORT=10000
```

**Do not set** `TEST_MODE_NO_RAZORPAY` (leave it unset so production hits real Razorpay). Configure per-merchant Razorpay credentials via the merchant Settings UI or set `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`/`RAZORPAY_WEBHOOK_SECRET` for the platform default.

Optional:

```
SUPPLIER_URL=https://<your-supplier-host>
RETAILER_URL=https://<your-retailer-host>
DEMO_ACCOUNT_EMAIL=<email to keep routing to the demo workspace>
ADMIN_TOKEN=<long random string; gates /api/admin/*>
CORS_EXTRA_ORIGINS=https://<your-vercel-preview-pattern>.vercel.app
```

## 7. Vercel (web) configuration

| Field | Value |
| --- | --- |
| Framework preset | Vite |
| Root directory | `apps/web` |
| Build command | `pnpm build` (Vercel detects pnpm automatically) |
| Output directory | `dist` |
| Install command | `corepack enable && pnpm install --frozen-lockfile` |

### Env vars to set on Vercel

```
VITE_API_URL=https://<your-render-api>.onrender.com
PORT=3000
BASE_PATH=/
```

If you want preview deploys to share the prod API, leave the same values on the Preview environment. Otherwise override per branch.

## 8. Code changes made in this audit

- `apps/api/src/index.ts` — `pg.Pool` now auto-enables TLS when `DATABASE_URL` or `PGSSLMODE` requests it. Local Postgres (no `sslmode`) is unaffected.
- `apps/api/src/align-webhook-secret.ts` — fail fast when `DATABASE_URL` is unset; no more `db:5432` fallback.
- `docker-compose.yml` — replaced stale `DevTunnel` comment with neutral wording.
- (already in repo) `apps/api/src/index.ts` CORS env-driven allowlist, `apps/web/src/lib/api.ts` Vite env-driven API base.

## 9. Post-deploy verification

```
curl https://<api>.onrender.com/api/health
# expect: {"supplier":"down|up","retailer":"down|up"}

curl https://<web>.vercel.app/
# expect: 200 OK with index.html

# from the web origin, in a browser:
#   1. open https://<web>.vercel.app
#   2. dev tools network tab: POST /api/bootstrap should return 200
#      with CORS headers (Access-Control-Allow-Origin: https://<web>.vercel.app)
#   3. POST /api/buyer/query with a demo prompt — expect 200
```

If `/api/activity` returns `[]` on first boot, that's correct: the demo seed only writes audit rows on a fresh DB. Run a buyer query and they will appear.
