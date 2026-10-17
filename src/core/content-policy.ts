import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isMap, parseDocument, type Document } from "yaml";
import { INDEX_MAX_BYTES, INDEX_MAX_LINES, INDEX_WARNING_RATIO } from "./constants.js";

export function lineCount(text: string): number {
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export function indexPrefix(text: string) {
  const bytes = Buffer.byteLength(text, "utf8");
  const lines = lineCount(text);
  let prefix = "";
  let usedBytes = 0;
  let newlines = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (usedBytes + size > INDEX_MAX_BYTES || newlines >= INDEX_MAX_LINES) break;
    prefix += char;
    usedBytes += size;
    if (char === "\n") newlines++;
  }
  const overLimit = lines > INDEX_MAX_LINES || bytes > INDEX_MAX_BYTES;
  return {
    prefix, bytes, lines, truncated: prefix !== text, overLimit,
    nearLimit: lines >= INDEX_MAX_LINES * INDEX_WARNING_RATIO || bytes >= INDEX_MAX_BYTES * INDEX_WARNING_RATIO,
  };
}

const TOKEN_RULES: [string, RegExp][] = [
  ["private-key", /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["provider-token", /\bsk-(?:ant-api\d+-|proj-)?[A-Za-z0-9_-]{24,}\b/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
];

export function assertNoSecrets(text: string): void {
  for (const [category, pattern] of TOKEN_RULES) {
    if (pattern.test(text)) throw new Error(`Memory save rejected: detected ${category}; remove sensitive data or use a secret-free reference.`);
  }
  const assignments = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|secret[_-]?key|bearer|token)\b["']?\s*[:=]\s*["']?([A-Za-z0-9_+\/.=-]{16,})/gi;
  for (const match of text.matchAll(assignments)) {
    const value = match[1];
    if (/[a-z]/i.test(value) && /[0-9]/.test(value) && new Set(value).size >= 8) {
      throw new Error("Memory save rejected: detected credential-assignment; remove sensitive data or use a secret-free reference.");
    }
  }
}

export function prepareContent(text: string, now = new Date()): string {
  assertNoSecrets(text);
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const plain = text.slice(bom.length);
  const opening = /^---[ \t]*(\r?\n)/.exec(plain);
  if (!opening) return text;
  const ending = opening[1];
  const rest = plain.slice(opening[0].length);
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!closing) throw new Error("Memory save rejected: malformed YAML frontmatter; repair metadata before retrying.");
  let yamlText: string;
  try {
    const doc: Document = parseDocument(rest.slice(0, closing.index), { uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) throw new Error("Unsafe YAML document");
    const before = doc.toJS({ mapAsMap: true, maxAliasCount: 100 }) as Map<unknown, unknown>;
    const timestamp = now.toISOString();
    doc.set("modified", doc.createNode(timestamp));
    const serialize = () => {
      const serialized = doc.toString();
      const check = parseDocument(serialized, { uniqueKeys: true });
      if (check.errors.length || check.warnings.length) throw new Error("Unsafe serialized metadata");
      const after = check.toJS({ mapAsMap: true, maxAliasCount: 100 });
      const otherFields = (map: Map<unknown, unknown>) => [...map].filter(([key]) => key !== "modified");
      if (!(after instanceof Map) || after.get("modified") !== timestamp
        || !isDeepStrictEqual(otherFields(before), otherFields(after))) throw new Error("Metadata semantics changed");
      return serialized;
    };
    try { yamlText = serialize(); }
    catch {
      const updated = new Map(before);
      updated.set("modified", timestamp);
      doc.contents = doc.createNode(updated);
      yamlText = serialize();
    }
    yamlText = yamlText.replace(/\n/g, ending);
  } catch { throw new Error("Memory save rejected: malformed or unsupported YAML frontmatter; repair metadata before retrying."); }
  const result = bom + opening[0] + yamlText + closing[0] + rest.slice(closing.index + closing[0].length);
  assertNoSecrets(result);
  return result;
}

export function savedResult(path: string, text: string) {
  const limit = basename(path) === "MEMORY.md" ? indexPrefix(text) : undefined;
  const note = limit?.overLimit
    ? "Saved successfully, but MEMORY.md exceeds 200 lines or 25KiB. The file IS SAVED; simplify the index and retry after reading it."
    : limit?.nearLimit
      ? "Saved successfully. MEMORY.md is near its 200-line/25KiB limit; simplify the index."
      : "Saved successfully.";
  return { saved: true as const, isError: limit?.overLimit ?? false, note };
}
