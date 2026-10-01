// The Telnyx adapter end to end: realistic Telnyx webhook JSON, signed
// with a real Ed25519 key, posted to /webhooks/telnyx; outbound REST calls
// captured from a mocked fetch and checked field by field.

import { generateKeyPairSync, sign } from "node:crypto";
import request from "supertest";
import { db } from "../src/lib/db";
import { TelnyxProvider } from "../src/providers/telnyx";
import { verifyTelnyxSignature, publicKeyFromBase64 } from "../src/providers/telnyx/verify";
import { CALLER, NUMBER, OWNER, business, harness, reset, type Harness } from "./helpers";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_B64 = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url").toString("base64");

type Req = { method: string; url: string; body: Record<string, unknown> | null };
let sent: Req[];
let h: Harness;

const fetchMock: typeof fetch = async (input, init) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  sent.push({ method: init?.method ?? "GET", url, body });
  const reply = (json: object, status = 200) => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  if (url.endsWith("/v2/calls") && init?.method === "POST") return reply({ data: { call_control_id: "v3:owner-leg", call_session_id: "sess" } });
  if (url.endsWith("/v2/messages")) return reply({ data: { id: `msg-${sent.length}`, to: [{ phone_number: body?.to, status: "queued" }] } });
  if (url.includes("/actions/hangup") && url.includes("already-gone")) return reply({ errors: [{ title: "Call has already ended", detail: "Call has already ended" }] }, 422);
  if (url.includes("/actions/")) return reply({ data: { result: "ok" } });
  if (url.includes("/available_phone_numbers")) {
    return reply({ data: [{ phone_number: "+15125550123", region_information: [{ region_type: "rate_center", region_name: "AUSTIN" }, { region_type: "state", region_name: "TX" }] }] });
  }
  if (url.endsWith("/v2/number_orders")) return reply({ data: { id: "order-1", status: "pending" } });
  if (url.startsWith("https://s3.telnyx.example/")) return new Response(Buffer.from("MP3BYTES"), { headers: { "content-type": "audio/mpeg" } });
  return reply({ errors: [{ title: "not mocked" }] }, 404);
};

function signed(body: object, opts: { tamper?: boolean; ageSeconds?: number } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000) - (opts.ageSeconds ?? 0));
  const sig = sign(null, Buffer.from(`${ts}|${raw}`), privateKey).toString("base64");
  return request(h.app)
    .post("/webhooks/telnyx")
    .set("content-type", "application/json")
    .set("telnyx-signature-ed25519", sig)
    .set("telnyx-timestamp", ts)
    .send(opts.tamper ? raw.replace(CALLER, "+15559999999") : raw);
}

let n = 0;
const event = (event_type: string, payload: object) => ({ data: { record_type: "event", id: `evt-${++n}`, event_type, occurred_at: new Date().toISOString(), payload }, meta: { attempt: 1 } });
const clientState = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64");
const actions = () => sent.filter((r) => r.url.includes("/actions/")).map((r) => r.url.split("/actions/")[1]);

beforeEach(async () => {
  await reset();
  sent = [];
  h = harness(new TelnyxProvider({ apiKey: "KEY_test", publicKey: PUBLIC_B64, connectionId: "conn-123", messagingProfileId: "mp-456", fetch: fetchMock }));
});
afterAll(() => db.$disconnect());

describe("webhook signatures", () => {
  it("accepts a correctly signed event and rejects tampered, unsigned or stale ones", async () => {
    await business();
    const body = event("call.initiated", { call_control_id: "v3:caller", call_session_id: "s1", direction: "incoming", from: CALLER, to: NUMBER, state: "parked" });
    await signed(body, { tamper: true }).expect(403);
    await request(h.app).post("/webhooks/telnyx").set("content-type", "application/json").send(JSON.stringify(body)).expect(403);
    await signed(body, { ageSeconds: 600 }).expect(403);
    expect(await db.call.count()).toBe(0);
    await signed(body).expect(200);
    expect(await db.call.count()).toBe(1);
  });

  it("verifies against the exact raw body", () => {
    const key = publicKeyFromBase64(PUBLIC_B64);
    const ts = "1700000000";
    const raw = '{"a":1}';
    const sig = sign(null, Buffer.from(`${ts}|${raw}`), privateKey).toString("base64");
    const headers = { "telnyx-signature-ed25519": sig, "telnyx-timestamp": ts };
    expect(verifyTelnyxSignature(key, raw, headers, 1700000000)).toBe(true);
    expect(verifyTelnyxSignature(key, '{"a": 1}', headers, 1700000000)).toBe(false);
  });
});

describe("full missed call over Telnyx", () => {
  it("rings the owner, screens, falls to voicemail, texts back, saves the recording", async () => {
    await business();
    await signed(event("call.initiated", { call_control_id: "v3:caller", call_session_id: "s1", direction: "incoming", from: CALLER, to: NUMBER })).expect(200);

    const dial = sent.find((r) => r.url === "https://api.telnyx.com/v2/calls")!;
    expect(dial.body).toMatchObject({ connection_id: "conn-123", to: OWNER, from: NUMBER, timeout_secs: 18 });
    const state = JSON.parse(Buffer.from(String(dial.body!.client_state), "base64").toString());
    expect(state).toMatchObject({ role: "owner" });
    expect(dial.body!.command_id).toBe(`${state.callId}:dial`);

    // Our outbound leg's own call.initiated is ignored.
    await signed(event("call.initiated", { call_control_id: "v3:owner-leg", direction: "outgoing", from: NUMBER, to: OWNER, client_state: dial.body!.client_state })).expect(200);

    await signed(event("call.answered", { call_control_id: "v3:owner-leg", client_state: dial.body!.client_state })).expect(200);
    const gather = sent.find((r) => r.url.endsWith("/calls/v3%3Aowner-leg/actions/gather_using_speak"))!;
    expect(gather.body).toMatchObject({ voice: "female", maximum_digits: 1, timeout_millis: 8000 });
    expect(String(gather.body!.payload)).toContain("Press 1");

    await signed(event("call.gather.ended", { call_control_id: "v3:owner-leg", digits: "", status: "timeout" })).expect(200);
    expect(actions()).toEqual(["gather_using_speak", "hangup", "answer"]);
    const text = sent.find((r) => r.url.endsWith("/v2/messages"))!;
    expect(text.body).toMatchObject({ from: NUMBER, to: CALLER, messaging_profile_id: "mp-456" });
    expect(String(text.body!.text)).toContain("Sorry we missed your call");

    await signed(event("call.answered", { call_control_id: "v3:caller", client_state: clientState({ callId: state.callId, role: "caller" }) })).expect(200);
    const speak = sent.filter((r) => r.url.includes("/actions/speak")).at(-1)!;
    expect(speak.url).toBe("https://api.telnyx.com/v2/calls/v3%3Acaller/actions/speak");
    await signed(event("call.speak.ended", { call_control_id: "v3:caller", status: "completed" })).expect(200);
    expect(sent.at(-1)!.body).toMatchObject({ format: "mp3", channels: "single", play_beep: true, max_length: 120 });

    await signed(event("call.hangup", { call_control_id: "v3:caller", hangup_cause: "normal_clearing", hangup_source: "caller" })).expect(200);
    await signed(event("call.recording.saved", { call_leg_id: "leg-x", call_session_id: "s1", channels: "single", recording_urls: { mp3: "https://s3.telnyx.example/rec.mp3?sig=1" } })).expect(200);

    const call = await db.call.findFirstOrThrow({ include: { voicemail: true } });
    expect(call).toMatchObject({ outcome: "MISSED", missReason: "NOT_ACCEPTED", state: "ENDED" });
    expect(Buffer.from(call.voicemail!.audio).toString()).toBe("MP3BYTES");
    expect(sent.every((r) => !r.url.includes("api.telnyx.com") || r.url.startsWith("https://api.telnyx.com/v2/"))).toBe(true);
  });

  it("bridges when the owner presses 1", async () => {
    await business();
    await signed(event("call.initiated", { call_control_id: "v3:caller", call_session_id: "s1", direction: "incoming", from: CALLER, to: NUMBER })).expect(200);
    const cs = String(sent[0].body!.client_state);
    const { callId } = JSON.parse(Buffer.from(cs, "base64").toString());
    await signed(event("call.answered", { call_control_id: "v3:owner-leg", client_state: cs })).expect(200);
    await signed(event("call.gather.ended", { call_control_id: "v3:owner-leg", digits: "1", status: "valid" })).expect(200);
    await signed(event("call.answered", { call_control_id: "v3:caller", client_state: clientState({ callId, role: "caller" }) })).expect(200);
    const bridge = sent.find((r) => r.url.includes("/actions/bridge"))!;
    expect(bridge.url).toBe("https://api.telnyx.com/v2/calls/v3%3Acaller/actions/bridge");
    expect(bridge.body).toMatchObject({ call_control_id: "v3:owner-leg" });
    expect(sent.some((r) => r.url.endsWith("/messages"))).toBe(false);
  });

  it("maps hangup causes: caller cancelling while ringing counts as missed", async () => {
    await business();
    await signed(event("call.initiated", { call_control_id: "v3:caller", call_session_id: "s1", direction: "incoming", from: CALLER, to: NUMBER })).expect(200);
    await signed(event("call.hangup", { call_control_id: "v3:caller", hangup_cause: "originator_cancel", hangup_source: "caller" })).expect(200);
    expect(await db.call.findFirstOrThrow()).toMatchObject({ missReason: "CALLER_HUNG_UP" });
    expect(sent.some((r) => r.url.endsWith("/messages"))).toBe(true);
  });
});

describe("SMS over Telnyx", () => {
  it("parses message.received and message.finalized", async () => {
    await business();
    await signed(
      event("message.received", {
        id: "in-1", direction: "inbound", type: "SMS", text: "Is anyone available today?",
        from: { phone_number: CALLER, carrier: "T-Mobile", line_type: "Wireless" }, to: [{ phone_number: NUMBER, status: "webhook_delivered" }],
      }),
    ).expect(200);
    const lead = await db.lead.findFirstOrThrow();
    expect(lead).toMatchObject({ phone: CALLER, job: "Is anyone available today?" });

    const out = await db.message.findFirstOrThrow({ where: { direction: "OUT" } });
    await signed(
      event("message.finalized", {
        id: out.providerId, direction: "outbound", to: [{ phone_number: CALLER, status: "delivery_failed" }],
        errors: [{ code: "40300", title: "Blocked as spam", detail: "Message blocked by carrier as spam" }],
      }),
    ).expect(200);
    expect(await db.message.findUniqueOrThrow({ where: { id: out.id } })).toMatchObject({ status: "failed", error: "Message blocked by carrier as spam" });
  });
});

describe("numbers & errors", () => {
  it("searches with Telnyx filters and orders onto the call control app + messaging profile", async () => {
    const b = await business({ phoneNumber: null as never });
    const search = await h.api(b).get("/numbers/search?areaCode=512").expect(200);
    expect(search.body.numbers).toEqual([{ phoneNumber: "+15125550123", locality: "AUSTIN", region: "TX" }]);
    const url = new URL(sent[0].url);
    expect(url.pathname).toBe("/v2/available_phone_numbers");
    expect(url.searchParams.get("filter[national_destination_code]")).toBe("512");
    expect(url.searchParams.get("filter[features]")).toBe("sms,voice");
    expect(sent[0].url).not.toContain("KEY_test");

    await h.api(b).post("/numbers/buy", { phoneNumber: "+15125550123" }).expect(201);
    expect(sent.at(-1)!.body).toEqual({ phone_numbers: [{ phone_number: "+15125550123" }], connection_id: "conn-123", messaging_profile_id: "mp-456" });
  });

  it("treats hanging up an already-ended call as success", async () => {
    const p = new TelnyxProvider({ apiKey: "k", publicKey: PUBLIC_B64, connectionId: "c", fetch: fetchMock });
    await expect(p.hangup("already-gone")).resolves.toBeUndefined();
  });

  it("sends the API key as a bearer token", async () => {
    let auth = "";
    const p = new TelnyxProvider({
      apiKey: "KEY_live", publicKey: PUBLIC_B64, connectionId: "c",
      fetch: async (_u, init) => {
        auth = new Headers(init?.headers).get("authorization") ?? "";
        return new Response("{}", { status: 200 });
      },
    });
    await p.answer("x");
    expect(auth).toBe("Bearer KEY_live");
  });
});
