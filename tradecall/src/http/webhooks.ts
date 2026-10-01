// POST /webhooks/:provider — one endpoint per provider for every call and
// SMS event. The raw body is kept for signature verification, which must
// pass before anything is parsed or stored.

import { Router, raw } from "express";
import { handleEvent } from "../core/events";
import type { Deps } from "../core/deps";

export function webhookRoutes(deps: Deps): Router {
  const r = Router();
  r.post("/:provider", raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
    if (req.params.provider !== deps.provider.name) return res.status(404).json({ error: "Unknown provider" });
    const body = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    if (!deps.provider.verifyWebhook(body, req.headers)) return res.status(403).json({ error: "Invalid signature" });
    let event;
    try {
      event = deps.provider.parseWebhook(body);
    } catch {
      return res.status(400).json({ error: "Unreadable payload" });
    }
    const result = await handleEvent(deps, event);
    res.json({ ok: true, result });
  });
  return r;
}
