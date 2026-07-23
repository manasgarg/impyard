import { parse, stringify } from "yaml";
import { invalid } from "./errors.js";

export interface ParsedMarkdown {
  metadata: Record<string, unknown>;
  body: string;
}

export function parseMarkdown(content: string, source = "note"): ParsedMarkdown {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    throw invalid(`${source} does not start with YAML frontmatter`);
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
  if (!match) throw invalid(`${source} has unterminated YAML frontmatter`);
  const value = parse(match[1] ?? "");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${source} frontmatter must be a YAML mapping`);
  }
  return { metadata: value as Record<string, unknown>, body: match[2] ?? "" };
}

export function serializeMarkdown(metadata: Record<string, unknown>, body: string): string {
  const yaml = stringify(metadata, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, "")}`;
}

export function parseMetadataFile(content: string, source: string): Record<string, unknown> {
  const value = parse(content);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${source} must contain a YAML mapping`);
  }
  return value as Record<string, unknown>;
}
