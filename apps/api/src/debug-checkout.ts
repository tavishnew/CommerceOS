const BASE = 'http://127.0.0.1:5000';
const wsId = 'ws_dbg_' + Date.now();
interface CatalogProduct {
  id: number;
  name: string;
}
interface Basket {
  id: string;
}
interface CheckoutStart {
  orderId?: string;
  razorpayOrderId?: string;
  [k: string]: unknown;
}
const prod = (await (await fetch(BASE + '/api/catalog')).json()) as CatalogProduct[];
console.log('catalog count', prod.length);
const p = prod[0];
console.log('using product', p.id, p.name);
const b = (await (await fetch(BASE + '/api/baskets', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ workspaceId: wsId, productId: p.id }),
})).json()) as Basket;
console.log('basket', b);
const s = (await (await fetch(BASE + '/api/checkout/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ basketId: b.id, workspaceId: wsId }),
})).json()) as CheckoutStart;
console.log('start', s);
