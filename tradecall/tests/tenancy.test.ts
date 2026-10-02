// Multi-tenant behaviour: roles, invites, seats, team alerts, isolation.

import request from "supertest";
import { db } from "../src/lib/db";
import { CALLER, NUMBER, OWNER, business, harness, missedCall, reset, user, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  await reset();
  h = harness();
});
afterAll(() => db.$disconnect());

const lastTo = (n: string) => h.fake.smsTo(n).at(-1)?.text ?? "";
const tokenFrom = (link: string) => link.split("#/invite/")[1];

describe("roles", () => {
  it("members work the inbox but can't change settings, numbers, team or see activity", async () => {
    const b = await business();
    const m = await user(b, "MEMBER");
    await missedCall(h);
    const lead = await db.lead.findFirstOrThrow();
    const asM = h.as(m);

    await asM.get("/leads").expect(200);
    await asM.post(`/leads/${lead.id}/messages`, { body: "Hi from the office" }).expect(201);
    await asM.patch(`/leads/${lead.id}`, { stage: "QUALIFIED" }).expect(200);
    await asM.patch("/settings", { ringSeconds: 20 }).expect(403);
    await asM.get("/numbers/search?areaCode=512").expect(403);
    await asM.post("/team/invites", { email: "x@example.com", role: "MEMBER" }).expect(403);
    await asM.get("/activity").expect(403);
    const team = (await asM.get("/team").expect(200)).body;
    expect(team).toMatchObject({ canManage: false, invites: [] });
    expect(team.users).toHaveLength(2);
  });

  it("admins manage the team but can't touch owners", async () => {
    const b = await business({ plan: "PRO" });
    const admin = await user(b, "ADMIN");
    const owner = await db.user.findFirstOrThrow({ where: { businessId: b.id, role: "OWNER" } });
    const asA = h.as(admin);
    await asA.post("/team/invites", { email: "boss@example.com", role: "OWNER" }).expect(403);
    await asA.patch(`/team/${owner.id}`, { active: false }).expect(403);
    await asA.patch(`/team/${admin.id}`, { role: "MEMBER" }).expect(400); // not on yourself
    await asA.post("/team/invites", { email: "tech@example.com", role: "MEMBER" }).expect(201);
  });

  it("always keeps at least one active owner", async () => {
    const b = await business();
    const owner = await db.user.findFirstOrThrow({ where: { businessId: b.id } });
    const second = await user(b, "OWNER");
    const asSecond = h.as(second);
    await asSecond.patch(`/team/${owner.id}`, { role: "ADMIN" }).expect(200);
    await h.as(owner).patch(`/team/${second.id}`, { active: false }).expect(403); // owner is now an admin
    const last = await asSecond.patch(`/team/${second.id}`, { active: false });
    expect(last.status).toBe(400);
  });

  it("role changes and deactivation take effect on the very next request", async () => {
    const b = await business();
    const m = await user(b, "ADMIN");
    const token = (await request(h.app).post("/api/auth/login").send({ email: m.email, password: "x" })).status; // passwordHash "x" isn't bcrypt
    expect(token).toBe(401);
    const asM = h.as(m);
    await asM.get("/activity").expect(200);
    await h.api(b).patch(`/team/${m.id}`, { role: "MEMBER" }).expect(200);
    await asM.get("/activity").expect(403);
    await h.api(b).patch(`/team/${m.id}`, { active: false }).expect(200);
    await asM.get("/leads").expect(401);
  });
});

describe("invites", () => {
  it("invite → accept → signed in to the same business; link works once", async () => {
    const b = await business({ name: "Rapid Rooter" });
    const sent = (await h.api(b).post("/team/invites", { email: "Tech@Example.com", role: "MEMBER" }).expect(201)).body;
    expect(sent.invite).toMatchObject({ email: "tech@example.com", role: "MEMBER" });
    expect(h.mailer.sent[0]).toMatchObject({ to: "tech@example.com" });
    expect(h.mailer.sent[0].text).toContain(sent.link);
    const token = tokenFrom(sent.link);
    expect(await db.invite.count({ where: { tokenHash: token } })).toBe(0); // only the hash is stored

    expect((await request(h.app).get(`/api/auth/invite/${token}`).expect(200)).body).toEqual({ businessName: "Rapid Rooter", email: "tech@example.com", role: "MEMBER" });
    const accepted = await request(h.app).post(`/api/auth/invite/${token}/accept`).send({ name: "Jo", password: "jo-password", phone: "555-010-3030" }).expect(201);
    const me = (await h.as(accepted.body.token).get("/me").expect(200)).body;
    expect(me).toMatchObject({ business: { id: b.id }, user: { name: "Jo", role: "MEMBER", phone: "+15550103030", getsAlerts: true } });

    await request(h.app).post(`/api/auth/invite/${token}/accept`).send({ name: "Again", password: "12345678" }).expect(404);
    await request(h.app).post("/api/auth/login").send({ email: "tech@example.com", password: "jo-password" }).expect(200);
    const actions = (await h.api(b).get("/activity")).body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["invite_sent", "invite_accepted", "login"]));
  });

  it("expired and revoked invites can't be used", async () => {
    const b = await business();
    const one = (await h.api(b).post("/team/invites", { email: "a@example.com", role: "MEMBER" })).body;
    h.advance(8 * 86_400_000);
    await request(h.app).get(`/api/auth/invite/${tokenFrom(one.link)}`).expect(410);
    const two = (await h.api(b).post("/team/invites", { email: "b@example.com", role: "MEMBER" })).body;
    await h.api(b).del(`/team/invites/${two.invite.id}`).expect(200);
    await request(h.app).post(`/api/auth/invite/${tokenFrom(two.link)}/accept`).send({ name: "B", password: "12345678" }).expect(404);
  });

  it("enforces the plan's seats; re-inviting the same person doesn't use another", async () => {
    const b = await business({ plan: "STARTER" }); // 2 seats: owner + 1
    await h.api(b).post("/team/invites", { email: "a@example.com", role: "MEMBER" }).expect(201);
    await h.api(b).post("/team/invites", { email: "a@example.com", role: "ADMIN" }).expect(201);
    const full = await h.api(b).post("/team/invites", { email: "c@example.com", role: "MEMBER" }).expect(409);
    expect(full.body.error).toContain("2 seats");
    await db.business.update({ where: { id: b.id }, data: { plan: "PRO" } });
    await h.api(b).post("/team/invites", { email: "c@example.com", role: "MEMBER" }).expect(201);
  });

  it("doesn't reveal whether an email is on another business, but won't create a second account", async () => {
    const a = await business();
    const other = await business({ phoneNumber: "+15550108888" });
    const someone = await user(other, "MEMBER");
    const sent = (await h.api(a).post("/team/invites", { email: someone.email, role: "MEMBER" }).expect(201)).body;
    const res = await request(h.app).post(`/api/auth/invite/${tokenFrom(sent.link)}/accept`).send({ name: "X", password: "12345678" }).expect(409);
    expect(res.body.error).toContain("already has an account");
    expect((await db.user.findUniqueOrThrow({ where: { id: someone.id } })).businessId).toBe(other.id);
  });
});

describe("team alerts and replies", () => {
  it("alerts everyone with alerts on, and nobody else", async () => {
    const b = await business();
    await user(b, "MEMBER", { phone: "+15550103001", getsAlerts: true });
    await user(b, "MEMBER", { phone: "+15550103002", getsAlerts: false });
    await missedCall(h);
    await h.sms("Burst pipe!");
    await h.sms("1 Main");
    await h.sms("yes");
    expect(lastTo(OWNER)).toContain("URGENT");
    expect(lastTo("+15550103001")).toContain("URGENT");
    expect(h.fake.smsTo("+15550103002")).toHaveLength(0);
  });

  it("falls back to the ring phone if nobody has alerts on", async () => {
    const b = await business();
    await db.user.updateMany({ where: { businessId: b.id }, data: { getsAlerts: false } });
    await missedCall(h);
    await h.sms("hello");
    await h.sms("2 Oak");
    await h.sms("no");
    expect(lastTo(OWNER)).toContain("New lead #1");
  });

  it("any team member can reply by text, and is named on the message", async () => {
    const b = await business();
    await user(b, "MEMBER", { phone: "+15550103001", getsAlerts: true, name: "Jo" });
    await missedCall(h);
    await h.sms("#1 Jo here, on my way", "+15550103001");
    expect(lastTo(CALLER)).toBe("Jo here, on my way");
    expect(await db.message.findFirstOrThrow({ where: { kind: "OWNER" } })).toMatchObject({ sentBy: "Jo" });
    await h.sms("LEADS", "+15550103001");
    expect(lastTo("+15550103001")).toContain("#1");
    expect(lastTo(OWNER)).not.toContain("Open leads"); // command replies go only to who asked
  });

  it("treats a team member calling in as a line test, not a lead", async () => {
    const b = await business();
    await user(b, "MEMBER", { phone: "+15550103001" });
    await h.event({ type: "call.incoming", legId: "t", sessionId: "s", from: "+15550103001", to: NUMBER } as never);
    expect(await db.call.findFirstOrThrow()).toMatchObject({ state: "SELF_TEST" });
    expect(await db.lead.count()).toBe(0);
  });

  it("dashboard replies record who sent them", async () => {
    const b = await business();
    await missedCall(h);
    const lead = await db.lead.findFirstOrThrow();
    await h.api(b).post(`/leads/${lead.id}/messages`, { body: "hi" }).expect(201);
    expect(await db.message.findFirstOrThrow({ where: { kind: "OWNER" } })).toMatchObject({ sentBy: "Dana" });
  });
});

describe("isolation between businesses", () => {
  it("can't see or change another business's team, invites or activity", async () => {
    const a = await business();
    const b = await business({ phoneNumber: "+15550108888", ownerPhone: "+15550100002", plan: "PRO" });
    const bMember = await user(b, "MEMBER");
    const bInvite = (await h.api(b).post("/team/invites", { email: "z@example.com", role: "MEMBER" })).body.invite;
    await h.api(b).patch("/settings", { ringSeconds: 22 });

    const asA = h.api(a);
    expect((await asA.get("/team")).body.users.map((u: { email: string }) => u.email)).not.toContain(bMember.email);
    await asA.patch(`/team/${bMember.id}`, { active: false }).expect(404);
    await asA.del(`/team/invites/${bInvite.id}`).expect(404);
    const activity = (await asA.get("/activity")).body.entries;
    expect(activity.every((e: { action: string }) => e.action !== "settings_updated")).toBe(true);
    expect((await db.user.findUniqueOrThrow({ where: { id: bMember.id } })).active).toBe(true);
  });

  it("shows plan usage for this business only", async () => {
    const a = await business({ plan: "STARTER" });
    await business({ phoneNumber: "+15550108888", ownerPhone: "+15550100002" });
    await missedCall(h);
    await missedCall(h, "+15550103333");
    await h.event({ type: "call.incoming", legId: "other", sessionId: "s", from: "+15550104444", to: "+15550108888" } as never);
    await h.event({ type: "call.ended", legId: h.fake.last("dial")!.legId, cause: "no_answer", state: null } as never);
    const me = (await h.api(a).get("/me")).body;
    expect(me.plan).toMatchObject({ id: "STARTER", includedTexts: 500, texts: { sent: 2, included: 500, overage: 0 }, seats: { used: 1, limit: 2 } });
  });
});
