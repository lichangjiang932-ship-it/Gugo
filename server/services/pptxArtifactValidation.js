import { PPTX_CHART_SCHEMA, PPTX_LIMITS, PPTX_TABLE_SCHEMA } from './pptxArtifactContract.js'

export function invalidPptx(path, message, code = 'PPTX_CONTENT_INVALID') {
  throw Object.assign(new TypeError(`${path} ${message}`), { code, retryable: true })
}

function propertyValue(value, key, path) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor) return undefined
  if (!Object.hasOwn(descriptor, 'value')) invalidPptx(path, 'must be plain data, without accessors')
  return descriptor.value
}

function matchesType(value, type) {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
  if (type === 'integer') return Number.isSafeInteger(value)
  return typeof value === type
}

export function pptxText(value, path, maximum = PPTX_LIMITS.text) {
  if (typeof value !== 'string' || value.length > maximum) {
    invalidPptx(path, `must be a string of at most ${maximum} characters`)
  }
  for (const character of value) {
    const code = character.codePointAt(0)
    if ((code < 0x20 && ![9, 10, 13].includes(code))
      || (code >= 0xD800 && code <= 0xDFFF) || code === 0xFFFE || code === 0xFFFF) {
      invalidPptx(path, 'contains a character that cannot be stored in Office XML')
    }
  }
  return value
}

function validateObject(value, schema, path) {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalidPptx(path, 'must be a plain object')
  for (const required of schema.required || []) {
    if (!Object.hasOwn(value, required)) invalidPptx(`${path}.${required}`, 'is required')
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') invalidPptx(path, 'must use string keys')
    const property = schema.properties?.[key]
    if (!property && schema.additionalProperties === false) invalidPptx(`${path}.${key}`, 'is not supported')
    if (property) assertPptxSchema(propertyValue(value, key, `${path}.${key}`), property, `${path}.${key}`)
  }
}

export function assertPptxSchema(value, schema, path) {
  const variants = schema.oneOf || schema.anyOf
  if (variants) {
    const match = variants.find((candidate) => {
      if (!matchesType(value, candidate.type)) return false
      const type = candidate.properties?.type?.const
      return type === undefined || propertyValue(value, 'type', `${path}.type`) === type
    })
    if (!match) invalidPptx(path, 'does not match a supported data type')
    return assertPptxSchema(value, match, path)
  }
  if (!matchesType(value, schema.type)) invalidPptx(path, `must be ${schema.type}`)
  if (Object.hasOwn(schema, 'const') && value !== schema.const) invalidPptx(path, `must be ${schema.const}`)
  if (schema.enum && !schema.enum.includes(value)) invalidPptx(path, `must be one of ${schema.enum.join(', ')}`)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidPptx(path, 'must be a finite number')
    if (schema.minimum !== undefined && value < schema.minimum) invalidPptx(path, `must be at least ${schema.minimum}`)
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) invalidPptx(path, `must exceed ${schema.exclusiveMinimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) invalidPptx(path, `must be at most ${schema.maximum}`)
  }
  if (typeof value === 'string') {
    pptxText(value, path, schema.maxLength ?? PPTX_LIMITS.text)
    if (schema.minLength && value.length < schema.minLength) invalidPptx(path, 'must not be empty')
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) invalidPptx(path, 'has an invalid format')
  }
  if (Array.isArray(value)) {
    if (schema.minItems && value.length < schema.minItems) invalidPptx(path, `must contain at least ${schema.minItems} item(s)`)
    if (schema.maxItems && value.length > schema.maxItems) invalidPptx(path, `must contain at most ${schema.maxItems} item(s)`)
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) invalidPptx(path, 'must be a dense array')
      assertPptxSchema(propertyValue(value, index, `${path}[${index}]`), schema.items, `${path}[${index}]`)
    }
  } else if (value && typeof value === 'object') validateObject(value, schema, path)
}

export function pptxColor(value) {
  return value === undefined ? undefined : value.replace(/^#/u, '').toUpperCase()
}

export function normalizePptxChart(chart, path) {
  assertPptxSchema(chart, PPTX_CHART_SCHEMA, path)
  const length = chart.series[0].values.length
  if (chart.series.some((series) => series.values.length !== length)) {
    invalidPptx(path, 'must contain equally sized series; values cannot be omitted or filled with invented zeros')
  }
  if (chart.categories?.length && chart.categories.length !== length) {
    invalidPptx(`${path}.categories`, 'must have exactly one label for every value')
  }
  if (['pie', 'doughnut'].includes(chart.type)) {
    if (chart.series.length !== 1) invalidPptx(`${path}.series`, 'must contain exactly one series for a pie or doughnut chart')
    if (chart.series[0].values.some((number) => number < 0)
      || !chart.series[0].values.some((number) => number > 0)) {
      invalidPptx(path, 'must contain non-negative values with a positive total for a pie or doughnut chart')
    }
  }
  return {
    ...chart,
    categories: chart.categories?.length ? [...chart.categories] : Array.from({ length }, (_, index) => String(index + 1)),
    series: chart.series.map((series) => ({ name: series.name || '', values: [...series.values] })),
    ...(chart.colors ? { colors: chart.colors.map(pptxColor) } : {}),
  }
}

export function normalizePptxTable(table, path) {
  assertPptxSchema(table, PPTX_TABLE_SCHEMA, path)
  const columns = table.rows[0].length
  if (table.rows.some((row) => row.length !== columns)) invalidPptx(`${path}.rows`, 'must have the same number of cells in every row')
  const widths = table.column_widths || Array.from({ length: columns }, () => 1 / columns)
  const sum = widths.reduce((total, value) => total + value, 0)
  if (widths.length !== columns || Math.abs(sum - 1) > 0.001) {
    invalidPptx(`${path}.column_widths`, 'must contain one positive width per column and add up to 1')
  }
  return {
    rows: table.rows.map((row) => row.map((value) => value === null ? '' : String(value))),
    header: table.header === true,
    columnWidths: widths.map((width) => width / sum),
  }
}

export function fullPptxBullets(slide, path) {
  let bullets = slide.bullets ?? []
  if (!Array.isArray(bullets)) invalidPptx(`${path}.bullets`, 'must be an array')
  if (slide.body) bullets = [...bullets, ...pptxText(slide.body, `${path}.body`).split(/\r?\n/u)]
  if (bullets.length > PPTX_LIMITS.bullets) invalidPptx(`${path}.bullets`, `must contain at most ${PPTX_LIMITS.bullets} items`)
  return bullets.map((text, index) => pptxText(text, `${path}.bullets[${index}]`).trim()).filter(Boolean)
}

export function fullPptxKpis(slide, path) {
  const source = slide.kpi ?? slide.kpis ?? []
  if (!Array.isArray(source) || source.length > 4) invalidPptx(`${path}.kpi`, 'must be an array of at most four items')
  return source.map((item, index) => {
    const itemPath = `${path}.kpi[${index}]`
    if (!item || !['string', 'number'].includes(typeof item.value)
      || (typeof item.value === 'number' && !Number.isFinite(item.value))) {
      invalidPptx(`${itemPath}.value`, 'must be a string or finite number')
    }
    return Object.fromEntries(['value', 'label', 'unit', 'delta'].map((key) => [
      key, pptxText(item[key] == null ? '' : String(item[key]), `${itemPath}.${key}`, 500),
    ]))
  })
}
