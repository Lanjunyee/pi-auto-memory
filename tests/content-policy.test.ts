import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import { assertNoSecrets, indexPrefix, lineCount, prepareContent, savedResult } from "../src/core/content-policy.js";

test("secret detection rejects synthetic keys/tokens/assignments without echoing values", () => {
  const samples = [
    "-----BEGIN PRIVATE KEY-----\nSYNTHETIC-NOT-A-KEY\n-----END PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nSYNTHETIC-NOT-A-KEY",
    `ghp_${"SYNTHETIC1234".repeat(4)}`,
    `github_pat_${"SYNTHETIC1234_".repeat(4)}`,
    `sk-proj-${"SYNTHETIC1234".repeat(4)}`,
    `sk-ant-api03-${"SYNTHETIC1234".repeat(4)}`,
    `xoxb-${"SYNTHETIC1234-".repeat(3)}`,
    "AKIASYNTHETIC1234567",
    'api_key: "SyntheticExample1234567890"',
    'password = "SyntheticExample9876543210"',
  ];
  for (const sample of samples) {
    assert.throws(() => assertNoSecrets(sample), (err: Error) => {
      assert.match(err.message, /Memory save rejected: detected/);
      assert.equal(err.message.includes(sample), false);
      assert.equal(err.message.includes("SYNTHETIC"), false);
      assert.equal(err.message.includes("SyntheticExample"), false);
      return true;
    });
  }
  for (const reference of [
    "Credentials are stored in the team's vault; never copy them here.",
    "api_key: <from environment>", "API_KEY=process.env.API_KEY",
    "Reference: https://example.invalid/docs/auth", "type: reference\nUse password manager",
    "A token is a parser unit. The project prefers concise output.",
  ]) assert.doesNotThrow(() => assertNoSecrets(reference));
});

test("frontmatter preserves semantic fields/body, BOM and line endings; malformed input is sanitized", () => {
  const now = new Date("2026-01-02T03:04:05.000Z");
  for (const ending of ["\n", "\r\n"]) {
    for (const bom of ["", "\uFEFF"]) {
      const metadata = ['type: feedback', 'count: 7', 'flags: [true, false]', 'nested: {name: example}', 'modified: old'];
      const body = `# Body${ending}Keep this exactly.${ending}`;
      const text = bom + ["---", ...metadata, "---", ""].join(ending) + body;
      const result = prepareContent(text, now);
      assert.ok(result.startsWith(bom + "---" + ending));
      assert.ok(result.endsWith(body));
      if (ending === "\r\n") assert.equal(result.replace(/\r\n/g, "").includes("\n"), false);
      const yaml = result.slice(bom.length).split("---")[1];
      assert.deepEqual(parse(yaml), { type: "feedback", count: 7, flags: [true, false], nested: { name: "example" }, modified: now.toISOString() });
    }
  }
  assert.equal(prepareContent("# No metadata\n", now), "# No metadata\n");
  for (const invalid of ["---\ntype: [broken\n---\nbody", "---\ntype: feedback\n", "---\n- list\n---\nbody", "---\na: 1\na: 2\n---\nbody", "---\nvalue: !unknown data\n---\nbody"]) {
    assert.throws(() => prepareContent(invalid, now), (err: Error) => {
      assert.match(err.message, /frontmatter/);
      assert.equal(err.message.includes("broken"), false);
      return true;
    });
  }
  const secret = `sk-proj-${"SYNTHETIC1234".repeat(4)}`;
  assert.throws(() => prepareContent(`---\nbroken: [\n---\n${secret}`, now), /provider-token/);
});

test("updating modified preserves other fields when aliases refer to its old anchored value", () => {
  const now = new Date("2026-01-02T03:04:05.000Z");
  for (const metadata of [
    "modified: &stamp old\nreference: *stamp\nother: *stamp",
    "modified: &stamp {state: old, items: [1, 2]}\nreference: *stamp\nother: *stamp",
    "modified: {nested: &stamp old}\nreference: *stamp",
    "reference: &stamp old\nmodified: *stamp\nother: *stamp",
  ]) {
    const before = parse(metadata);
    const result = prepareContent(`---\n${metadata}\n---\nbody\n`, now);
    const after = parse(result.split("---")[1]);
    assert.equal(after.modified, now.toISOString());
    delete before.modified; delete after.modified;
    assert.deepEqual(after, before);
    assert.ok(result.endsWith("body\n"));
  }
});

test("index limits: 199/200/201 lines, CRLF, terminal newline and empty content", () => {
  for (const ending of ["\n", "\r\n"]) {
    for (const count of [199, 200, 201]) {
      for (const terminal of [false, true]) {
        const text = Array(count).fill("line").join(ending) + (terminal ? ending : "");
        const result = indexPrefix(text);
        assert.equal(result.lines, count);
        assert.equal(result.overLimit, count > 200);
        assert.equal(result.truncated, count > 200);
        assert.ok(lineCount(result.prefix) <= 200);
        if (count <= 200) assert.equal(result.prefix, text);
      }
    }
  }
  assert.equal(indexPrefix("").prefix, "");
  assert.equal(indexPrefix("").lines, 0);
  assert.equal(indexPrefix("").nearLimit, false);
});

test("byte boundary, Unicode, combined limits and save-result semantics", () => {
  const max = 25 * 1024;
  for (const size of [max - 1, max, max + 1]) {
    const result = indexPrefix("x".repeat(size));
    assert.equal(Buffer.byteLength(result.prefix), Math.min(size, max));
    assert.equal(result.overLimit, size > max);
  }
  for (const char of ["中", "🙂"]) {
    const result = indexPrefix("x".repeat(max - 1) + char);
    assert.equal(result.prefix, "x".repeat(max - 1));
    assert.equal(result.prefix.includes("\uFFFD"), false);
  }
  assert.equal(indexPrefix(Array(201).fill("x".repeat(200)).join("\n")).truncated, true);
  const saved = savedResult("/tmp/MEMORY.md", "x".repeat(max + 1));
  assert.equal(saved.saved, true);
  assert.equal(saved.isError, true);
  assert.match(saved.note, /file IS SAVED/);
  assert.equal(savedResult("/tmp/topic.md", "x".repeat(max + 1)).isError, false);
  assert.equal(savedResult("MEMORY.md", "x".repeat(max)).isError, false);
  assert.match(savedResult("MEMORY.md", "x".repeat(max)).note, /near/);
  assert.equal(indexPrefix("x".repeat(max * 0.9 - 1)).nearLimit, false);
  assert.equal(indexPrefix("x".repeat(max * 0.9)).nearLimit, true);
});
