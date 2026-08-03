// tests/batchesAndListings.test.ts

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

describe("batch intake", () => {
  const startBatch = (body: object = {}) =>
    request(app)
      .post("/batches")
      .set("Authorization", `Bearer ${alphaTech}`)
      .send({ sourceName: "Carrier Buyback Lot #4521", ...body });

  const scan = (batchId: string, serialNumber: string) =>
    request(app)
      .post(`/batches/${batchId}/devices`)
      .set("Authorization", `Bearer ${alphaTech}`)
      .send({ serialNumber });

  it("opens a batch attributed to the technician's tenant", async () => {
    const res = await startBatch();
    expect(res.status).toBe(201);
    expect(res.body.tenantId).toBe(fx.alpha.tenantId);
    expect(res.body.technicianId).toBe(fx.alpha.technicianId);
  });

  it("refuses another tenant's profile on the batch", async () => {
    const res = await startBatch({ profileId: fx.beta.profileId });
    expect(res.status).toBe(404);
  });

  // CLAUDE.md: re-scanning the same serial is a no-op, not a duplicate —
  // the lot count is what operations reconciles the pallet against.
  it("counts a serial once no matter how many times it is scanned", async () => {
    const batch = await startBatch();
    expect((await scan(batch.body.batchId, "SER-001")).status).toBe(201);

    const rescan = await scan(batch.body.batchId, "SER-001");
    expect(rescan.status).toBe(200);
    expect(rescan.body.alreadyPresent).toBe(true);
    expect(rescan.body.deviceCount).toBe(1);
  });

  // REGRESSION-CLASS: same shape as the revision-number race. Concurrent
  // scans both read the serial array, and the second write would discard
  // the first — silently losing a device from the lot.
  it("does not lose devices under concurrent scanning", async () => {
    const batch = await startBatch();
    const serials = Array.from({ length: 8 }, (_, i) => `CONC-${i}`);
    await Promise.all(serials.map((s) => scan(batch.body.batchId, s)));

    const stored = await prisma.batchSession.findUnique({ where: { batchId: batch.body.batchId } });
    expect(stored?.deviceSerials.sort()).toEqual(serials.sort());
  });

  it("refuses scans into a closed batch", async () => {
    const batch = await startBatch();
    await request(app).post(`/batches/${batch.body.batchId}/close`).set("Authorization", `Bearer ${alphaTech}`);

    const res = await scan(batch.body.batchId, "SER-LATE");
    expect(res.status).toBe(409);
  });

  // REGRESSION (review finding): the status gate read outside the lock
  // let a serial land in a batch that had already been closed. Simulated
  // by closing the batch directly, which is what a concurrent /close
  // commit looks like from the scan's point of view.
  it("does not append to a batch closed after the fast-path check", async () => {
    const batch = await startBatch();
    await prisma.batchSession.update({
      where: { batchId: batch.body.batchId },
      data: { status: "closed", closedAt: new Date() },
    });

    const res = await scan(batch.body.batchId, "SER-RACE");
    expect(res.status).toBe(409);
    const stored = await prisma.batchSession.findUnique({ where: { batchId: batch.body.batchId } });
    expect(stored?.deviceSerials).toEqual([]);
  });

  it("cannot scan into another tenant's batch", async () => {
    const batch = await startBatch();
    const betaTech = await technicianLogin(app, fx.beta.tenantId, fx.beta.badgeCode);
    const res = await request(app)
      .post(`/batches/${batch.body.batchId}/devices`)
      .set("Authorization", `Bearer ${betaTech}`)
      .send({ serialNumber: "SER-EVIL" });
    expect(res.status).toBe(404);
  });

  it("does not list another tenant's batches", async () => {
    await startBatch();
    const betaToken = await portalLogin(app, fx.beta.adminEmail);
    const res = await request(app).get("/batches").set("Authorization", `Bearer ${betaToken}`);
    expect(res.body).toHaveLength(0);
  });
});

describe("marketplace listings", () => {
  const priceAndQuote = async () => {
    await request(app)
      .put("/quotes/prices")
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ prices: [{ model: "iPhone 13", storageGb: 128, gradeBasePrices: { A: 400, B: 340, C: 260, D: 120 } }] });
    await request(app)
      .post("/quotes")
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ reportId: fx.alpha.reportId, grade: "A", storageGb: 128 });
  };

  const createListing = (body: object = {}) =>
    request(app)
      .post("/listings")
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ reportId: fx.alpha.reportId, grade: "A", ...body });

  it("generates a listing from the report and its quote", async () => {
    await priceAndQuote();
    const res = await createListing();

    expect(res.status).toBe(201);
    expect(res.body.title).toMatch(/iPhone 13/);
    expect(res.body.title).toMatch(/Grade A/);
    // 400 offer * 1.35 markup.
    expect(res.body.askingPrice).toBe(540);
  });

  // The markup is not a pricing strategy and the quote may rest on seed
  // data — the caveat has to ride on the response, not live in a comment.
  it("labels the price as a placeholder", async () => {
    await priceAndQuote();
    const res = await createListing();
    expect(res.body.priceIsPlaceholder).toBe(true);
    expect(res.body.priceNote).toMatch(/not a pricing strategy/i);
  });

  it("refuses to list a report with no quote", async () => {
    const res = await createListing();
    expect(res.status).toBe(422);
  });

  // A device routed to parts harvest is unsellable; listing it would put
  // it on a marketplace anyway.
  it("refuses to list a device not routed to resale", async () => {
    await priceAndQuote();
    await prisma.report.update({
      where: { reportId: fx.alpha.reportId },
      data: { routing: "parts_harvest" },
    });

    const res = await createListing();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/parts_harvest/);
  });

  // REGRESSION (review finding): quotes.ts honoured the dispute hold at
  // quote/accept/payout, but listings did not — a device could be listed
  // for resale at the very grade the customer was contesting.
  it("refuses to list a device with an open dispute", async () => {
    await priceAndQuote();
    await request(app)
      .post("/disputes")
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ reportId: fx.alpha.reportId, disputingItem: "grade", customerNote: "Contested" });

    const res = await createListing();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/dispute/i);
    expect(await prisma.marketplaceListing.count()).toBe(0);
  });

  it("allows one listing per report", async () => {
    await priceAndQuote();
    await createListing();
    expect((await createListing()).status).toBe(409);
  });

  it("refuses to list another tenant's report", async () => {
    await priceAndQuote();
    const res = await createListing({ reportId: fx.beta.reportId });
    expect(res.status).toBe(404);
  });

  it("does not expose another tenant's listings", async () => {
    await priceAndQuote();
    await createListing();
    const betaToken = await portalLogin(app, fx.beta.adminEmail);
    const res = await request(app).get("/listings").set("Authorization", `Bearer ${betaToken}`);
    expect(res.body).toHaveLength(0);
  });
});
