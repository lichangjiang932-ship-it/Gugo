import { buildChartSvg, escapeHtml } from './chartSvg.js'
import { renderPremiumContentSlide } from './premiumContentSlide.js'

export function buildPremiumSlideHtml(slide, index) {
  const num = String(index + 1).padStart(2, '0')
  const type = slide.type || 'content'

  switch (type) {
    case 'cover': {
      const subtitle = slide.bullets?.[0]
        ? `<p class="cover-subtitle">${escapeHtml(slide.bullets[0])}</p>`
        : ''
      return `<div class="slide slide-cover">
  <div class="glow-ember"></div>
  <div class="glow-cyan"></div>
  <div class="grid-bg cover-grid"></div>
  <div class="cover-wave"></div>
  <div class="cover-decor-ring"></div>
  <div class="cover-tag">PRESENTATION</div>
  <h1 class="cover-title">${escapeHtml(slide.title)}</h1>
  ${subtitle}
  <p class="cover-date">${new Date().toLocaleDateString('zh-CN')}</p>
  <div class="cover-line-bottom"></div>
</div>`
    }

    case 'toc': {
      const items = slide.bullets
        .map(
          (b, i) => `
  <div class="toc-item">
    <span class="toc-item-num">${String(i + 1).padStart(2, '0')}</span>
    <span class="toc-item-text">${escapeHtml(b)}</span>
  </div>`
        )
        .join('')
      return `<div class="slide slide-toc">
  <div class="toc-sidebar">
    <div class="dot-texture"></div>
    <div class="toc-sidebar-title">\u76ee\u5f55</div>
    <div class="toc-sidebar-sub">CONTENTS</div>
    <div class="toc-sidebar-line"></div>
    <div class="toc-sidebar-ring"></div>
  </div>
  <div class="toc-main">${items}
  </div>
</div>`
    }

    case 'section': {
      const desc = slide.bullets?.[0]
        ? `<p class="section-desc">${escapeHtml(slide.bullets[0])}</p>`
        : ''
      return `<div class="slide slide-section">
  <div class="grid-bg-light"></div>
  <div class="section-bg-num">${num}</div>
  <div class="section-decor-tri"></div>
  <div class="corner-badge">CHAPTER ${num}</div>
  <h1 class="section-title">${escapeHtml(slide.title)}</h1>
  ${desc}
  <div class="section-line"></div>
</div>`
    }

    case 'data': {
      const cards = (slide.dataPoints || [])
        .slice(0, 4)
        .map(
          (p) => `
  <div class="data-card">
    <div class="data-card-glow"></div>
    <div class="data-value">${escapeHtml(p.value)}</div>
    <div class="data-label">${escapeHtml(p.label)}</div>
    <div class="data-card-line"></div>
  </div>`
        )
        .join('')
      return `<div class="slide slide-data">
  <div class="grid-bg"></div>
  <div class="data-glow-1"></div>
  <div class="data-glow-2"></div>
  <div class="corner-badge">DATA</div>
  <div class="data-tag">DATA INSIGHTS</div>
  <h2 class="data-title">${escapeHtml(slide.title)}</h2>
  <div class="data-title-line"></div>
  <div class="data-grid">${cards}
  </div>
</div>`
    }

    case 'quote': {
      const q = slide.quote || { text: '', source: '' }
      const sourceHtml = q.source
        ? `<p class="quote-source">\u2014 ${escapeHtml(q.source)}</p>`
        : ''
      return `<div class="slide slide-quote">
  <div class="dot-texture"></div>
  <div class="quote-glow"></div>
  <div class="quote-mark-svg">"</div>
  <p class="quote-text">${escapeHtml(q.text)}</p>
  <div class="quote-line"></div>
  ${sourceHtml}
</div>`
    }

    case 'split': {
      const left = slide.leftColumn || { title: '', bullets: [] }
      const right = slide.rightColumn || { title: '', bullets: [] }
      const leftBullets = left.bullets
        .map(
          (b) => `
    <li><span class="bullet-square bullet-square-cyan"></span>${escapeHtml(b)}</li>`
        )
        .join('')
      const rightBullets = right.bullets
        .map(
          (b) => `
    <li><span class="bullet-square bullet-square-ember"></span>${escapeHtml(b)}</li>`
        )
        .join('')
      return `<div class="slide slide-split">
  <div class="grid-bg-light"></div>
  <div class="split-tag">COMPARISON</div>
  <h2 class="split-title">${escapeHtml(slide.title)}</h2>
  <div class="split-title-line"></div>
  <div class="split-body">
    <div class="split-col split-col-cyan">
      <div class="split-col-accent"></div>
      <div class="split-col-title split-col-title-cyan">${escapeHtml(left.title)}</div>
      <ul class="split-col-bullets">${leftBullets}
      </ul>
    </div>
    <div class="split-col split-col-ember">
      <div class="split-col-accent"></div>
      <div class="split-col-title split-col-title-ember">${escapeHtml(right.title)}</div>
      <ul class="split-col-bullets">${rightBullets}
      </ul>
    </div>
  </div>
</div>`
    }

    case 'table': {
      const table = slide.table || []
      let tableHtml = ''
      if (table.length >= 2) {
        const header = table[0]
        const body = table.slice(1)
        const th = header.map((c) => `<th>${escapeHtml(c)}</th>`).join('')
        const tr = body
          .map((row) => `<tr>${row.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`)
          .join('')
        tableHtml = `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`
      }
      return `<div class="slide slide-table">
  <div class="grid-bg-light"></div>
  <div class="corner-badge">TABLE</div>
  <div class="table-tag">DATA TABLE</div>
  <h2 class="table-title">${escapeHtml(slide.title)}</h2>
  <div class="table-title-line"></div>
  <div class="table-body">${tableHtml}</div>
</div>`
    }

    case 'process': {
      const steps = (slide.processSteps || [])
        .slice(0, 5)
        .map((step, i) => {
          const cls = i % 2 === 0 ? 'process-circle-ember' : 'process-circle-cyan'
          const desc = step.desc ? `<div class="process-desc">${escapeHtml(step.desc)}</div>` : ''
          return `
  <div class="process-step">
    <div class="process-circle ${cls}"><div class="process-circle-ring"></div>${i + 1}</div>
    <div class="process-name">${escapeHtml(step.name)}</div>
    ${desc}
  </div>`
        })
        .join('')
      return `<div class="slide slide-process">
  <div class="grid-bg-light"></div>
  <div class="corner-badge">PROCESS</div>
  <div class="process-tag">PROCESS</div>
  <h2 class="process-title">${escapeHtml(slide.title)}</h2>
  <div class="process-title-line"></div>
  <div class="process-body">
    <div class="process-track"></div>${steps}
  </div>
</div>`
    }

    case 'image': {
      const bullets = slide.bullets
        .slice(0, 5)
        .map(
          (b) => `
    <li><span class="bullet-diamond"></span>${escapeHtml(b)}</li>`
        )
        .join('')
      return `<div class="slide slide-image">
  <div class="grid-bg-light"></div>
  <div class="corner-badge">VISUAL</div>
  <div class="image-tag">VISUAL</div>
  <h2 class="image-title">${escapeHtml(slide.title)}</h2>
  <div class="image-title-line"></div>
  <div class="image-body">
    <div class="image-text">
      <ul>${bullets}
      </ul>
    </div>
    <div class="image-placeholder">[ ${escapeHtml(slide.images?.[0]?.alt || '\u914d\u56fe\u533a\u57df')} ]</div>
  </div>
</div>`
    }

    case 'end': {
      const subtitle = slide.bullets?.[0]
        ? `<p class="end-subtitle">${escapeHtml(slide.bullets[0])}</p>`
        : ''
      return `<div class="slide slide-end">
  <div class="glow-cyan"></div>
  <div class="glow-ember"></div>
  <div class="end-wave"></div>
  <div class="end-decor-ring"></div>
  <div class="end-tag">THANK YOU</div>
  <h1 class="end-title">${escapeHtml(slide.title)}</h1>
  ${subtitle}
  <div class="end-line-bottom"></div>
</div>`
    }

    case 'chart': {
      const svg = buildChartSvg(slide.chart, {
        palette: ['#E86A3C', '#2E8FA3', '#C97C5D', '#3E7A8C', '#8A7B68', '#4A6B82'],
        axisColor: '#8A7B68',
        gridColor: 'rgba(42,31,23,0.08)',
        labelColor: '#5E4F40',
        valueColor: '#2A1F17',
        bg: '',
      })
      return `<div class="slide slide-content" style="padding:60px 70px 70px;display:flex;flex-direction:column;box-sizing:border-box">
  <div class="accent-bar-v"></div>
  <div class="grid-bg-light"></div>
  <div class="corner-badge">DATA</div>
  <div class="content-tag">CHART \u00b7 ${num}</div>
  <h2 class="content-title">${escapeHtml(slide.title)}</h2>
  <div class="content-title-line"></div>
  <div style="flex:1;min-height:0;margin-top:18px">${svg || '<div style="color:#8A7B68;font-size:13px">\uff08\u56fe\u8868\u6570\u636e\u7f3a\u5931\uff09</div>'}</div>
  <div class="content-footer-line"></div>
</div>`
    }

    default: {
      return renderPremiumContentSlide(slide, index, num)
    }
  }
}
