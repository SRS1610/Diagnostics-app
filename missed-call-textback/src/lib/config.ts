// Environment config, read once. Twilio and SendGrid are optional at boot
// so the dashboard can run locally without them; the telephony adapter
// says loudly when they're missing instead of failing silently.

import "dotenv/config";

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return v === "true" || v === "1";
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  // Public HTTPS origin Twilio calls back to, e.g. https://textback.example.com.
  // Also used to verify webhook signatures, which are computed over the full URL.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "http://localhost:4000").replace(/\/$/, ""),
  jwtSecret: process.env.JWT_SECRET ?? "",
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID ?? "",
    authToken: process.env.TWILIO_AUTH_TOKEN ?? "",
    // A2P 10DLC: registered US traffic must go through a Messaging Service
    // tied to an approved campaign. When set, all SMS is sent through it.
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID ?? "",
    validateSignatures: bool(process.env.TWILIO_VALIDATE_SIGNATURES, true),
  },
  sendgrid: {
    apiKey: process.env.SENDGRID_API_KEY ?? "",
    from: process.env.SENDGRID_FROM_EMAIL ?? "",
  },
  workerIntervalMs: Number(process.env.WORKER_INTERVAL_MS ?? 30_000),
  runWorker: bool(process.env.RUN_WORKER, true),
};

export function requireJwtSecret(): string {
  if (!config.jwtSecret || config.jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must be set to at least 32 characters");
  }
  return config.jwtSecret;
}
