// Phone number normalisation. Everything is stored and compared as E.164
// so "(555) 010-2000", "555-010-2000" and "+15550102000" are the same lead.
// US/Canada assumed for bare 10-digit input — that's the market this ships to.

export function toE164(input: string): string | null {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Display form for the dashboard and owner alerts: +15550102000 → (555) 010-2000 */
export function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
