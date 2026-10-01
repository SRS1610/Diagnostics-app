// Demo data — three weeks of a plumbing business, so the dashboard and
// inbox can be explored without a phone provider.
//   npm run db:seed  →  demo@tradecall.test / demo-password
// All phone numbers are fictional 512-555 numbers.

import bcrypt from "bcryptjs";
import { PrismaClient, type LeadStage, type MissReason } from "@prisma/client";
import { ASK_ADDRESS, ASK_EMERGENCY, DEFAULT_AFTER_HOURS_TEXT, DEFAULT_MISSED_TEXT, INTAKE_DONE, INTAKE_DONE_URGENT, fill } from "../src/lib/text";
import { DEFAULT_HOURS, isOpen } from "../src/lib/time";

const db = new PrismaClient();
const TZ = "America/Chicago";
let s = 7;
const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];

const JOBS = [
  ["Water heater leaking from the bottom", false, 1450], ["Kitchen sink clogged and backing up", false, 240],
  ["Pipe burst under the house, water everywhere", true, 1900], ["Toilet keeps running", false, 180],
  ["Quote to replace garbage disposal", false, 420], ["No hot water since this morning", true, 680],
  ["Sewer smell in the basement", false, 390], ["Main line backed up, floor drain flooding", true, 980],
  ["Low water pressure upstairs", false, 260], ["Install an outdoor spigot", false, 320],
] as const;
const STREETS = ["Elm St", "Oak Ave", "Burnet Rd", "Lamar Blvd", "Manor Rd", "Riverside Dr"];
const NAMES = ["Maria", "James", "Priya", "Tom", "Keisha", "Luis", "Ann", null, null, null];

async function main() {
  await db.business.deleteMany({ where: { email: "demo@tradecall.test" } });
  const b = await db.business.create({
    data: {
      name: "Lone Star Plumbing", ownerName: "Mike", email: "demo@tradecall.test", passwordHash: await bcrypt.hash("demo-password", 10),
      ownerPhone: "+15125550100", phoneNumber: "+15125550199", timezone: TZ, hours: DEFAULT_HOURS,
      missedText: DEFAULT_MISSED_TEXT, afterHoursText: DEFAULT_AFTER_HOURS_TEXT, avgJobCents: 52000,
    },
  });
  const v = { business: b.name, owner: b.ownerName, number: "(512) 555-0199" };
  const now = Date.now();
  let caller = 0, code = 0;

  for (let day = 20; day >= 0; day--) {
    const calls = 4 + Math.floor(rnd() * 6);
    for (let i = 0; i < calls; i++) {
      const d = new Date(now - day * 864e5);
      const hour = rnd() < 0.85 ? 7 + Math.floor(rnd() * 12) : 19 + Math.floor(rnd() * 3);
      const at = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour + 5, Math.floor(rnd() * 60)));
      if (at.getTime() > now) continue;
      const open = isOpen(at, TZ, DEFAULT_HOURS);
      const answered = open && rnd() < 0.66;
      const from = `+1512555${1000 + ++caller}`;
      const reason: MissReason = pick(["NO_ANSWER", "NO_ANSWER", "CALLER_HUNG_UP", "CALLER_HUNG_UP", "NOT_ACCEPTED"] as const);
      const call = await db.call.create({
        data: {
          businessId: b.id, callerLegId: `seed-${caller}`, fromNumber: from, state: "ENDED", startedAt: at, afterHours: !open,
          outcome: answered ? "ANSWERED" : "MISSED", missReason: answered ? null : reason, answeredAt: answered ? at : null,
        },
      });
      if (answered) continue;

      const [job, urgent, value] = pick(JOBS);
      const replied = rnd() < 0.7;
      const t = (min: number) => new Date(Math.min(now - 1000, at.getTime() + min * 60_000));
      let stage: LeadStage = "NEW";
      if (replied) {
        const r = rnd();
        stage = day < 1 ? "QUALIFIED" : r < 0.45 ? "WON" : r < 0.62 ? "SCHEDULED" : r < 0.8 ? "QUALIFIED" : "LOST";
      }
      const address = `${100 + Math.floor(rnd() * 9000)} ${pick(STREETS)}, Austin TX`;
      const lead = await db.lead.create({
        data: {
          businessId: b.id, code: ++code, phone: from, name: replied ? pick(NAMES) : null, job: replied ? job : null, address: replied ? address : null,
          urgent: replied && urgent, stage, intakeStep: replied ? 0 : 1,
          valueCents: stage === "WON" ? Math.round(value * (0.8 + rnd() * 0.5)) * 100 : null,
          wonAt: stage === "WON" ? t(60 * 24 * Math.min(day, 2)) : null,
          appointmentAt: stage === "SCHEDULED" ? new Date(now + (1 + Math.floor(rnd() * 4)) * 864e5) : null,
          lastInboundAt: replied ? t(6) : null, lastOutboundAt: t(0), createdAt: at,
        },
      });
      await db.call.update({ where: { id: call.id }, data: { leadId: lead.id } });
      const msgs: [("IN" | "OUT"), string, string, number][] = [["OUT", "AUTO_REPLY", fill(open ? DEFAULT_MISSED_TEXT : DEFAULT_AFTER_HOURS_TEXT, v), 0]];
      if (replied) {
        msgs.push(["IN", "CUSTOMER", job, 3], ["OUT", "INTAKE", ASK_ADDRESS, 3], ["IN", "CUSTOMER", address, 5], ["OUT", "INTAKE", ASK_EMERGENCY, 5],
          ["IN", "CUSTOMER", urgent ? "YES" : "No", 6], ["OUT", "INTAKE", fill(urgent ? INTAKE_DONE_URGENT : INTAKE_DONE, v), 6]);
        if (stage !== "QUALIFIED") msgs.push(["OUT", "OWNER", "Mike here — I can come by tomorrow at 9, does that work?", 35], ["IN", "CUSTOMER", "Yes that works, thank you!", 41]);
      }
      for (const [direction, kind, body, min] of msgs) {
        await db.message.create({ data: { businessId: b.id, leadId: lead.id, direction, kind: kind as never, body, status: direction === "IN" ? "received" : "delivered", createdAt: t(min) } });
      }
    }
  }
  await db.business.update({ where: { id: b.id }, data: { leadSeq: code } });
  console.log(`Seeded ${b.name}: ${caller} calls, ${code} leads. Sign in: demo@tradecall.test / demo-password`);
}
main().finally(() => db.$disconnect());
