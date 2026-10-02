// Append-only record of who changed what. Never throws into the caller:
// a logging hiccup must not undo the action it describes.

import type { Prisma } from "@prisma/client";
import type { Session } from "../lib/auth";
import { db } from "../lib/db";

export async function audit(
  actor: Session | "system",
  businessId: string | null,
  action: string,
  target?: string | null,
  details?: Prisma.InputJsonValue,
): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        businessId,
        actorId: actor === "system" ? null : actor.userId,
        actorName: actor === "system" ? "System" : actor.name,
        actorKind: actor === "system" ? "SYSTEM" : actor.role === "PLATFORM_ADMIN" ? "PLATFORM" : "USER",
        action,
        target: target ?? null,
        details: details ?? undefined,
      },
    });
  } catch (err) {
    console.error(`[audit] failed to record ${action}:`, err instanceof Error ? err.message : err);
  }
}
