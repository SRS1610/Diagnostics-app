import request from "supertest";
import type { Business } from "@prisma/client";
import { createApp } from "../src/app";
import type { Deps } from "../src/core/deps";
import type { UserRole } from "@prisma/client";
import { issueToken } from "../src/lib/auth";
import { db } from "../src/lib/db";
import { MemoryMailer } from "../src/lib/mail";
import { DEFAULT_AFTER_HOURS_TEXT, DEFAULT_MISSED_TEXT } from "../src/lib/text";
import { DEFAULT_HOURS } from "../src/lib/time";
import { FakeProvider } from "../src/providers/fake";
import type { Provider, ProviderEvent } from "../src/providers/types";

// Wednesday 2026-09-30, 11:00am in New York (EDT) — business is open.
export const WED_11AM = new Date("2026-09-30T15:00:00Z");
export const OWNER = "+15550100001";
export const NUMBER = "+15550109999";
export const CALLER = "+15550102000";
export const MIN = 60_000;
export const HOUR = 60 * MIN;

export function harness(provider: Provider = new FakeProvider()) {
  const mailer = new MemoryMailer();
  const clock = { now: new Date(WED_11AM) };
  const deps: Deps = { provider, mailer, now: () => new Date(clock.now) };
  const app = createApp(deps);
  let n = 0;
  const h = {
    app,
    deps,
    mailer,
    clock,
    fake: provider as FakeProvider,
    advance(ms: number) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
    /** Deliver a normalized event through the real webhook endpoint (fake provider). */
    async event(ev: Omit<Extract<ProviderEvent, { type: string }>, "eventId"> & { eventId?: string }) {
      const res = await request(app).post("/webhooks/fake").set("content-type", "application/json").send(JSON.stringify({ eventId: `ev${++n}`, ...ev }));
      if (res.status !== 200) throw new Error(`webhook ${res.status}: ${res.text}`);
      return res.body;
    },
    async sms(text: string, from = CALLER, to = NUMBER) {
      return h.event({ type: "sms.received", providerId: `in-${++n}`, from, to, text } as never);
    },
    /** Call the API as the OWNER that business() created for b. */
    api(b: Business) {
      const owner = owners.get(b.id);
      if (!owner) throw new Error("api(b) needs a business made by business()");
      return h.as({ id: owner });
    },
    /** Call the API with any user's (or a raw) token. */
    as(u: { id: string } | string) {
      const auth = `Bearer ${typeof u === "string" ? u : issueToken(u)}`;
      return {
        get: (p: string) => request(app).get(`/api${p}`).set("authorization", auth),
        post: (p: string, body?: object) => request(app).post(`/api${p}`).set("authorization", auth).send(body),
        patch: (p: string, body?: object) => request(app).patch(`/api${p}`).set("authorization", auth).send(body),
        put: (p: string, body?: object) => request(app).put(`/api${p}`).set("authorization", auth).send(body),
        del: (p: string) => request(app).delete(`/api${p}`).set("authorization", auth),
      };
    },
  };
  return h;
}
export type Harness = ReturnType<typeof harness>;

export async function reset() {
  await db.$executeRawUnsafe('TRUNCATE "WebhookEvent", "Job", "Message", "Voicemail", "Call", "OptOut", "Lead", "AuditLog", "Invite", "User", "Business" CASCADE');
}

let seq = 0;
const owners = new Map<string, string>();
/** A business plus its OWNER user (Dana, alerts on, phone = OWNER unless overridden). */
export async function business(over: Partial<Business> = {}): Promise<Business> {
  seq++;
  const b = await db.business.create({
    data: {
      name: "Rapid Rooter", ownerName: "Dana", email: `owner${seq}@example.com`, ownerPhone: OWNER, phoneNumber: NUMBER,
      timezone: "America/New_York", hours: DEFAULT_HOURS, missedText: DEFAULT_MISSED_TEXT, afterHoursText: DEFAULT_AFTER_HOURS_TEXT, ...over,
    } as never,
  });
  const owner = await db.user.create({ data: { businessId: b.id, email: `owner${seq}@example.com`, passwordHash: "x", name: "Dana", role: "OWNER", phone: b.ownerPhone, getsAlerts: true } });
  owners.set(b.id, owner.id);
  return b;
}

export function user(b: Business | null, role: UserRole, over: { phone?: string | null; getsAlerts?: boolean; name?: string; active?: boolean } = {}) {
  seq++;
  return db.user.create({
    data: { businessId: b?.id ?? null, email: `user${seq}@example.com`, passwordHash: "x", name: over.name ?? `${role.toLowerCase()} ${seq}`, role, phone: over.phone ?? null, getsAlerts: over.getsAlerts ?? false, active: over.active ?? true },
  });
}

let legs = 0;
/** Caller rings in (RING_OWNER mode); returns ids for the caller and owner legs. */
export async function ringIn(h: Harness, from = CALLER) {
  const callerLeg = `caller-leg-${++legs}`;
  await h.event({ type: "call.incoming", legId: callerLeg, sessionId: `sess-${legs}`, from, to: NUMBER } as never);
  const dial = h.fake.last("dial");
  return { callerLeg, ownerLeg: dial?.legId ?? "", sessionId: `sess-${legs}`, callId: dial?.opts.state?.callId ?? "" };
}

/** A full "owner didn't pick up" call. */
export async function missedCall(h: Harness, from = CALLER) {
  const legs = await ringIn(h, from);
  await h.event({ type: "call.ended", legId: legs.ownerLeg, cause: "no_answer", state: null } as never);
  return legs;
}
