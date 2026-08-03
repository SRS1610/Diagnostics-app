# Device Diagnostics & Trade-In SaaS Platform

Multi-tenant SaaS platform for mobile device diagnostics, cosmetic
grading, and trade-in valuation. Serves the phone trade-in/refurbishment
industry — each customer (a refurbisher, carrier, or trade-in program)
gets an isolated tenant; a Master Admin manages all tenants.

## Start here

1. **Read `CLAUDE.md` first** — this is the canonical architecture
   reference. Every decision, platform constraint, and module's purpose
   is documented there. Claude Code reads it automatically at the start
   of every session in this directory.
2. **Read `docs/project_roadmap.docx`** — the 8-sprint plan, module
   inventory, critical path, and risk register.
3. **Browse `/mockups`** — 18 HTML files, fully interactive, showing
   every screen this platform needs (mobile app, tenant portal, Master
   Console, consumer-facing pages). These are the visual spec — build
   toward them, don't redesign from scratch.

## Project structure

```
├── CLAUDE.md                    ← read this first
├── packages/
│   ├── shared/src/               ← 27 TypeScript modules, ALL business
│   │                                logic + types already written
│   ├── api/                      ← Express + Prisma backend (Sprint 1-2)
│   │   ├── prisma/schema.prisma  ← full multi-tenant DB schema
│   │   └── src/
│   ├── mobile/                   ← React Native app (Sprint 3-5) — see
│   │                                its README for setup + build order
│   └── portal/                   ← Web portal (Sprint 6) — see its
│                                    README for setup + build order
├── mockups/                      ← 18 HTML reference screens
└── docs/
    ├── project_roadmap.docx
    ├── cosmetic_grading_dataset_plan.md
    └── market_pricing_template.xlsx
```

## Getting started with Claude Code

```bash
npm install -g @anthropic-ai/claude-code
cd device-diagnostics-platform
claude
```

Then, in your first session:

```
> Read CLAUDE.md and the module inventory in docs/project_roadmap.docx.
  Summarize the multi-tenant model back to me so I can confirm you've
  got the architecture right before we start Sprint 1.
```

Once confirmed, work sprint by sprint per the roadmap. Start with:

```
> Set up the database: run `npm install` at the repo root, then
  `npx prisma generate` and `npx prisma migrate dev` inside packages/api
  using the schema already written. Then run the seed script.
```

## What's real vs. what needs external setup

Every module in `packages/shared/src` has complete types and logic.
Several depend on a real external vendor before they're functional —
this is called out explicitly in the header comment of each affected
file (`deviceVerification.ts`, `notifications.ts`, `shippingLogistics.ts`,
`kycVerification.ts`, `invoicing.ts`, `marketPriceData.ts`). Don't treat
the code compiling as the same thing as the feature working — read
those header comments before assuming a module is production-ready.

## The one architectural rule that matters most

**Multi-tenant data isolation.** Every tenant-scoped query must filter
by `tenantId`. See `packages/api/src/middleware/tenantScope.ts` for the
enforcement pattern and `packages/api/src/routes/reports.ts` for a
reference implementation. The tenant-indicator badge visible on every
portal mockup is a UI convention, not a security guarantee — the real
guarantee has to be enforced server-side, in every single query.
