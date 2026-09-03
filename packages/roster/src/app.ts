// src/app.ts
//
// Builds the Express app without binding a port, so tests can drive it
// in-process via supertest — same split as packages/api/src/app.ts.

import "express-async-errors";

import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import path from "path";

import outletsRoutes from "./routes/outlets";
import staffRoutes from "./routes/staff";
import rosterRoutes from "./routes/roster";

export function buildApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "roster_dashboard.html")));
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/outlets", outletsRoutes);
  app.use("/staff", staffRoutes);
  app.use("/roster", rosterRoutes);

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
