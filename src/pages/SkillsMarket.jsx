import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Search, Sparkles, Upload, X } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import { SKILLS } from '../data.js'
import { useAppContext } from '../store/AppContext'
import { importSkillPack, listSkills } from '../lib/skillClient.js'

const CUSTOM_KEY = 'your-model-atelier:custom-skills:v1'

function loadCustomSkills() {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(CUSTOM_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveCustomSkills(skills) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(CUSTOM_KEY, JSON.stringify(skills))
}

export default function SkillsMarket() {
  const navigate = useNavigate()
  const { dispatch } = useAppContext()
  const [query, setQuery] = useState('')
  const [activeFilter, setActiveFilter] = useState('全部')
  const [customSkills, setCustomSkills] = useState(() => loadCustomSkills())
  const [runtimeSkills, setRuntimeSkills] = useState(SKILLS)
  const [showModal, setShowModal] = useState(false)
  const [draft, setDraft] = useState({ id: '', name: '', desc: '', icon: '*', perms: '' })
  const [draftError, setDraftError] = useState('')
  const [importFiles, setImportFiles] = useState(null)
  const [importPreview, setImportPreview] = useState(null)
  const [importError, setImportError] = useState('')
  const [importing, setImporting] = useState(false)
  const searchRef = useRef(null)
  const folderInputRef = useRef(null)

  const allSkills = useMemo(() => [...customSkills, ...runtimeSkills], [customSkills, runtimeSkills])

  useEffect(() => {
    let active = true
    listSkills()
      .then(({ skills }) => {
        if (active && Array.isArray(skills) && skills.length) setRuntimeSkills(skills)
      })
      .catch(() => {
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
      if (e.key === 'Escape' && showModal) {
        setShowModal(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showModal])

  const filteredSkills = allSkills.filter((skill) => {
    const text = `${skill.id} ${skill.name} ${skill.desc} ${(skill.perms || []).join(' ')}`
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
  })

  const handleSkillClick = (skill) => {
    dispatch({ type: 'SET_DRAFT_INPUT', payload: `/${skill.id} ` })
    navigate('/chat')
  }

  const handleCreateCustom = () => {
    setDraft({ id: '', name: '', desc: '', icon: '*', perms: '' })
    setDraftError('')
    setShowModal(true)
  }

  const handleSaveCustom = () => {
    const id = draft.id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
    const name = draft.name.trim()
    if (!id || !name) {
      setDraftError('请填写技能 ID 和名称。')
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
        icon: draft.icon.trim() || '*',
        perms: draft.perms.split(',').map((s) => s.trim()).filter(Boolean),
        recommended: false,
        custom: true,
        localCustom: true,
      },
      ...customSkills,
    ]
    setCustomSkills(next)
    saveCustomSkills(next)
    setShowModal(false)
    setDraftError('')
  }

  const handleDeleteCustom = (e, id) => {
    e.stopPropagation()
    if (!confirm(`删除自定义技能 "${id}"？`)) return
    const next = customSkills.filter((s) => s.id !== id)
    setCustomSkills(next)
    saveCustomSkills(next)
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
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="h-screen flex bg-paper overflow-hidden">
      <LeftRail />

      <main className="flex-1 p-8 overflow-y-auto">
        <div className="flex items-end justify-between mb-6 gap-4">
          <div>
            <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">SKILLS · ATELIER</span>
            <h1 className="font-hand text-[30px] text-ink mt-1.5">
              技能库 <span className="font-display italic text-[26px] opacity-70"> / your toolkit.</span>
            </h1>
            <p className="font-hand text-base text-ink-soft mt-1">点击技能会把 /命令 写入聊天输入框。</p>
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
              onClick={() => handleSkillClick(skill)}
              className={`relative p-4 border rounded-md text-left flex flex-col gap-2.5 hover:shadow-md transition-shadow ${
                skill.recommended ? 'border-ember bg-ember-soft' : skill.custom ? 'border-ink/40 border-dashed bg-paper-2' : 'border-ink/30 hover:border-ink/60'
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
                  <span className="text-xl">{skill.icon}</span>
                </div>
                {skill.recommended && (
                  <span className="font-mono text-[9px] tracking-wider text-ember flex items-center gap-1">
                    <Sparkles className="w-3 h-3" /> 推荐
                  </span>
                )}
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
                disabled={!draft.id.trim() || !draft.name.trim()}
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
    </div>
  )
}
