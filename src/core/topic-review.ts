import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { indexPrefix } from "./content-policy.js";
import { checkIndex, readBoundedText } from "./index-check.js";
import type { MemoryStore } from "./store.js";

export interface TopicReview {
  path: string;
  content: string;
  truncated: boolean;
  modified?: string;
  modifiedKnown: boolean;
  entries: { line: number; column: number; inLoadedRange: boolean }[];
  entriesComplete: boolean;
  notes: string[];
}

function parseModified(text: string): string | undefined {
  if (!text.startsWith("---")) return undefined;
  const closing = /\n---[ \t]*(?:\r?\n|$)/.exec(text.slice(3));
  if (!closing) return undefined;
  const frontmatter = text.slice(3, 3 + closing.index);
  if (!/^type\s*:/m.test(frontmatter) && !/^modified\s*:/m.test(frontmatter)) return undefined;
  const match = /^modified[ \t]*:[ \t]*(.+)$/m.exec(frontmatter);
  if (!match) return undefined;
  const value = match[1].trim().replace(/^["']|["']$/g, "");
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(value) ? undefined : value;
}

export async function reviewTopic(store: MemoryStore, relativePath: string): Promise<TopicReview> {
  if (relativePath === "MEMORY.md") throw new Error("Memory review requires a topic file; manage the index with list, check or edit.");
  if (!relativePath.toLowerCase().endsWith(".md")) throw new Error("Memory review requires a Markdown topic file.");
  const target = await store.access(join(store.paths.projectDir, relativePath));
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Memory review rejected: target must be a regular topic file.");
  const read = await readBoundedText(target);
  if (!read) throw new Error("Memory review rejected: target disappeared before it could be read.");
  if (read.changed) throw new Error("Memory review invalidated: the topic changed while it was being read; retry.");
  await store.access(target);
  const text = read.text;
  const prefix = indexPrefix(text);
  const modified = parseModified(text);
  const check = await checkIndex(store, relativePath);
  return {
    path: relativePath,
    content: prefix.prefix,
    truncated: prefix.truncated || read.truncated,
    ...(modified === undefined ? {} : { modified }),
    modifiedKnown: modified !== undefined,
    entries: check.topic?.entries ?? [],
    entriesComplete: check.complete && check.index === "present",
    notes: check.notes,
  };
}

export function formatReview(review: TopicReview): string {
  return [
    `记忆审阅：${review.path}`,
    `检查时点：${new Date().toISOString()}（仅代表本次检查）。`,
    `修改时间：${review.modified ?? "未知（未找到可安全解析的 modified 字段）"}；该时间不代表内容仍然有效。`,
    review.entriesComplete
      ? `索引入口：${review.entries.length ? review.entries.map((entry) => `第 ${entry.line} 行，第 ${entry.column} 列${entry.inLoadedRange ? "" : "（加载范围外）"}`).join("；") : "未发现"}。`
      : "索引入口：未完整检查；不能据此判断入口缺失。",
    "入口范围仅代表检查时点磁盘索引下次加载的候选范围；只有完整链接落入前 200 行 / 25KiB UTF-8 前缀才计入。当前会话可能复用旧快照，不代表当前模型请求已包含入口；需要时执行 /memory reload，下一用户任务才加载。",
    review.truncated ? "正文展示：前 200 行或 25KiB（已截断）；未展示内容未检查。" : "正文展示：完整（前 200 行或 25KiB 以内）。",
    "关闭查看后可选择保留、编辑、删除或返回列表；保留不写入 reviewed 标记，查看不建立模型读取许可。",
    ...(review.notes.length ? [`说明：${[...new Set(review.notes)].join("；")}`] : []),
  ].join("\n");
}
