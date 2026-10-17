import assert from "node:assert/strict";
import test from "node:test";
import { compatibilityAdvice, faultSummary, formatSave, userError } from "../src/pi/presentation.js";

test("known memory errors are classified in Chinese without exposing raw text", () => {
  const cases: [string, RegExp][] = [
    ["Memory is off; managed body access and saves are rejected.", /记忆已关闭.*\/memory on/],
    ["Memory paused: incompatible same-name tool override (read); disable the conflicting extension.", /工具兼容性冲突.*完整重载/],
    ["Memory paused: auto-memory.json is unreadable, corrupt or unsupported; repair it before retrying.", /auto-memory\.json.*修复配置/],
    ["Memory paused: project identity is unavailable; repair the repository or Git configuration.", /项目身份不可用/],
    ["Memory paused: system section structure is unreliable; no new memory snapshot was injected into this request.", /系统提示区结构不可靠/],
    ["Memory save rejected: detected provider-token; remove sensitive data or use a secret-free reference.", /检测到疑似敏感凭据/],
    ["Memory save rejected: malformed YAML frontmatter; repair metadata before retrying.", /元数据格式无效/],
    ["Memory save rejected: no complete read baseline; read all remaining ranges, then retry.", /缺少完整读取基线/],
    ["Memory conflict: stale version; reread the complete file and retry.", /保存冲突：文件版本已变化/],
    ["Memory conflict: file was removed; reread and retry.", /保存冲突：文件已被移除/],
    ["Memory delete rejected: prepare and confirm the exact target again.", /重新确认/],
    ["Memory delete conflict: target changed; confirm again.", /删除冲突/],
    ["Memory delete invalidated by a session change; confirm again.", /删除已失效/],
    ["Memory path rejected: only the current project is supported.", /路径安全检查拒绝/],
    ["Memory target must be a current-project relative file name; absolute paths and '..' are not allowed.", /相对文件名/],
    ["Memory target changed during tool execution; reread and retry.", /目标在执行期间发生变化/],
    ["Memory file disappeared; unable to view it. Reopen the list.", /记忆文件已消失/],
    ["Memory file is no longer available; reopen the list.", /记忆文件已不可用/],
    ["Memory edit requires an interactive editor UI (TUI or RPC); no direct file edit was made.", /记忆编辑需要交互式编辑器|编辑需要交互式编辑器/],
    ["Memory delete requires explicit confirmation UI; no file was deleted. There is no force option.", /删除需要显式确认界面/],
    ["Memory browsing invalidated by a session change; reopen the list.", /会话变化使文件浏览失效/],
    ["Memory edit invalidated by a session change; reopen the editor.", /会话变化使编辑失效/],
    ["Memory reload invalidated by a session change; retry in the current session.", /会话变化使刷新失效/],
    ["Memory diagnosis invalidated by a session change; retry in the current session.", /会话变化使诊断失效/],
    ["Memory operation invalidated by a session change; reread and retry.", /会话变化使旧操作失效/],
    ["Memory unavailable: runner child is unsupported.", /runner 子会话，不支持/],
    ["Memory operation failed; no successful change was reported.", /记忆操作未能完成/],
  ];
  for (const [message, expected] of cases) {
    const output = userError(new Error(message), "测试");
    assert.match(output, /^测试失败：/, message);
    assert.match(output, expected, message);
  }
});

test("unknown errors never echo messages, stacks, secrets or paths and point to doctor", () => {
  const secret = "sk-proj-SYNTHETICSECRETVALUE1234567890";
  const internal = new Error(`raw failure at /private/secret/path with ${secret}`);
  internal.stack = `Error: ${secret}\n    at internal (/private/secret/path/file.ts:1:1)`;
  for (const error of [internal, { message: secret }, "raw string", undefined, null]) {
    const output = userError(error, "编辑");
    assert.match(output, /编辑失败：访问失败（未知错误）/);
    assert.match(output, /\/memory doctor/);
    for (const forbidden of [secret, "raw failure", "/private/secret/path", "file.ts", "raw string"]) assert.equal(output.includes(forbidden), false);
  }
  const denied = Object.assign(new Error(`denied ${secret}`), { code: "EACCES" });
  const output = userError(denied, "列表");
  assert.match(output, /列表失败：权限不足或访问被拒绝/);
  assert.equal(output.includes(secret), false);
  const missing = Object.assign(new Error("ENOENT raw"), { code: "ENOENT" });
  assert.match(userError(missing), /文件或路径不存在/);
  assert.equal(userError(missing).includes("ENOENT raw"), false);
});

test("operations and doctor hints are added once, pause advice is actionable and ordered", () => {
  const paused = userError(new Error("Memory paused: tool compatibility could not be confirmed."), "兼容检查");
  assert.match(paused, /按顺序恢复/);
  assert.equal(paused.split("/memory doctor").length - 1, 2);
  assert.match(paused, /\/memory reload 只安排索引刷新，不能解除兼容暂停/);
  assert.ok(compatibilityAdvice.indexOf("doctor") < compatibilityAdvice.indexOf("停用"));
  assert.ok(compatibilityAdvice.indexOf("停用") < compatibilityAdvice.indexOf("完整重载"));
  assert.ok(compatibilityAdvice.indexOf("完整重载") < compatibilityAdvice.lastIndexOf("doctor"));
  const generic = userError(new Error("Memory operation failed; no successful change was reported."));
  assert.match(generic, /可运行 \/memory doctor/);
  const off = userError(new Error("Memory is off; managed body access and saves are rejected."));
  assert.match(off, /\/memory on/);
  assert.doesNotMatch(off, /\/memory doctor/);
});

test("save notes distinguish index activation, limits and on-demand topics", () => {
  const index = formatSave("Saved successfully.", "/project/MEMORY.md");
  assert.match(index, /索引文件已保存/);
  assert.match(index, /当前快照不会自动更新/);
  assert.match(index, /\/memory reload 后，下一条用户任务会重载索引/);
  const near = formatSave("Saved successfully. MEMORY.md is near its 200-line/25KiB limit; simplify the index.", "/project/MEMORY.md");
  assert.match(near, /接近 200 行 \/ 25KiB 上限/);
  const over = formatSave("Saved successfully, but MEMORY.md exceeds 200 lines or 25KiB. The file IS SAVED; simplify the index and retry after reading it.", "/project/MEMORY.md");
  assert.match(over, /已保存，但超过 200 行或 25KiB 上限/);
  assert.match(over, /精简索引/);
  const topic = formatSave("Saved successfully.", "/project/topics/note.md");
  assert.match(topic, /主题文件已保存/);
  assert.match(topic, /按需读取/);
  assert.doesNotMatch(topic, /reload|注入当前请求成功/);
  const failed = formatSave("Saved successfully.", "/project/topics/note.md");
  assert.equal(failed.includes("Saved successfully"), false);
  assert.match(faultSummary(new Error("Memory paused: incompatible tool override.")), /工具兼容性冲突.*按顺序恢复/);
});

test("storage initialization failures name their cause and never suggest a retry that cannot work", async () => {
  const { degradedMemoryError } = await import("../src/pi/degraded-path.js");
  const cases: [string, string, RegExp][] = [
    ["EACCES", "denied", /用户目录不可访问/],
    ["EPERM", "denied", /用户目录不可访问/],
    ["ELOOP", "too many symbolic links", /路径解析失败/],
    ["ENOENT", "missing", /用户目录路径不存在/],
  ];
  for (const [code, message, expected] of cases) {
    const cause = Object.assign(new Error(message), { code });
    const text = userError(degradedMemoryError(cause), "状态查询");
    assert.match(text, expected, code);
    assert.match(text, /记忆路径在此期间保持关闭/);
    assert.doesNotMatch(text, /请重试|可执行 \/memory reload 安排/, code);
  }
  const identity = userError(degradedMemoryError(new Error("Memory paused: project identity is unavailable; repair.")), "状态查询");
  assert.match(identity, /项目身份不可用/);
  const unknown = userError(degradedMemoryError(new Error("unexpected")), "状态查询");
  assert.match(unknown, /用户目录初始化失败/);
  assert.doesNotMatch(unknown, /请重试/);
});
