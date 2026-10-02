// The platform console: only platform admins, cross-tenant, every action logged.

import { db } from "../src/lib/db";
import { runDueJobs } from "../src/core/jobs";
import { sendDigests } from "../src/core/digest";
import { CALLER, HOUR, NUMBER, OWNER, business, harness, missedCall, reset, user, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  await reset();
  h = harness();
});
afterAll(() => db.$disconnect());

async function admin() {
  return user(null, "PLATFORM_ADMIN", { name: "Pat (support)" });
}

describe("access", () => {
  it("is for platform admins only; they can't wander into a tenant without view-as", async () => {
    const b = await business();
    await h.api(b).get("/platform/tenants").expect(403);
    const p = await admin();
    await h.as(p).get("/platform/tenants").expect(200);
    await h.as(p).get("/leads").expect(403);
    await h.as(p).get("/me").expect(403);
  });

  it("the database refuses a platform admin attached to a tenant", async () => {
    const b = await business();
    await expect(db.user.create({ data: { businessId: b.id, email: "bad@example.com", passwordHash: "x", name: "x", role: "PLATFORM_ADMIN" } })).rejects.toThrow();
    await expect(db.user.create({ data: { businessId: null, email: "bad2@example.com", passwordHash: "x", name: "x", role: "OWNER" } })).rejects.toThrow();
  });
});

describe("tenant list", () => {
  it("lists every tenant with usage", async () => {
    const a = await business({ name: "Rapid Rooter" });
    await business({ name: "Cool Air", phoneNumber: "+15550108888", ownerPhone: "+15550100002", plan: "PRO" });
    await missedCall(h);
    const p = await admin();
    const { tenants } = (await h.as(p).get("/platform/tenants")).body;
    expect(tenants).toHaveLength(2);
    expect(tenants.find((t: { id: string }) => t.id === a.id)).toMatchObject({ name: "Rapid Rooter", plan: "STARTER", status: "ACTIVE", activeUsers: 1, textsThisMonth: 1, missedCalls30d: 1, leads30d: 1, includedTexts: 500 });
    expect((await h.as(p).get("/platform/tenants?q=cool")).body.tenants).toHaveLength(1);
    expect((await h.as(p).get("/platform/overview")).body).toMatchObject({ tenants: { ACTIVE: 2 }, textsThisMonth: 1, missedCalls30d: 1 });
  });
});

describe("suspension", () => {
  it("stops service and writes, keeps reads and opt-outs, and resumes cleanly", async () => {
    const b = await business();
    await missedCall(h);
    const p = await admin();
    await h.as(p).post(`/platform/tenants/${b.id}/suspend`, {}).expect(400); // reason required
    await h.as(p).post(`/platform/tenants/${b.id}/suspend`, { reason: "Card declined twice" }).expect(200);
    const before = h.fake.sms.length;

    // dashboard: read yes, write no
    const me = (await h.api(b).get("/me").expect(200)).body;
    expect(me.business).toMatchObject({ status: "SUSPENDED", suspendedReason: "Card declined twice" });
    const lead = await db.lead.findFirstOrThrow();
    expect((await h.api(b).post(`/leads/${lead.id}/messages`, { body: "hi" }).expect(403)).body.error).toContain("suspended");

    // calls aren't answered, texts aren't sent, nudges wait
    await h.event({ type: "call.incoming", legId: "s1", sessionId: "s", from: "+15550103333", to: NUMBER } as never);
    expect(h.fake.last("hangup")).toMatchObject({ legId: "s1" });
    await h.sms("hello?");
    h.advance(3 * HOUR);
    await runDueJobs(h.deps);
    expect(h.fake.sms.length).toBe(before);
    // ...but STOP is still recorded
    await h.sms("STOP", "+15550104444");
    expect(await db.optOut.count({ where: { phone: "+15550104444" } })).toBe(1);

    await h.as(p).post(`/platform/tenants/${b.id}/reactivate`).expect(200);
    await runDueJobs(h.deps);
    expect(h.fake.smsTo(CALLER).at(-1)!.text).toContain("again"); // the held nudge went out
    const actions = (await h.api(b).get("/activity")).body.entries.map((e: { action: string; actorName: string }) => `${e.action}:${e.actorName}`);
    expect(actions).toEqual(expect.arrayContaining(["tenant_suspended:Pat (support)", "tenant_reactivated:Pat (support)"]));
  });

  it("skips suspended tenants' weekly digest", async () => {
    const b = await business();
    await db.business.update({ where: { id: b.id }, data: { status: "SUSPENDED" } });
    h.clock.now = new Date("2026-10-05T12:00:00Z");
    expect(await sendDigests(h.deps)).toBe(0);
  });
});

describe("plans and messaging profiles", () => {
  it("sends through the tenant's own messaging profile once set", async () => {
    const b = await business();
    const p = await admin();
    await h.as(p).patch(`/platform/tenants/${b.id}`, { plan: "PRO", messagingProfileId: "40017f2b-1111-2222-3333-444455556666" }).expect(200);
    await missedCall(h);
    expect(h.fake.smsTo(CALLER)[0].messagingProfileId).toBe("40017f2b-1111-2222-3333-444455556666");
    expect((await db.business.findUniqueOrThrow({ where: { id: b.id } })).plan).toBe("PRO");
    await h.as(p).patch(`/platform/tenants/${b.id}`, { plan: "GOLD" }).expect(400);
  });

  it("lets a platform admin assign an existing number, never one another business has", async () => {
    await business();
    const b = await business({ phoneNumber: null as never, ownerPhone: "+15550100002" });
    const p = await admin();
    await h.as(p).patch(`/platform/tenants/${b.id}`, { phoneNumber: "+15550109999" }).expect(409);
    await h.as(p).patch(`/platform/tenants/${b.id}`, { phoneNumber: "(555) 010-7777" }).expect(200);
    expect((await db.business.findUniqueOrThrow({ where: { id: b.id } })).phoneNumber).toBe("+15550107777");
  });
});

describe("support view (view-as)", () => {
  it("is read-only, scoped to one tenant, and shows up in that tenant's activity", async () => {
    const a = await business();
    const other = await business({ phoneNumber: "+15550108888", ownerPhone: "+15550100002" });
    await missedCall(h);
    const lead = await db.lead.findFirstOrThrow({ where: { businessId: a.id } });
    const p = await admin();
    const { token } = (await h.as(p).post(`/platform/tenants/${a.id}/view-as`).expect(200)).body;
    const view = h.as(token);

    expect((await view.get("/me").expect(200)).body).toMatchObject({ viewAs: true, business: { id: a.id } });
    await view.get(`/leads/${lead.id}`).expect(200);
    await view.get("/activity").expect(200);
    expect((await view.post(`/leads/${lead.id}/messages`, { body: "hi" }).expect(403)).body.error).toContain("read-only");
    await view.patch("/settings", { ringSeconds: 20 }).expect(403);
    await view.get("/platform/tenants").expect(403); // not a way back into the console

    const otherLead = await db.lead.create({ data: { businessId: other.id, phone: "+15550109001", code: 1 } });
    await view.get(`/leads/${otherLead.id}`).expect(404);

    const entry = (await h.api(a).get("/activity")).body.entries.find((e: { action: string }) => e.action === "support_view_opened");
    expect(entry).toMatchObject({ actorName: "Pat (support)", actorKind: "PLATFORM" });
    expect(h.fake.smsTo(OWNER).every((m) => !m.text.includes("hi"))).toBe(true);
  });
});

describe("creating and managing businesses from the console", () => {
  const tokenFrom = (link: string) => link.split("#/invite/")[1];

  it("creates a business and invites its owner, who then sets their own password", async () => {
    const p = await admin();
    const res = await h
      .as(p)
      .post("/platform/tenants", { businessName: "Peak Roofing", ownerName: "Ray", ownerEmail: "Ray@PeakRoofing.com", ownerPhone: "(555) 010-6000", timezone: "America/Denver", plan: "PRO" })
      .expect(201);
    expect(res.body.tenant).toMatchObject({ name: "Peak Roofing", email: "ray@peakroofing.com", ownerPhone: "+15550106000", plan: "PRO", status: "ACTIVE", timezone: "America/Denver" });
    expect(res.body.emailed).toBe(true);
    expect(h.mailer.sent[0]).toMatchObject({ to: "ray@peakroofing.com", subject: "Your TradeCall account for Peak Roofing is ready" });
    expect(await db.user.count({ where: { businessId: res.body.tenant.id } })).toBe(0); // no password chosen by staff

    const accepted = await (await import("supertest")).default(h.app)
      .post(`/api/auth/invite/${tokenFrom(res.body.link)}/accept`)
      .send({ name: "Ray", password: "ray-password", phone: "555-010-6000" })
      .expect(201);
    const me = (await h.as(accepted.body.token).get("/me").expect(200)).body;
    expect(me).toMatchObject({ role: "OWNER", business: { name: "Peak Roofing" } });

    const actions = (await h.as(accepted.body.token).get("/activity")).body.entries.map((e: { action: string; actorKind: string }) => `${e.action}:${e.actorKind}`);
    expect(actions).toEqual(expect.arrayContaining(["tenant_created:PLATFORM", "invite_sent:PLATFORM", "invite_accepted:USER"]));
    expect((await h.as(p).get("/platform/tenants")).body.tenants.map((t: { name: string }) => t.name)).toContain("Peak Roofing");
  });

  it("validates input and refuses an email that already has an account", async () => {
    const b = await business();
    const p = await admin();
    const owner = await db.user.findFirstOrThrow({ where: { businessId: b.id } });
    await h.as(p).post("/platform/tenants", { businessName: "X", ownerName: "Y", ownerEmail: "not-an-email", ownerPhone: "5550106000" }).expect(400);
    await h.as(p).post("/platform/tenants", { businessName: "Dup Co", ownerName: "Y", ownerEmail: owner.email, ownerPhone: "5550106000" }).expect(409);
    await h.api(b).post("/platform/tenants", { businessName: "Sneaky", ownerName: "Y", ownerEmail: "s@example.com", ownerPhone: "5550106000" }).expect(403);
  });

  it("re-invites a lost owner, lists and cancels pending invites, and edits the business's details", async () => {
    const p = await admin();
    const { tenant } = (await h.as(p).post("/platform/tenants", { businessName: "Peak Roofing", ownerName: "Ray", ownerEmail: "ray@example.com", ownerPhone: "5550106000" })).body;
    const again = (await h.as(p).post(`/platform/tenants/${tenant.id}/invites`, { email: "ray@example.com", role: "OWNER" }).expect(201)).body;
    const detail = (await h.as(p).get(`/platform/tenants/${tenant.id}`)).body;
    expect(detail.invites).toHaveLength(1); // the re-invite replaced the first link
    await h.as(p).del(`/platform/tenants/${tenant.id}/invites/${again.invite.id}`).expect(200);
    expect((await h.as(p).get(`/platform/tenants/${tenant.id}`)).body.invites).toHaveLength(0);

    await h.as(p).patch(`/platform/tenants/${tenant.id}`, { name: "Peak Roofing & Gutters", email: "billing@peak.example" }).expect(200);
    expect(await db.business.findUniqueOrThrow({ where: { id: tenant.id } })).toMatchObject({ name: "Peak Roofing & Gutters", email: "billing@peak.example" });
  });

  it("respects the plan's seats when staff invite people", async () => {
    const p = await admin();
    const { tenant } = (await h.as(p).post("/platform/tenants", { businessName: "Tiny Co", ownerName: "T", ownerEmail: "t@example.com", ownerPhone: "5550106000", plan: "STARTER" })).body;
    await h.as(p).post(`/platform/tenants/${tenant.id}/invites`, { email: "second@example.com", role: "MEMBER" }).expect(201);
    await h.as(p).post(`/platform/tenants/${tenant.id}/invites`, { email: "third@example.com", role: "MEMBER" }).expect(409);
  });
});
