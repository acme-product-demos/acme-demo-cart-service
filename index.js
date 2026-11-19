// cart-service
// Demo e-commerce cart microservice. In-memory only, no database, no auth.
// Node v24+ has global fetch built in, so no axios/node-fetch dependency is used.

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 4002;

// Easy to spot/change base URLs for the services this cart depends on.
// Overridable via env so CI (which only starts cart-service itself) can
// point at the deployed mocks instead of localhost.
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://localhost:4001';
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://localhost:4003';
const INVENTORY_SERVICE_URL = process.env.INVENTORY_SERVICE_URL || 'http://localhost:4004';
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://localhost:4006';

// When set (e.g. by CI), tags outbound calls to the mocks so a run's state
// stays separate from the Monitor's/manual use's. No-op when unset.
const MOCK_SESSION_HEADERS = process.env.MOCK_SESSION_ID
  ? { 'x-mock-session': process.env.MOCK_SESSION_ID }
  : {};

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'cart-service' });
});

// In-memory cart storage: userId -> [{ productId, quantity }]
const carts = new Map();

function getUserId(req) {
  return req.header('x-user-id') || 'demo-user';
}

function getCartLines(userId) {
  if (!carts.has(userId)) {
    carts.set(userId, []);
  }
  return carts.get(userId);
}

// Fetch product details from product-service for one productId.
// On any failure (service down, network error, 404, etc.) resolve to null
// so callers can fall back gracefully instead of crashing the request.
async function fetchProduct(productId) {
  try {
    const res = await fetch(`${PRODUCT_SERVICE_URL}/api/products/${productId}`, {
      headers: { ...MOCK_SESSION_HEADERS },
    });
    if (!res.ok) {
      return null;
    }
    return await res.json();
  } catch (err) {
    return null;
  }
}

// Build the enriched cart response shape for a given userId:
// { userId, items: [{ productId, name, price, quantity, subtotal }], total }
async function buildEnrichedCart(userId) {
  const lines = getCartLines(userId);

  const items = await Promise.all(
    lines.map(async (line) => {
      const product = await fetchProduct(line.productId);
      const name = product ? product.name : 'Unknown product';
      const price = product ? product.price : 0;
      const subtotal = price * line.quantity;
      return {
        productId: line.productId,
        name,
        price,
        quantity: line.quantity,
        subtotal,
      };
    })
  );

  const total = items.reduce((sum, item) => sum + item.subtotal, 0);

  return { userId, items, total };
}

const router = express.Router();

// GET /api/cart -> enriched cart for requesting user
router.get('/', async (req, res) => {
  const userId = getUserId(req);
  const cart = await buildEnrichedCart(userId);
  res.status(200).json(cart);
});

// POST /api/cart/items -> add item (increment if present)
router.post('/items', async (req, res) => {
  const userId = getUserId(req);
  const { productId, quantity } = req.body || {};

  if (!productId || typeof quantity !== 'number' || quantity < 1) {
    return res.status(400).json({ error: 'productId is required and quantity must be a number >= 1' });
  }

  const lines = getCartLines(userId);
  const existing = lines.find((l) => l.productId === productId);
  if (existing) {
    existing.quantity += quantity;
  } else {
    lines.push({ productId, quantity });
  }

  const cart = await buildEnrichedCart(userId);
  res.status(200).json(cart);
});

// PUT /api/cart/items/:productId -> set exact quantity (0 removes)
router.put('/items/:productId', async (req, res) => {
  const userId = getUserId(req);
  const { productId } = req.params;
  const { quantity } = req.body || {};

  if (typeof quantity !== 'number' || quantity < 0) {
    return res.status(400).json({ error: 'quantity must be a number >= 0' });
  }

  const lines = getCartLines(userId);
  const idx = lines.findIndex((l) => l.productId === productId);

  if (quantity === 0) {
    if (idx !== -1) lines.splice(idx, 1);
  } else if (idx !== -1) {
    lines[idx].quantity = quantity;
  } else {
    lines.push({ productId, quantity });
  }

  const cart = await buildEnrichedCart(userId);
  res.status(200).json(cart);
});

// DELETE /api/cart/items/:productId -> remove item entirely
router.delete('/items/:productId', async (req, res) => {
  const userId = getUserId(req);
  const { productId } = req.params;

  const lines = getCartLines(userId);
  const idx = lines.findIndex((l) => l.productId === productId);
  if (idx !== -1) lines.splice(idx, 1);

  const cart = await buildEnrichedCart(userId);
  res.status(200).json(cart);
});

// DELETE /api/cart -> clear whole cart
router.delete('/', async (req, res) => {
  const userId = getUserId(req);
  carts.set(userId, []);

  const cart = await buildEnrichedCart(userId);
  res.status(200).json(cart);
});

// POST /api/cart/checkout -> create order from cart via order-service
router.post('/checkout', async (req, res) => {
  const userId = getUserId(req);
  const cart = await buildEnrichedCart(userId);

  if (cart.items.length === 0) {
    return res.status(400).json({ error: 'Cart is empty' });
  }

  const orderPayload = {
    userId,
    items: cart.items.map((item) => ({
      productId: item.productId,
      name: item.name,
      price: item.price,
      quantity: item.quantity,
    })),
    total: cart.total,
  };

  // Reserve stock for every line before charging anything. Any failure here
  // (service down, insufficient stock) aborts checkout without touching the
  // cart or payment.
  for (const item of cart.items) {
    try {
      const reserveRes = await fetch(`${INVENTORY_SERVICE_URL}/api/inventory/${item.productId}/reserve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...MOCK_SESSION_HEADERS },
        body: JSON.stringify({ quantity: item.quantity }),
      });
      if (!reserveRes.ok) {
        return res.status(502).json({ error: 'Could not reserve inventory' });
      }
    } catch (err) {
      return res.status(502).json({ error: 'Could not reserve inventory' });
    }
  }

  // Charge payment for the cart total. This is the demo's usual
  // dependency-down failure mode: stop payment-service and checkout fails
  // here even though cart-service itself is up.
  let paymentTransactionId;
  try {
    const paymentRes = await fetch(`${PAYMENT_SERVICE_URL}/api/payments/charge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...MOCK_SESSION_HEADERS },
      body: JSON.stringify({ orderId: userId, amount: cart.total, method: 'card' }),
    });
    if (!paymentRes.ok) {
      const status = paymentRes.status === 402 ? 402 : 502;
      const body = await paymentRes.json().catch(() => ({}));
      return res.status(status).json({ error: body.error || 'Payment failed' });
    }
    const paymentBody = await paymentRes.json();
    paymentTransactionId = paymentBody.transactionId;
  } catch (err) {
    return res.status(502).json({ error: 'Could not reach payment service' });
  }

  try {
    const orderRes = await fetch(`${ORDER_SERVICE_URL}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...MOCK_SESSION_HEADERS },
      body: JSON.stringify({ ...orderPayload, paymentTransactionId }),
    });

    if (!orderRes.ok) {
      return res.status(502).json({ error: 'Could not create order' });
    }

    const orderBody = await orderRes.json();
    carts.set(userId, []); // clear cart only on confirmed success
    return res.status(201).json(orderBody);
  } catch (err) {
    return res.status(502).json({ error: 'Could not create order' });
  }
});

app.use('/api/cart', router);

// Basic 404 handler for unknown routes.
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`Cart service listening on http://localhost:${PORT}`);
});
