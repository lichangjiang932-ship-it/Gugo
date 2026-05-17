# guizang-ppt 技能包

来源：https://github.com/op7418/guizang-ppt-skill （MIT，作者 歸藏）

## 内容
- `skill.json` — manifest
- `prompts/system.md` — 完整规范（SKILL.md + 两套 HTML 模板源码 + 主题色 + 布局），约 309 KB

## 导入
1. 浏览器 `http://127.0.0.1:5175/#/skills`
2. 「上传技能包」→ 选 `skill-packs/guizang-ppt/` 文件夹
3. 聊天输入 `/guizang-ppt 你的主题`

## 风格
- A 电子杂志风：衬线 + WebGL 流体，人文/Monocle
- B 瑞士国际主义：无衬线 + 网格点阵 + IKB / 柠檬黄，科技/数据

## 注意
- system.md ≈ 80k tokens，每次对话固定开销，建议长上下文模型
- 只用 `prompts/system.md`（jobRuntime.js:92 只读这个文件），其他 reference 已合并进去
