import { buildChartSvg, escapeHtml } from './chartSvg.js'

export function buildSlideHtml(slide, index, total) {
  const num = String(index + 1).padStart(2, '0')
  const totalStr = String(total).padStart(2, '0')
  const type = slide.type || 'content'

  switch (type) {
    case 'cover': {
      const subtitle = slide.bullets?.[0] ? `<p class="cover-subtitle">${escapeHtml(slide.bullets[0])}</p>` : ''
      return `<div class="slide slide-cover">
  <div class="cover-top-bar"></div>
  <div class="cover-circle cover-circle-1"></div>
  <div class="cover-circle cover-circle-2"></div>
  <div class="cover-content">
    <div class="slide-number">SLIDE ${num} / ${totalStr}</div>
    <h1 class="cover-title">${escapeHtml(slide.title)}</h1>
    ${subtitle}
    <p class="cover-date">${new Date().toLocaleDateString('zh-CN')}</p>
  </div>
  <div class="cover-bottom-line"></div>
</div>`
    }
    case 'toc': {
      const items = slide.bullets.map((b, i) => `
  <div class="toc-item">
    <span class="toc-num">${String(i + 1).padStart(2, '0')}</span>
    <span class="toc-text">${escapeHtml(b)}</span>
  </div>`).join('')
      return `<div class="slide slide-toc">
  <div class="toc-sidebar">
    <div class="toc-title">\u76ee\u5f55</div>
    <div class="toc-subtitle">CONTENTS</div>
  </div>
  <div class="toc-main">
    <div class="slide-number">SLIDE ${num} / ${totalStr}</div>${items}
  </div>
</div>`
    }
    case 'image': {
      const bullets = slide.bullets.slice(0, 4).map(b => `
    <li>${escapeHtml(b)}</li>`).join('')
      return `<div class="slide slide-image">
  <div class="image-header">
    <div class="slide-number">SLIDE ${num} / ${totalStr}</div>
    <h2 class="image-title">${escapeHtml(slide.title)}</h2>
    <div class="image-line"></div>
  </div>
  <div class="image-body">
    <ul class="image-bullets">${bullets}
    </ul>
    <div class="image-placeholder">[ ${escapeHtml(slide.images?.[0]?.alt || '\u914d\u56fe')} ]</div>
  </div>
</div>`
    }
    case 'end': {
      const subtitle = slide.bullets?.[0] ? `<p class="end-subtitle">${escapeHtml(slide.bullets[0])}</p>` : ''
      return `<div class="slide slide-end">
  <div class="end-circle end-circle-1"></div>
  <div class="end-circle end-circle-2"></div>
  <div class="end-bottom-bar"></div>
  <div class="end-content">
    <div class="slide-number">SLIDE ${num} / ${totalStr}</div>
    <h1 class="end-title">${escapeHtml(slide.title)}</h1>
    ${subtitle}
  </div>
</div>`
    }
    case 'data': {
      const cards = (slide.dataPoints || []).slice(0, 4).map((p) => `
  <div class="data-card">
    <div class="data-value">${escapeHtml(p.value)}</div>
    <div class="data-label">${escapeHtml(p.label)}</div>
    <div class="data-card-line"></div>
  </div>`).join('')
      return `<div class="slide slide-data">
  <div class="data-header">
    <div class="slide-number">SLIDE ${num} / ${totalStr}</div>
    <h2 class="data-title">${escapeHtml(slide.title)}</h2>
    <div class="data-line"></div>
  </div>
  <div class="data-grid">${cards}
  </div>
</div>`
    }
    case 'quote': {
      const q = slide.quote || { text: '', source: '' }
      const sourceHtml = q.source ? `<div class="quote-source">\u2014 ${escapeHtml(q.source)}</div>` : ''
      return `<div class="slide slide-quote">
  <div class="slide-number">SLIDE ${num} / ${totalStr}</div>
  <div class="quote-mark">"</div>
  <div class="quote-text">${escapeHtml(q.text)}</div>
  ${sourceHtml}
  <div class="quote-bottom-line"></div>
</div>`
    }
    case 'split': {
      const left = slide.leftColumn || { title: '', bullets: [] }
      const right = slide.rightColumn || { title: '', bullets: [] }
      const leftBullets = left.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('')
      const rightBullets = right.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('')
      return `<div class="slide slide-split">
  <div class="split-header">
    <div class="slide-number">SLIDE ${num} / ${totalStr}</div>
    <h2 class="split-title">${escapeHtml(slide.title)}</h2>
    <div class="split-line"></div>
  </div>
  <div class="split-body">
    <div class="split-col">
      <div class="split-col-title split-col-cyan">${escapeHtml(left.title)}</div>
      <ul class="split-col-bullets">${leftBullets}</ul>
    </div>
    <div class="split-col">
      <div class="split-col-title split-col-ember">${escapeHtml(right.title)}</div>
      <ul class="split-col-bullets">${rightBullets}</ul>
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
        const th = header.map(c => `<th>${escapeHtml(c)}</th>`).join('')
        const tr = body.map(row => `<tr>${row.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')
        tableHtml = `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`
      }
      return `<div class="slide slide-table">
  <div class="table-header">
    <div class="slide-number">SLIDE ${num} / ${totalStr}</div>
    <h2 class="table-title">${escapeHtml(slide.title)}</h2>
    <div class="table-line"></div>
  </div>
  <div class="table-body">${tableHtml}</div>
</div>`
    }
    case 'process': {
      const steps = (slide.processSteps || []).slice(0, 5).map((step, i) => {
        const cls = i % 2 === 0 ? 'process-circle-ember' : 'process-circle-cyan'
        const arrow = i < (slide.processSteps || []).length - 1 && i < 4 ? '<div class="process-arrow">\u2192</div>' : ''
        const desc = step.desc ? `<div class="process-desc">${escapeHtml(step.desc)}</div>` : ''
        return `
  <div class="process-step">
    <div class="process-circle ${cls}">${i + 1}</div>
    <div class="process-name">${escapeHtml(step.name)}</div>
    ${desc}
  </div>${arrow}`
      }).join('')
      return `<div class="slide slide-process">
  <div class="process-header">
    <div class="slide-number">SLIDE ${num} / ${totalStr}</div>
    <h2 class="process-title">${escapeHtml(slide.title)}</h2>
    <div class="process-line"></div>
  </div>
  <div class="process-body">${steps}
  </div>
</div>`
    }
    case 'section': {
      const desc = slide.bullets?.[0] ? `<div class="section-desc">${escapeHtml(slide.bullets[0])}</div>` : ''
      return `<div class="slide slide-section">
  <div class="slide-number">SLIDE ${num} / ${totalStr}</div>
  <div class="section-number">${num}</div>
  <h1 class="section-title">${escapeHtml(slide.title)}</h1>
  ${desc}
  <div class="section-line"></div>
</div>`
    }
    case 'chart': {
      const svg = buildChartSvg(slide.chart, {
        palette: ['#E86A3C', '#2E8FA3', '#8A7B68', '#4A6B82', '#C97C5D', '#3E7A8C'],
        axisColor: '#8A7B68',
        gridColor: 'rgba(42,31,23,0.10)',
        labelColor: '#5E4F40',
        valueColor: '#2A1F17',
        bg: '',
      })
      return `<div class="slide slide-chart" style="background:#F4EFE5;padding:48px 56px;display:flex;flex-direction:column;box-sizing:border-box">
  <div class="slide-number">SLIDE ${num} / ${totalStr}</div>
  <h2 style="font-family:'Calibri','Source Han Sans SC',sans-serif;font-size:28px;font-weight:700;color:#2A1F17;margin:0 0 6px 0">${escapeHtml(slide.title)}</h2>
  <div style="width:48px;height:3px;background:#E86A3C;margin-bottom:14px;border-radius:2px"></div>
  <div style="flex:1;min-height:0">${svg || '<div style="color:#8A7B68;font-size:13px">\uff08\u56fe\u8868\u6570\u636e\u7f3a\u5931\uff09</div>'}</div>
</div>`
    }
    default: {
      const bullets = slide.bullets.map(b => `
    <li>${escapeHtml(b)}</li>`).join('')
      return `<div class="slide slide-content">
  <div class="content-bar"></div>
  <div class="content-body">
    <div class="slide-number">SLIDE ${num} / ${totalStr}</div>
    <h2 class="content-title">${escapeHtml(slide.title)}</h2>
    <div class="content-line"></div>
    <ul class="content-bullets">${bullets}
    </ul>
  </div>
  <div class="content-bottom-line"></div>
</div>`
    }
  }
}

