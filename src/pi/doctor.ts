import { constants, type Stats } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { join } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { MemoryConfig, resolveEffectiveState } from "../core/config.js";
import { MemoryPaths } from "../core/paths.js";
import { hostVersionStatus, SUPPORTED_HOST_RANGE } from "../core/constants.js";
import type { DiagnosticContext } from "./registration.js";
import { existingBinary } from "./scan-binary.js";
import { compatibilityAdvice } from "./presentation.js";

export interface DoctorCheck {
  id: string;
  level: "ok" | "warning" | "failure" | "unchecked";
  reason: string;
  advice?: string;
}
export interface DoctorOptions {
  nodeVersion?: string;
  hostVersion?: string | null;
  metadata?: (path: string) => Promise<Stats>;
  permissions?: typeof access;
  binary?: typeof existingBinary;
}

export async function diagnoseMemory(context: DiagnosticContext, options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (id: string, level: DoctorCheck["level"], reason: string, advice?: string) => checks.push({ id, level, reason, ...(advice ? { advice } : {}) });
  const probe = async <T>(action: () => Promise<T>): Promise<T> => {
    context.assertCurrent();
    try { return await action(); }
    finally { context.assertCurrent(); }
  };
  context.assertCurrent();
  const node = options.nodeVersion ?? process.versions.node;
  const parts = node.split(".").map(Number);
  const supportedNode = parts.length === 3 && parts.every(Number.isInteger)
    && (parts[0] > 22 || (parts[0] === 22 && (parts[1] > 19 || (parts[1] === 19 && parts[2] >= 0))));
  add("runtime.node", supportedNode ? "ok" : "failure", supportedNode ? `Node ${node}；最低要求 22.19.0。` : "Node 版本低于最低要求 22.19.0。", supportedNode ? undefined : "请使用 Node 22.19.0 或更新版本。");
  const host = options.hostVersion === undefined ? VERSION : options.hostVersion;
  const hostStatus = hostVersionStatus(host);
  const range = `已验证范围 ${SUPPORTED_HOST_RANGE.min} 至 ${SUPPORTED_HOST_RANGE.max}`;
  add("runtime.pi", hostStatus === "ok" ? "ok" : hostStatus === "unchecked" ? "unchecked" : "warning",
    hostStatus === "unchecked" ? "无法可靠获取当前 pi 版本。"
      : hostStatus === "ok" ? `pi ${host} 属于${range}。`
      : `当前 pi ${host} 超出${range}。`,
    hostStatus === "out-of-range" ? "请检查正在运行的 pi 安装；该版本之外的兼容性尚未验证。" : undefined);
  add("runtime.scope", context.child ? "failure" : "ok", context.child ? "runner 子会话不受支持；已跳过项目记忆检查。" : "当前为独立主会话；其他平台和扩展组合需要单独验证。");
  try {
    const config = await probe(async () => (await MemoryConfig.create(context.agentDir)).inspect());
    if (config.status === "known") add("config", "ok", config.missing ? "配置不存在；全局记忆默认开启，项目默认继承。" : `配置有效；全局开关${config.enabled ? "开启" : "关闭"}${config.data.version === 2 ? "，包含项目设置" : ""}。`);
    else {
      const reasons = { "unreadable": "配置无法读取。", "unsafe-path": "配置路径不是普通文件或属于符号链接。", "invalid-format": "配置格式无效。", "unsupported-version": "配置版本不受支持。" };
      add("config", "failure", reasons[config.reason], "请检查 auto-memory.json 的格式、版本、路径或权限并进行修复；本次未执行任何修复。");
    }
  } catch { add("config", "failure", "无法安全检查配置位置。", "请检查 agent 目录及其权限。"); }
  context.assertCurrent();
  try {
    const tools = context.tools();
    for (const tool of tools.entries) add(`tool.${tool.name}`, tool.conflict ? "failure" : "ok",
      tool.conflict ? "存在同名工具的所有权或参数结构冲突。" : !tool.registered ? "未注册；未检测到冲突。" : `已注册；${tool.active ? "启用" : "停用"}；所有权和参数结构兼容。`,
      tool.conflict ? compatibilityAdvice : undefined);
    add("tools.pause", tools.paused ? "failure" : "ok", tools.paused ? "当前运行时记录了一次工具兼容暂停。" : "当前未记录工具兼容暂停。",
      tools.paused ? "按顺序处理：运行 /memory doctor 定位冲突项，停用冲突扩展，完整重载 Pi 扩展取得新实例，然后再次运行 /memory doctor。一次正常检查不会清除已有暂停。" : undefined);
  } catch { add("tools", "unchecked", "无法检查工具注册状态。", "请在当前 pi 会话中重试。"); }
  context.assertCurrent();
  for (const tool of ["rg", "fd"] as const) {
    try {
      await probe(() => (options.binary ?? existingBinary)(tool, context.agentDir));
      add(`scan.${tool}`, "ok", `已找到可用的 ${tool === "fd" ? "fd/fdfind" : tool} 可执行文件；未执行它。`);
    } catch {
      add(`scan.${tool}`, "warning", `未找到 ${tool === "fd" ? "fd/fdfind" : tool}；相关受保护扫描受限。`, "请在 agentDir/bin 或 PATH 中安装所需的扫描工具；其他记忆操作仍可能可用。");
    }
    context.assertCurrent();
  }
  if (context.child) {
    add("project.identity", "unchecked", "runner 子会话不检查项目身份。");
    add("project.directory", "unchecked", "runner 子会话不检查项目记忆路径。");
    add("project.index", "unchecked", "runner 子会话不检查索引元数据。");
  } else {
    let paths: MemoryPaths | undefined;
    let projectId: string | undefined;
    try {
      const project = await probe(() => context.identify());
      projectId = project.projectId;
      paths = await probe(() => MemoryPaths.create(context.agentDir, project.projectId));
      add("project.identity", "ok", `已解析${project.kind === "git" ? " Git 仓库" : "工作目录"}项目身份。`);
    } catch {
      add("project.identity", "failure", "项目身份或其记忆位置不可用。", "请修复仓库、Git 配置或 agent 目录；本次未检查回退路径。");
    }
    context.assertCurrent();
    if (projectId) {
      const inspection = await probe(async () => (await MemoryConfig.create(context.agentDir)).inspect());
      if (inspection.status === "known") {
        const effective = resolveEffectiveState(inspection, projectId);
        add("project.setting", "ok", effective.status === "known" && effective.projectPolicy === "disabled"
          ? "当前项目设置：禁用（不改变全局开关）。"
          : "当前项目设置：继承全局开关。");
      } else add("project.setting", "unchecked", "配置不可读取；未检查项目设置。");
    } else add("project.setting", "unchecked", "项目身份不可用；已跳过项目设置检查。");
    context.assertCurrent();
    if (!paths) {
      add("project.directory", "unchecked", "项目身份不可用；已跳过目录检查。");
      add("project.index", "unchecked", "项目身份不可用；已跳过索引检查。");
    } else {
      const metadata = options.metadata ?? lstat;
      const permissions = options.permissions ?? access;
      const inspectPath = async (id: string, path: string, directory: boolean): Promise<boolean> => {
        try {
          await probe(() => paths!.assertCurrent(path));
          let info;
          try { info = await probe(() => metadata(path)); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              add(id, "ok", directory ? "项目记忆目录不存在；新项目属正常情况。" : "索引不存在；属于正常空记忆。");
              return true;
            }
            throw error;
          }
          if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) {
            add(id, "failure", "文件类型异常或为符号链接。", "请检查当前项目记忆路径；未经审阅不要替换文件。");
            return false;
          }
          await probe(() => permissions(path, constants.R_OK | (directory ? constants.X_OK : 0)));
          await probe(() => paths!.assertCurrent(path));
          const oversized = !directory && info.size > 25 * 1024;
          add(id, oversized ? "warning" : "ok", directory ? "项目记忆目录可安全访问。"
            : `索引大小：${info.size} 字节；${oversized ? "25KiB 加载上限会截断它" : "在 25KiB 字节上限内"}。未检查 200 行上限。`,
          oversized ? "请使用 /memory edit MEMORY.md 精简索引；doctor 未读取或修改正文。" : undefined);
          return true;
        } catch (error) {
          context.assertCurrent();
          const code = (error as NodeJS.ErrnoException).code;
          const reason = error instanceof Error && error.message.startsWith("Memory path rejected:")
            ? "路径安全检查拒绝了符号链接或无效的父级类型。"
            : code === "EACCES" || code === "EPERM" ? "读取或遍历权限不可用。"
            : "无法验证路径安全或读取/遍历权限。";
          add(id, "failure", reason, "请检查当前项目记忆路径中的链接、文件类型和权限；未更改任何权限。");
          return false;
        }
      };
      const safeDirectory = await inspectPath("project.directory", paths.projectDir, true);
      if (safeDirectory) await inspectPath("project.index", join(paths.projectDir, "MEMORY.md"), false);
      else add("project.index", "unchecked", "项目目录检查失败；已跳过索引元数据检查。");
    }
  }
  context.assertCurrent();
  return checks;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return ["记忆 doctor：仅做当前时刻的只读检查；未执行修复。",
    ...checks.map((check) => `[${check.level}] ${check.id}：${check.reason}${check.advice ? ` 下一步：${check.advice}` : ""}`),
    "未检查记忆正文和索引的 200 行上限。未更改开关、快照、受管理读取许可或任何待处理操作。这些检查不保证未来保存一定成功。",
  ].join("\n");
}
