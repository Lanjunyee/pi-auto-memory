import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./pi/commands.js";
import { registerMemoryTools } from "./pi/registration.js";
import { registerLifecycle } from "./pi/lifecycle.js";
import { MemoryActivity } from "./pi/activity.js";

export default function autoMemory(pi: ExtensionAPI): void {
  const runtime = registerMemoryTools(pi, { activity: new MemoryActivity() });
  const lifecycle = registerLifecycle(pi, runtime);
  registerCommands(pi, runtime, { lifecycleState: lifecycle.status, resetLifecycle: lifecycle.reset });
}
