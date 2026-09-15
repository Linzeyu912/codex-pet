# 图像生成记录

工具：内置 image_gen。

最终源图：`public/qq-penguin-source.png`。运行时使用构建脚本生成的透明图集，桌面版与 Codex 内置版共用同一来源。

## 当前角色与动画约束

- 黑白企鹅，橙色嘴脚，红围巾，像素风格。
- 围巾只有一个下垂尾端，固定在自身左侧；正面与左行可见，右行与背面被遮挡。
- 4×4 姿态表包含左右行走、正面、背面、挥手、侧躺与恢复姿态。
- 固定镜头与身体比例，构建时所有姿态使用同一缩放系数，并对齐脚底基线。
- 源图使用绿色色键背景，构建时去除；最终 PNG 与 WebP 保留透明通道。

## 最后一次围巾遮挡修正提示词

以下为内置图像工具最后一次编辑使用的提示词，描述对左行四帧的局部调整。当前设定以以上约束及源图为准。

Edit target: this exact 4x4 pixel sprite sheet.Change ONLY the four LEFT-FACING walking penguins in the FIRST ROW: restore one short RED hanging scarf end on the near-side upper chest, attached to the existing red neck ring, hanging down along the boundary between white chest and near black wing. The scarf end belongs to the character's anatomical LEFT side (viewer right in front view), hence visible in LEFT-facing profile. Consistent same short rectangular tab in all 4 first-row frames; end around 68-70% of character full height. It should match the front-view tab in row3 col2, with slight pixel shading and tiny gait motion. Rows2,3,4 must stay exactly unchanged: RIGHT-facing walking penguins must keep NO hanging scarf end, back views NO end, front views one existing end. Preserve every character outline, head/body proportions, posture, feet, position, 4x4 cell grid, canvas dimensions, all colors outside new scarf tabs. No resizing, no zoom, no re-centering. Keep solid green chroma background. No text or shadows. This is an occlusion correction for ONE physical scarf tab, not adding a second scarf.
