import { z } from "zod";
import { toE164 } from "../lib/phone";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const phone = z.string().transform((v, ctx) => toE164(v) ?? (ctx.addIssue({ code: "custom", message: "Enter a valid phone number" }), z.NEVER));
export const email = z.string().trim().toLowerCase().email();
export const password = z.string().min(8, "Use at least 8 characters").max(200);
export const personName = z.string().trim().min(1).max(60);
