// Twilio webhooks. No user session here: the business is resolved from the
// number that was called/texted (To), and every request must carry a
// valid X-Twilio-Signature or it's rejected.
//
// Call flow, DIAL mode:
//   /voice/incoming  → ring owner's cell (with "press 1 to accept" screen)
//   /voice/screen    → plays to the OWNER; no keypress = their voicemail picked up
//   /voice/dial-result → answered? done. Otherwise: missed → text-back + voicemail
// CARRIER_FORWARD mode: /voice/incoming is already a missed call.

import { Router, urlencoded, type NextFunction, type Request, type Response } from "express";
import twilio from "twilio";
import type { Business } from "@prisma/client";
import { config } from "../lib/config";
import type { Deps } from "../lib/deps";
import { formatPhone, toE164 } from "../lib/phone";
import { prisma } from "../lib/prisma";
import { handleInboundSms } from "../services/conversation";
import { alertOwner } from "../services/messaging";
import { handleMissedCall } from "../services/missedCall";

const { VoiceResponse, MessagingResponse } = twilio.twiml;

function verifyTwilioSignature(req: Request, res: Response, next: NextFunction) {
  if (!config.twilio.validateSignatures) return next();
  const signature = req.header("x-twilio-signature");
  const url = `${config.publicBaseUrl}${req.originalUrl}`;
  if (!config.twilio.authToken || !signature || !twilio.validateRequest(config.twilio.authToken, signature, url, req.body)) {
    return res.status(403).send("Invalid Twilio signature");
  }
  next();
}

function twiml(res: Response, xml: string) {
  res.type("text/xml").send(xml);
}

async function businessForNumber(to: unknown): Promise<Business | null> {
  const number = typeof to === "string" ? toE164(to) : null;
  return number ? prisma.business.findUnique({ where: { twilioNumber: number } }) : null;
}

function missedCallTwiml(business: Business): string {
  const vr = new VoiceResponse();
  vr.say(
    { voice: "Polly.Joanna" },
    `Thanks for calling ${business.name}. Sorry we couldn't get to the phone — we've just sent you a text message so we can help you right away.`,
  );
  if (business.recordVoicemail) {
    vr.say({ voice: "Polly.Joanna" }, "You can also leave a message after the tone.");
    vr.record({
      maxLength: 120,
      playBeep: true,
      action: "/twilio/voice/voicemail-done",
      recordingStatusCallback: "/twilio/voice/recording",
      recordingStatusCallbackEvent: ["completed"],
    });
  }
  vr.hangup();
  return vr.toString();
}

export function twilioRouter(deps: Deps): Router {
  const r = Router();
  r.use(urlencoded({ extended: false }));
  r.use(verifyTwilioSignature);

  r.post("/voice/incoming", async (req, res) => {
    const business = await businessForNumber(req.body.To);
    if (!business) {
      const vr = new VoiceResponse();
      vr.say("This number is not in service.");
      vr.hangup();
      return twiml(res, vr.toString());
    }
    const from = toE164(String(req.body.From ?? "")) ?? String(req.body.From ?? "unknown");
    const call = await prisma.call.upsert({
      where: { callSid: String(req.body.CallSid) },
      create: { businessId: business.id, callSid: String(req.body.CallSid), fromNumber: from, createdAt: deps.now() },
      update: {},
    });

    if (business.callMode === "CARRIER_FORWARD") {
      await handleMissedCall(deps, business, call);
      return twiml(res, missedCallTwiml(business));
    }

    const vr = new VoiceResponse();
    const dial = vr.dial({
      timeout: business.ringTimeoutSec,
      answerOnBridge: true,
      action: "/twilio/voice/dial-result",
      // Show the real caller on the owner's phone, not the Twilio number.
      callerId: from.startsWith("+") ? from : undefined,
    });
    dial.number(business.screenCalls ? { url: "/twilio/voice/screen" } : {}, business.ownerPhone);
    twiml(res, vr.toString());
  });

  // Plays to the owner when they pick up. If their carrier voicemail
  // answered instead, nobody presses 1 and the call falls through to missed.
  r.post("/voice/screen", async (req, res) => {
    const call = await prisma.call.findUnique({ where: { callSid: String(req.body.ParentCallSid ?? "") } });
    const vr = new VoiceResponse();
    const gather = vr.gather({ numDigits: 1, timeout: 6, action: "/twilio/voice/screen-result" });
    gather.say(`Customer call from ${call ? call.fromNumber.replace(/\D/g, "").slice(-10).split("").join(" ") : "a customer"}. Press 1 to accept.`);
    vr.hangup();
    twiml(res, vr.toString());
  });

  r.post("/voice/screen-result", async (req, res) => {
    const vr = new VoiceResponse();
    if (req.body.Digits === "1" && req.body.ParentCallSid) {
      await prisma.call.updateMany({ where: { callSid: String(req.body.ParentCallSid) }, data: { screenAccepted: true } });
    } else {
      vr.hangup();
    }
    twiml(res, vr.toString());
  });

  r.post("/voice/dial-result", async (req, res) => {
    const call = await prisma.call.findUnique({
      where: { callSid: String(req.body.CallSid) },
      include: { business: true },
    });
    if (!call) return twiml(res, new VoiceResponse().toString());
    const { business } = call;

    const completed = req.body.DialCallStatus === "completed";
    const answered = completed && (!business.screenCalls || call.screenAccepted);
    if (answered) {
      await prisma.call.update({
        where: { id: call.id },
        data: { outcome: "ANSWERED", durationSec: Number(req.body.DialCallDuration) || null },
      });
      const vr = new VoiceResponse();
      vr.hangup();
      return twiml(res, vr.toString());
    }

    await handleMissedCall(deps, business, call);
    twiml(res, missedCallTwiml(business));
  });

  r.post("/voice/voicemail-done", (_req, res) => {
    const vr = new VoiceResponse();
    vr.say("Thanks, we'll be in touch soon. Goodbye.");
    vr.hangup();
    twiml(res, vr.toString());
  });

  r.post("/voice/recording", async (req, res) => {
    if (req.body.RecordingStatus === "completed" && req.body.RecordingUrl) {
      const call = await prisma.call.findUnique({
        where: { callSid: String(req.body.CallSid) },
        include: { business: true },
      });
      if (call && !call.voicemailUrl) {
        await prisma.call.update({ where: { id: call.id }, data: { voicemailUrl: `${req.body.RecordingUrl}.mp3` } });
        const where = call.leadId ? `\n${config.publicBaseUrl}/#/leads/${call.leadId}` : "";
        await alertOwner(deps, call.business, `🎙 New voicemail from ${formatPhone(call.fromNumber)}.${where}`);
      }
    }
    res.sendStatus(204);
  });

  r.post("/sms/incoming", async (req, res) => {
    const business = await businessForNumber(req.body.To);
    const from = toE164(String(req.body.From ?? ""));
    if (business && from) {
      await handleInboundSms(deps, business, {
        from,
        body: String(req.body.Body ?? ""),
        sid: String(req.body.MessageSid ?? req.body.SmsSid),
      });
    }
    // Replies go out via the REST API so they're logged like everything else.
    twiml(res, new MessagingResponse().toString());
  });

  r.post("/sms/status", async (req, res) => {
    const sid = String(req.body.MessageSid ?? "");
    const status = String(req.body.MessageStatus ?? "");
    if (sid && status) {
      await prisma.message.updateMany({
        where: { twilioSid: sid },
        data: { status, ...(req.body.ErrorCode ? { error: `Twilio error ${req.body.ErrorCode}` } : {}) },
      });
    }
    res.sendStatus(204);
  });

  return r;
}
