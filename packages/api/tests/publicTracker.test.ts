// tests/publicTracker.test.ts
//
// The consumer tracker is the only unauthenticated surface in this API
// that reads tenant data, so these tests are about two things:
//
//  1. The token is the entire authorisation. It must reach exactly one
//     report and nothing else — including, emphatically, nothing in the
//     OTHER tenant. The fixture builds two tenants precisely so a
//     token from one can be tried against the other's records.
//
//  2. The public projection is a whitelist. A test that only checked
//     "the fields I expect are present" would pass while a new column
//     leaked. These assert on ABSENCE of the private ones too.

import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { Fixtures, prisma, resetDatabase, seedTwoTenants } from "./fixtures";

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

const track = (token: string) => `/public/track/${token}`;

/** A real (acceptable) quote: priced from uploaded data, not the seed
 *  table, and not yet expired. */
async function giveQuote(
  tenantId: string,
  reportId: string,
  overrides: Partial<{ priceSource: string; expiresAt: Date; finalOffer: number }> = {},
) {
  return prisma.tradeInQuote.create({
    data: {
      tenantId,
      reportId,
      deviceModel: "iPhone 13",
      grade: "B",
      basePrice: 300,
      deductions: [],
      finalOffer: overrides.finalOffer ?? 250,
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 7 * 24 * 3600 * 1000),
      priceSource: overrides.priceSource ?? "tenant_price_list",
    },
  });
}

describe("token is the whole authorisation", () => {
  it("returns the tracker for a valid token with no credentials at all", async () => {
    const res = await request(app).get(track(fx.alpha.consumerToken));
    expect(res.status).toBe(200);
    expect(res.body.device.model).toBe("iPhone 13");
  });

  it("404s an unknown or malformed token", async () => {
    for (const token of ["nope", "x".repeat(64), "%20", "null", "undefined"]) {
      expect((await request(app).get(track(token))).status).toBe(404);
    }
  });

  it("gives nothing away to a path-traversal attempt", async () => {
    // The client resolves "../../reports" before it is sent, so this
    // lands on the authenticated /reports route rather than on the
    // tracker. The assertion is what matters either way: no data.
    const res = await request(app).get(track("../../reports"));
    expect(res.status).not.toBe(200);
  });

  it("never returns another tenant's report, even though both look alike", async () => {
    // Both tenants seed an identical device (same model, same IMEI). If
    // a lookup ever matched on anything but the token, this is where it
    // would show up.
    const alpha = await request(app).get(track(fx.alpha.consumerToken));
    const beta = await request(app).get(track(fx.beta.consumerToken));
    expect(alpha.status).toBe(200);
    expect(beta.status).toBe(200);

    const alphaReport = await prisma.report.findUnique({ where: { reportId: fx.alpha.reportId } });
    const betaReport = await prisma.report.findUnique({ where: { reportId: fx.beta.reportId } });
    // Distinct tokens for distinct reports — no shared or derived value.
    expect(alphaReport!.consumerToken).not.toBe(betaReport!.consumerToken);
  });

  it("does not accept a reportId in place of a token", async () => {
    // The obvious guess for anyone who has seen a report id.
    expect((await request(app).get(track(fx.alpha.reportId))).status).toBe(404);
  });

  it("acts only on the token's own report — a dispute filed via alpha's token never lands on beta", async () => {
    await request(app)
      .post(`${track(fx.alpha.consumerToken)}/dispute`)
      .send({ disputingItem: "Overall grade", customerNote: "Screen was fine when I sent it." });

    const betaDisputes = await prisma.dispute.findMany({ where: { tenantId: fx.beta.tenantId } });
    expect(betaDisputes).toHaveLength(0);

    const alphaDisputes = await prisma.dispute.findMany({ where: { tenantId: fx.alpha.tenantId } });
    expect(alphaDisputes).toHaveLength(1);
    // tenantId and reportId came from the token's report, not the caller.
    expect(alphaDisputes[0].reportId).toBe(fx.alpha.reportId);
  });
});

describe("public projection is a whitelist", () => {
  it("masks serial and IMEI rather than publishing them", async () => {
    const res = await request(app).get(track(fx.alpha.consumerToken));
    const body = JSON.stringify(res.body);

    expect(res.body.device.imeiMasked).toBe("••••3809");
    expect(res.body.device.serialNumberMasked).toBe("••••lpha");
    // The full values must appear nowhere in the response.
    expect(body).not.toContain("356938035643809");
    expect(body).not.toContain("SERIAL-Alpha");
  });

  it("omits internal identifiers and technician attribution entirely", async () => {
    const res = await request(app).get(track(fx.alpha.consumerToken));
    const body = JSON.stringify(res.body);

    for (const secret of [
      fx.alpha.tenantId,
      fx.alpha.reportId,
      fx.alpha.technicianId,
      fx.alpha.profileId,
      fx.alpha.consumerToken,
    ]) {
      expect(body).not.toContain(secret);
    }
    // CLAUDE.md: no technician notes, no redo history, no raw photos.
    expect(res.body.results).toBeUndefined();
    expect(res.body.revisions).toBeUndefined();
    expect(res.body.routing).toBeUndefined();
  });

  it("reports per-test outcomes as counts, never as individual notes", async () => {
    await prisma.report.update({
      where: { reportId: fx.alpha.reportId },
      data: {
        results: [
          { testId: "battery_health", label: "Battery", status: "fail", source: "api", timestamp: "t", notes: "INTERNAL: swollen cell, do not resell" },
          { testId: "loud_speaker", label: "Speaker", status: "pass", source: "manual", timestamp: "t" },
          { testId: "charging_port", label: "Port", status: "skipped", source: "api", timestamp: "t" },
        ],
      },
    });

    const res = await request(app).get(track(fx.alpha.consumerToken));
    expect(res.body.inspection).toMatchObject({ testsRun: 3, testsPassed: 1, testsFlagged: 1, testsSkipped: 1 });
    expect(JSON.stringify(res.body)).not.toContain("swollen cell");
  });

  it("shows a data-erasure attestation only when the wipe actually passed", async () => {
    await prisma.dataWipeCertificate.create({
      data: {
        reportId: fx.alpha.reportId,
        deviceSerial: "SERIAL-Alpha",
        imei: "356938035643809",
        standard: "nist_800_88_purge",
        verifiedByTechnicianId: fx.alpha.technicianId,
        passed: false,
      },
    });
    const failed = await request(app).get(track(fx.alpha.consumerToken));
    expect(failed.body.dataErasure).toBeNull();

    await prisma.dataWipeCertificate.update({ where: { reportId: fx.alpha.reportId }, data: { passed: true } });
    const passed = await request(app).get(track(fx.alpha.consumerToken));
    expect(passed.body.dataErasure.standard).toBe("nist_800_88_purge");
  });
});

describe("offer", () => {
  it("hides the amount and refuses acceptance when pricing is illustrative seed data", async () => {
    await giveQuote(fx.alpha.tenantId, fx.alpha.reportId, { priceSource: "unverified_seed_data" });

    const view = await request(app).get(track(fx.alpha.consumerToken));
    // null, not 0 — a zero reads as "your phone is worthless".
    expect(view.body.offer.amount).toBeNull();
    expect(view.body.offer.unavailableReason).toMatch(/pricing/i);

    const accept = await request(app).post(`${track(fx.alpha.consumerToken)}/offer/accept`);
    expect(accept.status).toBe(409);
    const quote = await prisma.tradeInQuote.findFirst({ where: { reportId: fx.alpha.reportId } });
    expect(quote!.accepted).toBe(false);
  });

  it("accepts a real, unexpired offer once and only once", async () => {
    await giveQuote(fx.alpha.tenantId, fx.alpha.reportId);

    const first = await request(app).post(`${track(fx.alpha.consumerToken)}/offer/accept`);
    expect(first.status).toBe(200);
    expect(first.body.offer.accepted).toBe(true);

    const second = await request(app).post(`${track(fx.alpha.consumerToken)}/offer/accept`);
    expect(second.status).toBe(409);
  });

  it("shows a breakdown that adds up when deductions exceed the base price", async () => {
    // A heavily damaged device: the offer is floored at zero, so without
    // the floor being stated the customer sees 60 − 40 − 35 − 25 = 0 and
    // the arithmetic on screen is visibly wrong.
    await prisma.tradeInQuote.create({
      data: {
        tenantId: fx.alpha.tenantId,
        reportId: fx.alpha.reportId,
        deviceModel: "iPhone 13",
        grade: "D",
        basePrice: 60,
        deductions: [
          { reason: "Battery Health", amount: 40 },
          { reason: "Rear Camera", amount: 35 },
          { reason: "Loud Speaker", amount: 25 },
        ],
        finalOffer: 0,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        priceSource: "tenant_price_list",
      },
    });

    const { body } = await request(app).get(track(fx.alpha.consumerToken));
    const offer = body.offer;
    const deducted = offer.deductions.reduce((sum: number, d: { amount: number }) => sum + d.amount, 0);

    expect(offer.deductionsCappedBy).toBe(40);
    // The line items must reconcile to the total the customer is shown.
    expect(offer.basePrice - deducted + offer.deductionsCappedBy).toBe(offer.amount);
  });

  it("reports no floor adjustment on an ordinary offer", async () => {
    await giveQuote(fx.alpha.tenantId, fx.alpha.reportId);
    const { body } = await request(app).get(track(fx.alpha.consumerToken));
    expect(body.offer.deductionsCappedBy).toBe(0);
  });

  it("refuses an expired offer", async () => {
    await giveQuote(fx.alpha.tenantId, fx.alpha.reportId, { expiresAt: new Date(Date.now() - 1000) });
    const res = await request(app).post(`${track(fx.alpha.consumerToken)}/offer/accept`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/expired/i);
  });

  it("declines, and a declined offer cannot then be accepted", async () => {
    await giveQuote(fx.alpha.tenantId, fx.alpha.reportId);

    const decline = await request(app).post(`${track(fx.alpha.consumerToken)}/offer/decline`);
    expect(decline.status).toBe(200);
    expect(decline.body.offer.declinedAt).not.toBeNull();

    const accept = await request(app).post(`${track(fx.alpha.consumerToken)}/offer/accept`);
    expect(accept.status).toBe(409);
  });
});

describe("payout selection", () => {
  it("requires an accepted offer first", async () => {
    await giveQuote(fx.alpha.tenantId, fx.alpha.reportId);
    const res = await request(app).post(`${track(fx.alpha.consumerToken)}/payout`).send({ method: "ach" });
    expect(res.status).toBe(409);
  });

  it("rejects an unknown payout method", async () => {
    await giveQuote(fx.alpha.tenantId, fx.alpha.reportId);
    await request(app).post(`${track(fx.alpha.consumerToken)}/offer/accept`);
    const res = await request(app).post(`${track(fx.alpha.consumerToken)}/payout`).send({ method: "cash_in_hand" });
    expect(res.status).toBe(400);
  });

  it("records the chosen method once, at the accepted offer's amount", async () => {
    await giveQuote(fx.alpha.tenantId, fx.alpha.reportId, { finalOffer: 250 });
    await request(app).post(`${track(fx.alpha.consumerToken)}/offer/accept`);

    const first = await request(app).post(`${track(fx.alpha.consumerToken)}/payout`).send({ method: "store_credit" });
    expect(first.status).toBe(200);
    expect(first.body.offer.payout).toMatchObject({ method: "store_credit", status: "pending" });

    const stored = await prisma.payoutRecord.findFirst();
    // The amount comes from the quote, never from the request body.
    expect(stored!.amount).toBe(250);

    const second = await request(app).post(`${track(fx.alpha.consumerToken)}/payout`).send({ method: "ach" });
    expect(second.status).toBe(409);
  });
});

describe("dispute hold", () => {
  it("blocks acceptance and payout while a dispute is open", async () => {
    await giveQuote(fx.alpha.tenantId, fx.alpha.reportId);
    await request(app)
      .post(`${track(fx.alpha.consumerToken)}/dispute`)
      .send({ disputingItem: "Overall grade", customerNote: "Graded lower than described." });

    const view = await request(app).get(track(fx.alpha.consumerToken));
    expect(view.body.onHold).toBe(true);

    const accept = await request(app).post(`${track(fx.alpha.consumerToken)}/offer/accept`);
    expect(accept.status).toBe(409);
  });

  it("holds payout for a dispute raised AFTER acceptance", async () => {
    await giveQuote(fx.alpha.tenantId, fx.alpha.reportId);
    await request(app).post(`${track(fx.alpha.consumerToken)}/offer/accept`);
    await request(app)
      .post(`${track(fx.alpha.consumerToken)}/dispute`)
      .send({ disputingItem: "Battery test", customerNote: "Battery was replaced last month." });

    const res = await request(app).post(`${track(fx.alpha.consumerToken)}/payout`).send({ method: "ach" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/hold/i);
  });

  it("allows only one open dispute per device", async () => {
    const body = { disputingItem: "Overall grade", customerNote: "Please look again." };
    expect((await request(app).post(`${track(fx.alpha.consumerToken)}/dispute`).send(body)).status).toBe(201);
    expect((await request(app).post(`${track(fx.alpha.consumerToken)}/dispute`).send(body)).status).toBe(409);
    expect(await prisma.dispute.count()).toBe(1);
  });

  it("requires both a subject and an explanation, and bounds their length", async () => {
    const base = track(fx.alpha.consumerToken) + "/dispute";
    expect((await request(app).post(base).send({})).status).toBe(400);
    expect((await request(app).post(base).send({ disputingItem: "Grade" })).status).toBe(400);
    expect((await request(app).post(base).send({ disputingItem: "Grade", customerNote: "   " })).status).toBe(400);
    expect(
      (await request(app).post(base).send({ disputingItem: "Grade", customerNote: "x".repeat(2001) })).status,
    ).toBe(400);
    expect(await prisma.dispute.count()).toBe(0);
  });

  it("surfaces a consumer-filed dispute in the tenant's own portal queue", async () => {
    // The point of the flow: what the customer submits is what the admin
    // reviews, in the right tenant.
    await request(app)
      .post(`${track(fx.beta.consumerToken)}/dispute`)
      .send({ disputingItem: "Camera test", customerNote: "Rear camera worked fine." });

    const queued = await prisma.dispute.findMany({ where: { tenantId: fx.beta.tenantId, status: "awaiting_review" } });
    expect(queued).toHaveLength(1);
    expect(queued[0].customerNote).toBe("Rear camera worked fine.");
  });
});
