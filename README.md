# Codex Pet

一只同时住在 Codex 和 Windows 桌面的企鹅宠物。Codex Pet 把工作、等待、完成、检查和失败等状态变成连续动画；桌面版还能左右散步、拖动、回头、背身调皮、侧躺和翻滚。

当前版本：`0.3.0`。

> 这是独立的非官方兼容项目，不隶属于、未获腾讯或 OpenAI 赞助、认可或审核。代码采用 MIT 许可证；经典 QQ 企鹅及其像素重绘只用于个人本地实验，不提交 Git、不包含在 MIT 许可中，也不进入公共发布包。

## 两种使用方式

- **Codex 自定义宠物**：遵循 Codex Pets V2 的 `8 × 11` 图集契约，安装后可在 `Settings → Pets` 中选择。
- **Windows 桌面宠物**：以 Tauri 2 作为唯一公开桌面运行时，透明置顶、可拖动，支持单实例、托盘、位置记忆、开机启动、自动巡游、状态桥接和动作菜单。

Codex 官方说明：[Pets](https://learn.chatgpt.com/docs/pets)。仓库中的详细兼容契约见 [docs/codex-pet-contract.md](docs/codex-pet-contract.md)。

## 在 D 盘运行

以下只是路径示例，程序不会硬编码某台电脑的绝对路径：

```powershell
Set-Location D:\
git clone https://github.com/Linzeyu912/codex-pet.git
Set-Location D:\codex-pet
pnpm install --frozen-lockfile
pnpm assets:prepare
pnpm dev
```

开发环境要求：Windows 10/11、WebView2、Node.js 20.19+ 或 22.12+、pnpm 11+ 和稳定版 Rust；推荐 Node.js 24。`pnpm dev` 会准备图集并启动 Tauri 桌面应用。普通用户使用 NSIS 安装器，不需要 Node.js、pnpm 或 Rust。

干净克隆会直接使用项目原创、可公开分发的 Aurora 企鹅；不需要额外角色素材即可获得完整图集和动作。

## 桌面操作

- 按住左键拖动；向右移动时播放右侧步态，向左移动时播放左侧步态。
- 松开拖拽、自动巡游碰边转向或定时结束左右跑动时，会等当前步态循环到边界再切换，避免半途闪回正面。
- 双击企鹅挥手；右键菜单可指定散步、张望、装摔、侧躺、翻滚，也可暂停动画、切换自动闲逛、设置开机启动、隐藏或退出。
- 自动闲逛会混合左右巡游、跳跃、张望、背身调皮、侧躺和翻滚；屏幕启用“减少动态效果”时会降低刷新和动作强度。
- `failed` 先完整播放一次失败动作，再停留在躺倒帧，直到远端状态改变或过期。

## 本地经典企鹅素材

公开仓库包含程序、生成与校验工具、应用图标和原创 Aurora 企鹅，不分发经典 QQ 企鹅素材。

有权进行个人本地实验的开发者，可自行准备透明 PNG：

```text
.local-assets\qq-penguin\pixel-base.png
```

可选的 `4 × 4` 多角度姿态表放在：

```text
.local-assets\qq-penguin\poses\pose-sheet-v1.png
```

四行依次表达左侧步态、右侧步态、背面/回头姿态，以及侧躺/翻滚/恢复姿态。生成器会把 16 个姿态统一为 `192 × 208` 单元，并在本地生成 `desktop-poses.png`。它只扩展 Tauri 桌面动作，不改变 Codex Pets V2 的 11 行契约；缺少姿态表时，桌面端会退回 V2 图集内的兼容动作。

```powershell
pnpm assets:build
```

本地经典形象及其全部衍生文件留在被 Git 忽略的 `.local-assets/`、`public/local/` 或本地发布目录中。像素重绘不改变原角色的权利归属，详情见 [ASSET-LICENSES.md](ASSET-LICENSES.md)。

## 安装到 Codex

普通用户首次启动 Windows 桌面版时会看到“让 Aurora 认识 Codex”引导；也可随时从右键菜单选择“连接 Codex…”。“一键连接”会：

- 把公开 Aurora 图集原子安装到 `%CODEX_HOME%\pets\codex-aurora-penguin`；
- 在用户级 `%CODEX_HOME%\config.toml` 没有 `notify` 时，写入指向当前 `Codex Pet.exe --codex-notify` 的命令；
- 发现已有 `notify`、未知宠物目录、修改后的安装或链接路径时保留现场并提示，不静默覆盖。

配置完成后重启 Codex 客户端，再到 `Settings → Pets` 选择 `custom:codex-aurora-penguin`。官方 `notify` 当前只提供 `agent-turn-complete`，因此桌面宠物会在一轮任务完成时跳跃；工作中、等待输入等状态仍可通过下文的状态文件桥接。

以下命令适合源码开发、隔离测试或卸载：

先只检查来源、目标与冲突，不写入文件：

```powershell
pnpm assets:install -- --dry-run
```

确认后进行原子安装：

```powershell
pnpm assets:install
```

安装器只写入 `%CODEX_HOME%\pets\<pet-id>`；未设置 `CODEX_HOME` 时使用当前用户的 `.codex\pets`。它先在同级临时目录准备完整文件，再一次性替换目标，并写入 `.codex-pet-install-receipt.json`，记录版本、文件 SHA-256、目标和备份位置。升级与卸载还会核对 receipt 的宠物 ID、实际目标，并拒绝经过链接或 junction 的备份恢复路径。

若目标已有文件，完整的本项目安装也会先备份；未被本项目拥有或安装后被修改的目录默认拒绝覆盖。只有检查无误后才应使用：

```powershell
pnpm assets:install -- --force
```

备份位于 `%CODEX_HOME%\pets\.codex-pet-backups\<pet-id>\<timestamp>`。卸载默认验证 receipt 和文件哈希，并恢复上次安装留下的备份：

```powershell
pnpm assets:uninstall -- --dry-run
pnpm assets:uninstall
```

可用 `--no-restore-backup` 只移除当前安装，或用 `--pet-id <id>` 明确目标；检测到未知或已修改文件时仍需显式 `--force`。测试其他 Codex 配置可向安装和卸载命令传入 `--codex-home <path>`。

有本地经典素材时，默认宠物 ID 为 `custom:qq-penguin`；没有时安装公开原创宠物 `custom:codex-aurora-penguin`。安装后进入 Codex 的 `Settings → Pets`，刷新并选择对应宠物。

## Codex Pets V2 图集

- 图集：透明 PNG 或 WebP，`1536 × 2288`
- 网格：8 列 × 11 行
- 单帧：`192 × 208`
- `pet.json`：必须显式设置 `"spriteVersionNumber": 2`

| 行 | 动作 | 有效帧 |
| ---: | --- | ---: |
| 0 | idle | 6，另在第 7 格放中性 QA 帧 |
| 1 | running-right | 8 |
| 2 | running-left | 8 |
| 3 | waving | 4 |
| 4 | jumping | 5 |
| 5 | failed | 8 |
| 6 | waiting / needs input | 6 |
| 7 | running / working | 6 |
| 8 | review / ready | 6 |
| 9–10 | 16 个顺时针视线方向 | 每行 8 |

## 状态桥接

Windows 宠物读取当前用户目录下的 `.codex-pet\state.json`。可用命令模拟状态：

```powershell
pnpm state running
pnpm state waiting
pnpm state jumping
pnpm state failed
pnpm state idle
pnpm state running -- --ttl-ms 90000 --session demo-1
```

当前格式：

```json
{
  "state": "running",
  "updatedAt": 1783950000000,
  "source": "codex-notify",
  "sessionId": "thread-123",
  "expiresAt": 1783950090000
}
```

- `updatedAt` 必须是 JSON 数值类型的正安全整数 Unix 毫秒（不大于 `Number.MAX_SAFE_INTEGER`）；字符串、布尔值、非整数数值、非有限值、非正数或超界值都不会接管当前状态。
- `sessionId` 区分不同任务或桥接器，读入时会去除首尾空白；缺少、空白或非字符串值归入 `legacy`，写入器则生成安全默认 ID。有效的新会话即使时间戳较旧也可接管状态。
- `expiresAt` 可为 Unix 毫秒或可解析的日期时间字符串；到期自动回到 `idle`。
- 旧格式仍兼容：非 `idle` 且缺少、无效或非正数的 `expiresAt` 时，以 `updatedAt + 15 分钟` 作为安全过期时间；缺少、空白或非字符串的 `sessionId` 归入 `legacy` 会话。
- 标准 V2 状态为 `idle`、`running-right`、`running-left`、`waving`、`jumping`、`failed`、`waiting`、`running`、`review`；桌面版另支持 `looking`、`mischief`、`lying`、`rolling`。

Codex 的外部 [`notify`](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications) 当前只发送 `agent-turn-complete`。安装后的桌面程序通过 `Codex Pet.exe --codex-notify <JSON>` 直接接收事件，不依赖 Node.js，并把它映射为短时 `jumping` 状态；官方 `thread-id` 用于隔离任务会话。源码中的 `scripts/codex-notify.mjs` 保留给开发和第三方桥接测试，它还兼容自定义的 `fail` / `error` 事件，但这不是 Codex 官方当前提供的失败事件。`notify` 也不是完整实时任务监听器；工作中和等待输入等阶段仍由状态文件桥接。

## 验证与发布

日常改动运行统一验证：

```powershell
pnpm verify
```

它检查版本一致性、脚本语法、TypeScript、Web 构建、公开原创图集、无透明色边、连续性、PowerShell、Rust/Tauri 编译与单元测试，并在本机可用时调用 Codex 官方图集校验器。发布前运行：

```powershell
pnpm release:gate
```

`pnpm build` 是同一发布门禁的别名。发布门禁强制生成原创 Aurora 图集，执行 Rust/Tauri 编译与单元测试，构建唯一的 NSIS 桌面安装器，并检查 Git 中没有本地经典素材或未批准栅格文件。CI 使用 `pnpm verify:ci` 执行同一条正式链路。本地经典图集另须通过零警告的 V2 权威 QA 汇总、低透明度青色色边清零和完整 14 对方向盲测；盲测图由待测图集确定性生成，三位隔离评审必须逐项一致且置信度不低于 `medium`，图集、盲测图和原始 verdict 均以 SHA-256 绑定，旧汇总不能复用。生成目录和固定输出还会拒绝符号链接与 Windows junction，避免构建写出项目边界。

每个安装器同时生成同名 `.sha256` 与 `.release.json`。发布门禁重新计算哈希，并核对版本、构建配置、文件大小、当前 Git commit、构建时间和工作区清洁状态；正式 Release 拒绝从脏工作区或旧 commit 生成的工件。标签 `v<package-version>` 推送后，GitHub Actions 会复跑同一门禁，并将安装器及两份校验文件一起发布。

公共桌面构建始终强制使用原创 Aurora 企鹅，即使本机存在经典素材：

```text
src-tauri\target\release\bundle\nsis\Codex Pet_0.3.0_x64-setup.exe
```

`pnpm build:tauri` 和 `pnpm build:desktop` 都走同一公共构建器，不会把本地经典素材装入安装器。本地经典角色只用于 `pnpm dev` 的个人实验。

## 项目结构

```text
src/                    Tauri/Web 前端状态机
src-tauri/              Tauri 2 原生桌面壳
windows/                Windows 图集验证支持脚本
scripts/                图集、QA、安装、发布和状态桥接
docs/                   角色与接口说明
public/aurora-penguin*.png  MIT 许可的原创公共角色源图
.local-assets/          本地第三方素材与衍生文件（Git 忽略）
```

## 许可证与责任边界

源代码、文档、原创 Aurora 企鹅和项目自制应用图标采用 [MIT License](LICENSE)。经典 QQ 企鹅参考、像素重绘、衍生图集，以及任何标记为 `local-classic` 的包均不在 MIT 授权范围内，也不应上传到 GitHub Releases、软件商店或其他公开渠道。贡献和安全说明分别见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [SECURITY.md](SECURITY.md)。
