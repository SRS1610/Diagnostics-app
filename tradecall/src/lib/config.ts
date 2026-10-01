import "dotenv/config";

const bool = (v: string | undefined, d: boolean) => (v === undefined || v === "" ? d : v === "true" || v === "1");

export const config = {
  port: Number(process.env.PORT ?? 4100),
  // Public HTTPS origin — used in alert links. Set it to what owners open.
  publicUrl: (process.env.PUBLIC_URL ?? "http://localhost:4100").replace(/\/$/, ""),
  jwtSecret: process.env.JWT_SECRET ?? "",
  telnyx: {
    apiKey: process.env.TELNYX_API_KEY ?? "",
    publicKey: process.env.TELNYX_PUBLIC_KEY ?? "",
    connectionId: process.env.TELNYX_CONNECTION_ID ?? "",
    messagingProfileId: process.env.TELNYX_MESSAGING_PROFILE_ID ?? "",
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY ?? "",
    from: process.env.DIGEST_FROM_EMAIL ?? "",
  },
  runWorker: bool(process.env.RUN_WORKER, true),
  workerIntervalMs: Number(process.env.WORKER_INTERVAL_MS ?? 30_000),
};

export function jwtSecret(): string {
  if (config.jwtSecret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");
  return config.jwtSecret;
}
