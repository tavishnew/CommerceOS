// Canonical policy engine. ONE place where amount vs ceilings is decided.
// Every checkout, upsell, trace, audit row uses this — no duplicated logic.

export type CeilingSource = 'buyer_ceiling' | 'merchant_ceiling' | 'both' | 'none';
export type PolicyDecision = 'auto_approved' | 'human_approval_required' | 'no_match';

export interface PolicyContext {
  amount: number;
  buyerLimit: number | null; // null = no buyer ceiling set
  merchantLimit: number;
}

export interface PolicyResult {
  decision: PolicyDecision;
  amount: number;
  buyer: { limit: number | null; exceeded: boolean };
  merchant: { limit: number; exceeded: boolean };
  triggeredBy: Array<'buyer_ceiling' | 'merchant_ceiling'>;
  ceilingSource: CeilingSource;
  requiresHumanApproval: boolean;
  reasons: string[];
}

export function evaluateTransactionPolicy(ctx: PolicyContext): PolicyResult {
  const merchantExceeded = ctx.amount >= ctx.merchantLimit;
  const buyerExceeded = ctx.buyerLimit != null && ctx.amount > ctx.buyerLimit;

  const triggeredBy: Array<'buyer_ceiling' | 'merchant_ceiling'> = [];
  if (merchantExceeded) triggeredBy.push('merchant_ceiling');
  if (buyerExceeded) triggeredBy.push('buyer_ceiling');

  let ceilingSource: CeilingSource;
  if (merchantExceeded && buyerExceeded) ceilingSource = 'both';
  else if (merchantExceeded) ceilingSource = 'merchant_ceiling';
  else if (buyerExceeded) ceilingSource = 'buyer_ceiling';
  else ceilingSource = 'none';

  const decision: PolicyDecision =
    triggeredBy.length > 0 ? 'human_approval_required' : 'auto_approved';

  const reasons: string[] = [];
  if (decision === 'auto_approved') {
    reasons.push(
      `Amount ₹${ctx.amount.toFixed(2)} is within both ceilings (merchant ₹${ctx.merchantLimit.toFixed(2)}` +
        (ctx.buyerLimit != null ? `, buyer ₹${ctx.buyerLimit.toFixed(2)}` : '') +
        ').',
    );
  } else {
    if (merchantExceeded)
      reasons.push(
        `Amount ₹${ctx.amount.toFixed(2)} is at or above the merchant auto-approve ceiling of ₹${ctx.merchantLimit.toFixed(2)}.`,
      );
    if (buyerExceeded && ctx.buyerLimit != null)
      reasons.push(
        `Amount ₹${ctx.amount.toFixed(2)} is above your session spending limit of ₹${ctx.buyerLimit.toFixed(2)}.`,
      );
  }

  return {
    decision,
    amount: ctx.amount,
    buyer: { limit: ctx.buyerLimit, exceeded: buyerExceeded },
    merchant: { limit: ctx.merchantLimit, exceeded: merchantExceeded },
    triggeredBy,
    ceilingSource,
    requiresHumanApproval: triggeredBy.length > 0,
    reasons,
  };
}