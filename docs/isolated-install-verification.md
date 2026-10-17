# 隔离安装验证

`scripts/verify-isolated-install.mjs` 在临时 `HOME`、临时 Pi 用户目录（agentDir）和临时 npm 缓存下验证一次真实安装，不读写日常配置。它回答的问题是**装得上、加载得了、受管理工具能保存和读取、普通文件仍交给宿主**，不验证真实模型的保存或召回质量。

## 运行前提

- PATH 上可用的 `pi` CLI；脚本用 `which pi` 定位，并用其真实路径调用（可用 `PI_CLI` 覆盖）。
- 本仓库依赖已按 `npm ci --ignore-scripts` 准备（脚本会以仓库根目录为 `cwd` 启动宿主加载器）。
- 不需要网络凭据；脚本以 `PI_OFFLINE=1` 运行并禁用技能、模板、主题、上下文文件与 MCP。

## 命令

```sh
node scripts/verify-isolated-install.mjs .
```

输出为 JSON。成功时顶层 `result` 为 `pass`，`steps` 逐项记录：

| step | 含义 |
| --- | --- |
| `install` | `pi install <仓库>` 在临时 agentDir 写入且只写入一个包来源 |
| `capabilities` | 宿主加载器发现 1 个扩展、注册 `memory` 命令；受管理 write 返回保存结果并落盘；受管理 read 返回正文；普通文件 read 委托宿主 |
| `remove` | `pi remove <仓库>` 后包来源列表为空 |

`capabilities.modelCalls` 恒为 `0`：脚本把模型调用替换为抛错，任何真实请求都会使验证失败而不是静默通过。

## 边界

- 脚本断言的是安装、注册与工具行为，**不**断言 `/memory` 命令输出；命令文案由 `tests/commands.test.ts` 与 `tests/presentation.test.ts` 覆盖。
- 临时目录在结束时删除；失败时同样清理。脚本不发布、不推送、不读取凭据，也不修改日常 `~/.pi`。
- 该验证通过不表示真实模型会稳定保存或召回内容，也不扩大支持的宿主版本或平台范围。
