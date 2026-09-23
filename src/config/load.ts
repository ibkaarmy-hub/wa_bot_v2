// src/config/load.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z, type ZodTypeAny } from "zod";
import type { FaqEntry } from "../core/ports.js";
import { parseFaqMarkdown } from "./faq.js";
import { MESSAGE_PLACEHOLDERS, MESSAGE_PLACEHOLDERS_BY_KEY, MessagesSchema, RosterSchema, SettingsSchema, type Messages, type Roster, type Settings } from "./schema.js";

export interface AppConfig { settings: Settings; messages: Messages; faq: FaqEntry[]; roster: Roster; }

export class ConfigError extends Error {
  constructor(public file: string, message: string) { super(`${file}: ${message}`); }
}

function loadYaml<S extends ZodTypeAny>(dir: string, file: string, schema: S): z.infer<S> {
  const path = join(dir, file);
  let raw: unknown;
  try { raw = parseYaml(readFileSync(path, "utf8")); }
  catch (e) { throw new ConfigError(file, `cannot read or parse: ${(e as Error).message}`); }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new ConfigError(file, issues);
  }
  return result.data;
}

// roster.yaml is not committed (config/roster.yaml is gitignored; the real file
// is a Render Secret File in production). Its path can differ from the other
// config files, but errors always name it "roster.yaml".
function loadRoster(path: string): Roster {
  let raw: unknown;
  try { raw = parseYaml(readFileSync(path, "utf8")); }
  catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new ConfigError("roster.yaml", `not found (looked for ${path}) — copy config/roster.example.yaml to config/roster.yaml for local runs, or upload the real file to Render as a Secret File named "roster.yaml"`);
    }
    throw new ConfigError("roster.yaml", `cannot read or parse: ${(e as Error).message}`);
  }
  const result = RosterSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new ConfigError("roster.yaml", issues);
  }
  return result.data;
}

export function loadConfig(dir: string, opts: { rosterFile?: string } = {}): AppConfig {
  const settings = loadYaml(dir, "settings.yaml", SettingsSchema);
  const messages = loadYaml(dir, "messages.yaml", MessagesSchema);
  for (const [key, text] of Object.entries(messages)) {
    const allowed = MESSAGE_PLACEHOLDERS_BY_KEY[key] ?? MESSAGE_PLACEHOLDERS;
    for (const m of text.matchAll(/\{(\w+)\}/g)) {
      if (!allowed.has(m[1])) throw new ConfigError("messages.yaml", `${key}: unknown placeholder "${m[1]}"`);
    }
  }
  const roster = loadRoster(opts.rosterFile ?? join(dir, "roster.yaml"));
  const ids = new Set<string>();
  for (const d of roster.doctors) {
    if (ids.has(d.id)) throw new ConfigError("roster.yaml", `duplicate doctor id "${d.id}"`);
    ids.add(d.id);
  }
  let faq: FaqEntry[];
  try { faq = parseFaqMarkdown(readFileSync(join(dir, "faq.md"), "utf8")); }
  catch (e) { throw new ConfigError("faq.md", (e as Error).message.replace(/^faq\.md: /, "")); }
  return { settings, messages, faq, roster };
}
