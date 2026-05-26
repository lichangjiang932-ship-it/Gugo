import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const read = (rel) =>
  fs.readFileSync(new URL(rel, import.meta.url), 'utf8')

test('P0 AppShell \u63d0\u4f9b\u4e09\u5217\u7ed3\u6784(left/center/right)', () => {
  const src = read('../src/components/AppShell.jsx')
  assert.match(src, /data-testid="app-shell-left"/)
  assert.match(src, /data-testid="app-shell-center"/)
  assert.match(src, /data-testid="app-shell-right"/)
  // \u5de6\u680f\u5bbd 240, \u53f3\u680f\u5bbd 260
  assert.match(src, /width:\s*240/)
  assert.match(src, /width:\s*260/)
  // \u4f7f\u7528 P0 \u8272\u677f token
  assert.match(src, /var\(--p0-bg\)/)
  assert.match(src, /var\(--p0-border\)/)
})

test('P0 SettingsDrawer \u6536\u7eb3\u539f\u9876\u90e8 nav \u5165\u53e3', () => {
  const src = read('../src/components/SettingsDrawer.jsx')
  for (const path of ['/memory', '/skills', '/agents', '/mcp', '/hooks', '/permissions', '/history', '/settings']) {
    assert.ok(src.includes(`path: '${path}'`), `\u62bd\u5c49\u7f3a\u5c11\u5165\u53e3 ${path}`)
  }
  assert.match(src, /role="dialog"/)
  assert.match(src, /aria-modal="true"/)
})

test('P0 AgentEmptyState \u5305\u542b\u5934\u50cf/agent\u540d/\u8bb0\u5fc6/\u5de5\u4f5c\u53f0\u4fe1\u606f', () => {
  const src = read('../src/components/AgentEmptyState.jsx')
  assert.match(src, /\u968f\u65f6\u90fd\u5728/)
  assert.match(src, /\u8bb0\u5fc6/)
  assert.match(src, /\u5de5\u4f5c\u53f0/)
  assert.match(src, /\u64cd\u4f5c\u524d\u8be2\u95ee/)
  assert.match(src, /data-testid="agent-empty-state"/)
})

test('P0 ProjectFilesPane \u6709\u5bf9\u8bdd\u6587\u4ef6 + \u9879\u76ee\u6280\u80fd \u5165\u53e3', () => {
  const src = read('../src/components/ProjectFilesPane.jsx')
  assert.match(src, /\u9879\u76ee\u6280\u80fd/)
  assert.match(src, /\u672c\u6b21\u5bf9\u8bdd\u751f\u6210/)
  assert.match(src, /\u9879\u76ee\u56fa\u5b9a\u6587\u4ef6/)
  assert.match(src, /data-testid="project-files-pane"/)
  // \u641c\u7d22 + tab
  assert.match(src, /\u641c\u7d22\u6587\u4ef6/)
  assert.match(src, /\u5bf9\u8bdd\u6587\u4ef6/)
  assert.match(src, /\u5de5\u4f5c\u53f0/)
})

test('P0 ChatSplit \u63a5\u5165 SettingsDrawer + AgentEmptyState + ProjectFilesPane + p0-shell', () => {
  const src = read('../src/pages/ChatSplit/index.jsx')
  assert.match(src, /import SettingsDrawer/)
  assert.match(src, /import ProjectFilesPane/)
  assert.match(src, /import AgentEmptyState/)
  assert.match(src, /p0-shell/)
  assert.match(src, /onOpenSettings/)
})

test('P0 LeftRail \u4e0d\u518d\u6e32\u67d3\u987d\u90e8 nav \u6309\u94ae\u5217 + \u63d0\u4f9b\u9f7f\u8f6e\u5165\u53e3', () => {
  const src = read('../src/components/LeftRail.jsx')
  // navItems \u6570\u636e\u5df2\u5220
  assert.ok(!src.includes('const navItems = ['), 'navItems \u8fd8\u6ca1\u5220')
  // \u9f7f\u8f6e\u6309\u94ae
  assert.match(src, /aria-label="\u6253\u5f00\u8bbe\u7f6e"/)
  assert.match(src, /onOpenSettings/)
})

test('P0 tokens.css \u63d0\u4f9b\u6838\u5fc3\u8272\u677f + \u5b57\u4f53', () => {
  const src = read('../src/styles/tokens.css')
  assert.match(src, /--p0-bg:\s*#F5F5F5/)
  assert.match(src, /--p0-card:\s*#FFFFFF/)
  assert.match(src, /--p0-accent:\s*#D97757/)
  assert.match(src, /--p0-radius-card:\s*12px/)
  assert.match(src, /Noto Sans SC/)
  // \u7981 Inter \u7528 PingFang \u5907\u9009
  assert.ok(!/Inter/.test(src), 'tokens.css \u4e0d\u8be5\u6709 Inter')
})
