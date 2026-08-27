const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:5000';

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
}

// ── Fetch helpers ───────────────────────────────────────────────────────────

/**
 * Shared fetch wrapper. Detects:
 *   - server unreachable (TypeError on fetch) → NetworkUnreachableError
 *   - JSON error body with `{ error: { code, message } }` → ApiError
 *   - bare string error body (`{ error: "..." }`) → ApiError with INTERNAL_ERROR
 *   - non-OK with no body → ApiError
 */
async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
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

export function fetchProduct(id: number): Promise<Product> {
  return apiFetch<Product>(`/api/catalog/${id}`);
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

export function disputeOrder(orderId: number, reason: string): Promise<DisputedOrder> {
  return apiFetch<DisputedOrder>(`/api/orders/${orderId}/dispute`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function refundOrder(orderId: number): Promise<{ order: RefundedOrder; refundId: string }> {
  return apiFetch<{ order: RefundedOrder; refundId: string }>(`/api/orders/${orderId}/refund`, {
    method: 'POST',
  });
}

// ── Orders ──────────────────────────────────────────────────────────────────

export function fetchOrders(): Promise<Order[]> {
  return apiFetch<Order[]>('/api/orders');
}

export function fetchOrder(id: number): Promise<Order> {
  return apiFetch<Order>(`/api/orders/${id}`);
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

// ── Buyer query / trace ────────────────────────────────────────────────────

export interface TraceStep {
  label: string;
  detail: string;
  timestamp: string;
}

export interface BuyerQueryResult {
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
}

export interface BuyerQueryResponse {
  sessionId: string;
  steps: TraceStep[];
  result: BuyerQueryResult;
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
 * Open an SSE connection to stream trace steps for a session.
 * Calls `onStep` for each step, `onDone` when the trace completes,
 * and `onError` if the connection fails.
 */
export function subscribeTrace(
  sessionId: string,
  onStep: (step: TraceStep) => void,
  onDone: (result: BuyerQueryResult) => void,
  onError: (err: Event) => void,
): () => void {
  const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:5000';
  const es = new EventSource(`${API_BASE}/api/buyer/trace/${sessionId}`);

  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.label === '__done') {
        onDone(data.result);
        es.close();
      } else {
        onStep(data as TraceStep);
      }
    } catch {
      // ignore parse errors
    }
  };

  es.onerror = onError;

  return () => es.close();
}

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

export function verifyOrder(orderId: number): Promise<Order> {
  return apiFetch<Order>(`/api/checkout/verify/${orderId}`);
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
    limit?: number;
    offset?: number;
  } = {},
): Promise<AuditResponse> {
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.action) qs.set('action', params.action);
  if (params.outcome) qs.set('outcome', params.outcome);
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
  keyId: string | null;
  configured: boolean;
  source: 'merchant_row' | 'env_fallback' | 'none';
  updatedAt: string | null;
}

export function fetchRazorpaySettings(): Promise<RazorpaySettings> {
  return apiFetch<RazorpaySettings>('/api/settings/razorpay');
}

export function saveRazorpaySettings(data: {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}): Promise<{ keyId: string; configured: boolean }> {
  return apiFetch<{ keyId: string; configured: boolean }>('/api/settings/razorpay', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
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
