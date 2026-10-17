import { access, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  DEFAULT_MAX_BYTES, formatSize, truncateHead, truncateLine,
  type AgentToolResult, type FindToolDetails, type FindToolInput, type GrepToolDetails, type GrepToolInput,
} from "@earendil-works/pi-coding-agent";
import type { MemoryStore } from "../core/store.js";
import { checkScanAbort, escapeScanGlob, type ScanPolicy } from "./scan-policy.js";
import { existingBinary } from "./scan-binary.js";

interface StreamResult { lines: string[]; code: number | null; stderr: string; limited: boolean }
async function stream(binary: string, args: string[], signal: AbortSignal | undefined, onLine?: (line: string) => boolean): Promise<StreamResult> {
  checkScanAbort(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    const reader = createInterface({ input: child.stdout });
    const lines: string[] = [];
    let stderr = "";
    let limited = false;
    const abort = () => { child.kill(); };
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => { reader.close(); signal?.removeEventListener("abort", abort); };
    if (signal?.aborted) abort();
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    reader.on("line", (line) => {
      if (limited) return;
      if (onLine) {
        if (onLine(line)) { limited = true; child.kill(); }
      } else lines.push(line);
    });
    child.on("error", (error) => { cleanup(); reject(new Error(`Failed to run ${basename(binary)}: ${error.message}`)); });
    child.on("close", (code) => {
      cleanup();
      if (signal?.aborted) reject(new Error("Operation aborted"));
      else resolve({ lines, code, stderr, limited });
    });
  });
}

export async function protectedGrep(store: MemoryStore, policy: ScanPolicy, params: GrepToolInput, signal?: AbortSignal): Promise<AgentToolResult<GrepToolDetails | undefined>> {
  checkScanAbort(signal);
  if (policy.empty) return { content: [{ type: "text", text: "No matches found" }], details: undefined };
  const binary = await existingBinary("rg", store.paths.agentDir, signal);
  let directory: boolean;
  try { directory = (await stat(policy.root)).isDirectory(); }
  catch { throw new Error(`Path not found: ${policy.root}`); }
  const args = ["--json", "--line-number", "--color=never", "--hidden", "--no-follow"];
  if (params.ignoreCase) args.push("--ignore-case");
  if (params.literal) args.push("--fixed-strings");
  if (params.glob) args.push("--glob", params.glob);
  for (const path of policy.excluded) args.push("--glob", `!**${escapeScanGlob(path)}`);
  args.push("--", params.pattern, policy.root);
  const limit = Math.max(1, params.limit ?? 100);
  const matches: { file: string; line: number; text?: string }[] = [];
  let count = 0;
  store.assertLifecycle();
  const result = await stream(binary, args, signal, (line) => {
    if (!line.trim() || count >= limit) return false;
    let event;
    try { event = JSON.parse(line); } catch { return false; }
    if (event.type !== "match") return false;
    count++;
    const data = event.data;
    if (data?.path?.text && typeof data.line_number === "number") matches.push({ file: data.path.text, line: data.line_number, text: data.lines?.text });
    return count >= limit;
  });
  store.assertLifecycle();
  if (!result.limited && result.code !== 0 && result.code !== 1) throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.code}`);
  if (!count) return { content: [{ type: "text", text: "No matches found" }], details: undefined };
  const context = params.context && params.context > 0 ? params.context : 0;
  const cache = new Map<string, string[]>();
  const output: string[] = [];
  let linesTruncated = false;
  const formatPath = (file: string) => {
    if (directory) {
      const rel = relative(policy.root, file);
      if (rel && !rel.startsWith("..")) return rel.replace(/\\/g, "/");
    }
    return basename(file);
  };
  const compact = (text: string) => {
    const truncated = truncateLine(text);
    if (truncated.wasTruncated) linesTruncated = true;
    return truncated.text;
  };
  for (const match of matches) {
    checkScanAbort(signal);
    const file = formatPath(match.file);
    if (context === 0 && match.text !== undefined) {
      output.push(`${file}:${match.line}: ${compact(match.text.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, ""))}`);
      continue;
    }
    let lines = cache.get(match.file);
    if (!lines) {
      try {
        const target = await store.paths.classify(match.file, policy.root);
        if (target.kind === "memory") await store.access(target.path);
        lines = (await readFile(match.file, "utf8")).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      } catch { lines = []; }
      cache.set(match.file, lines);
    }
    if (!lines.length) { output.push(`${file}:${match.line}: (unable to read file)`); continue; }
    const start = context > 0 ? Math.max(1, match.line - context) : match.line;
    const end = context > 0 ? Math.min(lines.length, match.line + context) : match.line;
    for (let current = start; current <= end; current++) {
      const text = compact((lines[current - 1] ?? "").replace(/\r/g, ""));
      output.push(current === match.line ? `${file}:${current}: ${text}` : `${file}-${current}- ${text}`);
    }
  }
  store.assertLifecycle();
  const truncation = truncateHead(output.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  let text = truncation.content;
  const details: GrepToolDetails = {};
  const notices: string[] = [];
  if (result.limited) { notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`); details.matchLimitReached = limit; }
  if (truncation.truncated) { notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`); details.truncation = truncation; }
  if (linesTruncated) { notices.push("Some lines truncated to 500 chars. Use read tool to see full lines"); details.linesTruncated = true; }
  if (notices.length) text += `\n\n[${notices.join(". ")}]`;
  return { content: [{ type: "text", text }], details: Object.keys(details).length ? details : undefined };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export async function protectedFind(store: MemoryStore, policy: ScanPolicy, params: FindToolInput, signal?: AbortSignal): Promise<AgentToolResult<FindToolDetails | undefined>> {
  checkScanAbort(signal);
  if (policy.empty) return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
  const binary = await existingBinary("fd", store.paths.agentDir, signal);
  const limit = params.limit ?? 1000;
  const args = ["--glob", "--color=never", "--hidden"];
  let insideGit = false;
  for (let current = policy.root;;) {
    checkScanAbort(signal);
    if (await exists(join(current, ".git"))) { insideGit = true; break; }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!insideGit) args.push("--no-require-git");
  args.push("--max-results", String(limit));
  let pattern = params.pattern;
  if (pattern.includes("/")) {
    args.push("--full-path");
    if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") pattern = `**/${pattern}`;
    if (process.platform === "win32") pattern = pattern.replaceAll("/", String.raw`[/\\]`);
  }
  for (const path of policy.excluded) args.push("--exclude", `/${escapeScanGlob(relative(policy.root, path))}`);
  args.push("--", pattern, policy.root);
  store.assertLifecycle();
  const result = await stream(binary, args, signal);
  store.assertLifecycle();
  if (result.code !== 0 && !result.lines.join("\n")) throw new Error(result.stderr.trim() || `fd exited with code ${result.code}`);
  if (!result.lines.join("\n")) return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
  const paths = result.lines.map((raw) => raw.replace(/\r$/, "").trim()).filter(Boolean).map((path) => {
    const trailing = path.endsWith(sep) || (sep === "\\" && path.endsWith("/"));
    const rel = relative(policy.root, path).split(sep).join("/");
    return trailing && !rel.endsWith("/") ? `${rel}/` : rel;
  });
  const truncation = truncateHead(paths.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  let text = truncation.content;
  const details: FindToolDetails = {};
  const notices: string[] = [];
  if (paths.length >= limit) { notices.push(`${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern`); details.resultLimitReached = limit; }
  if (truncation.truncated) { notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`); details.truncation = truncation; }
  if (notices.length) text += `\n\n[${notices.join(". ")}]`;
  return { content: [{ type: "text", text }], details: Object.keys(details).length ? details : undefined };
}
