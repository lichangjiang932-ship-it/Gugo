import { useCallback, useEffect, useState } from 'react'
import {
  createAgentApi,
  deleteAgentApi,
  exportAgentUrl,
  exportAgentZipUrl,
  getAgentTemplateApi,
  getDefaultAgentApi,
  importAgentApi,
  importAgentZipApi,
  listAgentsApi,
  listAgentTemplatesApi,
  updateAgentApi,
} from '../../lib/agentClient.js'
import { getPluginApi, listPluginsApi } from '../../lib/pluginClient.js'

const EMPTY_MANIFEST = { version: 1, capabilityIds: [], recommendedConnectorIds: [], defaultPermissionMode: 'bypass' }

function emptyAgent() {
  return { id: '', name: '', soulMd: '', identityMd: '', personaTemplate: '', personaManifest: EMPTY_MANIFEST, avatarUrl: '', isDefault: false }
}

export default function useAgentListController({ lang, refreshActiveAgent, t }) {
  const [agents, setAgents] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const [personaTemplates, setPersonaTemplates] = useState([])
  const [personaDraftId, setPersonaDraftId] = useState('')
  const [personaPreview, setPersonaPreview] = useState(null)
  const [personaLoading, setPersonaLoading] = useState(false)
  const [templates, setTemplates] = useState([])
  const [showTemplates, setShowTemplates] = useState(false)
  const [previewTpl, setPreviewTpl] = useState(null)
  const [previewSource, setPreviewSource] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const templateLang = lang === 'en' ? 'en' : 'zh'

  const reload = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      let list = await listAgentsApi()
      if ((list.agents || []).length === 0) {
        await getDefaultAgentApi()
        list = await listAgentsApi()
      }
      setAgents(list.agents || [])
      refreshActiveAgent?.()
    } catch (error) {
      setErr(error.message || t('errors.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [refreshActiveAgent, t])

  useEffect(() => {
    const timer = window.setTimeout(reload, 0)
    return () => window.clearTimeout(timer)
  }, [reload])

  const loadPersonaTemplates = async () => {
    try {
      const data = await listAgentTemplatesApi({ lang: templateLang })
      setPersonaTemplates(data.templates || [])
    } catch (error) {
      setErr(error.message || t('errors.loadFailed'))
    }
  }
  const loadPersonaPreview = async (id) => {
    if (!id) { setPersonaPreview(null); return }
    setPersonaLoading(true)
    try {
      const data = await getAgentTemplateApi(id, { lang: templateLang })
      setPersonaPreview(data.template || null)
    } catch (error) {
      setPersonaPreview(null)
      setErr(error.message || t('errors.loadFailed'))
    } finally {
      setPersonaLoading(false)
    }
  }
  const openNew = () => {
    setEditing(emptyAgent())
    setPersonaDraftId('')
    setPersonaPreview(null)
    loadPersonaTemplates()
  }
  const openEdit = (agent) => {
    const personaTemplate = agent.personaTemplate || ''
    setEditing({
      id: agent.id,
      name: agent.name,
      soulMd: agent.soulMd || '',
      identityMd: agent.identityMd || '',
      personaTemplate,
      personaManifest: agent.personaManifest || EMPTY_MANIFEST,
      avatarUrl: agent.avatarUrl || '',
      isDefault: !!agent.isDefault,
    })
    setPersonaDraftId(personaTemplate)
    setPersonaPreview(null)
    loadPersonaTemplates()
    if (personaTemplate) loadPersonaPreview(personaTemplate)
  }
  const save = async () => {
    if (!editing) return
    if (!editing.name.trim()) { setErr(t('agents.errNameRequired')); return }
    setSaving(true)
    setErr('')
    try {
      const payload = { ...editing, id: undefined, name: editing.name.trim(), avatarUrl: editing.avatarUrl || null }
      if (editing.id) await updateAgentApi(editing.id, payload)
      else await createAgentApi(payload)
      setEditing(null)
      await reload()
    } catch (error) {
      setErr(error.message || t('errors.saveFailed'))
    } finally {
      setSaving(false)
    }
  }
  const remove = async (agent) => {
    if (!window.confirm(t('agents.confirmDelete', { name: agent.name }))) return
    try { await deleteAgentApi(agent.id); await reload() } catch (error) { setErr(error.message || t('errors.deleteFailed')) }
  }
  const importWithRetry = async (source, hintName) => {
    try { await importAgentApi(source) } catch (error) {
      if (!/\u540c\u540d|UNIQUE/i.test(String(error?.message || ''))) throw error
      const next = window.prompt(t('agents.renameOnConflict'), `${hintName} (copy)`)
      if (!next?.trim()) throw error
      await importAgentApi(source, { overrideName: next.trim() })
    }
  }
  const importMarkdown = () => chooseFile('.md,text/markdown,text/plain', async (file) => {
    const source = await file.text()
    await importWithRetry(source, /name:\s*"?([^"\n]+)/.exec(source)?.[1]?.trim() || 'Agent')
  }, reload, setErr, t)
  const importZip = () => chooseFile('.zip,application/zip', async (file) => {
    if (file.size > 10 * 1024 * 1024) throw new Error('zip > 10MB')
    try { await importAgentZipApi(file) } catch (error) {
      if (!/\u540c\u540d|UNIQUE/i.test(String(error?.message || ''))) throw error
      const next = window.prompt(t('agents.renameOnConflict'), 'imported-agent (copy)')
      if (!next?.trim()) throw error
      await importAgentZipApi(file, { overrideName: next.trim() })
    }
  }, reload, setErr, t)
  const openTemplates = async () => {
    setErr('')
    try {
      const data = await listPluginsApi({ type: 'agent-template' })
      setTemplates(data.plugins || [])
      setShowTemplates(true)
      setPreviewTpl(null)
      setPreviewSource('')
    } catch (error) { setErr(error.message || t('errors.loadFailed')) }
  }
  const openPreview = async (template) => {
    setPreviewTpl(template)
    setPreviewSource('')
    setPreviewLoading(true)
    try { setPreviewSource((await getPluginApi(template.id))?.entryPreview?.content || '') }
    catch (error) { setErr(error.message || t('errors.loadFailed')) }
    finally { setPreviewLoading(false) }
  }
  const useTemplate = async (template) => {
    try {
      let source = previewTpl?.id === template.id ? previewSource : ''
      if (!source) source = (await getPluginApi(template.id))?.entryPreview?.content || ''
      if (!source) throw new Error('template entry empty')
      await importWithRetry(source, template.name || 'Agent')
      setShowTemplates(false)
      await reload()
    } catch (error) { setErr(error.message || t('errors.loadFailed')) }
  }
  const exportAgent = (agent) => downloadAgent(exportAgentUrl(agent.id), `${agent.name}.agent.md`, setErr, t)
  const exportZip = (agent) => downloadAgent(exportAgentZipUrl(agent.id), `${agent.name}.agent.zip`, setErr, t)

  return {
    agents, editing, err, exportAgent, exportZip, importMarkdown, importZip, loading, openEdit, openNew,
    openPreview, openTemplates, personaDraftId, personaLoading, personaPreview, personaTemplates, previewLoading,
    previewSource, previewTpl, remove, save, saving, setEditing, setShowTemplates, showTemplates, templates, useTemplate,
    applyPersona: () => setEditing((current) => current ? { ...current, personaTemplate: personaDraftId || '' } : current),
    selectPersona: (id) => { setPersonaDraftId(id); loadPersonaPreview(id) },
  }
}

function chooseFile(accept, processFile, reload, setErr, t) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = accept
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    try { await processFile(file); await reload() } catch (error) { setErr(error.message || t('errors.loadFailed')) }
  }
  input.click()
}

async function downloadAgent(url, filename, setErr, t) {
  try {
    const { getAuthToken } = await import('../../lib/accountClient.js')
    const token = getAuthToken?.() || ''
    const response = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    if (!response.ok) throw new Error('export failed')
    const objectUrl = URL.createObjectURL(await response.blob())
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(objectUrl)
  } catch (error) { setErr(error.message || t('errors.loadFailed')) }
}
