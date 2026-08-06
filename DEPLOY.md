# Deploy

Two moving parts, deployed separately:

- **API** (`packages/api`) — Express + Prisma + Postgres. Runs on a
  Node host (Render blueprint provided in `render.yaml`).
- **Portal** (`packages/portal`) — static React bundle. Runs on
  Netlify (`netlify.toml` provided).

The consumer site (`packages/consumer`) deploys the same way as the
portal — duplicate the Netlify config into a second site if you need it.
The mobile app is a native binary and is out of scope here.

## Why login fails on a bare Netlify deploy

The portal is a static bundle; Netlify does not run the API. Its API
base URL is inlined at build time from `VITE_API_BASE_URL`, defaulting
to `http://localhost:4000` (`packages/portal/src/api/client.ts:21`). If
that env var isn't set, the deployed site tries to POST login to the
visitor's own machine — the browser blocks it as mixed content over
HTTPS anyway. Fix is (1) deploy the API somewhere HTTPS-reachable and
(2) rebuild the portal with `VITE_API_BASE_URL` pointing at it.

## 1. API on Render (or equivalent)

1. Push this branch. In Render: **New → Blueprint**, pick the repo and
   branch. It reads `render.yaml`, provisions a Postgres, wires
   `DATABASE_URL`, and builds the API.
2. First deploy runs `prisma migrate deploy` automatically. Seed once:
   open **Shell** on the `diagnostics-api` service and run
   `npx --workspace=packages/api prisma db seed`. That creates the
   Acme Wireless tenant, PIN 4726, technician TEC-1042, and the two
   portal logins (`master@platform.com` / `changeme123` and
   `admin@acmewireless.com` / `changeme123`).
3. Note the service URL Render assigns (e.g.
   `https://diagnostics-api.onrender.com`).
4. Back in Render → Environment, set:
   - `CORS_ORIGINS` = your Netlify origin(s), comma-separated
   - `PORTAL_BASE_URL` = the Netlify portal URL
   - `CONSUMER_BASE_URL` = the consumer site URL (if deployed)
   - `API_BASE_URL` = the Render API URL (used in email links / SSO
     callback URLs)

Render's free Postgres plan expires after 30 days — fine for testing,
not for anything real.

Other hosts (Railway, Fly.io, a plain VPS) work the same shape: run
`node packages/api/dist/index.js` with `DATABASE_URL` and `JWT_SECRET`
set, run `prisma migrate deploy` before each deploy, seed once.

## 2. Portal on Netlify

1. New site → connect this repo. `netlify.toml` at the repo root is
   picked up automatically (build command, publish dir, SPA fallback).
2. **Site settings → Environment variables**, add:
   - `VITE_API_BASE_URL` = the Render API URL (e.g.
     `https://diagnostics-api.onrender.com`)
3. Trigger a redeploy. Vite inlines env vars at build time — changing
   the value alone won't update the already-built bundle; a rebuild is
   required.

## 3. Sanity check

```bash
curl -sS https://<api-host>/health
# → {"status":"ok"}

curl -sS -X POST https://<api-host>/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@acmewireless.com","password":"changeme123"}'
# → 200 with a JWT and the user object; if you get 401 the seed didn't run
```

Then open the Netlify portal URL and log in with the same credentials.
If the browser console shows a CORS error, `CORS_ORIGINS` on the API
doesn't include the portal's exact origin (scheme + host, no trailing
slash).

## What is intentionally not wired

Stripe, Twilio, SendGrid, cosmetic CV inference, and device
verification all read their credentials from env vars but ship without
them — features that depend on those services degrade gracefully (see
each module's header comment). Add the credentials as env vars on the
API host when you're ready to turn each one on.
