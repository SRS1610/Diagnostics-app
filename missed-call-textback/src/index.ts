import { createApp } from "./app";
import { config, requireJwtSecret } from "./lib/config";
import type { Deps } from "./lib/deps";
import { createMailer } from "./lib/email";
import { createTelephony } from "./lib/telephony";
import { runWeeklyDigests } from "./services/digest";
import { runDueJobs } from "./services/scheduler";

requireJwtSecret();
if (!config.twilio.validateSignatures) {
  console.warn("[security] TWILIO_VALIDATE_SIGNATURES=false — anyone can post fake calls/texts. Never use this in production.");
}

const deps: Deps = { telephony: createTelephony(), mailer: createMailer(), now: () => new Date() };

createApp(deps).listen(config.port, () => {
  console.log(`missed-call-textback listening on :${config.port} (public URL ${config.publicBaseUrl})`);
});

if (config.runWorker) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const jobs = await runDueJobs(deps);
      if (jobs.sent || jobs.failed) console.log(`[worker] sent=${jobs.sent} skipped=${jobs.skipped} failed=${jobs.failed}`);
      const digests = await runWeeklyDigests(deps);
      if (digests) console.log(`[worker] weekly digests sent=${digests}`);
    } catch (err) {
      console.error("[worker] tick failed:", err);
    } finally {
      running = false;
    }
  };
  setInterval(tick, config.workerIntervalMs);
  void tick();
}
