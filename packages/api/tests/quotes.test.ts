// tests/quotes.test.ts
//
// Trade-in quotes are the one place this system puts a number in front
// of a customer and creates an obligation to pay it. CLAUDE.md says the
// only pricing data that exists is "rough/illustrative" seed data whose
// sources disagreed by 2x+ on the same model, so most of what's asserted
// here is about refusing to act on a number that isn't real yet.

import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { Fixtures, prisma, resetDatabase, seedTwoTenants } from "./fixtures";
import { portalLogin } from "./helpers";

let app: Express;
let fx: Fixtures;
let alphaToken: string;

const PRICES = [
  { model: "iPhone 13", storageGb: 128, gradeBasePrices: { A: 400, B: 340, C: 260, D: 120 } },
];

beforeAll(() => {
  app = createApp();
});

beforeEach(async () => {
  fx = await seedTwoTenants();
  alphaToken = await portalLogin(app, fx.alpha.adminEmail);
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const uploadPrices = (token = alphaToken, prices = PRICES) =>
  request(app).put("/quotes/prices").set("Authorization", `Bearer ${token}`).send({ prices });

const createQuote = (token = alphaToken, reportId = fx.alpha.reportId, body = {}) =>
  request(app)
    .post("/quotes")
    .set("Authorization", `Bearer ${token}`)
    .send({ reportId, grade: "A", storageGb: 128, ...body });

describe("market prices", () => {
  it("upserts so a corrected re-upload updates rather than conflicts", async () => {
    await uploadPrices();
    const second = await uploadPrices(alphaToken, [
      { model: "iPhone 13", storageGb: 128, gradeBasePrices: { A: 450, B: 340, C: 260, D: 120 } },
    ]);
    expect(second.status).toBe(200);

    const rows = await prisma.marketPriceEntry.findMany({ where: { tenantId: fx.alpha.tenantId } });
    expect(rows).toHaveLength(1);
    expect((rows[0].gradeBasePrices as Record<string, number>).A).toBe(450);
  });

  // A missing grade would surface later as an undefined base price and a
  // quote of 0 — indistinguishable from "this device is worthless".
  it("requires every grade to be priced", async () => {
    const res = await uploadPrices(alphaToken, [
      { model: "iPhone 13", storageGb: 128, gradeBasePrices: { A: 400, B: 340 } } as never,
    ]);
    expect(res.status).toBe(400);
  });

  it("keeps each tenant's price list separate", async () => {
    await uploadPrices();
    const betaToken = await portalLogin(app, fx.beta.adminEmail);
    const res = await request(app).get("/quotes/prices").set("Authorization", `Bearer ${betaToken}`);
    expect(res.body).toHaveLength(0);
  });

  it("does not let tenant_staff change pricing", async () => {
    const staff = await prisma.portalUser.create({
      data: {
        email: "staff@alpha.test",
        passwordHash: (await prisma.portalUser.findFirstOrThrow({ where: { email: fx.alpha.adminEmail } }))
          .passwordHash,
        role: "tenant_staff",
        tenantId: fx.alpha.tenantId,
      },
    });
    const staffToken = await portalLogin(app, staff.email);
    expect((await uploadPrices(staffToken)).status).toBe(403);
  });
});

describe("quote computation", () => {
  it("computes an offer from grade base price minus functional deductions", async () => {
    await uploadPrices();
    // The seeded report has no failing results, so grade A is undeducted.
    const res = await createQuote();
    expect(res.status).toBe(201);
    expect(res.body.basePrice).toBe(400);
    expect(res.body.finalOffer).toBe(400);
  });

  it("deducts for failed functional tests", async () => {
    await uploadPrices();
    await prisma.report.update({
      where: { reportId: fx.alpha.reportId },
      data: {
        results: [
          {
            testId: "battery_health",
            label: "Battery Health",
            status: "fail",
            source: "manual",
            timestamp: "2026-08-03T12:00:00Z",
          },
        ],
      },
    });

    const res = await createQuote();
    // 400 base minus the 15 battery deduction.
    expect(res.body.finalOffer).toBe(385);
    expect(res.body.deductions).toHaveLength(1);
  });

  // "We have no price for this device" and "this device is worth nothing"
  // are very different things to tell a customer.
  it("refuses to quote an unpriced model rather than offering zero", async () => {
    await uploadPrices();
    const res = await createQuote(alphaToken, fx.alpha.reportId, { storageGb: 512 });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/no price on file/i);
  });

  it("refuses to quote another tenant's report", async () => {
    await uploadPrices();
    const res = await createQuote(alphaToken, fx.beta.reportId);
    expect(res.status).toBe(404);
  });

  it("allows only one quote per report", async () => {
    await uploadPrices();
    await createQuote();
    expect((await createQuote()).status).toBe(409);
  });

  // CLAUDE.md: an open dispute holds the device and the offer.
  it("refuses to quote a device with an open dispute", async () => {
    await uploadPrices();
    await request(app)
      .post("/disputes")
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ reportId: fx.alpha.reportId, disputingItem: "grade", customerNote: "Disagree" });

    const res = await createQuote();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/dispute/i);
  });
});

describe("acceptance guards", () => {
  // The core financial guardrail: seed pricing is explicitly not real
  // market data, so a quote derived from it must not become an
  // obligation.
  it("refuses to accept a quote computed from seed pricing", async () => {
    // No prices uploaded — but computeTradeInQuote needs a match, so
    // seed the row directly and mark the source as the API would.
    await prisma.marketPriceEntry.create({
      data: {
        tenantId: fx.alpha.tenantId,
        model: "iPhone 13",
        storageGb: 128,
        gradeBasePrices: { A: 400, B: 340, C: 260, D: 120 },
      },
    });
    const created = await createQuote();
    await prisma.tradeInQuote.update({
      where: { quoteId: created.body.quoteId },
      data: { priceSource: "unverified_seed_data" },
    });

    const res = await request(app)
      .post(`/quotes/${created.body.quoteId}/accept`)
      .set("Authorization", `Bearer ${alphaToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/seed pricing/i);
  });

  it("accepts a quote backed by uploaded pricing", async () => {
    await uploadPrices();
    const created = await createQuote();
    const res = await request(app)
      .post(`/quotes/${created.body.quoteId}/accept`)
      .set("Authorization", `Bearer ${alphaToken}`);
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
  });

  // Honouring a stale quote silently is how a tenant loses money on
  // every old one, since prices move.
  it("refuses to accept an expired quote", async () => {
    await uploadPrices();
    const created = await createQuote();
    await prisma.tradeInQuote.update({
      where: { quoteId: created.body.quoteId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app)
      .post(`/quotes/${created.body.quoteId}/accept`)
      .set("Authorization", `Bearer ${alphaToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/expired/i);
  });

  // REGRESSION (review finding): this was the missing third checkpoint.
  // The hold existed at quote time and payout time but not at accept —
  // and accept is precisely the step that creates the obligation.
  it("refuses to accept while a dispute is open", async () => {
    await uploadPrices();
    const created = await createQuote();
    await request(app)
      .post("/disputes")
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ reportId: fx.alpha.reportId, disputingItem: "grade", customerNote: "Contested" });

    const res = await request(app)
      .post(`/quotes/${created.body.quoteId}/accept`)
      .set("Authorization", `Bearer ${alphaToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/dispute/i);
    const stored = await prisma.tradeInQuote.findUnique({ where: { quoteId: created.body.quoteId } });
    expect(stored?.accepted).toBe(false);
  });

  it("refuses to accept twice", async () => {
    await uploadPrices();
    const created = await createQuote();
    const accept = () =>
      request(app).post(`/quotes/${created.body.quoteId}/accept`).set("Authorization", `Bearer ${alphaToken}`);
    expect((await accept()).status).toBe(200);
    expect((await accept()).status).toBe(409);
  });
});

describe("payout", () => {
  const acceptedQuote = async () => {
    await uploadPrices();
    const created = await createQuote();
    await request(app).post(`/quotes/${created.body.quoteId}/accept`).set("Authorization", `Bearer ${alphaToken}`);
    return created.body.quoteId as string;
  };

  it("records a payout against an accepted quote", async () => {
    const quoteId = await acceptedQuote();
    const res = await request(app)
      .post(`/quotes/${quoteId}/payout`)
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ method: "store_credit" });

    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(400);
    // Must not read as money in flight — no processor is integrated.
    expect(res.body.note).toMatch(/no funds are transferred/i);
  });

  it("refuses payout on a quote that was never accepted", async () => {
    await uploadPrices();
    const created = await createQuote();
    const res = await request(app)
      .post(`/quotes/${created.body.quoteId}/payout`)
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ method: "ach" });
    expect(res.status).toBe(409);
  });

  // A dispute can be raised between acceptance and payout, so the hold
  // is re-checked here rather than trusted from quote time.
  it("holds payout when a dispute is raised after acceptance", async () => {
    const quoteId = await acceptedQuote();
    await request(app)
      .post("/disputes")
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ reportId: fx.alpha.reportId, disputingItem: "grade", customerNote: "Changed my mind" });

    const res = await request(app)
      .post(`/quotes/${quoteId}/payout`)
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ method: "ach" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/dispute/i);
  });

  it("requires a reason when marking a payout failed", async () => {
    const quoteId = await acceptedQuote();
    await request(app)
      .post(`/quotes/${quoteId}/payout`)
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ method: "ach" });

    const res = await request(app)
      .patch(`/quotes/${quoteId}/payout`)
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ status: "failed" });
    expect(res.status).toBe(400);
  });

  // A payout PATCH must not update a payout across the tenant boundary
  // even when the write is keyed by payoutId — the tenant filter rides
  // through the quote relation inside the write itself.
  it("scopes the payout status write to the caller's tenant", async () => {
    const quoteId = await acceptedQuote();
    await request(app)
      .post(`/quotes/${quoteId}/payout`)
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ method: "ach" });

    const betaToken = await portalLogin(app, fx.beta.adminEmail);
    const res = await request(app)
      .patch(`/quotes/${quoteId}/payout`)
      .set("Authorization", `Bearer ${betaToken}`)
      .send({ status: "completed" });
    expect(res.status).toBe(404);

    const payout = await prisma.payoutRecord.findFirst({ where: { quoteId } });
    expect(payout?.status).toBe("pending");
  });

  it("does not expose another tenant's quotes", async () => {
    await acceptedQuote();
    const betaToken = await portalLogin(app, fx.beta.adminEmail);
    const res = await request(app).get("/quotes").set("Authorization", `Bearer ${betaToken}`);
    expect(res.body).toHaveLength(0);
  });
});
