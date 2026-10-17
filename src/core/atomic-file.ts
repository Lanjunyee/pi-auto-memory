import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { FileHandle } from "node:fs/promises";

export interface AtomicHooks {
  write?: (handle: FileHandle, text: string) => Promise<void>;
  beforeRename?: () => Promise<void>;
}

export async function atomicReplace(path: string, text: string, hooks: AtomicHooks = {}): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temp, "wx", 0o600);
    if (process.platform !== "win32") await handle.chmod(0o600);
    if (hooks.write) await hooks.write(handle, text);
    else await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await hooks.beforeRename?.();
    await rename(temp, path);
  } finally {
    await handle?.close();
    await unlink(temp).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
  }
}
