// src/index.ts
//
// Server entry point. Run with: npm run dev --workspace=packages/api
// (or `npm run dev:api` from the repo root).
//
// The app itself lives in app.ts so tests can import it without binding
// a port; this file only loads config, listens, and installs the
// process-level guards that belong to a running server rather than to
// the app object.

import dotenv from "dotenv";

dotenv.config();

// Imported AFTER dotenv.config(): middleware/auth.ts and
// middleware/technicianAuth.ts read JWT_SECRET at module load and throw
// if it's missing, so the env has to be populated first.
// eslint-disable-next-line import/first
import { createApp } from "./app";

const app = createApp();

// Last-resort process guards. With express-async-errors in place these
// should not fire for route errors, but a rejection from a timer,
// background task, or a module outside the request lifecycle would still
// terminate the process by default. For a shared API, staying up and
// loudly logging beats dropping every tenant's in-flight session.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (process kept alive):", reason);
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception (process kept alive):", error);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
