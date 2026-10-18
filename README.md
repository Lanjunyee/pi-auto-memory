<div align="center">

<h1>pi-auto-memory</h1>

<p><strong>让 Pi 记住项目偏好，减少跨会话的重复说明。</strong></p>

<p>
  <a href="https://www.npmjs.com/package/@lanjunyee/pi-auto-memory"><img src="https://img.shields.io/npm/v/%40lanjunyee%2Fpi-auto-memory?style=flat-square&amp;label=npm" alt="npm 最新版本"></a>
  <a href="https://github.com/Lanjunyee/pi-auto-memory/actions/workflows/check.yml"><img src="https://github.com/Lanjunyee/pi-auto-memory/actions/workflows/check.yml/badge.svg?branch=main" alt="main 分支 CI 状态"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square" alt="许可证 Apache-2.0"></a>
</p>

<p>
  <a href="#preview">效果预览</a> ·
  <a href="#install">快速安装</a> ·
  <a href="#first-use">首次使用</a> ·
  <a href="#commands">常用命令</a> ·
  <a href="#details">详细说明</a> ·
  <a href="#development">开发与验证</a>
</p>

</div>

Pi 的项目级文件记忆扩展：把稳定的偏好、反馈和项目事实保存为可查看、可编辑的 Markdown，在同一个项目的新独立会话中按需使用。

| 记住什么 | 怎么使用 | 如何管理 |
| --- | --- | --- |
| 长期偏好、工作反馈、稳定项目事实 | 索引提供线索，主题按需读取 | `/memory` 菜单、只读浏览、编辑与诊断 |

**适用环境：pi 1.2.0 至 1.3.0 · Node.js ≥22.19.0 · 独立主会话。**

保存由当前主模型自主判断，没有后台总结模型；是否保存、读取以及遵循仍是概率行为，不保证每次成功。

<a id="preview"></a>

## 效果预览

以下是**使用示意**，用于说明操作方式与期望体验，不是界面截图或每次都能复现的结果。

**会话一 · 在项目中保存偏好**

```text
你：请记住：今后本项目发布说明使用中文，按变更/验证/风险组织，请保存项目记忆。
```

**会话二 · 同一项目，新独立会话，不重复偏好**

```text
你：为这次缓存调整写一份简短发布说明，已补充测试，极端输入仍需观察。

期望的回答结构：
变更  调整缓存策略……
验证  补充相关测试……
风险  极端输入仍需继续观察……
```

```mermaid
flowchart LR
    A[会话一：提出长期偏好] --> B[模型选择保存主题与索引]
    B --> C[新独立会话：加载索引]
    C --> D[模型按需读取主题]
    D --> E[结合当前任务回答]
```

记忆是参考数据，当前用户指令优先；流程中的保存、主题读取与最终遵循均不保证发生。

<a id="install"></a>

## 快速安装（0.1.4）

先安装宿主 Pi，再在终端执行：

```sh
# npm（固定版本，推荐）
pi install npm:@lanjunyee/pi-auto-memory@0.1.4
```

**本次文档补丁使用 npm 固定版本 `0.1.4`。** 安装后，在目标项目中启动 Pi 独立主会话，即可按下节验证。`0.1.4` 更新 README 展示与安装说明，运行时代码及依赖与 `0.1.3` 相同。

不要同时配置源码入口和安装包。**两个渠道的依赖处理不同。** npm 包在 manifest 中声明运行时依赖，安装时由 npm 一并解析；GitHub 来源拉取的是源码，不含 `node_modules`，加载前需要先在克隆目录执行 `npm ci --ignore-scripts`，否则扩展加载会因缺少 `yaml` 等模块而失败。若只求可用，选 npm 渠道。

<details>
<summary><strong>其他安装方式、更新与卸载</strong></summary>

### 一次性试用

```sh
pi -e npm:@lanjunyee/pi-auto-memory@0.1.4
```

不写入包配置，仍会下载／缓存包。

### GitHub 来源

```sh
pi install git:github.com/Lanjunyee/pi-auto-memory
```

GitHub 默认分支的内容随 main 变化，不保证等于某个固定版本；加载前先在克隆目录准备依赖。

### 更新与卸载

```sh
pi update npm:@lanjunyee/pi-auto-memory@0.1.4
pi update git:github.com/Lanjunyee/pi-auto-memory
```

更新某个已配置来源；固定版本不会自动升级到新版本。升级固定 npm 版本时先 remove 旧来源，再 install 新版本。

```sh
pi remove npm:@lanjunyee/pi-auto-memory@0.1.4
pi remove git:github.com/Lanjunyee/pi-auto-memory
```

卸载时只使用原来安装的来源。包安装会执行受信任的扩展代码，应先审查源码。`/memory off` 仅停止新的记忆使用，卸载仅移除加载引用；两者都**保留记忆文件与已有会话历史**，不代表永久忘记。

</details>

<a id="first-use"></a>

## 首次使用：保存、查看、新独立会话验证

适用于 `0.1.3`／`0.1.4`，示例只使用无秘密的稳定偏好。

1. **保存偏好。** 在目标项目启动 Pi，输入上方示例中的保存要求，观察模型是否调用工具保存。扩展不会在任务结束时自动总结。

2. **查看文件。** 执行 `/memory list`，选择 `MEMORY.md` 和对应主题，核对“中文、变更/验证/风险”等内容。只读查看不会替模型建立读取许可；空列表表示尚无已保存文件。

3. **新会话验证。** 退出后在**同一个项目**启动新的独立主会话，**不要重复偏好原文**。例如：“请为本次候选写一段发布说明，说明新增 doctor 和会话摘要，并列出验证方式和已知风险。”核对回答是否使用目标结构；不复用旧会话、fork 或子代理。

三类结果与排查入口：

| 现象 | 可能原因与下一步 |
| --- | --- |
| 没有保存 | 模型判断无需保存、保存被拒绝、开关关闭或环境不支持。先用 list 检查文件；`0.1.3` 可运行 doctor，并查看下文提交拒绝表。不要假设每轮都会保存。 |
| 已保存但新会话没有使用 | 主题按需读取，模型可能没有读取；也可能记忆关闭、配置未知、兼容暂停或索引没有链接该主题。检查 status、开关和索引内容；`/memory doctor` 可报告运行条件。 |
| 读取后没有遵循 | 记忆只是参考数据，当前用户指令优先；模型可能忽略或判断不适用。status 摘要只能说明正文是否曾返回，不能证明模型理解或遵循。 |

真实模型的保存与召回具有随机性，一次示例不能作为离线管理验收或必然成功证明。隔离试用只验证管理界面，见“版本差异与隔离试用”。

<a id="commands"></a>

## 常用管理

| 命令 | 用途 | 何时使用 |
| --- | --- | --- |
| `/memory` | 打开 TUI 菜单；非 TUI 显示状态和用法 | 从统一入口管理记忆 |
| `/memory list` | 列出文件，交互时选中只读查看 | 确认偏好是否保存 |
| `/memory status` | 状态、项目路径、快照边界及会话摘要；不读正文 | 排查是否开启、准备或投影 |
| `/memory reload` | 撤销快照和旧操作，下一用户任务重载 | 修改索引后安排刷新 |
| `/memory doctor` | 只读分项诊断，不自动修复 | 检查配置、工具或兼容问题 |
| `/memory on` / `/memory off` | 持久开启／关闭；关闭保留文件与历史 | 控制后续记忆使用 |
| `/memory edit topic.md` | 用 TUI/RPC 编辑器编辑当前项目相对文件 | 修正已保存的偏好 |
| `/memory delete topic.md` | 确认后删除单个文件，关闭时也可用 | 删除过期记录；无撤销 |

记忆文件按项目隔离；同一 agentDir 的项目共用持久开关。修改索引后，执行 `/memory reload`，刷新在下一用户任务生效。

## 支持与安全边界

- 宿主为 **pi 1.2.0 至 1.3.0**，Node.js **≥22.19.0**，仅支持**独立主会话**。
- 不支持子代理、fork、foreground 显式子会话加载；可靠识别到 `PI_SUBAGENT_CHILD=1` 的 runner 会禁用记忆。
- 历史实测环境为 macOS 27.0.1（arm64）、Node.js 22.19.0／26.9.0；pi 1.3.0 上以隔离宿主加载器与本地 CLI 复验通过。Linux 的自动化检查已由 GitHub hosted CI 在 ubuntu-24.04 上覆盖；未做 Linux 本地手工试用，未验证范围外版本或完整跨平台矩阵。
- **不是 OS 安全沙箱。** 受管理工具保护不覆盖任意 shell、用户 `!` shell、其他扩展、硬链接别名和手工访问，也不能完全消除 TOCTOU 风险。
- 秘密必须排除；高置信检测**不能保证识别所有秘密**，也不能抹去工具参数、会话记录或已有模型历史中的秘密。错误不回显命中值，且没有强制允许秘密的开关。
- 主模型自主判断保存价值，没有后台总结模型，不保证每轮保存或召回。记忆是参考数据，不能覆盖当前指令；稳定 user/feedback/project/reference 信息才适合保存，跳过代码可推导事实、临时进度及 `AGENTS.md` 重复规则。

<a id="details"></a>

## 详细说明

按需展开管理语义、工作机制与恢复规则。

<details>
<summary><strong>文件浏览、中文反馈与删除规则</strong></summary>

`/memory status` 提供简短状态摘要，并展示当前实例的会话使用摘要。诊断结果包含稳定检查标识和 `ok`（正常）、`warning`（警告）、`failure`（失败）、`unchecked`（未检查），保留命令语法与诊断标识。

`0.1.1` 的管理文字为英文。`0.1.3` 新增简体中文的菜单、用法、状态、开关、通知和诊断原因；命令名、诊断标识、错误分类和普通文件的宿主输出保持原有语义。

`/memory list` 与 TUI 菜单的 `List files` 使用同一文件列表，按相对路径列出索引和嵌套主题，不跟随符号链接、不读取未选中文件正文；空目录只提示暂无文件。交互时选中即只读查看，关闭后重新列举，取消列表退出；查看 `MEMORY.md` 请直接选择该文件，没有独立 view 子命令。查看界面中的改动不会保存或以查看建立模型读取许可。

删除只针对确认的单个版本，**本扩展不提供撤销**，没有整库清空或 force 删除。删除文件不会清除已有模型／会话历史，也不是永久忘记黑名单，未来仍可能重新记住。

</details>

<details>
<summary><strong>共用开关、项目隔离与延迟感知</strong></summary>

记忆文件按项目隔离，但持久开关共用：`/memory on` 与 `/memory off` 影响**同一 Pi 用户目录（agentDir）下的所有项目**，不宣称影响使用其他 agentDir 的实例。其他会话在**下一任务或下一次受管理访问检查**时感知变化，没有即时广播或后台 watcher。

独立配置为 `<agentDir>/auto-memory.json`，不修改 pi `settings.json`：

```json
{ "version": 1, "enabled": false }
```

缺失默认开启；损坏、未知版本或非 boolean 开关会暂停并提示修复。设置在配置锁内重读，保留额外字段，通过私有临时文件原子替换；失败不宣称成功。每次任务开始、受管理访问和最终提交都检查持久开关。成功关闭之后不再许可基于旧 enabled 检查的新提交；已先取得配置锁的提交会在 off 成功返回前完成。

`/memory off` 只停止新的主动注入和受管理正文访问，**不清除文件或已有会话历史**；支持历史 system 更新的模型仍可能看到旧记录。删除也不是永久忘记。

</details>

<details>
<summary><strong>索引快照、编辑与生效</strong></summary>

索引在会话进入后的首个用户任务读取一次，连续任务复用同一快照；新建、恢复、切换、树导航、成功重新开启和 `/memory reload` 会使快照及旧读取许可失效，下一次用户任务才重载。扩展不在任务结束时自动总结，不自动加载主题，也不额外调用模型。

**编辑索引不会自动刷新当前快照。** 通过 `/memory edit` 保存 `MEMORY.md` 后，磁盘变更立即完成，但当前请求仍使用旧快照；成功提示应说明需执行 `/memory reload`，刷新在下一用户任务生效。reload 只安排刷新，不立即读取正文、不写持久开关、不调用模型，也不能解除工具兼容暂停。主题保存只说明文件已保存，主题仍按需读取，不应描述为已进入当前模型请求或必然召回。

当前实例只能观察自己完成的受管理保存或删除。若快照已准备或已投影后，本实例保存或删除了索引，status 可标记“已知索引变更，等待下一任务刷新”；新快照成功准备或投影后清除标记。外部手工编辑、其他会话写入和任意 shell 修改不会被检测，也不会自动刷新；需要时显式 reload，文档不宣称摘要与磁盘始终一致。

索引加载上限为前 200 行或 25×1024 UTF-8 字节（先到者为准）；达到任一上限的 90% 提醒，恰好上限不报超限，截断保持字符边界。索引保存完成但超过上限时，文件**仍然已保存**，只是加载时截断，应精简索引，不描述为回滚或未保存。主题文件不使用该索引加载限制。

如果索引读取失败或请求投影失败，不恢复旧快照，按故障暂停新注入；若索引缺失，下一任务按空索引处理且不创建替代文件。请求级投影只替换本扩展的 `auto_memory` 区段，保留首条 system、其他扩展区段、工具变化和用户／助手历史；无法可靠识别自有区段时暂停该次新注入。

</details>

<details>
<summary><strong>status 会话摘要：展示事实与边界（0.1.3 起）</strong></summary>

status 提供**仅存于当前扩展实例内存**的使用摘要，只展示已经发生的事实：

| 展示事实 | 含义 | 不表示 |
| --- | --- | --- |
| 最近保存 | 当前会话最近一次受管理保存已成功提交，含项目相对文件名、UTC 时间和来源（模型工具或用户编辑） | 模型已读取、理解或遵循该文件 |
| 快照已准备 | 索引读取完成，等待后续请求投影 | 索引已放入模型请求 |
| 请求已投影 | 本扩展已成功把索引放入自己处理的请求 | 远端模型已接收、理解或遵循 |
| 主题正文已返回 | 标准 `read` 已把非空正文返回给模型 | 模型已遵循；局部读取不等于完整读取 |

摘要规则：

- **只观察当前实例。** 不监控外部文件变更、其他会话或其他 agentDir；未显示记录只表示“本会话未观察到”，不推断磁盘为空或模型未使用历史。
- 会话进入、切换、树导航和退出会清除摘要；reload、on/off 会重置投影状态和旧操作有效期，但保留同一会话已完成的保存与读取作为历史，旧读取许可仍然失效。兼容暂停撤销当前可用状态，但不伪造已完成提交的回滚。
- 最多保留最近一次保存和最多 **20 个最近向模型返回正文的主题**，按最近读取时间排序；淘汰后摘要会说明截断。同一主题版本的非空分段可以累计，版本变化后重新累计；保存建立的写后基线、内部读取、用户 list/edit 查看都不算模型读取。
- 摘要不保存正文、候选秘密或模型推断，不作为读写授权依据，也不会额外读取正文、扫描文件或增加模型调用。
- 关闭、配置未知或兼容暂停时仍可显示当前会话已有记录，但必须同时标明当前不可用；历史记录不代表仍在注入。
- 摘要中的“已投影”只描述本扩展处理的请求，不保证服务端送达；“正文已返回”只描述返回边界，不保证模型理解或遵循。

</details>

<details>
<summary><strong>版本历史、发布校验与隔离试用</strong></summary>

### 版本状态（核对日期 2026-10-17）

以下渠道一致性与零模型安装验收记录属于该核对时点。

`0.1.3` 同时发布到 npm 与 GitHub，两者内容逐字节一致：npm tarball SHA256 为 `6d9c996cf5d056f217ecf35a9e55ddc9115095d5c5c17a11634c2fdf62f2af11`，公开源码树指纹为 `cd5c9dbfa41661a0bd2e3f170abe135616e0422d`。本轮实际执行了 npm 安装、`pi install npm:` 渠道、受管理写入与读取、普通文件委托和卸载保留，全部通过，模型调用为 0；未调用真实模型评估保存或召回。

- `0.1.0`：已发布，早于 `0.1.1`；没有 `/memory list`、`/memory reload` 和 `/memory doctor`。
- `0.1.1`：已发布（2026-10-16）；新增 `/memory list` 只读浏览和 `/memory reload` 延迟刷新，没有 `/memory doctor` 和会话使用摘要。
- `0.1.2`：**未发布，已被 `0.1.3` 取代**；该候选新增 `/memory doctor`、会话 status 摘要和简体中文管理反馈，未单独发布。
- `0.1.3`：已发布（2026-10-17），是 npm `latest` 与 GitHub 默认分支；在 `0.1.2` 候选基础上修复存储初始化故障的扩散、失败粘滞与状态展示，并把宿主版本判定改为范围比较。

版本可获取、安装验证通过与功能存在是三件事。渠道状态会变化；重新发布或更新文档前应再次核对并记录日期。更细的版本功能差异见下文“版本差异与隔离试用”。

### 版本差异与隔离试用

`0.1.3` 已发布到 npm 与 GitHub，两个渠道内容逐字节一致。`0.1.3` 之前，`0.1.2` 候选未单独发布，其能力并入 `0.1.3`。

| 能力 | 0.1.0 | 0.1.1 | 0.1.3 |
| --- | --- | --- | --- |
| status / on / off / edit / delete | 有 | 有 | 有 |
| `/memory list` 只读浏览 | 无 | 有 | 有 |
| `/memory reload` 延迟刷新 | 无 | 有 | 有 |
| `/memory doctor` 只读诊断 | 无 | 无 | 有 |
| status 会话使用摘要 | 无 | 无 | 有 |
| 中文管理反馈 | 无 | 无 | 有 |
| 宿主版本按范围判定 | 无 | 无 | 声明 1.2.0–1.3.0 范围 |
| 存储故障不拖垮普通工具 | 无 | 无 | 有 |
| 初始化失败不跨调用缓存 | 无 | 无 | 有 |

隔离试用步骤见 [隔离试用指南](https://github.com/Lanjunyee/pi-auto-memory/blob/main/docs/release-trial.md)。该指南**仅随公开源码分发，npm 包内不包含 `docs/`**，因此从 npm 安装时请以本文档为准。该试用只检查 `/memory` 菜单、开关、编辑和删除等离线管理能力，不能证明真实模型保存、召回或跨会话遵循；真实模型调用需要用户自行选择模型、认证并承担费用。

试用不安装、不复制到 `~/.pi/agent/extensions/` 或 `.pi/extensions/`。若需要在仓库根目录显式加载源码，先按“开发与验证”准备依赖，再使用指南中的临时 HOME／agentDir 命令；退出即停止显式加载，临时目录保留，清理前确认属于本次试用。

</details>

<details>
<summary><strong>工具兼容、扫描保护与诊断边界</strong></summary>

- 注册时只包装已配置的标准文件工具，保留活跃集合。六种标准名称（`read`、`write`、`edit`、`grep`、`find`、`ls`）只检查宿主当前选中的实现；参数符合标准 schema 的名称按路径与祖先重叠规则拦截记忆访问，并保留普通非重叠文件的既有委托。参数为未知 schema 时拒绝该名称的全部调用，不猜测 `target` 等字段等同于 `path`。
- 受保护父目录的 `grep`／`find` 扫描会在启动扫描进程前排除禁止的记忆子树；关闭、未知状态和 child 环境排除全部记忆。扫描仅使用 pi 用户目录 `bin/` 或 PATH 中已有的 `rg`／`fd`（也支持 `fdfind`），**不自动下载**；缺失时明确报错，不回退到未保护扫描。`ls` 在 stat 子目录前排除禁止条目。
- 同名工具覆盖及修改完整 system prompt 的扩展可能不兼容。发现同名非标准实现、运行中替换或原先缺席后新增的未受管理同名实现，会触发兼容暂停；暂停在**同一扩展运行实例内粘性保留**，不因 doctor、会话重置、索引刷新或 on/off 消除。只有移除冲突扩展并**完整重载扩展**取得新实例、检查通过后，才按持久开关恢复。`/memory reload` 不是完整扩展重载，不能解除暂停。
- 兼容验证只覆盖宿主 pi 1.2.0 至 1.3.0 的合成扩展组合（`tests/registration.test.ts`、`tests/lifecycle-owner.test.ts`、`tests/host-contract.test.ts`），不代表真实 `pi-cc-extensions` 组合或任意平台扩展已兼容，也不承诺拦截任意外部直接 IO。
- 不提供跨文件事务、自动合并、全局个人记忆、自动迁移、整库清空、force 删除或秘密豁免。先保存主题、再更新索引链接不是事务；第二步失败应明确重试，不自动删除主题。
- 关闭保留文件，停止新注入／受管理正文访问，不清除旧历史。删除只删除单个确认版本，不读取正文，历史仍可能被模型看到；未来模型也可能重新保存。
- 诊断只观察注册／激活／归属、参数兼容性和配置路径，不设置或清除暂停，不读取索引或主题正文，不扫描全库，不创建探测文件，不获取锁，不改权限、开关、快照、读取许可或待提交操作，不执行扫描二进制、不自动修复、不调用模型。它仅反映当前时点，不能保证后续保存成功；`doctor` 不接受额外参数。

</details>

<details>
<summary><strong>项目身份与配置</strong></summary>

记忆根遵循 `getAgentDir()`／`PI_CODING_AGENT_DIR`，默认 `~/.pi/agent/memory/<project-id>/`，索引为 `MEMORY.md`，主题为 Markdown。ID 是 `git-` 或 `cwd-` 加规范化身份路径的 SHA-256，不使用 remote URL，也不把完整项目路径编码进文件名。

- Git 身份使用 `realpath(git rev-parse --path-format=absolute --git-common-dir)`：主仓库和其 worktree 共享；独立 clone、submodule、嵌套仓库分别隔离。
- 非 Git 身份仅使用规范化启动 cwd：父目录与子目录**不共享**，路径别名共享。bare 或异常 Git 暂停，不静默生成另一身份。
- 移动仓库或重建 clone 不迁移旧记忆，旧文件不自动删除。当前项目受管理访问拒绝跨项目和记忆树内符号链接；不支持自定义记忆根。

</details>

<details>
<summary><strong>提交、冲突与恢复</strong></summary>

受管理提交按配置锁 → 项目锁 → 宿主文件队列串行，锁保持到同目录私有临时文件 rename 完成。已有文件必须先完整读取：可把同一内容摘要版本的多个分段累计，但内部读到、未实际返回的部分不算已读；文件变化会清空旧累计。不存在的文件只在锁内确认仍不存在后创建。标准 `read` 保留 2000 行／50KiB 单次输出上限，使用 `offset`／`limit` 补读；分段间明确的行号边界计入换行覆盖。

**单行超过 50KiB 是例外**：沿用宿主超长行诊断，诊断不算正文读取，不能建立完整基线或受管理覆盖；须先在受管理通道外拆分该长行。扩展不增加字节参数、不提升输出上限，也不把宿主推荐的 shell 当作受保护读取。

| 反馈 | 状态与恢复 |
| --- | --- |
| `Memory save rejected: no complete read baseline` | 未保存；补齐所有分段后重试，不能凭局部内容覆盖全文。 |
| `Memory conflict: stale version` | 未保存；完整重读当前版本，再重新应用修改。不自动合并。 |
| `Memory lock unavailable` | 未保存；等待其他受管理操作完成后重试。不强制解锁。 |
| `Memory save rejected: detected …` | 未保存；删除敏感结构或使用无秘密参考。无强制允许秘密开关。 |
| `Memory save rejected: malformed … YAML frontmatter` | 未保存；修复元数据，不静默丢弃其他字段。 |
| `The file IS SAVED; simplify the index` | 已保存，但索引超限，以错误结果提示精简。不是回滚。完整重读后精简。 |
| `Memory delete conflict: target changed; confirm again` | 未删除；重新选择并确认当前目标版本。 |

其他恢复要点：

- 编辑期间其他会话保存：`Memory conflict: stale version`，未保存；重新打开编辑器，不自动覆盖。
- 编辑期间关闭：`Memory is off`，未保存；显式开启后重新打开。
- 编辑或提交等待期间执行 reload、新建／恢复／切换会话、树导航或关闭会话：`Memory operation invalidated by a session change`，旧副本不得保存；在当前会话重新打开编辑器。
- 最终提交许可前发现同名工具冲突：旧读取许可、编辑草稿及等待加锁的提交失败，原文件保持；须停用冲突扩展并完整重载扩展取得新实例，再重新打开编辑器或完整重读当前版本后保存。
- 提交已取得最终许可并完成文件替换后才出现同名工具冲突：该完成提交保留，不回滚；后续受管理操作仍按兼容暂停拒绝。许可界线是提交链内 `beforeRename` 或删除 `unlink` 前的最后一次状态检查，宿主文件队列本身不是许可界线。
- 配置损坏：暂停；修复独立 `auto-memory.json` 后重试，不自动覆盖损坏文件。
- 秘密拒绝：旧文件不变，错误不回显命中值；去除敏感结构后重试，没有豁免。
- 用户目录无法初始化（权限不足、路径含符号链接环、项目身份不可用）：**普通文件工具不受影响**，`read`／`write`／`edit`／`grep`／`find`／`ls` 对记忆之外的路径继续按宿主行为工作；记忆路径在此期间失败关闭。修复条件后同一会话内的下一次调用即恢复，不需要重进会话——失败不会被缓存。管理命令会指出具体类别（用户目录不可访问、路径解析失败、项目身份不可用），且不会再提示在同一状态下重试。

手工编辑、任意 shell 与其他扩展不经过本提交链；受管理修改会拒绝基于旧读取版本的覆盖，但不承诺外部写入攻击下的绝对证明。进程异常退出时临时副本可能残留；正常失败路径尽力清理，锁仅按锁库的心跳／过期规则恢复。

</details>

<a id="development"></a>

## 开发与验证

支持与验收目标为 pi 1.2.0 至 1.3.0、独立主会话，Node.js ≥22.19.0。包名 `@lanjunyee/pi-auto-memory`，唯一入口 `src/index.ts`。宿主包声明为 peer（开发测试固定 1.2.0，范围常量见 `src/core/constants.ts`），YAML 与跨进程锁为显式运行依赖。

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run check
npm run test:package
node scripts/check-snapshot.mjs
```

测试只使用临时目录，不读用户凭据，不注册日常扩展，不调用模型。`tests/load.test.ts` 显式隔离加载；`tests/host-contract.test.ts` 比较标准工具 schema/行为，并验证命名 system section。离线测试不等于真实模型体验、中文界面验收或跨平台兼容证明。

CI 配置覆盖 ubuntu-24.04／macos-15 × Node 22.19.0／26.9.0，先准备并确认 Git、rg、fd／fdfind，再执行锁文件安装、`npm run check`、`npm run test:package` 和 `node scripts/check-snapshot.mjs`。后者在逐文件公开副本上重新安装依赖并运行完整检查和包级验证。工作流契约由 `tests/workflow.test.mjs` 静态检查。公开提交 `2b3452fcfe6bdfb23791e80a50324f5ad7ad3d61`（对应 `0.1.3`）的 hosted CI run `39045640235` 四格全部成功，其中每格的上列检查步骤均为 success；这是该提交的自动化检查证据，不等于当前开发树、真实模型效果、中文界面或 Linux 本地手工验收。工作流不发布、不写仓库、不请求秘密或调用模型。

## 许可与分发验证

Copyright 2026 Lanjunyee。Apache-2.0，完整文本见 [LICENSE](LICENSE)，依赖核对见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。软件按现状提供，无担保或支持承诺。

<details>
<summary><strong>分发白名单与包级验证</strong></summary>

`distribution-files.json` 是逐文件公开白名单。运行包只含源码、manifest、README 与许可；公开源码额外包含合成测试及必要开发／包验证工具。`docs/release-trial.md` 仅随公开源码分发，npm 包内不包含 `docs/`；公开源码更新前，远端指南可能落后于本地候选。不会复制开发 Git 历史。

```sh
# 在依赖准备好的源码目录执行；输出目录必须不存在
node scripts/distribution.mjs pack /tmp/auto-memory-package-output
node scripts/distribution.mjs snapshot /tmp/auto-memory-public-source
# 输出归档 SHA256、逐文件指纹；重新计算归档散列
shasum -a 256 /tmp/auto-memory-package-output/*.tgz
```

包级隔离验证命令见 `npm run test:package`；它安装独立固定宿主及声明依赖，需要网络，只使用临时 HOME／agentDir 和合成记忆，模型调用为零。验证覆盖本次真实 tarball 的解包、本地／Git 来源及 npm 提升依赖布局，安装文件逐一与候选归档比对，成功或失败均清理本次临时资源。候选布局 fixture 不等于 registry 发布验收，也不以已发布旧包替代当前候选。验证工具不包含发布命令。公开目录发现依赖 `pi-package` 元数据，不保证官网收录时效或官方背书。

</details>
