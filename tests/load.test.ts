import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

test("pi 1.2.0 explicitly loads the extension without user discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-load-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalExtensionPaths: [resolve("src/index.ts")],
    });
    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    assert.equal(result.extensions[0].commands.has("memory"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
