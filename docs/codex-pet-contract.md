# Codex Pets V2 接口契约

本文件记录 Codex Windows App 当前使用的自定义宠物格式，供图集生成器和后续皮肤作者使用。

## 文件结构

```text
%CODEX_HOME%\pets\<pet-name>\
├─ pet.json
└─ spritesheet.webp
```

`CODEX_HOME` 未设置时默认为 `%USERPROFILE%\.codex`。Codex 只扫描 `pets` 下一级子目录。

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

字段约束：

| 字段 | 要求 |
| --- | --- |
| `id` | 可选；非空字符串。运行时 ID 仍由目录名生成。 |
| `displayName` | 可选；设置页显示名称。 |
| `description` | 可选或 `null`。 |
| `spriteVersionNumber` | V2 必须显式写 `2`；缺省会被按 V1 处理。 |
| `spritesheetPath` | 缺省为 `spritesheet.webp`，且必须留在宠物目录内部。 |

目录名为 `qq-penguin` 时，运行时 ID 为 `custom:qq-penguin`。

## 图集

- 格式：PNG 或 WebP
- 色彩：RGBA，透明背景
- 总尺寸：`1536 × 2288`
- 网格：`8 × 11`
- 单格：`192 × 208`
- 未使用格：除 `row 0 / col 6` 的 neutral QA 格外，所有像素必须完全透明，透明像素 RGB 也应为零

## 行定义

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

`0°` 指向屏幕上方，16 个方向顺时针排列。无有效指针向量时回退到 idle。

当前官方 V2 校验器还要求 `row 0 / col 6` 放置中性正面 QA 帧，虽然该格不属于 idle 播放序列。`row 0 / col 7` 以及其他未使用格保持透明。

## Codex 状态映射

| Codex 状态 | 动作 |
| --- | --- |
| Running | row 7 `running` |
| Needs input | row 6 `waiting` |
| Ready | row 8 `review` |
| Blocked | row 5 `failed` |
| 普通信息 | row 0 `idle` |
| 首次唤醒 | row 3 `waving` |
| 鼠标悬停 | row 4 `jumping` |
| 水平拖动 | row 1 / row 2 |

## 本机验证

仓库的 `pnpm assets:build` 生成 V2 图集。随后可使用 Codex 安装内置的 `validate_atlas.py --require-v2` 做只读校验；成功结果的 `ok` 为 `true` 且 `errors` 为空。`warnings` 不会单独令校验失败，但仍应逐项审阅，本项目目标为零警告。
