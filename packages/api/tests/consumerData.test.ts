// tests/consumerData.test.ts
//
// The right-to-deletion path. Two things this proves that a "does it
// return 200" test wouldn't:
//   1. Scrubbing is tenant-scoped — one tenant asking to erase
//      updates@example.test must not touch the same address in another
//      tenant's reports.
//   2. The report itself survives — inspection results, timestamps, and
//      device serial are audit records, not personal data.

import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { Fixtures, prisma, resetDatabase, seedTwoTenants } from "./fixtures";
import { portalLogin } from "./helpers";
import { mintConsumerToken } from "../src/lib/consumerToken";

let app: Express;
let fx: Fixtures;

beforeAll(() => {
  app = createApp();
});

beforeEach(async () => {
  fx = await seedTwoTenants();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function seedContactedReport(tenantId: string, email: string | null, phone: string | null, opts: { serial?: string } = {}) {
  return prisma.report.create({
    data: {
      tenantId,
      deviceMake: "Apple",
      deviceModel: "iPhone 13",
      serialNumber: opts.serial ?? `EX-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      imei: "356938035643809",
      captureSource: "manual",
      results: [],
      overallStatus: "pass",
      consumerToken: mintConsumerToken(),
      consumerEmail: email,
      consumerPhone: phone,
    },
  });
}

describe("GET /consumer-data (preview)", () => {
  it("returns matching reports for an email, case-insensitively", async () => {
    await seedContactedReport(fx.alpha.tenantId, "Updates@Example.Test", null);
    const token = await portalLogin(app, fx.alpha.adminEmail);

    const res = await request(app).get("/consumer-data?email=updates@example.test").set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.reports.total).toBe(1);
    expect(res.body.reports.sample).toHaveLength(1);
    expect(res.body.disputes.total).toBe(0);
  });

  it("does not surface another tenant's rows", async () => {
    await seedContactedReport(fx.alpha.tenantId, "shared@example.test", null);
    await seedContactedReport(fx.beta.tenantId, "shared@example.test", null);

    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).get("/consumer-data?email=shared@example.test").set(auth(token));
    expect(res.body.reports.total).toBe(1); // alpha only
  });

  it("requires at least one selector", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).get("/consumer-data").set(auth(token));
    expect(res.status).toBe(400);
  });
});

describe("POST /consumer-data/erase", () => {
  it("scrubs email and phone from every matching report in this tenant only", async () => {
    const a1 = await seedContactedReport(fx.alpha.tenantId, "erase.me@example.test", "+15551110000");
    const a2 = await seedContactedReport(fx.alpha.tenantId, "erase.me@example.test", null);
    const bSame = await seedContactedReport(fx.beta.tenantId, "erase.me@example.test", "+15551110000");

    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app)
      .post("/consumer-data/erase")
      .set(auth(token))
      .send({ email: "erase.me@example.test", reason: "Data subject request DSR-42" });
    expect(res.status).toBe(200);
    expect(res.body.erasedReports).toBe(2);

    const after1 = await prisma.report.findUnique({ where: { reportId: a1.reportId } });
    const after2 = await prisma.report.findUnique({ where: { reportId: a2.reportId } });
    const afterBeta = await prisma.report.findUnique({ where: { reportId: bSame.reportId } });

    expect(after1?.consumerEmail).toBeNull();
    expect(after1?.consumerPhone).toBeNull();
    expect(after2?.consumerEmail).toBeNull();
    // Beta's report — same email but different tenant — untouched.
    expect(afterBeta?.consumerEmail).toBe("erase.me@example.test");
    expect(afterBeta?.consumerPhone).toBe("+15551110000");
  });

  it("preserves the report as an audit record (results, serial, timestamps intact)", async () => {
    const seeded = await seedContactedReport(fx.alpha.tenantId, "keep.audit@example.test", null, { serial: "AUDIT-1" });
    const token = await portalLogin(app, fx.alpha.adminEmail);
    await request(app)
      .post("/consumer-data/erase")
      .set(auth(token))
      .send({ email: "keep.audit@example.test", reason: "DSR" });

    const after = await prisma.report.findUnique({ where: { reportId: seeded.reportId } });
    expect(after).not.toBeNull();
    expect(after?.serialNumber).toBe("AUDIT-1");
    expect(after?.overallStatus).toBe("pass");
  });

  it("redacts the customerNote on matching disputes rather than deleting them", async () => {
    const reported = await seedContactedReport(fx.alpha.tenantId, "dispute.me@example.test", null);
    const dispute = await prisma.dispute.create({
      data: {
        tenantId: fx.alpha.tenantId,
        reportId: reported.reportId,
        disputingItem: "battery_health",
        customerNote: "My name is Jane Doe and I disagree with this result",
        status: "awaiting_review",
      },
    });

    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app)
      .post("/consumer-data/erase")
      .set(auth(token))
      .send({ email: "dispute.me@example.test", reason: "DSR" });
    expect(res.body.redactedDisputes).toBe(1);

    const after = await prisma.dispute.findUnique({ where: { disputeId: dispute.disputeId } });
    expect(after).not.toBeNull();
    expect(after?.customerNote).not.toContain("Jane Doe");
    expect(after?.customerNote).toMatch(/erased/i);
    expect(after?.disputingItem).toBe("battery_health"); // structural fields intact
  });

  it("writes one activity-log entry per erased report", async () => {
    await seedContactedReport(fx.alpha.tenantId, "audit.trail@example.test", null);
    await seedContactedReport(fx.alpha.tenantId, "audit.trail@example.test", null);
    const token = await portalLogin(app, fx.alpha.adminEmail);
    await request(app)
      .post("/consumer-data/erase")
      .set(auth(token))
      .send({ email: "audit.trail@example.test", reason: "DSR-99" });

    const entries = await prisma.activityLogEntry.findMany({
      where: { tenantId: fx.alpha.tenantId, action: "consumer_data_erased" },
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]!.details).toBe("DSR-99");
  });

  it("requires a reason", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app)
      .post("/consumer-data/erase")
      .set(auth(token))
      .send({ email: "x@example.test" });
    expect(res.status).toBe(400);
  });

  it("refuses tenant_staff", async () => {
    const staffEmail = "staff.privacy@alpha.test";
    await prisma.portalUser.create({
      data: {
        email: staffEmail,
        passwordHash: (await prisma.portalUser.findFirst({ where: { email: fx.alpha.adminEmail } }))!.passwordHash,
        role: "tenant_staff",
        tenantId: fx.alpha.tenantId,
      },
    });
    const staffToken = await portalLogin(app, staffEmail);
    const res = await request(app)
      .post("/consumer-data/erase")
      .set(auth(staffToken))
      .send({ email: "someone@example.test", reason: "DSR" });
    expect(res.status).toBe(403);
  });

  it("is a no-op when nothing matches (no rows, no audit entries)", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const before = await prisma.activityLogEntry.count({
      where: { tenantId: fx.alpha.tenantId, action: "consumer_data_erased" },
    });
    const res = await request(app)
      .post("/consumer-data/erase")
      .set(auth(token))
      .send({ email: "nobody@example.test", reason: "DSR" });
    expect(res.status).toBe(200);
    expect(res.body.erasedReports).toBe(0);

    const after = await prisma.activityLogEntry.count({
      where: { tenantId: fx.alpha.tenantId, action: "consumer_data_erased" },
    });
    expect(after).toBe(before);
  });
});
