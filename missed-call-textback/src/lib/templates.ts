// Message templates. Owners edit textBack/afterHours in Settings; the
// rest are fixed for now. {placeholders} the owner can use are listed
// in the Settings page.

export const DEFAULT_TEXT_BACK =
  "Hi, this is {business}. Sorry we missed your call — we're out on a job. What can we help you with? Reply here and we'll get right back to you. Reply STOP to opt out.";

export const DEFAULT_AFTER_HOURS =
  "Hi, this is {business}. Thanks for calling! We're closed right now, but reply with what you need and we'll get back to you first thing. If it's an emergency, say so and we'll do our best. Reply STOP to opt out.";

export const QUALIFY_ASK_ADDRESS = "Thanks! What's the address or ZIP code for the job?";
export const QUALIFY_ASK_URGENT = "Got it. Is this an emergency (active leak, no heat/AC, no power, etc.)? Reply YES or NO.";
export const QUALIFY_DONE = "Thanks — {owner} will reach out shortly.";
export const QUALIFY_DONE_URGENT = "Thanks — we've flagged this as urgent and {owner} will call you as soon as possible.";

export const FOLLOW_UP =
  "Hi, it's {business} again. Still need a hand? Reply here or call us back at {number} and we'll get you scheduled.";

export const APPOINTMENT_REMINDER =
  "Reminder: {business} is scheduled for {when}. Reply here or call {number} if you need to reschedule.";

export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => vars[key] ?? whole);
}
