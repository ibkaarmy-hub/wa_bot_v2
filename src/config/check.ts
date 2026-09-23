// src/config/check.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./load.js";
const dir = process.env.CONFIG_DIR ?? "./config";

let rosterFile = process.env.ROSTER_FILE;
let note = "";
if (!rosterFile && !existsSync(join(dir, "roster.yaml"))) {
  rosterFile = join(dir, "roster.example.yaml");
  note = " (roster.yaml not found locally; checked roster.example.yaml instead)";
}

try {
  const cfg = loadConfig(dir, { rosterFile });
  console.log(`OK: ${cfg.roster.doctors.length} doctor(s), ${cfg.faq.length} FAQ entries, booking_mode=${cfg.settings.booking_mode}${note}`);
} catch (e) {
  console.error(`CONFIG ERROR — ${(e as Error).message}`);
  process.exit(1);
}
