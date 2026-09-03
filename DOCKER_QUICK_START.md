# CommerceOS Local Development - Quick Start Guide

## Status
✅ Docker services are currently building and starting up. Please wait for full startup completion.

## Services Running

### 1. **PostgreSQL Database**
- **Status**: Starting
- **Port**: 5432
- **Database**: commerce0s
- **User**: commerce
- **Password**: commerce

### 2. **API Server (Express.js)**
- **Status**: Building (dev mode with hot reload)
- **Port**: 5000
- **Framework**: Node.js + Express + TypeScript
- **Auto-reload**: Enabled (tsx watch)
- **Database**: Connected to PostgreSQL
- **Test Mode**: Razorpay test mode enabled (`RAZORPAY_MODE=test`, real `rzp_test_…` keys)

### 3. **Web App (React + Vite)**
- **Status**: Building (dev mode with hot reload)
- **Port**: 5173
- **Framework**: React 19 + Vite + TypeScript
- **Features**: React Router, TanStack Query, Tailwind CSS, Radix UI

---

## Access Points

Once services are fully started:

| Service | URL | Purpose |
|---------|-----|---------|
| Web App | http://localhost:5173 | Frontend - React app |
| API | http://localhost:5000 | Backend - REST API |
| PostgreSQL | localhost:5432 | Database (internal) |

---

## What's Happening Now

1. **Docker Images**: Building from Alpine Node 22 for optimal size
2. **Dependencies**: Installing ~332 packages for both services
3. **Volume Mounts**: Setting up live reload for source files
4. **Health Checks**: PostgreSQL waits for database readiness
5. **Startup Sequence**:
   - PostgreSQL starts first
   - API waits for database health check
   - Web app starts independently
   - Both services ready for requests

---

## Terminal Commands for Monitoring

### View all logs (keep this terminal open)
```bash
docker-compose logs -f
```

### View specific service logs
```bash
docker-compose logs -f api      # API server
docker-compose logs -f web      # Web app
docker-compose logs -f db       # Database
```

### Check service status
```bash
docker-compose ps
```

### Stop services
```bash
docker-compose down
```

### Restart a service
```bash
docker-compose restart api
```

---

## Development Workflow

### Making Changes

Both services have **hot reload enabled**:

- **API**: Edit `apps/api/src/*.ts` → Automatically restarts (tsx watch)
- **Web**: Edit `apps/web/src/**/*.{ts,tsx}` → Automatically refreshes (Vite)

### Running Tests

Tests in Docker:
```bash
docker-compose exec api pnpm test
```

### Building for Production
```bash
docker-compose exec api pnpm build
docker-compose exec web pnpm build
```

### Accessing Database

Connect to PostgreSQL inside Docker:
```bash
docker-compose exec db psql -U commerce -d commerce0s
```

---

## Troubleshooting

### Services won't start
```bash
# View detailed logs
docker-compose logs

# Rebuild from scratch
docker-compose down -v
docker-compose up --build
```

### API can't connect to database
- Wait a few seconds for PostgreSQL health check to pass
- Check logs: `docker-compose logs db`
- Database connection string: `postgres://commerce:commerce@db:5432/commerce0s`

### Port already in use
```bash
# Kill process on port
lsof -i :5000     # Check port 5000
lsof -i :5173     # Check port 5173
lsof -i :5432     # Check port 5432
```

### Out of memory or slow build
```bash
# Clear Docker cache and rebuild
docker system prune
docker-compose up --build
```

---

## Environment Setup

### Database Environment Variables (already configured in docker-compose.yml)
```
POSTGRES_USER=commerce
POSTGRES_PASSWORD=commerce
POSTGRES_DB=commerce0s
DATABASE_URL=postgres://commerce:commerce@db:5432/commerce0s
```

### API Environment Variables (already configured in docker-compose.yml)
```
PORT=5000
ENCRYPTION_KEY=devkey-devkey-devkey-devkey-devkey-devkey01
SUPPLIER_URL=http://host.docker.internal:8080
RETAILER_URL=http://host.docker.internal:8082
RAZORPAY_MODE=test
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
RAZORPAY_WEBHOOK_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
DISABLE_RATE_LIMITS=0
```

### Web Environment Variables (already configured in docker-compose.yml)
```
PORT=5173
BASE_PATH=/
```

---

## Next Steps

1. **Wait** for services to fully start (watch the terminal output)
2. **Open** http://localhost:5173 in your browser
3. **Start developing** - changes auto-reload!
4. **Check API** at http://localhost:5000 (if endpoints exist)

---

## Useful Docker Commands

```bash
# View running containers
docker ps

# View all containers (including stopped)
docker ps -a

# View Docker images
docker images

# Get container IP
docker-compose exec db hostname -i

# Run command in container
docker-compose exec api npm run typecheck

# View container resource usage
docker stats

# Remove all stopped containers
docker container prune

# Clean up unused images/volumes
docker system prune
```

---

## Project Structure

```
CommerceOS/
├── apps/
│   ├── api/              # Express API server (TypeScript)
│   │   ├── src/          # Source code
│   │   ├── Dockerfile    # Docker config (dev mode)
│   │   └── package.json
│   ├── web/              # React web app (TypeScript)
│   │   ├── src/          # React components
│   │   ├── Dockerfile    # Docker config (dev mode)
│   │   └── package.json
├── services/
│   └── agents/           # Python agents (optional)
├── docker-compose.yml    # Docker orchestration
├── pnpm-workspace.yaml   # Monorepo config
└── SETUP_LOCAL_DEV.md    # Setup guide (this workspace)
```

---

## Performance Tips

- **First build**: Takes 2-3 minutes (downloading images, installing dependencies)
- **Subsequent builds**: Much faster due to Docker caching
- **Live reload**: Takes 1-2 seconds per change
- **Database**: Persists in `pgdata` volume across restarts (use `down -v` to clear)

---

## Support & Debugging

For issues, check:
1. Docker Desktop is running
2. No port conflicts (5000, 5173, 5432)
3. Sufficient disk space for images (~2GB)
4. Docker daemon logs: `docker logs <container-id>`
5. Full build output: Check the terminal running `docker-compose up`

---

Generated: 2026-09-01
For the latest setup guide, see [SETUP_LOCAL_DEV.md](SETUP_LOCAL_DEV.md)
