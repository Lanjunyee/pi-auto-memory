export const MEMORY_SECTION = "auto_memory";

export function setMemorySection(options: { sections: Record<string, string> }, text?: string): void {
  if (text === undefined) delete options.sections[MEMORY_SECTION];
  else options.sections[MEMORY_SECTION] = text;
}
