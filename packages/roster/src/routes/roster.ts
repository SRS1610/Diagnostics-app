import { Router } from "express";
import { assignmentsToCsv } from "../csvExport";
import { rosterStore } from "../rosterStore";

const router = Router();

router.post("/generate", (req, res) => {
  const year = Number(req.body?.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return res.status(400).json({ error: "year must be a valid 4-digit year" });
  }
  const result = rosterStore.generateYear(year);
  res.json(result);
});

router.get("/assignments", (req, res) => {
  const outletId = typeof req.query.outletId === "string" ? req.query.outletId : undefined;
  const month = typeof req.query.month === "string" ? req.query.month : undefined;
  const year = typeof req.query.year === "string" ? req.query.year : undefined;
  const staffId = typeof req.query.staffId === "string" ? req.query.staffId : undefined;
  res.json(rosterStore.listAssignments({ outletId, month, year, staffId }));
});

router.get("/overview", (req, res) => {
  const month = typeof req.query.month === "string" ? req.query.month : undefined;
  if (!month) return res.status(400).json({ error: "month (YYYY-MM) is required" });
  res.json(rosterStore.summarizeOutlets(month));
});

router.get("/export", (req, res) => {
  const outletId = typeof req.query.outletId === "string" ? req.query.outletId : undefined;
  const month = typeof req.query.month === "string" ? req.query.month : undefined;
  if (!outletId || !month) return res.status(400).json({ error: "outletId and month are required" });

  const assignments = rosterStore.listAssignments({ outletId, month });
  const csv = assignmentsToCsv({
    assignments,
    staff: rosterStore.listStaff(),
    shiftTemplates: rosterStore.listShiftTemplates(),
    outlets: rosterStore.listOutlets(),
  });

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="roster-${outletId}-${month}.csv"`);
  res.send(csv);
});

router.get("/warnings", (req, res) => {
  const outletId = typeof req.query.outletId === "string" ? req.query.outletId : undefined;
  res.json(rosterStore.warnings(outletId));
});

router.get("/shift-templates", (req, res) => {
  const outletId = typeof req.query.outletId === "string" ? req.query.outletId : undefined;
  res.json(rosterStore.listShiftTemplates(outletId));
});

router.post("/swap", (req, res) => {
  const { assignmentIdA, assignmentIdB } = req.body ?? {};
  if (typeof assignmentIdA !== "string" || typeof assignmentIdB !== "string") {
    return res.status(400).json({ error: "assignmentIdA and assignmentIdB are required" });
  }
  const result = rosterStore.swapAssignments(assignmentIdA, assignmentIdB);
  if (!result.ok) return res.status(409).json({ error: result.error });
  res.json({ ok: true });
});

router.post("/leave", (req, res) => {
  const { staffId, startDate, endDate, reason } = req.body ?? {};
  if (typeof staffId !== "string" || typeof startDate !== "string" || typeof endDate !== "string") {
    return res.status(400).json({ error: "staffId, startDate and endDate are required" });
  }
  if (endDate < startDate) {
    return res.status(400).json({ error: "endDate cannot be before startDate" });
  }
  const request = rosterStore.requestLeave({ staffId, startDate, endDate, reason });
  res.status(201).json(request);
});

router.get("/leave", (req, res) => {
  const staffId = typeof req.query.staffId === "string" ? req.query.staffId : undefined;
  res.json(rosterStore.listLeave(staffId));
});

router.post("/leave/:leaveRequestId/decision", (req, res) => {
  const { status } = req.body ?? {};
  if (status !== "approved" && status !== "denied") {
    return res.status(400).json({ error: "status must be 'approved' or 'denied'" });
  }
  const updated = rosterStore.decideLeave(req.params.leaveRequestId, status);
  if (!updated) return res.status(404).json({ error: "Leave request not found" });
  res.json(updated);
});

export default router;
