// tests/webhooks.test.ts
//
// Runs a real HTTP server in-process as the "receiver" so these prove
// actual delivery happened — not just that a WebhookDelivery row got
// written, which a bug could produce even if nothing was ever sent.
// Also verifies the HMAC signature a receiver would check, since an
// unsigned or wrongly-signed payload is a webhook endpoint anyone on the
// internet could spoof.

import http from "node:http";
import { createHmac } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { Fixtures, prisma, resetDatabase, seedTwoTenants } from "./fixtures";
import { portalLogin, technicianLogin } from "./helpers";

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

/** A real listener, on an ephemeral port, that records every request it
 *  receives. Closed at the end of each test that uses it. */
function startReceiver(): Promise<{ url: string; received: () => Array<{ body: string; headers: http.IncomingHttpHeaders }>; close: () => Promise<void> }> {
  const received: Array<{ body: string; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ body, headers: req.headers });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        received: () => received,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function seedReport(techToken: string, serial: string) {
  const res = await request(app)
    .post("/reports")
    .set(auth(techToken))
    .send({
      device: { make: "Apple", model: "iPhone 13", serialNumber: serial, imei: "356938035643809", captureSource: "barcode" },
      results: [],
    });
  expect(res.status).toBe(201);
  return res.body;
}

describe("registering endpoints", () => {
  it("returns the signing secret exactly once", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const created = await request(app)
      .post("/webhooks")
      .set(auth(token))
      .send({ url: "https://example.test/hook", eventTypes: ["report.created"] });

    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^whsec_/);

    const list = await request(app).get("/webhooks").set(auth(token));
    expect(JSON.stringify(list.body)).not.toContain(created.body.secret);
  });

  it("rejects an unknown event type", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app)
      .post("/webhooks")
      .set(auth(token))
      .send({ url: "https://example.test/hook", eventTypes: ["totally.made.up"] });
    expect(res.status).toBe(400);
  });

  it("rejects a non-http(s) URL", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app)
      .post("/webhooks")
      .set(auth(token))
      .send({ url: "not-a-url", eventTypes: ["report.created"] });
    expect(res.status).toBe(400);
  });
});

describe("real delivery to a real receiver", () => {
  it("actually POSTs the event when a report is created", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const receiver = await startReceiver();
    try {
      await request(app)
        .post("/webhooks")
        .set(auth(token))
        .send({ url: receiver.url, eventTypes: ["report.created"] });

      const techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
      await seedReport(techToken, "WEBHOOK-TEST-1");

      // Dispatch is fire-and-forget from the route's perspective; give
      // it a moment to actually land rather than asserting immediately.
      await new Promise((r) => setTimeout(r, 300));

      const requests = receiver.received();
      expect(requests).toHaveLength(1);
      const payload = JSON.parse(requests[0].body);
      expect(payload.eventType).toBe("report.created");
      expect(payload.data.deviceModel).toBe("iPhone 13");
    } finally {
      await receiver.close();
    }
  });

  it("signs the payload with HMAC-SHA256 over the exact body sent", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const receiver = await startReceiver();
    try {
      const created = await request(app)
        .post("/webhooks")
        .set(auth(token))
        .send({ url: receiver.url, eventTypes: ["report.created"] });
      const secret = created.body.secret as string;

      const techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
      await seedReport(techToken, "WEBHOOK-TEST-2");
      await new Promise((r) => setTimeout(r, 300));

      const [delivered] = receiver.received();
      const expectedSignature = `sha256=${createHmac("sha256", secret).update(delivered.body).digest("hex")}`;
      expect(delivered.headers["x-webhook-signature"]).toBe(expectedSignature);
    } finally {
      await receiver.close();
    }
  });

  it("only sends to endpoints subscribed to that event type", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const receiver = await startReceiver();
    try {
      // Subscribed to disputes, NOT reports.
      await request(app)
        .post("/webhooks")
        .set(auth(token))
        .send({ url: receiver.url, eventTypes: ["dispute.received"] });

      const techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
      await seedReport(techToken, "WEBHOOK-TEST-3");
      await new Promise((r) => setTimeout(r, 300));

      expect(receiver.received()).toHaveLength(0);
    } finally {
      await receiver.close();
    }
  });

  it("records a failed delivery rather than losing it silently", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    // Nothing listens on this port — a real connection failure.
    const created = await request(app)
      .post("/webhooks")
      .set(auth(token))
      .send({ url: "http://127.0.0.1:1", eventTypes: ["report.created"] });

    const techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
    await seedReport(techToken, "WEBHOOK-TEST-4");
    await new Promise((r) => setTimeout(r, 500));

    const deliveries = await request(app)
      .get(`/webhooks/${created.body.endpointId}/deliveries`)
      .set(auth(token));
    expect(deliveries.status).toBe(200);
    expect(deliveries.body.length).toBeGreaterThan(0);
    expect(deliveries.body[0].succeeded).toBe(false);
  });

  it("a report creation still succeeds even when the webhook receiver is unreachable", async () => {
    // The core promise: a customer's broken integration must never be
    // able to break report submission for a technician in the field.
    const token = await portalLogin(app, fx.alpha.adminEmail);
    await request(app)
      .post("/webhooks")
      .set(auth(token))
      .send({ url: "http://127.0.0.1:1", eventTypes: ["report.created"] });

    const techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
    const res = await request(app)
      .post("/reports")
      .set(auth(techToken))
      .send({
        device: { make: "Apple", model: "iPhone 13", serialNumber: "WEBHOOK-TEST-5", imei: "356938035643809", captureSource: "barcode" },
        results: [],
      });
    expect(res.status).toBe(201);
  });
});

describe("deactivating an endpoint stops delivery without deleting history", () => {
  it("stops sending once inactive, keeps prior delivery records", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const receiver = await startReceiver();
    try {
      const created = await request(app)
        .post("/webhooks")
        .set(auth(token))
        .send({ url: receiver.url, eventTypes: ["report.created"] });

      const techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
      await seedReport(techToken, "WEBHOOK-TEST-6");
      await new Promise((r) => setTimeout(r, 300));
      expect(receiver.received()).toHaveLength(1);

      await request(app).patch(`/webhooks/${created.body.endpointId}`).set(auth(token)).send({ active: false });

      await seedReport(techToken, "WEBHOOK-TEST-7");
      await new Promise((r) => setTimeout(r, 300));
      expect(receiver.received()).toHaveLength(1); // unchanged

      const history = await request(app)
        .get(`/webhooks/${created.body.endpointId}/deliveries`)
        .set(auth(token));
      expect(history.body.length).toBeGreaterThanOrEqual(1);
    } finally {
      await receiver.close();
    }
  });
});

describe("isolation", () => {
  it("a report created in beta never triggers alpha's webhook", async () => {
    const alphaToken = await portalLogin(app, fx.alpha.adminEmail);
    const receiver = await startReceiver();
    try {
      await request(app)
        .post("/webhooks")
        .set(auth(alphaToken))
        .send({ url: receiver.url, eventTypes: ["report.created"] });

      const betaTechToken = await technicianLogin(app, fx.beta.tenantId, fx.beta.badgeCode);
      await seedReport(betaTechToken, "WEBHOOK-CROSS-TENANT");
      await new Promise((r) => setTimeout(r, 300));

      expect(receiver.received()).toHaveLength(0);
    } finally {
      await receiver.close();
    }
  });

  it("cannot read another tenant's delivery history", async () => {
    const alphaToken = await portalLogin(app, fx.alpha.adminEmail);
    const created = await request(app)
      .post("/webhooks")
      .set(auth(alphaToken))
      .send({ url: "https://example.test/hook", eventTypes: ["report.created"] });

    const betaToken = await portalLogin(app, fx.beta.adminEmail);
    const res = await request(app).get(`/webhooks/${created.body.endpointId}/deliveries`).set(auth(betaToken));
    expect(res.status).toBe(404);
  });
});
