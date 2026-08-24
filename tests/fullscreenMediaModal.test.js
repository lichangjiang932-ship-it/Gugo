import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { readSourceTree } from './sourceTree.js'

const componentPath = new URL('../src/components/FullscreenMediaModal.jsx', import.meta.url)
const composerPath = new URL('../src/pages/ChatSplit/ChatComposer.jsx', import.meta.url)
const markdownPath = new URL('../src/components/MarkdownRenderer.jsx', import.meta.url)

test('FullscreenMediaModal component exists and exports default', () => {
  const source = fs.readFileSync(componentPath, 'utf8')
  assert.match(source, /export default function FullscreenMediaModal/)
})

test('FullscreenMediaModal uses the shared portal modal with a framer-motion fade and black backdrop', () => {
  const source = fs.readFileSync(componentPath, 'utf8')
  assert.match(source, /from 'framer-motion'/)
  assert.match(source, /import Modal from '\.\/Modal\.jsx'/)
  assert.match(source, /<Modal/)
  assert.match(source, /motion\.div/)
  assert.match(source, /initial=\{\{ opacity: 0 \}\}/)
  assert.match(source, /animate=\{\{ opacity: 1 \}\}/)
  assert.match(source, /bg-black/)
  assert.doesNotMatch(source, /fixed inset-0/)
})

test('FullscreenMediaModal supports wheel zoom, drag pan, keyboard shortcuts', () => {
  const source = fs.readFileSync(componentPath, 'utf8')
  // 滚轮缩放
  assert.match(source, /onWheel/)
  assert.match(source, /deltaY/)
  // 拖拽
  assert.match(source, /onPointerDown/)
  assert.match(source, /onPointerMove/)
  // 缩放范围 0.25 - 5
  assert.match(source, /MIN_SCALE = 0\.25/)
  assert.match(source, /MAX_SCALE = 5/)
  // 键盘：Esc / +/- / 0 / ← / →
  assert.match(source, /'Escape'/)
  assert.match(source, /ArrowLeft/)
  assert.match(source, /ArrowRight/)
  assert.match(source, /e\.key === '0'/)
  assert.match(source, /e\.key === '\+'/)
})

test('FullscreenMediaModal renders close X button', () => {
  const source = fs.readFileSync(componentPath, 'utf8')
  assert.match(source, /from 'lucide-react'/)
  assert.match(source, /\bX\b/)
  assert.match(source, /aria-label="关闭全屏查看器"/)
})

test('FullscreenMediaModal accepts list/index for prev/next navigation', () => {
  const source = fs.readFileSync(componentPath, 'utf8')
  assert.match(source, /list = null/)
  assert.match(source, /onIndexChange/)
  assert.match(source, /goPrev/)
  assert.match(source, /goNext/)
})

test('ChatComposer opens image attachment thumbnails in the right preview pane', () => {
  const source = fs.readFileSync(composerPath, 'utf8') + readSourceTree('../src/pages/ChatSplit/chatComposer/')
  assert.match(source, /buildAttachmentPreviewArtifact/)
  assert.match(source, /onOpenAttachment/)
  assert.match(source, /onOpen=\{\(attachment\)/)
  assert.doesNotMatch(source, /setFullscreenSrc|<FullscreenMediaModal/)
})

test('MarkdownRenderer wires <img> click to FullscreenMediaModal', () => {
  const source = fs.readFileSync(markdownPath, 'utf8')
  assert.match(source, /FullscreenMediaModal/)
  assert.match(source, /cursor-zoom-in/)
  assert.match(source, /setFullscreen/)
})
