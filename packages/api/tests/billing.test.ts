// tests/billing.test.ts
//
// Self-serve Stripe billing. The Stripe SDK itself is mocked — there is
// no live Stripe account to test against — but only at the SDK
// boundary: this API's own body-parsing (the rawBody capture in
// app.ts), route wiring, database writes, and event-type dispatch all
// run for real. The mock's webhooks.constructEvent still requires a
// `Stripe-Signature` header to be PRESENT (matching production's shape)
// and can be told to reject one, so the "an unverifiable webhook must
// never be treated as 200" property is still exercised.

import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { Fixtures, prisma, resetDatabase, seedTwoTenants } from "./fixtures";
import { portalLogin } from "./helpers";

const stripeMock = {
  customers: { create: jest.fn() },
  checkout: { sessions: { create: jest.fn() } },
  billingPortal: { sessions: { create: jest.fn() } },
  subscriptions: { retrieve: jest.fn() },
  webhooks: { constructEvent: jest.fn() },
};

jest.mock("stripe", () => jest.fn().mockImplementation(() => stripeMock));

let app: Express;
let fx: Fixtures;

const ENV = {
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_dummy",
  STRIPE_PRICE_PER_INSPECTION: "price_per_inspection",
};

beforeAll(() => {
  app = createApp();
});

beforeEach(async () => {
  fx = await seedTwoTenants();
  jest.clearAllMocks();
  Object.assign(process.env, ENV);
  // A realistic mock: parses whatever body was actually sent (proving
  // app.ts's rawBody capture really carries the exact bytes through),
  // and honours a deliberately-bad signature the same way a real
  // signature mismatch would.
  stripeMock.webhooks.constructEvent.mockImplementation((rawBody: Buffer, signature: string) => {
    if (signature === "bad-signature") throw new Error("No signatures found matching the expected signature");
    return JSON.parse(rawBody.toString());
  });
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("checkout", () => {
  it("501s when Stripe isn't configured", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).post("/billing/checkout-session").set(auth(token)).send({ type: "per_inspection" });
    expect(res.status).toBe(501);
  });

  it("501s when the key is set but this plan has no price configured", async () => {
    delete process.env.STRIPE_PRICE_PER_INSPECTION;
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).post("/billing/checkout-session").set(auth(token)).send({ type: "per_inspection" });
    expect(res.status).toBe(501);
  });

  it("creates a Stripe customer on first checkout and reuses it on the second", async () => {
    stripeMock.customers.create.mockResolvedValue({ id: "cus_alpha" });
    stripeMock.checkout.sessions.create.mockResolvedValue({ url: "https://checkout.stripe.test/session1" });

    const token = await portalLogin(app, fx.alpha.adminEmail);
    const first = await request(app).post("/billing/checkout-session").set(auth(token)).send({ type: "per_inspection" });
    expect(first.status).toBe(200);
    expect(first.body.checkoutUrl).toBe("https://checkout.stripe.test/session1");
    expect(stripeMock.customers.create).toHaveBeenCalledTimes(1);

    const tenant = await prisma.tenant.findUnique({ where: { tenantId: fx.alpha.tenantId } });
    expect(tenant!.stripeCustomerId).toBe("cus_alpha");

    const second = await request(app).post("/billing/checkout-session").set(auth(token)).send({ type: "per_inspection" });
    expect(second.status).toBe(200);
    expect(stripeMock.customers.create).toHaveBeenCalledTimes(1); // not called again
    expect(stripeMock.checkout.sessions.create.mock.calls[1][0].customer).toBe("cus_alpha");
  });

  it("refuses tenant_staff", async () => {
    const admin = await portalLogin(app, fx.alpha.adminEmail);
    const staffCreated = await request(app).post("/users").set(auth(admin)).send({ email: "billing-staff@alpha.test", role: "tenant_staff" });
    const staffLogin = await request(app).post("/auth/login").send({ email: "billing-staff@alpha.test", password: staffCreated.body.temporaryPassword });

    const res = await request(app).post("/billing/checkout-session").set(auth(staffLogin.body.token)).send({ type: "per_inspection" });
    expect(res.status).toBe(403);
  });

  it("rejects an unknown plan type", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).post("/billing/checkout-session").set(auth(token)).send({ type: "gold_tier" });
    expect(res.status).toBe(400);
  });
});

describe("billing portal", () => {
  it("404s before any checkout has ever happened", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).post("/billing/portal-session").set(auth(token));
    expect(res.status).toBe(404);
  });

  it("opens a portal session once a Stripe customer exists", async () => {
    await prisma.tenant.update({ where: { tenantId: fx.alpha.tenantId }, data: { stripeCustomerId: "cus_existing" } });
    stripeMock.billingPortal.sessions.create.mockResolvedValue({ url: "https://billing.stripe.test/portal1" });

    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).post("/billing/portal-session").set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://billing.stripe.test/portal1");
    expect(stripeMock.billingPortal.sessions.create.mock.calls[0][0].customer).toBe("cus_existing");
  });
});

function checkoutCompletedEvent(tenantId: string, type: string, subscriptionId: string) {
  return {
    type: "checkout.session.completed",
    data: { object: { metadata: { tenantId, type }, subscription: subscriptionId } },
  };
}

describe("webhook: checkout.session.completed", () => {
  it("provisions an active license, superseding any existing active one", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      items: { data: [{ current_period_start: 1700000000, current_period_end: 1702592000 }] },
    });

    const res = await request(app)
      .post("/billing/webhook")
      .set("Stripe-Signature", "good")
      .send(checkoutCompletedEvent(fx.alpha.tenantId, "per_inspection", "sub_new1"));
    expect(res.status).toBe(200);

    const licenses = await prisma.license.findMany({ where: { tenantId: fx.alpha.tenantId }, orderBy: { billingPeriodStart: "desc" } });
    const active = licenses.filter((l) => l.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0].stripeSubscriptionId).toBe("sub_new1");
    expect(active[0].type).toBe("per_inspection");
  });

  it("rejects a request with no signature", async () => {
    const res = await request(app).post("/billing/webhook").send(checkoutCompletedEvent(fx.alpha.tenantId, "per_inspection", "sub_x"));
    expect(res.status).toBe(400);
  });

  it("rejects a bad signature rather than trusting the body", async () => {
    const res = await request(app)
      .post("/billing/webhook")
      .set("Stripe-Signature", "bad-signature")
      .send(checkoutCompletedEvent(fx.alpha.tenantId, "per_inspection", "sub_bad"));
    expect(res.status).toBe(400);

    const license = await prisma.license.findFirst({ where: { stripeSubscriptionId: "sub_bad" } });
    expect(license).toBeNull();
  });
});

describe("webhook: dunning (payment failed / recovered)", () => {
  async function provisionActiveLicense(tenantId: string, subscriptionId: string) {
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      items: { data: [{ current_period_start: 1700000000, current_period_end: 1702592000 }] },
    });
    await request(app)
      .post("/billing/webhook")
      .set("Stripe-Signature", "good")
      .send(checkoutCompletedEvent(tenantId, "per_inspection", subscriptionId));
  }

  it("a failed payment marks the license past_due, a recovered one restores it", async () => {
    await provisionActiveLicense(fx.alpha.tenantId, "sub_dunning1");

    const failed = await request(app)
      .post("/billing/webhook")
      .set("Stripe-Signature", "good")
      .send({ type: "invoice.payment_failed", data: { object: { parent: { subscription_details: { subscription: "sub_dunning1" } } } } });
    expect(failed.status).toBe(200);

    let license = await prisma.license.findFirst({ where: { stripeSubscriptionId: "sub_dunning1" } });
    expect(license!.status).toBe("past_due");

    const recovered = await request(app)
      .post("/billing/webhook")
      .set("Stripe-Signature", "good")
      .send({ type: "invoice.payment_succeeded", data: { object: { parent: { subscription_details: { subscription: "sub_dunning1" } } } } });
    expect(recovered.status).toBe(200);

    license = await prisma.license.findFirst({ where: { stripeSubscriptionId: "sub_dunning1" } });
    expect(license!.status).toBe("active");
  });

  it("a subscription cancellation expires the license", async () => {
    await provisionActiveLicense(fx.alpha.tenantId, "sub_cancel1");

    const res = await request(app)
      .post("/billing/webhook")
      .set("Stripe-Signature", "good")
      .send({ type: "customer.subscription.deleted", data: { object: { id: "sub_cancel1" } } });
    expect(res.status).toBe(200);

    const license = await prisma.license.findFirst({ where: { stripeSubscriptionId: "sub_cancel1" } });
    expect(license!.status).toBe("expired");
  });
});

describe("isolation", () => {
  it("provisioning for alpha never touches beta's licenses", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      items: { data: [{ current_period_start: 1700000000, current_period_end: 1702592000 }] },
    });
    await request(app)
      .post("/billing/webhook")
      .set("Stripe-Signature", "good")
      .send(checkoutCompletedEvent(fx.alpha.tenantId, "per_inspection", "sub_isolated"));

    const betaLicenses = await prisma.license.findMany({ where: { tenantId: fx.beta.tenantId, stripeSubscriptionId: "sub_isolated" } });
    expect(betaLicenses).toHaveLength(0);
  });
});
