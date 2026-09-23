// src/config/faq.ts
import type { FaqEntry } from "../core/ports.js";

export function parseFaqMarkdown(md: string): FaqEntry[] {
  const entries: FaqEntry[] = [];
  const seen = new Set<string>();
  const sections = md.split(/^## +/m).slice(1);
  for (const section of sections) {
    const [idLine, ...rest] = section.split("\n");
    const id = idLine.trim();
    if (!/^[a-z0-9_-]+$/.test(id)) throw new Error(`faq.md: heading "${id}" must be a lowercase id`);
    if (seen.has(id)) throw new Error(`faq.md: duplicate faq id "${id}"`);
    seen.add(id);
    const lines = rest.map(l => l.trimEnd()).filter((l, i, arr) => !(l === "" && (i === 0 || i === arr.length - 1)));
    const qIdx = lines.findIndex(l => l.startsWith("**Q:**"));
    if (qIdx === -1) throw new Error(`faq.md: section "${id}" needs a "**Q:** ..." line`);
    const question = lines[qIdx].replace("**Q:**", "").trim();
    const answer = lines.filter((_, i) => i !== qIdx).join("\n").trim();
    if (!answer) throw new Error(`faq.md: section "${id}" has no answer`);
    entries.push({ id, question, answer });
  }
  if (entries.length === 0) throw new Error("faq.md: no entries found");
  return entries;
}
