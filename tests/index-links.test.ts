import assert from "node:assert/strict";
import test from "node:test";
import { analyzeIndexLinks, classifyTarget, loadedLineLimit, normalizedTarget, CHECK_MAX_LINKS, CHECK_MAX_LINES } from "../src/core/index-links.js";

test("inline Markdown links are recognized outside code and inline code", () => {
  const text = [
    "# Memory",
    "- [发布格式](topics/release.md) — 按缘起校验余量",
    "- [评审](<notes/review.md#anchor>)",
    "- `[忽略](inline.md)` 行内代码",
    "```",
    "[代码块](ignored.md)",
    "```",
    "- [绝对](/etc/passwd)",
    "- [越界](../other/x.md)",
    "- [外链](https://example.com/x.md)",
    "- ![图片](image.png)",
    "- [引用][ref]",
    "- [ref]: topics/ref.md",
    "- <a href=\"topics/html.md\">html</a>",
    "- [嵌套](a(b).md)",
  ].join("\n");
  const analysis = analyzeIndexLinks(text);
  assert.deepEqual(analysis.links.map(({ line, target }) => ({ line, target })), [
    { line: 2, target: "topics/release.md" },
    { line: 3, target: "notes/review.md#anchor" },
    { line: 8, target: "/etc/passwd" },
    { line: 9, target: "../other/x.md" },
    { line: 10, target: "https://example.com/x.md" },
    { line: 15, target: "a(b" },
  ]);
  const reasons = new Set(analysis.unsupported.map((item) => item.reason));
  assert.ok(reasons.has("image"));
  assert.ok(reasons.has("reference-style"));
  assert.ok(reasons.has("html"));
  assert.ok(reasons.has("nested"));  assert.equal(analysis.truncated, false);
  assert.deepEqual(classifyTarget("topics/release.md"), { kind: "local" });
  assert.deepEqual(classifyTarget("notes/review.md#anchor"), { kind: "local" });
  assert.deepEqual(classifyTarget("/etc/passwd"), { kind: "unsafe" });
  assert.deepEqual(classifyTarget("../other/x.md"), { kind: "unsafe" });
  assert.deepEqual(classifyTarget("https://example.com"), { kind: "external" });
  assert.deepEqual(classifyTarget("mailto:a@b.c"), { kind: "external" });
  assert.deepEqual(classifyTarget("javascript:alert(1)"), { kind: "unsupported" });
  assert.deepEqual(classifyTarget("file:///etc/passwd"), { kind: "unsupported" });
  assert.deepEqual(classifyTarget("#anchor"), { kind: "unsupported" });
  assert.deepEqual(classifyTarget("image.png"), { kind: "unsupported" });
  assert.equal(normalizedTarget("./topics//release.md#x"), "topics/release.md");
});

test("link positions preserve original offsets and Unicode columns through code masking", () => {
  const first = "[相同](topic.md)";
  const second = "[相同](topic.md)";
  const visibleLine = `😀 \`[隐藏](inline.md)\` ${first} 中 ${second}`;
  const text = ["# Memory", "```", "[隐藏](fenced.md)", "```", visibleLine].join("\n");
  const links = analyzeIndexLinks(text).links;
  const lineStart = text.lastIndexOf(visibleLine);
  const firstStart = visibleLine.indexOf(first);
  const secondStart = visibleLine.lastIndexOf(second);
  assert.deepEqual(links, [firstStart, secondStart].map((start) => ({
    line: 5,
    column: [...visibleLine.slice(0, start)].length + 1,
    start: lineStart + start,
    end: lineStart + start + first.length,
    target: "topic.md",
  })));
  for (const link of links) assert.equal(text.slice(link.start, link.end), first);
  assert.equal(links[1].start > links[0].end, true);
  const escaped = analyzeIndexLinks("😀 \`code\` [标签](<topic.md#anchor>)").links[0];
  assert.equal(escaped.column, 10);
  assert.equal(escaped.start, 10);
  assert.equal(escaped.end, "😀 \`code\` [标签](<topic.md#anchor>)".length);
});

test("link analysis enforces line, byte and link limits with incomplete status", () => {
  const many = Array.from({ length: CHECK_MAX_LINKS + 5 }, (_, index) => `- [t${index}](t${index}.md)`).join("\n");
  const byLinks = analyzeIndexLinks(many);
  assert.equal(byLinks.links.length, CHECK_MAX_LINKS);
  assert.equal(byLinks.truncated, true);
  const byLines = analyzeIndexLinks(Array.from({ length: CHECK_MAX_LINES + 1 }, (_, index) => `line ${index}`).join("\n"));
  assert.equal(byLines.truncated, true);
  assert.equal(byLines.lines, CHECK_MAX_LINES + 1);
  const byBytes = analyzeIndexLinks("a".repeat(1024 * 1024 + 1));
  assert.equal(byBytes.truncated, true);
  const prefix = loadedLineLimit("- [x](x.md)\n".repeat(400), 200, 25 * 1024);
  assert.equal(prefix.truncated, true);
  assert.ok(prefix.lines <= 200);
  assert.ok(prefix.bytes <= 25 * 1024);
  const whole = loadedLineLimit("- [x](x.md)\n", 200, 25 * 1024);
  assert.equal(whole.truncated, false);
});
