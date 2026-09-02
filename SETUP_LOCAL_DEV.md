# CommerceOS Local Development Setup

This guide walks you through setting up and running the project locally. You have two options: **Docker** (recommended) or **native** Node.js + PostgreSQL.

## Option 1: Docker Setup (Recommended)

### Prerequisites
- Docker Desktop installed
- Docker daemon running

### Quick Start
```bash
# Start all services (PostgreSQL, API, Web)
docker-compose up --build

# In another terminal, migrate the database
docker-compose exec api npm run db:migrate
```

The services will be available at:
- **API**: http://localhost:5000
- **Web**: http://localhost:5173
- **PostgreSQL**: localhost:5432

### Logs
```bash
# View all logs
docker-compose logs -f

# View specific service logs
docker-compose logs -f api
docker-compose logs -f web
docker-compose logs -f db
```

### Clean Up
```bash
# Stop services
docker-compose down

# Stop and remove volumes (deletes database)
docker-compose down -v
```

---

## Option 2: Native Local Development

### Prerequisites
- Node.js 18+ and pnpm
- PostgreSQL 16 running locally

### Step 1: Install Dependencies
```bash
# Install root dependencies
pnpm install

# Install workspace dependencies
pnpm install --recursive
```

### Step 2: Set Up Environment Variables

**API Server** - Create `.env` in `apps/api/`:
```bash
cp apps/api/.env.example apps/api/.env
```

Then edit `apps/api/.env` with your local PostgreSQL credentials:
```
DATABASE_URL=postgres://postgres:password@localhost:5432/commerce0s
ENCRYPTION_KEY=devkey-devkey-devkey-devkey-devkey-devkey01
SUPPLIER_URL=http://localhost:8080
RETAILER_URL=http://localhost:8082
PORT=5000
TEST_MODE_NO_RAZORPAY=1
```

### Step 3: Create Database
```bash
# Using psql
createdb -U postgres commerce0s

# Or using PostgreSQL admin tools
```

### Step 4: Run the Services

In separate terminals:

**Terminal 1 - API Server**:
```bash
cd apps/api
pnpm dev
# Runs on http://localhost:5000
```

**Terminal 2 - Web Dev Server**:
```bash
cd apps/web
pnpm dev
# Runs on http://localhost:5173
```

### Step 5: Verify Setup
```bash
# Check API health
curl http://localhost:5000/health

# Open web app
open http://localhost:5173
```

---

## Environment Setup Summary

### Database Setup
- **PostgreSQL**: 5432 (local) or via Docker
- **Database name**: commerce0s
- **User**: commerce (Docker) or postgres (local)
- **Password**: commerce (Docker) or your password (local)

### Required Environment Variables (for local dev)
```bash
DATABASE_URL=postgres://[user]:[password]@localhost:5432/commerce0s
ENCRYPTION_KEY=devkey-devkey-devkey-devkey-devkey-devkey01
SUPPLIER_URL=http://localhost:8080
RETAILER_URL=http://localhost:8082
PORT=5000
TEST_MODE_NO_RAZORPAY=1
```

### Service Ports
| Service | Port | URL |
|---------|------|-----|
| API | 5000 | http://localhost:5000 |
| Web | 5173 | http://localhost:5173 |
| PostgreSQL | 5432 | localhost:5432 |

---

## Troubleshooting

### API won't start - "Database connection refused"
```bash
# Check PostgreSQL is running
# Local: brew services start postgresql@16
# Docker: docker-compose up db
```

### Port already in use
```bash
# Find and kill process on port
lsof -i :5000
kill -9 <PID>
```

### Module not found errors
```bash
# Clean install
rm -rf node_modules
pnpm install
pnpm install --recursive
```

### Database migrations failed
```bash
# Docker
docker-compose exec api npm run db:migrate

# Local
cd apps/api && npm run db:migrate
```

---

## Development Workflow

### Running Tests
```bash
# API tests
cd apps/api && pnpm test

# All tests
pnpm test --recursive
```

### Building for Production
```bash
# Build both services
pnpm build --recursive

# Or individual builds
cd apps/api && pnpm build
cd apps/web && pnpm build
```

### Code Quality
```bash
# Type checking
pnpm typecheck --recursive

# Format code
pnpm format

# Check formatting
pnpm format:check
```

---

## Sharing the demo with ngrok

Use ngrok when someone outside your machine needs to hit your local
CommerceOS instance. The frontend is served over HTTPS by ngrok and
forwards API calls back to your `localhost:5000`. See
[`apps/api/NGROK.md`](apps/api/NGROK.md) for the full walkthrough; the
short version:

1. **Terminal 1 — API**
   ```powershell
   pnpm --filter api dev
   ```
2. **Terminal 2 — Frontend**
   ```powershell
   pnpm --filter web dev
   ```
3. **Terminal 3 — expose API**
   ```powershell
   ngrok http 5000
   ```
4. **Terminal 4 — expose frontend**
   ```powershell
   ngrok http 5173
   ```
5. Configure the frontend at build time with the API ngrok URL via
   `apps/web/.env.local`:
   ```env
   VITE_API_URL=https://<API-NGROK-URL>
   ```
   Then rebuild or restart the Vite dev server so the new origin is
   embedded.
6. Configure the API CORS with the frontend ngrok origin (in your
   shell or `apps/api/.env`):
   ```env
   FRONTEND_ORIGIN=https://<FRONTEND-NGROK-URL>
   ```
   Restart the API.

Open the frontend ngrok URL in a browser. DevTools → Network should
show requests going to `<API-NGROK-URL>/api/...`, never to
`localhost:5000`. Do **not** commit ngrok URLs into the repo — prefer
`.env.local` for temporary values.
