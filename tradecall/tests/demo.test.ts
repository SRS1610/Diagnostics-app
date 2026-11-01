// The in-app demo simulator ("Try it" page).

import { generateKeyPairSync } from "node:crypto";
import { db } from "../src/lib/db";
import { TelnyxProvider } from "../src/providers/telnyx";
import { business, harness, reset, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  await reset();
  h = harness();
});
afterAll(() => db.$disconnect());

const run = async (b: Awaited<ReturnType<typeof business>>, scenario: string, extra: object = {}) =>
  (await h.api(b).post("/demo/simulate", { scenario, ...extra }).expect(200)).body as { steps: { kind: string; who?: string; text: string }[]; caller: string; leadId: string | null };
const smsTo = (r: Awaited<ReturnType<typeof run>>, who: string) => r.steps.filter((s) => s.kind === "sms" && s.who === who).map((s) => s.text);

it("missed call: caller is texted, hears the greeting, team gets the voicemail alert", async () => {
  const b = await business();
  const r = await run(b, "missed");
  expect(smsTo(r, "Caller")[0]).toContain("Sorry we missed your call");
  expect(r.steps.some((s) => s.who === "Caller" && s.text.includes("Thanks for calling Rapid Rooter"))).toBe(true);
  expect(smsTo(r, "Dana")[0]).toContain("New voicemail");
  expect(r.leadId).toBeTruthy();
});

it("answered call sends no text", async () => {
  const b = await business();
  const r = await run(b, "answered");
  expect(r.steps.filter((s) => s.kind === "sms")).toHaveLength(0);
  expect(r.steps.some((s) => s.text.includes("connected"))).toBe(true);
});

it("hang-up and owner-voicemail still text the caller", async () => {
  const b = await business();
  expect(smsTo(await run(b, "hangup"), "Caller")).toHaveLength(1);
  expect(smsTo(await run(b, "voicemail"), "Caller")).toHaveLength(1);
});

it("conversation ends with an urgent summary to the team, and the owner can reply", async () => {
  const b = await business();
  const r = await run(b, "conversation", { from: "+15550109001" });
  expect(smsTo(r, "Caller")).toHaveLength(4);
  expect(smsTo(r, "Dana").at(-1)).toContain("URGENT");
  const reply = await run(b, "owner-reply", { text: "On my way" });
  expect(reply.steps.find((s) => s.kind === "sms")).toMatchObject({ who: "Customer (555) 010-9001", text: "On my way" });
});

it("explains why it can't run for a suspended business", async () => {
  const b = await business({ status: "SUSPENDED" });
  // writes are blocked for suspended accounts before the simulator even runs
  await h.api(b).post("/demo/simulate", { scenario: "missed" }).expect(403);
  await db.business.update({ where: { id: b.id }, data: { status: "ACTIVE", phoneNumber: null } });
  expect((await h.api(b).post("/demo/simulate", { scenario: "missed" }).expect(409)).body.error).toContain("Connect a business number");
});

it("does not exist on a real (Telnyx) server", async () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const key = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url").toString("base64");
  h = harness(new TelnyxProvider({ apiKey: "k", publicKey: key, connectionId: "c", fetch: async () => new Response("{}") }));
  const b = await business();
  await h.api(b).post("/demo/simulate", { scenario: "missed" }).expect(404);
});
