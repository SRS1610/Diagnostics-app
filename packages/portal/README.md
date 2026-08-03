# @diagnostics/portal

The backend admin portal: a tenant-scoped web app plus the cross-tenant
Master Console. React + TypeScript + Vite.

## Running it

```bash
npm run dev      # http://localhost:5173
npm run build    # typecheck + production bundle into dist/
npm run preview  # serve the built bundle
```

The API base URL defaults to `http://localhost:4000` and is overridable
with `VITE_API_BASE_URL`. Start `packages/api` first — every page here is
a view over it, and nothing in the portal holds its own data.

Seeded logins (see `packages/api/prisma/seed.ts`):

| Email                    | Role         | Lands on       |
| ------------------------ | ------------ | -------------- |
| `master@platform.com`    | master_admin | Master Console |
| `admin@acmewireless.com` | tenant_admin | Dashboard      |

## Why a client-rendered SPA and not Next.js

The scaffold's `package.json` originally declared Next.js. This is a Vite
SPA instead, and the reason is the constraint the whole codebase is
organised around: every tenant-scoped query must run under the caller's
session (`requireAuth` + `requireTenantScope` + `tenantWhere`). A server
component fetching data outside that session is precisely the shape where
a query can execute with no tenant context attached. Client rendering
means there is exactly one place a request can originate —
`src/api/client.ts` — and it always carries the caller's token. A request
that somehow skips it is a 401, not a leak.

## How tenant scope is held

`src/auth/SessionContext.tsx` stores the **server-minted token**, not a
locally-tracked tenant id. `enterTenantView` / `exitTenantView` swap that
token for a new one from the API, so the UI is structurally incapable of
disagreeing with the API about which tenant is in scope — there is no
second source of truth to drift.

The tenant-indicator badge lives in `TenantShell`
(`src/components/Shell.tsx`) rather than being repeated per page, so
CLAUDE.md's "on every tenant-scoped portal page" holds by construction.
The badge is still only the UI half of the problem; the query-level
filtering in the API is the other half, and neither substitutes for the
other.

The Master Console is deliberately a different dark theme. A superuser
context should never be visually confusable with a normal tenant view.

## Known limits

- **Devices** groups reports by serial (falling back to IMEI) on the
  client, over the API's 50 most recent reports. A device whose earlier
  inspections fall outside that window shows a shorter history than it
  has. Fixing it properly needs a grouped endpoint. The page says so.
- **Team** omits the QA metrics (redo rate, dispute rate per technician)
  the design calls for — the aggregate endpoints don't exist, and
  invented figures on a page used to judge people's work would be worse
  than none.
- **Settings** is read-only. There is no persistence endpoint behind it,
  and a form that appears to save but doesn't is worse than a page that
  says it can't.
- **Profile QR** shows the exact payload string, not a rendered QR image.
  The payload is the part that has to be correct.
