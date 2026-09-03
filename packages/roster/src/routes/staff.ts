import { Router } from "express";
import { rosterStore } from "../rosterStore";

const router = Router();

router.get("/", (req, res) => {
  const outletId = typeof req.query.outletId === "string" ? req.query.outletId : undefined;
  res.json(rosterStore.listStaff(outletId));
});

export default router;
