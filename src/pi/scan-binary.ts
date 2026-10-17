import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { checkScanAbort } from "./scan-policy.js";

export async function existingBinary(
  tool: "rg" | "fd",
  agentDir: string,
  signal?: AbortSignal,
  searchPath: string = process.env.PATH ?? "",
): Promise<string> {
  const names = tool === "fd" ? ["fd", "fdfind"] : ["rg"];
  const dirs = [join(agentDir, "bin"), ...searchPath.split(delimiter).filter(Boolean)];
  for (const dir of dirs) for (const name of names) {
    checkScanAbort(signal);
    const path = join(dir, process.platform === "win32" ? `${name}.exe` : name);
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return path;
    } catch {}
  }
  throw new Error(`Memory scan unavailable: existing ${tool === "fd" ? "fd/fdfind" : "rg"} is required in agentDir/bin or PATH; no download was attempted.`);
}
