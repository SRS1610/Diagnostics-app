import "express-async-errors";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import type { Deps } from "./core/deps";
import { HttpError, apiRoutes } from "./http/api";
import { webhookRoutes } from "./http/webhooks";

export function createApp(deps: Deps) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.get("/health", (_req, res) => res.json({ ok: true, provider: deps.provider.name }));
  app.use("/webhooks", webhookRoutes(deps));
  app.use("/api", apiRoutes(deps));
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      const i = err.issues[0];
      return res.status(400).json({ error: `${i.path.join(".") || "input"}: ${i.message}` });
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  });
  return app;
}
