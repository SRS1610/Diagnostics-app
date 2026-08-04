// tests/exportAndCompliance.test.ts
//
// CSV export and the compliance summary.
//
// The export tests care about two things a naive implementation gets
// wrong: a spreadsheet is the most-forwarded artefact this system
// produces, so it must not carry capability tokens or another tenant's
// rows; and a CSV opened in Excel executes cells that begin with "=",
// so any text a person typed is a potential formula.
//
// The compliance tests care about one thing: a number that is quietly
// wrong is worse than no number, and the usual way to get one is to
// divide by a denominator that silently excludes the awkward rows.

import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { Fixtures, prisma, resetDatabase, seedTwoTenants } from "./fixtures";
import { portalLogin } from "./helpers";
import { mintConsumerToken } from "../src/lib/consumerToken";
import { csvCell } from "../src/lib/csv";

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

async function makeReport(tenantId: string, overrides: Record<string, unknown> = {}) {
  return prisma.report.create({
    data: {
      tenantId,
      deviceMake: "Apple",
      deviceModel: "iPhone 13",
      serialNumber: `SER-${Math.random().toString(36).slice(2, 8)}`,
      imei: "356938035643809",
      captureSource: "barcode",
      results: [],
      overallStatus: "pass",
      consumerToken: mintConsumerToken(),
      ...overrides,
    },
  });
}

describe("CSV escaping", () => {
  it("defuses a cell that a spreadsheet would run as a formula", () => {
    // The attack: a note that becomes a live formula when opened.
    const evil = '=HYPERLINK("https://evil.example","Click")';
    const cell = csvCell(evil);

    expect(cell.startsWith('"\'=') || cell.startsWith("'=")).toBe(true);
    // The text is preserved — only its interpretation changes.
    expect(cell).toContain("HYPERLINK");
  });

  it("defuses every prefix a spreadsheet treats as a formula", () => {
    for (const prefix of ["=", "+", "-", "@"]) {
      expect(csvCell(`${prefix}SUM(A1:A9)`).replace(/^"/, "").startsWith("'")).toBe(true);
    }
  });

  it("escapes quotes, commas and newlines without mangling them", () => {
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("leaves ordinary text alone", () => {
    expect(csvCell("iPhone 13")).toBe("iPhone 13");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(null)).toBe("");
  });
});

describe("exporting inspections", () => {
  it("returns a CSV attachment with a dated filename", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).get("/reports/export.csv").set(auth(token));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/attachment.*inspections-\d{4}-\d{2}-\d{2}\.csv/);
  });

  it("is not swallowed by the /:reportId route", async () => {
    // Express matches in declaration order; with the export declared
    // after the parameterised route this 404s as a report named
    // "export.csv".
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).get("/reports/export.csv").set(auth(token));
    expect(res.status).not.toBe(404);
  });

  it("never includes a consumer token", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const report = await prisma.report.findUnique({ where: { reportId: fx.alpha.reportId } });

    const res = await request(app).get("/reports/export.csv").set(auth(token));
    // A spreadsheet is the most forwarded thing this system produces.
    expect(res.text).not.toContain(report!.consumerToken);
    expect(res.text.toLowerCase()).not.toContain("consumertoken");
  });

  it("exports only this tenant's inspections", async () => {
    await makeReport(fx.beta.tenantId, { serialNumber: "BETA-ONLY-SERIAL" });
    const token = await portalLogin(app, fx.alpha.adminEmail);

    const res = await request(app).get("/reports/export.csv").set(auth(token));
    expect(res.text).not.toContain("BETA-ONLY-SERIAL");
    expect(res.text).toContain("SERIAL-Alpha");
  });

  it("honours the same filters as the list, so you export what you were looking at", async () => {
    await makeReport(fx.alpha.tenantId, { serialNumber: "FAILING-DEVICE", overallStatus: "fail" });
    const token = await portalLogin(app, fx.alpha.adminEmail);

    const failed = await request(app).get("/reports/export.csv?status=fail").set(auth(token));
    expect(failed.text).toContain("FAILING-DEVICE");
    expect(failed.text).not.toContain("SERIAL-Alpha"); // the fixture's passing report
  });

  it("carries a technician's name so an export is attributable", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).get("/reports/export.csv").set(auth(token));
    expect(res.text).toContain("Alpha Tech");
  });

  it("defuses a formula that arrived through a real report field", async () => {
    // End to end rather than unit: the model name is caller-supplied.
    await makeReport(fx.alpha.tenantId, { deviceModel: "=1+1" });
    const token = await portalLogin(app, fx.alpha.adminEmail);

    const res = await request(app).get("/reports/export.csv").set(auth(token));
    expect(res.text).toContain("'=1+1");
  });
});

describe("compliance summary", () => {
  it("counts each routing decision and states the period", async () => {
    await makeReport(fx.alpha.tenantId, { routing: "resale" });
    await makeReport(fx.alpha.tenantId, { routing: "resale" });
    await makeReport(fx.alpha.tenantId, { routing: "recycle" });

    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).get("/compliance/summary").set(auth(token));

    expect(res.status).toBe(200);
    const resale = res.body.routing.find((r: { decision: string }) => r.decision === "resale");
    expect(resale.count).toBe(2);
    expect(res.body.period.generatedAt).toEqual(expect.any(String));
  });

  it("counts unrouted devices rather than dropping them from the denominator", async () => {
    // The fixture's own report has no routing; two resold.
    await makeReport(fx.alpha.tenantId, { routing: "resale" });
    await makeReport(fx.alpha.tenantId, { routing: "resale" });

    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).get("/compliance/summary").set(auth(token));

    expect(res.body.unrouted.count).toBe(1);
    expect(res.body.totalInspections).toBe(3);

    // 2 of 3, not 2 of 2. Excluding the unrouted device would report
    // 100% resold for a period in which a third was never routed.
    const resale = res.body.routing.find((r: { decision: string }) => r.decision === "resale");
    expect(resale.percentage).toBeCloseTo(66.7, 1);
  });

  it("never counts another tenant's devices", async () => {
    for (let i = 0; i < 5; i += 1) await makeReport(fx.beta.tenantId, { routing: "recycle" });

    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).get("/compliance/summary").set(auth(token));

    const recycled = res.body.routing.find((r: { decision: string }) => r.decision === "recycle");
    expect(recycled.count).toBe(0);
    expect(res.body.totalInspections).toBe(1); // just the fixture's
  });

  it("respects a date range", async () => {
    await makeReport(fx.alpha.tenantId, {
      routing: "resale",
      generatedAt: new Date("2020-01-01"),
    });

    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).get("/compliance/summary?from=2025-01-01").set(auth(token));

    const resale = res.body.routing.find((r: { decision: string }) => r.decision === "resale");
    expect(resale.count).toBe(0);
    expect(res.body.period.from).toContain("2025-01-01");
  });

  it("counts only PASSED erasure certificates", async () => {
    const failedWipe = await makeReport(fx.alpha.tenantId);
    await prisma.dataWipeCertificate.create({
      data: {
        reportId: failedWipe.reportId,
        deviceSerial: "x",
        imei: "356938035643809",
        standard: "nist_800_88_purge",
        verifiedByTechnicianId: fx.alpha.technicianId,
        passed: false,
      },
    });
    const passedWipe = await makeReport(fx.alpha.tenantId);
    await prisma.dataWipeCertificate.create({
      data: {
        reportId: passedWipe.reportId,
        deviceSerial: "y",
        imei: "356938035643809",
        standard: "nist_800_88_purge",
        verifiedByTechnicianId: fx.alpha.technicianId,
        passed: true,
      },
    });

    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).get("/compliance/summary").set(auth(token));

    // A failed erasure is not an attestation.
    expect(res.body.dataErasure.certificatesIssued).toBe(1);
    expect(res.body.dataErasure.purgeStandard).toBe(1);
  });

  it("does not count another tenant's erasure certificates", async () => {
    const betaReport = await makeReport(fx.beta.tenantId);
    await prisma.dataWipeCertificate.create({
      data: {
        reportId: betaReport.reportId,
        deviceSerial: "z",
        imei: "356938035643809",
        standard: "nist_800_88_clear",
        verifiedByTechnicianId: fx.beta.technicianId,
        passed: true,
      },
    });

    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).get("/compliance/summary").set(auth(token));
    expect(res.body.dataErasure.certificatesIssued).toBe(0);
  });

  it("exports the summary as CSV with the period in the file", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).get("/compliance/summary.csv?from=2026-01-01").set(auth(token));

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("compliance-summary");
    // Someone filing this must be able to see what it covers.
    expect(res.text).toContain("Period start");
    expect(res.text).toContain("2026-01-01");
    expect(res.text).toContain("No routing decision recorded");
  });
});
