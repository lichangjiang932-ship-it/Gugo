import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE_DIR = path.resolve(__dirname, '../data/agent_templates')
const TEMPLATE_IDS = ['hanako', 'butter', 'ming', 'kong']
const TEMPLATE_ID_RE = /^[a-z0-9_-]+$/i
const SUPPORTED_LANGS = new Set(['zh', 'en'])

function normalizeLang(lang) {
  return SUPPORTED_LANGS.has(lang) ? lang : 'zh'
}

function parseFrontmatter(text) {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/)
  if (!match) return { meta: {}, body: text }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return { meta, body: text.slice(match[0].length).trim() }
}

function parseSections(body) {
  const sections = []
  const re = /^##\s+(.+?)\s*$/gm
  const matches = [...body.matchAll(re)]
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]
    const next = matches[i + 1]
    sections.push({
      title: match[1].trim(),
      body: body.slice(match.index + match[0].length, next?.index ?? body.length).trim(),
    })
  }
  return sections
}

function readTemplateFile(id, lang) {
  if (!TEMPLATE_ID_RE.test(id)) return null
  const filePath = path.join(TEMPLATE_DIR, `${id}.${normalizeLang(lang)}.md`)
  if (!filePath.startsWith(TEMPLATE_DIR + path.sep)) return null
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

function parseTemplate(id, lang) {
  const raw = readTemplateFile(id, lang)
  if (!raw) return null
  const { meta, body } = parseFrontmatter(raw)
  const finalId = meta.id || id
  const finalLang = normalizeLang(meta.lang || lang)
  return {
    id: finalId,
    lang: finalLang,
    name: meta.name || finalId,
    label: meta.label || meta.name || finalId,
    description: meta.description || '',
    sections: parseSections(body),
    systemPrompt: body,
  }
}

function toListItem(template) {
  return {
    id: template.id,
    lang: template.lang,
    name: template.name,
    label: template.label,
    description: template.description,
  }
}

export function listAgentTemplates({ lang = 'zh' } = {}) {
  const finalLang = normalizeLang(lang)
  return TEMPLATE_IDS
    .map((id) => parseTemplate(id, finalLang))
    .filter(Boolean)
    .map(toListItem)
}

export function getAgentTemplate(id, { lang = 'zh' } = {}) {
  if (!id || typeof id !== 'string') return null
  const key = id.trim()
  if (!TEMPLATE_IDS.includes(key)) return null
  return parseTemplate(key, normalizeLang(lang))
}

export function isKnownAgentTemplate(id) {
  return typeof id === 'string' && TEMPLATE_IDS.includes(id.trim())
}

export function getAgentTemplateSystemPrompt(id, { lang = 'zh' } = {}) {
  const template = getAgentTemplate(id, { lang })
  return template?.systemPrompt || ''
}
