export const PPTX_LIMITS = Object.freeze({
  slides: 100,
  elements: 128,
  text: 16_000,
  bullets: 24,
  series: 20,
  points: 200,
  rows: 40,
  columns: 16,
  imageIndex: 50,
  minFontSize: 8,
  maxFontSize: 120,
  maxDimension: 30,
})

const COLOR = Object.freeze({ type: 'string', pattern: '^#?[0-9a-fA-F]{6}$' })
const FONT = Object.freeze({ type: 'string', minLength: 1, maxLength: 100 })
const FONT_SIZE = Object.freeze({
  type: 'number', minimum: PPTX_LIMITS.minFontSize, maximum: PPTX_LIMITS.maxFontSize,
})
const TEXT = Object.freeze({ type: 'string', maxLength: PPTX_LIMITS.text })
const LABEL = Object.freeze({ type: 'string', maxLength: 500 })
const FRACTION = Object.freeze({ type: 'number', minimum: 0, maximum: 1 })
const EXTENT = Object.freeze({ type: 'number', exclusiveMinimum: 0, maximum: 1 })

export const PPTX_DESIGN_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  description: 'Author this directly from the user request; do not ask the user to configure it. Exact requested colors, fonts, proportions, and optional chrome take priority over topic-based presets. Omitting chrome flags never adds a brand, date, or page number.',
  properties: {
    background: COLOR,
    foreground: COLOR,
    accent: COLOR,
    secondary: COLOR,
    muted: COLOR,
    heading_font: FONT,
    body_font: FONT,
    east_asian_font: FONT,
    heading_font_size: FONT_SIZE,
    body_font_size: FONT_SIZE,
    aspect_ratio: { type: 'string', enum: ['16:9', '4:3', '16:10', '1:1', '9:16'] },
    width: { type: 'number', minimum: 4, maximum: PPTX_LIMITS.maxDimension, description: 'Slide width in inches. Supply width and height together for an exact custom size.' },
    height: { type: 'number', minimum: 4, maximum: PPTX_LIMITS.maxDimension, description: 'Slide height in inches. Supply width and height together for an exact custom size.' },
    show_page_numbers: { type: 'boolean' },
    show_brand: { type: 'boolean' },
    show_date: { type: 'boolean' },
  },
})

export const PPTX_CHART_TYPES = Object.freeze([
  'bar', 'bar-stacked', 'bar-horizontal', 'line', 'area', 'pie', 'doughnut',
])

export const PPTX_CHART_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  description: 'Native editable chart with supplied numeric evidence. Every series must have the same number of values as categories. Never invent zeros or discard missing/invalid points; resolve missing data before calling the tool.',
  properties: {
    type: { type: 'string', enum: PPTX_CHART_TYPES },
    categories: { type: 'array', maxItems: PPTX_LIMITS.points, items: LABEL },
    series: {
      type: 'array', minItems: 1, maxItems: PPTX_LIMITS.series,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          name: LABEL,
          values: { type: 'array', minItems: 1, maxItems: PPTX_LIMITS.points, items: { type: 'number' } },
        },
        required: ['values'],
      },
    },
    colors: { type: 'array', minItems: 1, maxItems: PPTX_LIMITS.points, items: COLOR },
    show_legend: { type: 'boolean' },
    show_values: { type: 'boolean' },
    legend_position: { type: 'string', enum: ['b', 't', 'l', 'r'] },
    x_axis_title: LABEL,
    y_axis_title: LABEL,
    number_format: { type: 'string', maxLength: 80 },
  },
  required: ['type', 'series'],
})

export const PPTX_TABLE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  description: 'Native editable rectangular table. Keep every requested row and column; the tool rejects content that cannot fit rather than dropping cells or adding pages.',
  properties: {
    rows: {
      type: 'array', minItems: 1, maxItems: PPTX_LIMITS.rows,
      items: {
        type: 'array', minItems: 1, maxItems: PPTX_LIMITS.columns,
        items: { anyOf: [{ type: 'string', maxLength: 2000 }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] },
      },
    },
    header: { type: 'boolean', description: 'Treat the first supplied row as the header; no header text is fabricated.' },
    column_widths: {
      type: 'array', minItems: 1, maxItems: PPTX_LIMITS.columns,
      items: EXTENT,
      description: 'Optional relative widths within the table, one per column, adding up to 1.',
    },
  },
  required: ['rows'],
})

const FRAME = Object.freeze({ x: FRACTION, y: FRACTION, w: EXTENT, h: EXTENT })
const TEXT_STYLE = Object.freeze({
  font_size: FONT_SIZE,
  font_face: FONT,
  color: COLOR,
  bold: { type: 'boolean' },
  italic: { type: 'boolean' },
  align: { type: 'string', enum: ['left', 'center', 'right'] },
  valign: { type: 'string', enum: ['top', 'mid', 'bottom'] },
})

function elementSchema(type, properties, required = []) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: { type: { type: 'string', const: type }, ...FRAME, ...properties },
    required: ['type', 'x', 'y', 'w', 'h', ...required],
  }
}

export const PPTX_ELEMENT_SCHEMA = Object.freeze({
  description: 'One native editable element. x/y/w/h are fractions of the entire slide, not inches; x+w and y+h must be at most 1. Array order is the intentional back-to-front drawing order. Keep sufficient space for complete text and do not overlap evidence with decoration.',
  oneOf: [
    elementSchema('text', {
      text: TEXT,
      role: { type: 'string', enum: ['heading', 'body', 'caption'], description: 'Optional text role. heading inherits heading_font and heading_font_size; body is the default. Explicit font_face/font_size always take priority.' },
      ...TEXT_STYLE,
      fill: COLOR,
    }, ['text']),
    elementSchema('shape', {
      shape: { type: 'string', enum: ['rect', 'roundRect', 'ellipse', 'triangle', 'chevron'] },
      fill: COLOR,
      line_color: COLOR,
      line_width: { type: 'number', minimum: 0, maximum: 10 },
      transparency: { type: 'number', minimum: 0, maximum: 100 },
    }, ['shape']),
    elementSchema('line', {
      w: FRACTION,
      h: FRACTION,
      line_color: COLOR,
      line_width: { type: 'number', minimum: 0, maximum: 10 },
      begin_arrow: { type: 'string', enum: ['none', 'triangle'] },
      end_arrow: { type: 'string', enum: ['none', 'triangle'] },
      flip_vertical: { type: 'boolean' },
    }),
    elementSchema('chart', { chart: PPTX_CHART_SCHEMA, font_face: FONT, font_size: FONT_SIZE }, ['chart']),
    elementSchema('table', {
      table: PPTX_TABLE_SCHEMA,
      ...TEXT_STYLE,
      fill: COLOR,
      header_fill: COLOR,
      header_color: COLOR,
      line_color: COLOR,
    }, ['table']),
    elementSchema('image', {
      image_index: {
        type: 'integer', minimum: 1, maximum: PPTX_LIMITS.imageIndex,
        description: '1-based index into the top-level images array, which the host authorizes and prepares. Never put a file path, URL, code, or data URI in an element.',
      },
      fit: { type: 'string', enum: ['contain', 'cover', 'stretch'] },
      alt: LABEL,
    }, ['image_index']),
  ],
})

export const PPTX_SLIDE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  description: 'A requested slide, with no implicit cover or closing page. Prefer elements for user-directed compositions. Legacy layout/content fields remain supported; elements automatically select canvas and must not be mixed with legacy content fields.',
  properties: {
    title: TEXT,
    layout: { type: 'string', enum: ['canvas', 'cover', 'section', 'kpi', 'chart', 'table', 'statement', 'split', 'process', 'quote', 'bullets', 'end'] },
    background: COLOR,
    notes: TEXT,
    elements: { type: 'array', minItems: 1, maxItems: PPTX_LIMITS.elements, items: PPTX_ELEMENT_SCHEMA },
    eyebrow: LABEL,
    bullets: { type: 'array', maxItems: PPTX_LIMITS.bullets, items: TEXT },
    body: TEXT,
    subtitle: TEXT,
    kpi: {
      type: 'array', maxItems: 4,
      items: {
        type: 'object', additionalProperties: false,
        properties: { value: LABEL, label: LABEL, unit: LABEL, delta: LABEL },
        required: ['value'],
      },
    },
    chart: PPTX_CHART_SCHEMA,
    table: PPTX_TABLE_SCHEMA,
    quote: {
      oneOf: [TEXT, {
        type: 'object', additionalProperties: false,
        properties: { text: TEXT, source: LABEL },
        required: ['text'],
      }],
    },
  },
  required: ['title'],
})
