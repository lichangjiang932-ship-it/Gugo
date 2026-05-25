import { useEffect, useState } from 'react'
import { Plus, Trash2, Save, Star, X, Download, Upload, Sparkles, Package } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import { useT } from '../i18n/I18nProvider.jsx'
import { useActiveAgent } from '../agents/activeAgentContext.js'
import {
  listAgentsApi,
  createAgentApi,
  updateAgentApi,
  deleteAgentApi,
  getDefaultAgentApi,
  exportAgentUrl,
  exportAgentZipUrl,
  importAgentApi,
  importAgentZipApi,
} from '../lib/agentClient.js'
import { listPluginsApi, getPluginApi } from '../lib/pluginClient.js'

function emptyAgent() {
  return { id: '', name: '', soulMd: '', identityMd: '', avatarUrl: '', isDefault: false }
}

export default function AgentList() {
  const { t } = useT()
  const { refresh: refreshActiveAgent } = useActiveAgent()
  const [agents, setAgents] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)

  const reload = async () => {
    setLoading(true)
    setErr('')
    try {
      // 首次拉到空就触发默认 agent seed
      const list = await listAgentsApi()
      if ((list.agents || []).length === 0) {
        await getDefaultAgentApi()
        const again = await listAgentsApi()
        setAgents(again.agents || [])
      } else {
        setAgents(list.agents || [])
      }
      // 列表变动后同步 active agent context
      refreshActiveAgent?.()
    } catch (e) {
      setErr(e.message || t('errors.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { reload() }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  const handleNew = () => setEditing(emptyAgent())

  const handleEdit = (a) => setEditing({
    id: a.id,
    name: a.name,
    soulMd: a.soulMd || '',
    identityMd: a.identityMd || '',
    avatarUrl: a.avatarUrl || '',
    isDefault: !!a.isDefault,
  })

  const handleSave = async () => {
    if (!editing) return
    if (!editing.name.trim()) {
      setErr(t('agents.errNameRequired'))
      return
    }
    setSaving(true)
    setErr('')
    try {
      const payload = {
        name: editing.name.trim(),
        soulMd: editing.soulMd,
        identityMd: editing.identityMd,
        avatarUrl: editing.avatarUrl || null,
        isDefault: editing.isDefault,
      }
      if (editing.id) {
        await updateAgentApi(editing.id, payload)
      } else {
        await createAgentApi(payload)
      }
      setEditing(null)
      await reload()
    } catch (e) {
      setErr(e.message || t('errors.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (a) => {
    if (!window.confirm(t('agents.confirmDelete', { name: a.name }))) return
    try {
      await deleteAgentApi(a.id)
      await reload()
    } catch (e) {
      setErr(e.message || t('errors.deleteFailed'))
    }
  }

  // v0.7: 撞名重试。后端报 "已存在同名 agent: <x>" 时，弹 prompt 让用户改名 retry。
  const importWithRetry = async (source, hintName) => {
    try {
      await importAgentApi(source)
    } catch (e) {
      const msg = String(e?.message || '')
      if (/已存在同名/.test(msg) || /UNIQUE/i.test(msg)) {
        const next = window.prompt(t('agents.renameOnConflict'), `${hintName} (copy)`)
        if (next && next.trim()) {
          await importAgentApi(source, { overrideName: next.trim() })
          return
        }
      }
      throw e
    }
  }

  const handleImport = async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,text/markdown,text/plain'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        const source = await file.text()
        await importWithRetry(source, /name:\s*"?([^"\n]+)/.exec(source)?.[1]?.trim() || 'Agent')
        await reload()
      } catch (e) {
        setErr(e.message || t('errors.loadFailed'))
      }
    }
    input.click()
  }

  const [templates, setTemplates] = useState([])
  const [showTemplates, setShowTemplates] = useState(false)
  const [previewTpl, setPreviewTpl] = useState(null)
  const [previewSource, setPreviewSource] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)

  const openTemplates = async () => {
    setErr('')
    try {
      const { plugins } = await listPluginsApi({ type: 'agent-template' })
      setTemplates(plugins || [])
      setShowTemplates(true)
      setPreviewTpl(null)
      setPreviewSource('')
    } catch (e) {
      setErr(e.message || t('errors.loadFailed'))
    }
  }

  const openPreview = async (tpl) => {
    setPreviewTpl(tpl)
    setPreviewSource('')
    setPreviewLoading(true)
    try {
      const detail = await getPluginApi(tpl.id)
      setPreviewSource(detail?.entryPreview?.content || '')
    } catch (e) {
      setErr(e.message || t('errors.loadFailed'))
    } finally {
      setPreviewLoading(false)
    }
  }

  const handleUseTemplate = async (tpl) => {
    try {
      let source = previewSource
      if (!source || previewTpl?.id !== tpl.id) {
        const detail = await getPluginApi(tpl.id)
        source = detail?.entryPreview?.content || ''
      }
      if (!source) throw new Error('template entry empty')
      await importWithRetry(source, tpl.name || 'Agent')
      setShowTemplates(false)
      await reload()
    } catch (e) {
      setErr(e.message || t('errors.loadFailed'))
    }
  }

  const handleExport = async (a) => {
    try {
      // 使用项目已有的 accountClient.getAuthToken() 最鲁棒
      const mod = await import('../lib/accountClient.js')
      const token = mod.getAuthToken?.() || ''
      const r = await fetch(exportAgentUrl(a.id), { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      if (!r.ok) throw new Error('export failed')
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${a.name}.agent.md`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setErr(e.message || t('errors.loadFailed'))
    }
  }

  // v0.9: 导出角色卡 zip (包含 memories)
  const handleExportZip = async (a) => {
    try {
      const mod = await import('../lib/accountClient.js')
      const token = mod.getAuthToken?.() || ''
      const r = await fetch(exportAgentZipUrl(a.id), { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      if (!r.ok) throw new Error('export failed')
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${a.name}.agent.zip`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setErr(e.message || t('errors.loadFailed'))
    }
  }

  // v0.9: 导入角色卡 zip
  const handleImportZip = async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.zip,application/zip'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        if (file.size > 10 * 1024 * 1024) throw new Error('zip > 10MB')
        try {
          const r = await importAgentZipApi(file)
          if (r.memoriesImported > 0) {
            setErr(`OK: imported ${r.memoriesImported} memories`)
          }
        } catch (e) {
          const msg = String(e?.message || '')
          if (/已存在同名/.test(msg) || /UNIQUE/i.test(msg)) {
            const next = window.prompt(t('agents.renameOnConflict'), 'imported-agent (copy)')
            if (next && next.trim()) {
              await importAgentZipApi(file, { overrideName: next.trim() })
            } else {
              throw e
            }
          } else {
            throw e
          }
        }
        await reload()
      } catch (e) {
        setErr(e.message || t('errors.loadFailed'))
      }
    }
    input.click()
  }

  return (
    <div className="flex h-screen bg-canvas">
      <LeftRail />
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-8 py-10">
          <header className="flex items-end justify-between mb-8 border-b border-ink/10 pb-6">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">{t('agents.title')}</h1>
              <p className="text-sm text-ink-fade mt-1">{t('agents.subtitle')}</p>
            </div>
            <button
              onClick={openTemplates}
              className="inline-flex items-center gap-2 px-3 py-2 border border-ink/15 rounded-md text-sm hover:bg-ink/5"
            >
              <Sparkles size={14} /> {t('agents.fromTemplate')}
            </button>
            <button
              onClick={handleImportZip}
              className="inline-flex items-center gap-2 px-3 py-2 border border-ink/15 rounded-md text-sm hover:bg-ink/5"
            >
              <Package size={14} /> {t('agents.importZip')}
            </button>
            <button
              onClick={handleImport}
              className="inline-flex items-center gap-2 px-3 py-2 border border-ink/15 rounded-md text-sm hover:bg-ink/5"
            >
              <Upload size={14} /> {t('agents.import')}
            </button>
            <button
              onClick={handleNew}
              className="inline-flex items-center gap-2 px-4 py-2 bg-ink text-canvas rounded-md text-sm hover:opacity-90"
            >
              <Plus size={16} /> {t('agents.newAgent')}
            </button>
          </header>

          {err && (
            <div className="mb-4 px-4 py-3 border border-red-400/30 bg-red-50/40 text-red-700 text-sm rounded">{err}</div>
          )}

          {loading ? (
            <div className="text-ink-fade py-12 text-center">{t('common.loading')}</div>
          ) : agents.length === 0 ? (
            <div className="text-ink-fade py-12 text-center">{t('agents.emptyHint')}</div>
          ) : (
            <ul className="divide-y divide-ink/10 border-y border-ink/10">
              {agents.map((a) => (
                <li key={a.id} className="flex items-center justify-between py-4 hover:bg-ink/5 px-2 -mx-2 rounded">
                  <button onClick={() => handleEdit(a)} className="flex-1 text-left">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{a.name}</span>
                      {a.isDefault && (
                        <span className="inline-flex items-center gap-1 text-xs text-amber-700 bg-amber-100/50 px-2 py-0.5 rounded">
                          <Star size={10} /> {t('agents.defaultBadge')}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-ink-fade mt-1 line-clamp-1">
                      {(a.soulMd || '').slice(0, 120) || t('agents.noSoul')}
                    </div>
                  </button>
                  <button
                    onClick={() => handleExport(a)}
                    className="ml-2 p-2 text-ink-fade hover:text-ink"
                    aria-label={t('agents.export')}
                    title=".agent.md"
                  >
                    <Download size={16} />
                  </button>
                  <button
                    onClick={() => handleExportZip(a)}
                    className="ml-1 p-2 text-ink-fade hover:text-ink"
                    aria-label={t('agents.exportZip')}
                    title={t('agents.exportZip')}
                  >
                    <Package size={16} />
                  </button>
                  <button
                    onClick={() => handleDelete(a)}
                    className="ml-2 p-2 text-ink-fade hover:text-red-600"
                    aria-label={t('common.delete')}
                  >
                    <Trash2 size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {editing && (
            <div className="fixed inset-0 z-30 bg-black/40 flex items-center justify-center p-6" onClick={() => setEditing(null)}>
              <div className="bg-canvas w-full max-w-3xl max-h-[88vh] rounded-lg shadow-xl flex flex-col" onClick={(e) => e.stopPropagation()}>
                <header className="flex items-center justify-between px-6 py-4 border-b border-ink/10">
                  <h2 className="text-lg font-semibold">
                    {editing.id ? t('agents.editTitle') : t('agents.newTitle')}
                  </h2>
                  <button onClick={() => setEditing(null)} className="text-ink-fade hover:text-ink"><X size={18} /></button>
                </header>
                <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
                  <div>
                    <label className="block text-xs font-medium text-ink-fade mb-1">{t('agents.fieldName')}</label>
                    <input
                      value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                      className="w-full px-3 py-2 border border-ink/15 rounded bg-canvas text-ink text-sm"
                      placeholder="Atelier"
                      maxLength={80}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-ink-fade mb-1">{t('agents.fieldSoul')}</label>
                    <textarea
                      value={editing.soulMd}
                      onChange={(e) => setEditing({ ...editing, soulMd: e.target.value })}
                      rows={10}
                      className="w-full px-3 py-2 border border-ink/15 rounded bg-canvas text-ink text-sm font-mono"
                      placeholder={t('agents.soulPlaceholder')}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-ink-fade mb-1">{t('agents.fieldIdentity')}</label>
                    <textarea
                      value={editing.identityMd}
                      onChange={(e) => setEditing({ ...editing, identityMd: e.target.value })}
                      rows={6}
                      className="w-full px-3 py-2 border border-ink/15 rounded bg-canvas text-ink text-sm font-mono"
                      placeholder={t('agents.identityPlaceholder')}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-ink-fade mb-1">{t('agents.fieldAvatar')}</label>
                    <input
                      value={editing.avatarUrl}
                      onChange={(e) => setEditing({ ...editing, avatarUrl: e.target.value })}
                      className="w-full px-3 py-2 border border-ink/15 rounded bg-canvas text-ink text-sm"
                      placeholder="https://..."
                      maxLength={1024}
                    />
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={editing.isDefault}
                      onChange={(e) => setEditing({ ...editing, isDefault: e.target.checked })}
                    />
                    <Star size={14} /> {t('agents.setAsDefault')}
                  </label>
                </div>
                <footer className="flex items-center justify-end gap-2 px-6 py-4 border-t border-ink/10">
                  <button
                    onClick={() => setEditing(null)}
                    className="px-4 py-2 text-sm text-ink-fade hover:text-ink"
                  >{t('common.cancel')}</button>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-ink text-canvas rounded text-sm disabled:opacity-50"
                  ><Save size={14} /> {saving ? t('common.saving') : t('common.save')}</button>
                </footer>
              </div>
            </div>
          )}
          {showTemplates && (
            <div
              className="fixed inset-0 bg-ink/30 flex items-center justify-center z-50"
              onClick={() => setShowTemplates(false)}
            >
              <div
                className="bg-canvas rounded-lg shadow-2xl w-full max-w-4xl max-h-[85vh] overflow-hidden flex flex-col"
                onClick={(e) => e.stopPropagation()}
              >
                <header className="flex items-center justify-between px-6 py-4 border-b border-ink/10">
                  <h2 className="text-base font-medium">{t('agents.templatesTitle')}</h2>
                  <button onClick={() => setShowTemplates(false)} className="p-1 text-ink-fade hover:text-ink"><X size={16} /></button>
                </header>
                <div className="flex-1 overflow-hidden flex min-h-0">
                  <div className="w-64 shrink-0 border-r border-ink/10 overflow-y-auto">
                    {templates.length === 0 ? (
                      <p className="text-sm text-ink-fade p-4">{t('agents.templatesEmpty')}</p>
                    ) : (
                      <ul className="divide-y divide-ink/10">
                        {templates.map((tpl) => (
                          <li
                            key={tpl.id}
                            onClick={() => openPreview(tpl)}
                            className={`px-4 py-3 cursor-pointer hover:bg-ink/5 ${previewTpl?.id === tpl.id ? 'bg-ink/5' : ''}`}
                          >
                            <div className="font-medium text-sm">{tpl.name}</div>
                            <div className="text-xs text-ink-fade mt-0.5 line-clamp-2">{tpl.description}</div>
                            <div className="font-mono text-[10px] text-ink-fade mt-1">{tpl.id} v{tpl.version}</div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="flex-1 overflow-y-auto px-6 py-4 min-w-0">
                    {!previewTpl ? (
                      <p className="text-sm text-ink-fade">{t('agents.templatesHint')}</p>
                    ) : previewLoading ? (
                      <p className="text-sm text-ink-fade">{t('common.loading')}</p>
                    ) : (
                      <pre className="text-xs leading-relaxed whitespace-pre-wrap font-mono text-ink">
{previewSource}
                      </pre>
                    )}
                  </div>
                </div>
                {previewTpl && (
                  <footer className="flex items-center justify-end gap-2 px-6 py-3 border-t border-ink/10">
                    <button
                      onClick={() => setShowTemplates(false)}
                      className="px-4 py-2 text-sm text-ink-fade hover:text-ink"
                    >{t('common.cancel')}</button>
                    <button
                      onClick={() => handleUseTemplate(previewTpl)}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-ink text-canvas rounded text-sm hover:opacity-90"
                    >
                      <Sparkles size={14} /> {t('agents.useThis')}
                    </button>
                  </footer>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
