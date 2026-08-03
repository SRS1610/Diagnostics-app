// src/index.ts
//
// Server entry point. Run with: npm run dev --workspace=packages/api
// (or `npm run dev:api` from the repo root).

import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import authRoutes from "./routes/auth";
import reportsRoutes from "./routes/reports";
import tenantsRoutes from "./routes/tenants";
import profilesRoutes from "./routes/profiles";
import licensesRoutes from "./routes/licenses";
import techniciansRoutes from "./routes/technicians";
import activityLogRoutes from "./routes/activityLog";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/auth", authRoutes);
app.use("/reports", reportsRoutes);
app.use("/tenants", tenantsRoutes);
app.use("/profiles", profilesRoutes);
app.use("/licenses", licensesRoutes);
app.use("/technicians", techniciansRoutes);
app.use("/activity-log", activityLogRoutes);

// TODO (Sprint 2+): dispute routes — the Dispute model exists in
// schema.prisma but resolution actions aren't wired to backend logic
// yet (admin_portal_disputes.html buttons are still mockup-only per
// CLAUDE.md "Admin activity log" section).

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
