import "express-async-errors";
import path from "path";
import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import type { Deps } from "./lib/deps";
import { HttpError, apiRouter } from "./routes/api";
import { twilioRouter } from "./routes/twilio";

export function createApp(deps: Deps) {
  const app = express();
  app.disable("x-powered-by");
  // Behind Render/Heroku-style proxies, so rate limiting sees the client IP.
  app.set("trust proxy", 1);

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/twilio", twilioRouter(deps));
  app.use("/api", apiRouter(deps));
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return res.status(400).json({ error: `${first.path.join(".") || "input"}: ${first.message}`, issues: err.issues });
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  });

  return app;
}
