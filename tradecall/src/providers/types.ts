// The provider boundary. Core logic (call flow, texting, scheduling) only
// ever sees these normalized events and commands — it never knows whether
// Telnyx, Plivo or anyone else is underneath. Adding a provider means
// writing one adapter that implements Provider; nothing in core/ changes.

/** Opaque state we attach to a call leg and get back on every event for it. */
export interface LegState {
  callId: string;
  role: "caller" | "owner";
}

interface Base {
  /** Provider's unique event id — used to drop duplicate deliveries. */
  eventId: string;
}

export type ProviderEvent =
  | (Base & { type: "call.incoming"; legId: string; sessionId: string | null; from: string; to: string })
  | (Base & { type: "call.answered"; legId: string; state: LegState | null })
  | (Base & { type: "call.keypress"; legId: string; digits: string; outcome: "entered" | "timeout" | "hangup"; state: LegState | null })
  | (Base & { type: "call.speech_done"; legId: string; state: LegState | null })
  | (Base & {
      type: "call.ended";
      legId: string;
      cause: "no_answer" | "busy" | "rejected" | "caller_cancel" | "normal" | "other";
      state: LegState | null;
    })
  | (Base & { type: "call.recording_ready"; sessionId: string | null; legId: string | null; url: string })
  | (Base & { type: "sms.received"; providerId: string; from: string; to: string; text: string })
  | (Base & { type: "sms.status"; providerId: string; status: "sent" | "delivered" | "failed"; error: string | null })
  | (Base & { type: "ignored"; reason: string });

export interface CommandOpts {
  /** Lets the provider drop a repeated command (e.g. after a webhook retry). */
  commandId?: string;
  state?: LegState;
}

export interface AvailableNumber {
  phoneNumber: string;
  locality: string | null;
  region: string | null;
}

export interface Provider {
  readonly name: string;

  /** True if the request really came from the provider. Must see the raw body. */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean;
  parseWebhook(rawBody: string): ProviderEvent;

  // --- voice ---
  /** Place an outbound call (we use it to ring the owner). Returns the new leg id. */
  dial(args: { to: string; from: string; timeoutSecs: number } & CommandOpts): Promise<{ legId: string }>;
  answer(legId: string, opts?: CommandOpts): Promise<void>;
  bridge(legId: string, otherLegId: string, opts?: CommandOpts): Promise<void>;
  speak(legId: string, text: string, opts?: CommandOpts): Promise<void>;
  /** Speak a prompt and collect one keypress. Result arrives as call.keypress. */
  askForKey(legId: string, prompt: string, timeoutMs: number, opts?: CommandOpts): Promise<void>;
  record(legId: string, maxSeconds: number, opts?: CommandOpts): Promise<void>;
  hangup(legId: string, opts?: CommandOpts): Promise<void>;
  downloadRecording(url: string): Promise<{ audio: Buffer; mimeType: string }>;

  // --- messaging ---
  /** messagingProfileId: the tenant's own profile (10DLC is registered per business); falls back to the platform default. */
  sendSms(args: { from: string; to: string; text: string; messagingProfileId?: string | null }): Promise<{ providerId: string; status: string }>;

  // --- numbers ---
  searchNumbers(areaCode: string): Promise<AvailableNumber[]>;
  buyNumber(phoneNumber: string, opts?: { messagingProfileId?: string | null }): Promise<void>;
}

/** Thrown for provider API errors; `gone` = the call already ended. */
export class ProviderError extends Error {
  constructor(message: string, readonly status: number, readonly gone = false) {
    super(message);
  }
}
