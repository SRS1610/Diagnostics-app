// src/routes/technicians.ts
//
// Technician CRUD (roster management, tenant-scoped, portal-authenticated)
// + badge login (mobile app, NOT portal-authenticated — see below).
//
// CRUD follows the requireAuth + requireTenantScope + tenantWhere
// pattern from reports.ts, same as profiles.ts/licenses.ts. badgeCode is
// unique per-tenant (schema.prisma's @@unique([tenantId, badgeCode])),
// same PIN-scoping pattern as CustomerProfile.
//
// RESOLVED — tenant context at mobile Step 1: badgeCode is only unique
// WITHIN a tenant, so a bare badgeCode lookup at /login is ambiguous
// across tenants — the same problem customerProfile.ts already solved
// for PINs. Fixed the same way: technicianAuth.ts's
// generateTechnicianBadgePayload/parseTechnicianBadgePayload encode
// tenantId:badgeCode together in a printed badge QR (GET
// /:technicianId/badge-payload below generates it, mirroring
// GET /profiles/:profileId/qr), so scanning a technician's own badge at
// Step 1 carries tenant context with it — no need to reorder the mobile
// flow or wait for the Step 2 profile scan. Manual badge-code entry (the
// fallback, badge missing/damaged) needs a tenant picker first, same as
// manual PIN entry.
//
// /login is NOT behind requireAuth/requireTenantScope: CLAUDE.md is
// explicit that badge login is about attribution, not security (the
// tablet itself is already facility-access-controlled) — it establishes
// a Technician identity for a mobile session, not a portal session.

import { Router } from "express";
import { PrismaClient, Prisma } from "@prisma/client";
import rateLimit from "express-rate-limit";
import { generateTechnicianBadgePayload } from "@diagnostics/shared";
import { requireAuth } from "../middleware/auth";
import { requireTenantScope, tenantWhere } from "../middleware/tenantScope";

const router = Router();
const prisma = new PrismaClient();

// badgeCode is a low-entropy, non-secret identifier (CLAUDE.md: "about
// attribution... not security") looked up by a client-supplied tenantId
// that isn't secret either — it's printed on the profile QR poster at
// intake. Without a rate limit, an unauthenticated caller who has (or
// photographs) a tenantId could brute-force badgeCode and harvest a
// tenant's technician roster with no throttling.
const badgeLoginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." },
});

router.get("/", requireAuth, requireTenantScope, async (req, res) => {
  const technicians = await prisma.technician.findMany({
    where: tenantWhere(req),
    orderBy: { createdAt: "desc" },
  });
  res.json(technicians);
});

router.get("/:technicianId", requireAuth, requireTenantScope, async (req, res) => {
  const technician = await prisma.technician.findFirst({
    where: { ...tenantWhere(req), technicianId: req.params.technicianId },
  });
  if (!technician) return res.status(404).json({ error: "Technician not found" });
  res.json(technician);
});

router.get("/:technicianId/badge-payload", requireAuth, requireTenantScope, async (req, res) => {
  const technician = await prisma.technician.findFirst({
    where: { ...tenantWhere(req), technicianId: req.params.technicianId },
  });
  if (!technician) return res.status(404).json({ error: "Technician not found" });
  res.json({ payload: generateTechnicianBadgePayload(technician) });
});

router.post("/", requireAuth, requireTenantScope, async (req, res) => {
  const { displayName, badgeCode } = req.body;
  if (!displayName || !badgeCode) {
    return res.status(400).json({ error: "displayName and badgeCode are required" });
  }

  let technician;
  try {
    technician = await prisma.technician.create({
      data: { ...tenantWhere(req), displayName, badgeCode },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ error: "Badge code already in use for this tenant" });
    }
    throw e;
  }

  res.status(201).json(technician);
});

router.patch("/:technicianId", requireAuth, requireTenantScope, async (req, res) => {
  const existing = await prisma.technician.findFirst({
    where: { ...tenantWhere(req), technicianId: req.params.technicianId },
  });
  if (!existing) return res.status(404).json({ error: "Technician not found" });

  const { displayName, badgeCode } = req.body;
  const data: Prisma.TechnicianUpdateManyMutationInput = {};
  if (displayName !== undefined) data.displayName = displayName;
  if (badgeCode !== undefined) data.badgeCode = badgeCode;

  try {
    // Combined tenant + id filter in the write itself (updateMany, not
    // update-by-id) — see the tenant-scope-reviewer finding fixed in
    // profiles.ts for why this matters even though nothing currently
    // reassigns a technician's tenantId.
    const result = await prisma.technician.updateMany({
      where: { ...tenantWhere(req), technicianId: req.params.technicianId },
      data,
    });
    if (result.count === 0) return res.status(404).json({ error: "Technician not found" });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ error: "Badge code already in use for this tenant" });
    }
    throw e;
  }

  const updated = await prisma.technician.findFirst({
    where: { ...tenantWhere(req), technicianId: req.params.technicianId },
  });
  res.json(updated);
});

router.delete("/:technicianId", requireAuth, requireTenantScope, async (req, res) => {
  const result = await prisma.technician.deleteMany({
    where: { ...tenantWhere(req), technicianId: req.params.technicianId },
  });
  if (result.count === 0) return res.status(404).json({ error: "Technician not found" });
  res.status(204).send();
});

// Mobile app badge login — not requireAuth/requireTenantScope (there is
// no portal session yet; this IS how a mobile session establishes a
// technician identity). See file header for the tenantId disambiguation
// note, and badgeLoginRateLimit above for the enumeration-risk mitigation.
router.post("/login", badgeLoginRateLimit, async (req, res) => {
  const { tenantId, badgeCode } = req.body;
  if (!tenantId || !badgeCode) {
    return res.status(400).json({ error: "tenantId and badgeCode are required" });
  }

  const technician = await prisma.technician.findFirst({
    where: { tenantId, badgeCode },
    include: { tenant: { select: { companyName: true } } },
  });
  if (!technician) return res.status(404).json({ error: "Badge code not recognized for this tenant" });

  // Trim the response to what a mobile session actually needs — no
  // reason to echo badgeCode back once it's served its purpose as a
  // lookup key. companyName IS included: the mobile app binds this
  // tenant to the device (see mobile's src/lib/deviceTenant.ts) and must
  // be able to show a human which organization the tablet is set up for,
  // so a mis-provisioned device is visible rather than silent. Not a
  // cross-tenant disclosure — the caller already proved knowledge of a
  // valid (tenantId, badgeCode) pair for exactly this tenant.
  res.json({
    technicianId: technician.technicianId,
    tenantId: technician.tenantId,
    displayName: technician.displayName,
    companyName: technician.tenant.companyName,
  });
});

export default router;
