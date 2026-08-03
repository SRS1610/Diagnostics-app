// tests/reportArtifacts.test.ts
//
// Revisions, wipe certificates, disputes, warranty claims and invoices
// are all sub-resources: none of them carries a tenantId column, so
// their tenant boundary is the parent lookup, not a filter on their own
// table. That makes them a different — and easier to get wrong — shape
// from the resources covered in tenantIsolation.test.ts, so they get
// their own isolation assertions rather than being assumed safe.

import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { Fixtures, prisma, resetDatabase, seedTwoTenants } from "./fixtures";
import { portalLogin, technicianLogin } from "./helpers";

let app: Express;
let fx: Fixtures;
let alphaToken: string;
let alphaTech: string;

beforeAll(() => {
  app = createApp();
});

beforeEach(async () => {
  fx = await seedTwoTenants();
  alphaToken = await portalLogin(app, fx.alpha.adminEmail);
  alphaTech = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe("report revisions", () => {
  it("appends a revision to an existing report rather than minting a new one", async () => {
    const res = await request(app)
      .post(`/reports/${fx.alpha.reportId}/revisions`)
      .set("Authorization", `Bearer ${alphaTech}`)
      .send({ testIdsRedone: ["battery_health"], reason: "OCR misread" });

    expect(res.status).toBe(201);
    expect(res.body.reportId).toBe(fx.alpha.reportId);
    expect(res.body.revisionNumber).toBe(1);
    expect(await prisma.report.count({ where: { tenantId: fx.alpha.tenantId } })).toBe(1);
  });

  it("numbers revisions sequentially", async () => {
    for (const expected of [1, 2, 3]) {
      const res = await request(app)
        .post(`/reports/${fx.alpha.reportId}/revisions`)
        .set("Authorization", `Bearer ${alphaTech}`)
        .send({ testIdsRedone: ["loud_speaker"] });
      expect(res.body.revisionNumber).toBe(expected);
    }
  });

  // The parent lookup is the only thing standing between a technician
  // and another tenant's report here.
  it("refuses to attach a revision to another tenant's report", async () => {
    const res = await request(app)
      .post(`/reports/${fx.beta.reportId}/revisions`)
      .set("Authorization", `Bearer ${alphaTech}`)
      .send({ testIdsRedone: ["battery_health"] });

    expect(res.status).toBe(404);
    expect(await prisma.reportRevision.count({ where: { reportId: fx.beta.reportId } })).toBe(0);
  });

  it("does not expose another tenant's revisions", async () => {
    const res = await request(app)
      .get(`/reports/${fx.beta.reportId}/revisions`)
      .set("Authorization", `Bearer ${alphaToken}`);
    expect(res.status).toBe(404);
  });

  // REGRESSION. Revision numbers were computed with count-then-insert
  // inside a transaction, which does not serialise under Postgres's
  // default READ COMMITTED — a plain count takes no lock. Eight
  // concurrent requests produced 1,2,2,2,2,5,6,7: four revisions
  // labelled R2, and no R3 or R4. Now serialised by a row lock on the
  // parent report, with a unique constraint as the backstop.
  it("numbers concurrent revisions on one report without duplicates", async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app)
          .post(`/reports/${fx.alpha.reportId}/revisions`)
          .set("Authorization", `Bearer ${alphaTech}`)
          .send({ testIdsRedone: ["battery_health"] }),
      ),
    );
    // A 409 is an acceptable outcome (the client retries); a duplicate
    // number is not.
    expect(responses.every((r) => r.status === 201 || r.status === 409)).toBe(true);

    const rows = await prisma.reportRevision.findMany({
      where: { reportId: fx.alpha.reportId },
      orderBy: { revisionNumber: "asc" },
    });
    const numbers = rows.map((r) => r.revisionNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
    // Gapless from 1 — the display convention (R1, R2, ...) depends on it.
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1));
  });

  it("attributes the revision to a technician, not a portal role", async () => {
    await request(app)
      .post(`/reports/${fx.alpha.reportId}/revisions`)
      .set("Authorization", `Bearer ${alphaTech}`)
      .send({ testIdsRedone: ["battery_health"] });

    const entry = await prisma.activityLogEntry.findFirst({
      where: { tenantId: fx.alpha.tenantId, action: "report_revision_created" },
    });
    // actorUserId points into Technician, so labelling it with a portal
    // role would send an auditor to the wrong table.
    expect(entry?.actorRole).toBe("technician");
    expect(entry?.actorUserId).toBe(fx.alpha.technicianId);
  });

  it("rejects an empty redo list", async () => {
    const res = await request(app)
      .post(`/reports/${fx.alpha.reportId}/revisions`)
      .set("Authorization", `Bearer ${alphaTech}`)
      .send({ testIdsRedone: [] });
    expect(res.status).toBe(400);
  });
});

describe("data wipe certificate", () => {
  const cert = { standard: "nist_800_88_purge", passed: true };

  it("records a certificate against the report", async () => {
    const res = await request(app)
      .post(`/reports/${fx.alpha.reportId}/wipe-certificate`)
      .set("Authorization", `Bearer ${alphaTech}`)
      .send(cert);

    expect(res.status).toBe(201);
    expect(res.body.standard).toBe("nist_800_88_purge");
    // Copied from the report, not accepted from the caller.
    expect(res.body.deviceSerial).toBe("SERIAL-Alpha");
  });

  // A failed erasure that goes unrecorded is the exact situation the
  // attestation exists to prevent, so it must be recordable.
  it("records a FAILED wipe as a legitimate certificate", async () => {
    const res = await request(app)
      .post(`/reports/${fx.alpha.reportId}/wipe-certificate`)
      .set("Authorization", `Bearer ${alphaTech}`)
      .send({ standard: "nist_800_88_clear", passed: false });

    expect(res.status).toBe(201);
    expect(res.body.passed).toBe(false);
  });

  // Defaulting either way would put a claim in the record that nobody made.
  it("requires the outcome to be stated explicitly", async () => {
    const res = await request(app)
      .post(`/reports/${fx.alpha.reportId}/wipe-certificate`)
      .set("Authorization", `Bearer ${alphaTech}`)
      .send({ standard: "nist_800_88_clear" });
    expect(res.status).toBe(400);
  });

  // Overwriting would destroy the record of what was originally certified.
  it("refuses to replace an existing certificate", async () => {
    await request(app)
      .post(`/reports/${fx.alpha.reportId}/wipe-certificate`)
      .set("Authorization", `Bearer ${alphaTech}`)
      .send(cert);

    const second = await request(app)
      .post(`/reports/${fx.alpha.reportId}/wipe-certificate`)
      .set("Authorization", `Bearer ${alphaTech}`)
      .send({ standard: "nist_800_88_clear", passed: false });

    expect(second.status).toBe(409);
    const stored = await prisma.dataWipeCertificate.findUnique({ where: { reportId: fx.alpha.reportId } });
    expect(stored?.standard).toBe("nist_800_88_purge");
    expect(stored?.passed).toBe(true);
  });

  it("refuses to certify another tenant's report", async () => {
    const res = await request(app)
      .post(`/reports/${fx.beta.reportId}/wipe-certificate`)
      .set("Authorization", `Bearer ${alphaTech}`)
      .send(cert);
    expect(res.status).toBe(404);
  });

  it("rejects an unknown erasure standard", async () => {
    const res = await request(app)
      .post(`/reports/${fx.alpha.reportId}/wipe-certificate`)
      .set("Authorization", `Bearer ${alphaTech}`)
      .send({ standard: "wiped_it_a_bit", passed: true });
    expect(res.status).toBe(400);
  });
});

describe("disputes", () => {
  const filing = { disputingItem: "overall grade", customerNote: "Screen was fine when I sent it." };

  const fileDispute = (reportId: string, token = alphaToken) =>
    request(app).post("/disputes").set("Authorization", `Bearer ${token}`).send({ reportId, ...filing });

  it("files a dispute against the caller's own report", async () => {
    const res = await fileDispute(fx.alpha.reportId);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("awaiting_review");
  });

  // Otherwise a dispute could put ANOTHER tenant's device on hold.
  it("refuses to file against another tenant's report", async () => {
    const res = await fileDispute(fx.beta.reportId);
    expect(res.status).toBe(404);
    expect(await prisma.dispute.count({ where: { tenantId: fx.beta.tenantId } })).toBe(0);
  });

  it("reports an open dispute as a hold on the report", async () => {
    await fileDispute(fx.alpha.reportId);
    const res = await request(app)
      .get(`/disputes/holds/${fx.alpha.reportId}`)
      .set("Authorization", `Bearer ${alphaToken}`);
    expect(res.body.onHold).toBe(true);
  });

  it("clears the hold once resolved", async () => {
    const filed = await fileDispute(fx.alpha.reportId);
    await request(app)
      .post(`/disputes/${filed.body.disputeId}/resolve`)
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ outcome: "uphold", resolutionNotes: "Photos show pre-existing damage." });

    const res = await request(app)
      .get(`/disputes/holds/${fx.alpha.reportId}`)
      .set("Authorization", `Bearer ${alphaToken}`);
    expect(res.body.onHold).toBe(false);
  });

  // An adjusted grade with no stated reason is unauditable.
  it("requires reasoning to resolve", async () => {
    const filed = await fileDispute(fx.alpha.reportId);
    const res = await request(app)
      .post(`/disputes/${filed.body.disputeId}/resolve`)
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ outcome: "adjust" });
    expect(res.status).toBe(400);
  });

  // Re-resolving would overwrite the original decision and its reasoning.
  it("refuses to re-resolve", async () => {
    const filed = await fileDispute(fx.alpha.reportId);
    const body = { outcome: "uphold", resolutionNotes: "Upheld." };
    await request(app)
      .post(`/disputes/${filed.body.disputeId}/resolve`)
      .set("Authorization", `Bearer ${alphaToken}`)
      .send(body);

    const second = await request(app)
      .post(`/disputes/${filed.body.disputeId}/resolve`)
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ outcome: "adjust", resolutionNotes: "Changed my mind." });
    expect(second.status).toBe(409);
  });

  it("does not list another tenant's disputes", async () => {
    await fileDispute(fx.alpha.reportId);
    const betaToken = await portalLogin(app, fx.beta.adminEmail);
    const res = await request(app).get("/disputes").set("Authorization", `Bearer ${betaToken}`);
    expect(res.body).toHaveLength(0);
  });
});

describe("warranty claims", () => {
  const claim = { claimedIssue: "Battery drains overnight" };

  it("files a claim and computes expiry from the inspection date", async () => {
    const res = await request(app)
      .post("/warranty-claims")
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ reportId: fx.alpha.reportId, ...claim });

    expect(res.status).toBe(201);
    expect(res.body.deviceSerial).toBe("SERIAL-Alpha");
    expect(res.body.withinWarranty).toBe(true);
  });

  // A client-supplied expiry could extend a warranty arbitrarily.
  it("ignores a caller-supplied expiry date", async () => {
    const res = await request(app)
      .post("/warranty-claims")
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ reportId: fx.alpha.reportId, ...claim, warrantyExpiresAt: "2099-01-01T00:00:00Z" });

    expect(new Date(res.body.warrantyExpiresAt).getFullYear()).toBeLessThan(2099);
  });

  it("refuses to file against another tenant's report", async () => {
    const res = await request(app)
      .post("/warranty-claims")
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ reportId: fx.beta.reportId, ...claim });
    expect(res.status).toBe(404);
  });

  it("requires reasoning to approve or deny", async () => {
    const filed = await request(app)
      .post("/warranty-claims")
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ reportId: fx.alpha.reportId, ...claim });

    const res = await request(app)
      .patch(`/warranty-claims/${filed.body.claimId}`)
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ status: "denied" });
    expect(res.status).toBe(400);
  });

  it("does not list another tenant's claims", async () => {
    await request(app)
      .post("/warranty-claims")
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ reportId: fx.alpha.reportId, ...claim });

    const betaToken = await portalLogin(app, fx.beta.adminEmail);
    const res = await request(app).get("/warranty-claims").set("Authorization", `Bearer ${betaToken}`);
    expect(res.body).toHaveLength(0);
  });
});

describe("invoices", () => {
  it("generates a draft invoice from licence usage", async () => {
    await prisma.license.update({
      where: { licenseId: fx.alpha.licenseId },
      data: { usageThisPeriod: 20 },
    });

    const res = await request(app)
      .post("/invoices")
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ licenseId: fx.alpha.licenseId });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("draft");
    // per_inspection at 2.5 per credit — real pricing, so no placeholder.
    expect(res.body.total).toBe(50);
    expect(res.body.pricingIncomplete).toBe(false);
  });

  // Sending a customer a bill computed from placeholder zero prices is a
  // real-money error, so the response says so rather than burying it.
  it("flags an invoice whose pricing is still placeholder", async () => {
    const seat = await prisma.license.create({
      data: {
        tenantId: fx.beta.tenantId,
        type: "seat_subscription",
        status: "expired", // avoid the one-active-licence constraint
        billingPeriodStart: new Date("2026-08-01"),
        billingPeriodEnd: new Date("2026-08-31"),
        seatLimit: 5,
      },
    });

    const betaToken = await portalLogin(app, fx.beta.adminEmail);
    const res = await request(app)
      .post("/invoices")
      .set("Authorization", `Bearer ${betaToken}`)
      .send({ licenseId: seat.licenseId });

    expect(res.status).toBe(201);
    expect(res.body.pricingIncomplete).toBe(true);
    expect(res.body.pricingWarning).toMatch(/not invoiceable/i);
  });

  it("refuses to invoice another tenant's licence", async () => {
    const res = await request(app)
      .post("/invoices")
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ licenseId: fx.beta.licenseId });
    expect(res.status).toBe(404);
  });

  it("does not list another tenant's invoices", async () => {
    await request(app)
      .post("/invoices")
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ licenseId: fx.alpha.licenseId });

    const betaToken = await portalLogin(app, fx.beta.adminEmail);
    const res = await request(app).get("/invoices").set("Authorization", `Bearer ${betaToken}`);
    expect(res.body).toHaveLength(0);
  });
});
