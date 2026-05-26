import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const read = (rel) =>
  fs.readFileSync(new URL(rel, import.meta.url), 'utf8')

// 1. ArtifactPane 走真实 /api/artifacts/.../slides 解析
test('P2 ArtifactPane 从 /api/artifacts/:file/slides 拉真实页', () => {
  const src = read('../src/components/ArtifactPane.jsx')
  assert.match(src, /\/api\/artifacts\/\$\{encodeURIComponent\(file\)\}\/slides/)
  // 鉴权
  assert.match(src, /getAuthToken/)
  // 失败 / 加载状态
  assert.match(src, /loadState/)
  assert.match(src, /ErrorState/)
  assert.match(src, /LoadingState/)
  // 不再硬编码 3 页 mock
  assert.ok(!/p1.*封面.*开场[\s\S]*p2.*问题与机会[\s\S]*p3.*下一步推进/.test(src),
    'ArtifactPane 不应再保留 3 页固定 mock')
})

// 2. MarkdownRenderer 自动识别 marker
test('P2 MarkdownRenderer 接入 artifactMarker', () => {
  const src = read('../src/components/MarkdownRenderer.jsx')
  assert.match(src, /artifactMarker/)
  assert.match(src, /artifact:/)
  assert.match(src, /artifact:open/)
  // a-handler 拦截 artifact: scheme
  assert.match(src, /href\.startsWith\(ARTIFACT_SCHEME\)/)
  // urlTransform 保留 artifact: scheme 不被 sanitize
  assert.match(src, /urlTransform/)
})

// 3. server 暴露 slides 解析路由
test('P2 server /api/artifacts/:file/slides 路由', () => {
  const app = read('../server/appServer.js')
  assert.match(app, /handleArtifactSlides/)
  assert.ok(app.includes('\\/api\\/artifacts\\/[^/?#]+\\/slides'), 'appServer 应有 slides 路由判别')

  const svc = read('../server/services/artifactGen.js')
  assert.match(svc, /export async function handleArtifactSlides/)
  // size 上限 50MB
  assert.match(svc, /SLIDES_MAX_BYTES\s*=\s*50\s*\*\s*1024\s*\*\s*1024/)
  // 限定 .pptx
  assert.match(svc, /endsWith\('\.pptx'\)/)
})

// 4. ChatSplit 保留 ProjectFilesPane mount (display:none) 解决滚动丢
test('P2 ChatSplit 切 artifact 时 ProjectFilesPane 保持 mount', () => {
  const src = read('../src/pages/ChatSplit/index.jsx')
  // 期望有 display: activeArtifact ? 'none' : 'block'
  assert.match(src, /display:\s*activeArtifact\s*\?\s*'none'/)
})

// 5. ChatHeader ⋯ 菜单焦点循环
test('P2 ChatHeader ⋯ 菜单加键盘 Arrow / Escape', () => {
  const src = read('../src/pages/ChatSplit/ChatHeader.jsx')
  assert.match(src, /onMenuKeyDown/)
  assert.match(src, /ArrowDown/)
  assert.match(src, /ArrowUp/)
  assert.match(src, /Escape/)
  assert.match(src, /triggerRef/)
})

// 6. pptxParse 模块导出
test('P2 pptxParse 模块导出 parsePptx', () => {
  const src = read('../src/lib/pptxParse.js')
  assert.match(src, /export async function parsePptx/)
  assert.match(src, /JSZip/)
  // 安全上限
  assert.match(src, /maxBytes/)
})
