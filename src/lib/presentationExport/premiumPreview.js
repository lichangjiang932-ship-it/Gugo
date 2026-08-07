import { buildPremiumThemeOverride, resolvePresentationTheme } from '../presentationThemes.js'
import { parseMarkdownSlides } from './presentationParser.js'
import { buildPremiumSlideHtml } from './premiumSlideRenderer.js'
import { PREMIUM_CSS, PREMIUM_RESPONSIVE_CSS } from './premiumPreviewStyles.js'

export function buildPremiumHtmlPreview(markdown, { responsive = false } = {}) {
  const slides = parseMarkdownSlides(markdown)
  if (!slides.length) return ''

  const total = slides.length
  const theme = resolvePresentationTheme(slides
    .map((slide) => `${slide.title || ''} ${(slide.bullets || []).join(' ')}`)
    .join(' '))
  const slideHtml = slides.map((slide, i) => buildPremiumSlideHtml(slide, i, total)).join('')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>${PREMIUM_CSS}${buildPremiumThemeOverride(theme)}${responsive ? PREMIUM_RESPONSIVE_CSS : ''}</style>
</head>
<body data-presentation-theme="${theme.id}">${slideHtml}</body>
</html>`
}

/* \u2500\u2500 Screenshot \u2192 PPTX Pipeline \u2500\u2500 */

