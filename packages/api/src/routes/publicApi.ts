// src/routes/publicApi.ts
//
// The actual programmatic surface an API key unlocks: read-only, and
// only reports. Nothing here can create, change or delete anything —
// see middleware/apiKeyAuth.ts for why that boundary exists at all.
//
// Deliberately a small slice of what the portal can see, not a mirror
// of it: a partner integration pulling inspection results does not need
// disputes, licensing, or other tenants' users, and exposing them here
// would be scope creep on a credential that's much more likely to end
// up in a partner's server logs than a portal session token is.

import { Router } from "express";
import { requireApiKey, apiKeyTenantWhere } from "../middleware/apiKeyAuth";
import { parseDate, parseListWindow, parseSearch, setPaginationHeaders } from "../lib/pagination";
import { prisma } from "../lib/prisma";

const router = Router();

router.get("/reports", requireApiKey, async (req, res) => {
  const { limit, offset } = parseListWindow(req);
  const search = parseSearch(req.query.q);
  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to);

  const where: Record<string, unknown> = { ...apiKeyTenantWhere(req) };
  if (search) {
    where.OR = [
      { serialNumber: { contains: search, mode: "insensitive" } },
      { imei: { contains: search, mode: "insensitive" } },
      { deviceModel: { contains: search, mode: "insensitive" } },
    ];
  }
  if (from || to) {
    where.generatedAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }

  const [total, reports] = await Promise.all([
    prisma.report.count({ where }),
    prisma.report.findMany({
      where,
      orderBy: { generatedAt: "desc" },
      take: limit,
      skip: offset,
      // Same whitelist reasoning as the portal's own list endpoint:
      // consumerToken is a live capability and never belongs in a list
      // response, and this is a credential even more likely than a
      // portal session to be logged somewhere by whatever's calling it.
      select: {
        reportId: true,
        generatedAt: true,
        deviceMake: true,
        deviceModel: true,
        serialNumber: true,
        imei: true,
        captureSource: true,
        overallStatus: true,
        routing: true,
      },
    }),
  ]);

  setPaginationHeaders(res, { total, limit, offset });
  res.json(reports);
});

router.get("/reports/:reportId", requireApiKey, async (req, res) => {
  const report = await prisma.report.findFirst({
    where: { ...apiKeyTenantWhere(req), reportId: req.params.reportId },
    select: {
      reportId: true,
      generatedAt: true,
      deviceMake: true,
      deviceModel: true,
      serialNumber: true,
      imei: true,
      captureSource: true,
      overallStatus: true,
      routing: true,
      results: true,
    },
  });
  if (!report) return res.status(404).json({ error: "Report not found" });
  res.json(report);
});

export default router;
