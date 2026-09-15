# Codex Pets V2 接口契约

本文记录 Codex Pet `0.4.0` 使用的 Codex 自定义宠物格式、状态桥接和本地桌面扩展。Codex 官方说明见 [Pets](https://learn.chatgpt.com/docs/pets)。

## Codex 宠物目录

```text
%CODEX_HOME%\pets\<pet-id>\
├─ pet.json
└─ spritesheet.webp
```

未设置 `CODEX_HOME` 时，使用当前用户的 `.codex` 目录。Codex 扫描 `pets` 的下一级子目录；目录名 `qq-penguin` 对应运行时 ID `custom:qq-penguin`。

本项目安装器还会写入 `.codex-pet-install-receipt.json`。它只供安全升级和卸载使用，不属于 Codex Pets 格式，也不会被图集运行时读取。

## pet.json

```json
{
  "id": "qq-penguin",
  "displayName": "QQ Penguin",
  "description": "A local classic red-scarf pixel penguin companion.",
  "spriteVersionNumber": 2,
  "spritesheetPath": "spritesheet.webp"
}
```

| 字段 | 本项目要求 |
| --- | --- |
| `id` | 安全的非空标识，只使用字母、数字、点、下划线和连字符，并与目标目录用途一致。 |
| `displayName` | Codex 设置页显示名称。 |
| `description` | 可省略或设为 `null`。 |
| `spriteVersionNumber` | V2 必须显式为 `2`；缺省可能被当作 V1。 |
| `spritesheetPath` | 默认为 `spritesheet.webp`，且必须留在宠物目录内。 |

## V2 图集

- 格式：透明 PNG 或 WebP
- 总尺寸：`1536 × 2288`
- 网格：`8 × 11`
- 单格：`192 × 208`
- 未使用格：除 `row 0 / col 6` 的中性 QA 格外完全透明；透明像素的 RGB 也清零

| Row | 名称 | 列 | 官方基础帧时长（毫秒） |
| ---: | --- | --- | --- |
| 0 | idle | 0–5 | `280, 110, 110, 140, 140, 320` |
| 1 | running-right | 0–7 | 前 7 帧 `120`，末帧 `220` |
| 2 | running-left | 0–7 | 前 7 帧 `120`，末帧 `220` |
| 3 | waving | 0–3 | 前 3 帧 `140`，末帧 `280` |
| 4 | jumping | 0–4 | 前 4 帧 `140`，末帧 `280` |
| 5 | failed | 0–7 | 前 7 帧 `140`，末帧 `240` |
| 6 | waiting | 0–5 | 前 5 帧 `150`，末帧 `260` |
| 7 | running | 0–5 | 前 5 帧 `120`，末帧 `220` |
| 8 | review | 0–5 | 前 5 帧 `150`，末帧 `280` |
| 9 | look 0°–157.5° | 0–7 | 每格递增 `22.5°` |
| 10 | look 180°–337.5° | 0–7 | 每格递增 `22.5°` |

`0°` 指屏幕上方，16 个方向顺时针排列。无有效指针向量时回退到 idle。`row 0 / col 6` 放置中性正面 QA 帧；`row 0 / col 7` 和其他未使用格保持透明。

## 状态与动作映射

| Codex/桥接状态 | V2 动作 |
| --- | --- |
| `running` / working / thinking | row 7 `running` |
| `waiting` / needs input | row 6 `waiting` |
| `review` / ready | row 8 `review` |
| `failed` / blocked | row 5 `failed` |
| `idle` | row 0 `idle` |
| `waving` | row 3 `waving` |
| `jumping` / complete | row 4 `jumping` |
| 水平向右拖动 | row 1 `running-right` |
| 水平向左拖动 | row 2 `running-left` |

桌面运行时按表内的逐帧时长播放。有限动作会完成整个循环；远端 `failed` 完成一轮后停留在躺倒帧，直到状态变化或过期。拖拽结束、自动碰边转向和定时结束方向动作都在当前步态的循环边界生效，避免中途切回正面；拖动过程根据水平位移选择左右步态。

## 桌面专用姿态扩展

Codex V2 固定为上述 11 行，不增加自定义动作行。为了让独立桌面版拥有真正的侧面、背面和躺姿，本项目可在本地生成另一张图集：

```text
public/local/desktop-poses.png
```

- 尺寸：`768 × 832`
- 网格：`4 × 4`
- 单格：`192 × 208`
- 16 格均为非空姿态，并使用统一尺度和脚底基线

姿态来源是 `public/qq-penguin-source.png`：第 1 行左侧步态，第 2 行右侧步态，第 3 行背面/回头/过渡，第 4 行侧躺/仰躺/翻滚/恢复。Tauri 在检测到该图集时，用它编排：

- `mischief`：正面 → 回头 → 背身调皮 → 转回正面
- `lying`：正面 → 下蹲/转身 → 侧躺/仰躺 → 坐起 → 正面
- `rolling`：正面 → 侧倒 → 翻身 → 恢复坐姿 → 正面

没有 `desktop-poses.png` 时，这三种桌面动作退回 V2 `failed` 行的兼容序列。该扩展不会复制到 Codex 的宠物目录；Tauri 安装器包含同一套红围巾图集。

## 状态文件协议

桌面端轮询当前用户目录下的 `.codex-pet/state.json`：

```json
{
  "state": "running",
  "updatedAt": 1783950000000,
  "source": "codex-notify",
  "sessionId": "thread-123",
  "expiresAt": 1783950090000
}
```

| 字段 | 约束 |
| --- | --- |
| `state` | 必须是已知 V2 状态或桌面扩展状态。 |
| `updatedAt` | JSON 数值类型的正安全整数 Unix 毫秒（不大于 `Number.MAX_SAFE_INTEGER`）；字符串、布尔值、非整数数值、非有限值、非正数或超界值不接管状态，同一会话内只接受更大的时间戳。 |
| `source` | 可选来源标签，用于诊断。 |
| `sessionId` | 可选字符串会话标识；读入前去除首尾空白，缺少、空白或非字符串时使用 `legacy`。有效 ID 变化时允许新会话接管，不与旧会话时间戳冲突；写入器对空白值生成安全默认 ID。 |
| `expiresAt` | 可选 Unix 毫秒或可解析日期时间；到期自动回到 `idle`。非 `idle` 状态提供无效或非正数时按旧格式安全回退。 |

兼容旧格式：缺少、空白或非字符串的 `sessionId` 使用 `legacy`；非 `idle` 且缺少、无效或非正数的 `expiresAt` 时，以 `updatedAt + 15 分钟` 作为过期时间，防止陈旧状态永久占用。文件通过唯一临时文件和原子重命名写入，多个通知并发时不会暴露半写 JSON。

Codex 官方外部 [`notify`](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications) 当前只提供 `agent-turn-complete`，并在单个 JSON 参数中使用 `thread-id` 标识会话。公共桌面程序自身支持 `--codex-notify <JSON>`，无需 Node.js 即可把该事件原子写成短时 `jumping` 状态；源码桥接脚本继续保留第三方自定义失败事件兼容。

桌面扩展状态为 `looking`、`mischief`、`lying`、`rolling`。本地拖拽/演示与远端状态的时间戳、会话分别维护；交互结束后仍可恢复尚未完成且未过期的远端状态。

## 安装、升级与卸载约束

桌面版的首次启动引导复用相同的 ownership receipt 契约，并额外遵守用户配置边界：只修改用户级 `%CODEX_HOME%/config.toml`；仅当顶层 `notify` 不存在时写入 `["<当前 Codex Pet.exe>", "--codex-notify"]`；已有任意其他 `notify` 时报告冲突并保持文件逐字不变。配置文件或宠物目标是链接/junction 时拒绝写入。修改通知配置后需要重启 Codex 客户端。

安装器仅复制 `pet.json` 与 `spritesheet.webp`，并创建 ownership receipt：

1. `--dry-run` 只报告来源、目标、是否已准备和冲突，不写文件。
2. 正式安装先在 `pets` 下创建临时同级目录，复制并校验完整文件后，再通过重命名原子替换。
3. 已有目标先移动到 `%CODEX_HOME%\pets\.codex-pet-backups\<pet-id>\<timestamp>`。
4. 无 receipt、receipt 所有者不符、宠物 ID 或实际目标不一致、文件哈希变化或出现未知文件时默认拒绝覆盖；`--force` 表示用户检查后明确同意备份并替换，但不会授权信任外来 receipt 的备份路径。
5. 卸载默认验证 receipt 与哈希，备份必须真实位于 `.codex-pet-backups/<当前 petId>/` 下且整条路径不得包含链接或 junction；先原子移走当前安装，再恢复 receipt 记录的备份。恢复成功即为提交点，后续垃圾清理失败只保留待清理目录并警告；`--no-restore-backup` 可禁止恢复。

可用 `--codex-home <path>` 测试隔离配置，避免改动日常 Codex 目录。

## QA 与构建契约

桌面与 Codex 均使用 qq-penguin，源图为 public/qq-penguin-source.png。构建只使用一套姿态，不再选择不同角色。

共同缩放校验从所有源图/输出尺寸独立求交集；跨图集同一姿态逐像素相等。不同角度站立高度差上限 6%，检查的是生成源图的残差，不使用逐帧拉伸掩盖它。跳跃须为基准帧精确平移；瞳孔移动限制于眼白区域，并检查 16 方向语义。围巾尾端固定在自身左侧：正面观众右侧和左行近侧必须可见，右行与背面必须遮挡。

pnpm verify 检查图集、动画、脚本、安装安全、前端与 Rust。pnpm build:desktop -- --debug 生成可试用的桌面包；正式发布仍需干净工作区和发布工件校验。图像与代码许可边界见 ASSET-LICENSES.md。
