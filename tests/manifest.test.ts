import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("public manifest has one explicit Pi entry and shared host peer", async () => {
  const p = JSON.parse(await readFile("package.json", "utf8"));
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  assert.equal(p.name, "@lanjunyee/pi-auto-memory");
  assert.equal(p.version, "0.1.3");
  assert.equal(p.private, undefined);
  assert.equal(p.license, "Apache-2.0");
  const license = await readFile("LICENSE", "utf8");
  assert.ok(license.includes("END OF TERMS AND CONDITIONS"));
  assert.ok(license.includes("APPENDIX: How to apply"));
  assert.ok(license.length > 10000);
  assert.ok((await readFile("README.md", "utf8")).includes("Copyright 2026 Lanjunyee"));
  assert.deepEqual(p.pi, { extensions: ["./src/index.ts"] });
  assert.equal(p.engines.node, ">=22.19.0");
  assert.ok(p.keywords.includes("pi-package"));
  assert.equal(p.publishConfig.access, "public");
  assert.equal(p.repository.url, "git+https://github.com/Lanjunyee/pi-auto-memory.git");
  assert.equal(p.bugs.url, "https://github.com/Lanjunyee/pi-auto-memory/issues");
  assert.equal(p.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  assert.deepEqual(p.dependencies, { "proper-lockfile": "4.1.2", yaml: "2.9.1" });
  assert.equal(p.devDependencies["@earendil-works/pi-coding-agent"], "1.2.0");
  for (const root of [lock, lock.packages[""]]) {
    assert.equal(root.name, p.name);
    assert.equal(root.version, p.version);
  }
  assert.deepEqual(lock.packages[""].dependencies, p.dependencies);
  assert.deepEqual(lock.packages[""].peerDependencies, p.peerDependencies);
});
