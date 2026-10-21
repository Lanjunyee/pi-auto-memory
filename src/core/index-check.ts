import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { indexPrefix, lineCount } from "./content-policy.js";
import { analyzeIndexLinks, CHECK_MAX_BYTES, classifyTarget, normalizedTarget, type IndexLink } from "./index-links.js";
import type { MemoryStore } from "./store.js";

export type LinkCheckStatus = "ok" | "missing" | "rejected" | "external" | "unsupported" | "unchecked";

export interface CheckedLink extends IndexLink {
  status: LinkCheckStatus;
  normalized?: string;
}

export interface IndexCheckReport {
  index: "present" | "missing" | "unreadable";
  complete: boolean;
  limits: { lines: number; bytes: number; truncated: boolean; linkLimitReached: boolean };
  links: CheckedLink[];
  missingEntries: CheckedLink[];
  duplicates: { normalized: string; lines: number[] }[];
  unsupported: { line: number; reason: string }[];
  loadedRange: { startLine: number; endLine: number; truncated: boolean };
  topic?: {
    path: string;
    exists: boolean;
    entries: { line: number; column: number; inLoadedRange: boolean }[];
    duplicateEntries: number;
  };
  notes: string[];
}

export const CHECK_READ_MAX_BYTES = CHECK_MAX_BYTES;

function versionOf(info: Awaited<ReturnType<typeof lstat>>): string {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode, info.nlink].join(":");
}

export async function readBoundedText(path: string, limit = CHECK_READ_MAX_BYTES): Promise<{ text: string; truncated: boolean; changed: boolean } | undefined> {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Memory check rejected: the target must be a regular file.");
  const handle = await open(path, "r");
  let truncated: boolean;
  let text: string;
  try {
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    truncated = bytesRead > limit || before.size > limit;
    text = buffer.subarray(0, Math.min(bytesRead, limit)).toString("utf8");
  } finally {
    await handle.close();
  }
  if (truncated) {
    const lastNewline = text.lastIndexOf("\n");
    text = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : text.replace(/�$/, "");
  }
  let changed = false;
  try {
    changed = versionOf(await lstat(path)) !== versionOf(before);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") changed = true;
    else throw error;
  }
  return { text, truncated, changed };
}

async function existingFile(store: MemoryStore, relativePath: string): Promise<boolean | undefined> {
  let absolute: string;
  try {
    absolute = await store.paths.assertCurrent(join(store.paths.projectDir, relativePath));
  } catch {
    return undefined;
  }
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) return undefined;
    return info.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function checkIndex(store: MemoryStore, topic?: string): Promise<IndexCheckReport> {
  await store.access(store.paths.projectDir);
  const report: IndexCheckReport = {
    index: "missing",
    complete: true,
    limits: { lines: 0, bytes: 0, truncated: false, linkLimitReached: false },
    links: [],
    missingEntries: [],
    duplicates: [],
    unsupported: [],
    loadedRange: { startLine: 0, endLine: 0, truncated: false },
    notes: [],
  };
  let topicPath: string | undefined;
  if (topic !== undefined) {
    try {
      topicPath = await store.paths.assertCurrent(join(store.paths.projectDir, topic));
    } catch {
      report.notes.push("指定主题路径不是当前项目的普通相对文件；未检查该主题。");
      return report;
    }
    const relative = topicPath.slice(store.paths.projectDir.length + 1).split("\\").join("/");
    const exists = await existingFile(store, relative);
    report.topic = { path: relative, exists: exists === true, entries: [], duplicateEntries: 0 };
    if (exists !== true) report.notes.push(exists === false ? "指定主题不存在。" : "指定主题路径安全检查失败或为符号链接，未读取。");
  }
  let text: string;
  try {
    const read = await readBoundedText(join(store.paths.projectDir, "MEMORY.md"));
    if (!read) {
      if (report.topic) report.notes.push("索引不存在；无法确认主题入口。");
      return report;
    }
    text = read.text;
    if (read.changed) {
      report.index = "present";
      report.complete = false;
      report.notes.push("检查期间索引版本发生变化；本次报告已失效，请重新检查。");
      return report;
    }
    if (read.truncated) {
      report.complete = false;
      report.notes.push(`索引超过 ${CHECK_READ_MAX_BYTES} 字节检查上限，检查不完整。`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Memory check rejected")) {
      report.index = "unreadable";
      report.complete = false;
      report.notes.push("索引不是普通文件或为符号链接，未读取。");
      return report;
    }
    report.index = "unreadable";
    report.complete = false;
    report.notes.push("索引无法读取；未检查入口。");
    return report;
  }
  const bytes = Buffer.byteLength(text, "utf8");
  report.index = "present";
  const prefix = indexPrefix(text);
  report.loadedRange = { startLine: prefix.prefix ? 1 : 0, endLine: lineCount(prefix.prefix), truncated: prefix.truncated };
  const analysis = analyzeIndexLinks(text);
  report.limits = { lines: analysis.lines, bytes, truncated: analysis.truncated, linkLimitReached: analysis.links.length >= 1000 };
  if (analysis.truncated) report.complete = false;
  report.unsupported = analysis.unsupported;
  if (analysis.unsupported.length) report.complete = false;
  for (const link of analysis.links) {
    const classification = classifyTarget(link.target);
    const status: LinkCheckStatus = classification.kind === "local" ? "ok" : classification.kind === "unsafe" ? "rejected" : classification.kind;
    const checked: CheckedLink = { ...link, status };
    if (classification.kind === "local") {
      const normalized = normalizedTarget(link.target);
      checked.normalized = normalized;
      const exists = await existingFile(store, normalized);
      checked.status = exists === true ? "ok" : exists === false ? "missing" : "rejected";
    }
    report.links.push(checked);
  }
  if (report.complete) report.missingEntries = report.links.filter((link) => link.status === "missing");
  const groups = new Map<string, number[]>();
  for (const link of report.links) {
    if (link.status !== "ok" || !link.normalized) continue;
    groups.set(link.normalized, [...(groups.get(link.normalized) ?? []), link.line]);
  }
  report.duplicates = [...groups].filter(([, lines]) => lines.length > 1).map(([normalized, lines]) => ({ normalized, lines }));
  if (report.topic?.exists) {
    const target = normalizedTarget(report.topic.path);
    const lines = report.complete ? report.links.filter((link) => link.normalized === target) : [];
    const entries = lines.map((link) => ({ line: link.line, column: link.column, inLoadedRange: link.end <= prefix.prefix.length }));
    report.topic.entries = entries;
    report.topic.duplicateEntries = Math.max(0, lines.length - 1);
    if (report.complete && lines.length === 0) report.notes.push("索引已完整检查，未发现该主题入口。");
    if (entries.length && !entries.some((entry) => entry.inLoadedRange)) report.notes.push("该主题入口存在，但位于当前 200 行 / 25KiB 加载范围之外。");
  }
  if (!report.complete) report.notes.push("检查不完整；未报告全局“入口缺失”。");
  if (report.unsupported.length) report.notes.push("存在不支持的引用写法，相关行未纳入结构结论。");
  return report;
}

export function formatCheck(report: IndexCheckReport): string {
  const lines = [`记忆关联检查（只读；检查时点：${new Date().toISOString()}；结构有效不代表描述准确或模型会读取）：`];
  lines.push(report.index === "missing" ? "索引：不存在。" : report.index === "unreadable" ? "索引：无法安全读取。" : "索引：已读取。");
  if (report.index === "present") {
    lines.push(`检查范围：${report.limits.lines} 行 / ${report.limits.bytes} 字节；${report.complete ? "完整" : "不完整"}。`);
    lines.push(`磁盘索引下次加载的候选范围：前 ${report.loadedRange.endLine} 行${report.loadedRange.truncated ? "（已截断）" : ""}；仅完整落入前 200 行 / 25KiB UTF-8 前缀的链接计入范围内。`);
    const local = report.links.filter((link) => link.status !== "external" && link.status !== "unsupported");
    lines.push(`本地链接：${local.length} 个；缺失 ${report.missingEntries.length}，重复 ${report.duplicates.length}。`);
    for (const link of report.missingEntries) lines.push(`  - 缺失：${link.normalized}（第 ${link.line} 行，第 ${link.column} 列）`);
    for (const duplicate of report.duplicates) lines.push(`  - 重复：${duplicate.normalized}（第 ${duplicate.lines.join("、")} 行）`);
    const rejected = report.links.filter((link) => link.status === "rejected");
    for (const link of rejected) lines.push(`  - 拒绝：${link.target}（第 ${link.line} 行，第 ${link.column} 列；越界或符号链接）`);
    const external = report.links.filter((link) => link.status === "external");
    if (external.length) lines.push(`外部链接：${external.length} 个，未访问。`);
    if (report.unsupported.length) lines.push(`未检查写法：${report.unsupported.length} 处（${[...new Set(report.unsupported.map((item) => item.reason))].join("、")}）。`);
    if (report.limits.linkLimitReached) lines.push("链接数量达到检查上限，检查不完整。");
  }
  if (report.topic) {
    lines.push(`主题：${report.topic.path}；${report.topic.exists ? "存在" : "不存在或不可检查"}。`);
    if (report.topic.exists) {
      lines.push(report.topic.entries.length
        ? `索引入口：${report.topic.entries.length} 个（${report.topic.entries.map((entry) => `第 ${entry.line} 行，第 ${entry.column} 列${entry.inLoadedRange ? "" : "，加载范围外"}`).join("；")}）。`
        : report.index === "present" && report.complete ? "索引入口：未发现（检查范围见上）。" : "索引入口：未检查（索引不存在或本次检查不完整）。");
      if (report.topic.duplicateEntries) lines.push(`重复入口：${report.topic.duplicateEntries} 个。`);
    }
  }
  for (const note of [...new Set(report.notes)]) lines.push(`说明：${note}`);
  lines.push("范围仅代表检查时点的磁盘索引；当前会话可能复用旧快照，不代表当前模型请求已包含入口。需要时执行 /memory reload，下一用户任务才加载。");
  lines.push("未修改文件、快照或模型读取许可；需要修正时请使用 /memory edit MEMORY.md。");
  return lines.join("\n");
}
