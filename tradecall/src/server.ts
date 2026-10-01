import { createApp } from "./app";
import type { Deps } from "./core/deps";
import { sendDigests } from "./core/digest";
import { runDueJobs } from "./core/jobs";
import { config, jwtSecret } from "./lib/config";
import { makeMailer } from "./lib/mail";
import { FakeProvider } from "./providers/fake";
import { TelnyxProvider } from "./providers/telnyx";
import type { Provider } from "./providers/types";

function makeProvider(): Provider {
  const t = config.telnyx;
  const required = [t.apiKey, t.publicKey, t.connectionId];
  if (required.every(Boolean)) {
    return new TelnyxProvider({ apiKey: t.apiKey, publicKey: t.publicKey, connectionId: t.connectionId, messagingProfileId: t.messagingProfileId || undefined });
  }
  // Demo mode accepts UNSIGNED webhooks, so never fall into it by accident:
  // a half-configured Telnyx setup, or production without an explicit opt-in, is fatal.
  if (required.some(Boolean)) {
    throw new Error("Telnyx is partly configured — set all of TELNYX_API_KEY, TELNYX_PUBLIC_KEY and TELNYX_CONNECTION_ID (or none for demo mode).");
  }
  if (process.env.NODE_ENV === "production" && process.env.DEMO_MODE !== "true") {
    throw new Error("No phone provider configured. Set the TELNYX_* variables, or DEMO_MODE=true to run the demo in production.");
  }
  console.warn(
    "[provider] TELNYX_API_KEY / TELNYX_PUBLIC_KEY / TELNYX_CONNECTION_ID not all set — DEMO MODE: no real calls or texts, and /webhooks/fake accepts unsigned events.",
  );
  return new FakeProvider();
}

jwtSecret();
const deps: Deps = { provider: makeProvider(), mailer: makeMailer(), now: () => new Date() };

createApp(deps).listen(config.port, () => console.log(`TradeCall on :${config.port} via ${deps.provider.name} (${config.publicUrl})`));

if (config.runWorker) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const j = await runDueJobs(deps);
      if (j.sent || j.failed) console.log(`[worker] texts sent=${j.sent} failed=${j.failed}`);
      const d = await sendDigests(deps);
      if (d) console.log(`[worker] weekly digests=${d}`);
    } catch (err) {
      console.error("[worker]", err);
    } finally {
      busy = false;
    }
  };
  setInterval(tick, config.workerIntervalMs);
  void tick();
}
