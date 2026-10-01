// Telnyx adapter: Call Control v2 for voice, Messaging v2 for SMS, Number
// Orders for provisioning. Plain fetch against https://api.telnyx.com/v2 —
// endpoints and field names checked against the official telnyx@7 SDK types.

import type { KeyObject } from "node:crypto";
import { ProviderError, type AvailableNumber, type CommandOpts, type LegState, type Provider, type ProviderEvent } from "../types";
import { publicKeyFromBase64, verifyTelnyxSignature } from "./verify";

export interface TelnyxConfig {
  apiKey: string;
  publicKey: string; // base64 Ed25519 key from Mission Control
  connectionId: string; // Call Control Application id — numbers are assigned to it
  messagingProfileId?: string; // 10DLC-registered messaging profile
  baseUrl?: string;
  fetch?: typeof fetch;
}

const VOICE = "female";

function encodeState(state?: LegState): string | undefined {
  return state ? Buffer.from(JSON.stringify(state)).toString("base64") : undefined;
}

function decodeState(raw: unknown): LegState | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    return v && typeof v.callId === "string" && (v.role === "caller" || v.role === "owner") ? v : null;
  } catch {
    return null;
  }
}

function firstNumber(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v[0] && typeof v[0].phone_number === "string") return v[0].phone_number;
  if (v && typeof v === "object" && typeof (v as { phone_number?: unknown }).phone_number === "string") {
    return (v as { phone_number: string }).phone_number;
  }
  return "";
}

const HANGUP_CAUSES: Record<string, Extract<ProviderEvent, { type: "call.ended" }>["cause"]> = {
  timeout: "no_answer",
  no_answer: "no_answer",
  user_busy: "busy",
  call_rejected: "rejected",
  originator_cancel: "caller_cancel",
  normal_clearing: "normal",
};

export class TelnyxProvider implements Provider {
  readonly name = "telnyx";
  private key: KeyObject;
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(private cfg: TelnyxConfig) {
    this.key = publicKeyFromBase64(cfg.publicKey);
    this.baseUrl = (cfg.baseUrl ?? "https://api.telnyx.com/v2").replace(/\/$/, "");
    this.fetchImpl = cfg.fetch ?? fetch;
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean {
    return verifyTelnyxSignature(this.key, rawBody, headers);
  }

  parseWebhook(rawBody: string): ProviderEvent {
    const body = JSON.parse(rawBody);
    const data = body?.data ?? {};
    const p = data.payload ?? {};
    const eventId: string = data.id ?? `${data.event_type}:${p.call_control_id ?? p.id ?? ""}:${data.occurred_at ?? ""}`;
    const state = decodeState(p.client_state);

    switch (data.event_type) {
      case "call.initiated":
        // Our own outbound leg to the owner also fires call.initiated.
        if (p.direction !== "incoming") return { type: "ignored", eventId, reason: "outbound leg initiated" };
        return { type: "call.incoming", eventId, legId: p.call_control_id, sessionId: p.call_session_id ?? null, from: p.from ?? "", to: p.to ?? "" };
      case "call.answered":
        return { type: "call.answered", eventId, legId: p.call_control_id, state };
      case "call.gather.ended":
        return {
          type: "call.keypress",
          eventId,
          legId: p.call_control_id,
          digits: p.digits ?? "",
          outcome: p.status === "valid" ? "entered" : p.status === "call_hangup" ? "hangup" : "timeout",
          state,
        };
      case "call.speak.ended":
        return { type: "call.speech_done", eventId, legId: p.call_control_id, state };
      case "call.hangup":
        return { type: "call.ended", eventId, legId: p.call_control_id, cause: HANGUP_CAUSES[p.hangup_cause] ?? "other", state };
      case "call.recording.saved": {
        const url = p.recording_urls?.mp3 ?? p.public_recording_urls?.mp3;
        if (!url) return { type: "ignored", eventId, reason: "recording without mp3 url" };
        return { type: "call.recording_ready", eventId, sessionId: p.call_session_id ?? null, legId: p.call_leg_id ?? null, url };
      }
      case "message.received":
        return { type: "sms.received", eventId, providerId: p.id, from: firstNumber(p.from), to: firstNumber(p.to), text: p.text ?? "" };
      case "message.sent":
      case "message.finalized": {
        const raw: string = Array.isArray(p.to) ? p.to[0]?.status : "";
        const status = raw === "delivered" ? "delivered" : raw === "sending_failed" || raw === "delivery_failed" ? "failed" : "sent";
        const err = Array.isArray(p.errors) && p.errors[0] ? p.errors[0].detail ?? p.errors[0].title ?? `code ${p.errors[0].code}` : null;
        return { type: "sms.status", eventId, providerId: p.id, status, error: status === "failed" ? err ?? raw : null };
      }
      default:
        return { type: "ignored", eventId, reason: `unhandled ${data.event_type}` };
    }
  }

  private async request<T = unknown>(method: "GET" | "POST", path: string, body?: object, query?: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}${query ? `?${query}` : ""}`, {
      method,
      headers: {
        authorization: `Bearer ${this.cfg.apiKey}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const detail = json?.errors?.[0]?.detail ?? json?.errors?.[0]?.title ?? res.statusText;
      // Telnyx answers 422 when commanding a call that has already hung up.
      const gone = res.status === 422 && /ended|hung up|not found|no longer active/i.test(String(detail));
      throw new ProviderError(`Telnyx ${method} ${path} failed (${res.status}): ${detail}`, res.status, gone);
    }
    return json as T;
  }

  private action(legId: string, action: string, body: Record<string, unknown>, opts?: CommandOpts) {
    return this.request("POST", `/calls/${encodeURIComponent(legId)}/actions/${action}`, {
      ...body,
      ...(opts?.state ? { client_state: encodeState(opts.state) } : {}),
      ...(opts?.commandId ? { command_id: opts.commandId } : {}),
    });
  }

  async dial(args: { to: string; from: string; timeoutSecs: number } & CommandOpts) {
    const res = await this.request<{ data: { call_control_id: string } }>("POST", "/calls", {
      connection_id: this.cfg.connectionId,
      to: args.to,
      from: args.from,
      timeout_secs: args.timeoutSecs,
      ...(args.state ? { client_state: encodeState(args.state) } : {}),
      ...(args.commandId ? { command_id: args.commandId } : {}),
    });
    return { legId: res.data.call_control_id };
  }

  async answer(legId: string, opts?: CommandOpts) {
    await this.action(legId, "answer", {}, opts);
  }

  async bridge(legId: string, otherLegId: string, opts?: CommandOpts) {
    await this.action(legId, "bridge", { call_control_id: otherLegId }, opts);
  }

  async speak(legId: string, text: string, opts?: CommandOpts) {
    await this.action(legId, "speak", { payload: text, voice: VOICE, language: "en-US" }, opts);
  }

  async askForKey(legId: string, prompt: string, timeoutMs: number, opts?: CommandOpts) {
    await this.action(
      legId,
      "gather_using_speak",
      { payload: prompt, voice: VOICE, language: "en-US", minimum_digits: 1, maximum_digits: 1, maximum_tries: 1, timeout_millis: timeoutMs, valid_digits: "0123456789*#" },
      opts,
    );
  }

  async record(legId: string, maxSeconds: number, opts?: CommandOpts) {
    await this.action(legId, "record_start", { format: "mp3", channels: "single", play_beep: true, max_length: maxSeconds, timeout_secs: 8 }, opts);
  }

  async hangup(legId: string, opts?: CommandOpts) {
    try {
      await this.action(legId, "hangup", {}, opts);
    } catch (err) {
      if (err instanceof ProviderError && err.gone) return; // already over — that's the goal
      throw err;
    }
  }

  async downloadRecording(url: string) {
    // Recording URLs are pre-signed and expire after ~10 minutes.
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new ProviderError(`Recording download failed (${res.status})`, res.status);
    return { audio: Buffer.from(await res.arrayBuffer()), mimeType: res.headers.get("content-type") ?? "audio/mpeg" };
  }

  async sendSms(args: { from: string; to: string; text: string }) {
    const res = await this.request<{ data: { id: string; to?: { status?: string }[] } }>("POST", "/messages", {
      from: args.from,
      to: args.to,
      text: args.text,
      ...(this.cfg.messagingProfileId ? { messaging_profile_id: this.cfg.messagingProfileId } : {}),
    });
    return { providerId: res.data.id, status: res.data.to?.[0]?.status ?? "queued" };
  }

  async searchNumbers(areaCode: string): Promise<AvailableNumber[]> {
    const q = new URLSearchParams({
      "filter[country_code]": "US",
      "filter[national_destination_code]": areaCode,
      "filter[features]": "sms,voice",
      "filter[phone_number_type]": "local",
      "filter[limit]": "10",
    });
    const res = await this.request<{ data?: { phone_number?: string; region_information?: { region_type?: string; region_name?: string }[] }[] }>(
      "GET",
      "/available_phone_numbers",
      undefined,
      q.toString(),
    );
    return (res.data ?? [])
      .filter((n) => n.phone_number)
      .map((n) => {
        const region = (type: string) => n.region_information?.find((r) => r.region_type === type)?.region_name ?? null;
        return { phoneNumber: n.phone_number!, locality: region("rate_center"), region: region("state") };
      });
  }

  async buyNumber(phoneNumber: string) {
    // Assigning the Call Control app + messaging profile on the order means
    // the number's calls and texts hit our webhooks as soon as it's active.
    await this.request("POST", "/number_orders", {
      phone_numbers: [{ phone_number: phoneNumber }],
      connection_id: this.cfg.connectionId,
      ...(this.cfg.messagingProfileId ? { messaging_profile_id: this.cfg.messagingProfileId } : {}),
    });
  }
}
