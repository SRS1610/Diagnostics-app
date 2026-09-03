import { Router } from "express";
import { rosterStore } from "../rosterStore";
import { EmploymentType, Role, Weekday } from "../types";

const VALID_ROLES: Role[] = ["duty_manager", "reception", "coach", "maintenance"];
const VALID_EMPLOYMENT_TYPES: EmploymentType[] = ["full_time", "part_time", "casual"];

const router = Router();

router.get("/", (req, res) => {
  const outletId = typeof req.query.outletId === "string" ? req.query.outletId : undefined;
  res.json(rosterStore.listStaff(outletId));
});

router.post("/", (req, res) => {
  const { name, role, homeOutletId, employmentType, maxHoursPerWeek, availableDays } = req.body ?? {};

  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of ${VALID_ROLES.join(", ")}` });
  }
  if (!VALID_EMPLOYMENT_TYPES.includes(employmentType)) {
    return res.status(400).json({ error: `employmentType must be one of ${VALID_EMPLOYMENT_TYPES.join(", ")}` });
  }
  if (!rosterStore.listOutlets().some((o) => o.outletId === homeOutletId)) {
    return res.status(400).json({ error: "homeOutletId does not match a known outlet" });
  }
  if (typeof maxHoursPerWeek !== "number" || maxHoursPerWeek <= 0 || maxHoursPerWeek > 80) {
    return res.status(400).json({ error: "maxHoursPerWeek must be a number between 1 and 80" });
  }
  if (!Array.isArray(availableDays) || availableDays.length === 0 || !availableDays.every((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)) {
    return res.status(400).json({ error: "availableDays must be a non-empty array of weekday numbers (0-6)" });
  }

  const created = rosterStore.addStaff({
    name: name.trim(),
    role,
    homeOutletId,
    employmentType,
    maxHoursPerWeek,
    availableDays: availableDays as Weekday[],
  });
  res.status(201).json(created);
});

router.delete("/:staffId", (req, res) => {
  const result = rosterStore.removeStaff(req.params.staffId);
  if (!result.ok) return res.status(404).json({ error: result.error });
  res.status(204).end();
});

export default router;
