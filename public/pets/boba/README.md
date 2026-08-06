# Pet: Boba

桌面宠物的动画精灵表（Codex 标准 8×9 布局）。

- **宠物**: Boba — 一只喝着珍珠奶茶的小水獭（Petdex 社区人气第一）
- **来源**: [Petdex](https://petdex.dev) 开源宠物图库 (https://github.com/crafter-station/petdex)
- **精灵表**: `spritesheet.webp`，1536×1872，8 列 × 9 行，每格 192×208
- **行布局**: 0 idle(待机) / 1 walk-right(向右) / 2 walk-left(向左) / 3 wave(挥手) / 4 jump(跳跃) / 5 failed(失败) / 6 waiting(等待) / 7 thinking(思考) / 8 review(检查)
- **许可证**: MIT（Petdex 项目本身 MIT；宠物素材为社区贡献，使用遵循 Petdex 条款）

## 替换宠物

把新宠物的 `spritesheet.webp` 覆盖此文件即可（保持 1536×1872 标准 8×9 布局）。
如需多个宠物，在 `public/pets/<name>/spritesheet.webp` 添加并调整 `DesktopPet.jsx` 中的
`PET_SPRITESHEET_URL` 与状态行映射。
