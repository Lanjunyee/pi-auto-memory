import { basename } from "node:path";

export const compatibilityAdvice = "按顺序恢复：1) 运行 /memory doctor 定位标记为 failure 的冲突项；2) 停用提供同名不兼容工具的扩展；3) 完整重载 Pi 扩展以取得新实例；4) 再次运行 /memory doctor 复查。/memory reload 只安排索引刷新，不能解除兼容暂停。";

interface Classification {
  text: string;
  advice?: string;
  doctor: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : undefined;
}

function paused(message: string): Classification {
  if (/incompatible|compatibility|same-name tool override/i.test(message)) {
    return { text: "工具兼容性冲突，记忆暂时停用。", advice: compatibilityAdvice, doctor: true };
  }
  if (/auto-memory\.json/i.test(message)) {
    return { text: "配置文件 auto-memory.json 不可读取、损坏或版本不受支持。", advice: "请修复配置后再重试；未执行任何修复。", doctor: true };
  }
  if (/memory storage is unavailable|user directory could not be initialized/i.test(message)) {
    const cause = /\(([^)]*)\)/.exec(message)?.[1];
    const reason = cause === "user directory not accessible" ? "用户目录不可访问"
      : cause === "path resolution failed" ? "路径解析失败（符号链接环）"
      : cause === "project identity unavailable" ? "项目身份不可用"
      : cause === "user directory missing" ? "用户目录路径不存在"
      : "用户目录初始化失败";
    return { text: `记忆存储无法初始化：${reason}。`, advice: "请修复该目录的权限或路径后重新执行；同一状态下重复执行不会成功。记忆路径在此期间保持关闭，普通文件工具不受影响。", doctor: true };
  }
  if (/project identity/i.test(message)) {
    return { text: "项目身份不可用，记忆暂时停用。", advice: "请修复仓库或 Git 配置后重试。", doctor: true };
  }
  if (/system section/i.test(message)) {
    return { text: "系统提示区结构不可靠，未注入新的记忆快照。", advice: "请重新加载后重试。", doctor: true };
  }
  return { text: "记忆暂时停用，未能安全读取索引或配置。", advice: "可执行 /memory reload 安排下一条用户任务重试，或重新进入会话。", doctor: true };
}

function classify(error: unknown): Classification {
  const message = messageOf(error);
  if (message.startsWith("Memory ")) {
    if (message.startsWith("Memory paused:")) return paused(message);
    if (message.startsWith("Memory is off")) {
      return { text: "记忆已关闭，当前操作被拒绝。", advice: "请先执行 /memory on。", doctor: false };
    }
    if (message.startsWith("Memory save rejected:")) {
      if (/detected /.test(message)) return { text: "保存被拒绝：检测到疑似敏感凭据，未写入文件。", advice: "请移除秘密，改用不含凭据的引用。", doctor: false };
      if (/malformed/.test(message)) return { text: "保存被拒绝：前置元数据格式无效或不受支持，未写入文件。", advice: "请修复元数据后重试。", doctor: false };
      if (/no complete read baseline/.test(message)) return { text: "保存被拒绝：缺少完整读取基线，文件未写入。", advice: "请重新完整读取文件后再保存。", doctor: false };
      return { text: "保存被拒绝，文件未写入。", advice: "请重新读取文件后再试。", doctor: false };
    }
    if (message.startsWith("Memory conflict:")) {
      if (/removed/.test(message)) return { text: "保存冲突：文件已被移除。", advice: "请重新读取后再保存。", doctor: false };
      return { text: "保存冲突：文件版本已变化。", advice: "请重新完整读取后再保存。", doctor: false };
    }
    if (message.startsWith("Memory delete rejected:")) {
      if (/regular file/.test(message)) return { text: "删除被拒绝：目标必须是普通文件。", doctor: true };
      return { text: "删除被拒绝：请重新确认要删除的同一目标。", advice: "请重新执行删除确认。", doctor: false };
    }
    if (message.startsWith("Memory delete conflict:")) return { text: "删除冲突：目标已变化或消失。", advice: "请重新确认删除目标。", doctor: false };
    if (message.startsWith("Memory delete invalidated")) return { text: "删除已失效：会话已变化。", advice: "请重新确认删除。", doctor: false };
    if (message.startsWith("Memory path rejected:")) return { text: "路径安全检查拒绝：仅支持当前项目内、非符号链接的记忆文件。", advice: "请改用当前项目的相对路径。", doctor: true };
    if (message.startsWith("Memory target must be")) return { text: "目标必须是当前项目的相对文件名，不允许绝对路径或“..”。", doctor: false };
    if (message.startsWith("Memory target changed")) return { text: "目标在执行期间发生变化。", advice: "请重新读取后重试。", doctor: false };
    if (message.startsWith("Memory file disappeared")) return { text: "记忆文件已消失，无法查看；请重新打开列表。", doctor: false };
    if (message.startsWith("Memory file not found")) return { text: "记忆文件尚不存在，可以直接创建。", advice: "请按需要新建主题或索引文件。", doctor: false };
    if (message.startsWith("Memory file is no longer available")) return { text: "记忆文件已不可用；请重新打开列表。", doctor: false };
    if (message.startsWith("Memory parent is not a directory")) return { text: "记忆路径的父级不是目录；请检查路径。", advice: "请确认项目记忆路径未被替换。", doctor: true };
    if (message.startsWith("Memory edit requires")) return { text: "编辑需要交互式编辑器（TUI 或 RPC），未改动文件。", doctor: false };
    if (message.startsWith("Memory delete requires")) return { text: "删除需要显式确认界面，未删除文件。", advice: "请在支持确认界面的交互式会话中重试。", doctor: true };
    if (/needs a relative file name/.test(message)) return { text: "该操作需要相对文件名和交互界面。", advice: "请在支持交互界面的会话中提供当前项目的相对文件名。", doctor: false };
    if (/browsing invalidated/.test(message)) return { text: "会话变化使文件浏览失效。", advice: "请重新打开文件列表。", doctor: false };
    if (/edit invalidated/.test(message)) return { text: "会话变化使编辑失效。", advice: "请重新打开编辑器。", doctor: false };
    if (/reload invalidated/.test(message)) return { text: "会话变化使刷新失效。", advice: "请在当前会话重试。", doctor: false };
    if (/diagnosis invalidated/.test(message)) return { text: "会话变化使诊断失效。", advice: "请在当前会话重试。", doctor: false };
    if (/operation invalidated/.test(message)) return { text: "会话变化使旧操作失效。", advice: "请重新读取后重试。", doctor: false };
    if (/runner child/.test(message)) return { text: "当前为 runner 子会话，不支持项目记忆。", doctor: false };
    return { text: "记忆操作未能完成，未报告成功变更。", advice: "可运行 /memory doctor 查看诊断。", doctor: false };
  }
  const code = codeOf(error);
  if (code === "EACCES" || code === "EPERM") return { text: "权限不足或访问被拒绝，未报告成功变更。", advice: "请检查路径与权限后重试。", doctor: true };
  if (code === "ENOENT") return { text: "文件或路径不存在，未报告成功变更。", advice: "请确认目标路径后重试。", doctor: true };
  return { text: "访问失败（未知错误），未报告成功变更。", advice: "请重试；不会显示底层异常信息。", doctor: true };
}

export function faultSummary(error: unknown): string {
  const result = classify(error);
  return result.advice ? `${result.text} ${result.advice}` : result.text;
}

export function userError(error: unknown, operation?: string): string {
  const result = classify(error);
  const parts = [`${operation ? `${operation}失败：` : ""}${result.text}`];
  if (result.advice) parts.push(result.advice);
  if (result.doctor && !parts.join(" ").includes("/memory doctor")) parts.push("可运行 /memory doctor 查看诊断。");
  return parts.join(" ");
}

export function formatSave(note: string, path: string): string {
  if (basename(path) !== "MEMORY.md") return "主题文件已保存；本次保存未核实 MEMORY.md 关联。请检查已有入口，仅在缺失或过时时更新；主题仍由模型按需读取，保存不代表已注入当前请求或必然被召回。";
  if (/exceeds 200 lines or 25KiB/.test(note)) return "索引文件已保存，但超过 200 行或 25KiB 上限，无法完整加载。请精简索引；执行 /memory reload 后下一条用户任务生效。";
  if (/near its 200-line/.test(note)) return "索引文件已保存，但接近 200 行 / 25KiB 上限，建议精简。当前快照不会自动更新；执行 /memory reload 后下一条用户任务生效。";
  return "索引文件已保存。当前快照不会自动更新；执行 /memory reload 后，下一条用户任务会重载索引。";
}
