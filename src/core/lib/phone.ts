// src/core/lib/phone.ts
/** Meta delivers bare digits; the app uses E.164 with a leading "+" everywhere. */
export function normalisePhone(raw: string): string {
  return `+${raw.replace(/[^\d]/g, "")}`;
}
