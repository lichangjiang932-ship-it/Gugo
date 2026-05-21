# Your Model Atelier — 3D 封面页设计文档

## 概述

这是一个全屏 3D 动态进入页面，作为网站的总封面。用户进入网站后首先看到这个令人印象深刻的 3D 场景，然后点击按钮进入主应用。

## 主题

- **风格**: 温暖、极简、现代、具有工匠精神的艺术工作室感
- **配色**: 
  - 背景: `#1a1510` (暖黑/深棕)
  - 主文字: `#f4efe5` (暖白)
  - 强调色: `#E86A3C` (琥珀/余烬橙)
  - 次要文字: `#8a7b68` (暖灰)
  - 球体发光: 从中心 `#E86A3C` 到边缘 `#2E8FA3` (青色) 的渐变
- **字体**: Cormorant Garamond (标题), Inter (正文), JetBrains Mono (装饰)

## 结构

整个页面为单屏全屏 (`100vh × 100vw`)，无滚动。

### 布局层次 (从底到顶)

1. **Three.js Canvas** — 全屏底层，包含 3D 场景
2. **暗角遮罩** — 径向渐变遮罩，增强中心聚焦
3. **文字内容层** — 居中对齐的文字组
4. **导航按钮** — 底部居中

### 内容

- **主标题**: "Your Model Atelier" — Cormorant Garamond, 48px, italic, 暖白色
- **副标题**: "你的 AI 模型工坊" — Inter, 16px, 300 weight, 暖灰色
- **装饰线**: 一条水平细线，带余烬色发光
- **提示文字**: "按任意键或点击进入" — JetBrains Mono, 12px, 暖灰色，呼吸动画

## 3D 场景

### 核心球体 (Wireframe Icosphere)

- **几何体**: IcosahedronGeometry, radius 2.5, detail 2
- **材质**: MeshBasicMaterial, wireframe: true, color: `#E86A3C`, transparent: true, opacity: 0.15
- **动画**: 持续缓慢旋转 (Y轴: 0.001 rad/frame, X轴: 0.0005 rad/frame)

### 粒子系统 (Orbiting Particles)

- **数量**: 2000 个粒子
- **几何体**: BufferGeometry 配合自定义位置属性
- **分布**: 球面随机分布，半径 2.0 - 4.0
- **材质**: PointsMaterial, size: 0.015, color: `#f4efe5`, transparent: true, opacity: 0.6
- **动画**: 整体粒子群缓慢旋转，每个粒子有微小的独立相位偏移

### 内部核心球 (Core Sphere)

- **几何体**: SphereGeometry, radius 0.8
- **材质**: MeshBasicMaterial, color: `#E86A3C`, transparent: true, opacity: 0.08
- **动画**: 脉冲呼吸效果 (scale 在 0.95 - 1.05 之间正弦波动)

### 光环 (Ring)

- **几何体**: RingGeometry, innerRadius 3.2, outerRadius 3.25
- **材质**: MeshBasicMaterial, color: `#2E8FA3`, transparent: true, opacity: 0.3
- **动画**: 持续旋转 (Z轴: 0.002 rad/frame)

### 后期效果

- **Bloom**: 使用 @react-three/drei 的 EffectComposer + Bloom
  - intensity: 0.8
  - luminanceThreshold: 0.2
  - luminanceSmoothing: 0.9

## 交互

### 鼠标交互

- **球体旋转偏移**: 鼠标位置影响球体旋转速度 (±50%)
- **视差效果**: 鼠标移动时，文字层有微小的反向视差 (±10px)

### 进入过渡

- **触发**: 点击页面或按任意键
- **动画序列**:
  1. 3D 场景向内收缩 (scale 1 → 0)，同时加速旋转
  2. 文字内容向上淡出 (opacity 1 → 0, translateY 0 → -50px)
  3. 整体背景渐变为黑色
  4. 导航到 `/chat` 路由
- **时长**: 1200ms
- **缓动**: cubic-bezier(0.76, 0, 0.24, 1)

## 动画时间线 (入场)

| 时间 (ms) | 元素 | 动画 |
|-----------|------|------|
| 0 | 背景 | 从黑色渐变为 #1a1510 |
| 200 | 球体 | scale 0 → 1, opacity 0 → 1 (800ms, ease-out) |
| 400 | 粒子 | 从球心向外扩散到位置 (1000ms, ease-out) |
| 600 | 主标题 | opacity 0 → 1, translateY 30px → 0 (600ms, ease-out) |
| 800 | 副标题 | opacity 0 → 1, translateY 20px → 0 (500ms, ease-out) |
| 1000 | 装饰线 | width 0 → 120px (400ms, ease-out) |
| 1200 | 提示文字 | opacity 0 → 0.6, 开始呼吸动画 |

## 技术栈

- @react-three/fiber — React Three.js 渲染器
- @react-three/drei — 辅助组件 (Bloom, OrbitControls 等)
- framer-motion — 文字层动画和页面过渡
- react-router-dom — 路由导航
