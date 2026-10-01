// Single entry point for provider webhooks: drop duplicates, then route.

import { Prisma } from "@prisma/client";
import { db } from "../lib/db";
import type { ProviderEvent } from "../providers/types";
import { handleVoiceEvent } from "./callFlow";
import { handleInboundSms } from "./conversation";
import type { Deps } from "./deps";

export async function handleEvent(deps: Deps, ev: ProviderEvent): Promise<"handled" | "duplicate" | "ignored"> {
  if (ev.type === "ignored") return "ignored";
  try {
    await db.webhookEvent.create({ data: { id: `${deps.provider.name}:${ev.eventId}` } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return "duplicate";
    throw err;
  }
  try {
    if (ev.type === "sms.received") await handleInboundSms(deps, ev);
    else if (ev.type === "sms.status") {
      await db.message.updateMany({ where: { providerId: ev.providerId }, data: { status: ev.status, ...(ev.error ? { error: ev.error } : {}) } });
    } else await handleVoiceEvent(deps, ev);
  } catch (err) {
    // Let the provider retry this event: forget we saw it.
    await db.webhookEvent.delete({ where: { id: `${deps.provider.name}:${ev.eventId}` } }).catch(() => {});
    throw err;
  }
  return "handled";
}
