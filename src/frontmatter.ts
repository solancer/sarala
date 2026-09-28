import { load, JSON_SCHEMA } from "js-yaml";

/** Parse metadata as YAML data; executable/custom tags are never accepted. */
export function parseYamlMetadata(text: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|$)/.exec(text);
  if (!match) return {};
  try {
    const value = load(match[1], { schema: JSON_SCHEMA });
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

/** String-valued options consumed by path/export helpers. Nested data stays in parseYamlMetadata. */
export function parseFrontMatter(text: string): Record<string, string> {
  return Object.fromEntries(Object.entries(parseYamlMetadata(text)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
