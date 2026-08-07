import { escapeHtml } from './chartSvg.js'
import { splitRichBullet } from './presentationParser.js'

const CONTENT_TEMPLATES = [
  { id: 'editorial', className: 'slide-template-editorial', badge: 'EDITORIAL', tag: 'DEEP DIVE', dark: false },
  { id: 'matrix', className: 'slide-template-matrix', badge: 'MATRIX', tag: 'DECISION MAP', dark: false },
  { id: 'dark-card', className: 'slide-template-dark-card', badge: 'INSIGHT', tag: 'EXECUTIVE LOGIC', dark: true },
]

function resolveContentTemplate(index) {
  const offset = Math.max(0, index - 1)
  return CONTENT_TEMPLATES[offset % CONTENT_TEMPLATES.length]
}

export function renderPremiumContentSlide(slide, index, num) {
  const template = resolveContentTemplate(index)
  const variant = template.dark ? 'slide-content-dark' : 'slide-content-light'
  const bullets = (slide.bullets?.length ? slide.bullets : ['\u56f4\u7ed5\u6838\u5fc3\u5224\u65ad\u5c55\u5f00\u4e0b\u4e00\u6b65\u884c\u52a8'])
    .slice(0, 4)
    .map((bullet, bulletIndex) => {
      const { main, note } = splitRichBullet(bullet)
      const noteHtml = note ? `<div class="content-card-note">${escapeHtml(note)}</div>` : ''
      return `
    <article class="content-card">
      <div class="content-card-index">${String(bulletIndex + 1).padStart(2, '0')}</div>
      <div class="content-card-text">${escapeHtml(main)}</div>
      ${noteHtml}
    </article>`
    })
    .join('')

  return `<div class="slide slide-content ${variant} ${template.className}">
  <div class="accent-bar-v"></div>
  <div class="grid-bg-light"></div>
  <div class="content-orb content-orb-a"></div>
  <div class="content-orb content-orb-b"></div>
  <div class="content-shard"></div>
  <div class="corner-badge">${template.badge}</div>
  <div class="content-tag" data-template="${template.id}">${template.tag} \u00b7 ${num}</div>
  <h2 class="content-title">${escapeHtml(slide.title)}</h2>
  <div class="content-title-line"></div>
  <div class="content-card-grid">${bullets}
  </div>
  <div class="content-footer-line"></div>
</div>`
}
