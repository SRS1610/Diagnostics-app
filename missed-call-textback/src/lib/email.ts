// Weekly digest email via SendGrid. Optional — when it isn't configured
// the digest still goes out by SMS.

import sgMail from "@sendgrid/mail";
import { config } from "./config";

export interface Mailer {
  send(args: { to: string; subject: string; text: string; html: string }): Promise<void>;
}

export class SendGridMailer implements Mailer {
  constructor(apiKey: string, private from: string) {
    sgMail.setApiKey(apiKey);
  }
  async send(args: { to: string; subject: string; text: string; html: string }) {
    await sgMail.send({ ...args, from: this.from });
  }
}

export class FakeMailer implements Mailer {
  sent: { to: string; subject: string; text: string; html: string }[] = [];
  async send(args: { to: string; subject: string; text: string; html: string }) {
    this.sent.push(args);
  }
}

export function createMailer(): Mailer | null {
  if (!config.sendgrid.apiKey || !config.sendgrid.from) return null;
  return new SendGridMailer(config.sendgrid.apiKey, config.sendgrid.from);
}
