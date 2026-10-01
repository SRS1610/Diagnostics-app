// Timezone-aware helpers built on Intl only — no tz library. Every rule
// here (business hours, quiet hours, digest day) is in the BUSINESS's
// local time, never the server's.

export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
export const WEEKDAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export type DayHours = { open: string; close: string } | null;
export type BusinessHours = Partial<Record<Weekday, DayHours>>;

export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  mon: { open: "07:00", close: "18:00" },
  tue: { open: "07:00", close: "18:00" },
  wed: { open: "07:00", close: "18:00" },
  thu: { open: "07:00", close: "18:00" },
  fri: { open: "07:00", close: "18:00" },
  sat: { open: "08:00", close: "14:00" },
  sun: null,
};

export interface LocalParts {
  weekday: Weekday;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function localParts(date: Date, timeZone: string): LocalParts {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
    formatters.set(timeZone, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    weekday: parts.weekday.toLowerCase().slice(0, 3) as Weekday,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function isWithinBusinessHours(date: Date, timeZone: string, hours: BusinessHours): boolean {
  const p = localParts(date, timeZone);
  const today = hours[p.weekday];
  if (!today) return false;
  const now = p.hour * 60 + p.minute;
  return now >= toMinutes(today.open) && now < toMinutes(today.close);
}

// Automated (non-reply) texts only go out 8:00–20:59 local time. The
// instant text-back is exempt: it answers a call the person just made.
export const QUIET_START_HOUR = 21;
export const QUIET_END_HOUR = 8;

export function isQuietHours(date: Date, timeZone: string): boolean {
  const { hour } = localParts(date, timeZone);
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

const STEP_MS = 15 * 60 * 1000;

/**
 * Move a send time out of quiet hours in 15-minute steps. "later" is for
 * follow-ups (send next morning); "earlier" is for appointment reminders,
 * which are useless if they arrive after the appointment.
 */
export function shiftOutOfQuietHours(date: Date, timeZone: string, direction: "later" | "earlier"): Date {
  let t = date.getTime();
  // 13h of quiet hours max, so 60 steps always gets out.
  for (let i = 0; i < 60 && isQuietHours(new Date(t), timeZone); i++) {
    t += direction === "later" ? STEP_MS : -STEP_MS;
  }
  return new Date(t);
}

export function formatLocal(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
