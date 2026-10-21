import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkIndex, formatCheck } from "../src/core/index-check.js";
import { makeStore } from "./helpers/store.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-check-"));
  const store = await makeStore(join(root, "agent"));
  return { root, store };
}

test("check reports missing entries, duplicates, out-of-range entries and rejected targets without reading topics", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const dir = f.store.paths.projectDir;
  await f.store.write(join(dir, "topics/release.md"), "release body");
  await f.store.write(join(dir, "topics/review.md"), "review body");
  const index = [
    "# Memory",
    "- [发布格式](topics/release.md) — described",
    "- [重复](topics/release.md#x) — duplicate",
    "- [断链](topics/missing.md) — broken",
    "- [绝对](/etc/passwd)",
    "- [越界](../other.md)",
    "- [外链](https://example.com)",
    "- [图片](topics/picture.png)",
    ...Array.from({ length: 210 }, (_, index) => `line ${index}`),
    "- [范围外](topics/review.md) — late entry",
  ].join("\n");
  await f.store.write(join(dir, "MEMORY.md"), index);
  const report = await checkIndex(f.store, "topics/release.md");
  assert.equal(report.index, "present");
  assert.equal(report.complete, true);
  assert.equal(report.topic?.exists, true);
  assert.equal(report.topic?.entries.length, 2);
  assert.equal(report.topic?.duplicateEntries, 1);
  assert.ok(report.missingEntries.some((link) => link.normalized === "topics/missing.md"));
  assert.ok(report.links.some((link) => link.status === "rejected"));
  assert.ok(report.links.some((link) => link.status === "external"));
  assert.ok(report.duplicates.some((item) => item.normalized === "topics/release.md" && item.lines.length === 2));
  const foreign = await checkIndex(f.store, "topics/review.md");
  assert.equal(foreign.topic?.entries.length, 1);
  assert.equal(foreign.topic?.entries[0].inLoadedRange, false);
  assert.ok(foreign.notes.some((note) => note.includes("加载范围之外")));
  const absent = await checkIndex(f.store, "topics/absent.md");
  assert.equal(absent.topic?.exists, false);
  await symlink(join(dir, "topics/release.md"), join(dir, "topics/link.md"));
  const linked = await checkIndex(f.store, "topics/link.md");
  assert.notEqual(linked.topic?.exists, true);
  const before = await readFile(join(dir, "topics/release.md"), "utf8");
  assert.equal(before, "release body");
  const text = formatCheck(report);
  assert.match(text, /记忆关联检查/);
  assert.match(text, /缺失/);
  assert.match(text, /重复/);
  assert.match(text, /未修改文件/);
  assert.doesNotMatch(text, /release body/);
});

test("check reports an existing topic without an entry and leaves the index untouched", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const dir = f.store.paths.projectDir;
  await f.store.write(join(dir, "topics/orphan.md"), "orphan body");
  await f.store.write(join(dir, "topics/linked.md"), "linked body");
  const index = "# Memory\n\n- [已关联](topics/linked.md) — described\n";
  await f.store.write(join(dir, "MEMORY.md"), index);
  const report = await checkIndex(f.store, "topics/orphan.md");
  assert.equal(report.complete, true);
  assert.equal(report.topic?.exists, true);
  assert.deepEqual(report.topic?.entries, []);
  assert.ok(report.notes.some((note) => note.includes("索引已完整检查，未发现该主题入口")));
  const text = formatCheck(report);
  assert.match(text, /索引入口：未发现（检查范围见上）/);
  assert.match(text, /\/memory edit MEMORY\.md/);
  assert.equal(await readFile(join(dir, "MEMORY.md"), "utf8"), index);
  assert.equal(await readFile(join(dir, "topics/orphan.md"), "utf8"), "orphan body");
});

test("check reports unsupported syntax as incomplete instead of claiming a missing entry", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const dir = f.store.paths.projectDir;
  await f.store.write(join(dir, "topic.md"), "body");
  const index = "# Memory\n\n[ref]: topic.md\n- [主题](topic.md)\n";
  await f.store.write(join(dir, "MEMORY.md"), index);
  const report = await checkIndex(f.store, "topic.md");
  assert.equal(report.complete, false);
  assert.deepEqual(report.unsupported.map((item) => item.reason), ["reference-style"]);
  assert.deepEqual(report.topic?.entries, []);
  assert.ok(report.notes.some((note) => note.includes("不支持的引用写法")));
  const text = formatCheck(report);
  assert.match(text, /检查不完整/);
  assert.match(text, /未检查写法：1 处（reference-style）/);
  assert.match(text, /索引入口：未检查/);
  assert.doesNotMatch(text, /索引入口：未发现/);
  assert.equal(await readFile(join(dir, "MEMORY.md"), "utf8"), index);
});

test("check requires complete link spans inside the actual line and UTF-8 prefix", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const dir = f.store.paths.projectDir;
  const topic = join(dir, "topic.md");
  const indexPath = join(dir, "MEMORY.md");
  await f.store.write(topic, "body");
  const link = "[主题](topic.md)";
  const maxBytes = 25 * 1024;
  const linkBytes = Buffer.byteLength(link, "utf8");
  const cases = [
    { name: "empty", index: "", expected: [], lines: 0, truncated: false },
    { name: "line 200", index: `${"line\n".repeat(199)}${link}\n`, expected: [true], lines: 200, truncated: false },
    { name: "line 201", index: `${"line\n".repeat(200)}${link}`, expected: [false], lines: 200, truncated: true },
    { name: "after byte boundary", index: `${"x".repeat(maxBytes)}${link}`, expected: [false], lines: 1, truncated: true },
    { name: "crossing final parenthesis", index: `${"x".repeat(maxBytes - linkBytes + 1)}${link}`, expected: [false], lines: 1, truncated: true },
    { name: "exact byte boundary", index: `${"x".repeat(maxBytes - linkBytes)}${link}`, expected: [true], lines: 1, truncated: false },
    { name: "Unicode before byte boundary", index: `${"x".repeat(maxBytes - 1)}😀${link}`, expected: [false], lines: 1, truncated: true },
    { name: "Unicode at exact boundary", index: `😀${"x".repeat(maxBytes - linkBytes - 4)}${link}`, expected: [true], lines: 1, truncated: false },
    { name: "same-line duplicate", index: `${link}${"x".repeat(maxBytes - linkBytes)}${link}`, expected: [true, false], lines: 1, truncated: true },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      await writeFile(indexPath, entry.index);
      const report = await checkIndex(f.store, "topic.md");
      assert.equal(report.complete, true);
      assert.deepEqual(report.topic?.entries.map((item) => item.inLoadedRange), entry.expected);
      assert.deepEqual(report.loadedRange, { startLine: entry.lines ? 1 : 0, endLine: entry.lines, truncated: entry.truncated });
      if (entry.expected.length === 2) {
        assert.equal(report.topic?.entries[0].line, report.topic?.entries[1].line);
        assert.notEqual(report.topic?.entries[0].column, report.topic?.entries[1].column);
        assert.equal(report.topic?.duplicateEntries, 1);
      }
      assert.match(formatCheck(report), new RegExp(`候选范围：前 ${entry.lines} 行`));
    });
  }
});

test("precise range checks only open the index and do not establish read coverage or change files", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const dir = f.store.paths.projectDir;
  const topic = join(dir, "topic.md");
  const indexPath = join(dir, "MEMORY.md");
  await f.store.write(topic, "body");
  await f.store.write(indexPath, `${"x".repeat(25 * 1024)}[主题](topic.md)`);
  const originalTopic = await readFile(topic);
  const originalIndex = await readFile(indexPath);
  const observer = await makeStore(join(f.root, "agent"));
  const opened: string[] = [];
  const original = fsPromises.open;
  const spy = t.mock.method(fsPromises, "open", async (...args: Parameters<typeof original>) => {
    opened.push(String(args[0]));
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const report = await checkIndex(observer, "topic.md");
    assert.equal(report.topic?.entries[0].inLoadedRange, false);
    assert.deepEqual(opened, [indexPath]);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(await readFile(topic), originalTopic);
  assert.deepEqual(await readFile(indexPath), originalIndex);
  await assert.rejects(observer.write(topic, "overwrite"), /no complete read baseline/);
  await assert.rejects(observer.write(indexPath, "overwrite"), /no complete read baseline/);
});

test("check invalidates its report when the index changes during the read", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const dir = f.store.paths.projectDir;
  await f.store.write(join(dir, "topic.md"), "body");
  await f.store.write(join(dir, "MEMORY.md"), "# Memory\n\n- [主题](topic.md) — described\n");
  const original = fsPromises.lstat;
  let indexStats = 0;
  fsPromises.lstat = (async (path: Parameters<typeof original>[0], ...rest: unknown[]) => {
    const info = await (original as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof original>>>)(path, ...rest);
    if (String(path).endsWith("MEMORY.md")) {
      indexStats++;
      if (indexStats >= 2) {
        return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: Number(info.mtimeMs) + 1000, ctimeMs: Number(info.ctimeMs) + 1000,
          mode: info.mode, nlink: info.nlink, isFile: () => true, isSymbolicLink: () => false } as typeof info;
      }
    }
    return info;
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    const report = await checkIndex(f.store, "topic.md");
    assert.equal(report.complete, false);
    assert.ok(report.notes.some((note) => note.includes("检查期间索引版本发生变化")));
    assert.match(formatCheck(report), /不完整|失效/);
  } finally {
    fsPromises.lstat = original;
    syncBuiltinESMExports();
  }
  const retry = await checkIndex(f.store, "topic.md");
  assert.equal(retry.complete, true);
  assert.equal(retry.topic?.entries.length, 1);
});

test("check reads at most the analysis limit instead of the whole oversized index", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const dir = f.store.paths.projectDir;
  await f.store.write(join(dir, "topic.md"), "body");
  const handle = await import("node:fs/promises").then((fs) => fs.open(join(dir, "MEMORY.md"), "w"));
  try {
    const chunk = Buffer.alloc(64 * 1024, "x");
    for (let index = 0; index < 96; index++) await handle.write(chunk);
  } finally {
    await handle.close();
  }
  const report = await checkIndex(f.store, "topic.md");
  assert.equal(report.complete, false);
  assert.ok(report.notes.some((note) => note.includes("检查上限")));
  assert.ok(report.limits.bytes <= 1024 * 1024);
});

test("check reports missing index, incomplete scans and unreadable indexes without claiming absence", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const dir = f.store.paths.projectDir;
  await f.store.write(join(dir, "topic.md"), "body");
  const missing = await checkIndex(f.store, "topic.md");
  assert.equal(missing.index, "missing");
  assert.equal(missing.topic?.entries.length, 0);
  assert.ok(missing.notes.some((note) => note.includes("索引不存在")));
  assert.equal(formatCheck(missing).includes("索引入口：未发现"), false);
  assert.match(formatCheck(missing), /索引：不存在/);
  await f.store.write(join(dir, "MEMORY.md"), `${"- [t](topic.md)\n".repeat(990)}`);
  const duplicates = await checkIndex(f.store);
  assert.equal(duplicates.duplicates.length, 1);
  assert.equal(duplicates.duplicates[0].lines.length, 990);
  await f.store.config.setProjectDisabled(f.store.paths.projectId, true);
  await assert.rejects(checkIndex(f.store), /Memory is off/);
  await f.store.config.setProjectDisabled(f.store.paths.projectId, false);
  await f.store.config.setEnabled(false);
  await assert.rejects(checkIndex(f.store), /Memory is off/);
});

test("check truncates oversized indexes and marks the report incomplete", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const dir = f.store.paths.projectDir;
  await f.store.write(join(dir, "topic.md"), "body");
  await f.store.write(join(dir, "MEMORY.md"), `${"x".repeat(1024 * 1024 + 10)}`);
  const report = await checkIndex(f.store, "topic.md");
  assert.equal(report.complete, false);
  assert.ok(report.notes.some((note) => note.includes("检查上限")));
  assert.equal(report.topic?.entries.length, 0);
  assert.equal(formatCheck(report).includes("索引入口：未发现"), false);
});
