import { describe, it, expect } from "vitest";
import { onDutyDoctors, weekdayIn } from "../../../src/core/lib/roster.js";
import type { Roster } from "../../../src/config/schema.js";

const roster: Roster = {
  settings: { visit_block_minutes: 60, travel_buffer_minutes: 30, earliest_start: "09:00", latest_start: "20:00", coverage_postal_prefixes: ["01"] },
  doctors: [
    { id: "a", name: "A", plato_calendar_id: "x", whatsapp: "+6590000001", duty_days: ["mon", "tue"] },
    { id: "b", name: "B", plato_calendar_id: "y", whatsapp: "+6590000002", duty_days: ["tue", "wed"] },
  ],
};

describe("weekdayIn", () => {
  it("uses the clinic timezone, not UTC", () => {
    // 2026-09-14T22:00Z is Monday 22:00 UTC = Tuesday 06:00 in Singapore
    expect(weekdayIn(new Date("2026-09-14T22:00:00Z"), "Asia/Singapore")).toBe("tue");
    expect(weekdayIn(new Date("2026-09-14T22:00:00Z"), "UTC")).toBe("mon");
  });
});

describe("onDutyDoctors", () => {
  it("returns doctors rostered for that local weekday", () => {
    const tue = new Date("2026-09-15T04:00:00Z"); // Tue 12:00 SGT
    expect(onDutyDoctors(roster, tue, "Asia/Singapore").map(d => d.id)).toEqual(["a", "b"]);
    const wed = new Date("2026-09-16T04:00:00Z");
    expect(onDutyDoctors(roster, wed, "Asia/Singapore").map(d => d.id)).toEqual(["b"]);
  });
  it("falls back to all doctors when nobody is rostered", () => {
    const sun = new Date("2026-09-20T04:00:00Z");
    expect(onDutyDoctors(roster, sun, "Asia/Singapore").map(d => d.id)).toEqual(["a", "b"]);
  });
});
