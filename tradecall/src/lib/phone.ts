// Numbers are stored as E.164 everywhere so the same person always matches
// the same lead. Bare 10-digit input is assumed US/Canada.

export function toE164(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim();
  const d = s.replace(/\D/g, "");
  if (s.startsWith("+")) return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

export function prettyPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/** "5 1 2, 5 5 5, 9 0 0 1" — how text-to-speech should read a number. */
export function spokenPhone(e164: string): string {
  const d = e164.replace(/\D/g, "").slice(-10);
  return [d.slice(0, 3), d.slice(3, 6), d.slice(6)].map((g) => g.split("").join(" ")).join(", ");
}
