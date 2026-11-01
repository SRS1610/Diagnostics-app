// Play out phone calls and texts against a TradeCall server running in
// DEMO MODE (no Telnyx keys), exactly as Telnyx would deliver them.
// Watch the server terminal for what gets "texted" and "said", and the
// dashboard for the leads that appear.
//
//   npm run simulate -- missed                 owner doesn't pick up → caller texted back
//   npm run simulate -- hangup                 caller gives up while it's still ringing
//   npm run simulate -- voicemail              owner's own voicemail answers (no "press 1")
//   npm run simulate -- answered               owner presses 1 and talks to the caller
//   npm run simulate -- conversation           missed call + the caller answers all 3 questions
//   npm run simulate -- text "Need a quote"    a customer texts the business number
//   npm run simulate -- owner-reply "On my way" the owner replies to the latest alert by text
//
// Options: --from +15125559001  (caller; default: a new random caller each run)
//          --to   +15125550199  (business number; default: the seeded demo business)
//          --url  http://localhost:4100

import { randomUUID } from "node:crypto";
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const [scenario, message] = positional;

const URL = opt("url", process.env.SIM_URL ?? "http://localhost:4100").replace(/\/$/, "");
const TO = opt("to", "+15125550199");
const FROM = opt("from", `+1512555${9000 + Math.floor(Math.random() * 999)}`);
const db = new PrismaClient();

async function send(event: Record<string, unknown>) {
  const res = await fetch(`${URL}/webhooks/fake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId: randomUUID(), ...event }),
  });
  if (res.status === 404) throw new Error("The server isn't in demo mode (it has Telnyx keys), so it won't accept simulated events. Unset TELNYX_* to simulate.");
  if (!res.ok) throw new Error(`Server answered ${res.status}: ${await res.text()}`);
}

const pause = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const step = (text: string) => console.log(`\n▶ ${text}`);

/** The caller rings in; returns the caller's and the owner's call legs. */
class Stop extends Error {}

async function ringIn() {
  const business = await db.business.findUnique({ where: { phoneNumber: TO } });
  if (!business) throw new Error(`No business has the number ${TO}. Run "npm run db:seed", or pass --to with a business's number.`);
  const callerLeg = `sim-${randomUUID().slice(0, 8)}`;
  if (business.status === "SUSPENDED") {
    step(`${FROM} calls ${TO} (${business.name})`);
    await send({ type: "call.incoming", legId: callerLeg, sessionId: `sess-${callerLeg}`, from: FROM, to: TO });
    throw new Stop(`${business.name} is suspended, so the call was hung up and nothing was texted (see the server log).`);
  }
  step(`${FROM} calls ${TO}`);
  await send({ type: "call.incoming", legId: callerLeg, sessionId: `sess-${callerLeg}`, from: FROM, to: TO });
  for (let i = 0; i < 20; i++) {
    const call = await db.call.findUnique({ where: { callerLegId: callerLeg } });
    if (call) return { callerLeg, ownerLeg: call.ownerLegId, callId: call.id, sessionId: call.sessionId, state: call.state };
    await pause(100);
  }
  throw new Error("The server didn't record the call — is it running, and on the same database?");
}

async function voicemailLeft(callerLeg: string, sessionId: string | null, callId: string) {
  await pause();
  step("We answer the caller and play the greeting");
  await send({ type: "call.answered", legId: callerLeg, state: { callId, role: "caller" } });
  await pause();
  step("Greeting finishes → recording starts; the caller leaves a message and hangs up");
  await send({ type: "call.speech_done", legId: callerLeg, state: null });
  await send({ type: "call.ended", legId: callerLeg, cause: "normal", state: null });
  await send({ type: "call.recording_ready", sessionId, legId: null, url: "https://example.invalid/demo-voicemail.mp3" });
}

async function text(body: string, from = FROM) {
  step(`${from} texts: "${body}"`);
  await send({ type: "sms.received", providerId: `sim-${randomUUID().slice(0, 8)}`, from, to: TO, text: body });
  await pause();
}

async function main() {
  switch (scenario) {
    case "missed": {
      const c = await ringIn();
      if (c.state === "RINGING_OWNER" && c.ownerLeg) {
        step("Owner's phone rings out (no answer)");
        await send({ type: "call.ended", legId: c.ownerLeg, cause: "no_answer", state: null });
      }
      await voicemailLeft(c.callerLeg, c.sessionId, c.callId);
      break;
    }
    case "hangup": {
      const c = await ringIn();
      await pause();
      step("Caller gives up after a few rings");
      await send({ type: "call.ended", legId: c.callerLeg, cause: "caller_cancel", state: null });
      break;
    }
    case "voicemail": {
      const c = await ringIn();
      if (!c.ownerLeg) throw new Error("This business isn't in 'ring my cell first' mode");
      step("Owner's carrier voicemail picks up — it hears the prompt but nobody presses 1");
      await send({ type: "call.answered", legId: c.ownerLeg, state: { callId: c.callId, role: "owner" } });
      await send({ type: "call.keypress", legId: c.ownerLeg, digits: "", outcome: "timeout", state: null });
      await voicemailLeft(c.callerLeg, c.sessionId, c.callId);
      break;
    }
    case "answered": {
      const c = await ringIn();
      if (!c.ownerLeg) throw new Error("This business isn't in 'ring my cell first' mode");
      step("Owner picks up and presses 1");
      await send({ type: "call.answered", legId: c.ownerLeg, state: { callId: c.callId, role: "owner" } });
      await send({ type: "call.keypress", legId: c.ownerLeg, digits: "1", outcome: "entered", state: null });
      await send({ type: "call.answered", legId: c.callerLeg, state: { callId: c.callId, role: "caller" } });
      await pause();
      step("They talk, then the caller hangs up (no text is sent)");
      await send({ type: "call.ended", legId: c.callerLeg, cause: "normal", state: null });
      break;
    }
    case "conversation": {
      const c = await ringIn();
      if (c.ownerLeg) await send({ type: "call.ended", legId: c.ownerLeg, cause: "no_answer", state: null });
      await pause(500);
      await text(message ?? "Water heater is leaking all over the garage floor");
      await text("1820 Burnet Rd, Austin 78757");
      await text("yes");
      break;
    }
    case "text":
      await text(message ?? "Hi, do you do drain cleaning?");
      break;
    case "owner-reply": {
      const b = await db.business.findUnique({ where: { phoneNumber: TO } });
      if (!b) throw new Error(`No business has the number ${TO}`);
      await text(message ?? "Hi, this is the owner — I can come by at 3pm today.", b.ownerPhone);
      break;
    }
    default:
      console.log("Scenarios: missed | hangup | voicemail | answered | conversation | text \"msg\" | owner-reply \"msg\"\nSee the top of scripts/simulate.ts for options.");
      process.exitCode = 1;
      return;
  }
  console.log(`\n✓ Done. Texts and call steps are in the server terminal; leads are in the dashboard Inbox.`);
}

main()
  .catch((err) => {
    if (err instanceof Stop) return console.log(`\n✓ ${err.message}`);
    console.error(`\n✗ ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
