// In-memory provider for local demo mode and tests. Records every command
// so tests can assert exactly what the call flow asked the network to do.

import { randomUUID } from "node:crypto";
import type { AvailableNumber, CommandOpts, Provider, ProviderEvent } from "./types";

export type Command =
  | { cmd: "dial"; to: string; from: string; timeoutSecs: number; legId: string; opts: CommandOpts }
  | { cmd: "answer" | "hangup"; legId: string; opts: CommandOpts }
  | { cmd: "bridge"; legId: string; otherLegId: string; opts: CommandOpts }
  | { cmd: "speak"; legId: string; text: string; opts: CommandOpts }
  | { cmd: "askForKey"; legId: string; prompt: string; timeoutMs: number; opts: CommandOpts }
  | { cmd: "record"; legId: string; maxSeconds: number; opts: CommandOpts };

export class FakeProvider implements Provider {
  readonly name = "fake";
  /** Demo mode prints every text and call command to the server log so you can follow along. */
  constructor(private opts: { log?: boolean } = {}) {}
  private say(line: string) {
    if (this.opts.log) console.log(`[demo] ${line}`);
  }
  commands: Command[] = [];
  sms: { from: string; to: string; text: string; providerId: string; messagingProfileId?: string | null }[] = [];
  bought: string[] = [];
  failNextSms = false;
  recordings = new Map<string, Buffer>();

  verifyWebhook() {
    return true;
  }
  parseWebhook(rawBody: string): ProviderEvent {
    return JSON.parse(rawBody) as ProviderEvent;
  }

  async dial(args: { to: string; from: string; timeoutSecs: number } & CommandOpts) {
    // Unique across restarts: leg ids are stored, and a reused id would collide.
    const legId = `owner-leg-${randomUUID().slice(0, 8)}`;
    const { to, from, timeoutSecs, ...opts } = args;
    this.commands.push({ cmd: "dial", to, from, timeoutSecs, legId, opts });
    if (this.opts.log && this.commands.length > 4000) this.commands.splice(0, 2000);
    this.say(`📞 ringing ${to} for ${timeoutSecs}s (owner leg ${legId})`);
    return { legId };
  }
  async answer(legId: string, opts: CommandOpts = {}) {
    this.commands.push({ cmd: "answer", legId, opts });
    this.say(`answer ${legId}`);
  }
  async bridge(legId: string, otherLegId: string, opts: CommandOpts = {}) {
    this.commands.push({ cmd: "bridge", legId, otherLegId, opts });
    this.say(`🔗 connected ${legId} ↔ ${otherLegId}`);
  }
  async speak(legId: string, text: string, opts: CommandOpts = {}) {
    this.commands.push({ cmd: "speak", legId, text, opts });
    this.say(`🔊 to ${legId}: "${text}"`);
  }
  async askForKey(legId: string, prompt: string, timeoutMs: number, opts: CommandOpts = {}) {
    this.commands.push({ cmd: "askForKey", legId, prompt, timeoutMs, opts });
    this.say(`🔊 to ${legId}: "${prompt}" (waiting for a key)`);
  }
  async record(legId: string, maxSeconds: number, opts: CommandOpts = {}) {
    this.commands.push({ cmd: "record", legId, maxSeconds, opts });
    this.say(`⏺ recording voicemail on ${legId} (max ${maxSeconds}s)`);
  }
  async hangup(legId: string, opts: CommandOpts = {}) {
    this.commands.push({ cmd: "hangup", legId, opts });
    this.say(`hang up ${legId}`);
  }
  async downloadRecording(url: string) {
    return { audio: this.recordings.get(url) ?? Buffer.from("ID3-fake-mp3"), mimeType: "audio/mpeg" };
  }

  async sendSms(args: { from: string; to: string; text: string; messagingProfileId?: string | null }) {
    if (this.failNextSms) {
      this.failNextSms = false;
      throw new Error("Simulated provider failure");
    }
    const providerId = `msg-${randomUUID().slice(0, 8)}`;
    this.sms.push({ ...args, providerId });
    if (this.opts.log && this.sms.length > 2000) this.sms.splice(0, 1000); // bounded on a long-running demo server
    this.say(`💬 text ${args.from} → ${args.to}:\n         ${args.text.replace(/\n/g, "\n         ")}`);
    return { providerId, status: "queued" };
  }

  async searchNumbers(areaCode: string): Promise<AvailableNumber[]> {
    return [1, 2, 3].map((i) => ({ phoneNumber: `+1${areaCode}555010${i}`, locality: "Demo City", region: "TX" }));
  }
  async buyNumber(phoneNumber: string) {
    this.bought.push(phoneNumber);
  }

  // --- test helpers ---
  smsTo(number: string) {
    return this.sms.filter((m) => m.to === number);
  }
  commandsFor(legId: string) {
    return this.commands.filter((c) => c.legId === legId);
  }
  last<T extends Command["cmd"]>(cmd: T): Extract<Command, { cmd: T }> | undefined {
    return [...this.commands].reverse().find((c) => c.cmd === cmd) as Extract<Command, { cmd: T }> | undefined;
  }
}
