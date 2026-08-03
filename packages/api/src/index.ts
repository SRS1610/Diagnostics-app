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

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/auth", authRoutes);
app.use("/reports", reportsRoutes);
app.use("/tenants", tenantsRoutes);

// TODO (Sprint 2): profiles, licenses, technicians, disputes,
// activity-log routes — follow the pattern in routes/reports.ts for
// every tenant-scoped resource.

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
