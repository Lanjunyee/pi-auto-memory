import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { indexPrefix } from "../core/content-policy.js";
import { MemoryStore } from "../core/store.js";
import type { MemoryRuntime } from "./registration.js";
import { diagnoseMemory, formatDoctor } from "./doctor.js";
import { MemoryConfig } from "../core/config.js";
import { MemoryPaths } from "../core/paths.js";
import type { ActivitySnapshot } from "./activity.js";
import { faultSummary, formatSave, userError } from "./presentation.js";
import { degradedMemoryError } from "./degraded-path.js";

export interface CommandOptions {
  lifecycleState?: () => { loaded: boolean; fault?: string };
  resetLifecycle?: (reason?: "refresh" | "toggle") => void;
}
const usage = "用法：/memory status | doctor | on | off | list | reload | edit <项目内相对文件> | delete <项目内相对文件>。交互式 /memory 打开菜单。list 选择文件进行只读查看；无界面或记忆关闭时只报告文件名。delete 需要确认，不提供 force 或全部清除选项。";
const scope = (agentDir: string) => `开关范围：同一 Pi 用户目录（agentDir）下所有项目；记忆文件按项目隔离；其他会话在下一任务或访问检查时感知变化。当前 agentDir：${agentDir}。`;
const manualNote = "手工修改在下一次加载时生效；/memory reload 将刷新安排到下一条用户任务，并使旧的受管理读取与待提交编辑或保存失效。关闭记忆会保留文件；关闭或刷新后历史上下文仍保留。";
const summaryScope = "摘要范围：仅当前扩展实例在本会话观察到的活动；外部写入不可见；不代表模型理解或遵循记忆。";
const operationNames: Record<string, string> = { status: "状态查询", doctor: "诊断", list: "文件列表", reload: "刷新", edit: "编辑", delete: "删除", on: "开启记忆", off: "关闭记忆" };

class CommandError extends Error {}

function snapshotStatus(activity: ActivitySnapshot, enabled: boolean): string[] {
  const lines: string[] = [];
  if (activity.fault) lines.push(`索引快照：暂停。原因：${faultSummary(new Error(activity.fault))}`);
  else if (!enabled) lines.push("索引快照：未加载（记忆未启用）。");
  else if (activity.phase === "initial") lines.push("索引快照：等待首次用户任务加载。");
  else if (activity.phase === "refresh") lines.push("索引快照：刷新已安排，等待下一条用户任务加载。");
  else if (activity.phase === "prepared") lines.push("索引快照：已准备，等待该请求成功注入。");
  else lines.push(`索引快照：已成功注入（首次投影时间：${activity.projectedAt ?? "未知"}）。${activity.empty ? "当前为空索引（没有 MEMORY.md 内容）。" : ""}`);
  if (activity.changed) lines.push("已知索引变更：本实例已修改或删除 MEMORY.md，但当前快照尚未刷新；执行 /memory reload 后在下一条用户任务生效。");
  lines.push(activity.lastSave
    ? `最近保存：${activity.lastSave.path}（来源：${activity.lastSave.source === "model" ? "模型工具" : "用户编辑"}，时间：${activity.lastSave.at}）。`
    : "最近保存：本会话未观察到受管理保存。");
  if (!activity.topics.length) lines.push("本会话未观察到向模型返回的记忆主题正文；这不代表磁盘为空或模型未使用历史。");
  else {
    lines.push(`已向模型返回正文的主题（最近 ${activity.topics.length} 个，最多 20 个）：`,
      ...activity.topics.map((topic) => `  - ${topic.path}（${topic.complete ? "完整读取" : "局部读取"}，时间：${topic.at}）`));
    if (activity.truncated) lines.push("主题摘要已截断：仅保留最近 20 个主题。");
  }
  if (!enabled || activity.fault) lines.push("以上保存和读取均为历史记录；当前不注入索引，历史读取不构成当前读取许可。");
  lines.push(summaryScope);
  return lines;
}

async function relativeTarget(store: MemoryStore, name: string): Promise<string> {
  if (!name || isAbsolute(name) || name.split(/[\\/]/).includes("..") || name === ".") {
    throw new CommandError("目标必须是当前项目的相对文件名；不允许绝对路径或“..”。");
  }
  return store.paths.assertCurrent(join(store.paths.projectDir, name));
}
async function fileNames(store: MemoryStore, validate: () => Promise<unknown> = async () => {}): Promise<string[]> {
  const names: string[] = [];
  async function walk(directory: string): Promise<void> {
    await validate();
    await store.paths.assertCurrent(directory);
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    await validate();
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) names.push(relative(store.paths.projectDir, path).split(sep).join("/"));
    }
  }
  await walk(store.paths.projectDir);
  return names.sort();
}

export function registerCommands(pi: ExtensionAPI, runtime: MemoryRuntime, options: CommandOptions = {}): void {
  pi.registerCommand("memory", {
    description: "管理和诊断本地项目自动记忆：状态、诊断、开启/关闭、列表、刷新、编辑或确认删除",
    handler: async (args, ctx) => {
      let operationName = "";
      const report = (text: string, level: "info" | "warning" | "error" = "info") => {
        if (ctx.hasUI) ctx.ui.notify(text, level);
        else pi.sendMessage({ customType: "memory_status", content: text, display: true });
      };
      try {
        const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
        let operation = match?.[1];
        const target = match?.[2];
        operationName = operation ? operationNames[operation] ?? "" : "";
        const doctor = async () => {
          const context = runtime.diagnostics?.(ctx);
          if (!context) { report("记忆诊断不可用：当前运行时未提供诊断观察。", "warning"); return; }
          const checks = await diagnoseMemory(context);
          context.assertCurrent();
          report(formatDoctor(checks));
        };
        if (operation === "doctor") {
          if (target) report(usage, "warning");
          else await doctor();
          return;
        }
        if (!operation && ctx.hasUI && ctx.mode === "tui" && runtime.diagnostics) {
          const context = runtime.diagnostics(ctx);
          const lines = ["记忆管理", `项目目录：${ctx.cwd}`];
          try {
            const state = await (await MemoryConfig.create(context.agentDir)).read();
            context.assertCurrent();
            const tools = context.tools();
            const effective = context.child ? "不可用（runner 子会话不受支持）" : state.status === "unknown" ? `暂停（${faultSummary(new Error(state.fault))}）`
              : tools.paused || tools.entries.some((tool) => tool.conflict) ? "暂停（工具兼容冲突）" : state.enabled ? "开启" : "关闭";
            lines.push(`记忆：${effective}`, scope(context.agentDir));
            if (!context.child) {
              const project = await context.identify();
              const paths = await MemoryPaths.create(context.agentDir, project.projectId);
              lines.push(`项目记忆：${paths.projectDir}`);
            }
          } catch { lines.push("部分状态或项目信息不可用；可选择“诊断”查看。"); }
          context.assertCurrent();
          const choice = await ctx.ui.select(lines.join("\n"), ["列出文件", "刷新", "状态", "诊断", "开启", "关闭", "编辑文件", "删除文件"]);
          context.assertCurrent();
          if (choice === "诊断") { operationName = operationNames.doctor; await doctor(); return; }
          const operations: Record<string, string> = { "列出文件": "list", "刷新": "reload", "状态": "status", "开启": "on", "关闭": "off", "编辑文件": "edit", "删除文件": "delete" };
          if (!choice || !operations[choice]) return;
          operation = operations[choice];
          operationName = operationNames[operation] ?? "";
        }
        const store = await runtime.getStore(ctx).catch((error: unknown) => {
          throw new Error(degradedMemoryError(error).message);
        });
        const reset = (reason: "refresh" | "toggle") => {
          if (options.resetLifecycle) options.resetLifecycle(reason);
          else { runtime.activity?.reset(reason); runtime.reset(); }
        };
        const effectiveState = async () => {
          const state = await store.config.read();
          if (store.child) return { state, text: "不可用（runner 子会话不受支持）", usable: false };
          if (state.status === "unknown") return { state, text: `暂停（${faultSummary(new Error(state.fault))}）`, usable: false };
          return { state, text: state.enabled ? "开启" : "关闭", usable: state.enabled };
        };
        const status = async () => {
          const { state, text: effective, usable } = await effectiveState();
          const lifecycle = options.lifecycleState?.();
          const observed = runtime.activity?.snapshot();
          const lines = [`记忆：${effective}`, `项目目录：${ctx.cwd}`];
          lines.push(store.projectLocationTrusted
            ? `项目记忆：${store.paths.projectDir}`
            : "项目记忆：不可用（项目身份未建立；不展示替代路径，请修复仓库或 Git 配置后重试）。");
          lines.push(scope(store.config.agentDir),
            "索引快照内容为前 200 行 / 25KiB，在会话进入、重新开启或 /memory reload 后的第一条用户任务加载。");
          if (observed) lines.push(...snapshotStatus(observed, usable));
          else {
            lines.push(`索引快照：${lifecycle?.loaded ? "已加载" : "尚未加载"}${lifecycle?.fault ? `；原因：${faultSummary(new Error(lifecycle.fault))}` : ""}。`);
          }
          lines.push(manualNote);
          if (state.status === "known" && !state.enabled) lines.push("记忆已关闭：文件和历史保留，新的受管理正文访问与保存会被拒绝。");
          const text = lines.join("\n");
          report(text);
          return text;
        };
        const ensureSupported = () => { if (store.child) throw new CommandError("记忆不可用：runner 子会话不受支持。"); };
        const toggle = async (enabled: boolean) => {
          ensureSupported();
          await store.config.setEnabled(enabled);
          reset("toggle");
          report(enabled
            ? `记忆已开启；快照将在下一条用户任务时加载。${scope(store.config.agentDir)}历史上下文不会被清除。`
            : `记忆已关闭；同一 agentDir 下所有项目停止新的记忆使用，文件和历史保留。${scope(store.config.agentDir)}历史上下文不会被清除。`);
        };
        const reload = async () => {
          ensureSupported();
          const reloadStore = store.fork();
          const state = await store.config.read();
          reloadStore.assertLifecycle();
          if (state.status === "unknown") throw new Error(state.fault);
          if (!state.enabled) throw new Error("Memory is off; turn it on with /memory on before reloading.");
          await reloadStore.access(store.paths.projectDir);
          if (await runtime.getStore(ctx) !== store) throw new CommandError("会话已变化，刷新已失效；请在当前会话重试。");
          reloadStore.assertLifecycle();
          reset("refresh");
          report("记忆快照已重置；下一条用户任务将重载索引。旧的受管理读取与待提交编辑或保存已失效；请重新打开编辑器并重新读取后再保存。历史上下文仍保留。");
        };
        const chooseTarget = async (name: string | undefined, operation: "edit" | "delete") => {
          if (name) return relativeTarget(store, name);
          if (!ctx.hasUI) throw new CommandError(`记忆${operation === "edit" ? "编辑需要相对文件名和交互式编辑器" : "删除需要相对文件名和交互式确认"}。${usage}`);
          const names = await fileNames(store);
          if (!names.length) { report("记忆：没有可选择的项目文件。"); return undefined; }
          const selected = await ctx.ui.select(`记忆${operation === "edit" ? "编辑：选择一个文件" : "删除：选择一个文件"}`, names);
          return selected === undefined ? undefined : relativeTarget(store, selected);
        };
        const edit = async (name?: string) => {
          ensureSupported();
          if (!ctx.hasUI) throw new CommandError("记忆编辑需要交互式编辑器（TUI 或 RPC）；未直接修改文件。");
          await store.access(store.paths.projectDir);
          const path = await chooseTarget(name, "edit");
          if (!path) return;
          const editorStore = store.fork("user");
          const content = await editorStore.readFull(path);
          const temporary = await mkdtemp(join(store.paths.agentDir, ".auto-memory-edit-"));
          try {
            await writeFile(join(temporary, "draft.md"), content, { mode: 0o600, flag: "wx" });
            const edited = await ctx.ui.editor(`记忆编辑：${relative(store.paths.projectDir, path)}`, content);
            if (edited === undefined) { report("已取消编辑；文件未更改。"); return; }
            if (await runtime.getStore(ctx) !== store) throw new CommandError("会话已变化，编辑已失效；请重新打开编辑器。");
            const saved = await editorStore.write(path, edited);
            report(formatSave(saved.note, path), saved.isError ? "error" : "info");
          } finally {
            await rm(temporary, { recursive: true, force: true }).catch(() => report("记忆临时文件清理失败；已报告的提交结果仍然有效。", "warning"));
          }
        };
        const remove = async (name?: string) => {
          ensureSupported();
          if (!ctx.hasUI) throw new CommandError("记忆删除需要显式确认界面；未删除文件，也不提供 force 选项。");
          const path = await chooseTarget(name, "delete");
          if (!path) return;
          const deleteTarget = await store.prepareDelete(path);
          const confirmed = await ctx.ui.confirm("删除一个记忆文件？", `${deleteTarget.path}\n仅删除这一个文件。本扩展不提供撤销，也不会清除历史上下文或永久阻止重新记住。`);
          const result = await store.deleteConfirmed(deleteTarget, confirmed);
          report(result.deleted ? "记忆文件已删除。历史上下文仍保留；这不是永久忘记，本扩展不提供撤销。" : "已取消删除；文件未更改。");
        };
        const list = async () => {
          ensureSupported();
          const browserStore = store.fork();
          const validate = async () => {
            try {
              browserStore.assertLifecycle();
              const state = await store.config.read();
              if (state.status === "unknown") throw new Error(state.fault);
              if (await runtime.getStore(ctx) !== store) throw new CommandError("会话已变化，文件浏览已失效；请重新打开列表。");
              browserStore.assertLifecycle();
              return state.enabled;
            } catch (error) {
              if (error instanceof Error && error.message.startsWith("Memory operation invalidated")) {
                throw new CommandError("会话变化，文件浏览已失效；请重新打开列表。");
              }
              throw error;
            }
          };
          for (;;) {
            await validate();
            const names = await fileNames(store, validate);
            const enabled = await validate();
            if (!names.length) report("记忆：没有可选择的项目文件。");
            if (!enabled || !ctx.hasUI) {
              if (names.length) report(`记忆文件：\n${names.join("\n")}`);
              if (!enabled) report("记忆已关闭；执行 /memory on 后可查看文件内容。");
              return;
            }
            if (!names.length) return;
            const selected = await ctx.ui.select("记忆列表：选择一个文件查看", names);
            if (selected === undefined) return;
            if (!await validate()) throw new Error("Memory is off; turn it on with /memory on to view file contents.");
            if (!names.includes(selected)) throw new CommandError("记忆文件已不可用；请重新打开列表。");
            const path = await relativeTarget(store, selected);
            let content: string;
            try { content = (await browserStore.readBuffer(path)).buffer.toString("utf8"); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CommandError("记忆文件已消失，无法查看；请重新打开列表。");
              throw error;
            }
            if (!await validate()) throw new Error("Memory is off; turn it on with /memory on to view file contents.");
            await browserStore.access(path);
            browserStore.assertLifecycle();
            const prefix = indexPrefix(content);
            await ctx.ui.editor(`${selected} 只读查看 — 前 200 行 / 25KiB${prefix.truncated ? "（已截断）" : ""}`, prefix.prefix);
            report("记忆查看已关闭；未保存任何内容。");
          }
        };
        if (operation === "status" && !target) { await status(); return; }
        if (operation === "on" && !target) { await toggle(true); return; }
        if (operation === "off" && !target) { await toggle(false); return; }
        if (operation === "list" && !target) { await list(); return; }
        if (operation === "reload" && !target) { await reload(); return; }
        if (operation === "edit") { await edit(target); return; }
        if (operation === "delete") { await remove(target); return; }
        if (operation) { report(usage, "warning"); return; }
        if (!ctx.hasUI || ctx.mode !== "tui") { await status(); report(usage); return; }
        const current = await status();
        const choice = await ctx.ui.select(current, ["列出文件", "刷新", "状态", "诊断", "开启", "关闭", "编辑文件", "删除文件"]);
        if (choice === "列出文件") { operationName = operationNames.list; await list(); }
        else if (choice === "刷新") { operationName = operationNames.reload; await reload(); }
        else if (choice === "状态") { operationName = operationNames.status; await status(); }
        else if (choice === "诊断") { operationName = operationNames.doctor; await doctor(); }
        else if (choice === "开启") { operationName = operationNames.on; await toggle(true); }
        else if (choice === "关闭") { operationName = operationNames.off; await toggle(false); }
        else if (choice === "编辑文件") { operationName = operationNames.edit; await edit(); }
        else if (choice === "删除文件") { operationName = operationNames.delete; await remove(); }
      } catch (error) {
        report(error instanceof CommandError ? error.message : userError(error, operationName || undefined), "error");
      }
    },
  });
}
