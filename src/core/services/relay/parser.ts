// src/core/services/relay/parser.ts
// Turns a doctor's WhatsApp text into a command. Pure: no I/O.
import { looksLikeCode } from "../../lib/codes.js";

export type DoctorCommand =
  | { kind: "take"; code: string }
  | { kind: "release"; code: string | null }
  | { kind: "list" } | { kind: "help" } | { kind: "call" } | { kind: "unknown" }
  | { kind: "text"; code: string | null; text: string };

export function parseDoctorCommand(raw: string): DoctorCommand {
  const text = raw.trim();
  const first = text.split(/\s+/, 1)[0] ?? "";
  const rest = text.slice(first.length).trim();
  const head = first.toLowerCase();
  if (head.startsWith("#")) {
    const arg = rest ? rest.split(/\s+/, 1)[0].toUpperCase() : null;
    switch (head) {
      case "#take": return arg ? { kind: "take", code: arg } : { kind: "unknown" };
      case "#bot": return { kind: "release", code: arg };
      case "#list": return { kind: "list" };
      case "#help": return { kind: "help" };
      case "#call": return { kind: "call" };
      default: return { kind: "unknown" };
    }
  }
  if (looksLikeCode(first) && rest.length > 0) return { kind: "text", code: first.toUpperCase(), text: rest };
  return { kind: "text", code: null, text };
}
