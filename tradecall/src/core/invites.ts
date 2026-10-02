// Creating an invite — shared by a business's own Team page and the
// platform console, so both follow the same rules: one live invite per
// email per business, plan seat limits, 7-day single-use link stored only
// as a hash, emailed when email is configured, always audit-logged.

import { createHash, randomBytes } from "node:crypto";
import type { Business, UserRole } from "@prisma/client";
import type { Session } from "../lib/auth";
import { config } from "../lib/config";
import { db } from "../lib/db";
import { PLANS } from "../lib/plans";
import { audit } from "./audit";
import type { Deps } from "./deps";
import { seatUsage } from "./team";

export const INVITE_DAYS = 7;
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newInviteToken = () => randomBytes(32).toString("base64url");

export class SeatsFullError extends Error {}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function createInvite(
  deps: Deps,
  b: Business,
  email: string,
  role: Exclude<UserRole, "PLATFORM_ADMIN">,
  by: Session,
) {
  const now = deps.now();
  // Re-inviting the same email replaces the old link instead of using another seat.
  await db.invite.updateMany({ where: { businessId: b.id, email, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } });
  const { used } = await seatUsage(b.id, now);
  const plan = PLANS[b.plan];
  if (used >= plan.seats) {
    throw new SeatsFullError(`The ${plan.label} plan includes ${plan.seats} seats and they're all in use. Remove someone or upgrade.`);
  }

  const token = newInviteToken();
  const invite = await db.invite.create({
    data: { businessId: b.id, email, role, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + INVITE_DAYS * 86_400_000), invitedById: by.userId },
    select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
  });
  const link = `${config.publicUrl}/#/invite/${token}`;

  // Invites from TradeCall staff read as coming from TradeCall, not a person.
  const fromStaff = by.role === "PLATFORM_ADMIN";
  const lead = fromStaff ? `TradeCall has set up ${b.name}` : `${by.name} added you to ${b.name}`;
  let emailed = false;
  if (deps.mailer) {
    try {
      await deps.mailer.send({
        to: email,
        subject: fromStaff ? `Your TradeCall account for ${b.name} is ready` : `${by.name} invited you to ${b.name} on TradeCall`,
        text: `${lead}. Set up your login here (the link expires in ${INVITE_DAYS} days):\n${link}`,
        html: `<p>${esc(lead)}.</p><p><a href="${link}">Set up your login</a> — the link expires in ${INVITE_DAYS} days.</p>`,
      });
      emailed = true;
    } catch (err) {
      console.error("[invite] email failed:", err instanceof Error ? err.message : err);
    }
  }
  await audit(by, b.id, "invite_sent", email, { role });
  return { invite, link, emailed };
}
