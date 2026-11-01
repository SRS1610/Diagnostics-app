// POST /internal/run-jobs — runs due follow-ups/reminders and weekly
// digests once. For hosts where the server sleeps between requests
// (Cloudflare Containers): a scheduler calls this instead of relying on the
// in-process timer. Disabled unless INTERNAL_JOBS_SECRET is set, and every
// call must present that secret.

import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Deps } from "../core/deps";
import { sendDigests } from "../core/digest";
import { runDueJobs } from "../core/jobs";

const MIN_SECRET_LENGTH = 32;

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function internalRoutes(deps: Deps, secret = process.env.INTERNAL_JOBS_SECRET ?? ""): Router {
  const r = Router();
  if (secret.length < MIN_SECRET_LENGTH) return r; // not configured → endpoint doesn't exist
  let running = false;
  r.post("/run-jobs", async (req, res) => {
    if (!sameSecret(req.header("x-internal-secret") ?? "", secret)) return res.status(404).end();
    if (running) return res.json({ ok: true, skipped: "already running" });
    running = true;
    try {
      const jobs = await runDueJobs(deps);
      const digests = await sendDigests(deps);
      res.json({ ok: true, jobs, digests });
    } finally {
      running = false;
    }
  });
  return r;
}
