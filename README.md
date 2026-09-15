# Codex Pet · 红围巾企鹅

当前版本：`0.4.0`。

怀念 QQ 农场的黑白企鹅：橙色嘴脚，红围巾，尾端固定在自身左侧，正面与左行可见，右行和背面被遮挡。

非官方同人作品。QQ 企鹅形象及相关标识的权利归原权利人所有。如有侵权，请联系删除。详见 [素材说明](ASSET-LICENSES.md)。

## 两种版本

| 版本 | 使用方式 |
| --- | --- |
| Windows 桌面版 | Tauri 透明置顶窗口、拖动、托盘、巡游、挥手、转身、侧躺和翻滚 |
| Codex 内置宠物版 | Pets V2 图集，宠物 ID 为 `custom:qq-penguin` |

两版本共用角色源图和缩放系数，跨图集的同一姿态逐像素一致。

## 下载

在 [GitHub Releases](https://github.com/Linzeyu912/codex-pet/releases/latest) 下载当前正式版本：

- Windows 桌面版：下载 `.exe` 安装包运行安装。
- Codex 内置版：解压 `qq-penguin-codex-v2.zip`，将其中的 `qq-penguin` 文件夹放入 `%USERPROFILE%\.codex\pets\`；自定义 `CODEX_HOME` 时放入该目录下的 `pets` 文件夹。

两种版本可以同时使用。

## 开发与运行

需要 Node.js 22.12+、pnpm 11、Python 3 与 Pillow（用于保留 WebP 透明像素）；桌面版另需 Rust、Windows C++ 构建工具和 WebView2。

```powershell
git clone https://github.com/Linzeyu912/codex-pet.git
cd codex-pet
pnpm install --frozen-lockfile
python -m pip install "Pillow>=10,<14"
pnpm assets:prepare
pnpm dev
```

网页预览：`pnpm dev:web`。桌面试用安装包：`pnpm build:desktop -- --debug`。正式打包使用 `pnpm build:desktop`，要求工作区已提交且干净。

## 安装到 Codex

```powershell
pnpm assets:install -- --dry-run
pnpm assets:install
```

安装器写入 `%CODEX_HOME%/pets/qq-penguin/`，默认使用用户目录下的 `.codex`。重启 Codex，在 Settings → Pets 选择红围巾企鹅。原有文件冲突会被报告；安装器支持备份、ownership receipt 和原子替换。

```powershell
pnpm assets:uninstall -- --dry-run
pnpm assets:uninstall
```

桌面版的“连接 Codex…”也能安装同一宠物并配置完成通知；已有 notify 配置会保留并提示冲突。

## 动作与状态

左键拖动、双击挥手、右键选择动作或暂停巡游。Codex 完成一轮任务后可通过 notify 触发跳跃。

```powershell
pnpm state -- running
pnpm state -- waiting
pnpm state -- failed
pnpm state -- idle
```

## 验证

```powershell
pnpm assets:prepare
pnpm assets:continuity
pnpm verify
```

检查包括图集尺寸与透明通道、共同缩放、脚底基线、跨图集像素一致性、围巾遮挡、瞳孔方向、动作连续性，以及安装安全、前端和桌面编译。

## 文件

- `public/qq-penguin-source.png`：内置图像工具生成的统一姿态表；绿色是构建时去除的色键背景。
- `public/local/`：生成的透明运行时图集。
- `.local-assets/qq-penguin/codex-pet/`：Codex 安装源、桌面姿态图和几何报告。
- [角色设定](docs/character-brief.md) · [接口契约](docs/codex-pet-contract.md) · [生成记录](docs/image-generation.md)
