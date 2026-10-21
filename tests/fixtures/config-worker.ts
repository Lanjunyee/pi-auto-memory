import { MemoryConfig } from "../../src/core/config.js";
import { atomicReplace } from "../../src/core/atomic-file.js";
const [dir, operation, project] = process.argv.slice(2);
const config = await MemoryConfig.create(dir);
const barrier = async () => {
  process.send?.({ event: "locked" });
  await new Promise<void>((resolve) => process.once("message", () => resolve()));
};
try {
  if (operation === "disable" || operation === "inherit") {
    await config.setProjectDisabled(project, operation === "disable", { beforeRename: barrier });
  } else if (operation.startsWith("field-")) {
    await config.locked(async (state, lease) => {
      if (state.status !== "known") throw new Error(state.fault);
      await barrier();
      lease.check();
      await atomicReplace(config.path, JSON.stringify({ ...state.data, [operation]: true }));
    });
  } else await config.setEnabled(operation === "on", { beforeRename: barrier });
  process.send?.({ event: "done" });
} catch (err) { process.send?.({ event: "error", message: (err as Error).message }); process.exitCode = 1; }
process.disconnect?.();
