# cart-service

A basic in-memory shopping cart microservice for the acme-corp demo e-commerce project. No database, no auth — carts are kept in a Map in server memory and are identified by an `x-user-id` request header (defaults to `demo-user` when the header is missing).

It depends on two sibling services for full functionality:

- **product-service** on `http://localhost:4001` — used to enrich cart lines with product name/price.
- **order-service** on `http://localhost:4003` — used on checkout to actually create the order.

If either of those isn't running, this service still responds: cart lines that can't be enriched come back as `name: "Unknown product"`, `price: 0`, and checkout fails with a `502` if order-service is unreachable.

## Run

```bash
npm install
npm start
```

Listens on `http://localhost:4002`.

## API

All routes are under `/api/cart` and operate on the cart for the `x-user-id` making the request.

- `GET /api/cart` — get the enriched cart.
- `POST /api/cart/items` — add an item (`{ productId, quantity }`), increments quantity if already in cart.
- `PUT /api/cart/items/:productId` — set exact quantity (`{ quantity }`); `0` removes the item.
- `DELETE /api/cart/items/:productId` — remove an item entirely.
- `DELETE /api/cart` — clear the whole cart.
- `POST /api/cart/checkout` — checkout the cart, creating an order via order-service. Clears the cart on success.

## Example curl commands

```bash
# Add an item to alice's cart
curl -X POST http://localhost:4002/api/cart/items \
  -H "Content-Type: application/json" \
  -H "x-user-id: alice" \
  -d '{"productId": "p1", "quantity": 2}'

# View alice's cart (enriched with product-service data if it's up)
curl http://localhost:4002/api/cart -H "x-user-id: alice"

# Change quantity
curl -X PUT http://localhost:4002/api/cart/items/p1 \
  -H "Content-Type: application/json" \
  -H "x-user-id: alice" \
  -d '{"quantity": 5}'

# Remove an item
curl -X DELETE http://localhost:4002/api/cart/items/p1 -H "x-user-id: alice"

# Clear the cart
curl -X DELETE http://localhost:4002/api/cart -H "x-user-id: alice"

# Checkout (requires order-service running on 4003)
curl -X POST http://localhost:4002/api/cart/checkout -H "x-user-id: alice"
```
