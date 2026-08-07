export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/* SVG chart renderer \u2014 \u5171\u4eab\u7ed9 normal HTML \u9884\u89c8\u548c Premium HTML \u622a\u56fe\u5bfc\u51fa.
   Premium \u8d70\u6df1\u8272 bg \u4e0e\u9ad8\u5bf9\u6bd4\u8272,\u666e\u901a\u9884\u89c8\u8d70 paper bg \u4e0e\u67d4\u548c\u5750\u6807\u8f74. */
export function niceCeil(v) {
  if (v <= 0) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(v)))
  const norm = v / mag
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return nice * mag
}
export function formatChartNumber(v) {
  const abs = Math.abs(v)
  if (abs >= 10000) return (v / 1000).toFixed(0) + 'k'
  if (abs >= 1000) return (v / 1000).toFixed(1) + 'k'
  if (Number.isInteger(v)) return String(v)
  return v.toFixed(1)
}
export function buildChartSvg(chart, opts) {
  const { palette, axisColor, gridColor, labelColor, valueColor, bg } = opts
  const W = 1080, H = 540
  const PAD = { top: 36, right: 40, bottom: 60, left: 70 }
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const series = (chart?.series || []).filter((s) => s && Array.isArray(s.values) && s.values.length)
  const categories = chart?.categories || []
  if (!series.length) return ''

  const bgRect = bg ? `<rect width="${W}" height="${H}" fill="${bg}"/>` : ''

  if (chart.type === 'pie') {
    const s0 = series[0]
    const total = s0.values.reduce((a, b) => a + Math.max(0, Number(b) || 0), 0)
    if (!total) return ''
    const cx = W / 2 - 120, cy = H / 2 + 10
    const R = Math.min(innerW, innerH) / 2 - 20
    let angle = -Math.PI / 2
    const slices = []
    const legendItems = []
    s0.values.forEach((v, i) => {
      const a = Math.max(0, Number(v) || 0)
      if (a <= 0) return
      const frac = a / total
      const da = frac * Math.PI * 2
      const x1 = cx + R * Math.cos(angle), y1 = cy + R * Math.sin(angle)
      const x2 = cx + R * Math.cos(angle + da), y2 = cy + R * Math.sin(angle + da)
      const large = da > Math.PI ? 1 : 0
      const color = palette[i % palette.length]
      slices.push(`<path d="M ${cx} ${cy} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${R} ${R} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="${color}" opacity="0.92"/>`)
      const labelAngle = angle + da / 2
      const labelR = R * 0.62
      const lx = cx + labelR * Math.cos(labelAngle), ly = cy + labelR * Math.sin(labelAngle)
      slices.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" fill="#fff" font-size="14" font-weight="700" text-anchor="middle" dominant-baseline="middle">${(frac * 100).toFixed(1)}%</text>`)
      legendItems.push({ cat: categories[i] || `\u9879${i + 1}`, color })
      angle += da
    })
    const legendX = cx + R + 60
    const legend = legendItems.map((it, i) => {
      const y = cy - (legendItems.length * 28) / 2 + i * 28
      return `<rect x="${legendX}" y="${y - 10}" width="14" height="14" rx="2" fill="${it.color}"/>` +
        `<text x="${legendX + 22}" y="${y}" fill="${labelColor}" font-size="14" dominant-baseline="middle">${escapeHtml(it.cat)}</text>`
    }).join('')
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block">
${bgRect}${slices.join('')}${legend}</svg>`
  }

  const allValues = series.flatMap((s) => s.values.map((v) => Number(v) || 0))
  const maxV = Math.max(...allValues, 0)
  const minV = Math.min(...allValues, 0)
  const niceMax = niceCeil(maxV || 1)
  const niceMin = minV < 0 ? -niceCeil(-minV) : 0
  const span = niceMax - niceMin || 1
  const yToPx = (v) => PAD.top + innerH - ((v - niceMin) / span) * innerH
  const catCount = Math.max(...series.map((s) => s.values.length), 1)
  const xStep = innerW / catCount

  let grid = ''
  const ticks = 4
  for (let t = 0; t <= ticks; t++) {
    const v = niceMin + (span * t / ticks)
    const y = yToPx(v).toFixed(1)
    grid += `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + innerW}" y2="${y}" stroke="${gridColor}" stroke-width="0.5"/>` +
      `<text x="${PAD.left - 8}" y="${y}" fill="${labelColor}" font-size="11" text-anchor="end" dominant-baseline="middle">${formatChartNumber(v)}</text>`
  }

  let xLabels = ''
  for (let i = 0; i < catCount; i++) {
    const x = PAD.left + xStep * (i + 0.5)
    const cat = categories[i] || ''
    xLabels += `<text x="${x.toFixed(1)}" y="${(PAD.top + innerH + 22).toFixed(1)}" fill="${labelColor}" font-size="12" text-anchor="middle">${escapeHtml(cat)}</text>`
  }

  let body
  if (chart.type === 'line' || chart.type === 'area') {
    body = series.map((s, sIdx) => {
      const color = palette[sIdx % palette.length]
      const points = s.values.map((v, i) => [PAD.left + xStep * (i + 0.5), yToPx(Number(v) || 0)])
      const path = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
      const dots = points.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" fill="${color}" stroke="${bg || '#fff'}" stroke-width="2"/>`).join('')
      // PR4a: area = line + \u4e0b\u65b9\u586b\u534a\u900f\u660e\u8272\u5757
      let area = ''
      if (chart.type === 'area' && points.length) {
        const y0 = yToPx(0).toFixed(1)
        const first = points[0]
        const last = points[points.length - 1]
        const areaPath = `M ${first[0].toFixed(1)} ${y0} ${path} L ${last[0].toFixed(1)} ${y0} Z`
        area = `<path d="${areaPath}" fill="${color}" opacity="0.18" stroke="none"/>`
      }
      return `${area}<path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>${dots}`
    }).join('')
  } else if (chart.type === 'scatter') {
    // PR4a: \u6563\u70b9 \u2014 \u4ec5\u5706\u70b9,\u65e0\u8fde\u7ebf
    body = series.map((s, sIdx) => {
      const color = palette[sIdx % palette.length]
      return s.values.map((v, i) => {
        const x = PAD.left + xStep * (i + 0.5)
        const y = yToPx(Number(v) || 0)
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5.5" fill="${color}" opacity="0.85" stroke="${bg || '#fff'}" stroke-width="1.5"/>`
      }).join('')
    }).join('')
  } else if (chart.type === 'stacked') {
    // PR4a: \u5806\u53e0\u67f1 \u2014 \u540c category \u4e0b,\u5404 series \u6b63\u503c\u4f9d\u6b21\u53e0\u52a0
    const groupGap = 0.28
    const barW = Math.max(8, xStep * (1 - groupGap))
    const stacks = []
    const catCount = categories.length || Math.max(...series.map((s) => s.values.length))
    for (let i = 0; i < catCount; i++) {
      let cumPos = 0
      let cumNeg = 0
      series.forEach((s, sIdx) => {
        const color = palette[sIdx % palette.length]
        const val = Number(s.values[i]) || 0
        if (val === 0) return
        const x = PAD.left + xStep * i + (xStep * groupGap) / 2
        if (val >= 0) {
          const yTop = yToPx(cumPos + val)
          const yBot = yToPx(cumPos)
          stacks.push(`<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(2, yBot - yTop).toFixed(1)}" fill="${color}" rx="2"/>`)
          cumPos += val
        } else {
          const yTop = yToPx(cumNeg)
          const yBot = yToPx(cumNeg + val)
          stacks.push(`<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(2, yBot - yTop).toFixed(1)}" fill="${color}" rx="2"/>`)
          cumNeg += val
        }
      })
      if (cumPos > 0) {
        const yTop = yToPx(cumPos)
        const cx = PAD.left + xStep * i + (xStep * groupGap) / 2 + barW / 2
        stacks.push(`<text x="${cx.toFixed(1)}" y="${(yTop - 6).toFixed(1)}" fill="${valueColor}" font-size="11" font-weight="600" text-anchor="middle">${formatChartNumber(cumPos)}</text>`)
      }
    }
    body = stacks.join('')
  } else {
    const groupGap = 0.28
    const barGroupW = xStep * (1 - groupGap)
    const barW = Math.max(8, barGroupW / series.length)
    body = series.map((s, sIdx) => {
      const color = palette[sIdx % palette.length]
      return s.values.map((v, i) => {
        const val = Number(v) || 0
        const x = PAD.left + xStep * i + (xStep * groupGap) / 2 + barW * sIdx
        const y0 = yToPx(0)
        const y = yToPx(val)
        const top = Math.min(y, y0)
        const h = Math.max(2, Math.abs(y - y0))
        return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" rx="2"/>` +
          `<text x="${(x + barW / 2).toFixed(1)}" y="${(top - 6).toFixed(1)}" fill="${valueColor}" font-size="11" font-weight="600" text-anchor="middle">${formatChartNumber(val)}</text>`
      }).join('')
    }).join('')
  }

  let legend = ''
  if (series.length > 1) {
    const lY = 22
    legend = series.map((s, i) => {
      const color = palette[i % palette.length]
      const lx = PAD.left + i * 160
      return `<rect x="${lx}" y="${lY - 10}" width="12" height="12" rx="2" fill="${color}"/>` +
        `<text x="${lx + 18}" y="${lY}" fill="${labelColor}" font-size="12" dominant-baseline="middle">${escapeHtml(s.name)}</text>`
    }).join('')
  }

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block">
${bgRect}${grid}<line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + innerH}" stroke="${axisColor}" stroke-width="1"/><line x1="${PAD.left}" y1="${(PAD.top + innerH).toFixed(1)}" x2="${PAD.left + innerW}" y2="${(PAD.top + innerH).toFixed(1)}" stroke="${axisColor}" stroke-width="1"/>${body}${xLabels}${legend}</svg>`
}

