// src/core/lib/codes.ts
// Patient codes: 3 characters. No vowels or Y (no English word can be mistaken for a code),
// no I/L/O/0/1 (ambiguous when read aloud or typed on a phone).
export const CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXZ23456789";
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{3}$`);

export function generateCode(rng: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < 3; i++) s += CODE_ALPHABET[Math.min(CODE_ALPHABET.length - 1, Math.floor(rng() * CODE_ALPHABET.length))];
  return s;
}

export function looksLikeCode(token: string): boolean {
  return CODE_RE.test(token.toUpperCase());
}
