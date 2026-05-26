import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const read = (rel) =>
  fs.readFileSync(new URL(rel, import.meta.url), 'utf8')

// 1. Noto Sans SC webfont 在 index.html
test('P1 index.html 引入 Noto Sans SC webfont', () => {
  const src = read('../index.html')
  assert.match(src, /family=Noto\+Sans\+SC/)
  assert.match(src, /fonts\.googleapis\.com/)
})

// 2. ChatHeader 用 p0 token + ⋯ 菜单
test('P1 ChatHeader 用 p0 token + ⋯ 折叠菜单', () => {
  const src = read('../src/pages/ChatSplit/ChatHeader.jsx')
  assert.match(src, /var\(--p0-card\)/)
  assert.match(src, /var\(--p0-border\)/)
  assert.match(src, /var\(--p0-accent\)/)
  assert.match(src, /MoreHorizontal/)
  // 菜单语义
  assert.match(src, /aria-label="更多操作"/)
  assert.match(src, /role="menu"/)
  // 旧 ember/paper/ink 主题类应已移除
  assert.ok(!/border-ink-fade\/50/.test(src), 'ChatHeader 仍有旧 ink-fade 主题类')
})

// 3. ChatComposer 用 p0 token
test('P1 ChatComposer 用 p0 token + 发送按钮 disabled 灰', () => {
  const src = read('../src/pages/ChatSplit/ChatComposer.jsx')
  assert.match(src, /var\(--p0-card\)/)
  assert.match(src, /var\(--p0-border\)/)
  assert.match(src, /var\(--p0-accent\)/)
  // 发送按钮 canSend 判定
  assert.match(src, /canSend/)
  // disabled 灰 = border-strong
  assert.match(src, /var\(--p0-border-strong\)/)
})

// 4. LeftRail "+新对话" 卡片样式 + p0 token
test('P1 LeftRail 新对话按钮 + 会话分组用 p0 token', () => {
  const src = read('../src/components/LeftRail.jsx')
  assert.match(src, /var\(--p0-card\)/)
  assert.match(src, /var\(--p0-accent\)/)
  assert.match(src, /var\(--p0-text-secondary\)/)
  // 旧 "Ctrl N" 提示已移除
  assert.ok(!/Ctrl N/.test(src), 'LeftRail 仍残留 Ctrl N 提示')
  // 旧 ember/paper/ink 视觉应不再出现在新对话按钮区
  assert.ok(!/border-ink\/80/.test(src), 'LeftRail 新对话按钮仍是 ink/80 边框')
})

// 5. ChatSplit 在空状态把 composer 居中嵌进 AgentEmptyState
test('P1 ChatSplit 空状态时 composer 嵌进 AgentEmptyState', () => {
  const src = read('../src/pages/ChatSplit/index.jsx')
  // 空状态分支应该包含 <ChatComposer
  // 用粗略检测：messages.length === 0 后面紧跟 AgentEmptyState>...<ChatComposer
  const empty = src.indexOf('messages.length === 0')
  assert.ok(empty > 0, 'ChatSplit 未发现空状态分支')
  const afterEmpty = src.slice(empty, empty + 3000)
  assert.match(afterEmpty, /<AgentEmptyState[\s\S]*?<ChatComposer/)
  // 同时仍有外层 (非空) 的 ChatComposer
  assert.ok(src.split('<ChatComposer').length >= 3, 'ChatComposer 应渲染两处（空 / 非空）')
})

// 6. ArtifactPane 新组件存在 + 头栏关闭/下载/全屏 + 缩略图列
test('P1 ArtifactPane 头栏 + 缩略图列 + 大图', () => {
  const src = read('../src/components/ArtifactPane.jsx')
  assert.match(src, /data-testid="artifact-pane"/)
  assert.match(src, /aria-label="返回聊天"/)
  assert.match(src, /aria-label="下载"/)
  // 全屏 / 退出全屏
  assert.match(src, /aria-label=\{fullscreen \? '退出全屏' : '全屏'\}/)
  // 缩略图列
  assert.match(src, /aria-label="页面缩略图"/)
  // P2: 已去 mock, 走真 /api/artifacts/:file/slides
  assert.match(src, /\/slides/)
  assert.match(src, /loadState/)
  // 用 p0 token
  assert.match(src, /var\(--p0-card\)/)
  assert.match(src, /var\(--p0-accent\)/)
})

// 7. ChatSplit 接入 ArtifactPane + activeArtifact state + 事件触发
test('P1 ChatSplit 接入 ArtifactPane + activeArtifact', () => {
  const src = read('../src/pages/ChatSplit/index.jsx')
  assert.match(src, /import ArtifactPane/)
  assert.match(src, /activeArtifact/)
  assert.match(src, /setActiveArtifact/)
  assert.match(src, /artifact:open/)
  // 切换逻辑：activeArtifact ? <ArtifactPane/> : <ProjectFilesPane/>
  assert.match(src, /activeArtifact \?[\s\S]*?<ArtifactPane/)
})
