// Owner API for the dashboard. Every lookup is scoped by tenant(res) — a
// lead/call id belonging to another business is simply "not found".

import { Router, json } from "express";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { Prisma, type Business } from "@prisma/client";
import { issueToken, requireOwner, tenant } from "../lib/auth";
import { config } from "../lib/config";
import { db } from "../lib/db";
import { toE164 } from "../lib/phone";
import { DEFAULT_AFTER_HOURS_TEXT, DEFAULT_MISSED_TEXT } from "../lib/text";
import { DAYS, DEFAULT_HOURS, validTimeZone } from "../lib/time";
import type { Deps } from "../core/deps";
import { cancelJobs, scheduleReminders } from "../core/jobs";
import { NoNumberError, OptedOutError, textLead } from "../core/outbox";
import { compare } from "../core/stats";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const phone = z.string().transform((v, ctx) => toE164(v) ?? (ctx.addIssue({ code: "custom", message: "Enter a valid phone number" }), z.NEVER));
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
const hours = z.object(Object.fromEntries(DAYS.map((d) => [d, z.object({ open: hhmm, close: hhmm }).nullable().optional()])));
const STAGES = ["NEW", "ENGAGED", "QUALIFIED", "SCHEDULED", "WON", "LOST"] as const;
const OPEN_STAGES = ["NEW", "ENGAGED", "QUALIFIED", "SCHEDULED"] as const;

function safe(b: Business) {
  const { passwordHash: _p, ...rest } = b;
  return rest;
}

async function me(res: { locals: Record<string, unknown> }): Promise<Business> {
  const b = await db.business.findUnique({ where: { id: res.locals.businessId as string } });
  if (!b) throw new HttpError(401, "Account not found");
  return b;
}

async function myLead(businessId: string, id: string) {
  const lead = await db.lead.findFirst({ where: { id, businessId } });
  if (!lead) throw new HttpError(404, "Lead not found");
  return lead;
}

export function apiRoutes(deps: Deps): Router {
  const r = Router();
  r.use(json({ limit: "100kb" }));
  const authLimit = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

  r.post("/auth/signup", authLimit, async (req, res) => {
    const body = z
      .object({
        businessName: z.string().trim().min(2).max(80),
        ownerName: z.string().trim().min(1).max(60),
        email: z.string().trim().toLowerCase().email(),
        password: z.string().min(8).max(200),
        ownerPhone: phone,
        timezone: z.string().refine(validTimeZone, "Unknown timezone").default("America/New_York"),
      })
      .parse(req.body);
    if (await db.business.findUnique({ where: { email: body.email } })) throw new HttpError(409, "That email already has an account");
    const b = await db.business.create({
      data: {
        name: body.businessName, ownerName: body.ownerName, email: body.email, passwordHash: await bcrypt.hash(body.password, 10),
        ownerPhone: body.ownerPhone, timezone: body.timezone, hours: DEFAULT_HOURS, missedText: DEFAULT_MISSED_TEXT, afterHoursText: DEFAULT_AFTER_HOURS_TEXT,
      },
    });
    res.status(201).json({ token: issueToken(b.id), business: safe(b) });
  });

  r.post("/auth/login", authLimit, async (req, res) => {
    const { email, password } = z.object({ email: z.string().trim().toLowerCase(), password: z.string() }).parse(req.body);
    const b = await db.business.findUnique({ where: { email } });
    if (!b || !(await bcrypt.compare(password, b.passwordHash))) throw new HttpError(401, "Wrong email or password");
    res.json({ token: issueToken(b.id), business: safe(b) });
  });

  r.use(requireOwner);

  r.get("/me", async (_req, res) => {
    const b = await me(res);
    const [selfTest, customerCall] = await Promise.all([
      db.call.findFirst({ where: { businessId: b.id, state: { in: ["SELF_TEST", "ENDED"] }, fromNumber: b.ownerPhone }, select: { id: true } }),
      db.call.findFirst({ where: { businessId: b.id, fromNumber: { not: b.ownerPhone } }, select: { id: true } }),
    ]);
    res.json({
      business: safe(b),
      setup: { hasNumber: Boolean(b.phoneNumber), selfTested: Boolean(selfTest), firstCustomerCall: Boolean(customerCall) },
      provider: { name: deps.provider.name, live: deps.provider.name !== "fake", webhookUrl: `${config.publicUrl}/webhooks/${deps.provider.name}` },
    });
  });

  r.patch("/settings", async (req, res) => {
    const body = z
      .object({
        name: z.string().trim().min(2).max(80),
        ownerName: z.string().trim().min(1).max(60),
        ownerPhone: phone,
        phoneNumber: phone.nullable(),
        timezone: z.string().refine(validTimeZone, "Unknown timezone"),
        callMode: z.enum(["RING_OWNER", "FORWARDED"]),
        ringSeconds: z.number().int().min(10).max(45),
        screenCalls: z.boolean(),
        voicemailEnabled: z.boolean(),
        hours,
        missedText: z.string().trim().min(10).max(480),
        afterHoursText: z.string().trim().min(10).max(480),
        intakeEnabled: z.boolean(),
        nudgeEnabled: z.boolean(),
        nudgeAfterMin: z.number().int().min(15).max(1440),
        dedupeMin: z.number().int().min(0).max(1440),
        avgJob: z.number().min(0).max(1_000_000),
        digestEnabled: z.boolean(),
      })
      .partial()
      .strict()
      .parse(req.body);
    const { avgJob, ...rest } = body;
    try {
      const b = await db.business.update({
        where: { id: tenant(res) },
        data: { ...rest, ...(avgJob !== undefined ? { avgJobCents: Math.round(avgJob * 100) } : {}) },
      });
      res.json({ business: safe(b) });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new HttpError(409, "That number is already connected to another account");
      throw err;
    }
  });

  r.get("/numbers/search", async (req, res) => {
    const areaCode = z.string().regex(/^\d{3}$/, "Area code must be 3 digits").parse(req.query.areaCode);
    res.json({ numbers: await deps.provider.searchNumbers(areaCode) });
  });

  r.post("/numbers/buy", async (req, res) => {
    const { phoneNumber } = z.object({ phoneNumber: phone }).parse(req.body);
    const b = await me(res);
    if (b.phoneNumber) throw new HttpError(409, "This account already has a number");
    if (await db.business.findUnique({ where: { phoneNumber } })) throw new HttpError(409, "That number is taken");
    await deps.provider.buyNumber(phoneNumber);
    const updated = await db.business.update({ where: { id: b.id }, data: { phoneNumber } });
    res.status(201).json({ business: safe(updated) });
  });

  r.get("/dashboard", async (req, res) => {
    const days = z.coerce.number().int().min(1).max(90).default(7).parse(req.query.days);
    const b = await me(res);
    const [stats, urgent] = await Promise.all([
      compare(b, deps.now(), days),
      db.lead.findMany({ where: { businessId: b.id, urgent: true, stage: { in: ["NEW", "ENGAGED", "QUALIFIED"] } }, orderBy: { createdAt: "desc" }, take: 5 }),
    ]);
    res.json({ ...stats, urgent, avgJobCents: b.avgJobCents });
  });

  r.get("/leads", async (req, res) => {
    const q = z.object({ stage: z.enum([...STAGES, "OPEN", "ALL"]).default("OPEN"), q: z.string().trim().max(80).optional() }).parse(req.query);
    const businessId = tenant(res);
    const where: Prisma.LeadWhereInput = { businessId };
    if (q.stage === "OPEN") where.stage = { in: [...OPEN_STAGES] };
    else if (q.stage !== "ALL") where.stage = q.stage;
    if (q.q) {
      const digits = q.q.replace(/\D/g, "");
      const code = /^#?(\d{1,6})$/.exec(q.q);
      where.OR = [
        { name: { contains: q.q, mode: "insensitive" } },
        { job: { contains: q.q, mode: "insensitive" } },
        { address: { contains: q.q, mode: "insensitive" } },
        ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
        ...(code ? [{ code: Number(code[1]) }] : []),
      ];
    }
    const leads = await db.lead.findMany({ where, orderBy: { updatedAt: "desc" }, take: 200, include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } } });
    const out = new Set((await db.optOut.findMany({ where: { businessId, phone: { in: leads.map((l) => l.phone) } } })).map((o) => o.phone));
    res.json({ leads: leads.map(({ messages, ...l }) => ({ ...l, optedOut: out.has(l.phone), last: messages[0] ?? null })) });
  });

  r.get("/leads/:id", async (req, res) => {
    const businessId = tenant(res);
    const lead = await myLead(businessId, req.params.id);
    const [messages, calls, opt, jobs, earlier] = await Promise.all([
      db.message.findMany({ where: { leadId: lead.id }, orderBy: { createdAt: "asc" } }),
      db.call.findMany({ where: { leadId: lead.id }, orderBy: { startedAt: "asc" }, include: { voicemail: { select: { id: true } } } }),
      db.optOut.findUnique({ where: { businessId_phone: { businessId, phone: lead.phone } } }),
      db.job.findMany({ where: { leadId: lead.id, status: "PENDING" }, orderBy: { runAt: "asc" } }),
      db.lead.count({ where: { businessId, phone: lead.phone, id: { not: lead.id } } }),
    ]);
    res.json({
      lead: { ...lead, optedOut: Boolean(opt) },
      messages,
      calls: calls.map(({ voicemail, callerLegId: _a, ownerLegId: _b, sessionId: _c, ...c }) => ({ ...c, hasVoicemail: Boolean(voicemail) })),
      scheduled: jobs.map((j) => ({ type: j.type, runAt: j.runAt })),
      earlierLeads: earlier,
    });
  });

  r.patch("/leads/:id", async (req, res) => {
    const lead = await myLead(tenant(res), req.params.id);
    const body = z
      .object({
        stage: z.enum(STAGES),
        name: z.string().trim().max(80).nullable(),
        job: z.string().trim().max(1000).nullable(),
        address: z.string().trim().max(300).nullable(),
        notes: z.string().trim().max(4000).nullable(),
        urgent: z.boolean(),
        value: z.number().min(0).max(10_000_000).nullable(),
      })
      .partial()
      .strict()
      .parse(req.body);
    const { value, ...rest } = body;
    const data: Prisma.LeadUpdateInput = { ...rest };
    if (value !== undefined) data.valueCents = value === null ? null : Math.round(value * 100);
    if (body.stage === "WON" && !lead.wonAt) data.wonAt = deps.now();
    if (body.stage && body.stage !== "WON") data.wonAt = null;
    if (body.stage && body.stage !== "NEW") {
      data.intakeStep = 0;
      await cancelJobs(lead.id, ["NUDGE"]);
    }
    if (body.stage === "WON" || body.stage === "LOST") await cancelJobs(lead.id, ["REMINDER"]);
    res.json({ lead: await db.lead.update({ where: { id: lead.id }, data }) });
  });

  r.post("/leads/:id/messages", async (req, res) => {
    const lead = await myLead(tenant(res), req.params.id);
    const { body } = z.object({ body: z.string().trim().min(1).max(1200) }).parse(req.body);
    const b = await me(res);
    await cancelJobs(lead.id, ["NUDGE"]);
    await db.lead.update({ where: { id: lead.id }, data: { intakeStep: 0, ...(lead.stage === "NEW" ? { stage: "ENGAGED" as const } : {}) } });
    try {
      res.status(201).json({ message: await textLead(deps, b, lead, body, "OWNER", { template: false }) });
    } catch (err) {
      if (err instanceof OptedOutError || err instanceof NoNumberError) throw new HttpError(409, err.message);
      throw new HttpError(502, `The text didn't send: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  });

  r.put("/leads/:id/appointment", async (req, res) => {
    const lead = await myLead(tenant(res), req.params.id);
    const { at } = z.object({ at: z.coerce.date() }).parse(req.body);
    if (at <= deps.now()) throw new HttpError(400, "Pick a time in the future");
    const b = await me(res);
    await cancelJobs(lead.id, ["NUDGE"]);
    const updated = await db.lead.update({ where: { id: lead.id }, data: { appointmentAt: at, stage: "SCHEDULED", intakeStep: 0 } });
    await scheduleReminders(deps, b, updated, at);
    res.json({ lead: updated });
  });

  r.delete("/leads/:id/appointment", async (req, res) => {
    const lead = await myLead(tenant(res), req.params.id);
    await cancelJobs(lead.id, ["REMINDER"]);
    res.json({
      lead: await db.lead.update({ where: { id: lead.id }, data: { appointmentAt: null, ...(lead.stage === "SCHEDULED" ? { stage: "QUALIFIED" as const } : {}) } }),
    });
  });

  r.get("/calls/:id/voicemail", async (req, res) => {
    const vm = await db.voicemail.findFirst({ where: { callId: req.params.id, businessId: tenant(res) } });
    if (!vm) throw new HttpError(404, "No voicemail");
    res.type(vm.mimeType).set("cache-control", "private, max-age=3600").send(Buffer.from(vm.audio));
  });

  return r;
}
