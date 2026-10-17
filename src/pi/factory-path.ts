import { createReadToolDefinition, createWriteToolDefinition, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";

export async function factoryPath(path: string, cwd: string, mode: "read" | "write", ctx: ExtensionToolContext, signal?: AbortSignal): Promise<string> {
  let absolute: string | undefined;
  const capture = async (value: string): Promise<never> => { absolute = value; throw new Error("path probe complete"); };
  let error: unknown;
  if (mode === "read") {
    await createReadToolDefinition(cwd, { operations: { access: capture, readFile: capture } })
      .execute("memory-path-probe", { path }, signal, undefined, ctx).catch((err) => { error = err; });
  } else {
    await createWriteToolDefinition(cwd, { operations: { mkdir: async () => {}, writeFile: capture } })
      .execute("memory-path-probe", { path, content: "" }, signal, undefined, ctx).catch((err) => { error = err; });
  }
  if (!absolute) throw error ?? new Error("Memory path resolution failed.");
  return absolute;
}
