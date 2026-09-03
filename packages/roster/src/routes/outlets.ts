import { Router } from "express";
import { rosterStore } from "../rosterStore";

const router = Router();

router.get("/", (_req, res) => {
  res.json(rosterStore.listOutlets());
});

export default router;
