import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

function source(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

function sourceTree(relativeDirectory, extension) {
  const pending = [fileURLToPath(new URL(relativeDirectory, import.meta.url))]
  const contents = []
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) pending.push(absolutePath)
      else if (entry.name.endsWith(extension)) contents.push(fs.readFileSync(absolutePath, 'utf8'))
    }
  }
  return contents.join('\n')
}

const stylesSource = source('../src/index.css')
const tailwindSource = source('../tailwind.config.js')
const composerSource = source('../src/pages/ChatSplit/ChatComposer.jsx')
const messageRowSource = source('../src/pages/ChatSplit/chatMessages/MessageRow.jsx')
const markdownSource = source('../src/components/MarkdownRenderer.jsx')
  + sourceTree('../src/components/markdown/', '.jsx')
  + sourceTree('../src/components/markdown/', '.js')
const artifactPreviewSource = source('../src/pages/ChatSplit/ArtifactPreview.jsx')
const settingsViewStylesSource = source('../src/pages/SettingsView.css')
const settingsWebSearchSource = source('../src/components/settings/SettingsWebSearchPanel.jsx')
const chatSplitJsxSource = sourceTree('../src/pages/ChatSplit/', '.jsx')
const appLayoutSource = source('../src/components/AppLayout.jsx')
const pageJsxSource = sourceTree('../src/pages/', '.jsx')

const semanticSurfaceSources = [
  '../src/pages/AgentList.jsx',
  '../src/pages/agents/AgentEditorModal.jsx',
  '../src/pages/agents/AgentTemplateModal.jsx',
  '../src/components/PersonaManifestEditor.jsx',
].map(source).join('\n')

const readableMetadataSources = [
  '../src/components/MarkdownRenderer.jsx',
  '../src/components/markdown/MarkdownControls.jsx',
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

function codeHexToken(block, token) {
  const value = block.match(new RegExp(`--chat-code-${token}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1]
  assert.ok(value, `missing --chat-code-${token}`)
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

test('page shells render the left rail only through AppLayout', () => {
  assert.match(appLayoutSource, /import LeftRail from ['"]\.\/LeftRail\.jsx['"]/)
  assert.match(appLayoutSource, /<LeftRail\s*\/>/)
  assert.doesNotMatch(pageJsxSource, /import LeftRail from|<LeftRail\b/)
})

test('UI radius system exposes exactly the card, control, and pill tiers', () => {
  assert.match(stylesSource, /--radius-card:\s*12px/)
  assert.match(stylesSource, /--radius-control:\s*8px/)
  assert.match(stylesSource, /--radius-pill:\s*999px/)
  assert.match(tailwindSource, /card:\s*'var\(--radius-card\)'/)
  assert.match(tailwindSource, /control:\s*'var\(--radius-control\)'/)
  assert.match(tailwindSource, /pill:\s*'var\(--radius-pill\)'/)
})

test('global typography has one five-tier scale and one shared CJK-capable mono stack', () => {
  const expectedScale = {
    page: '28px',
    section: '20px',
    body: '15px',
    ui: '13px',
    meta: '11px',
  }
  const declarations = [...stylesSource.matchAll(/--type-([\w-]+):\s*([^;]+);/g)]
  assert.deepEqual(Object.fromEntries(declarations.map(([, name, value]) => [name, value.trim()])), expectedScale)
  assert.doesNotMatch(stylesSource, /font-size:\s*0?\.[0-9]+rem/)

  for (const name of Object.keys(expectedScale)) {
    assert.match(tailwindSource, new RegExp(`${name}:\\s*'var\\(--type-${name}\\)'`))
  }

  const monoDeclaration = stylesSource.match(/--font-mono:\s*([^;]+);/)?.[1] || ''
  for (const family of ['JetBrains Mono', 'Noto Sans Mono CJK SC', 'ui-monospace', 'SFMono-Regular', 'Consolas', 'Liberation Mono', 'monospace']) {
    assert.match(monoDeclaration, new RegExp(family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.equal((stylesSource.match(/--font-mono:/g) || []).length, 1)
  assert.ok((stylesSource.match(/font-family:\s*var\(--font-mono\);/g) || []).length > 0)
  assert.doesNotMatch(stylesSource, /font-family:\s*"SFMono-Regular"/)
  assert.match(tailwindSource, /mono:\s*\['var\(--font-mono\)'\]/)
})

test('unconsumed density spacing selectors and variables stay removed', () => {
  assert.doesNotMatch(stylesSource, /data-density|--density-(?:padding|gap)|var\(--density-/)
})

test('agent and settings surfaces use live theme tokens instead of dead aliases or raw hex', () => {
  assert.doesNotMatch(semanticSurfaceSources, /\b(?:bg|text|border)-canvas\b/)
  assert.match(semanticSurfaceSources, /\bbg-paper\b/)
  assert.match(semanticSurfaceSources, /\bbg-ink\b[^"]*\btext-paper\b/)
  assert.doesNotMatch(settingsViewStylesSource, /#[0-9a-f]{3,8}\b/i)
  assert.match(settingsViewStylesSource, /\.settings-toggle\[data-checked="true"\][\s\S]*?background:\s*var\(--color-accent\)/)
  assert.match(settingsViewStylesSource, /\.settings-action-button-primary\s*\{[\s\S]*?background:\s*var\(--color-accent\)[\s\S]*?color:\s*rgb\(var\(--color-accent-contrast-rgb\)\)/)
})

test('web search settings use theme-owned neutral and semantic colors', () => {
  assert.doesNotMatch(settingsWebSearchSource, /#[0-9a-f]{3,8}\b/i)
  assert.doesNotMatch(settingsWebSearchSource, /\b(?:bg|text)-white\b/)
  for (const token of ['paper', 'paper-2', 'ink', 'ink-soft', 'ink-fade', 'focus', 'success', 'danger']) {
    assert.match(settingsWebSearchSource, new RegExp(`(?:bg|text|border|ring|placeholder:text)-${token}(?:\\b|/)`))
  }
})

test('ChatSplit JSX uses semantic theme and status tokens instead of Tailwind palette colors', () => {
  assert.doesNotMatch(
    chatSplitJsxSource,
    /\b(?:bg|text|border|ring|outline|divide|from|via|to|shadow|fill|stroke|caret|decoration|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-/,
  )
  assert.match(chatSplitJsxSource, /border-l-(?:warning|danger)/)
  assert.match(chatSplitJsxSource, /\b(?:text|bg)-(?:danger|warning|running|success)\b/)
})

test('composer keeps restrained elevation while tool rows stay grounded', () => {
  assert.match(composerSource, /min-h-\[108px\][\s\S]{0,120}rounded-\[22px\]/)
  assert.match(composerSource, /chat-composer-surface/)
  assert.doesNotMatch(composerSource, /focus-within:-translate-y-px|focus-within:border-blue/)
  assert.match(cssRule('.chat-composer-surface'), /box-shadow:[\s\S]*?0 12px 32px/)
  assert.match(cssRule('.chat-composer-surface:focus-within'), /box-shadow:[\s\S]*?0 14px 38px/)
  assert.match(cssRule('.chat-composer-project-strip'), /width:\s*fit-content/)
  assert.match(cssRule('.chat-composer-project-strip'), /margin-bottom:\s*0\.5rem/)

  const toolCard = cssRule('.chat-tool-step')
  const toolCardHover = cssRule('.chat-tool-step:hover')
  assert.match(toolCard, /border-radius:\s*var\(--radius-card\)/)
  assert.match(toolCard, /box-shadow:/)
  assert.match(toolCardHover, /background:/)
  assert.doesNotMatch(toolCardHover, /box-shadow|transform/)
  const toolDetails = cssRule('.chat-tool-details-card')
  assert.match(toolDetails, /border-left:/)
  assert.doesNotMatch(toolDetails, /border-radius|box-shadow|background:/)
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
  assert.match(markdownSource, /<code className="[^"]*border-ink\/10[^"]*bg-paper-2[^"]*text-ink-soft/)
  assert.match(markdownSource, /<blockquote className="[^"]*border-ink\/15[^"]*bg-paper-2\/60[^"]*text-ink-soft/)
  assert.doesNotMatch(markdownSource, /\b(?:bg|text|border)-(?:neutral|blue|rose|emerald)-/)
  assert.doesNotMatch(markdownSource, /(?:<code|<blockquote)[^>]*\b(?:text|bg|border)-ember/)
  assert.match(cssRule('.chat-tool-label'), /color:\s*rgb\(var\(--color-ink-soft-rgb\)\)/)
  assert.doesNotMatch(cssRule('.chat-tool-label'), /ember/)
  assert.match(artifactPreviewSource, /tracking-\[0\.18em\] text-ink-fade/)
  assert.doesNotMatch(artifactPreviewSource, /tracking-\[0\.18em\] text-ember/)
})

test('streaming markdown caret blinks unless animation is disabled or reduced', () => {
  const caret = cssRule('.chat-markdown-streaming > :last-child::after')
  assert.match(caret, /content:\s*"▍"/)
  assert.match(caret, /animation:\s*chat-caret-blink 1s steps\(1, end\) infinite/)
  assert.match(stylesSource, /@keyframes chat-caret-blink\s*\{[\s\S]*?opacity:\s*0;/)
  assert.match(stylesSource, /html\[data-animations="false"\] \.chat-markdown-streaming > :last-child::after\s*\{[\s\S]*?animation:\s*none !important;[\s\S]*?opacity:\s*1;/)
  assert.match(stylesSource, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.chat-markdown-streaming > :last-child::after\s*\{[\s\S]*?animation:\s*none !important;[\s\S]*?opacity:\s*1;/)
})

test('message rows do not run an unconditional entrance animation', () => {
  assert.doesNotMatch(messageRowSource, /from ['"]framer-motion['"]/)
  assert.doesNotMatch(messageRowSource, /<\/?motion\./)
  assert.doesNotMatch(messageRowSource, /initial=\{\{|animate=\{\{|transition=\{\{/)
})

test('running timeline pulse stops for both animation preferences', () => {
  assert.match(
    cssRule('.chat-run-timeline .chat-tool-step[data-status="running"]::before'),
    /animation:\s*chat-timeline-pulse 1\.45s ease-in-out infinite/,
  )
  assert.match(
    stylesSource,
    /html\[data-animations="false"\] \.chat-run-timeline \.chat-tool-step\[data-status="running"\]::before[\s\S]*?\{[\s\S]*?animation:\s*none !important;/,
  )
  assert.match(
    stylesSource,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.chat-run-timeline \.chat-tool-step\[data-status="running"\]::before[\s\S]*?\{[\s\S]*?animation:\s*none !important;/,
  )
})

test('markdown code blocks use semantic surfaces and a complete theme-owned syntax palette', () => {
  assert.doesNotMatch(stylesSource, /@import\s+['"]highlight\.js\/styles\/github(?:-dark)?\.css['"]/)

  const codeBlockMarkup = markdownSource.match(/<div className="chat-code-block[^"]+"/)?.[0] || ''
  assert.match(codeBlockMarkup, /border-ink\/10/)
  assert.match(codeBlockMarkup, /bg-paper-2\/70/)
  assert.doesNotMatch(codeBlockMarkup, /(?:border|bg|text)-neutral-/)
  assert.match(markdownSource, /chat-code-block-header[^"]*bg-paper\/45/)
  assert.match(markdownSource, /chat-code-scroll/)

  const themes = [
    ['light', stylesSource.match(/:root,\s*html\[data-theme="light"\]\s*\{([^}]*)\}/)?.[1] || ''],
    ['dark', stylesSource.match(/html\[data-theme="dark"\]\s*\{([^}]*)\}/)?.[1] || ''],
    ['white', stylesSource.match(/html\[data-theme="white"\]\s*\{([^}]*)\}/)?.[1] || ''],
  ]
  const syntaxTokens = [
    'foreground', 'keyword', 'entity', 'constant', 'string', 'variable', 'comment',
    'tag', 'heading', 'bullet', 'addition', 'addition-bg', 'deletion', 'deletion-bg',
  ]
  const syntaxTextTokens = [
    'foreground', 'keyword', 'entity', 'constant', 'string', 'variable', 'comment',
    'tag', 'heading', 'bullet',
  ]

  for (const [themeName, block] of themes) {
    assert.ok(block, `missing ${themeName} theme block`)
    for (const token of syntaxTokens) {
      assert.match(block, new RegExp(`--chat-code-${token}:\\s*#[0-9a-f]{6};`, 'i'), `${themeName} is missing ${token}`)
    }
    const codeSurface = hexToken(block, 'paper-2')
    for (const token of syntaxTextTokens) {
      const ratio = contrastRatio(codeHexToken(block, token), codeSurface)
      assert.ok(ratio >= 4.5, `${themeName} code ${token}/paper-2 contrast ${ratio.toFixed(2)} is below 4.5`)
    }
    for (const kind of ['addition', 'deletion']) {
      const ratio = contrastRatio(codeHexToken(block, kind), codeHexToken(block, `${kind}-bg`))
      assert.ok(ratio >= 4.5, `${themeName} code ${kind} contrast ${ratio.toFixed(2)} is below 4.5`)
    }
  }

  for (const token of syntaxTokens) {
    assert.match(stylesSource, new RegExp(`var\\(--chat-code-${token}\\)`), `syntax rules do not consume ${token}`)
  }
  assert.doesNotMatch(stylesSource, /html\[data-theme="dark"\]\s+\.chat-code-block[^{}]*\{[^}]*#[0-9a-f]{3,8}/i)
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
