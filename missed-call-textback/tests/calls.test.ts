import { prisma } from "../src/lib/prisma";
import { runDueJobs } from "../src/services/scheduler";
import { CALLER, HOUR, MINUTE, OWNER, TWILIO_NUMBER, makeBusiness, makeHarness, missCall, resetDb, text, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  await resetDb();
  h = makeHarness();
});
afterAll(() => prisma.$disconnect());

describe("Twilio webhook security", () => {
  it("rejects requests without a valid signature", async () => {
    await makeBusiness();
    const { default: request } = await import("supertest");
    await request(h.app)
      .post("/twilio/voice/incoming")
      .type("form")
      .set("X-Twilio-Signature", "forged")
      .send({ CallSid: "CAx", From: CALLER, To: TWILIO_NUMBER })
      .expect(403);
    expect(await prisma.call.count()).toBe(0);
  });
});

describe("DIAL mode", () => {
  it("rings the owner with a press-1 screen and the caller's number as caller ID", async () => {
    await makeBusiness();
    const res = await h.twilioPost("/twilio/voice/incoming", { CallSid: "CA1", From: CALLER, To: TWILIO_NUMBER });
    expect(res.text).toContain("<Dial");
    expect(res.text).toContain(`callerId="${CALLER}"`);
    expect(res.text).toContain(`<Number url="/twilio/voice/screen">${OWNER}</Number>`);
    expect(h.telephony.sent).toHaveLength(0);
  });

  it("texts the caller back when nobody answers, and queues a follow-up", async () => {
    await makeBusiness();
    const { res } = await missCall(h);
    expect(res.text).toContain("<Record");

    const sent = h.telephony.to(CALLER);
    expect(sent).toHaveLength(1);
    expect(sent[0].from).toBe(TWILIO_NUMBER);
    expect(sent[0].body).toContain("Rapid Rooter Plumbing");
    expect(sent[0].body).toContain("Reply STOP");

    const lead = await prisma.lead.findFirstOrThrow();
    expect(lead).toMatchObject({ phone: CALLER, status: "NEW", qualifyStep: 1 });
    const call = await prisma.call.findFirstOrThrow();
    expect(call).toMatchObject({ outcome: "MISSED", leadId: lead.id, afterHours: false });
    const jobs = await prisma.scheduledJob.findMany();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: "FOLLOW_UP", status: "PENDING" });
    expect(jobs[0].runAt.getTime() - h.clock.now.getTime()).toBe(2 * HOUR);
  });

  it("treats the owner's carrier voicemail picking up (no press-1) as a missed call", async () => {
    await makeBusiness();
    await h.twilioPost("/twilio/voice/incoming", { CallSid: "CA1", From: CALLER, To: TWILIO_NUMBER });
    await h.twilioPost("/twilio/voice/dial-result", { CallSid: "CA1", DialCallStatus: "completed", DialCallDuration: "25" });
    expect(h.telephony.to(CALLER)).toHaveLength(1);
    expect((await prisma.call.findFirstOrThrow()).outcome).toBe("MISSED");
  });

  it("records an answered call when the owner presses 1, and sends nothing", async () => {
    await makeBusiness();
    await h.twilioPost("/twilio/voice/incoming", { CallSid: "CA1", From: CALLER, To: TWILIO_NUMBER });
    await h.twilioPost("/twilio/voice/screen-result", { CallSid: "CAchild", ParentCallSid: "CA1", Digits: "1" });
    await h.twilioPost("/twilio/voice/dial-result", { CallSid: "CA1", DialCallStatus: "completed", DialCallDuration: "95" });
    expect(h.telephony.sent).toHaveLength(0);
    expect(await prisma.call.findFirstOrThrow()).toMatchObject({ outcome: "ANSWERED", durationSec: 95 });
    expect(await prisma.lead.count()).toBe(0);
  });

  it("hangs up the owner leg on any key other than 1", async () => {
    await makeBusiness();
    await h.twilioPost("/twilio/voice/incoming", { CallSid: "CA1", From: CALLER, To: TWILIO_NUMBER });
    const res = await h.twilioPost("/twilio/voice/screen-result", { ParentCallSid: "CA1", Digits: "5" });
    expect(res.text).toContain("<Hangup/>");
  });

  it("handles a Twilio webhook retry for the same call only once", async () => {
    await makeBusiness();
    const { CallSid } = await missCall(h);
    await h.twilioPost("/twilio/voice/dial-result", { CallSid, DialCallStatus: "no-answer" }).expect(200);
    expect(h.telephony.to(CALLER)).toHaveLength(1);
  });
});

describe("CARRIER_FORWARD mode", () => {
  it("texts back immediately — the call was already missed on the owner's line", async () => {
    await makeBusiness({ callMode: "CARRIER_FORWARD" });
    const res = await h.twilioPost("/twilio/voice/incoming", { CallSid: "CA1", From: CALLER, To: TWILIO_NUMBER });
    expect(res.text).not.toContain("<Dial");
    expect(h.telephony.to(CALLER)).toHaveLength(1);
  });
});

describe("text-back rules", () => {
  it("sends one text when the same person redials within the dedupe window", async () => {
    await makeBusiness();
    await missCall(h);
    h.advance(5 * MINUTE);
    await missCall(h);
    expect(h.telephony.to(CALLER)).toHaveLength(1);
    expect(await prisma.call.count({ where: { outcome: "MISSED" } })).toBe(2);
    expect(await prisma.lead.count()).toBe(1);
  });

  it("texts again once the dedupe window has passed", async () => {
    await makeBusiness();
    await missCall(h);
    h.advance(61 * MINUTE);
    await missCall(h);
    expect(h.telephony.to(CALLER)).toHaveLength(2);
  });

  it("uses the after-hours message outside business hours", async () => {
    await makeBusiness();
    h.clock.now = new Date("2026-10-04T15:00:00Z"); // Sunday — closed
    await missCall(h);
    expect(h.telephony.to(CALLER)[0].body).toContain("closed right now");
    expect((await prisma.call.findFirstOrThrow()).afterHours).toBe(true);
  });

  it("never texts the owner's own number", async () => {
    await makeBusiness();
    await missCall(h, OWNER);
    expect(h.telephony.sent).toHaveLength(0);
    expect(await prisma.lead.count()).toBe(0);
  });

  it("never texts someone who replied STOP", async () => {
    await makeBusiness();
    await missCall(h);
    await text(h, "STOP");
    h.advance(3 * HOUR);
    await missCall(h);
    expect(h.telephony.to(CALLER)).toHaveLength(1);
  });

  it("opens a new lead for a repeat caller whose previous job is closed", async () => {
    await makeBusiness();
    await missCall(h);
    const first = await prisma.lead.findFirstOrThrow();
    await prisma.lead.update({ where: { id: first.id }, data: { status: "WON", wonAt: h.clock.now } });
    h.advance(30 * 24 * HOUR);
    await missCall(h);
    expect(await prisma.lead.count()).toBe(2);
  });

  it("records the failure and keeps the call when Twilio errors", async () => {
    await makeBusiness();
    h.telephony.failNext = true;
    const { res } = await missCall(h);
    expect(res.status).toBe(200); // caller still hears the voicemail prompt
    const msg = await prisma.message.findFirstOrThrow();
    expect(msg).toMatchObject({ status: "failed", error: "Simulated Twilio failure" });
  });

  it("does not text back a business with no number set up", async () => {
    await makeBusiness({ twilioNumber: "+15550108888" });
    await prisma.business.updateMany({ data: { twilioNumber: null } });
    const res = await h.twilioPost("/twilio/voice/incoming", { CallSid: "CA1", From: CALLER, To: "+15550108888" });
    expect(res.text).toContain("not in service");
  });
});

describe("voicemail", () => {
  it("saves the recording and alerts the owner with a link to the lead", async () => {
    await makeBusiness();
    const { CallSid } = await missCall(h);
    await h
      .twilioPost("/twilio/voice/recording", {
        CallSid,
        RecordingStatus: "completed",
        RecordingUrl: "https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1",
      })
      .expect(204);
    const call = await prisma.call.findFirstOrThrow();
    expect(call.voicemailUrl).toBe("https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1.mp3");
    const alert = h.telephony.to(OWNER);
    expect(alert).toHaveLength(1);
    expect(alert[0].body).toContain("voicemail from (555) 010-2000");
    expect(alert[0].body).toContain(`/#/leads/${call.leadId}`);
  });
});

describe("message status callbacks", () => {
  it("updates delivery status by MessageSid", async () => {
    await makeBusiness();
    await missCall(h);
    const sid = h.telephony.sent[0].sid;
    await h.twilioPost("/twilio/sms/status", { MessageSid: sid, MessageStatus: "undelivered", ErrorCode: "30007" }).expect(204);
    expect(await prisma.message.findFirstOrThrow()).toMatchObject({ status: "undelivered", error: "Twilio error 30007" });
  });
});

describe("follow-up", () => {
  it("is cancelled by a reply", async () => {
    await makeBusiness();
    await missCall(h);
    await text(h, "Need my water heater looked at");
    h.advance(3 * HOUR);
    await runDueJobs(h.deps);
    expect(h.telephony.to(CALLER).filter((m) => m.body.includes("again"))).toHaveLength(0);
  });
});
