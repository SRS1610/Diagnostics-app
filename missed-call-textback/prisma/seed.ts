// Demo data: one plumbing business with three weeks of calls, leads and
// conversations, so the dashboard can be explored without Twilio.
//   npm run db:seed   →  sign in as demo@example.com / demo-password
// Uses fictional 512-555 numbers — no real people.

import bcrypt from "bcryptjs";
import { PrismaClient, type LeadStatus } from "@prisma/client";
import { DEFAULT_AFTER_HOURS, DEFAULT_TEXT_BACK, QUALIFY_ASK_ADDRESS, QUALIFY_ASK_URGENT, QUALIFY_DONE, render } from "../src/lib/templates";
import { DEFAULT_BUSINESS_HOURS, isWithinBusinessHours } from "../src/lib/time";

const prisma = new PrismaClient();
const TZ = "America/Chicago";

let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

const JOBS = [
  ["Water heater leaking from the bottom", false, 1450],
  ["Kitchen sink is clogged and backing up", false, 225],
  ["Pipe burst under the house, water everywhere", true, 1800],
  ["Toilet keeps running", false, 180],
  ["Need a quote to replace a garbage disposal", false, 420],
  ["No hot water since this morning", true, 650],
  ["Sewer smell in the basement", false, 380],
  ["Main line backed up, flooding the floor drain", true, 950],
  ["Low water pressure in the shower", false, 260],
  ["Install a new outdoor spigot", false, 310],
] as const;
const STREETS = ["Elm St", "Oak Ave", "Burnet Rd", "Lamar Blvd", "Congress Ave", "Riverside Dr", "Manor Rd"];
const NAMES = ["Maria", "James", "Priya", "Tom", "Keisha", "Luis", "Ann", "Wei", null, null, null];

async function main() {
  await prisma.business.deleteMany({ where: { ownerEmail: "demo@example.com" } });
  const business = await prisma.business.create({
    data: {
      name: "Lone Star Plumbing",
      ownerName: "Mike",
      ownerEmail: "demo@example.com",
      passwordHash: await bcrypt.hash("demo-password", 10),
      ownerPhone: "+15125550100",
      twilioNumber: "+15125550199",
      timezone: TZ,
      businessHours: DEFAULT_BUSINESS_HOURS,
      textBackMessage: DEFAULT_TEXT_BACK,
      afterHoursMessage: DEFAULT_AFTER_HOURS,
      avgJobValueCents: 52000,
    },
  });
  const vars = { business: business.name, owner: business.ownerName, number: "(512) 555-0199" };

  const now = Date.now();
  let callerSeq = 0;
  for (let day = 20; day >= 0; day--) {
    const callsToday = 4 + Math.floor(rand() * 6);
    for (let i = 0; i < callsToday; i++) {
      // Mostly 7am–7pm Central (UTC-5 in CDT), with a tail into the evening.
      const d = new Date(now - day * 864e5);
      const localHour = rand() < 0.85 ? 7 + Math.floor(rand() * 12) : 19 + Math.floor(rand() * 3);
      const at = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), localHour + 5, Math.floor(rand() * 60)));
      if (at.getTime() > now) continue;
      const afterHours = !isWithinBusinessHours(at, TZ, DEFAULT_BUSINESS_HOURS);
      const answered = !afterHours && rand() < 0.7;
      const phone = `+1512555${1000 + ++callerSeq}`;
      const call = await prisma.call.create({
        data: { businessId: business.id, callSid: `CAseed${callerSeq}`, fromNumber: phone, outcome: answered ? "ANSWERED" : "MISSED", afterHours, durationSec: answered ? 60 + Math.floor(rand() * 300) : null, createdAt: at },
      });
      if (answered) continue;

      const [job, urgent, value] = pick([...JOBS]);
      const replied = rand() < 0.68;
      const t = (min: number) => new Date(Math.min(now - 1000, at.getTime() + min * 60000));
      let status: LeadStatus = "NEW";
      if (replied) {
        const r = rand();
        status = day < 1 ? "QUALIFIED" : r < 0.45 ? "WON" : r < 0.65 ? "BOOKED" : r < 0.8 ? "QUALIFIED" : "LOST";
      }
      const lead = await prisma.lead.create({
        data: {
          businessId: business.id,
          phone,
          name: replied ? pick(NAMES) : null,
          jobDescription: replied ? job : null,
          address: replied ? `${100 + Math.floor(rand() * 9000)} ${pick(STREETS)}, Austin TX` : null,
          urgent: replied && urgent,
          status,
          qualifyStep: replied ? 0 : 1,
          jobValueCents: status === "WON" ? Math.round(value * (0.8 + rand() * 0.5)) * 100 : null,
          wonAt: status === "WON" ? t(60 * 24 * Math.min(day, 2)) : null,
          appointmentAt: status === "BOOKED" ? new Date(now + (1 + Math.floor(rand() * 4)) * 864e5) : null,
          lastInboundAt: replied ? t(6) : null,
          lastOutboundAt: t(0),
          createdAt: at,
        },
      });
      await prisma.call.update({ where: { id: call.id }, data: { leadId: lead.id } });
      const msgs: { dir: "INBOUND" | "OUTBOUND"; kind: string; body: string; min: number }[] = [
        { dir: "OUTBOUND", kind: "TEXT_BACK", body: render(afterHours ? DEFAULT_AFTER_HOURS : DEFAULT_TEXT_BACK, vars), min: 0 },
      ];
      if (replied) {
        msgs.push(
          { dir: "INBOUND", kind: "INBOUND", body: job, min: 3 },
          { dir: "OUTBOUND", kind: "QUALIFY", body: QUALIFY_ASK_ADDRESS, min: 3 },
          { dir: "INBOUND", kind: "INBOUND", body: lead.address!, min: 5 },
          { dir: "OUTBOUND", kind: "QUALIFY", body: QUALIFY_ASK_URGENT, min: 5 },
          { dir: "INBOUND", kind: "INBOUND", body: urgent ? "YES" : "No", min: 6 },
          { dir: "OUTBOUND", kind: "QUALIFY", body: render(QUALIFY_DONE, vars), min: 6 },
        );
        if (status !== "QUALIFIED") msgs.push({ dir: "OUTBOUND", kind: "MANUAL", body: "Hi, Mike here — I can swing by tomorrow morning, does 9am work?", min: 40 });
      }
      for (const m of msgs) {
        await prisma.message.create({
          data: { businessId: business.id, leadId: lead.id, direction: m.dir, kind: m.kind as never, body: m.body, status: m.dir === "INBOUND" ? "received" : "delivered", createdAt: t(m.min) },
        });
      }
    }
  }
  const counts = await Promise.all([prisma.call.count(), prisma.lead.count(), prisma.message.count()]);
  console.log(`Seeded Lone Star Plumbing: ${counts[0]} calls, ${counts[1]} leads, ${counts[2]} messages.`);
  console.log("Sign in: demo@example.com / demo-password");
}

main().finally(() => prisma.$disconnect());
