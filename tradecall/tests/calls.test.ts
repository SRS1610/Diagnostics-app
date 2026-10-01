import { db } from "../src/lib/db";
import { CALLER, HOUR, MIN, NUMBER, OWNER, business, harness, missedCall, reset, ringIn, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  await reset();
  h = harness();
});
afterAll(() => db.$disconnect());

const call = () => db.call.findFirstOrThrow();
const textsTo = (n: string) => h.fake.smsTo(n);

describe("ring the owner first", () => {
  it("rings the owner's cell from the business number and leaves the caller ringing", async () => {
    await business();
    const { callerLeg } = await ringIn(h);
    const dial = h.fake.last("dial")!;
    expect(dial).toMatchObject({ to: OWNER, from: NUMBER, timeoutSecs: 18 });
    expect(h.fake.commandsFor(callerLeg)).toHaveLength(0); // not answered yet → caller hears ringback
    expect(await call()).toMatchObject({ state: "RINGING_OWNER", outcome: "PENDING" });
  });

  it("connects the call when the owner presses 1, and texts nobody", async () => {
    await business();
    const { callerLeg, ownerLeg, callId } = await ringIn(h);
    await h.event({ type: "call.answered", legId: ownerLeg, state: null } as never);
    expect(h.fake.last("askForKey")).toMatchObject({ legId: ownerLeg });
    expect(h.fake.last("askForKey")!.prompt).toContain("5 5 5, 0 1 0, 2 0 0 0");

    await h.event({ type: "call.keypress", legId: ownerLeg, digits: "1", outcome: "entered", state: null } as never);
    expect(h.fake.last("answer")).toMatchObject({ legId: callerLeg });
    await h.event({ type: "call.answered", legId: callerLeg, state: { callId, role: "caller" } } as never);
    expect(h.fake.last("bridge")).toMatchObject({ legId: callerLeg, otherLegId: ownerLeg });
    expect(await call()).toMatchObject({ state: "CONNECTED", outcome: "ANSWERED" });

    await h.event({ type: "call.ended", legId: callerLeg, cause: "normal", state: null } as never);
    expect(await call()).toMatchObject({ state: "ENDED", outcome: "ANSWERED" });
    expect(h.fake.sms).toHaveLength(0);
  });

  it("treats the owner's voicemail picking up (no keypress) as missed: text, greeting, recording", async () => {
    await business();
    const { callerLeg, ownerLeg, callId } = await ringIn(h);
    await h.event({ type: "call.answered", legId: ownerLeg, state: null } as never);
    await h.event({ type: "call.keypress", legId: ownerLeg, digits: "", outcome: "timeout", state: null } as never);

    expect(h.fake.last("hangup")).toMatchObject({ legId: ownerLeg });
    expect(await call()).toMatchObject({ state: "VOICEMAIL", outcome: "MISSED", missReason: "NOT_ACCEPTED" });
    expect(textsTo(CALLER)).toHaveLength(1);
    expect(textsTo(CALLER)[0].text).toContain("Rapid Rooter");

    expect(h.fake.last("answer")).toMatchObject({ legId: callerLeg });
    await h.event({ type: "call.answered", legId: callerLeg, state: { callId, role: "caller" } } as never);
    expect(h.fake.last("speak")!.text).toContain("Thanks for calling Rapid Rooter");
    await h.event({ type: "call.speech_done", legId: callerLeg, state: null } as never);
    expect(h.fake.last("record")).toMatchObject({ legId: callerLeg, maxSeconds: 120 });
  });

  it("treats no answer / busy as missed", async () => {
    await business();
    await missedCall(h);
    expect(await call()).toMatchObject({ outcome: "MISSED", missReason: "NO_ANSWER" });
    expect(textsTo(CALLER)).toHaveLength(1);
  });

  it("texts back a caller who hangs up while it's still ringing", async () => {
    await business();
    const { callerLeg, ownerLeg } = await ringIn(h);
    await h.event({ type: "call.ended", legId: callerLeg, cause: "caller_cancel", state: null } as never);
    expect(await call()).toMatchObject({ state: "ENDED", outcome: "MISSED", missReason: "CALLER_HUNG_UP" });
    expect(h.fake.last("hangup")).toMatchObject({ legId: ownerLeg });
    expect(textsTo(CALLER)).toHaveLength(1);
    // the owner leg's own hangup event arriving afterwards changes nothing
    await h.event({ type: "call.ended", legId: ownerLeg, cause: "normal", state: null } as never);
    expect(textsTo(CALLER)).toHaveLength(1);
  });

  it("skips screening when it's turned off", async () => {
    await business({ screenCalls: false });
    const { callerLeg, ownerLeg } = await ringIn(h);
    await h.event({ type: "call.answered", legId: ownerLeg, state: null } as never);
    expect(h.fake.last("askForKey")).toBeUndefined();
    expect(h.fake.last("answer")).toMatchObject({ legId: callerLeg });
  });

  it("hangs up after the greeting when voicemail is off", async () => {
    await business({ voicemailEnabled: false });
    const { callerLeg, callId } = await missedCall(h);
    await h.event({ type: "call.answered", legId: callerLeg, state: { callId, role: "caller" } } as never);
    expect(h.fake.last("speak")!.text).not.toContain("leave a message");
    await h.event({ type: "call.speech_done", legId: callerLeg, state: null } as never);
    expect(h.fake.last("hangup")).toMatchObject({ legId: callerLeg });
  });

  it("falls straight to missed if the owner can't be dialled", async () => {
    await business();
    h.fake.dial = async () => {
      throw new Error("provider down");
    };
    await ringIn(h);
    expect(await call()).toMatchObject({ state: "VOICEMAIL", missReason: "NO_ANSWER" });
    expect(textsTo(CALLER)).toHaveLength(1);
  });
});

describe("forwarded mode", () => {
  it("treats every call as already missed", async () => {
    await business({ callMode: "FORWARDED" });
    const callerLeg = "fw-1";
    await h.event({ type: "call.incoming", legId: callerLeg, sessionId: "s", from: CALLER, to: NUMBER } as never);
    expect(h.fake.last("dial")).toBeUndefined();
    expect(h.fake.last("answer")).toMatchObject({ legId: callerLeg });
    expect(await call()).toMatchObject({ outcome: "MISSED", missReason: "FORWARDED" });
    expect(textsTo(CALLER)).toHaveLength(1);
  });
});

describe("text-back rules", () => {
  it("texts once when someone redials inside the window, again after it", async () => {
    await business();
    await missedCall(h);
    h.advance(5 * MIN);
    await missedCall(h);
    expect(textsTo(CALLER)).toHaveLength(1);
    h.advance(61 * MIN);
    await missedCall(h);
    expect(textsTo(CALLER)).toHaveLength(2);
    expect(await db.lead.count()).toBe(1);
  });

  it("uses the after-hours text when closed", async () => {
    await business();
    h.clock.now = new Date("2026-10-04T15:00:00Z"); // Sunday
    await missedCall(h);
    expect(textsTo(CALLER)[0].text).toContain("closed right now");
    expect((await call()).afterHours).toBe(true);
  });

  it("can't text a blocked caller ID, but still logs the miss", async () => {
    await business();
    await missedCall(h, "anonymous");
    expect(h.fake.sms).toHaveLength(0);
    expect(await call()).toMatchObject({ outcome: "MISSED", leadId: null });
  });

  it("never texts someone who replied STOP", async () => {
    await business();
    await missedCall(h);
    await h.sms("STOP");
    h.advance(3 * HOUR);
    await missedCall(h);
    expect(textsTo(CALLER)).toHaveLength(1);
  });

  it("starts a fresh lead with a new number when a past customer calls again", async () => {
    await business();
    await missedCall(h);
    await db.lead.updateMany({ data: { stage: "WON", wonAt: h.clock.now } });
    h.advance(40 * 24 * HOUR);
    await missedCall(h);
    const leads = await db.lead.findMany({ orderBy: { code: "asc" } });
    expect(leads.map((l) => l.code)).toEqual([1, 2]);
  });

  it("records a failed text-back and still sends the caller to voicemail", async () => {
    await business();
    h.fake.failNextSms = true;
    const { callerLeg } = await missedCall(h);
    expect((await db.message.findFirstOrThrow()).status).toBe("failed");
    expect(h.fake.last("answer")).toMatchObject({ legId: callerLeg });
  });
});

describe("the owner calling their own number", () => {
  it("plays a 'your line works' check and logs no lead", async () => {
    await business();
    await h.event({ type: "call.incoming", legId: "self", sessionId: "s", from: OWNER, to: NUMBER } as never);
    const { id } = await call();
    await h.event({ type: "call.answered", legId: "self", state: { callId: id, role: "caller" } } as never);
    expect(h.fake.last("speak")!.text).toContain("set up correctly");
    await h.event({ type: "call.speech_done", legId: "self", state: null } as never);
    expect(h.fake.last("hangup")).toMatchObject({ legId: "self" });
    expect(await db.lead.count()).toBe(0);
    expect(h.fake.sms).toHaveLength(0);
  });
});

describe("voicemail", () => {
  it("downloads and stores the recording immediately, then alerts the owner", async () => {
    await business();
    const { sessionId } = await missedCall(h);
    h.fake.recordings.set("https://recordings.example/vm.mp3", Buffer.from("MP3DATA"));
    await h.event({ type: "call.recording_ready", sessionId, legId: null, url: "https://recordings.example/vm.mp3" } as never);
    const vm = await db.voicemail.findFirstOrThrow();
    expect(Buffer.from(vm.audio).toString()).toBe("MP3DATA");
    const alert = textsTo(OWNER).at(-1)!.text;
    expect(alert).toContain("New voicemail from #1 (555) 010-2000");
  });
});

describe("robustness", () => {
  it("ignores duplicate deliveries of the same event", async () => {
    await business();
    await h.event({ type: "call.incoming", eventId: "same", legId: "L1", sessionId: "s", from: CALLER, to: NUMBER } as never);
    await h.event({ type: "call.incoming", eventId: "same", legId: "L1", sessionId: "s", from: CALLER, to: NUMBER } as never);
    expect(h.fake.commands.filter((c) => c.cmd === "dial")).toHaveLength(1);
  });

  it("hangs up calls to numbers nobody owns", async () => {
    await business();
    await h.event({ type: "call.incoming", legId: "stray", sessionId: "s", from: CALLER, to: "+15550107777" } as never);
    expect(h.fake.last("hangup")).toMatchObject({ legId: "stray" });
  });
});
