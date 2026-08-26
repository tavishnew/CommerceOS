# Commerce0S API Gateway

Thin Express 5 + TypeScript gateway that normalizes calls to the Python FastAPI
supplier / retailer agents and exposes a single JSON API for the frontend.

## Prerequisites

- Node.js ≥ 18
- A Neon Postgres database with the `products` table (created by the supplier agent)
- (Optional) Supplier + retailer FastAPI services running for health checks

## Setup

```bash
cd api-server
cp .env.example .env        # then fill in DATABASE_URL
npm install
```

## Run (development)

```bash
npm run dev
```

Starts the server on **http://localhost:5000** with hot-reload via `tsx watch`.

## Run (production)

```bash
npm run build
npm start
```

## Endpoints

| Method | Path               | Description                                        |
|--------|--------------------|----------------------------------------------------|
| GET    | `/api/health`      | Health check for supplier + retailer FastAPI agents |
| GET    | `/api/catalog`     | List all products (normalized from Neon DB)         |
| GET    | `/api/catalog/:id` | Single product detail                              |
| GET    | `/api/orders`      | List orders                                        |
| POST   | `/api/orders`      | Create an order (status: `pending`)                |

### POST /api/orders body

```json
{
  "productId": 1,
  "buyerAgentId": "buyer.northstar",
  "amount": 148.00
}
```

## Typecheck

```bash
npm run typecheck
```
