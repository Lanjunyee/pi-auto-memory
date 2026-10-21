import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatReview, reviewTopic } from "../src/core/topic-review.js";
import { checkIndex, formatCheck } from "../src/core/index-check.js";
import { makeStore } from "./helpers/store.js";

test("review shows bounded content and safe modified metadata without granting coverage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await makeStore(join(root, "agent"));
  const topic = join(store.paths.projectDir, "topics/release.md");
  await store.write(topic, "---\ntype: feedback\nmodified: 2026-01-02T03:04:05.000Z\n---\nrelease body\n");
  await store.write(join(store.paths.projectDir, "MEMORY.md"), "# Memory\n\n- [发布](topics/release.md) — described\n");
  const review = await reviewTopic(store, "topics/release.md");
  assert.match(review.modified ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(review.truncated, false);
  assert.equal(review.entries.length, 1);
  assert.equal(review.entriesComplete, true);
  assert.match(review.content, /release body/);
  assert.match(formatReview(review), /修改时间：\d{4}-\d{2}-\d{2}T/);
  assert.match(formatReview(review), /不代表内容仍然有效/);
  const observer = await makeStore(join(root, "agent"));
  await reviewTopic(observer, "topics/release.md");
  await assert.rejects(observer.write(topic, "review overwrite"), /no complete read baseline/);
  const missingMeta = await reviewTopic(store, "topics/release.md").then(() => store.write(join(store.paths.projectDir, "plain.md"), "plain body"))
    .then(() => reviewTopic(store, "plain.md"));
  assert.equal(missingMeta.modifiedKnown, false);
  assert.match(formatReview(missingMeta), /修改时间：未知/);
  await assert.rejects(reviewTopic(store, "MEMORY.md"), /requires a topic file/);
  await store.write(join(store.paths.projectDir, "plain.txt"), "not markdown");
  await assert.rejects(reviewTopic(store, "plain.txt"), /requires a Markdown topic file/);
  await store.write(join(store.paths.projectDir, "UPPER.MD"), "markdown body");
  assert.match((await reviewTopic(store, "UPPER.MD")).content, /markdown body/);
  await store.config.setProjectDisabled(store.paths.projectId, true);
  await assert.rejects(reviewTopic(store, "topics/release.md"), /Memory is off/);
  assert.equal(await readFile(topic, "utf8").then((text) => text.includes("release body")), true);
});

test("review and check share precise entry positions and disk candidate range boundaries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-review-entries-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const writer = await makeStore(join(root, "agent"));
  const topic = join(writer.paths.projectDir, "topic.md");
  const indexPath = join(writer.paths.projectDir, "MEMORY.md");
  await writer.write(topic, "topic body");
  const link = "[主题](topic.md)";
  const index = `${link}${"x".repeat(25 * 1024 - Buffer.byteLength(link))}${link}`;
  await writeFile(indexPath, index);
  const observer = await makeStore(join(root, "agent"));
  const check = await checkIndex(observer, "topic.md");
  const review = await reviewTopic(observer, "topic.md");
  assert.deepEqual(review.entries, check.topic?.entries);
  assert.deepEqual(review.entries.map((entry) => entry.inLoadedRange), [true, false]);
  for (const text of [formatCheck(check), formatReview(review)]) {
    assert.match(text, /第 1 行，第 1 列/);
    assert.match(text, /加载范围外/);
    assert.match(text, /磁盘索引下次加载的候选范围/);
    assert.match(text, /当前会话可能复用旧快照/);
    assert.match(text, /不代表当前模型请求已包含入口/);
    assert.match(text, /\/memory reload，下一用户任务才加载/);
  }
  assert.equal(await readFile(indexPath, "utf8"), index);
  assert.equal(await readFile(topic, "utf8"), "topic body");
  await assert.rejects(observer.write(indexPath, "overwrite index"), /no complete read baseline/);
  await assert.rejects(observer.write(topic, "overwrite topic"), /no complete read baseline/);
});

test("review truncates long topics and marks incomplete entry checks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-review-limits-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await makeStore(join(root, "agent"));
  await store.write(join(store.paths.projectDir, "long.md"), Array.from({ length: 260 }, (_, index) => `line ${index}`).join("\n"));
  const review = await reviewTopic(store, "long.md");
  assert.equal(review.truncated, true);
  assert.equal(review.entriesComplete, false);
  assert.match(formatReview(review), /已截断/);
  assert.match(formatReview(review), /不能据此判断入口缺失/);
  const displayed = review.content.split("\n").length;
  assert.ok(displayed <= 201);
});
