// In-memory provider for local demo mode and tests. Records every command
// so tests can assert exactly what the call flow asked the network to do.

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
  commands: Command[] = [];
  sms: { from: string; to: string; text: string; providerId: string }[] = [];
  bought: string[] = [];
  failNextSms = false;
  recordings = new Map<string, Buffer>();
  private n = 0;

  verifyWebhook() {
    return true;
  }
  parseWebhook(rawBody: string): ProviderEvent {
    return JSON.parse(rawBody) as ProviderEvent;
  }

  async dial(args: { to: string; from: string; timeoutSecs: number } & CommandOpts) {
    const legId = `owner-leg-${++this.n}`;
    const { to, from, timeoutSecs, ...opts } = args;
    this.commands.push({ cmd: "dial", to, from, timeoutSecs, legId, opts });
    return { legId };
  }
  async answer(legId: string, opts: CommandOpts = {}) {
    this.commands.push({ cmd: "answer", legId, opts });
  }
  async bridge(legId: string, otherLegId: string, opts: CommandOpts = {}) {
    this.commands.push({ cmd: "bridge", legId, otherLegId, opts });
  }
  async speak(legId: string, text: string, opts: CommandOpts = {}) {
    this.commands.push({ cmd: "speak", legId, text, opts });
  }
  async askForKey(legId: string, prompt: string, timeoutMs: number, opts: CommandOpts = {}) {
    this.commands.push({ cmd: "askForKey", legId, prompt, timeoutMs, opts });
  }
  async record(legId: string, maxSeconds: number, opts: CommandOpts = {}) {
    this.commands.push({ cmd: "record", legId, maxSeconds, opts });
  }
  async hangup(legId: string, opts: CommandOpts = {}) {
    this.commands.push({ cmd: "hangup", legId, opts });
  }
  async downloadRecording(url: string) {
    return { audio: this.recordings.get(url) ?? Buffer.from("ID3-fake-mp3"), mimeType: "audio/mpeg" };
  }

  async sendSms(args: { from: string; to: string; text: string }) {
    if (this.failNextSms) {
      this.failNextSms = false;
      throw new Error("Simulated provider failure");
    }
    const providerId = `msg-${++this.n}`;
    this.sms.push({ ...args, providerId });
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
