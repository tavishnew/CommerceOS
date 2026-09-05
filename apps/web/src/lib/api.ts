// VITE_API_URL is the single source of truth. The dev fallback to
// http://localhost:5000 is intentional for `pnpm dev` on a developer
// machine without a shared dev environment. Any build intended for the
// shared demo MUST set VITE_API_URL at build time so the browser hits the
// shared API origin (not loopback, which Chrome's PNA will block from a
// public-origin page).
const FALLBACK_API_URL = 'http://localhost:5000';
const API_BASE = (import.meta.env.VITE_API_URL ?? FALLBACK_API_URL).replace(
  /\/$/,
  '',
);

// ── Workspace bootstrap ────────────────────────────────────────────────────

/** Designated demo email (server-defined, configurable via VITE_DEMO_ACCOUNT_EMAIL).
 *  Matches are routed to the demo workspace; no other user sees that data. */
export const DEMO_ACCOUNT_EMAIL = (
  import.meta.env.VITE_DEMO_ACCOUNT_EMAIL ?? 'tavish350@gmail.com'
).toLowerCase().trim();

/** Frontend check only — the server enforces. Never trust this for authorization. */
export function isDemoAccount(email: string | null | undefined): boolean {
  if (!email) return false;
  return email.toLowerCase().trim() === DEMO_ACCOUNT_EMAIL;
}

const WS_KEY = 'commerce0s.buyerWorkspaceId';
const MERCHANT_WS_KEY = 'commerce0s.merchantWorkspaceId';
const EMAIL_KEY = 'commerce0s.buyerEmail';
const BOOTSTRAPPED_KEY = 'commerce0s.buyerBootstrapped';

export interface BootstrapResponse {
  workspaceId: string;
  isDemo: boolean;
  email: string | null;
  merchantWorkspaceId: string;
}

function read<T>(key: string): T | null {
  if (typeof localStorage === 'undefined') return null;
  const v = localStorage.getItem(key);
  return v ? (JSON.parse(v) as T) : null;
}

function write(key: string, value: unknown): void {
  if (typeof localStorage === 'undefined') return;
  if (value === null || value === undefined) {
    localStorage.removeItem(key);
  } else {
    localStorage.setItem(key, JSON.stringify(value));
  }
}

/** Local fallback before the server has confirmed the workspace. The server
 *  re-assigns this on first call so the email-vs-id mismatch resolves there. */
export function getOrCreateBuyerWorkspaceId(): string {
  let ws = typeof localStorage !== 'undefined' ? localStorage.getItem(WS_KEY) : null;
  if (!ws) {
    ws = crypto.randomUUID().replace(/-/g, '');
    if (typeof localStorage !== 'undefined') localStorage.setItem(WS_KEY, ws);
  }
  return ws;
}

export function getStoredBuyerEmail(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(EMAIL_KEY);
}

export function setStoredBuyerEmail(email: string | null): void {
  if (typeof localStorage === 'undefined') return;
  if (!email) {
    localStorage.removeItem(EMAIL_KEY);
  } else {
    localStorage.setItem(EMAIL_KEY, email.toLowerCase().trim());
  }
}

/** Idempotent. Server returns the canonical workspaceId for the (caller-supplied
 *  email) pair — and the demo flag. The browser may send a candidate workspaceId
 *  but the server decides what to keep; this prevents the browser from
 *  self-assigning into the demo workspace. */
export async function bootstrapSession(
  email: string | null,
): Promise<BootstrapResponse> {
  const candidate = getOrCreateBuyerWorkspaceId();
  // `${API_BASE}/api/bootstrap` resolves to the API origin configured at
  // build time via VITE_API_URL. When that env var is not set (e.g. a
  // Vercel project that forgot to configure it), API_BASE falls back to
  // `http://localhost:5000` and the browser would attempt a cross-origin
  // POST to a host that is not the same-origin web app. We catch that
  // distinctly so the user sees a clear message instead of a raw 405 /
  // network error in the console.
  if (!API_BASE) {
    throw new ApiError('API base URL is not configured.', {
      code: 'API_BASE_MISSING',
      status: 0,
    });
  }
  const res = await fetch(`${API_BASE}/api/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, candidateWorkspaceId: candidate }),
  });
  const body = (await res.json().catch(() => null)) as BootstrapResponse | null;
  if (!res.ok || !body) {
    throw new ApiError('Could not initialise your session.', {
      code: 'BOOTSTRAP_FAILED',
      status: res.status,
    });
  }
  // Validate the response shape. The server contract is a strict
  // BootstrapResponse; an unexpected body (e.g. an HTML 405 page parsed
  // loosely, or a proxy/gateway error masquerading as JSON) must not
  // propagate to the rest of the app where a missing workspaceId
  // would crash downstream consumers that call .length / .trim on it.
  if (
    typeof body.workspaceId !== 'string' ||
    typeof body.merchantWorkspaceId !== 'string' ||
    typeof body.isDemo !== 'boolean'
  ) {
    throw new ApiError('Bootstrap response was malformed.', {
      code: 'BOOTSTRAP_MALFORMED',
      status: res.status,
    });
  }
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(WS_KEY, body.workspaceId);
    localStorage.setItem(MERCHANT_WS_KEY, body.merchantWorkspaceId);
    setStoredBuyerEmail(body.email ?? null);
    localStorage.setItem(BOOTSTRAPPED_KEY, '1');
  }
  return body;
}

/** Read the merchant workspace id persisted from /api/bootstrap. Returns
 *  null until the first successful bootstrap, or after the user signed out. */
export function getStoredMerchantWorkspaceId(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(MERCHANT_WS_KEY);
}

/** Clears the merchant workspace id from localStorage. Called on sign-out
 *  so the next /api/bootstrap can overwrite it with the new email's id. */
export function clearStoredMerchantWorkspaceId(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(MERCHANT_WS_KEY);
}

// ── Errors ──────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly cause?: unknown;

  constructor(message: string, opts: { code?: string; status?: number; cause?: unknown } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = opts.code ?? 'UNKNOWN';
    this.status = opts.status ?? 0;
    this.cause = opts.cause;
  }
}

export class NetworkUnreachableError extends ApiError {
  constructor(cause?: unknown) {
    super("Can't reach the server — check your connection and try again.", {
      code: 'NETWORK_UNREACHABLE',
      status: 0,
      cause,
    });
    this.name = 'NetworkUnreachableError';
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface Product {
  id: number;
  name: string;
  sku: string;
  price: number;
  currency: string;
  inStock: boolean;
  quantity: number;
  sellerId: string;
  description?: string | null;
  imageLink?: string | null;
  brand?: string | null;
  category?: string | null;
  status?: string;
  createdAt?: string | null;
  negotiation?: {
    negotiable: boolean;
    min_price: number | null;
    currency: string;
    bulk_tiers: Array<{ min_quantity: number; unit_price: number }> | null;
  } | null;
}

export interface Order {
  id: number;
  product_id: number;
  product_name: string | null;
  product_sku: string | null;
  buyer_agent_id: string;
  amount: number;
  status: string;
  created_at: string;
  transaction_id?: string | null;
  workspace_id?: string | null;
  human_approved_at?: string | null;
  dispute_reason?: string | null;
  razorpay_payment_id?: string | null;
  razorpay_refund_id?: string | null;
  razorpay_refund_amount?: number | null;
}

// ── Fetch helpers ───────────────────────────────────────────────────────────

/**
 * Shared fetch wrapper. Detects:
 *   - server unreachable (TypeError on fetch) → NetworkUnreachableError
 *   - JSON error body with `{ error: { code, message } }` → ApiError
 *   - bare string error body (`{ error: "..." }`) → ApiError with INTERNAL_ERROR
 *   - non-OK with no body → ApiError
 */
async function apiFetch<T>(path: string, init?: RequestInit & { __public?: boolean }): Promise<T> {
  const isPublic = init?.__public === true;
  const merchantWs = isPublic ? null : getStoredMerchantWorkspaceId();
  // Buyer-side identity headers for the agent surface. The negotiate
  // route resolves the caller's buyer workspace from these — see
  // apps/api/src/agent-catalog.ts resolveCallerBuyerWorkspace. Both
  // must be present; the server cross-checks them.
  const buyerEmail = isPublic ? null : getStoredBuyerEmail();
  const buyerWs = isPublic ? null : getOrCreateBuyerWorkspaceId();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(merchantWs ? { 'X-Merchant-Workspace-Id': merchantWs } : {}),
    ...(buyerEmail ? { 'x-buyer-email': buyerEmail } : {}),
    ...(buyerWs ? { 'x-buyer-workspace-id': buyerWs } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
    });
  } catch (err) {
    throw new NetworkUnreachableError(err);
  }

  if (res.status === 204) return undefined as T;

  // Always try to parse the body, even on errors.
  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const errField = body?.error;
    if (errField && typeof errField === 'object' && 'message' in errField) {
      throw new ApiError(String(errField.message), {
        code: String(errField.code ?? 'INTERNAL_ERROR'),
        status: res.status,
      });
    }
    if (typeof errField === 'string') {
      throw new ApiError(errField, { code: 'INTERNAL_ERROR', status: res.status });
    }
    throw new ApiError(`API error ${res.status}`, { code: 'INTERNAL_ERROR', status: res.status });
  }

  return body as T;
}

// ── Catalog ─────────────────────────────────────────────────────────────────

export function fetchCatalog(): Promise<Product[]> {
  return apiFetch<Product[]>('/api/catalog');
}
export function createProduct(
  data: Pick<Product, 'name' | 'sku'> & { price: number; quantity: number },
): Promise<Product> {
  return apiFetch<Product>('/api/catalog', {
    method: 'POST',
    body: JSON.stringify({
      name: data.name,
      sku: data.sku,
      price: data.price,
      stock: data.quantity,
    }),
  });
}

export function updateProduct(
  id: number,
  data: Partial<Pick<Product, 'name' | 'sku' | 'status'> & { price: number; quantity: number }>,
): Promise<Product> {
  return apiFetch<Product>(`/api/catalog/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: data.name,
      sku: data.sku,
      price: data.price,
      stock: data.quantity,
      status: data.status,
    }),
  });
}

export function deleteProduct(id: number): Promise<void> {
  return apiFetch<void>(`/api/catalog/${id}`, { method: 'DELETE' });
}

// ── Disputes / refunds (Stage 10 / C) ─────────────────────────────────────

export interface DisputedOrder {
  id: number;
  status: 'disputed' | 'refunded';
  dispute_reason: string;
}

export interface RefundedOrder {
  id: number;
  status: 'refunded';
  razorpay_refund_id: string;
}

export function disputeOrder(
  orderId: number,
  reason: string,
  workspaceId: string,
): Promise<DisputedOrder> {
  return apiFetch<DisputedOrder>(`/api/orders/${orderId}/dispute`, {
    method: 'POST',
    body: JSON.stringify({ reason, workspaceId }),
  });
}

export function refundOrder(
  orderId: number,
  workspaceId: string,
): Promise<{ order: RefundedOrder; refundId: string }> {
  return apiFetch<{ order: RefundedOrder; refundId: string }>(`/api/orders/${orderId}/refund`, {
    method: 'POST',
    body: JSON.stringify({ workspaceId }),
  });
}

// ── Orders ──────────────────────────────────────────────────────────────────

export function fetchOrders(): Promise<Order[]> {
  return apiFetch<Order[]>('/api/orders');
}

export function fetchOrder(id: number, opts: { expand?: boolean } = {}): Promise<Order> {
  const qs = opts.expand ? '?expand=true' : '';
  return apiFetch<Order>(`/api/orders/${id}${qs}`);
}

export function createOrder(data: {
  productId: number;
  buyerAgentId: string;
  amount: number;
}): Promise<Order> {
  return apiFetch<Order>('/api/orders', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ── Baskets + checkout ─────────────────────────────────────────────────────

export interface BasketItem {
  productId: number;
  priceAtAdd: number;
  name?: string;
  negotiatedUnitPrice?: number | null;
  negotiationTxnId?: string | null;
}

export interface Basket {
  id: string;
  workspaceId: string;
  txnId: string;
  items: BasketItem[];
  subtotal: number;
  currency: 'INR';
  status: 'open' | 'checked_out' | 'expired';
}

export interface NegotiateOptions {
  negotiatedUnitPrice?: number;
  negotiationTxnId?: string;
}

export function createBasket(
  workspaceId: string,
  productId: number,
  opts: NegotiateOptions = {},
): Promise<Basket> {
  return apiFetch<Basket>('/api/baskets', {
    method: 'POST',
    body: JSON.stringify({ workspaceId, productId, ...opts }),
  });
}

export type NegotiationDecision =
  | 'accept'
  | 'counter'
  | 'reject'
  | 'counter_quote_required';

export interface NegotiationResult {
  decision: NegotiationDecision;
  sku: string;
  quantity: number;
  unit_price: number | null;
  total: number | null;
  currency: string;
  expires_at: string;
  reason: string;
  merchant_workspace: string;
  negotiation_txn_id: string | null;
}

export function negotiateSeller(input: {
  sku: string;
  quantity: number;
  proposedUnitPrice: number;
  currency: string;
}): Promise<{ schema_version: string; data: NegotiationResult }> {
  return apiFetch<{ schema_version: string; data: NegotiationResult }>(
    '/agent/seller/negotiate',
    {
      method: 'POST',
      body: JSON.stringify({
        sku: input.sku,
        quantity: input.quantity,
        proposed_unit_price: input.proposedUnitPrice,
        currency: input.currency,
      }),
    },
  );
}

export function addBasketItem(
  workspaceId: string,
  basketId: string,
  productId: number,
): Promise<Basket> {
  return apiFetch<Basket>(`/api/baskets/${basketId}/items`, {
    method: 'POST',
    body: JSON.stringify({ workspaceId, productId }),
  });
}

export function loadBasket(workspaceId: string, basketId: string): Promise<Basket> {
  return apiFetch<Basket>(`/api/baskets/${basketId}?workspaceId=${encodeURIComponent(workspaceId)}`);
}

export interface CheckoutStartPolicy {
  decision: 'auto_approved' | 'human_approval_required' | 'no_match';
  amount: number;
  buyer: { limit: number | null; exceeded: boolean };
  merchant: { limit: number; exceeded: boolean };
  triggeredBy: Array<'buyer_ceiling' | 'merchant_ceiling'>;
  ceilingSource: 'buyer_ceiling' | 'merchant_ceiling' | 'both' | 'none';
  requiresHumanApproval: boolean;
  reasons: string[];
}

export interface CheckoutStartResponse {
  orderId: number;
  transactionId: string;
  razorpayOrderId: string | null;
  amount: number;
  currency: string;
  keyId: string;
  policy: CheckoutStartPolicy;
  evidence: string;
  // True when the policy required a human override; the order is in
  // pending_human_review. The frontend must call
  // /api/checkout/human-approve/:orderId to mint the Razorpay order.
  requiresHumanApproval?: boolean;
}

export function startCheckout(data: {
  basketId: string;
  workspaceId: string;
}): Promise<CheckoutStartResponse> {
  return apiFetch<CheckoutStartResponse>('/api/checkout/start', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export interface HumanApproveResponse {
  id: number;
  status: string;
  amount: number;
  razorpayOrderId: string | null;
  keyId: string | null;
  currency: string;
  transaction_id: string | null;
  workspace_id: string | null;
}
export function humanApproveCheckout(orderId: number): Promise<HumanApproveResponse> {
  return apiFetch<HumanApproveResponse>(`/api/checkout/human-approve/${orderId}`, {
    method: 'POST',
  });
}

// ── Buyer session + buyer orders ───────────────────────────────────────────

export interface BuyerSession {
  workspaceId: string;
  maxSpend: number | null;
  autonomy: 'recommend_only' | 'ask_before' | 'auto_up_to_limit';
}

export function fetchBuyerSession(workspaceId: string): Promise<BuyerSession> {
  return apiFetch<BuyerSession>(`/api/buyer/session?workspaceId=${encodeURIComponent(workspaceId)}`);
}

export function updateBuyerSession(data: {
  workspaceId: string;
  maxSpend?: number | null;
  autonomy?: BuyerSession['autonomy'];
}): Promise<BuyerSession> {
  return apiFetch<BuyerSession>('/api/buyer/session', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function fetchBuyerOrders(workspaceId: string): Promise<Order[]> {
  return apiFetch<Order[]>(`/api/buyer/orders?workspaceId=${encodeURIComponent(workspaceId)}`);
}

// ── Activity feed + transaction detail ────────────────────────────────────

export interface ActivityRow {
  id: number;
  timestamp: string;
  actor: string;
  action: string;
  detail: string | null;
  amount: number | null;
  outcome: string;
}

export function fetchActivity(
  limit = 12,
  workspaceId?: string,
  opts: { publicView?: boolean } = {},
): Promise<ActivityRow[]> {
  const qs = new URLSearchParams();
  qs.set('limit', String(limit));
  if (workspaceId) qs.set('workspaceId', workspaceId);
  return apiFetch<ActivityRow[]>(`/api/activity?${qs.toString()}`, {
    __public: opts.publicView === true,
  });
}

export interface TransactionDetail {
  transactionId: string;
  orders?: Order[];
  audit?: Array<ActivityRow & { transaction_id: string | null; workspace_id: string | null }>;
}

export function fetchTransactionDetail(txnId: string): Promise<TransactionDetail> {
  return apiFetch<TransactionDetail>(`/api/transactions/${encodeURIComponent(txnId)}`);
}

// ── Buyer query / trace ────────────────────────────────────────────────────

export interface TraceStep {
  label: string;
  detail: string;
  timestamp: string;
}

export interface BuyerQueryResult {
  matched: boolean;
  recommendedProduct: Product | null;
  confidence: number;
  policyResult: string;
  dataSource?: string;
  exceededCeiling?: 'merchant' | 'buyer' | 'both' | null;
  suggestions?: Array<{
    id: number;
    name: string;
    price: number;
    reason: string;
    category: string | null;
  }>;
  policy?: CheckoutStartPolicy | null;
}

export interface BuyerQueryResponse {
  sessionId: string;
  steps: TraceStep[];
  result: BuyerQueryResult;
  evidence?: string;
}

export function submitBuyerQuery(
  prompt: string,
  opts: { maxSpend?: number } = {},
): Promise<BuyerQueryResponse> {
  return apiFetch<BuyerQueryResponse>('/api/buyer/query', {
    method: 'POST',
    body: JSON.stringify({ prompt, maxSpend: opts.maxSpend }),
  });
}

export interface UpsellAcceptResponse {
  combinedTotal: number;
  policyResult: 'auto_approved' | 'human_approval_required';
  exceededCeiling: 'merchant' | 'buyer' | 'both' | null;
  merchantCap: number;
  buyerCap: number | null;
  policy?: CheckoutStartPolicy | null;
}

export function acceptUpsell(data: {
  sessionId: string;
  suggestionId: number;
  primaryProductId: number;
  buyerMaxSpend?: number;
}): Promise<UpsellAcceptResponse> {
  return apiFetch<UpsellAcceptResponse>('/api/buyer/upsell/accept', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/**
 * Trace steps are returned in the POST /api/buyer/query response; no SSE.
 * The /buyer/trace page reads `result.steps` from the cached query result.
 */

// ── Settings ───────────────────────────────────────────────────────────────

export interface MerchantSettings {
  merchantId: string;
  maxAutoApprove: number;
  requireHumanAboveCap: boolean;
}

export function fetchSettings(): Promise<MerchantSettings> {
  return apiFetch<MerchantSettings>('/api/settings');
}

export function updateSettings(
  data: Partial<Pick<MerchantSettings, 'maxAutoApprove' | 'requireHumanAboveCap'>>,
): Promise<MerchantSettings> {
  return apiFetch<MerchantSettings>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function humanApproveOrder(orderId: number): Promise<Order> {
  return apiFetch<Order>(`/api/checkout/human-approve/${orderId}`, { method: 'POST' });
}

// ── Checkout ──────────────────────────────────────────────────────────────

export interface CreateOrderResponse {
  razorpayOrderId: string;
  amount: number;
  currency: string;
  keyId: string;
}

export function createRazorpayOrder(data: {
  orderId: number;
  amount: number;
  currency?: string;
}): Promise<CreateOrderResponse> {
  return apiFetch<CreateOrderResponse>('/api/checkout/create-order', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function verifyOrder(orderId: number, workspaceId?: string): Promise<Order> {
  const ws = workspaceId?.trim() || '';
  const qs = ws ? `?workspaceId=${encodeURIComponent(ws)}` : '';
  return apiFetch<Order>(`/api/checkout/verify/${orderId}${qs}`);
}

// ── Audit log ──────────────────────────────────────────────────────────────

export interface AuditRow {
  id: number;
  timestamp: string;
  session_id: string | null;
  actor: string;
  action: string;
  detail: string | null;
  amount: number | null;
  outcome: string;
  transaction_id?: string | null;
  workspace_id?: string | null;
  policy?: CheckoutStartPolicy | null;
}

export interface AuditResponse {
  rows: AuditRow[];
  total: number;
  limit: number;
  offset: number;
}

export function fetchAudit(
  params: {
    from?: string;
    to?: string;
    action?: string;
    outcome?: string;
    transactionId?: string;
    workspaceId?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<AuditResponse> {
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.action) qs.set('action', params.action);
  if (params.outcome) qs.set('outcome', params.outcome);
  if (params.transactionId) qs.set('transactionId', params.transactionId);
  if (params.workspaceId) qs.set('workspaceId', params.workspaceId);
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.offset) qs.set('offset', String(params.offset));
  const q = qs.toString();
  return apiFetch<AuditResponse>(`/api/audit${q ? '?' + q : ''}`);
}

export function exportAudit(
  params: { from?: string; to?: string; action?: string; outcome?: string } = {},
): Promise<AuditRow[]> {
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.action) qs.set('action', params.action);
  if (params.outcome) qs.set('outcome', params.outcome);
  const q = qs.toString();
  return apiFetch<AuditRow[]>(`/api/audit/export${q ? '?' + q : ''}`);
}

// ── Debug helpers ────────────────────────────────────────────────────────

export interface DebugStatus {
  simulateSupplierFailure: boolean;
  catalogCacheSize: number;
  catalogCacheTime: string | null;
}

export function fetchDebugStatus(): Promise<DebugStatus> {
  return apiFetch<DebugStatus>('/api/debug/status');
}

export function toggleDebugFailure(enabled: boolean): Promise<DebugStatus> {
  return apiFetch<DebugStatus>('/api/debug/simulate-failure', {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
}

// ── Razorpay settings (merchant-configured credentials) ──────────────────

export interface RazorpaySettings {
  configured: boolean;
  mode: 'test' | 'live' | null;
  keyIdMasked: string | null;
  source: 'merchant_row' | 'none';
  envFallbackAvailable: boolean;
  updatedAt: string | null;
}

export function fetchRazorpaySettings(): Promise<RazorpaySettings> {
  return apiFetch<RazorpaySettings>('/api/settings/razorpay');
}

export function saveRazorpaySettings(data: {
  mode: 'test' | 'live';
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}): Promise<{ configured: boolean; mode: 'test' | 'live'; keyIdMasked: string }> {
  return apiFetch<{ configured: boolean; mode: 'test' | 'live'; keyIdMasked: string }>(
    '/api/settings/razorpay',
    { method: 'PUT', body: JSON.stringify(data) },
  );
}

export function deleteRazorpaySettings(): Promise<{ configured: boolean; envFallbackAvailable: boolean }> {
  return apiFetch<{ configured: boolean; envFallbackAvailable: boolean }>(
    '/api/settings/razorpay',
    { method: 'DELETE' },
  );
}

export interface RazorpayTestResult {
  valid: boolean;
  message: string;
}

export function testRazorpaySettings(): Promise<RazorpayTestResult> {
  return apiFetch<RazorpayTestResult>('/api/settings/razorpay/test', {
    method: 'POST',
  });
}
