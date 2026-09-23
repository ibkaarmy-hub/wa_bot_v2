import type { Roster, Weekday } from "../../config/schema.js";

const MAP: Record<string, Weekday> = { Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun" };

export function weekdayIn(now: Date, timezone: string): Weekday {
  const short = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: timezone }).format(now);
  return MAP[short];
}

/** Doctors rostered for the local weekday. If none, every doctor (so alerts always reach someone). */
export function onDutyDoctors(roster: Roster, now: Date, timezone: string): Roster["doctors"] {
  const day = weekdayIn(now, timezone);
  const on = roster.doctors.filter(d => d.duty_days.includes(day));
  return on.length > 0 ? on : roster.doctors;
}
