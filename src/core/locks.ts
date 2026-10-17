import { lstat, open } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { LOCK_RETRY_COUNT, LOCK_RETRY_MS, LOCK_STALE_MS, LOCK_UPDATE_MS } from "./constants.js";

export interface LockLease { check(): void }

export async function withLock<T>(anchor: string, action: (lease: LockLease) => Promise<T>): Promise<T> {
  try {
    const handle = await open(anchor, "wx", 0o600);
    await handle.close();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("Memory lock anchor creation failed.");
  }
  const info = await lstat(anchor);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Memory lock anchor rejected.");
  let compromised = false;
  const lease: LockLease = { check() { if (compromised) throw new Error("Memory lock became compromised; operation rejected."); } };
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(anchor, {
      stale: LOCK_STALE_MS, update: LOCK_UPDATE_MS,
      retries: { retries: LOCK_RETRY_COUNT, minTimeout: LOCK_RETRY_MS, maxTimeout: LOCK_RETRY_MS, factor: 1 },
      onCompromised: () => { compromised = true; },
    });
  } catch { throw new Error("Memory lock unavailable: wait timed out or lock could not be safely acquired."); }
  try { lease.check(); return await action(lease); }
  finally {
    await release().catch((err) => { if (!compromised) throw err; });
  }
}
