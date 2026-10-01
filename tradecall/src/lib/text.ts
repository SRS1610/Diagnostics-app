// Customer-facing copy. Owners edit the two missed-call texts in Settings;
// {business} {owner} {number} are filled in at send time.

export const DEFAULT_MISSED_TEXT =
  "Hi, it's {business}. Sorry we missed your call — we're out on a job right now. What can we help you with? Reply here and we'll get right back to you. Reply STOP to opt out.";
export const DEFAULT_AFTER_HOURS_TEXT =
  "Hi, it's {business}. Thanks for calling — we're closed right now, but reply with what you need and we'll get back to you first thing. If it's an emergency, tell us. Reply STOP to opt out.";

export const ASK_ADDRESS = "Thanks! What's the address or ZIP code for the job?";
export const ASK_EMERGENCY = "Got it. Is this an emergency (active leak, no heat or AC, no power)? Reply YES or NO.";
export const INTAKE_DONE = "Thanks — {owner} will get back to you shortly.";
export const INTAKE_DONE_URGENT = "Thanks — we've marked this urgent and {owner} will call you as soon as possible.";
export const NUDGE = "Hi, it's {business} again. Still need a hand? Reply here or call {number} and we'll get you on the schedule.";
export const REMINDER = "Reminder: {business} is booked for {when}. Reply here or call {number} if you need to change it.";

export const VOICE_GREETING =
  "Thanks for calling {business}. Sorry we couldn't pick up — we've just sent you a text so we can help you right away.";
export const VOICE_LEAVE_MESSAGE = " You can also leave a message after the beep.";
export const VOICE_SELF_TEST = "This is your TradeCall line for {business}. It's set up correctly. Goodbye.";
export const VOICE_SCREEN = "Customer call from {caller}. Press 1 to take it.";

export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (all, k: string) => vars[k] ?? all);
}
