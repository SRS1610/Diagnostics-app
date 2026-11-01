// Demo-mode simulator: plays out a phone call or text exactly as Telnyx
// would deliver it — through the same event handler real webhooks use —
// and returns a transcript of what each phone would have heard or
// received. Only available while the server runs on the FakeProvider.

import { randomUUID } from "node:crypto";
import type { Business } from "@prisma/client";
import type { Deps } from "../core/deps";
import { handleEvent } from "../core/events";
import { db } from "../lib/db";
import { prettyPhone } from "../lib/phone";
import { FakeProvider } from "../providers/fake";
import type { ProviderEvent } from "../providers/types";

export const SCENARIOS = {
  missed: "Missed call — owner doesn't pick up",
  hangup: "Caller hangs up while it's still ringing",
  voicemail: "Owner's own voicemail answers (nobody presses 1)",
  answered: "Owner answers and presses 1",
  conversation: "Missed call, then the caller answers the 3 questions",
  text: "A customer texts the business number",
  "owner-reply": "Owner replies to the latest alert by text",
} as const;
export type Scenario = keyof typeof SCENARIOS;

export interface Step {
  kind: "action" | "sms" | "voice";
  who?: string; // whose phone: "Caller", "Mike (alerts)", …
  text: string;
}

export class SimulatorError extends Error {}

type Ev = { [K in ProviderEvent["type"]]: Omit<Extract<ProviderEvent, { type: K }>, "eventId"> }[ProviderEvent["type"]];

export async function simulate(
  deps: Deps,
  b: Business,
  scenario: Scenario,
  opts: { from?: string; text?: string } = {},
): Promise<{ steps: Step[]; caller: string; leadId: string | null }> {
  const fake = deps.provider;
  if (!(fake instanceof FakeProvider)) throw new SimulatorError("The simulator only works in demo mode");
  if (b.status !== "ACTIVE") throw new SimulatorError("This business is suspended, so calls and texts are switched off");
  if (!b.phoneNumber) throw new SimulatorError("Connect a business number first (Settings → Setup)");

  const caller = opts.from ?? `+1512555${String(9000 + Math.floor(Math.random() * 999))}`;
  const steps: Step[] = [];
  const team = await db.user.findMany({ where: { businessId: b.id, phone: { not: null } }, select: { name: true, phone: true } });
  const nameFor = (phone: string) =>
    phone === caller ? "Caller" : team.find((u) => u.phone === phone)?.name ?? (phone === b.ownerPhone ? `${b.ownerName} (ring phone)` : `Customer ${prettyPhone(phone)}`);
  let smsMark = fake.sms.length;
  let cmdMark = fake.commands.length;

  // Turn whatever the system just did into readable steps.
  const collect = () => {
    for (const c of fake.commands.slice(cmdMark)) {
      if (c.cmd === "dial") steps.push({ kind: "voice", who: nameFor(c.to), text: `📞 Phone rings (for up to ${c.timeoutSecs}s)` });
      else if (c.cmd === "askForKey") steps.push({ kind: "voice", who: "Owner's phone", text: `🔊 “${c.prompt}”` });
      else if (c.cmd === "speak") steps.push({ kind: "voice", who: "Caller", text: `🔊 “${c.text}”` });
      else if (c.cmd === "bridge") steps.push({ kind: "voice", text: "🔗 Caller and owner are connected" });
      else if (c.cmd === "record") steps.push({ kind: "voice", who: "Caller", text: "⏺ Beep — recording their voicemail" });
    }
    for (const m of fake.sms.slice(smsMark)) steps.push({ kind: "sms", who: nameFor(m.to), text: m.text });
    smsMark = fake.sms.length;
    cmdMark = fake.commands.length;
  };
  const send = async (ev: Ev) => {
    await handleEvent(deps, { eventId: randomUUID(), ...ev } as ProviderEvent);
    collect();
  };
  const act = (text: string) => steps.push({ kind: "action", text });

  const ringIn = async () => {
    const legId = `sim-${randomUUID().slice(0, 8)}`;
    act(`${prettyPhone(caller)} calls ${prettyPhone(b.phoneNumber!)}`);
    await send({ type: "call.incoming", legId, sessionId: `sess-${legId}`, from: caller, to: b.phoneNumber! });
    const call = await db.call.findUniqueOrThrow({ where: { callerLegId: legId } });
    return { legId, call };
  };
  const leaveVoicemail = async (legId: string, callId: string, sessionId: string | null) => {
    await send({ type: "call.answered", legId, state: { callId, role: "caller" } });
    await send({ type: "call.speech_done", legId, state: null });
    act("The caller leaves a message and hangs up");
    await send({ type: "call.ended", legId, cause: "normal", state: null });
    await send({ type: "call.recording_ready", sessionId, legId: null, url: "https://example.invalid/demo-voicemail.mp3" });
  };
  const textIn = async (text: string, from = caller) => {
    act(`${from === caller ? "Caller" : nameFor(from)} texts: “${text}”`);
    await send({ type: "sms.received", providerId: `sim-${randomUUID().slice(0, 8)}`, from, to: b.phoneNumber!, text });
  };

  switch (scenario) {
    case "missed":
    case "conversation": {
      const { legId, call } = await ringIn();
      if (call.ownerLegId) {
        act("Nobody answers the owner's phone");
        await send({ type: "call.ended", legId: call.ownerLegId, cause: "no_answer", state: null });
      }
      if (scenario === "missed") {
        await leaveVoicemail(legId, call.id, call.sessionId);
      } else {
        act("The caller hangs up without leaving a message");
        await send({ type: "call.ended", legId, cause: "normal", state: null });
        await textIn(opts.text || "Water heater is leaking all over the garage floor");
        await textIn("1820 Burnet Rd, Austin 78757");
        await textIn("yes");
      }
      break;
    }
    case "hangup": {
      const { legId } = await ringIn();
      act("The caller gives up after a few rings");
      await send({ type: "call.ended", legId, cause: "caller_cancel", state: null });
      break;
    }
    case "voicemail":
    case "answered": {
      const { legId, call } = await ringIn();
      if (!call.ownerLegId) throw new SimulatorError("This business uses carrier forwarding, so there's no owner phone to answer — try “Missed call”");
      act(scenario === "voicemail" ? "The owner's carrier voicemail picks up" : "The owner picks up");
      await send({ type: "call.answered", legId: call.ownerLegId, state: { callId: call.id, role: "owner" } });
      if (scenario === "voicemail") {
        act("…it never presses 1");
        await send({ type: "call.keypress", legId: call.ownerLegId, digits: "", outcome: "timeout", state: null });
        await leaveVoicemail(legId, call.id, call.sessionId);
      } else {
        act("The owner presses 1");
        await send({ type: "call.keypress", legId: call.ownerLegId, digits: "1", outcome: "entered", state: null });
        await send({ type: "call.answered", legId, state: { callId: call.id, role: "caller" } });
        act("They talk, then hang up — no text is sent");
        await send({ type: "call.ended", legId, cause: "normal", state: null });
      }
      break;
    }
    case "text":
      await textIn(opts.text || "Hi, do you do drain cleaning?");
      break;
    case "owner-reply": {
      const from = team.find((u) => u.phone)?.phone ?? b.ownerPhone;
      await textIn(opts.text || "Hi, this is the owner — I can come by at 3pm today.", from);
      break;
    }
  }

  const lead = await db.lead.findFirst({ where: { businessId: b.id, phone: scenario === "owner-reply" ? undefined : caller }, orderBy: { updatedAt: "desc" } });
  return { steps, caller, leadId: lead?.id ?? null };
}
