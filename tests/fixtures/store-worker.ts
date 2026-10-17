import { join } from "node:path";
import { makeStore } from "../helpers/store.js";
import { withLock } from "../../src/core/locks.js";
import { mkdir } from "node:fs/promises";
const [dir, mode, content = "worker value"] = process.argv.slice(2);
const store = await makeStore(dir);
const path = join(store.paths.projectDir, "topic.md");
const barrier = async (event: string) => {
  process.send?.({ event });
  await new Promise<void>((resolve) => process.once("message", () => resolve()));
};
try {
  if (mode === "lock") await store.config.locked(async () => { await barrier("locked"); });
  else if (mode === "project-lock") {
    await mkdir(store.config.agentDir, { recursive: true, mode: 0o700 });
    await withLock(store.projectAnchor, async () => { await barrier("locked"); });
  } else {
    if (mode !== "new") await store.readFull(path);
    await barrier("ready");
    await store.write(path, content, { beforeRename: () => barrier("renaming") });
  }
  process.send?.({ event: "done" });
} catch (err) { process.send?.({ event: "rejected", message: (err as Error).message }); process.exitCode = 2; }
process.disconnect?.();
