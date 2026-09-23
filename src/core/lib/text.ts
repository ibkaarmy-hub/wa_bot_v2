// src/core/lib/text.ts
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = vars[key];
    if (v === undefined) throw new Error(`missing variable "${key}" for template: ${template}`);
    return v;
  });
}
