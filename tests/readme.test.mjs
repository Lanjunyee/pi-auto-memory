import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('README prioritizes the verified released install and separates candidate scope', async () => {
  const text = await readFile('README.md', 'utf8');
  for (const phrase of [
    '核对日期 2026-10-17',
    '当前优先使用 npm 已发布的固定版本 `0.1.1`',
    '`0.1.0`：已发布',
    '`0.1.1`：已发布（2026-10-16），是 npm `latest`',
    '`0.1.3`：尚未发布，只存在于本地候选源码',
    '`0.1.2`：**未发布，已被 `0.1.3` 取代**',
    'pi install npm:@lanjunyee/pi-auto-memory@0.1.1',
    'pi remove npm:@lanjunyee/pi-auto-memory@0.1.1',
    'pi install git:github.com/Lanjunyee/pi-auto-memory',
    '未重新执行渠道安装验收',
    '未调用真实模型',
    '版本可获取、安装验证通过与功能存在是三件事',
    '`0.1.3` 不能通过固定 npm 版本安装',
    '`0.1.0`：已发布，早于 `0.1.1`；没有 `/memory list`、`/memory reload` 和 `/memory doctor`',
    '`0.1.1`：已发布（2026-10-16），是 npm `latest`；新增 `/memory list` 只读浏览和 `/memory reload` 延迟刷新，没有 `/memory doctor`',
    '截至核对日期公开 `main` 尚无该文件',
  ]) assert.ok(text.includes(phrase), `Missing version/channel contract: ${phrase}`);
  assert.doesNotMatch(text, /pi install npm:@lanjunyee\/pi-auto-memory@0\.1\.[23]|pi -e npm:@lanjunyee\/pi-auto-memory@0\.1\.[23]|pi update npm:@lanjunyee\/pi-auto-memory@0\.1\.[23]|pi remove npm:@lanjunyee\/pi-auto-memory@0\.1\.[23]/);
});

test('README places first-use tutorial before development and explains candidate-only summary', async () => {
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
    '本变更验收见本地记录，发布前需重新核对',
    '请记住：今后本项目发布说明使用中文，按变更/验证/风险组织，请保存项目记忆',
    '请为本次候选写一段发布说明',
    '不是 OS 安全沙箱',
    '不能保证识别所有秘密',
    'Copyright 2026 Lanjunyee',
    'docs/release-trial.md',
  ]) assert.ok(text.includes(phrase), `Missing tutorial/scope contract: ${phrase}`);
  assert.doesNotMatch(text, /中文界面.{0,12}(?:已实测|验收通过)|本次摘要.{0,8}已实测通过|真实模型.{0,12}(?:已通过|验收通过)|Linux.{0,8}已通过|\/Users\/|\/home\/[^\s/]+|openspec\/|evidence\//);
});

test('release trial guide documents Chinese expectations without claiming this round passed', async () => {
  const text = await readFile('docs/release-trial.md', 'utf8');
  for (const phrase of [
    '0.1.3 尚未发布',
    '`0.1.1` 已包含 `/memory list` 和 `/memory reload`，没有 `/memory doctor`',
    '本轮没有执行真实模型调用',
    '本变更验收见本地记录，发布前需重新核对',
    '同一 agentDir（Pi 用户目录）下的所有项目共用开关',
    '本扩展不提供撤销',
    '不等于本轮已实测通过',
    '本轮无真实模型调用、无日常扩展修改、无发布或推送',
  ]) assert.ok(text.includes(phrase), `Missing trial contract: ${phrase}`);
  assert.doesNotMatch(text, /\/Users\/|\/home\/[^\s/]+|openspec\/|(?<!不等于)本轮.{0,12}(?:全部通过|已实测通过)/);
});
