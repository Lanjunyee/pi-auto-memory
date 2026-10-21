export const CHECK_MAX_BYTES = 1024 * 1024;
export const CHECK_MAX_LINES = 10_000;
export const CHECK_MAX_LINKS = 1_000;

export interface IndexLink {
  line: number;
  column: number;
  start: number;
  end: number;
  target: string;
}

export interface IndexLinkAnalysis {
  links: IndexLink[];
  unsupported: { line: number; reason: "reference-style" | "image" | "html" | "nested" | "multiline" }[];
  truncated: boolean;
  lines: number;
  bytes: number;
}

function codeMask(lines: string[]): boolean[] {
  const masked = new Array<boolean>(lines.length).fill(false);
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const match = /^\s*(`{3,}|~{3,})/.exec(lines[index]);
    if (fence) {
      masked[index] = true;
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (match) { fence = match[1]; masked[index] = true; continue; }
  }
  return masked;
}

function stripInlineCode(line: string): string {
  return line.replace(/(`+)(?:(?!\1).)*?\1/g, (text) => " ".repeat(text.length));
}

export function analyzeIndexLinks(text: string): IndexLinkAnalysis {
  const bytes = Buffer.byteLength(text, "utf8");
  const allLines = text.split("\n");
  const analysis: IndexLinkAnalysis = { links: [], unsupported: [], truncated: false, lines: allLines.length, bytes };
  const lines = analysis.lines > CHECK_MAX_LINES ? allLines.slice(0, CHECK_MAX_LINES) : allLines;
  analysis.truncated = bytes > CHECK_MAX_BYTES || analysis.lines > CHECK_MAX_LINES;
  const fenced = codeMask(lines);
  let consumed = 0;
  let lineEnd = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineStart = lineEnd;
    lineEnd += line.length + 1;
    consumed += Buffer.byteLength(line, "utf8") + 1;
    if (consumed > CHECK_MAX_BYTES) { analysis.truncated = true; break; }
    if (fenced[index]) continue;
    const visible = stripInlineCode(line);
    if (/^\s*(?:[-*+]\s+)?\[[^\]]+\]:\s*\S/.test(visible)) { analysis.unsupported.push({ line: index + 1, reason: "reference-style" }); continue; }
    if (/!\[[^\]]*\]\([^)]*\)/.test(visible)) { analysis.unsupported.push({ line: index + 1, reason: "image" }); continue; }
    if (/<a\s[^>]*href=/i.test(visible)) analysis.unsupported.push({ line: index + 1, reason: "html" });
    if (/\[[^\]]*\]\([^)]*\([^)]*\)[^)]*\)/.test(visible)) analysis.unsupported.push({ line: index + 1, reason: "nested" });
    const pattern = /\[([^\]]*)\]\(\s*(<[^>\n]+>|[^)\s]+)\s*\)/g;
    for (const match of visible.matchAll(pattern)) {
      if (analysis.links.length >= CHECK_MAX_LINKS) { analysis.truncated = true; break; }
      const raw = match[2].trim();
      const start = lineStart + match.index;
      analysis.links.push({
        line: index + 1,
        column: [...line.slice(0, match.index)].length + 1,
        start,
        end: start + match[0].length,
        target: raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw,
      });
    }
    if (analysis.truncated && analysis.links.length >= CHECK_MAX_LINKS) break;
  }
  return analysis;
}

export function classifyTarget(target: string): { kind: "local" | "external" | "unsafe" | "unsupported" } {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) return /^(https?|mailto):/i.test(target) ? { kind: "external" } : { kind: "unsupported" };
  if (target.startsWith("//")) return { kind: "external" };
  if (target.startsWith("#")) return { kind: "unsupported" };
  const path = target.split("#")[0].split("?")[0];
  if (!path) return { kind: "unsupported" };
  if (path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(path)) return { kind: "unsafe" };
  const segments = path.split(/[\\/]/);
  if (segments.includes("..")) return { kind: "unsafe" };
  if (!path.toLowerCase().endsWith(".md")) return { kind: "unsupported" };
  return { kind: "local" };
}

export function normalizedTarget(target: string): string {
  const path = target.split("#")[0].split("?")[0].replace(/\\/g, "/");
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    segments.push(segment);
  }
  return segments.join("/");
}

export function loadedLineLimit(text: string, maxLines: number, maxBytes: number): { lines: number; bytes: number; truncated: boolean } {
  let bytes = 0;
  let lines = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes || lines >= maxLines) break;
    bytes += size;
    if (char === "\n") lines++;
  }
  return { lines, bytes, truncated: bytes < Buffer.byteLength(text, "utf8") || lines >= maxLines };
}
