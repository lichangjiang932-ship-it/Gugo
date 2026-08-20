import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

function source(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

const stylesSource = source('../src/index.css')
const tailwindSource = source('../tailwind.config.js')
const composerSource = source('../src/pages/ChatSplit/ChatComposer.jsx')
const markdownSource = source('../src/components/MarkdownRenderer.jsx')
const artifactPreviewSource = source('../src/pages/ChatSplit/ArtifactPreview.jsx')

const readableMetadataSources = [
  '../src/components/MarkdownRenderer.jsx',
  '../src/components/LeftRail.jsx',
  '../src/components/leftRail/AccountArea.jsx',
  '../src/components/leftRail/SessionList.jsx',
  '../src/pages/ChatSplit/ArtifactPreview.jsx',
  '../src/pages/ChatSplit/ChatComposer.jsx',
  '../src/pages/ChatSplit/ChatMessages.jsx',
  '../src/pages/ChatSplit/ModelPicker.jsx',
  '../src/pages/ChatSplit/RightWorkbench.jsx',
  '../src/pages/ChatSplit/SlashInlinePanelHost.jsx',
  '../src/pages/ChatSplit/chatComposer/ComposerAttachments.jsx',
  '../src/pages/ChatSplit/chatMessages/ArtifactCards.jsx',
  '../src/pages/ChatSplit/chatMessages/ChatMiniTimeline.jsx',
  '../src/pages/ChatSplit/chatMessages/MessageRow.jsx',
  '../src/pages/ChatSplit/chatMessages/PermissionRequestCard.jsx',
]

function cssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return stylesSource.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] || ''
}

function hexToken(block, token) {
  const value = block.match(new RegExp(`--color-${token}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1]
  assert.ok(value, `missing --color-${token}`)
  return value
}

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/.{2}/g).map((value) => Number.parseInt(value, 16) / 255)
  const linear = channels.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

test('UI radius system exposes exactly the card, control, and pill tiers', () => {
  assert.match(stylesSource, /--radius-card:\s*12px/)
  assert.match(stylesSource, /--radius-control:\s*8px/)
  assert.match(stylesSource, /--radius-pill:\s*999px/)
  assert.match(tailwindSource, /card:\s*'var\(--radius-card\)'/)
  assert.match(tailwindSource, /control:\s*'var\(--radius-control\)'/)
  assert.match(tailwindSource, /pill:\s*'var\(--radius-pill\)'/)
})

test('composer and tool cards provide restrained elevation feedback', () => {
  assert.match(composerSource, /rounded-card/)
  assert.match(composerSource, /shadow-sm/)
  assert.match(composerSource, /focus-within:-translate-y-px/)
  assert.match(composerSource, /focus-within:shadow-md/)

  const toolCard = cssRule('.chat-tool-step')
  const toolCardHover = cssRule('.chat-tool-step:hover')
  assert.match(toolCard, /border-radius:\s*var\(--radius-card\)/)
  assert.match(toolCard, /box-shadow:/)
  assert.match(toolCardHover, /box-shadow:/)
  assert.match(toolCardHover, /transform:\s*translateY\(-1px\)/)
  assert.match(cssRule('.chat-tool-details-card'), /border-radius:\s*var\(--radius-control\)/)
})

test('readable chat metadata is at least 12px apart from compact numeric badges', () => {
  const violations = []
  for (const relativePath of readableMetadataSources) {
    source(relativePath).split(/\r?\n/).forEach((line, index) => {
      if (!/text-\[(?:9|10|11)px\]|leading-none/.test(line)) return
      if (line.includes('data-compact-numeric-badge')) return
      violations.push(`${relativePath}:${index + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(violations, [])
})

test('long-form markdown, tool labels, and artifact identity stay neutral', () => {
  assert.match(markdownSource, /<code className="[^"]*border-neutral-200[^"]*bg-neutral-100[^"]*text-neutral-700/)
  assert.match(markdownSource, /<blockquote className="[^"]*border-neutral-300[^"]*bg-neutral-50[^"]*text-ink-soft/)
  assert.doesNotMatch(markdownSource, /(?:<code|<blockquote)[^>]*\b(?:text|bg|border)-ember/)
  assert.match(cssRule('.chat-tool-label'), /color:\s*rgb\(var\(--color-ink-soft-rgb\)\)/)
  assert.doesNotMatch(cssRule('.chat-tool-label'), /ember/)
  assert.match(artifactPreviewSource, /tracking-\[0\.18em\] text-ink-fade/)
  assert.doesNotMatch(artifactPreviewSource, /tracking-\[0\.18em\] text-ember/)
})

test('normal and semantic text tokens meet WCAG AA against each theme paper surface', () => {
  const themes = [
    ['light', stylesSource.match(/:root,\s*html\[data-theme="light"\]\s*\{([^}]*)\}/)?.[1] || ''],
    ['dark', stylesSource.match(/html\[data-theme="dark"\]\s*\{([^}]*)\}/)?.[1] || ''],
    ['white', stylesSource.match(/html\[data-theme="white"\]\s*\{([^}]*)\}/)?.[1] || ''],
  ]

  for (const token of ['accent', 'accent-contrast', 'accent-ink', 'danger', 'warning', 'running', 'success', 'focus']) {
    assert.match(tailwindSource, new RegExp(`['"]?${token}['"]?:\\s*'rgb\\(var\\(--color-${token}-rgb\\)`))
  }

  for (const [themeName, block] of themes) {
    assert.ok(block, `missing ${themeName} theme block`)
    const paper = hexToken(block, 'paper')
    for (const token of ['ink', 'ink-soft', 'ink-fade', 'ink-ghost', 'accent-ink', 'danger', 'warning', 'running', 'success']) {
      const ratio = contrastRatio(hexToken(block, token), paper)
      assert.ok(ratio >= 4.5, `${themeName} ${token}/paper contrast ${ratio.toFixed(2)} is below 4.5`)
    }
    const focusRatio = contrastRatio(hexToken(block, 'focus'), paper)
    assert.ok(focusRatio >= 3, `${themeName} focus/paper contrast ${focusRatio.toFixed(2)} is below 3`)
  }
})
