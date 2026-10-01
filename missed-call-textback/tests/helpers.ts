import request from "supertest";
import twilio from "twilio";
import type { Business } from "@prisma/client";
import { createApp } from "../src/app";
import { signToken } from "../src/lib/auth";
import type { Deps } from "../src/lib/deps";
import { FakeMailer } from "../src/lib/email";
import { FakeTelephony } from "../src/lib/telephony";
import { prisma } from "../src/lib/prisma";
import { DEFAULT_AFTER_HOURS, DEFAULT_TEXT_BACK } from "../src/lib/templates";
import { DEFAULT_BUSINESS_HOURS } from "../src/lib/time";

// Wednesday 2026-09-30 11:00 in New York (EDT, UTC-4) — inside business hours.
export const WED_11AM_NY = new Date("2026-09-30T15:00:00Z");

export const OWNER = "+15550100001";
export const TWILIO_NUMBER = "+15550109999";
export const CALLER = "+15550102000";

export function makeHarness() {
  const telephony = new FakeTelephony();
  const mailer = new FakeMailer();
  const clock = { now: new Date(WED_11AM_NY) };
  const deps: Deps = { telephony, mailer, now: () => new Date(clock.now) };
  const app = createApp(deps);
  return {
    telephony,
    mailer,
    clock,
    deps,
    app,
    advance(ms: number) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
    /** POST to a Twilio webhook with a valid X-Twilio-Signature. */
    twilioPost(path: string, params: Record<string, string>) {
      const signature = twilio.getExpectedTwilioSignature("test_auth_token", `https://textback.test${path}`, params);
      return request(app).post(path).type("form").set("X-Twilio-Signature", signature).send(params);
    },
    api(business: Business) {
      const token = signToken(business.id);
      return {
        get: (p: string) => request(app).get(`/api${p}`).set("Authorization", `Bearer ${token}`),
        post: (p: string, body?: object) => request(app).post(`/api${p}`).set("Authorization", `Bearer ${token}`).send(body),
        patch: (p: string, body?: object) => request(app).patch(`/api${p}`).set("Authorization", `Bearer ${token}`).send(body),
        put: (p: string, body?: object) => request(app).put(`/api${p}`).set("Authorization", `Bearer ${token}`).send(body),
        delete: (p: string) => request(app).delete(`/api${p}`).set("Authorization", `Bearer ${token}`),
      };
    },
  };
}

export type Harness = ReturnType<typeof makeHarness>;

export async function resetDb() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "ScheduledJob", "Message", "Call", "OptOut", "Lead", "Business" RESTART IDENTITY CASCADE',
  );
}

let seq = 0;
export async function makeBusiness(overrides: Partial<Business> = {}): Promise<Business> {
  seq++;
  return prisma.business.create({
    data: {
      name: "Rapid Rooter Plumbing",
      ownerName: "Dana",
      ownerEmail: `owner${seq}@example.com`,
      passwordHash: "x",
      ownerPhone: OWNER,
      twilioNumber: TWILIO_NUMBER,
      timezone: "America/New_York",
      businessHours: DEFAULT_BUSINESS_HOURS,
      textBackMessage: DEFAULT_TEXT_BACK,
      afterHoursMessage: DEFAULT_AFTER_HOURS,
      ...overrides,
    } as never,
  });
}

let callSeq = 0;
/** Simulates a full missed call in DIAL mode: incoming → nobody answers. */
export async function missCall(h: Harness, from = CALLER, to = TWILIO_NUMBER) {
  const CallSid = `CA${++callSeq}`;
  await h.twilioPost("/twilio/voice/incoming", { CallSid, From: from, To: to }).expect(200);
  const res = await h
    .twilioPost("/twilio/voice/dial-result", { CallSid, From: from, To: to, DialCallStatus: "no-answer" })
    .expect(200);
  return { CallSid, res };
}

let smsSeq = 0;
export function text(h: Harness, body: string, from = CALLER, to = TWILIO_NUMBER) {
  return h.twilioPost("/twilio/sms/incoming", { MessageSid: `SM${++smsSeq}`, From: from, To: to, Body: body }).expect(200);
}

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
