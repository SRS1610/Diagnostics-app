// netlify/functions/api.mts
//
// Netlify Functions adapter for the roster API. This is NOT the Express
// app in src/app.ts running as-is — Netlify Functions are stateless
// per-invocation (a "warm" container can be reused, but nothing
// guarantees it, and concurrent requests can land on different
// containers entirely), so the module-level `rosterStore` singleton
// that works fine for the long-running `npm run dev` Express server
// cannot be trusted to hold state between requests here.
//
// Instead, every invocation: (1) loads the persisted snapshot from
// Netlify Blobs and hydrates rosterStore from it, (2) performs the
// requested operation, (3) if anything changed, serializes the store
// back to Blobs. Blobs give this "last write wins" consistency, not
// transactional guarantees — acceptable for a demo scheduler, not for
// a real multi-writer production system (same caveat rosterStore.ts's
// module header already gives for the in-memory version).
//
// Routes intentionally mirror src/routes/*.ts exactly (same paths,
// same request/response shapes) so public/roster_dashboard.html needs
// no changes to work against either backend.

import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { assignmentsToCsv } from "../../src/csvExport";
import { rosterStore } from "../../src/rosterStore";
import { EmploymentType, Role, Weekday } from "../../src/types";

const VALID_ROLES: Role[] = ["duty_manager", "reception", "coach", "maintenance"];
const VALID_EMPLOYMENT_TYPES: EmploymentType[] = ["full_time", "part_time", "casual"];

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

function getBlobStore() {
  // Global (not deploy-specific) scope — the roster is meant to persist
  // across redeploys, not reset every time this function is redeployed.
  return getStore({ name: "roster-data" });
}

async function loadState(): Promise<void> {
  const store = getBlobStore();
  const state = await store.get("state", { type: "json" });
  if (state) rosterStore.hydrate(state as Parameters<typeof rosterStore.hydrate>[0]);
}

async function saveState(): Promise<void> {
  const store = getBlobStore();
  await store.setJSON("state", rosterStore.serialize());
}

export default async (req: Request, _context: Context): Promise<Response> => {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  await loadState();

  try {
    // GET /outlets
    if (method === "GET" && path === "/outlets") {
      return json(rosterStore.listOutlets());
    }

    // GET /staff
    if (method === "GET" && path === "/staff") {
      const outletId = url.searchParams.get("outletId") ?? undefined;
      return json(rosterStore.listStaff(outletId));
    }

    // POST /staff
    if (method === "POST" && path === "/staff") {
      const body: any = await req.json().catch(() => ({}));
      const { name, role, homeOutletId, employmentType, maxHoursPerWeek, availableDays } = body ?? {};

      if (typeof name !== "string" || !name.trim()) {
        return json({ error: "name is required" }, { status: 400 });
      }
      if (!VALID_ROLES.includes(role)) {
        return json({ error: `role must be one of ${VALID_ROLES.join(", ")}` }, { status: 400 });
      }
      if (!VALID_EMPLOYMENT_TYPES.includes(employmentType)) {
        return json({ error: `employmentType must be one of ${VALID_EMPLOYMENT_TYPES.join(", ")}` }, { status: 400 });
      }
      if (!rosterStore.listOutlets().some((o) => o.outletId === homeOutletId)) {
        return json({ error: "homeOutletId does not match a known outlet" }, { status: 400 });
      }
      if (typeof maxHoursPerWeek !== "number" || maxHoursPerWeek <= 0 || maxHoursPerWeek > 80) {
        return json({ error: "maxHoursPerWeek must be a number between 1 and 80" }, { status: 400 });
      }
      if (
        !Array.isArray(availableDays) ||
        availableDays.length === 0 ||
        !availableDays.every((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)
      ) {
        return json({ error: "availableDays must be a non-empty array of weekday numbers (0-6)" }, { status: 400 });
      }

      const created = rosterStore.addStaff({
        name: name.trim(),
        role,
        homeOutletId,
        employmentType,
        maxHoursPerWeek,
        availableDays: availableDays as Weekday[],
      });
      await saveState();
      return json(created, { status: 201 });
    }

    // DELETE /staff/:staffId
    if (method === "DELETE" && path.startsWith("/staff/")) {
      const staffId = path.slice("/staff/".length);
      const result = rosterStore.removeStaff(staffId);
      if (!result.ok) return json({ error: result.error }, { status: 404 });
      await saveState();
      return new Response(null, { status: 204 });
    }

    // GET /roster/shift-templates
    if (method === "GET" && path === "/roster/shift-templates") {
      const outletId = url.searchParams.get("outletId") ?? undefined;
      return json(rosterStore.listShiftTemplates(outletId));
    }

    // POST /roster/generate
    if (method === "POST" && path === "/roster/generate") {
      const body: any = await req.json().catch(() => ({}));
      const year = Number(body?.year);
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        return json({ error: "year must be a valid 4-digit year" }, { status: 400 });
      }
      const result = rosterStore.generateYear(year);
      await saveState();
      return json(result);
    }

    // GET /roster/assignments
    if (method === "GET" && path === "/roster/assignments") {
      const outletId = url.searchParams.get("outletId") ?? undefined;
      const month = url.searchParams.get("month") ?? undefined;
      const year = url.searchParams.get("year") ?? undefined;
      const staffId = url.searchParams.get("staffId") ?? undefined;
      return json(rosterStore.listAssignments({ outletId, month, year, staffId }));
    }

    // GET /roster/overview
    if (method === "GET" && path === "/roster/overview") {
      const month = url.searchParams.get("month");
      if (!month) return json({ error: "month (YYYY-MM) is required" }, { status: 400 });
      return json(rosterStore.summarizeOutlets(month));
    }

    // GET /roster/export
    if (method === "GET" && path === "/roster/export") {
      const outletId = url.searchParams.get("outletId");
      const month = url.searchParams.get("month");
      if (!outletId || !month) return json({ error: "outletId and month are required" }, { status: 400 });

      const assignments = rosterStore.listAssignments({ outletId, month });
      const csv = assignmentsToCsv({
        assignments,
        staff: rosterStore.listStaff(),
        shiftTemplates: rosterStore.listShiftTemplates(),
        outlets: rosterStore.listOutlets(),
      });
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="roster-${outletId}-${month}.csv"`,
        },
      });
    }

    // GET /roster/warnings
    if (method === "GET" && path === "/roster/warnings") {
      const outletId = url.searchParams.get("outletId") ?? undefined;
      return json(rosterStore.warnings(outletId));
    }

    // POST /roster/swap
    if (method === "POST" && path === "/roster/swap") {
      const body: any = await req.json().catch(() => ({}));
      const { assignmentIdA, assignmentIdB } = body ?? {};
      if (typeof assignmentIdA !== "string" || typeof assignmentIdB !== "string") {
        return json({ error: "assignmentIdA and assignmentIdB are required" }, { status: 400 });
      }
      const result = rosterStore.swapAssignments(assignmentIdA, assignmentIdB);
      if (!result.ok) return json({ error: result.error }, { status: 409 });
      await saveState();
      return json({ ok: true });
    }

    // POST /roster/leave
    if (method === "POST" && path === "/roster/leave") {
      const body: any = await req.json().catch(() => ({}));
      const { staffId, startDate, endDate, reason } = body ?? {};
      if (typeof staffId !== "string" || typeof startDate !== "string" || typeof endDate !== "string") {
        return json({ error: "staffId, startDate and endDate are required" }, { status: 400 });
      }
      if (endDate < startDate) {
        return json({ error: "endDate cannot be before startDate" }, { status: 400 });
      }
      const request = rosterStore.requestLeave({ staffId, startDate, endDate, reason });
      await saveState();
      return json(request, { status: 201 });
    }

    // GET /roster/leave
    if (method === "GET" && path === "/roster/leave") {
      const staffId = url.searchParams.get("staffId") ?? undefined;
      return json(rosterStore.listLeave(staffId));
    }

    // POST /roster/leave/:leaveRequestId/decision
    if (method === "POST" && path.startsWith("/roster/leave/") && path.endsWith("/decision")) {
      const leaveRequestId = path.slice("/roster/leave/".length, -"/decision".length);
      const body: any = await req.json().catch(() => ({}));
      const { status } = body ?? {};
      if (status !== "approved" && status !== "denied") {
        return json({ error: "status must be 'approved' or 'denied'" }, { status: 400 });
      }
      const updated = rosterStore.decideLeave(leaveRequestId, status);
      if (!updated) return json({ error: "Leave request not found" }, { status: 404 });
      await saveState();
      return json(updated);
    }

    return json({ error: "Not found" }, { status: 404 });
  } catch (err) {
    console.error(err);
    return json({ error: "Internal server error" }, { status: 500 });
  }
};

export const config: Config = {
  path: ["/outlets", "/staff", "/staff/*", "/roster/*"],
};
