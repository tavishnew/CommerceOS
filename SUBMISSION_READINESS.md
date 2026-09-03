# SUBMISSION_READINESS.md

Generated 2026-09-03. Repo state: branch `main`, latest commit `cd0d147f`. Evidence cited as `path:line` against the current tree.

This report is **evidence-only** (file/line) for items verifiable from code, and **CANNOT-VERIFY** for items requiring live DB or deployed-prod access. Neon connection string is in chat only and never embedded in any file. No migrations applied by the auditor.

---

## 1. Workspace isolation

| Check | Result | Evidence |
|---|---|---|
| `merchant_credentials` keyed by real `workspace_id`, not hardcoded `'default'` | **FAIL** | `apps/api/src/index.ts:508–514` — `merchant_credentials` PK is `merchant_id TEXT PRIMARY KEY DEFAULT 'default'`. No `workspace_id` column. |
| `resolveRazorpayCreds()` takes real workspace id, no fallback to shared default | **FAIL** | `apps/api/src/index.ts:523` — `async function resolveRazorpayCreds(merchantId = 'default')`. 8 no-arg callers (`:1470, :1794, :2171, :2244, :2344, :2564, :3272, :3513`) silently use the singleton. |
| Every tenant table has `workspace_id` + every read filters by it | **PARTIAL PASS** | `orders` ✅ `apps/api/src/index.ts:240–259` + filter at `:847, :1234, :3714, :3439`. `baskets` ✅ `:293–302`. `buyer_sessions` ✅ `:307–313`. `audit_log` ✅ `:3600–3617` + filter at `:3714`. `trace_events`/`webhook_events`/`razorpay_attempts` are non-tenant (keyed by `session_id`/`event_id`/`order_id`) — acceptable. `products` is global (intentional — see comment at `:376–377`). `merchant_settings` ❌ singleton at `:1969–1974`. |
| No hardcoded `workspace_id = 'default'` left in query code | **FAIL** | `apps/api/src/index.ts:1980, :2020, :2155` (settings seed + DELETE handler). `apps/web/src/App.tsx:2042, :2267, :2285` — three `?? 'default'` fallbacks when `order.workspace_id` is null. |
| Frontend always sends real auth/session; no hardcoded workspace id | **FAIL** | `apps/web/src/lib/api.ts:212–243` — `apiFetch` sets only `Content-Type`. No `Authorization` header, no session cookie. Workspace id passed in body fields, never auth headers. Forgeable client-side. `MERCHANT_WORKSPACE_ID = 'default'` constant at `apps/api/src/index.ts:3631`. |

**Verdict for §1: NOT ISOLATED.** Single-tenant by design with explicit "future work" comments (`apps/api/src/index.ts:3629–3630`). Razorpay creds + settings are a shared singleton; any second merchant sees merchant #1's data.

---

## 2. Demo data scoping

| Check | Result | Evidence |
|---|---|---|
| Boot-time seed only attaches to demo workspace | **PASS** | `apps/api/src/demo.ts:63–157` `seedDemoDataIfEmpty` — binds to `DEMO_MERCHANT_WORKSPACE` (`:151`) and `DEMO_BUYER_WORKSPACE_ID` (`:128`). Idempotent. `seedProductsIfEmpty` (`:378–487`) is global catalog — intentional per comment `:376–377`. |
| New workspace signup never calls seed functions | **PASS** | `apps/api/src/index.ts:620–655` `POST /api/bootstrap` — calls `resolveBuyerWorkspaceId` (`:634`) then `INSERT INTO buyer_sessions` only (`:639–644`). No seed call. |
| No hardcoded mock greeting renders for non-demo users | **PASS** | `apps/web/src/App.tsx:1218` — `title={buildGreeting(email)}`. `buildGreeting` derives name from email local-part or returns bare greeting. No `Alex` literal remains. Hardcoded metric cards / decision-mix / policy.guard footer are gated on `isDemo` ternary at `:1247–1306`. |

---

## 3. Razorpay settings UI

| Check | Result | Evidence |
|---|---|---|
| Key ID field present | **PASS** | `apps/web/src/App.tsx:3702–3712` — `data-testid="input-razorpay-key-id"`. |
| Key Secret field present | **PASS** | `apps/web/src/App.tsx:3725–3738` — `data-testid="input-razorpay-key-secret"`. |
| Webhook Secret field present | **PASS** | `apps/web/src/App.tsx:3739–3752` — `data-testid="input-razorpay-webhook-secret"`. |
| Mode toggle (test/live) | **PASS** | `apps/web/src/App.tsx:3681–3700` — `data-testid="button-razorpay-mode-{m}"`. |
| Save (PUT) sends all fields | **PASS** | `apps/web/src/App.tsx:3501–3553` — `handleSave` builds `{ mode, keyId, keySecret, webhookSecret }` (`:3523–3528`) → `saveRazorpaySettings`. |
| Disconnect (DELETE) works | **PASS** | `apps/web/src/App.tsx:3592–3626` — `handleDelete` → `deleteRazorpaySettings()`. Backend: `apps/api/src/index.ts:2153–2165`. |
| GET returns masked key id only | **PASS** | `apps/api/src/index.ts:2056–2091` — selects only `merchant_id, razorpay_key_id, updated_at` (`:2059`). Returns `keyIdMasked: maskRazorpayKeyId(...)` (`:2080`). `maskRazorpayKeyId` at `:2050–2053`. |
| Checkout returns 402 RAZORPAY_NOT_CONFIGURED when unconfigured | **PASS** | `apps/api/src/index.ts:1468–1483` — creds resolve + `res.status(402).json({ error: { code: 'RAZORPAY_NOT_CONFIGURED' } })` at `:1474`. |

**Verdict for §3: UI + handler layer PASS** — but the backend is a singleton (see §1), so functionally the settings page edits a shared row. New workspaces still cannot have their own keys until §1 is fixed.

---

## 4. Real Razorpay payment flow

| Check | Result | Evidence |
|---|---|---|
| `TEST_MODE_NO_RAZORPAY` fully removed | **PASS** | Zero matches in `apps/web/src` and `apps/api/src`. |
| Real `rzp_test_...` keys documented | **PASS** | `apps/api/.env.example:24` — `RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx`. Comments `:17–18`. `SETUP_LOCAL_DEV.md:77, :82, :137, :151, :166`. |
| Webhook HMAC verification intact | **PASS** | `apps/api/src/index.ts:3269` — `POST /api/checkout/webhook`. Raw body captured at `:106–120` before json parser. HMAC at `:3296` — `crypto.createHmac('sha256', webhookSecret).update(req.rawBody).digest('hex')`. `crypto.timingSafeEqual` at `:3299`. Header `x-razorpay-signature` at `:3285`. |

---

## 5. Buyer-agent query quality

| Check | Result | Evidence |
|---|---|---|
| Input clears immediately on submit | **PASS** | `apps/web/src/App.tsx:4348` — `setPrompt('')` after `setSubmitted(true)` and before `submitBuyerQuery`. |
| Nonsense returns `matched: false` | **PASS** | `apps/api/src/index.ts:2947` `MIN_CONFIDENCE_SCORE = 0.15`. Filter at `:2953` — `s.matches > 0 && s.score >= MIN_CONFIDENCE_SCORE`. Nonsense query yields `matches: 0` for every row → `shortlisted = []` → `topMatch = null` (`:2954`) → `matched: false` (`:3075`). |
| Legit queries still match at threshold | **CANNOT-VERIFY** | Threshold logic is unchanged from prior verification. Static trace matches. Live test against seeded catalog requires local API up; not run in this audit. |

---

## 6. Agent-readable catalog + A2A

| Check | Result | Evidence |
|---|---|---|
| `/agent/catalog` returns spec-shaped JSON | **PASS** | `apps/api/src/agent-catalog.ts:190` — `{ schema_version, data: { total, limit, offset, products: [...] } }`. |
| `/agent/catalog/:sku` returns spec-shaped JSON | **PASS** | `apps/api/src/agent-catalog.ts:256` — `{ schema_version, data: AgentProduct }`. |
| `/agent/seller/negotiate` works | **PASS** | `apps/api/src/agent-catalog.ts:287` — returns `{ decision, sku, quantity, unit_price, total, currency, expires_at, reason }`. |
| `/agent/seller/intent` works | **PASS** | `apps/api/src/agent-catalog.ts:394` — returns `{ parsed, candidates: [{ sku, score, match_report }] }`. |
| `/.well-known/agent.json` returns valid Agent Card | **FAIL** | Not implemented. `AGENT_CATALOG_DESIGN.md:255–264` explicitly marks "A2A capability advertisement" as V1 out-of-scope. |
| `AGENT_CATALOG_DESIGN.md` has honest "what's implemented vs not" | **PARTIAL PASS** | Honest `## Out of scope (V1)` section at `:255–264` present. But doc **overclaims** vs code: design advertises capabilities `in_stock | out_of_stock | ships_domestic | ships_international | has_warranty | returnable | negotiable` but code at `apps/api/src/agent-catalog.ts:78–85` only emits `in_stock | out_of_stock | ships_domestic | returnable`. Design advertises `attributes` keys (`wattage_w`, `color_temp_k`, `dimmable`, `material`, `usb_charging`) at `:49–55` but code at `:113–116` only sets `availability` and `status`. |

---

## 7. UI polish

| Check | Result | Evidence |
|---|---|---|
| Replit badge fully removed | **PASS** | Zero matches for `replit | Made with | repl.it` in `apps/web/index.html` and `apps/web/dist/`. |
| Decision-mix card doesn't squeeze when sidebar expanded | **PASS** | `apps/web/src/App.tsx:1250` — outer grid bumped to `2xl:grid-cols-[1.35fr_.65fr]`. `:1266` — `min-w-0 select-none` on outer card. `:1267` — `flex min-w-0` on header row. `:1287` — `min-w-0 select-none` per progress row. |
| Text cursor doesn't show on non-interactive text | **PASS** | `select-none` applied to `Pill` (`:260`), `MetricCard` (`:1156`), decision-mix card `:1266`, progress rows `:1287`, "Sample data — not live" `:1250`, Next-steps title block `:1311`. Buttons/links use real `<button>`/`<a>` → native pointer. Order rows / IDs / amounts remain selectable (intentional). |
| Icon migration to Hugeicons complete | **PASS** | Zero `lucide-react` imports. Single match is a comment at `apps/web/src/App.tsx:12`. Six `hugeicons` imports across `App.tsx`, `pages/not-found.tsx`, `components/ui/toast.tsx`. Deps: `apps/web/package.json:37–38`. |
| Favicon replaced with logo | **PASS** | `apps/web/public/favicon.svg` — vermilion rounded square with white "0" glyph matching `Logo` component. `apps/web/index.html:15` references it. |

---

## 8. Deploy health

| Check | Result | Evidence |
|---|---|---|
| API listens on `process.env.PORT` + `0.0.0.0` | **PASS** | `apps/api/src/index.ts:3790–3801` `resolvePort()` reads `process.env.PORT`. `HOST = '0.0.0.0'` at `:3804`. `app.listen(PORT, HOST, ...)` at `:3927`. |
| Vercel web build succeeds, root `/` loads | **CANNOT-VERIFY** | `apps/web/vercel.json` rewrites `/(.*)` → `/index.html` (SPA fallback). `apps/web/Dockerfile` multi-stage build. `dist/` exists. Build not run during this audit; last build in session was 599.68 kB JS / 75.58 kB CSS. |
| CORS via env var, not hardcoded | **PASS** | `apps/api/src/index.ts:46–97` — `process.env.FRONTEND_ORIGIN` + `process.env.CORS_EXTRA_ORIGINS` env-driven. Localhost defaults are intentional for dev. `apps/api/.env.example:36–41` documents both. |
| No console errors on fresh page load of deployed prod | **CANNOT-VERIFY** | Requires deployed URL. Not exercised in this audit. |

---

## 9. End-to-end fresh-account test (local + prod)

**CANNOT-VERIFY.** All 9 sub-steps require either live Neon DB or deployed prod URL, neither of which the auditor has access to. Steps are documented in the original prompt and remain to be executed manually after §1 + §6 fixes are applied.

---

## T1 (Razorpay creds singleton) status

**DEFERRED — code change not shipped.** Requires DB schema migration (`ALTER TABLE merchant_credentials ADD COLUMN workspace_id` + backfill + drop singleton constraint + change `resolveRazorpayCreds` signature + update 8 callers). Migration authored as `apps/api/migrations/2026-09-03-razorpay-workspace-scoping.sql` plus runbook in `apps/api/migrations/README.md`. Run the SQL on Neon first, then ship the code changes diffed in the README. The auditor cannot apply the migration (Neon connection string is chat-only).

---

## Verdict

**NOT READY TO SUBMIT.**

### Prioritized blockers

1. **§1 Workspace isolation (P0)** — Singleton `merchant_credentials` + singleton `merchant_settings` + `MERCHANT_WORKSPACE_ID = 'default'` constant mean every workspace reads the same Razorpay creds and the same policy. Must fix before submission if multi-merchant isolation is a requirement. Even single-tenant builds need a verified run against a fresh workspace to prove the demo data does not leak.
2. **§6 Agent Card (`/.well-known/agent.json`)** — Not implemented. `AGENT_CATALOG_DESIGN.md` overclaims capability + attribute vocabularies that the code does not implement. Either ship `/.well-known/agent.json` + add missing capabilities (`ships_international`, `has_warranty`, `negotiable`) + add missing attribute keys (`wattage_w`, `color_temp_k`, `dimmable`, `material`, `usb_charging`), or update the doc to match what's actually shipped.
3. **§9 E2E fresh-account test** — Cannot be done without DB + deployed URL. After §1 + §6 are fixed, run the 9-step checklist end-to-end on both local and prod.
4. **Hardcoded `?? 'default'` fallbacks in `apps/web/src/App.tsx:2042, :2267, :2285`** — silent null-coalescing. Backend currently 404s on these (`apps/api/src/index.ts:954, :1828`) so they're not data-corrupting today, but the fallback hides a real bug. Replace with a real `workspaceId` from session context.
5. **No real auth/session layer** (`apps/web/src/lib/api.ts:212–243`) — workspace id flows in body fields, forgeable. Acceptable for single-tenant demo; blocker for any multi-tenant claim.

### Cosmetic / non-blocking

- Favicon ✅ (this session, `apps/web/public/favicon.svg`).
- Decision-mix card ✅ (this session, outer `select-none`).
- Icon migration ✅ (Hugeicons only).
- Replit badge ✅ (absent).
- All §3, §4, §5, §7, §8 code-path checks pass.

### Items the auditor could not verify

- Live webhook HMAC against real Razorpay test mode.
- E2E checkout with `4111 1111 1111 1111`.
- Deployed-prod console errors.
- `/.well-known/agent.json` over the wire.

All of the above require the user to execute against deployed prod + a real Razorpay test account.
