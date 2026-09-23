// src/config/schema.ts
import { z } from "zod";

const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, "must be E.164, e.g. +6591234567");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM");
export const Weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type Weekday = z.infer<typeof Weekday>;

export const SettingsSchema = z.object({
  clinic_name: z.string().min(1),
  booking_mode: z.enum(["review", "auto"]),
  timezone: z.string().default("Asia/Singapore").refine(tz => {
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
  }, "must be a valid IANA timezone, e.g. Asia/Singapore"),
  human_idle_hours: z.number().positive().default(12),
  close_after_hours: z.number().positive().default(72),
  approval_timeout_minutes: z.number().positive().default(15),
  handoff_realert_minutes: z.number().positive().default(5),
  relay_tick_seconds: z.number().positive().default(30),
  plato_poll_minutes: z.number().positive().default(10),
  address_retention_days: z.number().positive().default(30),
  history_turns_for_llm: z.number().int().positive().default(6),
  urgent_triggers: z.array(z.string().min(1)).min(1),
  templates: z.object({
    doctor_alert: z.string().min(1),
    reminder: z.string().min(1),
    doctor_will_call: z.string().min(1),
    visit_changed: z.string().min(1),
  }),
  meta: z.object({ echo_field: z.string().min(1).default("smb_message_echoes") }).default({}),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const MessagesSchema = z.object({
  menu: z.string().min(1),
  emergency: z.string().min(1),
  handoff: z.string().min(1),
  booking_handoff: z.string().min(1),
  faq_intro: z.string(),
  // Doctor relay — patient-facing
  doctor_joined: z.string(),            // blank = no notice
  bot_resumed: z.string(),              // blank = no notice
  handoff_unclaimed: z.string().min(1),
  // Doctor relay — doctor-facing
  doctor_took: z.string().min(1),
  doctor_released: z.string().min(1),
  doctor_unknown_code: z.string().min(1),
  doctor_not_pending: z.string().min(1),
  doctor_not_taken: z.string().min(1),
  doctor_taken_by_other: z.string().min(1),
  doctor_no_active: z.string().min(1),
  doctor_relayed_to: z.string(),        // blank = no confirmation
  doctor_list_header: z.string().min(1),
  doctor_list_empty: z.string().min(1),
  doctor_help: z.string().min(1),
  doctor_call_unavailable: z.string().min(1),
  doctor_window_closed: z.string().min(1),
});
export type Messages = z.infer<typeof MessagesSchema>;

// Placeholders the engine supplies to every message.
export const MESSAGE_PLACEHOLDERS = new Set(["clinic_name"]);
// Placeholders only the doctor relay supplies; valid only in the relay keys below.
export const RELAY_PLACEHOLDERS = new Set(["clinic_name", "doctor_name", "code", "patient_phone"]);
const RELAY_KEYS = [
  "doctor_joined", "bot_resumed", "handoff_unclaimed", "doctor_took", "doctor_released", "doctor_unknown_code",
  "doctor_not_pending", "doctor_not_taken", "doctor_taken_by_other", "doctor_no_active", "doctor_relayed_to",
  "doctor_list_header", "doctor_list_empty", "doctor_help", "doctor_call_unavailable", "doctor_window_closed",
] as const;
export const MESSAGE_PLACEHOLDERS_BY_KEY: Record<string, Set<string>> = Object.fromEntries(RELAY_KEYS.map(k => [k, RELAY_PLACEHOLDERS]));

export const RosterSchema = z.object({
  settings: z.object({
    visit_block_minutes: z.number().int().positive(),
    travel_buffer_minutes: z.number().int().nonnegative(),
    earliest_start: hhmm,
    latest_start: hhmm,
    coverage_postal_prefixes: z.array(z.string().regex(/^\d{2}$/)).min(1),
  }),
  doctors: z.array(z.object({
    id: z.string().regex(/^[a-z0-9_]+$/),
    name: z.string().min(1),
    plato_calendar_id: z.string().min(1),
    whatsapp: e164,
    duty_days: z.array(Weekday).min(1),
  })).min(1),
});
export type Roster = z.infer<typeof RosterSchema>;
