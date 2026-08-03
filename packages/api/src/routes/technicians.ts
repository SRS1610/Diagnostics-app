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
// NOTE on /login: technicianAuth.ts's shared loginTechnician(badgeCode)
// takes no tenantId — but the schema (correctly, per CLAUDE.md's
// multi-tenant model) only guarantees badgeCode uniqueness WITHIN a
// tenant, not globally. A badge-login lookup by code alone could match
// the wrong tenant's technician. This route requires tenantId in the
// body to disambiguate, same as customerProfile.ts's PIN resolution
// (parseProfileQrPayload/resolveProfileByPin encode tenantId alongside
// the PIN for the same reason). CLAUDE.md's mobile flow lists
// "Technician Login" as Step 1, before the profile QR scan that would
// otherwise establish tenant context — reconciling how the mobile app
// obtains a tenantId before Step 1 (e.g. a per-tenant login URL/QR
// distinct from the profile QR, or reordering the flow) is a real open
// question for Sprint 3 (mobile scaffold), not resolved here. This is
// also NOT behind requireAuth: CLAUDE.md is explicit that badge login is
// about attribution, not security (the tablet itself is already
// facility-access-controlled) — it establishes a Technician identity for
// a mobile session, not a portal session.

import { Router } from "express";
import { PrismaClient, Prisma } from "@prisma/client";
import { requireAuth } from "../middleware/auth";
import { requireTenantScope, tenantWhere } from "../middleware/tenantScope";

const router = Router();
const prisma = new PrismaClient();

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
// note.
router.post("/login", async (req, res) => {
  const { tenantId, badgeCode } = req.body;
  if (!tenantId || !badgeCode) {
    return res.status(400).json({ error: "tenantId and badgeCode are required" });
  }

  const technician = await prisma.technician.findFirst({
    where: { tenantId, badgeCode },
  });
  if (!technician) return res.status(404).json({ error: "Badge code not recognized for this tenant" });

  res.json(technician);
});

export default router;
