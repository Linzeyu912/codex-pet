# 验证记录

2026-09-15，Windows 本机验证。

- `pnpm verify` 通过：脚本语法、版本一致性、前端构建、安装安全、状态桥接、运行策略、角色回归、PowerShell、Rust 编译及 9 项 Rust 单测。
- Codex 官方 V2 校验器分别检查 PNG / WebP，均为 ok=true、errors=[]、warnings=[]。
- 模拟缩小单个姿态、背面新增围巾尾端、删除左行围巾尾端、反转视线方向的四个反例均被回归检查拒绝。
- 19 组主/桌面图集对应帧逐像素一致，16 个桌面姿态均接地于 y=187。
- 当前站立源帧可见高度 161–170px，差异约 5.6%；这是生成姿态的残差。构建使用一个共同缩放系数，不按单帧面积/最长边二次拉伸。
- 左行四帧有同一围巾尾端，右行和背面尾端像素为零；正面仅观众右侧一个短尾端。16 方向瞳孔最大角度误差约 7.04°。
- 图像 alpha 为 0/255，无绿色背景残留；完全透明像素 RGB 为零。
- 网页运行预览检查：正确加载红围巾企鹅、动作菜单和转身动作。
- Codex 安装器在 `.local-assets/codex-install-check` 隔离目录成功安装 `qq-penguin`，未改动用户当前的 Codex 配置。
- `pnpm build:desktop -- --debug` 与 `node scripts/check-public-release.mjs --debug` 通过；已运行打包后的 EXE 的独立通知测试。

## 限制

两个文件符号链接攻击测试因 Windows 的 EPERM 权限限制自动跳过，其余安全测试通过。桌面包为未优化的 debug 试用构建，未发布、未签名。正式发布仍需提交工作区并运行 release gate。

## 工件

- `release/Codex Pet_0.3.1_x64-setup.exe`：Windows 桌面试用安装器；同目录包含 SHA-256 和构建元数据。
- `release/qq-penguin-codex-v2.zip`：Codex 内置宠物包。
- `.local-assets/verification.log`、`.local-assets/desktop-build.log`、`.local-assets/desktop-package-check.log`：完整本机日志。
