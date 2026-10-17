import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { managedFileTools } from "../src/pi/tools.js";
import { makeStore } from "./helpers/store.js";

async function fixture(t: TestContext, text: string) {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-read-coverage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const writer = await makeStore(join(root, "agent"));
  const path = join(writer.paths.projectDir, "topic.md");
  await writer.write(path, text);
  const reader = await makeStore(join(root, "agent"));
  const tools = managedFileTools(root, reader);
  const ctx = { cwd: root } as ExtensionToolContext;
  const read = (offset?: number, limit?: number) => tools.read.execute("read", { path, offset, limit }, undefined, undefined, ctx);
  const write = (content: string) => tools.write.execute("write", { path, content }, undefined, undefined, ctx);
  const edit = () => tools.edit.execute("edit", { path, edits: [{ oldText: "line 0", newText: "changed" }] }, undefined, undefined, ctx);
  return { root, writer, reader, path, tools, ctx, read, write, edit };
}

test("line-truncated reads authorize only returned ranges; filling a gap allows edit beyond 2000 lines", async (t) => {
  const text = Array.from({ length: 2103 }, (_, i) => `line ${i}`).join("\n");
  const f = await fixture(t, text);
  await assert.rejects(f.write("unread"), /no complete read baseline/);
  const first = await f.read();
  assert.equal(first.details?.truncation?.outputLines, 2000);
  await assert.rejects(f.edit(), /no complete read baseline/);
  await f.read(2002);
  await assert.rejects(f.write("gap"), /no complete read baseline/);
  await f.read(2001, 1);
  await f.edit();
  assert.equal(await readFile(f.path, "utf8"), text.replace("line 0", "changed"));
});

test("byte-truncated Unicode/CRLF reads support out-of-order, overlapping segments beyond 50KiB", async (t) => {
  const text = Array.from({ length: 130 }, (_, i) => `line ${i} ${"记忆".repeat(100)}\r`).join("\n") + "\n";
  const f = await fixture(t, text);
  const first = await f.read();
  assert.equal(first.details?.truncation?.truncatedBy, "bytes");
  const returned = first.details!.truncation!.outputLines;
  assert.ok(returned < 130);
  await assert.rejects(f.edit(), /no complete read baseline/);
  await f.read(returned + 2);
  await assert.rejects(f.write("gap"), /no complete read baseline/);
  await f.read(returned, 2);
  await f.edit();
  assert.equal(await readFile(f.path, "utf8"), text.replace("line 0", "changed"));
});

test("version change clears old segments, including a zero-payload diagnostic read", async (t) => {
  const f = await fixture(t, "line 0\nsecond\nthird");
  await f.read(1, 1);
  await f.writer.write(f.path, "line 0\nchanged second\nthird");
  await f.read(2);
  await assert.rejects(f.edit(), /no complete read baseline/);
  await f.read(1, 1);
  await f.edit();
  await writeFile(f.path, "x".repeat(51201));
  const diagnostic = await f.read();
  assert.equal(diagnostic.details?.truncation?.firstLineExceedsLimit, true);
  await assert.rejects(f.write("replacement"), /no complete read baseline/);
  await writeFile(f.path, "changed\nchanged second\nthird");
  await assert.rejects(f.write("replacement"), /stale version/);
});

test("baseline digest uses the returned buffer, not a reread after an external write", async (t) => {
  const f = await fixture(t, "line 0\nsecond");
  const original = f.reader.readBuffer.bind(f.reader);
  t.mock.method(f.reader, "readBuffer", async (path: string) => {
    const observed = await original(path);
    await f.writer.write(path, "new disk version");
    return observed;
  });
  const result = await f.read();
  assert.equal(result.content[0].type, "text");
  assert.equal((result.content[0] as { text: string }).text, "line 0\nsecond");
  await assert.rejects(f.write("overwrite"), /stale version/);
  assert.equal(await readFile(f.path, "utf8"), "new disk version");
});

test("empty file, terminal newline, CRLF, blank lines and repeated identical text establish precise coverage", async (t) => {
  for (const text of ["", "line 0", "line 0\n", "line 0\r\n", "\n\n", "same\nsame\nsame\n"]) {
    await t.test(JSON.stringify(text), async (t) => {
      const f = await fixture(t, text);
      const count = text.split("\n").length;
      for (let offset = count; offset >= 1; offset--) await f.read(offset, 1);
      await f.write("replacement");
      assert.equal(await readFile(f.path, "utf8"), "replacement");
    });
  }
});

test("zero limit and overlong single line cannot create coverage; schema remains unchanged", async (t) => {
  const f = await fixture(t, "line 0\nsecond");
  await f.read(1, 0);
  await assert.rejects(f.write("overwrite"), /no complete read baseline/);
  await writeFile(f.path, "x".repeat(51201));
  const result = await f.read();
  assert.equal(result.details?.truncation?.outputBytes, 0);
  assert.equal(result.details?.truncation?.firstLineExceedsLimit, true);
  await assert.rejects(f.read(2));
  await assert.rejects(f.write("overwrite"), /no complete read baseline/);
  assert.equal((await readFile(f.path)).length, 51201);
});

test("aborted reads, invalid UTF-8 and lifecycle invalidation never grant full baseline", async (t) => {
  const f = await fixture(t, "line 0\nsecond");
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.tools.read.execute("aborted", { path: f.path }, abort.signal, undefined, f.ctx));
  await assert.rejects(f.write("overwrite"), /no complete read baseline/);
  await writeFile(f.path, Buffer.from([0x61, 0xff, 0x0a, 0x62]));
  await f.read();
  await assert.rejects(f.write("overwrite"), /no complete read baseline/);
  await writeFile(f.path, "line 0\nsecond");
  const original = f.reader.readBuffer.bind(f.reader);
  t.mock.method(f.reader, "readBuffer", async (path: string) => {
    const observed = await original(path);
    f.reader.invalidate();
    return observed;
  });
  await assert.rejects(f.read(), /invalidated by a session change/);
  await assert.rejects(f.write("overwrite"), /no complete read baseline/);
});
