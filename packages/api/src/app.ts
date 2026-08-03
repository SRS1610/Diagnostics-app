// src/app.ts
//
// Builds the Express app WITHOUT binding a port, so tests can drive it
// in-process via supertest while index.ts does the actual listening.
// Splitting these apart is the whole reason the API is testable at all —
// importing index.ts directly would start a real server on every test run.

// MUST be imported before any route module. Express 4 does not catch
// rejections from async route handlers — a thrown/rejected error inside
// `async (req, res) => {...}` becomes an unhandled rejection, which on
// Node's default behavior EXITS THE PROCESS. Every route in this API is
// an async handler touching Prisma, so before this import a single
// unexpected DB error took the whole API down for every tenant.
//
// This was not theoretical: deleting a technician (an ordinary admin
// action) while that technician's tablet submitted a report produced a
// P2003 foreign-key violation in POST /reports and killed the server.
// This package patches the Router so async errors reach the
// error-handling middleware at the bottom of this file instead.
// Alternative fixes were an asyncHandler wrapper on all ~30 handlers
// (easy for a future route to forget) or upgrading to Express 5 (fixes
// this natively, but a larger change).
import "express-async-errors";

import express, { NextFunction, Request, Response } from "express";
import cors from "cors";

import authRoutes from "./routes/auth";
import reportsRoutes from "./routes/reports";
import tenantsRoutes from "./routes/tenants";
import profilesRoutes from "./routes/profiles";
import licensesRoutes from "./routes/licenses";
import techniciansRoutes from "./routes/technicians";
import activityLogRoutes from "./routes/activityLog";

export function createApp() {
  const app = express();
  app.use(cors());
  // Explicit rather than relying on body-parser's 100kb default — a report
  // carries a full DiagnosticResult[] and this cap should be a decision,
  // not an accident. Raise deliberately if real test payloads approach it.
  app.use(express.json({ limit: "256kb" }));

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

  // Catch-all error handler. Must be registered AFTER all routes, and must
  // take four arguments — that arity is how Express identifies it.
  //
  // Deliberately opaque to the client: internal error text can leak schema
  // and query shape, which in a multi-tenant system is exactly the sort of
  // detail that helps someone probe for other tenants' structure. Routes
  // that can produce a *meaningful* client error (a duplicate PIN, a
  // revoked technician) handle it themselves and return a specific status;
  // anything reaching here is genuinely unexpected and gets a generic 500.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Unhandled error:", err);
    if (res.headersSent) return;

    // Middleware like express.json() throws http-errors carrying a status:
    // an oversized body is 413 and malformed JSON is 400, and flattening
    // those to 500 would tell a client its own bad request was our fault.
    // Honour 4xx statuses, but answer with a fixed message per status
    // rather than the error's own text — the status is safe to reflect,
    // arbitrary internal message text is not.
    const status =
      (err as { status?: number; statusCode?: number })?.status ??
      (err as { statusCode?: number })?.statusCode;

    if (typeof status === "number" && status >= 400 && status < 500) {
      const message =
        status === 413 ? "Request body too large" : status === 400 ? "Malformed request" : "Request rejected";
      return res.status(status).json({ error: message });
    }

    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
