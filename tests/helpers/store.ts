import { MemoryConfig } from "../../src/core/config.js";
import { MemoryPaths } from "../../src/core/paths.js";
import { MemoryStore } from "../../src/core/store.js";
export const testProjectId = `cwd-${"b".repeat(64)}`;
export async function makeStore(agentDir: string) {
  const paths = await MemoryPaths.create(agentDir, testProjectId);
  const config = await MemoryConfig.create(agentDir);
  return new MemoryStore(paths, config, false);
}
