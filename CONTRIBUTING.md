# Contributing to Your Model Atelier

感谢你愿意贡献！本项目是一个本地/内网可用的 Web AI 工作台，欢迎 Issue、PR、文档改进、技能包贡献。

## 快速开始

```bash
git clone https://github.com/lichangjiang932-ship-it/your-model-atelier.git
cd your-model-atelier
npm install
git config core.hooksPath .githooks  # 启用 pre-commit hook（防 secret-redaction 误改字面量）
cp .env.example .env   # 按需配置
npm run dev            # 前端 HMR
npm run serve          # 启动 server
npm test               # 跑测试套（当前 574 用例）
```

## 工作流

1. **开 issue 先**：实质性改动请先开 issue 讨论方向，避免做无用功
2. **分支命名**：`feat/<scope>-<short-desc>` / `fix/<scope>-<short>` / `chore/<short>` / `docs/<short>`
3. **小步提交**：单个 PR 聚焦一件事；commit 信息用 [Conventional Commits](https://www.conventionalcommits.org/)
4. **测试驱动**：新功能必须带测试，bug 修复必须带回归测试
5. **跑全套再提**：PR 前必须 `npm run lint && npm test && npm run build` 全过
6. **Self-review**：提 PR 前先自己 review 一遍 diff，去掉 `console.log` 和实验性代码

## Git hooks

本仓库自带 `.githooks/pre-commit`，防 secret-redaction 工具误把字面量替成 `'***'`（参 PROGRESS.md "已知问题"）。
clone 后跑一次启用：

```bash
git config core.hooksPath .githooks
```

紧急 bypass：`git commit --no-verify`（仅当 `'***'` 是有意为之时）。

## 代码风格

- 遵循现有风格（ESLint 配置已定），不要私自换 prettier 配置
- 中文注释 OK，但 commit message / PR title 用中文或英文均可
- 禁用 emoji 装饰（功能性 emoji 如 unicode 图标可保留）
- 禁用占位符（`// TODO` / `// ...` / `// 此处省略`），要么写完要么开 issue 追踪

## 提交 PR

1. Fork → 新分支 → 改 → push
2. 开 PR 时填清楚：
   - **改了什么 / 为什么改**
   - **如何验证**（贴测试输出 / 截图 / 复现步骤）
   - **影响范围 / 风险**
3. CI 必须全绿才合
4. 至少一位 maintainer review approve

## Skill / Plugin 贡献

- Skill（提示词 + 工具配置）：扔进 `skill-packs/<your-skill>/`，参考 `skill-packs/guizang-ppt/` 结构
- Plugin（带代码）：目前用静态配置模式，参考 `examples/plugins/`（开发中）

## 报告安全问题

**不要**开公开 issue。请按 [SECURITY.md](./SECURITY.md) 流程私下报告。

## 行为准则

参见 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。

## License

贡献即视为同意以 MIT 协议授权你的代码。
