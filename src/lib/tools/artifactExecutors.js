import { parseMarkdownDocument, parseSpreadsheetRows } from '../officeExport.js'
import { parseMarkdownSlides } from '../presentationExport.js'

async function execCreatePptx(args) {
  const title = String(args.title).trim().slice(0, 200) || 'presentation'
  const markdown = String(args.markdown)
  // \u7528\u73b0\u6709 parseMarkdownSlides \u505a\u4e00\u6b21 sanity \u89e3\u6790,\u5931\u8d25\u5c31\u8ba9\u6a21\u578b\u77e5\u9053
  const slides = parseMarkdownSlides(markdown)
  if (!slides.length) throw new Error('markdown \u89e3\u6790\u4e3a 0 \u5f20\u5e7b\u706f\u7247;\u8bf7\u7528 --- \u5206\u9875\u6216\u4ee5 # \u5f00\u5934\u7684\u9875\u6807\u9898')
  return {
    content: JSON.stringify({
      ok: true,
      title,
      slides: slides.length,
      message: `\u5df2\u751f\u6210 PPT \u8349\u7a3f "${title}"(${slides.length} \u9875),\u7528\u6237\u53ef\u5728\u53f3\u4fa7\u9884\u89c8\u5e76\u4e0b\u8f7d\u3002`,
    }),
    artifact: { type: 'pptx', title, source: markdown },
  }
}

async function execCreateDocx(args) {
  const title = String(args.title).trim().slice(0, 200) || 'document'
  const markdown = String(args.markdown)
  const doc = parseMarkdownDocument(markdown)
  if (!doc.blocks.length) throw new Error('markdown \u89e3\u6790\u4e3a 0 \u4e2a\u5185\u5bb9\u5757')
  return {
    content: JSON.stringify({
      ok: true,
      title,
      blocks: doc.blocks.length,
      message: `\u5df2\u751f\u6210 Word \u8349\u7a3f "${title}"(${doc.blocks.length} \u4e2a\u5757),\u7528\u6237\u53ef\u5728\u53f3\u4fa7\u9884\u89c8\u5e76\u4e0b\u8f7d\u3002`,
    }),
    artifact: { type: 'docx', title, source: markdown },
  }
}

async function execCreateXlsx(args) {
  const title = String(args.title).trim().slice(0, 200) || 'spreadsheet'
  const rows = Array.isArray(args.rows) ? args.rows : null
  let source
  if (rows && rows.length) {
    // \u76f4\u63a5\u7528\u7ed3\u6784\u5316\u6570\u7ec4 \u2014 \u8f6c\u6210 csv \u8ba9\u73b0\u6709 parseSpreadsheetRows \u8d70\u901a
    source = '```csv\n' + rows.map((r) =>
      r.map((c) => {
        const s = c == null ? '' : String(c)
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
      }).join(',')
    ).join('\n') + '\n```'
  } else if (args.markdown) {
    source = String(args.markdown)
  } else {
    throw new Error('\u9700\u8981 rows \u6216 markdown \u81f3\u5c11\u4e00\u9879')
  }
  const parsed = parseSpreadsheetRows(source)
  if (!parsed.length) throw new Error('\u89e3\u6790\u4e3a 0 \u884c\u6570\u636e')
  return {
    content: JSON.stringify({
      ok: true,
      title,
      rows: parsed.length,
      message: `\u5df2\u751f\u6210 Excel \u8349\u7a3f "${title}"(${parsed.length} \u884c),\u7528\u6237\u53ef\u5728\u53f3\u4fa7\u9884\u89c8\u5e76\u4e0b\u8f7d\u3002`,
    }),
    artifact: { type: 'xlsx', title, source },
  }
}

// \u2605 \u5371\u9669\u4ee3\u7801\u6a21\u5f0f \u2014 \u6c99\u7bb1\u9003\u9038/\u6076\u610f\u884c\u4e3a\u62e6\u622a
const DANGEROUS_PATTERNS = [
  { pattern: /\beval\s*\(/, msg: '\u6c99\u7bb1\u7981\u7528 eval() \u2014 \u8bf7\u7528\u672c\u5730\u72b6\u6001\u4e0e\u903b\u8f91\u5b9e\u73b0\u529f\u80fd' },
  { pattern: /\bnew\s+Function\s*\(/, msg: '\u6c99\u7bb1\u7981\u7528 new Function() \u2014 \u8bf7\u7528\u5e38\u89c4\u51fd\u6570\u5b9a\u4e49' },
  { pattern: /\bsetTimeout\s*\(\s*["']/, msg: '\u6c99\u7bb1\u7981\u7528 setTimeout \u5b57\u7b26\u4e32\u53c2\u6570 \u2014 \u8bf7\u4f20\u5165\u51fd\u6570' },
  { pattern: /\bsetInterval\s*\(\s*["']/, msg: '\u6c99\u7bb1\u7981\u7528 setInterval \u5b57\u7b26\u4e32\u53c2\u6570 \u2014 \u8bf7\u4f20\u5165\u51fd\u6570' },
  { pattern: /document\.write\s*\(/, msg: '\u6c99\u7bb1\u7981\u7528 document.write \u2014 \u8bf7\u7528 JSX \u6e32\u67d3' },
  { pattern: /window\.location\s*=/, msg: '\u6c99\u7bb1\u7981\u7528 window.location \u8df3\u8f6c \u2014 \u8bf7\u7528\u672c\u5730\u4ea4\u4e92\u5b9e\u73b0\u529f\u80fd' },
  { pattern: /<script\b/i, msg: '\u6c99\u7bb1\u7981\u7528 <script> \u6807\u7b7e \u2014 \u8bf7\u7528 JSX \u4e0e hooks \u5b9e\u73b0\u903b\u8f91' },
  { pattern: /\brequire\s*\(/, msg: '\u6c99\u7bb1\u7981\u7528 require() \u2014 \u53ea\u80fd\u7528 React/ReactDOM \u5168\u5c40\u53d8\u91cf' },
  { pattern: /\bimport\s*\(/, msg: '\u6c99\u7bb1\u7981\u7528\u52a8\u6001 import() \u2014 \u8bf7\u7528\u672c\u5730\u72b6\u6001\u5b9e\u73b0\u529f\u80fd' },
  { pattern: /\bfetch\s*\(|XMLHttpRequest|WebSocket/, msg: '\u6c99\u7bb1\u7981\u7528\u7f51\u7edc\u8bf7\u6c42(fetch/XHR/WebSocket);\u8bf7\u7528\u672c\u5730\u72b6\u6001\u751f\u6210\u793a\u4f8b\u6570\u636e' },
  { pattern: /\bimport\s+[^;]*\bfrom\b/, msg: '\u6c99\u7bb1\u4e0d\u5141\u8bb8 import \u5916\u90e8\u5305;\u53ea\u80fd\u7528 React/ReactDOM(\u5df2\u4f5c\u4e3a\u5168\u5c40\u53d8\u91cf\u6ce8\u5165)' },
]

async function execCreateReactComponent(args) {
  const title = String(args.title).trim().slice(0, 200) || 'react-component'
  const code = String(args.code)
  const description = args.description ? String(args.description).trim().slice(0, 500) : ''
  // \u6700\u8f7b\u91cf sanity check \u2014 \u9632\u6b62\u5e38\u89c1\u9519\u8bef\u4f20\u5230\u6c99\u7bb1\u524d\u5c31\u62a5
  if (!/export\s+default/.test(code)) {
    throw new Error('\u4ee3\u7801\u7f3a\u5c11 export default \u2014 \u8bf7\u7528 `export default function App() { ... }` \u6216 `export default () => ...`')
  }
  for (const { pattern, msg } of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      throw new Error(msg)
    }
  }
  return {
    content: JSON.stringify({
      ok: true,
      title,
      bytes: code.length,
      message: `\u5df2\u751f\u6210 React \u7ec4\u4ef6 "${title}"(${code.length} \u5b57\u7b26),\u7528\u6237\u53ef\u5728\u53f3\u4fa7\u5b9e\u65f6\u9884\u89c8\u5e76\u4ea4\u4e92\u3002`,
    }),
    artifact: { type: 'react', title, source: code, description },
  }
}


function rejectDangerousHtml(source, label = 'HTML') {
  const text = String(source || '')
  const bad = [
    /<script\b[^>]*\bsrc\s*=/i,
    /<link\b[^>]*\brel=["']?stylesheet["']?[^>]*\bhref\s*=/i,
    /javascript:/i,
    /on\w+\s*=/i,
  ]
  if (bad.some((re) => re.test(text))) {
    throw new Error(`${label} contains external scripts/styles or inline event handlers; keep artifacts self-contained.`)
  }
  return text
}

function rejectSvgScripts(svg) {
  const text = String(svg || '')
  if (!/^\s*<svg[\s>]/i.test(text)) throw new Error('svg must start with an <svg> element')
  if (/<script\b|javascript:|on\w+\s*=/i.test(text)) throw new Error('SVG scripts and event handlers are not allowed')
  return text
}

async function execCreateMermaid(args) {
  const title = String(args.title || 'diagram').trim().slice(0, 200) || 'diagram'
  const diagram = String(args.diagram || '').trim()
  if (!diagram) throw new Error('diagram is required')
  if (/<script\b|javascript:/i.test(diagram)) throw new Error('Mermaid source cannot contain scripts')
  return {
    content: JSON.stringify({ ok: true, title, type: 'mermaid', message: `Created Mermaid artifact "${title}".` }),
    artifact: { type: 'mermaid', title, source: diagram, description: args.theme || 'default' },
  }
}

async function execCreateChart(args) {
  const title = String(args.title || 'chart').trim().slice(0, 200) || 'chart'
  const config = args.config && typeof args.config === 'object' ? args.config : null
  if (!config) throw new Error('config is required')
  const source = JSON.stringify(config, null, 2)
  return {
    content: JSON.stringify({ ok: true, title, type: 'chart', message: `Created chart artifact "${title}".` }),
    artifact: { type: 'chart', title, source },
  }
}

async function execCreateSvg(args) {
  const title = String(args.title || 'vector').trim().slice(0, 200) || 'vector'
  const source = rejectSvgScripts(args.svg)
  return {
    content: JSON.stringify({ ok: true, title, type: 'svg', bytes: source.length, message: `Created SVG artifact "${title}".` }),
    artifact: { type: 'svg', title, source },
  }
}

async function execCreateHtmlApp(args) {
  const title = String(args.title || 'html-app').trim().slice(0, 200) || 'html-app'
  const files = args.files && typeof args.files === 'object' ? args.files : {}
  if (!files['index.html']) throw new Error('files must include index.html')
  const safeFiles = {}
  for (const [name, value] of Object.entries(files)) {
    if (!/^[\w./-]+$/.test(name) || name.includes('..')) throw new Error(`unsafe filename: ${name}`)
    safeFiles[name] = rejectDangerousHtml(String(value || ''), name)
  }
  const source = JSON.stringify(safeFiles, null, 2)
  return {
    content: JSON.stringify({ ok: true, title, type: 'html_multi', files: Object.keys(safeFiles), message: `Created multi-file HTML artifact "${title}".` }),
    artifact: { type: 'html_multi', title, source },
  }
}

export const ARTIFACT_EXECUTORS = {
  create_pptx: execCreatePptx,
  create_docx: execCreateDocx,
  create_xlsx: execCreateXlsx,
  create_react_component: execCreateReactComponent,
  create_mermaid: execCreateMermaid,
  create_chart: execCreateChart,
  create_svg: execCreateSvg,
  create_html_app: execCreateHtmlApp,
}

