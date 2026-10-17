import { fork } from "node:child_process";
import { resolve } from "node:path";

export function fixtureChild(script: string, args: string[]) {
  const child = fork(resolve(script), args, { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const messages: Record<string, unknown>[] = [];
  const waiting: { event: string; resolve: (value: Record<string, unknown>) => void; reject: (err: Error) => void }[] = [];
  child.on("message", (raw) => {
    const value = raw as Record<string, unknown>;
    const index = waiting.findIndex((item) => item.event === value.event);
    if (index >= 0) waiting.splice(index, 1)[0].resolve(value);
    else messages.push(value);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      for (const item of waiting.splice(0)) item.reject(new Error(`Fixture exited ${code} before ${item.event}`));
      resolve(code);
    });
  });
  return {
    child, exited,
    async next(event: string): Promise<Record<string, unknown>> {
      const index = messages.findIndex((item) => item.event === event);
      if (index >= 0) return messages.splice(index, 1)[0];
      return new Promise((resolve, reject) => waiting.push({ event, resolve, reject }));
    },
    go() { child.send("continue"); },
  };
}
