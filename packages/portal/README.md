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

## Testing

```bash
# 0. once per machine — installs the Chromium these checks drive
npm run e2e:install --workspace=packages/portal

# 1. API (needs Postgres running and the database seeded)
npm run dev --workspace=packages/api

# 2. the portal, BUILT — not the dev server
npm run build   --workspace=packages/portal
npm run preview --workspace=packages/portal   # http://localhost:4173

# 3. the checks
npm run test:e2e --workspace=packages/portal
```

`test:e2e` runs two suites, and they check different things:

- **`e2e/smoke.mjs`** — does it work? Login, the Master Console, entering
  and leaving a tenant, all nine tenant-scoped pages loading with the
  right heading and the right tenant badge, opening a report and a device
  history, and a session surviving a full page reload.
- **`e2e/failure-modes.mjs`** — does it lie when things break? Requests
  are made to fail, 401, and 500, and the checks assert the portal says
  so: no fabricated zeroes on stat tiles, no error rendered as an empty
  state, no blank screen on an expired session.
- **`e2e/write-flows.mjs`** — the actions that CHANGE something, which
  the other two never touch: creating a tenant, suspending and
  reactivating it, creating a profile (and being refused a duplicate PIN
  with a usable message), the QR payload carrying its tenant, deleting a
  profile, provisioning a licence and confirming it supersedes rather
  than accumulates, deactivating and reactivating a technician, and
  resolving a dispute — which must stay unavailable until reasoning is
  written.

  Everything mutating runs inside a dedicated **E2E Sandbox** tenant it
  creates on first run and reuses after, so a run cannot disturb real
  data. Provisioning a licence supersedes whatever was active, which is
  not something to do to a tenant you care about. The suite is safe to
  run repeatedly against the same database.

Run them against the **built bundle**, not `npm run dev`. That is what
ships, and it is where the session bug appeared.

Both suites exist because the portal's worst failures pass a type-check
and a unit test cleanly. The session bug that logged users out on every
refresh built without a warning. The dashboard that reported a failed
fetch as "0 disputes awaiting review" was correct TypeScript rendering a
false claim. Catching either needs a browser, a live API, and an
assertion about what a human would actually read.

### The browser

`playwright-core` is the Playwright library *without* the browser
downloader, so a fresh checkout has nothing to drive until
`npm run e2e:install` fetches one (~120 MB, once). Already have a Chrome
or Chromium? Point at it instead and skip the download:

```bash
CHROMIUM_PATH=/path/to/chrome npm run test:e2e --workspace=packages/portal
```

Managed/CI environments that pre-install browsers are detected via
`PLAYWRIGHT_BROWSERS_PATH` and need neither. If no browser can be found
the suites say so and exit non-zero, rather than failing with a stack
trace.

Useful environment variables: `PORTAL_URL`, `API_URL`, `MASTER_EMAIL`,
`TENANT_EMAIL`, `PORTAL_PASSWORD`, `TENANT_NAME`, `CHROMIUM_PATH`,
`E2E_TIMEOUT`. A failing check writes a screenshot to `/tmp` and names it
in the output.

### Testing it by hand

Sign in as `master@platform.com / changeme123` for the Master Console, or
`admin@acmewireless.com / changeme123` to land straight in a tenant.
Worth trying deliberately, since automated checks tend not to:

- Stop the API and reload a page. Nothing should claim a count of zero;
  tiles should read "—".
- Enter a tenant, then open a second tab and enter a different one. Each
  tab keeps its own scope; the badge must always match the data.
- Open a report detail and press "Show link" — that URL is a capability,
  and should stay hidden until asked for.

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
