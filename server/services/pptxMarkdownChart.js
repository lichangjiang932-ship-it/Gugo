import { invalidPptx, normalizePptxChart } from './pptxArtifactValidation.js'
import { PPTX_CHART_TYPES } from './pptxArtifactContract.js'
import { markdownSlideText } from './pptxMarkdownSource.js'

const CHART_ALIASES = Object.freeze({
  column: 'bar', stacked: 'bar-stacked', stack: 'bar-stacked',
  stackedbar: 'bar-stacked', stacked_bar: 'bar-stacked',
})

function chartValueTokens(value, path) {
  let values = value.trim()
  if (values.startsWith('[') && values.endsWith(']')) values = values.slice(1, -1).trim()
  const tokens = /[,，、]/u.test(values) ? values.split(/[,，、]/u) : values.split(/\s+/u)
  if (!tokens.length || tokens.some((token) => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(token.trim()))) {
    invalidPptx(path, 'must contain only supplied numeric values; missing or invalid points cannot be dropped or replaced')
  }
  const numbers = tokens.map((token) => Number(token.trim()))
  if (numbers.some((number) => !Number.isFinite(number))) invalidPptx(path, 'must contain finite numbers')
  return numbers
}

function chartSourceLines(lines, path) {
  const fenced = lines.some((line) => /^```\s*chart\s*$/iu.test(line))
  if (!fenced) return { data: lines, remainder: [], fenced: false }
  const data = []
  const remainder = []
  let inside = false
  let opened = false
  for (const line of lines) {
    if (/^```\s*chart\s*$/iu.test(line)) {
      if (opened) invalidPptx(path, 'contains multiple chart blocks; use explicit canvas elements for multiple charts')
      opened = true
      inside = true
    } else if (inside && /^```\s*$/u.test(line)) inside = false
    else (inside ? data : remainder).push(line)
  }
  if (inside) invalidPptx(path, 'has an unclosed chart fence')
  return { data, remainder, fenced: true }
}

/** Parse evidence strictly: the browser preview parser filters bad tokens and is not a data contract. */
export function canonicalMarkdownChart(lines, path) {
  const source = chartSourceLines(lines, path)
  const chart = { type: 'bar', series: [] }
  const remainder = source.remainder.map(markdownSlideText)
  const declarations = new Set()
  let seriesSection = false
  for (const line of source.data) {
    const type = line.match(/^type\s*[:=]\s*(.+)$/iu)
    const categories = line.match(/^(?:categories|labels|x|横轴)\s*[:=]\s*(.*)$/iu)
    if (type || categories) {
      const key = type ? 'type' : 'categories'
      if (declarations.has(key)) invalidPptx(`${path}.${key}`, 'must be declared only once')
      declarations.add(key)
      if (type) {
        const name = type[1].trim().toLowerCase()
        chart.type = CHART_ALIASES[name] || name
        if (!PPTX_CHART_TYPES.includes(chart.type)) invalidPptx(`${path}.type`, `does not support "${name}"; no substitute chart is chosen`)
      } else chart.categories = categories[1].split(/[,，、]/u).map((value) => value.trim())
      continue
    }
    if (/^series\s*[:=]?\s*$/iu.test(line)) { seriesSection = true; continue }
    const row = line.replace(/^[-*]\s+/u, '').match(/^(?:["']?(.+?)["']?\s*[:：]\s*)?(.+)$/u)
    const rawValues = row?.[2] || ''
    const appearsNumeric = /[,，、]/u.test(rawValues) || /^[+\-\d.]/u.test(rawValues.trim()) || rawValues.trim().startsWith('[')
    if (!source.fenced && !seriesSection && !row?.[1] && !appearsNumeric) {
      remainder.push(markdownSlideText(line))
      continue
    }
    chart.series.push({
      ...(row?.[1] ? { name: markdownSlideText(row[1]) } : {}),
      values: chartValueTokens(rawValues, `${path}.series[${chart.series.length}].values`),
    })
  }
  normalizePptxChart(chart, path)
  return { chart, remainder: remainder.filter(Boolean) }
}
