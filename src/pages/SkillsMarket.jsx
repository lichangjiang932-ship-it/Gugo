import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '../lib/router.jsx'
import { Plus, Search, Upload, X, Package, GitBranch as Github } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import { SKILLS } from '../data.js'
import { useAppContext } from '../store/AppContext'
import { importSkillPack, listSkills, importSkillFromGithubUrl } from '../lib/skillClient.js'
import { listPluginsApi, installPluginAsSkillApi } from '../lib/pluginClient.js'
import { getSkillIcon } from '../lib/skillIcons.js'
import { useToast } from '../components/Toast.jsx'
import { useT } from '../i18n/I18nProvider.jsx'
import { listLocalSkills, mergeRuntimeSkills, saveLocalSkills } from '../lib/localSkills.js'
import { getOfficialSkillPreset } from '../lib/skillPresets.js'
import { getPresentedSkill } from '../lib/skillPresentation.js'

export default function SkillsMarket() {
  const navigate = useNavigate()
  const { dispatch } = useAppContext()
  const toast = useToast()
  const { t, lang } = useT()
  const [query, setQuery] = useState('')
  const [activeFilter, setActiveFilter] = useState('全部')
  const [customSkills, setCustomSkills] = useState(() => listLocalSkills())
  const [runtimeSkills, setRuntimeSkills] = useState(SKILLS)
  const [showModal, setShowModal] = useState(false)
  const [draft, setDraft] = useState({ id: '', name: '', desc: '', systemPrompt: '', icon: '*', perms: '' })
  const [draftError, setDraftError] = useState('')
  const [importFiles, setImportFiles] = useState(null)
  const [importPreview, setImportPreview] = useState(null)
  const [importError, setImportError] = useState('')
  const [importing, setImporting] = useState(false)
  const [showGithubPanel, setShowGithubPanel] = useState(false)
  const [githubUrl, setGithubUrl] = useState('')
  const [githubInstalling, setGithubInstalling] = useState(false)
  const [githubError, setGithubError] = useState('')
  const [githubSuccess, setGithubSuccess] = useState(null)
  const [showPluginPanel, setShowPluginPanel] = useState(false)
  const [pluginBundles, setPluginBundles] = useState([])
  const [pluginPanelLoading, setPluginPanelLoading] = useState(false)
  const [pluginPanelError, setPluginPanelError] = useState('')
  const [installingPluginId, setInstallingPluginId] = useState(null)
  const [selectedSkill, setSelectedSkill] = useState(null)
  const searchRef = useRef(null)
  const folderInputRef = useRef(null)

  const allSkills = useMemo(
    () => mergeRuntimeSkills(customSkills, runtimeSkills).map((skill) => getPresentedSkill(skill, lang)),
    [customSkills, runtimeSkills, lang],
  )

  useEffect(() => {
    let active = true
    listSkills()
      .then(({ skills }) => {
        if (active && Array.isArray(skills) && skills.length) setRuntimeSkills(skills)
      })
      .catch((err) => {
        console.warn('[SkillsMarket] 无法加载远程技能:', err?.message || err)
        if (active) setRuntimeSkills(SKILLS)
      })
    return () => {
      active = false
    }
  }, [])

  const permCounts = useMemo(() => {
    const acc = {}
    allSkills.forEach((skill) => {
      skill.perms?.forEach((perm) => {
        acc[perm] = (acc[perm] || 0) + 1
      })
    })
    return acc
  }, [allSkills])

  const filterDefs = useMemo(
    () => [
      { key: '全部', label: '全部', count: allSkills.length },
      ...Object.entries(permCounts).map(([name, count]) => ({ key: name, label: name, count })),
      { key: '推荐', label: '推荐', count: allSkills.filter((s) => s.recommended).length },
      ...(customSkills.length ? [{ key: '自定义', label: '自定义', count: customSkills.length }] : []),
    ],
    [allSkills, permCounts, customSkills.length]
  )

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
      }
      if (e.key === 'Escape') {
        if (selectedSkill) setSelectedSkill(null)
        else if (showModal) setShowModal(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedSkill, showModal])

  const filteredSkills = allSkills.filter((skill) => {
    const text = `${skill.id} ${skill.name} ${skill.desc} ${skill.pluginName || ''} ${skill.publisher || ''} ${skill.license || ''} ${(skill.perms || []).join(' ')}`
    const matchesSearch = !query.trim() || text.toLowerCase().includes(query.trim().toLowerCase())
    const matchesFilter =
      activeFilter === '全部'
        ? true
        : activeFilter === '推荐'
        ? skill.recommended
        : activeFilter === '自定义'
        ? skill.custom
        : skill.perms?.includes(activeFilter)
    return matchesSearch && matchesFilter
  }).sort((left, right) => Number(Boolean(right.recommended)) - Number(Boolean(left.recommended))
    || String(left.name || left.id).localeCompare(String(right.name || right.id)))

  const handleSkillClick = (skill) => {
    setSelectedSkill(skill)
  }

  const handleUseSkill = (skill) => {
    if (skill?.runnable === false) return
    dispatch({ type: 'SET_DRAFT_INPUT', payload: `/${skill.id} ` })
    setSelectedSkill(null)
    navigate('/chat')
  }

  const handleCreateCustom = () => {
    setDraft({ id: '', name: '', desc: '', systemPrompt: '', icon: '*', perms: '' })
    setDraftError('')
    setShowModal(true)
  }

  const handleSaveCustom = () => {
    const id = draft.id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
    const name = draft.name.trim()
    const systemPrompt = draft.systemPrompt.trim()
    if (!id || !name || !systemPrompt) {
      setDraftError('请填写技能 ID、名称和技能指令。')
      return
    }
    if (allSkills.some((s) => s.id === id)) {
      setDraftError(`技能 ID "${id}" 已存在。`)
      return
    }
    const next = [
      {
        id,
        name,
        desc: draft.desc.trim() || '自定义技能',
        systemPrompt,
        icon: draft.icon.trim() || '*',
        perms: draft.perms.split(',').map((s) => s.trim()).filter(Boolean),
        recommended: false,
        custom: true,
        localCustom: true,
      },
      ...customSkills,
    ]
    setCustomSkills(next)
    saveLocalSkills(next)
    setShowModal(false)
    setDraftError('')
  }

  const handleDeleteCustom = (e, id) => {
    e.stopPropagation()
    if (!confirm(`删除自定义技能 "${id}"？`)) return
    const next = customSkills.filter((s) => s.id !== id)
    setCustomSkills(next)
    saveLocalSkills(next)
  }

  const handleFolderSelected = async (event) => {
    const files = [...(event.target.files || [])]
    event.target.value = ''
    if (!files.length) return
    const nextFiles = {}
    for (const file of files) {
      const parts = (file.webkitRelativePath || file.name).split('/').filter(Boolean)
      const relativePath = parts.length > 1 ? parts.slice(1).join('/') : file.name
      nextFiles[relativePath] = await file.text()
    }
    setImportFiles(nextFiles)
    try {
      const manifest = JSON.parse(nextFiles['skill.json'] || '{}')
      if (!nextFiles['prompts/system.md']) throw new Error('缺少 prompts/system.md')
      setImportPreview({
        ...manifest,
        promptPreview: nextFiles['prompts/system.md'].slice(0, 180),
      })
      setImportError('')
    } catch (err) {
      setImportPreview(null)
      setImportError(err.message || '技能包读取失败')
    }
  }

  const handleConfirmImport = async () => {
    if (!importFiles) return
    setImporting(true)
    setImportError('')
    try {
      await importSkillPack(importFiles)
      const { skills } = await listSkills()
      setRuntimeSkills(skills)
      setImportFiles(null)
      setImportPreview(null)
    } catch (err) {
      setImportError(err.message)
      toast.error({ title: t('toast.importFailed'), body: err.message })
    } finally {
      setImporting(false)
    }
  }

  const handleConfirmGithubImport = async () => {
    if (!githubUrl.trim()) {
      setGithubError('请输入 GitHub 仓库 URL')
      return
    }
    setGithubInstalling(true)
    setGithubError('')
    setGithubSuccess(null)
    try {
      const res = await importSkillFromGithubUrl(githubUrl.trim())
      if (!res?.skill) throw new Error(res?.error || '安装失败')
      try {
        const { skills } = await listSkills()
        if (Array.isArray(skills)) setRuntimeSkills(skills)
      } catch { /* 列表刷新失败不阻断 */ }
      setGithubSuccess({
        name: res.skill?.name || res.skill?.id,
        source: res.source,
        repo: res.repo,
      })
      setGithubUrl('')
    } catch (err) {
      setGithubError(err.message || '安装失败')
      toast.error({ title: t('toast.installFailed'), body: err.message || '安装失败' })
    } finally {
      setGithubInstalling(false)
    }
  }

  const openGithubImport = (presetId = null) => {
    const preset = presetId ? getOfficialSkillPreset(presetId) : null
    setGithubUrl(preset?.url || '')
    setGithubError('')
    setGithubSuccess(null)
    setShowGithubPanel(true)
  }

  const openPluginPanel = async () => {
    setPluginPanelError('')
    setShowPluginPanel(true)
    setPluginPanelLoading(true)
    try {
      const { plugins } = await listPluginsApi({ type: 'skill-bundle' })
      setPluginBundles(Array.isArray(plugins) ? plugins : [])
    } catch (e) {
      setPluginPanelError(e?.message || '无法加载 plugin')
      setPluginBundles([])
    } finally {
      setPluginPanelLoading(false)
    }
  }

  const handleInstallPluginAsSkill = async (pluginId) => {
    setPluginPanelError('')
    setInstallingPluginId(pluginId)
    try {
      const res = await installPluginAsSkillApi(pluginId)
      if (!res?.ok || !res.skill) {
        throw new Error(res?.error || '安装失败')
      }
      try {
        const { skills } = await listSkills()
        if (Array.isArray(skills) && skills.length) setRuntimeSkills(skills)
      } catch { /* 列表刷新失败不阻断安装反馈 */ }
      setShowPluginPanel(false)
    } catch (e) {
      setPluginPanelError(e?.message || '安装失败')
      toast.error({ title: t('toast.installFailed'), body: e?.message || '安装失败' })
    } finally {
      setInstallingPluginId(null)
    }
  }

  return (
    <div className="h-screen flex bg-paper overflow-hidden">
      <LeftRail />

      <main className="flex-1 p-8 overflow-y-auto">
        <div className="flex items-end justify-between mb-6 gap-4">
          <div>
            <h1 className="font-hand text-[30px] text-ink">技能库</h1>
          </div>
          <div className="flex gap-2">
            <input
              ref={folderInputRef}
              type="file"
              webkitdirectory=""
              directory=""
              multiple
              className="hidden"
              onChange={handleFolderSelected}
            />
            <div className="h-9 px-3.5 border border-ink/70 rounded-md flex items-center gap-1.5 bg-paper">
              <Search className="w-4 h-4 text-ink-fade" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索技能 · Ctrl K"
                className="bg-transparent text-sm text-ink outline-none placeholder:text-ink-soft w-40"
              />
            </div>
            <button
              onClick={() => folderInputRef.current?.click()}
              className="h-9 px-4 border border-ink/70 rounded-md font-hand text-sm flex items-center gap-1.5 hover:bg-paper-2 transition-colors"
            >
              <Upload className="w-4 h-4" />
              导入技能包
            </button>
            <button
              onClick={openPluginPanel}
              className="h-9 px-4 border border-ink/70 rounded-md font-hand text-sm flex items-center gap-1.5 hover:bg-paper-2 transition-colors"
              title="从 Plugin 安装为 Skill"
            >
              <Package className="w-4 h-4" />
              从 Plugin
            </button>
            <button
              onClick={() => openGithubImport('gsap')}
              className="h-9 px-4 border border-ink/70 rounded-md font-hand text-sm flex items-center gap-1.5 hover:bg-paper-2 transition-colors"
              title="greensock/gsap-skills"
            >
              <Github className="w-4 h-4" />
              GSAP
            </button>
            <button
              onClick={() => openGithubImport()}
              className="h-9 px-4 border border-ink/70 rounded-md font-hand text-sm flex items-center gap-1.5 hover:bg-paper-2 transition-colors"
              title="从 GitHub 仓库 URL 拉取技能"
            >
              <Github className="w-4 h-4" />
              从 GitHub
            </button>
            <button
              onClick={handleCreateCustom}
              className="h-9 px-4 bg-ember text-paper rounded-md font-hand text-sm flex items-center gap-1.5 hover:bg-ember/90 transition-colors"
            >
              <Plus className="w-4 h-4" />
              自定义
            </button>
          </div>
        </div>

        <div className="flex gap-2 mb-5 flex-wrap">
          {filterDefs.map((f) => (
            <button
              key={f.key}
              onClick={() => setActiveFilter(f.key)}
              className={`inline-flex items-center h-[26px] px-3 rounded-full text-xs border transition-colors ${
                activeFilter === f.key ? 'bg-ink text-paper border-ink' : 'border-ink-fade/60 text-ink-soft hover:border-ink-fade'
              }`}
            >
              {f.label} · {f.count}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5">
          {filteredSkills.map((skill) => (
            <button
              key={skill.id}
              data-skill-id={skill.id}
              onClick={() => handleSkillClick(skill)}
              className={`relative p-4 border rounded-md text-left flex flex-col gap-2.5 hover:shadow-md transition-shadow ${
                skill.custom ? 'border-ink/40 border-dashed bg-paper-2' : 'border-ink/30 hover:border-ink/60'
              }`}
            >
              {skill.localCustom && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => handleDeleteCustom(e, skill.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') handleDeleteCustom(e, skill.id)
                  }}
                  className="absolute top-2 right-2 w-5 h-5 rounded-full hover:bg-ink/10 flex items-center justify-center text-ink-fade hover:text-ink"
                  title="删除自定义技能"
                >
                  <X className="w-3 h-3" />
                </span>
              )}
              <div className="flex items-start justify-between gap-2">
                <div className="w-9 h-9 rounded-lg border border-ink-fade/60 flex items-center justify-center bg-paper">
                  {(() => {
                    const Icon = getSkillIcon(skill.id)
                    return <Icon className="w-5 h-5 text-ink-fade" />
                  })()}
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1">
                  {skill.compatibility && (
                    <span className="font-mono text-[9px] tracking-wider text-ink-fade">
                      {t(`skillsMarket.compatibility.${skill.compatibility}`)}
                    </span>
                  )}
                </div>
                {skill.custom && <span className="font-mono text-[9px] tracking-wider text-ink-fade">{skill.imported ? '已导入' : '自定义'}</span>}
              </div>
              <div>
                <div className="font-hand text-[17px] leading-tight text-ink">{skill.name}</div>
                <div className="text-sm text-ink-soft mt-0.5">{skill.desc}</div>
              </div>
              <div className="flex flex-wrap gap-1 mt-auto">
                {(skill.perms || []).map((p) => (
                  <span key={p} className="font-mono text-[9px] tracking-wider text-ink-fade">· {p}</span>
                ))}
              </div>
            </button>
          ))}
          {filteredSkills.length === 0 && (
            <div className="col-span-full text-center py-16 text-ink-fade text-sm">没有找到匹配的技能</div>
          )}
        </div>
      </main>

      {selectedSkill && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
          onClick={() => setSelectedSkill(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="skill-detail-title"
            className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-ink/30 bg-paper shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-ink/15 px-5 py-4">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-ink-fade/50 bg-paper-2">
                  {(() => {
                    const Icon = getSkillIcon(selectedSkill.id)
                    return <Icon className="h-5 w-5 text-ink-soft" />
                  })()}
                </div>
                <div className="min-w-0">
                  <h2 id="skill-detail-title" className="truncate font-hand text-xl text-ink">{selectedSkill.name}</h2>
                  <div className="font-mono text-[10px] text-ink-fade">/{selectedSkill.id}</div>
                  {selectedSkill.compatibility && (
                    <div className="font-mono text-[10px] text-ink-fade">
                      {t(`skillsMarket.compatibility.${selectedSkill.compatibility}`)}
                    </div>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedSkill(null)}
                className="rounded-md p-1 text-ink-fade hover:bg-paper-2 hover:text-ink"
                aria-label={t('nav.skillDetails')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4 text-sm">
              <p className="leading-6 text-ink-soft">{selectedSkill.desc}</p>
              {selectedSkill.runnable === false && (
                <div className="rounded-md border border-ember-line bg-ember-soft/30 p-3 text-xs leading-5 text-ember">
                  {t('skillsMarket.incompatibleHint')}
                </div>
              )}
              {selectedSkill.codexPlugin && (
                <div>
                  <div className="mb-2 text-xs font-medium text-ink">{t('skillsMarket.pluginSource')}</div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-md border border-ink/15 bg-paper-2 p-3 text-xs">
                    <dt className="text-ink-fade">{t('skillsMarket.plugin')}</dt>
                    <dd className="min-w-0 break-words text-ink-soft">{selectedSkill.pluginName || selectedSkill.pluginId}</dd>
                    {selectedSkill.publisher && (
                      <>
                        <dt className="text-ink-fade">{t('skillsMarket.publisher')}</dt>
                        <dd className="min-w-0 break-words text-ink-soft">{selectedSkill.publisher}</dd>
                      </>
                    )}
                    {selectedSkill.license && (
                      <>
                        <dt className="text-ink-fade">{t('skillsMarket.license')}</dt>
                        <dd className="min-w-0 break-words text-ink-soft">{selectedSkill.license}</dd>
                      </>
                    )}
                    {selectedSkill.source?.rootName && (
                      <>
                        <dt className="text-ink-fade">{t('skillsMarket.localSource')}</dt>
                        <dd className="min-w-0 break-words font-mono text-ink-soft">{selectedSkill.source.rootName}</dd>
                      </>
                    )}
                    {selectedSkill.repository && (
                      <>
                        <dt className="text-ink-fade">GitHub</dt>
                        <dd className="min-w-0 break-all">
                          <a
                            href={selectedSkill.repository}
                            target="_blank"
                            rel="noreferrer"
                            className="text-ember underline decoration-ember/40 underline-offset-2"
                          >
                            {selectedSkill.repository}
                          </a>
                        </dd>
                      </>
                    )}
                  </dl>
                </div>
              )}
              {(selectedSkill.perms || []).length > 0 && (
                <div>
                  <div className="mb-2 text-xs font-medium text-ink">{t('nav.permissions')}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedSkill.perms.map((permission) => (
                      <span key={permission} className="rounded-full border border-ink-fade/40 px-2 py-1 text-[11px] text-ink-soft">{permission}</span>
                    ))}
                  </div>
                </div>
              )}
              {selectedSkill.systemPrompt && (
                <div>
                  <div className="mb-2 text-xs font-medium text-ink">{t('nav.skillInstructions')}</div>
                  <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-ink/15 bg-paper-2 p-3 text-xs leading-5 text-ink-soft">
                    {selectedSkill.systemPrompt}
                  </div>
                </div>
              )}
            </div>
            <div className="flex justify-end border-t border-ink/15 px-5 py-4">
              <button
                type="button"
                onClick={() => handleUseSkill(selectedSkill)}
                disabled={selectedSkill.runnable === false}
                className="h-9 rounded-md bg-ink px-4 text-sm text-paper transition-colors hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-40"
              >
                {selectedSkill.runnable === false ? t('skillsMarket.unavailable') : t('nav.useSkill')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-ink/40 flex items-center justify-center z-50 p-4" onClick={() => setShowModal(false)}>
          <div className="bg-paper border border-ink rounded-md p-6 w-full max-w-md flex flex-col gap-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="font-hand text-xl text-ink">新建自定义技能</h2>
              <button onClick={() => setShowModal(false)} className="text-ink-fade hover:text-ink">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex flex-col gap-3 text-sm">
              <label className="flex flex-col gap-1">
                <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">ID · 命令名</span>
                <input
                  value={draft.id}
                  onChange={(e) => {
                    setDraft({ ...draft, id: e.target.value })
                    setDraftError('')
                  }}
                  placeholder="my-skill"
                  className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember"
                />
              </label>
              <div className="grid grid-cols-[1fr_60px] gap-2">
                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">名称</span>
                  <input
                    value={draft.name}
                    onChange={(e) => {
                      setDraft({ ...draft, name: e.target.value })
                      setDraftError('')
                    }}
                    placeholder="我的技能"
                    className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">图标</span>
                  <input
                    value={draft.icon}
                    onChange={(e) => setDraft({ ...draft, icon: e.target.value })}
                    maxLength={2}
                    className="h-9 px-2 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-center text-lg"
                  />
                </label>
              </div>
              <label className="flex flex-col gap-1">
                <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">描述</span>
                <textarea
                  value={draft.desc}
                  onChange={(e) => setDraft({ ...draft, desc: e.target.value })}
                  rows={2}
                  placeholder="一句话说明这个技能"
                  className="px-3 py-2 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember resize-none"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">技能指令</span>
                <textarea
                  value={draft.systemPrompt}
                  onChange={(e) => {
                    setDraft({ ...draft, systemPrompt: e.target.value })
                    setDraftError('')
                  }}
                  rows={5}
                  placeholder="说明模型应如何工作、输出什么，以及必须遵守的约束"
                  className="px-3 py-2 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember resize-y"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">权限，逗号分隔</span>
                <input
                  value={draft.perms}
                  onChange={(e) => setDraft({ ...draft, perms: e.target.value })}
                  placeholder="内容生成, 内容分析"
                  className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember"
                />
              </label>
            </div>

            {draftError && <div className="p-2 border border-ember-line bg-ember-soft/30 rounded-md text-sm text-ember">{draftError}</div>}

            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowModal(false)} className="h-9 px-4 border border-ink/40 rounded-md font-hand text-sm text-ink-soft hover:border-ink">
                取消
              </button>
              <button
                onClick={handleSaveCustom}
                disabled={!draft.id.trim() || !draft.name.trim() || !draft.systemPrompt.trim()}
                className="h-9 px-4 bg-ember text-paper rounded-md font-hand text-sm hover:bg-ember/90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {(importPreview || importError) && (
        <div className="fixed inset-0 bg-ink/40 flex items-center justify-center z-50 p-4" onClick={() => {
          setImportPreview(null)
          setImportError('')
          setImportFiles(null)
        }}>
          <div className="bg-paper border border-ink rounded-md p-6 w-full max-w-lg flex flex-col gap-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="font-hand text-xl text-ink">导入技能包</h2>
              <button onClick={() => {
                setImportPreview(null)
                setImportError('')
                setImportFiles(null)
              }} className="text-ink-fade hover:text-ink">
                <X className="w-4 h-4" />
              </button>
            </div>

            {importError ? (
              <div className="p-3 border border-ember-line bg-ember-soft/30 rounded-md text-sm text-ember">{importError}</div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-ink-fade">ID</p>
                    <p className="text-ink">{importPreview?.id}</p>
                  </div>
                  <div>
                    <p className="text-ink-fade">版本</p>
                    <p className="text-ink">{importPreview?.version}</p>
                  </div>
                  <div className="col-span-2">
                    <p className="text-ink-fade">名称</p>
                    <p className="text-ink">{importPreview?.name}</p>
                  </div>
                  <div className="col-span-2">
                    <p className="text-ink-fade">说明</p>
                    <p className="text-ink">{importPreview?.description}</p>
                  </div>
                </div>
                <div className="rounded-md border border-dashed border-ink-fade/40 p-3">
                  <p className="text-xs text-ink-fade mb-1">提示词预览</p>
                  <p className="text-sm text-ink-soft whitespace-pre-wrap">{importPreview?.promptPreview}</p>
                </div>
              </>
            )}

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => {
                  setImportPreview(null)
                  setImportError('')
                  setImportFiles(null)
                }}
                className="h-9 px-4 border border-ink/40 rounded-md font-hand text-sm text-ink-soft hover:border-ink"
              >
                取消
              </button>
              {!importError && (
                <button
                  onClick={handleConfirmImport}
                  disabled={importing}
                  className="h-9 px-4 bg-ember text-paper rounded-md font-hand text-sm hover:bg-ember/90 disabled:opacity-40"
                >
                  {importing ? '导入中…' : '确认导入'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {showGithubPanel && (
        <div
          className="fixed inset-0 bg-ink/40 flex items-center justify-center z-50 p-4"
          onClick={() => !githubInstalling && setShowGithubPanel(false)}
        >
          <div
            className="bg-paper border border-ink/30 rounded-lg max-w-xl w-full overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 border-b border-ink-line flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Github className="w-4 h-4 text-ink-soft" />
                <h2 className="font-hand text-xl text-ink">从 GitHub 导入技能</h2>
              </div>
              <button
                onClick={() => !githubInstalling && setShowGithubPanel(false)}
                className="p-1 rounded hover:bg-paper-2"
                aria-label="关闭"
              >
                <X className="w-4 h-4 text-ink-soft" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-sm text-ink-soft leading-relaxed">
                粘贴一个 <code className="font-mono text-xs text-ink">github.com/owner/repo</code> 的 URL，
                可包含 <code className="font-mono text-xs text-ink">/tree/&lt;branch&gt;/&lt;subpath&gt;</code>。
                自动识别：<br />
                <span className="text-xs">①&nbsp;yma 原生：<code className="font-mono">skill.json + prompts/system.md</code></span><br />
                <span className="text-xs">②&nbsp;openhanako 风格：<code className="font-mono">SKILL.md</code>（YAML frontmatter）</span>
              </p>
              <input
                type="url"
                value={githubUrl}
                onChange={(e) => setGithubUrl(e.target.value)}
                placeholder="https://github.com/owner/repo 或 .../tree/main/skills/foo"
                className="w-full px-3 py-2 border border-ink-line rounded-md text-sm text-ink bg-paper outline-none focus:border-ink/70 font-mono"
                disabled={githubInstalling}
                onKeyDown={(e) => { if (e.key === 'Enter' && !githubInstalling) handleConfirmGithubImport() }}
              />
              {githubError && (
                <div className="p-3 border border-ember-line bg-ember-soft/30 rounded-md text-sm text-ember">
                  {githubError}
                </div>
              )}
              {githubSuccess && (
                <div className="p-3 border border-ink-line bg-paper-2/50 rounded-md text-sm text-ink">
                  ✓ 已安装：<span className="font-medium">{githubSuccess.name}</span>
                  <span className="ml-2 text-ink-soft font-mono text-xs">
                    [{githubSuccess.source} · {githubSuccess.repo}]
                  </span>
                </div>
              )}
            </div>
            <div className="p-5 pt-0 flex items-center justify-end gap-2">
              <button
                onClick={() => !githubInstalling && setShowGithubPanel(false)}
                disabled={githubInstalling}
                className="h-9 px-4 border border-ink/40 rounded-md font-hand text-sm hover:bg-paper-2 disabled:opacity-50"
              >
                关闭
              </button>
              <button
                onClick={handleConfirmGithubImport}
                disabled={githubInstalling || !githubUrl.trim()}
                className="h-9 px-4 bg-ember text-paper rounded-md font-hand text-sm hover:bg-ember/90 disabled:opacity-50"
              >
                {githubInstalling ? '拉取中…' : '拉取并安装'}
              </button>
            </div>
          </div>
        </div>
      )}
      {showPluginPanel && (
        <div
          className="fixed inset-0 bg-ink/40 flex items-center justify-center z-50 p-4"
          onClick={() => setShowPluginPanel(false)}
        >
          <div
            className="bg-paper border border-ink/30 rounded-lg max-w-2xl w-full max-h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-ink/20">
              <div className="flex items-center gap-2">
                <Package className="w-4 h-4" />
                <h2 className="font-hand text-base">从 Plugin 安装为 Skill</h2>
              </div>
              <button onClick={() => setShowPluginPanel(false)} className="text-ink-fade hover:text-ink">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-5">
              {pluginPanelLoading && <div className="text-sm text-ink-soft">加载中...</div>}
              {pluginPanelError && (
                <div className="mb-3 p-2 border border-ember-line bg-ember-soft/30 rounded-md text-sm text-ember">
                  {pluginPanelError}
                </div>
              )}
              {!pluginPanelLoading && !pluginBundles.length && !pluginPanelError && (
                <div className="text-sm text-ink-soft">
                  未发现 type=skill-bundle 的 plugin。可在 <code className="font-mono text-xs">plugins/</code> 目录下放含 <code className="font-mono text-xs">skill.json</code> + <code className="font-mono text-xs">prompts/system.md</code> 的 plugin。
                </div>
              )}
              {pluginBundles.length > 0 && (
                <ul className="divide-y divide-ink/10">
                  {pluginBundles.map((p) => (
                    <li key={p.id} className="py-3 flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="font-medium text-sm flex items-center gap-2">
                          {p.name}
                          <span className="text-xs text-ink-fade font-mono">v{p.version}</span>
                        </div>
                        <div className="text-xs text-ink-fade font-mono mt-0.5">{p.id}</div>
                        {p.description && (
                          <div className="text-xs text-ink-soft mt-1 line-clamp-2">{p.description}</div>
                        )}
                      </div>
                      <button
                        onClick={() => handleInstallPluginAsSkill(p.id)}
                        disabled={installingPluginId === p.id}
                        className="shrink-0 h-8 px-3 bg-ink text-paper rounded-md text-xs font-hand hover:bg-ink/90 disabled:opacity-50 disabled:cursor-wait"
                      >
                        {installingPluginId === p.id ? '安装中...' : '安装'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
