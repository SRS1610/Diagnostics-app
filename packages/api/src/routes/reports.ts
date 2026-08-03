// src/routes/reports.ts
//
// Reference implementation of a correctly tenant-scoped route — every
// other tenant-scoped resource (devices, profiles, disputes, etc.)
// should follow this exact pattern: requireAuth, requireTenantScope,
// then filter every Prisma query with tenantWhere(req).

import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/auth";
import { requireTenantScope, tenantWhere } from "../middleware/tenantScope";

const router = Router();
const prisma = new PrismaClient();

router.get("/", requireAuth, requireTenantScope, async (req, res) => {
  const reports = await prisma.report.findMany({
    where: tenantWhere(req), // NEVER query without this — see tenantScope.ts
    orderBy: { generatedAt: "desc" },
    take: 50,
  });
  res.json(reports);
});

router.get("/:reportId", requireAuth, requireTenantScope, async (req, res) => {
  const report = await prisma.report.findFirst({
    where: { ...tenantWhere(req), reportId: req.params.reportId }, // tenantWhere FIRST —
    // a report ID guess from another tenant must still 404, not leak data
    include: { revisions: true, wipeCertificate: true },
  });
  if (!report) return res.status(404).json({ error: "Report not found" });
  res.json(report);
});

export default router;
