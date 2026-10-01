// Weekly digest email through Resend's HTTP API (optional — the digest
// always goes out by SMS too).

import { config } from "./config";

export interface Mailer {
  send(m: { to: string; subject: string; text: string; html: string }): Promise<void>;
}

export class ResendMailer implements Mailer {
  constructor(private apiKey: string, private from: string, private fetchImpl: typeof fetch = fetch) {}
  async send(m: { to: string; subject: string; text: string; html: string }) {
    const res = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
    });
    if (!res.ok) throw new Error(`Resend failed (${res.status}): ${await res.text()}`);
  }
}

export class MemoryMailer implements Mailer {
  sent: { to: string; subject: string; text: string; html: string }[] = [];
  async send(m: { to: string; subject: string; text: string; html: string }) {
    this.sent.push(m);
  }
}

export function makeMailer(): Mailer | null {
  return config.resend.apiKey && config.resend.from ? new ResendMailer(config.resend.apiKey, config.resend.from) : null;
}
