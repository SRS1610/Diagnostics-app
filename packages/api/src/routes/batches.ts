// src/routes/batches.ts
//
// Bulk lot intake (batchSession.ts). A batch ties many devices to one
// source — a carrier buyback, a corporate refresh — under a single
// customer profile, rather than re-selecting a profile per device.
//
// Written by the mobile app: mobile_batch_intake.html is a separate flow
// branching off right after technician login, so these are
// technician-authenticated and scoped by the session token's tenant.
// Reads are portal-authenticated too, since operations needs to see lot
// progress from the Devices tab.

import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { requireTenantScope, tenantWhere } from "../middleware/tenantScope";
import { requireTechnicianAuth, technicianTenantWhere } from "../middleware/technicianAuth";
import { prisma } from "../lib/prisma";

const router = Router();

router.get("/", requireAuth, requireTenantScope, async (req, res) => {
  const batches = await prisma.batchSession.findMany({
    where: tenantWhere(req),
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  res.json(batches.map((b) => ({ ...b, deviceCount: b.deviceSerials.length })));
});

router.get("/:batchId", requireAuth, requireTenantScope, async (req, res) => {
  const batch = await prisma.batchSession.findFirst({
    where: { ...tenantWhere(req), batchId: req.params.batchId },
  });
  if (!batch) return res.status(404).json({ error: "Batch not found" });
  res.json({ ...batch, deviceCount: batch.deviceSerials.length });
});

router.post("/", requireTechnicianAuth, async (req, res) => {
  const { sourceName, profileId } = req.body ?? {};

  if (typeof sourceName !== "string" || !sourceName.trim()) {
    return res.status(400).json({ error: "sourceName is required" });
  }
  if (profileId !== undefined && profileId !== null && typeof profileId !== "string") {
    return res.status(400).json({ error: "profileId must be a string when provided" });
  }

  const tenantFilter = technicianTenantWhere(req);

  // Same treatment as report creation: a caller-supplied profileId is
  // confirmed to belong to this tenant before it's attached, or a batch
  // could be bound to another tenant's test configuration.
  if (profileId) {
    const profile = await prisma.customerProfile.findFirst({
      where: { ...tenantFilter, profileId },
      select: { profileId: true },
    });
    if (!profile) return res.status(404).json({ error: "Profile not found" });
  }

  const batch = await prisma.batchSession.create({
    data: {
      ...tenantFilter,
      sourceName: sourceName.trim(),
      profileId: profileId ?? null,
      technicianId: req.technicianSession!.technicianId,
      deviceSerials: [],
      status: "open",
    },
  });

  res.status(201).json({ ...batch, deviceCount: 0 });
});

/**
 * CLAUDE.md: "Re-scanning the same serial within a batch is a no-op, not
 * a duplicate entry." A technician working a pallet will re-scan — the
 * point of the dedupe is that the lot count stays honest.
 *
 * Serials are appended inside a transaction with a row lock, because two
 * scans arriving together would otherwise both read the same array and
 * the second write would discard the first. That is the same class of
 * bug found in revision numbering; here it would silently lose a device
 * from the lot, which is worse than a visible error.
 */
router.post("/:batchId/devices", requireTechnicianAuth, async (req, res) => {
  const { serialNumber } = req.body ?? {};
  if (typeof serialNumber !== "string" || !serialNumber.trim()) {
    return res.status(400).json({ error: "serialNumber is required" });
  }
  const serial = serialNumber.trim();

  const tenantFilter = technicianTenantWhere(req);
  const existing = await prisma.batchSession.findFirst({
    where: { ...tenantFilter, batchId: req.params.batchId },
    select: { batchId: true, status: true },
  });
  if (!existing) return res.status(404).json({ error: "Batch not found" });
  // Fast path only — the authoritative status check happens inside the
  // lock below. This just avoids acquiring a lock in the common case.
  if (existing.status !== "open") {
    return res.status(409).json({ error: "This batch is closed and cannot accept more devices" });
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "batchId" FROM "batch_sessions" WHERE "batchId" = ${existing.batchId} FOR UPDATE`;

    // status is re-read INSIDE the lock, not trusted from the fast-path
    // check above. A concurrent /close commits in a single statement, so
    // it can land between that read and this transaction — gating on the
    // stale value let a serial be appended to an already-closed batch,
    // silently and with a 201. Same stale-read-gates-a-write shape as the
    // revision-number race; the earlier fix guarded deviceSerials but not
    // status.
    const current = await tx.batchSession.findUniqueOrThrow({
      where: { batchId: existing.batchId },
      select: { deviceSerials: true, status: true },
    });

    if (current.status !== "open") {
      return { alreadyPresent: false, closed: true, count: current.deviceSerials.length };
    }
    if (current.deviceSerials.includes(serial)) {
      return { alreadyPresent: true, closed: false, count: current.deviceSerials.length };
    }

    const updated = await tx.batchSession.update({
      where: { batchId: existing.batchId },
      data: { deviceSerials: { push: serial } },
    });
    return { alreadyPresent: false, closed: false, count: updated.deviceSerials.length };
  });

  if (result.closed) {
    return res.status(409).json({ error: "This batch is closed and cannot accept more devices" });
  }

  // 200 rather than 201 for a re-scan, so the client can tell "counted"
  // from "already counted" without treating it as an error — the
  // technician did nothing wrong.
  res.status(result.alreadyPresent ? 200 : 201).json({
    batchId: existing.batchId,
    serialNumber: serial,
    alreadyPresent: result.alreadyPresent,
    deviceCount: result.count,
  });
});

router.post("/:batchId/close", requireTechnicianAuth, async (req, res) => {
  const tenantFilter = technicianTenantWhere(req);

  const result = await prisma.batchSession.updateMany({
    where: { ...tenantFilter, batchId: req.params.batchId, status: "open" },
    data: { status: "closed", closedAt: new Date() },
  });

  if (result.count === 0) {
    const exists = await prisma.batchSession.findFirst({
      where: { ...tenantFilter, batchId: req.params.batchId },
      select: { batchId: true },
    });
    if (!exists) return res.status(404).json({ error: "Batch not found" });
    return res.status(409).json({ error: "This batch is already closed" });
  }

  const batch = await prisma.batchSession.findFirst({
    where: { ...tenantFilter, batchId: req.params.batchId },
  });
  res.json({ ...batch, deviceCount: batch?.deviceSerials.length ?? 0 });
});

export default router;
