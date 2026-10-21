import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('README uses unpinned package commands and explains installation channels', async () => {
  const text = await readFile('README.md', 'utf8');
  for (const phrase of [
    '## 快速安装',
    'pi install npm:@lanjunyee/pi-auto-memory',
    'pi -e npm:@lanjunyee/pi-auto-memory',
    'pi update npm:@lanjunyee/pi-auto-memory',
    'pi remove npm:@lanjunyee/pi-auto-memory',
    'pi install git:github.com/Lanjunyee/pi-auto-memory',
    '两个渠道的依赖处理不同',
    '加载前需要先在克隆目录执行 `npm ci --ignore-scripts`',
    '--host-regression',
    '--tui',
    '中文 PTY 已在 macOS 的 Pi 1.3.0 隔离宿主、解包后的候选入口上实际通过',
    '成功运行会删除自身沙箱',
    '开发树内的完整记录不随 npm 包或公开源码分发',
    '拒绝回退开发依赖或实例混用',
    'Pi 1.3.0 × Node 22.19.0 的两个 OS 组合额外启用',
  ]) assert.ok(text.includes(phrase), `Missing installation contract: ${phrase}`);
  assert.doesNotMatch(text, /npm:@lanjunyee\/pi-auto-memory@/);
});

test('README places first-use tutorial before development and explains memory usage boundaries', async () => {
  const text = await readFile('README.md', 'utf8');
  const tutorial = text.indexOf('## 首次使用：保存、查看、新独立会话验证');
  const development = text.indexOf('## 开发与验证');
  assert.ok(tutorial > 0 && development > tutorial);
  for (const phrase of [
    '## 首次使用：保存、查看、新独立会话验证',
    '/memory list',
    '不要重复偏好原文',
    '没有保存',
    '已保存但新会话没有使用',
    '读取后没有遵循',
    '保存由当前主模型自主判断',
    '没有后台总结模型',
    '主题按需读取',
    '不保证每次成功',
    '同一 Pi 用户目录（agentDir）下的所有项目',
    '/memory project off',
    '/memory project inherit',
    '不能绕过全局关闭',
    '`disabledProjects`',
    '查询、诊断和加载不会自动迁移',
    '旧扩展读取 v2 会按未知版本暂停',
    '全局开关不清空项目设置',
    '`/memory on`／`off` 继续只改全局值',
    '本变更不提供导入、导出、仓库搬迁或跨 clone 迁移',
    '同一仓库 worktree 共享',
    '下一任务或下一次受管理访问检查',
    '没有即时广播或后台 watcher',
    '编辑索引不会自动刷新当前快照',
    '/memory reload`，刷新在下一用户任务生效',
    '主题保存只说明文件已保存',
    '最多 **20 个最近向模型返回正文的主题**',
    '只观察当前实例',
    '不监控外部文件变更',
    '最近保存',
    '快照已准备',
    '请求已投影',
    '主题正文已返回',
    '局部读取不等于完整读取',
    '不保证模型理解或遵循',
    '不保存正文、候选秘密或模型推断',
    '不会额外读取正文、扫描文件或增加模型调用',
    '请记住：今后本项目发布说明使用中文，按变更/验证/风险组织，请保存项目记忆',
    '为这次缓存调整写一份简短发布说明',
    '不是 OS 安全沙箱',
    '不能保证识别所有秘密',
    'Copyright 2026 Lanjunyee',
    'docs/release-trial.md',
    '只有完整 Markdown 链接落入实际加载前缀才标为范围内',
    '该范围仅代表检查时点磁盘索引下次加载的候选范围',
    '当前会话可能复用旧快照',
    '入口行列及加载范围与关联检查一致',
  ]) assert.ok(text.includes(phrase), `Missing tutorial/scope contract: ${phrase}`);
  assert.doesNotMatch(text, /中文界面.{0,12}(?:已实测|验收通过)|本次摘要.{0,8}已实测通过|真实模型.{0,12}(?:已通过|验收通过)|Linux.{0,8}已通过|\/Users\/|\/home\/[^\s/]+|openspec\/|evidence\//);
});

test('README and release trial state the hosted CI scope without claiming model or manual verification', async () => {
  const readme = await readFile('README.md', 'utf8');
  const trial = await readFile('docs/release-trial.md', 'utf8');
  for (const phrase of [
    '`2b3452fcfe6bdfb23791e80a50324f5ad7ad3d61`',
    'run `39045640235` 当时四格全部成功',
    '不等于当前开发树、真实模型效果、中文界面或 Linux 本地手工验收',
    'Linux 的自动化检查已由 GitHub hosted CI 在 ubuntu-24.04 上覆盖',
  ]) assert.ok(readme.includes(phrase), `Missing hosted CI scope: ${phrase}`);
  assert.ok(trial.includes('run `39045640235` 已在 ubuntu-24.04 与 macos-15 上、Node 22.19.0 与 26.9.0 四格全部成功'));
  assert.ok(trial.includes('不等于本文的 `/memory` 手工步骤、中文界面或真实模型保存／召回已在 Linux 上完成实测'));
  assert.doesNotMatch(readme, /hosted CI 尚未运行/);
  assert.doesNotMatch(trial, /hosted CI 的结果需另行取得证据/);
});

test('release trial guide documents Chinese expectations without claiming this round passed', async () => {
  const text = await readFile('docs/release-trial.md', 'utf8');
  for (const phrase of [
    '`0.3.0` 相对 `0.2.0` 新增 `/memory project` 项目级开关',
    '没有重新实测本文全部手工步骤',
    '`0.3.0` 已发布到 npm 与 GitHub',
    '本轮没有执行真实模型调用',
    '同一 agentDir（Pi 用户目录）下的所有项目共用开关',
    '/memory project off',
    '/memory project inherit',
    '/memory check topic.md',
    '/memory review topic.md',
    '不读取主题正文、不修改文件、不建立模型读取许可',
    '检查不完整，不宣称“入口缺失”',
    '非交互环境执行 review 只返回交互要求与可用入口：`/memory list`、`/memory check <主题>`',
    '保留不写 `reviewed` 标记',
    '`modified` 不代表内容仍然有效',
    '逐文件使用编辑与删除；本扩展不自动合并或删除源主题',
    '全局关闭时恢复继承仍保持有效状态关闭',
    '本扩展不提供撤销',
    '不等于本轮已实测通过',
    '本轮无真实模型调用、无日常扩展修改、无发布或推送',
  ]) assert.ok(text.includes(phrase), `Missing trial contract: ${phrase}`);
  assert.doesNotMatch(text, /\/Users\/|\/home\/[^\s/]+|openspec\/|(?<!不等于)本轮.{0,12}(?:全部通过|已实测通过)/);
});
