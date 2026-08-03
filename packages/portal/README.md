# Portal (Sprint 6)

This package is intentionally not scaffolded yet — Next.js's own
scaffolding tool needs to run inside an otherwise-empty directory.

## Setup

```bash
cd packages/portal
npx create-next-app@latest . --typescript --tailwind --app --no-src-dir
```

When prompted, decline creating a new git repo (this is already inside one).

## What to build, and in what order

Each mockup in `/mockups` corresponds to one route. Build them in this
order, matching the dependency chain in `project_roadmap.docx`:

1. `portal_login.html` → `app/login/page.tsx` — wire to `POST /auth/login`
2. `master_console.html` → `app/master/page.tsx` — master_admin only,
   cross-tenant tenant list (see CLAUDE.md "Multi-tenant architecture")
3. `admin_portal.html` → `app/dashboard/page.tsx` — the tenant Dashboard
4. `admin_portal_detail.html`, `admin_portal_devices.html`,
   `admin_portal_device_history.html` → Reports/Devices
5. `admin_portal_profiles.html` → Test Profiles CRUD
6. `admin_portal_billing.html` → Billing & Licenses
7. `admin_portal_team.html` → Team roster
8. `admin_portal_activity_log.html` → Activity Log
9. `admin_portal_compliance.html`, `admin_portal_disputes.html`,
   `admin_portal_settings.html`

## The one rule that matters most

Every page except the Master Console must filter every data fetch by
the current tenant. The HTML mockups already show the tenant-indicator
badge as a UI convention — when you wire real data fetching, make sure
the actual API calls carry the tenant context (the JWT already encodes
`viewingTenantId` — see `packages/api/src/middleware/tenantScope.ts`).
The badge being present in the mockup does NOT mean the scoping is
real yet; that's this package's job to make real.
