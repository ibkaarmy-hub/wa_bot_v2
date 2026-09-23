import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/load.js";
import { parseFaqMarkdown } from "../../src/config/faq.js";

function copyConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "hc-config-"));
  cpSync("test/fixtures/config", dir, { recursive: true });
  return dir;
}

describe("loadConfig", () => {
  it("the shipped clinic config is valid", () => {
    // config/roster.yaml holds the real, gitignored roster; tests must not depend on it.
    expect(() => loadConfig("config", { rosterFile: "config/roster.example.yaml" })).not.toThrow();
  });

  it("reports a helpful error when the roster file is missing", () => {
    const dir = copyConfig();
    rmSync(join(dir, "roster.yaml"));
    expect(() => loadConfig(dir)).toThrow(/roster\.yaml.*looked for .*roster\.yaml.*roster\.example\.yaml.*Secret File/is);
  });

  it("loads the fixture config", () => {
    const cfg = loadConfig("test/fixtures/config");
    expect(cfg.settings.clinic_name).toBe("Urgent Care At Home");
    expect(cfg.messages.menu).toContain("{clinic_name}");
    expect(cfg.faq.map(f => f.id)).toEqual(["hours", "areas", "fees", "payment", "prepare"]);
    expect(cfg.roster.doctors[0].whatsapp).toBe("+6590000001");
  });
  it("reports the file and problem for an invalid setting", () => {
    const dir = copyConfig();
    writeFileSync(join(dir, "settings.yaml"), "clinic_name: X\nbooking_mode: sometimes\n");
    expect(() => loadConfig(dir)).toThrow(/settings\.yaml.*booking_mode/s);
  });
  it("rejects an invalid IANA timezone", () => {
    const dir = copyConfig();
    const settings = readFileSync(join(dir, "settings.yaml"), "utf8").replace(/^timezone:.*$/m, "timezone: Asia/Singapre");
    writeFileSync(join(dir, "settings.yaml"), settings);
    expect(() => loadConfig(dir)).toThrow(/settings\.yaml.*timezone/s);
  });

  it("rejects a roster with a non-E.164 number", () => {
    const dir = copyConfig();
    writeFileSync(join(dir, "roster.yaml"), `settings: {visit_block_minutes: 60, travel_buffer_minutes: 30, earliest_start: "09:00", latest_start: "20:00", coverage_postal_prefixes: ["01"]}
doctors: [{id: a, name: A, plato_calendar_id: X, whatsapp: "90000001", duty_days: [mon]}]`);
    expect(() => loadConfig(dir)).toThrow(/roster\.yaml.*whatsapp/s);
  });
  it("rejects duplicate doctor ids", () => {
    const dir = copyConfig();
    writeFileSync(join(dir, "roster.yaml"), `settings: {visit_block_minutes: 60, travel_buffer_minutes: 30, earliest_start: "09:00", latest_start: "20:00", coverage_postal_prefixes: ["01"]}
doctors:
  - {id: a, name: A, plato_calendar_id: X, whatsapp: "+6590000001", duty_days: [mon]}
  - {id: a, name: B, plato_calendar_id: Y, whatsapp: "+6590000002", duty_days: [tue]}`);
    expect(() => loadConfig(dir)).toThrow(/duplicate doctor id "a"/);
  });
  it("rejects a message with an unknown placeholder", () => {
    const dir = copyConfig();
    const messages = readFileSync(join(dir, "messages.yaml"), "utf8").replace("{clinic_name}", "{clinic_nam}");
    writeFileSync(join(dir, "messages.yaml"), messages);
    expect(() => loadConfig(dir)).toThrow(/messages\.yaml.*unknown placeholder "clinic_nam"/s);
  });
  it("allows relay placeholders only in relay messages", () => {
    const dir = copyConfig();
    const messages = readFileSync(join(dir, "messages.yaml"), "utf8").replace(/^handoff: \|\n  .*$/m, "handoff: \"Passed to Dr {doctor_name}\"");
    writeFileSync(join(dir, "messages.yaml"), messages);
    expect(() => loadConfig(dir)).toThrow(/messages\.yaml.*handoff: unknown placeholder "doctor_name"/s);
    const cfg = loadConfig("test/fixtures/config");
    expect(cfg.messages.doctor_took).toContain("{code}");
  });
  it("loads relay settings with defaults", () => {
    const cfg = loadConfig("test/fixtures/config");
    expect(cfg.settings.handoff_realert_minutes).toBe(5);
    expect(cfg.settings.relay_tick_seconds).toBe(30);
    expect(cfg.roster.doctors.map(d => d.id)).toEqual(["dr_example_a", "dr_example_b"]);
  });
});

describe("parseFaqMarkdown", () => {
  it("splits headings into entries and strips the Q line", () => {
    const entries = parseFaqMarkdown(`## hours\n**Q:** When?\nDaily 9-9.\n\n## fees\n**Q:** Cost?\nFrom $180.\n`);
    expect(entries).toEqual([
      { id: "hours", question: "When?", answer: "Daily 9-9." },
      { id: "fees", question: "Cost?", answer: "From $180." },
    ]);
  });
  it("rejects duplicate ids", () => {
    expect(() => parseFaqMarkdown(`## a\n**Q:** x\ny\n## a\n**Q:** x\ny`)).toThrow(/duplicate faq id "a"/);
  });
});
