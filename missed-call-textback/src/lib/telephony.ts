// The only module that talks to Twilio's REST API. Everything else gets a
// Telephony from app deps, so tests swap in FakeTelephony and production
// code never needs to know whether credentials are present.

import twilio from "twilio";
import { config } from "./config";

export interface SentSms {
  sid: string | null;
  status: string;
}

export interface AvailableNumber {
  phoneNumber: string;
  locality: string | null;
  region: string | null;
}

export interface Telephony {
  sendSms(args: { from: string; to: string; body: string }): Promise<SentSms>;
  searchNumbers(areaCode: string): Promise<AvailableNumber[]>;
  /** Buys a number and points its voice + SMS webhooks at this server. */
  purchaseNumber(phoneNumber: string): Promise<{ phoneNumber: string; sid: string }>;
}

export class TwilioTelephony implements Telephony {
  private client: ReturnType<typeof twilio>;

  constructor(accountSid: string, authToken: string, private messagingServiceSid: string) {
    this.client = twilio(accountSid, authToken);
  }

  async sendSms({ from, to, body }: { from: string; to: string; body: string }): Promise<SentSms> {
    const msg = await this.client.messages.create({
      to,
      body,
      ...(this.messagingServiceSid ? { messagingServiceSid: this.messagingServiceSid } : { from }),
      statusCallback: `${config.publicBaseUrl}/twilio/sms/status`,
    });
    return { sid: msg.sid, status: msg.status };
  }

  async searchNumbers(areaCode: string): Promise<AvailableNumber[]> {
    const list = await this.client
      .availablePhoneNumbers("US")
      .local.list({ areaCode: Number(areaCode), smsEnabled: true, voiceEnabled: true, limit: 10 });
    return list.map((n) => ({ phoneNumber: n.phoneNumber, locality: n.locality, region: n.region }));
  }

  async purchaseNumber(phoneNumber: string) {
    const n = await this.client.incomingPhoneNumbers.create({
      phoneNumber,
      voiceUrl: `${config.publicBaseUrl}/twilio/voice/incoming`,
      voiceMethod: "POST",
      smsUrl: `${config.publicBaseUrl}/twilio/sms/incoming`,
      smsMethod: "POST",
    });
    if (this.messagingServiceSid) {
      // Attach to the A2P-registered Messaging Service so texts from this
      // number count as registered traffic. The service's own inbound
      // webhook must also point at /twilio/sms/incoming (see README).
      await this.client.messaging.v1.services(this.messagingServiceSid).phoneNumbers.create({ phoneNumberSid: n.sid });
    }
    return { phoneNumber: n.phoneNumber, sid: n.sid };
  }
}

/** Used when Twilio credentials are missing (local dev) and in tests. */
export class FakeTelephony implements Telephony {
  sent: { from: string; to: string; body: string; sid: string }[] = [];
  purchased: string[] = [];
  failNext = false;
  private counter = 0;

  async sendSms(args: { from: string; to: string; body: string }): Promise<SentSms> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("Simulated Twilio failure");
    }
    const sid = `SMfake${++this.counter}`;
    this.sent.push({ ...args, sid });
    return { sid, status: "queued" };
  }

  async searchNumbers(areaCode: string): Promise<AvailableNumber[]> {
    return [1, 2, 3].map((i) => ({ phoneNumber: `+1${areaCode}555010${i}`, locality: "Testville", region: "TX" }));
  }

  async purchaseNumber(phoneNumber: string) {
    this.purchased.push(phoneNumber);
    return { phoneNumber, sid: `PNfake${this.purchased.length}` };
  }

  /** Test helper: messages sent to one number, oldest first. */
  to(number: string) {
    return this.sent.filter((m) => m.to === number);
  }

  reset() {
    this.sent = [];
    this.purchased = [];
    this.failNext = false;
  }
}

export function createTelephony(): Telephony {
  const { accountSid, authToken, messagingServiceSid } = config.twilio;
  if (!accountSid || !authToken) {
    console.warn(
      "[telephony] TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not set — using an in-memory fake. No real SMS will be sent.",
    );
    return new FakeTelephony();
  }
  return new TwilioTelephony(accountSid, authToken, messagingServiceSid);
}
