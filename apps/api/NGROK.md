# Sharing a local instance with ngrok

Use ngrok when you need a teammate or stakeholder to hit your local
CommerceOS instance from their browser. The frontend is served by ngrok,
and ngrok forwards API calls back to your `localhost:5000`.

## How it works

The API treats the shared frontend as a public origin and opts into
Chrome's Private Network Access so the browser allows the public →
private hop. No vendor-specific code, allowlist entries, or per-host
patterns are baked into the server — the only extra config is the
shared frontend origin in `FRONTEND_ORIGIN`.

## Quick start

1. Start the API (it binds `0.0.0.0:5000`):
   ```powershell
   pnpm --filter api dev
   ```
2. Start the frontend (it binds `0.0.0.0:5173`):
   ```powershell
   pnpm --filter web dev
   ```
3. Expose the API:
   ```powershell
   ngrok http 5000
   ```
   Note the printed HTTPS origin — that is `<API-NGROK-URL>`.
4. Expose the frontend:
   ```powershell
   ngrok http 5173
   ```
   Note the printed HTTPS origin — that is `<FRONTEND-NGROK-URL>`.
5. Point the frontend at the shared API. Create
   `apps/web/.env.local` (gitignored) with:
   ```env
   VITE_API_URL=https://<API-NGROK-URL>
   ```
   Restart the Vite dev server (or rebuild the production bundle) so the
   new origin is embedded.
6. Allow the frontend origin on the API. Set in your shell before
   starting the API, or in `apps/api/.env`:
   ```env
   FRONTEND_ORIGIN=https://<FRONTEND-NGROK-URL>
   ```
   Restart the API.
7. Open `<FRONTEND-NGROK-URL>` in a browser. DevTools → Network should
   show requests going to `<API-NGROK-URL>/api/...`, never to
   `localhost:5000`.

## Verifying the headers

```powershell
curl -i -X OPTIONS http://127.0.0.1:5000/api/debug/status `
  -H "Origin: https://<FRONTEND-NGROK-URL>" `
  -H "Access-Control-Request-Method: GET"
```

Expected response headers:

- `Access-Control-Allow-Origin: https://<FRONTEND-NGROK-URL>`
- `Access-Control-Allow-Private-Network: true`

If the second header is missing, Chrome will block the real GET/POST
from the shared frontend to your local API.

## Production

In production the API and web share a public origin (or the API is on a
whitelisted public host), so Private Network Access does not apply. The
`Access-Control-Allow-Private-Network: true` header is harmless outside
the public → private case.