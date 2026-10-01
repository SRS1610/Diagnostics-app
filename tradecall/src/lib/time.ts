// Every time rule (open hours, quiet hours, Monday digest) is evaluated in
// the BUSINESS's timezone using Intl — never the server's.

export type Day = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
export const DAYS: Day[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export type Hours = Partial<Record<Day, { open: string; close: string } | null>>;

export const DEFAULT_HOURS: Hours = {
  mon: { open: "07:00", close: "18:00" },
  tue: { open: "07:00", close: "18:00" },
  wed: { open: "07:00", close: "18:00" },
  thu: { open: "07:00", close: "18:00" },
  fri: { open: "07:00", close: "18:00" },
  sat: { open: "08:00", close: "14:00" },
  sun: null,
};

export interface Local {
  day: Day;
  ymd: string; // 2026-09-30
  hour: number;
  minute: number;
}

const cache = new Map<string, Intl.DateTimeFormat>();

export function local(date: Date, tz: string): Local {
  let f = cache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    cache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: p.weekday.toLowerCase().slice(0, 3) as Day, ymd: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function isOpen(date: Date, tz: string, hours: Hours): boolean {
  const l = local(date, tz);
  const today = hours[l.day];
  if (!today) return false;
  const now = l.hour * 60 + l.minute;
  return now >= mins(today.open) && now < mins(today.close);
}

/** Automated texts (nudges, reminders) only go out 8:00am–8:59pm local. */
export function isQuiet(date: Date, tz: string): boolean {
  const { hour } = local(date, tz);
  return hour >= 21 || hour < 8;
}

/** Step in 15-minute increments until out of quiet hours. */
export function outOfQuiet(date: Date, tz: string, direction: "later" | "earlier"): Date {
  const step = (direction === "later" ? 1 : -1) * 15 * 60_000;
  let t = date.getTime();
  for (let i = 0; i < 60 && isQuiet(new Date(t), tz); i++) t += step;
  return new Date(t);
}

export function friendly(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}
