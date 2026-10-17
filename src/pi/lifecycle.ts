import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { indexPrefix } from "../core/content-policy.js";
import type { MemoryStore } from "../core/store.js";
import { memoryGuidance, MEMORY_GUIDANCE_HEADER } from "./memory-guidance.js";
import { MEMORY_SECTION, setMemorySection } from "./system-section.js";
import type { MemoryActivity, ResetReason } from "./activity.js";
import { userError } from "./presentation.js";

export interface LifecycleRuntime {
  activity?: MemoryActivity;
  getStore(ctx: ExtensionContext): Promise<MemoryStore>;
  assertCompatible?(): void;
  reset(): void;
}
export interface LifecycleStatus { loaded: boolean; fault?: string }
const OPEN = `<${MEMORY_SECTION}>\n`;
const CLOSE = `\n</${MEMORY_SECTION}>`;
const PROJECTION_FAULT = "Memory paused: system section structure is unreliable; no new memory snapshot was injected into this request.";
const COMPATIBILITY_FAULT = "Memory paused: tool compatibility could not be confirmed, so no new memory snapshot was injected. Disable the conflicting extension and fully reload extensions; normal tasks can continue.";

function validateSection(text: string): void {
  if (!text.startsWith(OPEN + MEMORY_GUIDANCE_HEADER) || !text.endsWith(CLOSE)) throw new Error(PROJECTION_FAULT);
  const body = text.slice(OPEN.length, -CLOSE.length);
  if (body.includes(`<${MEMORY_SECTION}>`) || body.includes(`</${MEMORY_SECTION}>`)) throw new Error(PROJECTION_FAULT);
}

function stripContent(text: string): string {
  const opening = `<${MEMORY_SECTION}>`;
  const closing = `</${MEMORY_SECTION}>`;
  if (!text.includes(opening) && !text.includes(closing)) return text;
  const start = text.indexOf(opening);
  const end = text.indexOf(closing, start);
  if (start < 0 || end < 0 || (start > 0 && text[start - 1] !== "\n")
    || (end + closing.length < text.length && text[end + closing.length] !== "\n")
    || text.indexOf(opening, start + opening.length) !== -1
    || text.indexOf(closing, end + closing.length) !== -1) throw new Error(PROJECTION_FAULT);
  validateSection(text.slice(start, end + closing.length));
  return text.slice(0, start) + text.slice(end + closing.length);
}

export function projectMemorySection(messages: AgentMessage[], current: string): AgentMessage[] {
  if (messages[0]?.role !== "system") throw new Error(PROJECTION_FAULT);
  const wrapped = OPEN + current + CLOSE;
  validateSection(wrapped);
  const projected = messages.map((message) => {
    if (message.role !== "system") return message;
    const sections = { ...message.sections };
    const own = sections[MEMORY_SECTION];
    if (own !== undefined && own !== null) validateSection(own);
    delete sections[MEMORY_SECTION];
    const content = typeof message.content === "string"
      ? stripContent(message.content)
      : message.content.map((block) => ({ ...block, text: stripContent(block.text) }));
    return { ...message, content, sections };
  });
  const first = projected[0];
  if (first.role !== "system") throw new Error(PROJECTION_FAULT);
  projected[0] = { ...first, sections: { ...first.sections, [MEMORY_SECTION]: wrapped } };
  return projected.filter((message, i) => {
    const original = messages[i];
    if (i === 0 || message.role !== "system" || original.role !== "system") return true;
    const hadOwnSection = MEMORY_SECTION in (original.sections ?? {})
      || (typeof original.content === "string" ? original.content.includes(OPEN) : original.content.some((block) => block.text.includes(OPEN)));
    return !hadOwnSection
      || (typeof message.content === "string" ? message.content.length > 0 : message.content.some((block) => block.text.length > 0))
      || Object.keys(message.sections ?? {}).length > 0
      || message.toolsAdded !== undefined || message.toolsRemoved !== undefined;
  });
}

function withoutCurrentMemory(messages: AgentMessage[], current: string): AgentMessage[] {
  const wrapped = OPEN + current + CLOSE;
  return messages.map((message) => {
    if (message.role !== "system") return message;
    const sections = { ...message.sections };
    delete sections[MEMORY_SECTION];
    const removeCurrent = (text: string) => text.split(wrapped).join("");
    const content = typeof message.content === "string" ? removeCurrent(message.content)
      : message.content.map((block) => ({ ...block, text: removeCurrent(block.text) }));
    return { ...message, sections, content };
  });
}

export function registerLifecycle(pi: ExtensionAPI, runtime: LifecycleRuntime) {
  let generation = 0;
  let store: MemoryStore | undefined;
  let enabled: boolean | undefined;
  let attempted = false;
  let snapshot: string | undefined;
  let coverage: { store: MemoryStore; path: string; buffer: Buffer; end: number; generation: number } | undefined;
  let fault: string | undefined;
  const warn = (ctx: ExtensionContext, message: string) => {
    fault = message;
    runtime.activity?.fault(message);
    const display = userError(new Error(message), "记忆加载");
    if (ctx.hasUI) ctx.ui.notify(display, "warning");
    else pi.sendMessage({ customType: "memory_fault", content: display, display: true });
  };
  let compatibilityPaused = false;
  let withdrawnSnapshot: string | undefined;
  const dropProjection = () => {
    if (!compatibilityPaused) store?.invalidate();
    compatibilityPaused = true;
    runtime.activity?.pause(COMPATIBILITY_FAULT);
    withdrawnSnapshot ??= snapshot;
    attempted = true;
    snapshot = undefined;
    coverage = undefined;
  };
  const reset = (reason: ResetReason = "session") => {
    runtime.activity?.reset(reason);
    generation++;
    store?.invalidate();
    runtime.reset();
    store = undefined;
    enabled = undefined;
    attempted = false;
    snapshot = undefined;
    coverage = undefined;
    fault = undefined;
  };
  pi.on("session_start", () => reset());
  pi.on("session_tree", () => reset());
  pi.on("session_shutdown", () => reset());
  pi.on("before_agent_start", async (event, ctx) => {
    setMemorySection(event.systemPromptOptions);
    const entered = generation;
    try {
      if (compatibilityPaused) throw new Error(COMPATIBILITY_FAULT);
      runtime.assertCompatible?.();
    } catch {
      if (entered !== generation) return;
      dropProjection();
      warn(ctx, COMPATIBILITY_FAULT);
      return;
    }
    try {
      const current = await runtime.getStore(ctx);
      if (entered !== generation) return;
      store = current;
      if (current.child) { snapshot = undefined; coverage = undefined; enabled = false; return; }
      const config = await current.config.read();
      if (entered !== generation) return;
      if (config.status === "unknown" || !config.enabled) {
        if (enabled !== false) current.invalidate();
        if (enabled !== false) runtime.activity?.reset("toggle");
        enabled = false;
        attempted = false;
        snapshot = undefined;
        coverage = undefined;
        if (config.status === "unknown") warn(ctx, config.fault);
        else fault = undefined;
        return;
      }
      if (enabled === false) { current.invalidate(); attempted = false; snapshot = undefined; coverage = undefined; }
      enabled = true;
      if (!attempted && event.messageType === "user") {
        attempted = true;
        let index = "";
        let truncated = false;
        try {
          const result = await current.readBuffer(join(current.paths.projectDir, "MEMORY.md"));
          if (entered !== generation) return;
          const prefix = indexPrefix(result.buffer.toString("utf8"));
          index = prefix.prefix;
          truncated = prefix.truncated;
          const text = memoryGuidance(current.paths.projectDir, index, truncated);
          validateSection(OPEN + text + CLOSE);
          const returned = Buffer.from(index, "utf8");
          if (result.buffer.subarray(0, returned.length).equals(returned)) {
            coverage = { store: current, path: result.path, buffer: result.buffer, end: returned.length, generation: result.generation };
          }
          snapshot = text;
          runtime.activity?.prepared(index.length === 0);
        } catch (error) {
          if (entered !== generation) return;
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          snapshot = memoryGuidance(current.paths.projectDir, "", false);
          runtime.activity?.prepared(true);
        }
        fault = undefined;
      }
      if (entered === generation && snapshot !== undefined) setMemorySection(event.systemPromptOptions, snapshot);
    } catch {
      if (entered !== generation) return;
      try { runtime.assertCompatible?.(); }
      catch {
        dropProjection();
        warn(ctx, COMPATIBILITY_FAULT);
        return;
      }
      snapshot = undefined;
      coverage = undefined;
      warn(ctx, "Memory paused: index or memory configuration could not be read safely; normal tasks can continue. Use /memory reload, re-enter the session or re-enable memory to retry.");
    }
  });
  pi.on("context_with_system", (event, ctx) => {
    if (compatibilityPaused) {
      return withdrawnSnapshot === undefined ? undefined : { messages: withoutCurrentMemory(event.messages, withdrawnSnapshot) };
    }
    if (snapshot === undefined || enabled !== true) return;
    try {
      runtime.assertCompatible?.();
    } catch {
      const stale = snapshot;
      dropProjection();
      warn(ctx, COMPATIBILITY_FAULT);
      return { messages: withoutCurrentMemory(event.messages, stale) };
    }
    try {
      const messages = projectMemorySection(event.messages, snapshot);
      runtime.activity?.projected();
      if (coverage) {
        coverage.store.recordRange(coverage.path, coverage.buffer, 0, coverage.end, coverage.generation);
        coverage = undefined;
      }
      fault = undefined;
      return { messages };
    } catch {
      warn(ctx, PROJECTION_FAULT);
      return { messages: withoutCurrentMemory(event.messages, snapshot) };
    }
  });
  return { reset, status: (): LifecycleStatus => ({ loaded: snapshot !== undefined, ...(fault ? { fault } : {}) }) };
}
