// Live call handling, driven one provider event at a time.
//
// RING_OWNER mode
//   caller dials us ─► we ring the owner's cell (caller hears ringback)
//      owner answers ─► "Customer call from …, press 1"   (SCREENING)
//         presses 1 ─► answer caller, bridge both legs     (CONNECTED)
//         anything else / their voicemail picked up ─► missed
//      owner doesn't answer / busy / declines ─► missed
//      caller hangs up while it's still ringing ─► missed (text them!)
//   missed ─► text-back + answer caller, play greeting, record voicemail
//
// FORWARDED mode: the owner's carrier already let it ring, so every call
// that reaches us is missed on arrival.
//
// Every state change goes through `move()`, a conditional update
// (WHERE state IN from). Provider events can arrive out of order or twice;
// only the first event to make a given transition acts on it.

import type { Business, Call, CallState, MissReason, Prisma } from "@prisma/client";
import { db } from "../lib/db";
import { prettyPhone, spokenPhone, toE164 } from "../lib/phone";
import { VOICE_GREETING, VOICE_LEAVE_MESSAGE, VOICE_SCREEN, VOICE_SELF_TEST, fill } from "../lib/text";
import { ProviderError, type ProviderEvent } from "../providers/types";
import type { Deps } from "./deps";
import { onMissedCall } from "./missed";
import { leadUrl, textTeam, vars } from "./outbox";
import { teamMemberByPhone } from "./team";

const SCREEN_TIMEOUT_MS = 8000;
const VOICEMAIL_MAX_SECONDS = 120;

type VoiceEvent = Extract<ProviderEvent, { type: `call.${string}` }>;
type CallWithBiz = Call & { business: Business };

async function move(callId: string, from: CallState[], data: Prisma.CallUpdateManyMutationInput): Promise<boolean> {
  const r = await db.call.updateMany({ where: { id: callId, state: { in: from } }, data });
  return r.count === 1;
}

/**
 * Commands that lose a race — the leg already hung up, or was already
 * answered by an earlier command — come back as 422s. That's expected in a
 * live call; log and move on. Anything else (auth, 5xx) still throws.
 */
async function tolerate(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ProviderError && (err.gone || err.status === 422)) {
      if (!err.gone) console.warn(`[call] ignored: ${err.message}`);
      return;
    }
    throw err;
  }
}

async function findByLeg(legId: string): Promise<{ call: CallWithBiz; role: "caller" | "owner" } | null> {
  const call = await db.call.findFirst({
    where: { OR: [{ callerLegId: legId }, { ownerLegId: legId }] },
    include: { business: true },
  });
  if (!call) return null;
  return { call, role: call.callerLegId === legId ? "caller" : "owner" };
}

/** Caller leg: play greeting (answering first if we haven't yet). */
async function startVoicemail(deps: Deps, call: CallWithBiz) {
  if (call.callerAnswered) {
    await tolerate(deps.provider.speak(call.callerLegId, greeting(call.business), { commandId: `${call.id}:greet` }));
  } else {
    await tolerate(deps.provider.answer(call.callerLegId, { state: { callId: call.id, role: "caller" }, commandId: `${call.id}:answer-vm` }));
  }
}

function greeting(b: Business): string {
  return fill(VOICE_GREETING, vars(b)) + (b.voicemailEnabled ? VOICE_LEAVE_MESSAGE : "");
}

/** Owner didn't take it: mark missed, text the caller, send them to voicemail. */
async function missed(deps: Deps, callId: string, from: CallState[], reason: MissReason) {
  if (!(await move(callId, from, { state: "VOICEMAIL" }))) return;
  const call = await db.call.findUniqueOrThrow({ where: { id: callId }, include: { business: true } });
  if (call.ownerLegId) await tolerate(deps.provider.hangup(call.ownerLegId, { commandId: `${call.id}:hangup-owner` }));
  await onMissedCall(deps, call.business, call, reason);
  await startVoicemail(deps, call);
}

export async function handleVoiceEvent(deps: Deps, ev: VoiceEvent): Promise<void> {
  switch (ev.type) {
    case "call.incoming":
      return incoming(deps, ev);
    case "call.recording_ready":
      return recordingReady(deps, ev);
  }

  const found = await findByLeg(ev.legId);
  if (!found) return; // not a call we're tracking
  const { call, role } = found;
  const b = call.business;

  switch (ev.type) {
    case "call.answered": {
      if (role === "owner") {
        if (b.screenCalls) {
          if (await move(call.id, ["RINGING_OWNER"], { state: "SCREENING" })) {
            const prompt = fill(VOICE_SCREEN, { caller: /^\+\d+$/.test(call.fromNumber) ? spokenPhone(call.fromNumber) : "a private number" });
            await tolerate(deps.provider.askForKey(ev.legId, prompt, SCREEN_TIMEOUT_MS, { state: { callId: call.id, role: "owner" }, commandId: `${call.id}:screen` }));
          }
        } else if (await move(call.id, ["RINGING_OWNER"], { state: "CONNECTING" })) {
          await tolerate(deps.provider.answer(call.callerLegId, { state: { callId: call.id, role: "caller" }, commandId: `${call.id}:answer-bridge` }));
        }
        return;
      }
      // caller leg answered by us
      await db.call.update({ where: { id: call.id }, data: { callerAnswered: true } });
      if (call.state === "CONNECTING" && call.ownerLegId) {
        if (await move(call.id, ["CONNECTING"], { state: "CONNECTED", outcome: "ANSWERED", answeredAt: deps.now() })) {
          await deps.provider.bridge(call.callerLegId, call.ownerLegId, { commandId: `${call.id}:bridge` });
        }
      } else if (call.state === "VOICEMAIL") {
        await tolerate(deps.provider.speak(call.callerLegId, greeting(b), { commandId: `${call.id}:greet` }));
      } else if (call.state === "SELF_TEST") {
        await tolerate(deps.provider.speak(call.callerLegId, fill(VOICE_SELF_TEST, vars(b)), { commandId: `${call.id}:selftest` }));
      }
      return;
    }

    case "call.keypress": {
      if (role !== "owner") return;
      if (ev.outcome === "entered" && ev.digits === "1") {
        if (await move(call.id, ["SCREENING"], { state: "CONNECTING" })) {
          await tolerate(deps.provider.answer(call.callerLegId, { state: { callId: call.id, role: "caller" }, commandId: `${call.id}:answer-bridge` }));
        }
        return;
      }
      // Timeout, wrong key, or hang-up during the prompt: usually the
      // owner's own voicemail answered. Either way, it's a missed call.
      return missed(deps, call.id, ["SCREENING"], "NOT_ACCEPTED");
    }

    case "call.speech_done": {
      if (role !== "caller") return;
      if (call.state === "VOICEMAIL") {
        if (b.voicemailEnabled) {
          await tolerate(deps.provider.record(call.callerLegId, VOICEMAIL_MAX_SECONDS, { commandId: `${call.id}:record` }));
        } else {
          await tolerate(deps.provider.hangup(call.callerLegId, { commandId: `${call.id}:hangup-caller` }));
        }
      } else if (call.state === "SELF_TEST") {
        await tolerate(deps.provider.hangup(call.callerLegId, { commandId: `${call.id}:hangup-caller` }));
      }
      return;
    }

    case "call.ended": {
      const now = deps.now();
      if (role === "owner") {
        // Owner's phone never got to "press 1" (no answer, busy, declined),
        // or hung up during the prompt, or right after pressing 1.
        if (call.state === "RINGING_OWNER") return missed(deps, call.id, ["RINGING_OWNER"], "NO_ANSWER");
        if (call.state === "SCREENING" || call.state === "CONNECTING") return missed(deps, call.id, [call.state], "NOT_ACCEPTED");
        if (await move(call.id, ["CONNECTED"], { state: "ENDED", endedAt: now })) {
          await tolerate(deps.provider.hangup(call.callerLegId, { commandId: `${call.id}:hangup-caller` }));
        }
        return;
      }

      // Caller hung up. If we were still trying to reach the owner, that's a
      // missed call too — people give up after a few rings, and those are
      // exactly the customers who'll call a competitor next.
      if (await move(call.id, ["RINGING_OWNER", "SCREENING", "CONNECTING"], { state: "ENDED", endedAt: now })) {
        if (call.ownerLegId) await tolerate(deps.provider.hangup(call.ownerLegId, { commandId: `${call.id}:hangup-owner` }));
        await onMissedCall(deps, b, call, "CALLER_HUNG_UP");
        return;
      }
      if (await move(call.id, ["CONNECTED"], { state: "ENDED", endedAt: now })) {
        if (call.ownerLegId) await tolerate(deps.provider.hangup(call.ownerLegId, { commandId: `${call.id}:hangup-owner` }));
        return;
      }
      await move(call.id, ["VOICEMAIL", "SELF_TEST"], { state: "ENDED", endedAt: now });
      return;
    }
  }
}

async function incoming(deps: Deps, ev: Extract<ProviderEvent, { type: "call.incoming" }>) {
  const to = toE164(ev.to);
  const b = to ? await db.business.findUnique({ where: { phoneNumber: to } }) : null;
  // Unknown number, or a suspended tenant: the service is off, don't answer.
  if (!b || b.status === "SUSPENDED") {
    await tolerate(deps.provider.hangup(ev.legId));
    return;
  }
  const from = toE164(ev.from) ?? (ev.from || "anonymous");
  const now = deps.now();

  // Anyone on the team calling the business number is testing the line.
  const isOwner = (await teamMemberByPhone(b, from)) !== null;
  const initial: CallState = isOwner ? "SELF_TEST" : b.callMode === "FORWARDED" ? "VOICEMAIL" : "RINGING_OWNER";

  let call: Call;
  try {
    call = await db.call.create({
      data: {
        businessId: b.id, callerLegId: ev.legId, sessionId: ev.sessionId, fromNumber: from, state: initial, startedAt: now,
        ...(isOwner ? { outcome: "ANSWERED" as const } : {}),
      },
    });
  } catch {
    return; // duplicate delivery of the same call — already handled
  }
  const withBiz = { ...call, business: b };

  if (initial === "SELF_TEST") {
    await tolerate(deps.provider.answer(ev.legId, { state: { callId: call.id, role: "caller" }, commandId: `${call.id}:answer-test` }));
    return;
  }

  if (initial === "VOICEMAIL") {
    await onMissedCall(deps, b, call, "FORWARDED");
    await startVoicemail(deps, withBiz);
    return;
  }

  // RING_OWNER: the caller stays unanswered (hearing ringback) while we
  // ring the owner from the business number, so they know it's a customer.
  try {
    const { legId } = await deps.provider.dial({
      to: b.ownerPhone,
      from: b.phoneNumber!,
      timeoutSecs: b.ringSeconds,
      state: { callId: call.id, role: "owner" },
      commandId: `${call.id}:dial`,
    });
    await db.call.update({ where: { id: call.id }, data: { ownerLegId: legId } });
  } catch (err) {
    console.error(`[call] couldn't ring owner for business=${b.id}:`, err instanceof Error ? err.message : err);
    await missed(deps, call.id, ["RINGING_OWNER"], "NO_ANSWER");
  }
}

async function recordingReady(deps: Deps, ev: Extract<ProviderEvent, { type: "call.recording_ready" }>) {
  const call = await db.call.findFirst({
    where: { OR: [...(ev.sessionId ? [{ sessionId: ev.sessionId }] : []), ...(ev.legId ? [{ callerLegId: ev.legId }] : [])] },
    include: { business: true, lead: true, voicemail: { select: { id: true } } },
  });
  if (!call || call.voicemail) return;
  // Download now: provider links expire within minutes.
  const { audio, mimeType } = await deps.provider.downloadRecording(ev.url);
  await db.voicemail.create({ data: { businessId: call.businessId, callId: call.id, audio, mimeType } });
  const who = call.lead ? `#${call.lead.code} ${prettyPhone(call.fromNumber)}` : prettyPhone(call.fromNumber);
  await textTeam(
    deps,
    call.business,
    `🎙 New voicemail from ${who}.${call.lead ? `\n${leadUrl(call.lead)}` : ""}`,
    call.lead ?? undefined,
  );
}
