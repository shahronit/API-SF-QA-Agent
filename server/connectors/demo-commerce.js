'use strict';
/**
 * Demo Salesforce B2C Commerce Cloud simulator: OCAPI Shop + SCAPI Shopper
 * (products, search, baskets, SLAS token). Behaviour is labelled ASSUMED.
 */
const crypto = require('node:crypto');

const PRODUCTS = [
  { id: 'apple-iphone-15', name: 'iPhone 15', brand: 'Apple', price: 799, currency: 'USD', inventory: 42, c_color: 'Black' },
  { id: 'sony-wh-1000xm5', name: 'WH-1000XM5', brand: 'Sony', price: 349, currency: 'USD', inventory: 18, c_color: 'Silver' },
  { id: 'globex-hoodie', name: 'Globex Hoodie', brand: 'Globex', price: 59, currency: 'USD', inventory: 200, c_color: 'Navy' },
];

function id18(prefix) {
  return prefix + crypto.randomBytes(8).toString('hex').slice(0, 16);
}

class DemoCommerce {
  constructor(project) {
    this.project = project;
    this.kind = 'demo-commerce';
    this.baskets = new Map();
    const c = (project.integrationConfig && project.integrationConfig.commerce) || {};
    this.siteId = c.siteId || 'RefArch';
    this.orgId = c.orgId || 'f_ecom_zzte_001';
    this.ocapiVersion = c.ocapiVersion || 'v24_5';
    this.shortCode = c.shortCode || 'demo';
  }

  get available() { return true; }

  unavailableExplanation() {
    return { code: 'COMMERCE_DEMO', title: 'Commerce Cloud demo simulator is available.', category: 'configuration', evidence: [] };
  }

  async testConnection() {
    return {
      ok: true, kind: 'demo-commerce', siteId: this.siteId, orgId: this.orgId,
      ocapiVersion: this.ocapiVersion, products: PRODUCTS.length, label: 'ASSUMED (demo storefront)',
      catalog: await this.fetchCatalogSample(),
    };
  }

  async fetchCatalogSample() {
    const p = PRODUCTS[0];
    return { productId: p.id, productName: p.name, source: 'demo', siteId: this.siteId };
  }

  ocapiProduct(p) {
    return { _type: 'product', id: p.id, name: { default: p.name }, brand: p.brand, currency: p.currency, price: p.price, inventory: { orderable: p.inventory > 0, stock_level: p.inventory }, c_color: p.c_color };
  }

  scapiProduct(p) {
    return { id: p.id, name: p.name, brand: p.brand, currency: p.currency, price: p.price, inventory: { orderable: p.inventory > 0, stockLevel: p.inventory }, representedProduct: { id: p.id } };
  }

  json(status, body, extra = {}) {
    return {
      status, statusText: status === 200 || status === 201 ? 'OK' : 'Error',
      headers: { 'content-type': 'application/json;charset=UTF-8', ...extra.headers },
      body, text: JSON.stringify(body), timeMs: extra.timeMs || 12, sizeBytes: JSON.stringify(body).length,
      url: extra.url || '', correlationId: 'demo-sfcc-' + crypto.randomBytes(4).toString('hex'),
    };
  }

  fault(status, type, message) {
    return this.json(status, { _type: 'fault', type, message, arguments: { status } });
  }

  findProduct(id) {
    return PRODUCTS.find((p) => p.id === id);
  }

  /**
   * @param {object} r { method, path, headers, query, body, bodyRaw, auth }
   */
  async request(r) {
    const method = String(r.method || 'GET').toUpperCase();
    let path = String(r.path || '');
    try { if (/^https?:\/\//i.test(path)) path = new URL(path).pathname + (new URL(path).search || ''); } catch { /* keep */ }
    const q = { ...(r.query || {}) };
    const u = new URL('https://demo.commerce' + (path.startsWith('/') ? path : '/' + path));
    for (const [k, v] of u.searchParams) if (q[k] === undefined) q[k] = v;
    path = u.pathname;
    const auth = r.auth || 'default';
    const started = performance.now();
    const wrap = (res) => ({ ...res, timeMs: Math.max(1, Math.round(performance.now() - started)), url: `https://demo-commerce.example.com${path}` });

    if (auth === 'none' && !/oauth2\/(access_token|token)$/i.test(path)) {
      return wrap(this.json(401, { error: 'invalid_token', error_description: 'Missing Authorization header.' }));
    }
    if (auth === 'invalid') {
      return wrap(this.json(401, { error: 'invalid_token', error_description: 'The access token is invalid.' }));
    }

    if (method === 'POST' && /oauth2\/(access_token|token)$/i.test(path)) {
      return wrap(this.json(200, { access_token: 'demo-sfcc-token', token_type: 'Bearer', expires_in: 1800, id_token: 'demo' }));
    }

    let m;
    if ((m = path.match(/\/dw\/shop\/[^/]+\/products\/([^/]+)$/)) && method === 'GET') {
      const p = this.findProduct(decodeURIComponent(m[1]));
      if (!p) return wrap(this.fault(404, 'ProductNotFoundException', `No product with id ${m[1]}.`));
      return wrap(this.json(200, this.ocapiProduct(p)));
    }
    if (/\/dw\/shop\/[^/]+\/product_search$/.test(path) && method === 'GET') {
      const term = String(q.q || '').toLowerCase();
      const hits = PRODUCTS.filter((p) => !term || p.name.toLowerCase().includes(term) || p.id.includes(term) || p.brand.toLowerCase().includes(term));
      return wrap(this.json(200, { _type: 'product_search_result', count: hits.length, hits: hits.map((p) => ({ _type: 'product_search_hit', product_id: p.id, product_name: p.name, price: p.price })) }));
    }
    if (/\/dw\/shop\/[^/]+\/baskets$/.test(path) && method === 'POST') {
      const id = id18('bsk');
      const basket = { _type: 'basket', basket_id: id, currency: 'USD', product_items: [], product_sub_total: 0, order_total: 0 };
      this.baskets.set(id, basket);
      return wrap(this.json(200, basket));
    }
    if ((m = path.match(/\/dw\/shop\/[^/]+\/baskets\/([^/]+)\/items$/)) && method === 'POST') {
      const basket = this.baskets.get(m[1]);
      if (!basket) return wrap(this.fault(404, 'BasketNotFoundException', 'Unknown basket.'));
      const body = r.body || {};
      const pid = body.product_id || body.productId;
      const p = this.findProduct(pid);
      if (!p) return wrap(this.fault(400, 'ProductNotFoundException', `No product with id ${pid}.`));
      const qty = Number(body.quantity || 1);
      if (!(qty > 0)) return wrap(this.fault(400, 'InvalidParameterException', 'quantity must be greater than zero.'));
      basket.product_items.push({ _type: 'product_item', item_id: id18('itm'), product_id: p.id, product_name: p.name, quantity: qty, price: p.price, price_after_item_discount: p.price * qty });
      basket.product_sub_total = basket.product_items.reduce((s, i) => s + i.price_after_item_discount, 0);
      basket.order_total = basket.product_sub_total;
      return wrap(this.json(200, basket));
    }
    if ((m = path.match(/\/dw\/shop\/[^/]+\/baskets\/([^/]+)$/)) && method === 'GET') {
      const basket = this.baskets.get(m[1]);
      if (!basket) return wrap(this.fault(404, 'BasketNotFoundException', 'Unknown basket.'));
      return wrap(this.json(200, basket));
    }

    if ((m = path.match(/\/product\/shopper-products\/v1\/organizations\/[^/]+\/products\/([^/]+)$/)) && method === 'GET') {
      const ids = decodeURIComponent(m[1]).split(',').map((s) => s.trim());
      const found = ids.map((id) => this.findProduct(id)).filter(Boolean);
      if (!found.length) return wrap(this.json(404, { title: 'Product Not Found', type: 'https://api.commercecloud.salesforce.com/documentation/error/v1/errors/product-not-found' }));
      const data = found.map((p) => this.scapiProduct(p));
      return wrap(this.json(200, ids.length === 1 ? data[0] : { data }));
    }
    if (/\/search\/shopper-search\/v1\/organizations\/[^/]+\/product-search$/.test(path) && (method === 'GET' || method === 'POST')) {
      const term = String((r.body && (r.body.q || r.body.query)) || q.q || '').toLowerCase();
      const hits = PRODUCTS.filter((p) => !term || p.name.toLowerCase().includes(term) || p.brand.toLowerCase().includes(term) || p.id.includes(term));
      return wrap(this.json(200, { limit: hits.length, total: hits.length, hits: hits.map((p) => ({ representedProduct: { id: p.id }, productId: p.id, productName: p.name, currency: p.currency, price: p.price })) }));
    }
    if (/\/checkout\/shopper-baskets\/v1\/organizations\/[^/]+\/baskets$/.test(path) && method === 'POST') {
      const id = id18('bsk');
      const basket = { basketId: id, currency: 'USD', productItems: [], productSubTotal: 0, orderTotal: 0 };
      this.baskets.set(id, basket);
      return wrap(this.json(200, basket));
    }
    if ((m = path.match(/\/checkout\/shopper-baskets\/v1\/organizations\/[^/]+\/baskets\/([^/]+)\/items$/)) && method === 'POST') {
      const basket = this.baskets.get(m[1]);
      if (!basket) return wrap(this.json(404, { title: 'Basket Not Found' }));
      const body = r.body || {};
      const pid = body.productId || (Array.isArray(body) ? body[0] && body[0].productId : null);
      const p = this.findProduct(pid);
      if (!p) return wrap(this.json(400, { title: 'Product Not Found' }));
      const qty = Number(body.quantity || 1);
      const items = basket.productItems || basket.product_items;
      items.push({ itemId: id18('itm'), productId: p.id, quantity: qty, price: p.price });
      if (basket.productItems) {
        basket.productSubTotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
        basket.orderTotal = basket.productSubTotal;
      }
      return wrap(this.json(200, basket));
    }

    return wrap(this.json(404, { title: 'Not Found', detail: `${method} ${path} is not implemented in the Commerce Cloud demo simulator.` }));
  }
}

module.exports = { DemoCommerce, PRODUCTS };
