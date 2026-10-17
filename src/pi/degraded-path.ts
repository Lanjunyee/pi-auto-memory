import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { contains } from "../core/paths.js";
import { factoryPath } from "./factory-path.js";

export type DegradedRoute = "memory" | "ancestor" | "ordinary";

export function lexicalMemoryRoot(agentDir = getAgentDir()): string {
  return join(resolve(agentDir), "memory");
}

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

export function classifyLexical(memoryRoot: string, absolute: string): DegradedRoute {
  if (contains(memoryRoot, absolute)) return "memory";
  if (contains(absolute, memoryRoot)) return "ancestor";
  return "ordinary";
}

export async function degradedRoute(
  memoryRoot: string,
  requested: string,
  cwd: string,
  mode: "read" | "write",
  ctx: Parameters<typeof factoryPath>[3],
  signal?: AbortSignal,
): Promise<DegradedRoute> {
  let absolute: string;
  try {
    absolute = await factoryPath(requested, cwd, mode, ctx, signal);
  } catch {
    absolute = resolve(cwd, expandTilde(requested));
  }
  return classifyLexical(memoryRoot, absolute);
}

export const DEGRADED_FAULT = "Memory paused: memory storage is unavailable because the user directory could not be initialized";

export function degradedMemoryError(cause?: unknown): Error {
  const cause_ = cause === undefined ? "" : ` (${describeDegradedCause(cause)})`;
  return new Error(`${DEGRADED_FAULT}${cause_}; repair the user directory or Git configuration. Memory paths stay closed until it recovers.`);
}

export function describeDegradedCause(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
  const message = error instanceof Error ? error.message : "";
  if (code === "EACCES" || code === "EPERM") return "user directory not accessible";
  if (code === "ELOOP" || /too many symbolic links/i.test(message)) return "path resolution failed";
  if (/project identity/i.test(message)) return "project identity unavailable";
  if (code === "ENOENT") return "user directory missing";
  return "initialization failed";
}
