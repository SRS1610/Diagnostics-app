// tests/notifications.test.ts
//
// Real delivery wiring for the 7 stage-transition triggers this app
// actually has a distinct event for (device_received has no separate
// intake step in this API and is deliberately left unwired — see
// reports.ts's comment). The Twilio/SendGrid SDKs are mocked — no live
// account — but everything else is real: the actual route handlers,
// the actual contact-info lookup, the actual template rendering, and
// the actual ActivityLogEntry writes recording each attempt.
//
// Dispatch is fire-and-forget from every route's perspective (same
// pattern as dispatchWebhook), so these wait briefly after each request
// before asserting on the mocked SDK calls or the activity log.

import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { Fixtures, prisma, resetDatabase, seedTwoTenants } from "./fixtures";
import { portalLogin, technicianLogin, validReportBody } from "./helpers";

// Built entirely INSIDE each factory (never referencing an outer const)
// because jest.mock calls are hoisted above the rest of the file,
// including any const they'd otherwise close over. twilio's factory
// function is called fresh per dispatch (getTwilioClient() calls
// twilio(sid, token) every time), so the shared `create` mock is
// attached to the factory itself and pulled back out after the mock is
// in place — that's what makes multiple dispatches within one test
// observable through a single mock instance rather than a new,
// unobserved one each call.
jest.mock("twilio", () => {
  const create = jest.fn();
  const factory: any = jest.fn(() => ({ messages: { create } }));
  factory.__create = create;
  return factory;
});
jest.mock("@sendgrid/mail", () => ({ setApiKey: jest.fn(), send: jest.fn() }));

import twilioFactory from "twilio";
import sgMailImport from "@sendgrid/mail";

const twilioMessagesCreate = (twilioFactory as unknown as { __create: jest.Mock }).__create;
const sgMailMock = sgMailImport as unknown as { setApiKey: jest.Mock; send: jest.Mock };

let app: Express;
let fx: Fixtures;

const ENV = {
  TWILIO_ACCOUNT_SID: "AC_dummy",
  TWILIO_AUTH_TOKEN: "dummy",
  TWILIO_FROM_NUMBER: "+15550000000",
  SENDGRID_API_KEY: "SG.dummy",
  SENDGRID_FROM_EMAIL: "trade-in@example.test",
};

beforeAll(() => {
  app = createApp();
});

beforeEach(async () => {
  fx = await seedTwoTenants();
  jest.clearAllMocks();
  Object.assign(process.env, ENV);
  twilioMessagesCreate.mockResolvedValue({ sid: "SM_fake" });
  sgMailMock.send.mockResolvedValue([{ statusCode: 202 }]);
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const settle = () => new Promise((r) => setTimeout(r, 250));

async function activityFor(reportId: string, action: "notification_sent" | "notification_failed") {
  return prisma.activityLogEntry.findMany({ where: { targetId: reportId, action } });
}

async function createReportWithContact(techToken: string, overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/reports")
    .set(auth(techToken))
    .send(
      validReportBody({
        device: {
          make: "Apple",
          model: "iPhone 13",
          serialNumber: `NOTIF-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          imei: "356938035643809",
          captureSource: "manual",
          consumerEmail: "buyer@example.test",
          consumerPhone: "+15551234567",
        },
        ...overrides,
      }),
    );
  expect(res.status).toBe(201);
  return res.body;
}

describe("report creation → inspection_complete", () => {
  it("sends SMS and email when both channels are configured and both contacts are on file", async () => {
    const techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
    const report = await createReportWithContact(techToken);
    await settle();

    expect(twilioMessagesCreate).toHaveBeenCalledTimes(1);
    expect(twilioMessagesCreate.mock.calls[0][0].to).toBe("+15551234567");
    expect(twilioMessagesCreate.mock.calls[0][0].body).toContain("Apple iPhone 13");

    expect(sgMailMock.send).toHaveBeenCalledTimes(1);
    expect(sgMailMock.send.mock.calls[0][0].to).toBe("buyer@example.test");

    const sent = await activityFor(report.reportId, "notification_sent");
    expect(sent.map((e) => e.details)).toEqual(
      expect.arrayContaining([expect.stringContaining("inspection_complete via sms"), expect.stringContaining("inspection_complete via email")]),
    );
    // Never the real contact info in the log.
    expect(sent.every((e) => !e.details?.includes("buyer@example.test") && !e.details?.includes("+15551234567"))).toBe(true);
  });

  it("skips entirely when the report has no contact info at all", async () => {
    const techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
    const res = await request(app)
      .post("/reports")
      .set(auth(techToken))
      .send(validReportBody({ device: { make: "Apple", model: "iPhone 13", serialNumber: `NOCONTACT-${Date.now()}`, imei: "356938035643809", captureSource: "manual" } }));
    expect(res.status).toBe(201);
    await settle();

    expect(twilioMessagesCreate).not.toHaveBeenCalled();
    expect(sgMailMock.send).not.toHaveBeenCalled();
  });

  it("sends only SMS when only a phone number is on file", async () => {
    const techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
    const report = await createReportWithContact(techToken, {
      device: { make: "Apple", model: "iPhone 13", serialNumber: `PHONEONLY-${Date.now()}`, imei: "356938035643809", captureSource: "manual", consumerPhone: "+15559998888" },
    });
    await settle();

    expect(twilioMessagesCreate).toHaveBeenCalledTimes(1);
    expect(sgMailMock.send).not.toHaveBeenCalled();
    void report;
  });

  it("does not attempt SMS when Twilio isn't configured, even with a phone on file", async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    const techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
    await createReportWithContact(techToken);
    await settle();

    expect(twilioMessagesCreate).not.toHaveBeenCalled();
    expect(sgMailMock.send).toHaveBeenCalledTimes(1); // email still configured
  });

  it("logs notification_failed, not notification_sent, when the provider call rejects", async () => {
    twilioMessagesCreate.mockRejectedValue(new Error("Twilio: invalid number"));
    const techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
    const report = await createReportWithContact(techToken);
    await settle();

    const failed = await activityFor(report.reportId, "notification_failed");
    expect(failed.some((e) => e.details?.includes("sms"))).toBe(true);
    const sent = await activityFor(report.reportId, "notification_sent");
    expect(sent.some((e) => e.details?.includes("sms"))).toBe(false);
  });
});

describe("offer and payout stage transitions", () => {
  async function seedQuote(techToken: string, adminToken: string, tenantId: string) {
    const report = await createReportWithContact(techToken);
    await settle(); // let the report-creation notification land before clearing
    jest.clearAllMocks();
    await prisma.marketPriceEntry.create({
      data: { tenantId, model: "iPhone 13", storageGb: 128, gradeBasePrices: { A: 500, B: 400, C: 300, D: 150 } },
    });
    const quoteRes = await request(app)
      .post("/quotes")
      .set(auth(adminToken))
      .send({ reportId: report.reportId, grade: "A", storageGb: 128 });
    expect(quoteRes.status).toBe(201);
    return { report, quote: quoteRes.body };
  }

  it("quoting sends offer_ready", async () => {
    const techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
    const adminToken = await portalLogin(app, fx.alpha.adminEmail);
    const { report } = await seedQuote(techToken, adminToken, fx.alpha.tenantId);
    await settle();

    expect(twilioMessagesCreate).toHaveBeenCalledTimes(1);
    expect(twilioMessagesCreate.mock.calls[0][0].body).toMatch(/\$500/);
    const sent = await activityFor(report.reportId, "notification_sent");
    expect(sent.some((e) => e.details?.includes("offer_ready"))).toBe(true);
  });

  it("accepting (portal side) sends offer_accepted", async () => {
    const techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
    const adminToken = await portalLogin(app, fx.alpha.adminEmail);
    const { report, quote } = await seedQuote(techToken, adminToken, fx.alpha.tenantId);
    jest.clearAllMocks();

    const accepted = await request(app).post(`/quotes/${quote.quoteId}/accept`).set(auth(adminToken));
    expect(accepted.status).toBe(200);
    await settle();

    const sent = await activityFor(report.reportId, "notification_sent");
    expect(sent.some((e) => e.details?.includes("offer_accepted"))).toBe(true);
  });

  it("accepting via the public tracker also sends offer_accepted", async () => {
    const techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
    const adminToken = await portalLogin(app, fx.alpha.adminEmail);
    const { report } = await seedQuote(techToken, adminToken, fx.alpha.tenantId);
    const full = await prisma.report.findUnique({ where: { reportId: report.reportId } });
    jest.clearAllMocks();

    const res = await request(app).post(`/public/track/${full!.consumerToken}/offer/accept`);
    expect(res.status).toBe(200);
    await settle();

    const sent = await activityFor(report.reportId, "notification_sent");
    expect(sent.some((e) => e.details?.includes("offer_accepted"))).toBe(true);
  });

  it("choosing a payout method sends payout_processing, and marking it completed sends payout_complete", async () => {
    const techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
    const adminToken = await portalLogin(app, fx.alpha.adminEmail);
    const { report, quote } = await seedQuote(techToken, adminToken, fx.alpha.tenantId);
    await request(app).post(`/quotes/${quote.quoteId}/accept`).set(auth(adminToken));
    jest.clearAllMocks();

    const payout = await request(app).post(`/quotes/${quote.quoteId}/payout`).set(auth(adminToken)).send({ method: "ach" });
    expect(payout.status).toBe(201);
    await settle();
    let sent = await activityFor(report.reportId, "notification_sent");
    expect(sent.some((e) => e.details?.includes("payout_processing"))).toBe(true);

    jest.clearAllMocks();
    const completed = await request(app)
      .patch(`/quotes/${quote.quoteId}/payout`)
      .set(auth(adminToken))
      .send({ status: "completed" });
    expect(completed.status).toBe(200);
    await settle();
    sent = await activityFor(report.reportId, "notification_sent");
    expect(sent.some((e) => e.details?.includes("payout_complete"))).toBe(true);
  });
});

describe("disputes", () => {
  it("filing a dispute sends dispute_received, resolving it sends dispute_resolved", async () => {
    const techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
    const adminToken = await portalLogin(app, fx.alpha.adminEmail);
    const report = await createReportWithContact(techToken);
    const full = await prisma.report.findUnique({ where: { reportId: report.reportId } });
    jest.clearAllMocks();

    const filed = await request(app)
      .post(`/public/track/${full!.consumerToken}/dispute`)
      .send({ disputingItem: "Battery Health", customerNote: "It failed but shouldn't have." });
    expect(filed.status).toBe(201);
    await settle();
    let sent = await activityFor(report.reportId, "notification_sent");
    expect(sent.some((e) => e.details?.includes("dispute_received"))).toBe(true);

    const disputes = await request(app).get("/disputes").set(auth(adminToken));
    const disputeId = disputes.body[0].disputeId;
    jest.clearAllMocks();

    const resolved = await request(app)
      .post(`/disputes/${disputeId}/resolve`)
      .set(auth(adminToken))
      .send({ outcome: "uphold", resolutionNotes: "Confirmed via retest." });
    expect(resolved.status).toBe(200);
    await settle();
    sent = await activityFor(report.reportId, "notification_sent");
    expect(sent.some((e) => e.details?.includes("dispute_resolved"))).toBe(true);
  });
});

describe("self-service contact capture", () => {
  it("a consumer can add contact info via the tracker, and it's used on the next notification", async () => {
    const techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
    const adminToken = await portalLogin(app, fx.alpha.adminEmail);

    const created = await request(app)
      .post("/reports")
      .set(auth(techToken))
      .send(validReportBody({ device: { make: "Apple", model: "iPhone 13", serialNumber: `SELFSERVE-${Date.now()}`, imei: "356938035643809", captureSource: "manual" } }));
    expect(created.status).toBe(201);
    const full = await prisma.report.findUnique({ where: { reportId: created.body.reportId } });

    const patch = await request(app).patch(`/public/track/${full!.consumerToken}/contact`).send({ email: "self-added@example.test" });
    expect(patch.status).toBe(204);

    const view = await request(app).get(`/public/track/${full!.consumerToken}`);
    expect(view.body.notifications).toEqual({ hasEmail: true, hasPhone: false });

    await prisma.marketPriceEntry.create({
      data: { tenantId: fx.alpha.tenantId, model: "iPhone 13", storageGb: 128, gradeBasePrices: { A: 500, B: 400, C: 300, D: 150 } },
    });
    jest.clearAllMocks();
    await request(app).post("/quotes").set(auth(adminToken)).send({ reportId: created.body.reportId, grade: "A", storageGb: 128 });
    await settle();

    expect(sgMailMock.send).toHaveBeenCalledTimes(1);
    expect(sgMailMock.send.mock.calls[0][0].to).toBe("self-added@example.test");
  });

  it("rejects a malformed email", async () => {
    const techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
    const created = await request(app)
      .post("/reports")
      .set(auth(techToken))
      .send(validReportBody({ device: { make: "Apple", model: "iPhone 13", serialNumber: `BADEMAIL-${Date.now()}`, imei: "356938035643809", captureSource: "manual" } }));
    const full = await prisma.report.findUnique({ where: { reportId: created.body.reportId } });

    const res = await request(app).patch(`/public/track/${full!.consumerToken}/contact`).send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });
});

describe("isolation", () => {
  it("a notification for alpha's report never references beta's data", async () => {
    const techToken = await technicianLogin(app, fx.beta.tenantId, fx.beta.badgeCode);
    const report = await createReportWithContact(techToken, {
      device: { make: "Apple", model: "iPhone 13", serialNumber: `BETA-${Date.now()}`, imei: "356938035643809", captureSource: "manual", consumerEmail: "beta-buyer@example.test" },
    });
    await settle();

    const alphaEntries = await prisma.activityLogEntry.findMany({ where: { tenantId: fx.alpha.tenantId, targetId: report.reportId } });
    expect(alphaEntries).toHaveLength(0);
    const betaEntries = await activityFor(report.reportId, "notification_sent");
    expect(betaEntries.every((e) => e.tenantId === fx.beta.tenantId)).toBe(true);
  });
});
