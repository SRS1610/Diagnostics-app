// Owner-facing API for the dashboard. Every query is scoped by the
// businessId from the signed-in token (businessIdOf(res)) — a lead id from
// another business 404s, it never leaks.

import { Router, json, type Request } from "express";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { Prisma, type Business } from "@prisma/client";
import { businessIdOf, requireAuth, signToken } from "../lib/auth";
import { config } from "../lib/config";
import type { Deps } from "../lib/deps";
import { toE164 } from "../lib/phone";
import { prisma } from "../lib/prisma";
import { DEFAULT_AFTER_HOURS, DEFAULT_TEXT_BACK } from "../lib/templates";
import { DEFAULT_BUSINESS_HOURS, WEEKDAYS, isValidTimeZone } from "../lib/time";
import { NoNumberError, OptedOutError, sendToLead } from "../services/messaging";
import { cancelJobs, scheduleAppointmentReminders } from "../services/scheduler";
import { dashboardStats } from "../services/stats";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const phone = z.string().transform((v, ctx) => {
  const e164 = toE164(v);
  if (!e164) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a valid phone number" });
    return z.NEVER;
  }
  return e164;
});
const timezone = z.string().refine(isValidTimeZone, "Unknown timezone");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const businessHours = z.object(
  Object.fromEntries(WEEKDAYS.map((d) => [d, z.object({ open: hhmm, close: hhmm }).nullable().optional()])),
);

function publicBusiness(b: Business) {
  const { passwordHash: _omit, ...rest } = b;
  return rest;
}

async function currentBusiness(req: Request, businessId: string): Promise<Business> {
  const b = await prisma.business.findUnique({ where: { id: businessId } });
  if (!b) throw new HttpError(401, "Account not found");
  return b;
}

async function ownedLead(businessId: string, id: string) {
  const lead = await prisma.lead.findFirst({ where: { id, businessId } });
  if (!lead) throw new HttpError(404, "Lead not found");
  return lead;
}

export function apiRouter(deps: Deps): Router {
  const r = Router();
  r.use(json({ limit: "100kb" }));

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

  r.post("/auth/signup", authLimiter, async (req, res) => {
    const body = z
      .object({
        businessName: z.string().trim().min(2).max(80),
        ownerName: z.string().trim().min(1).max(60),
        email: z.string().trim().toLowerCase().email(),
        password: z.string().min(8).max(200),
        ownerPhone: phone,
        timezone: timezone.default("America/New_York"),
      })
      .parse(req.body);
    const exists = await prisma.business.findUnique({ where: { ownerEmail: body.email } });
    if (exists) throw new HttpError(409, "An account with that email already exists");
    const business = await prisma.business.create({
      data: {
        name: body.businessName,
        ownerName: body.ownerName,
        ownerEmail: body.email,
        passwordHash: await bcrypt.hash(body.password, 10),
        ownerPhone: body.ownerPhone,
        timezone: body.timezone,
        businessHours: DEFAULT_BUSINESS_HOURS,
        textBackMessage: DEFAULT_TEXT_BACK,
        afterHoursMessage: DEFAULT_AFTER_HOURS,
      },
    });
    res.status(201).json({ token: signToken(business.id), business: publicBusiness(business) });
  });

  r.post("/auth/login", authLimiter, async (req, res) => {
    const body = z.object({ email: z.string().trim().toLowerCase(), password: z.string() }).parse(req.body);
    const business = await prisma.business.findUnique({ where: { ownerEmail: body.email } });
    if (!business || !(await bcrypt.compare(body.password, business.passwordHash))) {
      throw new HttpError(401, "Wrong email or password");
    }
    res.json({ token: signToken(business.id), business: publicBusiness(business) });
  });

  r.use(requireAuth);

  r.get("/me", async (req, res) => {
    const business = await currentBusiness(req, businessIdOf(res));
    res.json({
      business: publicBusiness(business),
      setup: {
        hasNumber: Boolean(business.twilioNumber),
        twilioConfigured: Boolean(config.twilio.accountSid && config.twilio.authToken),
        a2pMessagingService: Boolean(config.twilio.messagingServiceSid),
        webhookUrls: {
          voice: `${config.publicBaseUrl}/twilio/voice/incoming`,
          sms: `${config.publicBaseUrl}/twilio/sms/incoming`,
        },
      },
    });
  });

  r.patch("/settings", async (req, res) => {
    const body = z
      .object({
        name: z.string().trim().min(2).max(80),
        ownerName: z.string().trim().min(1).max(60),
        ownerPhone: phone,
        twilioNumber: phone.nullable(),
        timezone,
        callMode: z.enum(["DIAL", "CARRIER_FORWARD"]),
        ringTimeoutSec: z.number().int().min(10).max(45),
        screenCalls: z.boolean(),
        recordVoicemail: z.boolean(),
        businessHours,
        textBackMessage: z.string().trim().min(10).max(480),
        afterHoursMessage: z.string().trim().min(10).max(480),
        qualifyEnabled: z.boolean(),
        followUpEnabled: z.boolean(),
        followUpDelayMin: z.number().int().min(15).max(24 * 60),
        dedupeWindowMin: z.number().int().min(0).max(24 * 60),
        avgJobValue: z.number().min(0).max(1_000_000),
        weeklyDigestEnabled: z.boolean(),
      })
      .partial()
      .strict()
      .parse(req.body);
    const { avgJobValue, ...rest } = body;
    try {
      const business = await prisma.business.update({
        where: { id: businessIdOf(res) },
        data: { ...rest, ...(avgJobValue !== undefined ? { avgJobValueCents: Math.round(avgJobValue * 100) } : {}) },
      });
      res.json({ business: publicBusiness(business) });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new HttpError(409, "That Twilio number is already connected to another account");
      }
      throw err;
    }
  });

  r.get("/numbers/search", async (req, res) => {
    const areaCode = z.string().regex(/^\d{3}$/, "Area code must be 3 digits").parse(req.query.areaCode);
    res.json({ numbers: await deps.telephony.searchNumbers(areaCode) });
  });

  r.post("/numbers/purchase", async (req, res) => {
    const { phoneNumber } = z.object({ phoneNumber: phone }).parse(req.body);
    const business = await currentBusiness(req, businessIdOf(res));
    if (business.twilioNumber) throw new HttpError(409, "This account already has a number");
    const bought = await deps.telephony.purchaseNumber(phoneNumber);
    const updated = await prisma.business.update({
      where: { id: business.id },
      data: { twilioNumber: toE164(bought.phoneNumber) },
    });
    res.status(201).json({ business: publicBusiness(updated) });
  });

  r.get("/dashboard", async (req, res) => {
    const days = z.coerce.number().int().min(1).max(90).default(7).parse(req.query.days);
    const business = await currentBusiness(req, businessIdOf(res));
    const stats = await dashboardStats(business, deps.now(), days);
    const urgentOpen = await prisma.lead.findMany({
      where: { businessId: business.id, urgent: true, status: { in: ["NEW", "CONTACTED", "QUALIFIED"] } },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    res.json({ ...stats, urgentOpen, avgJobValueCents: business.avgJobValueCents });
  });

  r.get("/leads", async (req, res) => {
    const q = z
      .object({
        status: z.enum(["NEW", "CONTACTED", "QUALIFIED", "BOOKED", "WON", "LOST", "OPEN"]).optional(),
        search: z.string().trim().max(80).optional(),
      })
      .parse(req.query);
    const businessId = businessIdOf(res);
    const where: Prisma.LeadWhereInput = { businessId };
    if (q.status === "OPEN") where.status = { in: ["NEW", "CONTACTED", "QUALIFIED", "BOOKED"] };
    else if (q.status) where.status = q.status;
    if (q.search) {
      const digits = q.search.replace(/\D/g, "");
      where.OR = [
        { name: { contains: q.search, mode: "insensitive" } },
        { jobDescription: { contains: q.search, mode: "insensitive" } },
        { address: { contains: q.search, mode: "insensitive" } },
        ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
      ];
    }
    const leads = await prisma.lead.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: 200,
      include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    const optOuts = new Set(
      (await prisma.optOut.findMany({ where: { businessId, phone: { in: leads.map((l) => l.phone) } } })).map((o) => o.phone),
    );
    res.json({
      leads: leads.map(({ messages, ...l }) => ({ ...l, optedOut: optOuts.has(l.phone), lastMessage: messages[0] ?? null })),
    });
  });

  r.get("/leads/:id", async (req, res) => {
    const businessId = businessIdOf(res);
    const lead = await ownedLead(businessId, req.params.id);
    const [messages, calls, optOut, jobs, history] = await Promise.all([
      prisma.message.findMany({ where: { leadId: lead.id }, orderBy: { createdAt: "asc" } }),
      prisma.call.findMany({ where: { leadId: lead.id }, orderBy: { createdAt: "asc" } }),
      prisma.optOut.findUnique({ where: { businessId_phone: { businessId, phone: lead.phone } } }),
      prisma.scheduledJob.findMany({ where: { leadId: lead.id, status: "PENDING" }, orderBy: { runAt: "asc" } }),
      prisma.lead.count({ where: { businessId, phone: lead.phone, id: { not: lead.id } } }),
    ]);
    res.json({
      lead: { ...lead, optedOut: Boolean(optOut) },
      messages,
      calls: calls.map(({ voicemailUrl, ...c }) => ({ ...c, hasVoicemail: Boolean(voicemailUrl) })),
      scheduled: jobs.map((j) => ({ id: j.id, type: j.type, runAt: j.runAt })),
      previousLeads: history,
    });
  });

  r.patch("/leads/:id", async (req, res) => {
    const businessId = businessIdOf(res);
    const lead = await ownedLead(businessId, req.params.id);
    const body = z
      .object({
        status: z.enum(["NEW", "CONTACTED", "QUALIFIED", "BOOKED", "WON", "LOST"]),
        name: z.string().trim().max(80).nullable(),
        jobDescription: z.string().trim().max(1000).nullable(),
        address: z.string().trim().max(300).nullable(),
        notes: z.string().trim().max(4000).nullable(),
        urgent: z.boolean(),
        jobValue: z.number().min(0).max(10_000_000).nullable(),
      })
      .partial()
      .strict()
      .parse(req.body);
    const { jobValue, ...rest } = body;
    const data: Prisma.LeadUpdateInput = { ...rest };
    if (jobValue !== undefined) data.jobValueCents = jobValue === null ? null : Math.round(jobValue * 100);
    if (body.status === "WON" && !lead.wonAt) data.wonAt = deps.now();
    if (body.status && body.status !== "WON") data.wonAt = null;
    // A human has taken over: stop the bot asking questions and nudging.
    if (body.status && body.status !== "NEW") {
      data.qualifyStep = 0;
      await cancelJobs(lead.id, ["FOLLOW_UP"]);
    }
    if (body.status === "WON" || body.status === "LOST") await cancelJobs(lead.id, ["APPOINTMENT_REMINDER"]);
    const updated = await prisma.lead.update({ where: { id: lead.id }, data });
    res.json({ lead: updated });
  });

  r.post("/leads/:id/messages", async (req, res) => {
    const businessId = businessIdOf(res);
    const lead = await ownedLead(businessId, req.params.id);
    const { body } = z.object({ body: z.string().trim().min(1).max(1200) }).parse(req.body);
    const business = await currentBusiness(req, businessId);
    await cancelJobs(lead.id, ["FOLLOW_UP"]);
    await prisma.lead.update({
      where: { id: lead.id },
      data: { qualifyStep: 0, ...(lead.status === "NEW" ? { status: "CONTACTED" } : {}) },
    });
    try {
      const message = await sendToLead(deps, business, lead, body, "MANUAL", {}, { verbatim: true });
      res.status(201).json({ message });
    } catch (err) {
      if (err instanceof OptedOutError) throw new HttpError(409, err.message);
      if (err instanceof NoNumberError) throw new HttpError(409, err.message);
      throw new HttpError(502, `Text failed to send: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  });

  r.put("/leads/:id/appointment", async (req, res) => {
    const businessId = businessIdOf(res);
    const lead = await ownedLead(businessId, req.params.id);
    const { at } = z.object({ at: z.coerce.date() }).parse(req.body);
    if (at.getTime() <= deps.now().getTime()) throw new HttpError(400, "Appointment must be in the future");
    const business = await currentBusiness(req, businessId);
    await cancelJobs(lead.id, ["FOLLOW_UP"]);
    const updated = await prisma.lead.update({
      where: { id: lead.id },
      data: { appointmentAt: at, status: "BOOKED", qualifyStep: 0 },
    });
    await scheduleAppointmentReminders(deps, business, updated, at);
    res.json({ lead: updated });
  });

  r.delete("/leads/:id/appointment", async (req, res) => {
    const lead = await ownedLead(businessIdOf(res), req.params.id);
    await cancelJobs(lead.id, ["APPOINTMENT_REMINDER"]);
    const updated = await prisma.lead.update({
      where: { id: lead.id },
      data: { appointmentAt: null, ...(lead.status === "BOOKED" ? { status: "QUALIFIED" } : {}) },
    });
    res.json({ lead: updated });
  });

  // Twilio recordings need account auth to fetch, so the dashboard plays
  // them through this proxy instead of exposing credentials or making
  // recordings public.
  r.get("/calls/:id/voicemail", async (req, res) => {
    const call = await prisma.call.findFirst({ where: { id: req.params.id, businessId: businessIdOf(res) } });
    if (!call?.voicemailUrl) throw new HttpError(404, "No voicemail");
    const { accountSid, authToken } = config.twilio;
    if (!call.voicemailUrl.startsWith("https://api.twilio.com/")) throw new HttpError(400, "Unexpected recording URL");
    const upstream = await fetch(call.voicemailUrl, {
      headers: { authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}` },
    });
    if (!upstream.ok) throw new HttpError(502, "Couldn't fetch recording from Twilio");
    res.type("audio/mpeg").send(Buffer.from(await upstream.arrayBuffer()));
  });

  return r;
}
