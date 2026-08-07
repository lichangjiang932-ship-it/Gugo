import { useEffect, useMemo, useRef, useState } from 'react'
import { SKILLS } from '../../data.js'
import { importSkillPack, importSkillFromGithubUrl, listSkills } from '../../lib/skillClient.js'
import { installPluginAsSkillApi, listPluginsApi } from '../../lib/pluginClient.js'
import { listLocalSkills, mergeRuntimeSkills, saveLocalSkills } from '../../lib/localSkills.js'
import { getOfficialSkillPreset } from '../../lib/skillPresets.js'
import { presentSkillCollection } from '../../lib/skillPresentation.js'

const FILTER_ALL = 'all'
const FILTER_RECOMMENDED = 'recommended'
const FILTER_CUSTOM = 'custom'
const EMPTY_DRAFT = { id: '', name: '', desc: '', systemPrompt: '', icon: '*', perms: '' }

export function useSkillsMarket({ lang, t, toast, onUseSkill }) {
  const [query, setQuery] = useState('')
  const [activeFilter, setActiveFilter] = useState(FILTER_ALL)
  const [customSkills, setCustomSkills] = useState(() => listLocalSkills())
  const [runtimeSkills, setRuntimeSkills] = useState(SKILLS)
  const [selectedSkill, setSelectedSkill] = useState(null)
  const [customModal, setCustomModal] = useState(false)
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  const [draftError, setDraftError] = useState('')
  const [importState, setImportState] = useState({ files: null, preview: null, error: '', busy: false })
  const [githubState, setGithubState] = useState({ open: false, url: '', busy: false, error: '', success: null })
  const [pluginState, setPluginState] = useState({ open: false, bundles: [], loading: false, error: '', installingId: null })
  const searchRef = useRef(null)
  const folderInputRef = useRef(null)

  const allSkills = useMemo(
    () => presentSkillCollection(mergeRuntimeSkills(customSkills, runtimeSkills), lang),
    [customSkills, runtimeSkills, lang],
  )

  useEffect(() => {
    let active = true
    listSkills().then(({ skills }) => {
      if (active && Array.isArray(skills) && skills.length) setRuntimeSkills(skills)
    }).catch(() => {
      if (active) setRuntimeSkills(SKILLS)
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchRef.current?.focus()
      }
      if (event.key === 'Escape') {
        if (selectedSkill) setSelectedSkill(null)
        else if (customModal) setCustomModal(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [customModal, selectedSkill])

  const filterDefs = useMemo(() => {
    const counts = {}
    allSkills.forEach((skill) => skill.perms?.forEach((permission) => {
      counts[permission] = (counts[permission] || 0) + 1
    }))
    return [
      { key: FILTER_ALL, label: t('skillsMarket.all'), count: allSkills.length },
      ...Object.entries(counts).map(([key, count]) => ({ key, label: key, count })),
      { key: FILTER_RECOMMENDED, label: t('skillsMarket.recommended'), count: allSkills.filter((skill) => skill.recommended).length },
      ...(customSkills.length ? [{ key: FILTER_CUSTOM, label: t('skillsMarket.custom'), count: customSkills.length }] : []),
    ]
  }, [allSkills, customSkills.length, t])

  const filteredSkills = useMemo(() => allSkills.filter((skill) => {
    const text = `${skill.id} ${skill.name} ${skill.desc} ${skill.pluginName || ''} ${skill.publisher || ''} ${skill.license || ''} ${(skill.perms || []).join(' ')}`
    const matchesSearch = !query.trim() || text.toLowerCase().includes(query.trim().toLowerCase())
    const matchesFilter = activeFilter === FILTER_ALL
      || (activeFilter === FILTER_RECOMMENDED && skill.recommended)
      || (activeFilter === FILTER_CUSTOM && skill.custom)
      || skill.perms?.includes(activeFilter)
    return matchesSearch && matchesFilter
  }).sort((left, right) => Number(Boolean(right.recommended)) - Number(Boolean(left.recommended))
    || String(left.name || left.id).localeCompare(String(right.name || right.id))), [activeFilter, allSkills, query])

  const openCustomModal = () => {
    setDraft(EMPTY_DRAFT)
    setDraftError('')
    setCustomModal(true)
  }

  const saveCustomSkill = () => {
    const id = draft.id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
    const name = draft.name.trim()
    const systemPrompt = draft.systemPrompt.trim()
    if (!id || !name || !systemPrompt) return setDraftError(t('skillsMarket.requiredFields'))
    if (allSkills.some((skill) => skill.id === id)) return setDraftError(t('skillsMarket.duplicateId', { id }))
    const next = [{
      id, name, systemPrompt,
      desc: draft.desc.trim() || t('skillsMarket.customDescription'),
      icon: draft.icon.trim() || '*',
      perms: draft.perms.split(',').map((value) => value.trim()).filter(Boolean),
      recommended: false, custom: true, localCustom: true,
    }, ...customSkills]
    setCustomSkills(next)
    saveLocalSkills(next)
    setCustomModal(false)
  }

  const deleteCustomSkill = (event, id) => {
    event.stopPropagation()
    if (!window.confirm(t('skillsMarket.deleteConfirm', { id }))) return
    const next = customSkills.filter((skill) => skill.id !== id)
    setCustomSkills(next)
    saveLocalSkills(next)
  }

  const selectFolder = async (event) => {
    const files = [...(event.target.files || [])]
    event.target.value = ''
    if (!files.length) return
    const contents = {}
    for (const file of files) {
      const parts = (file.webkitRelativePath || file.name).split('/').filter(Boolean)
      contents[parts.length > 1 ? parts.slice(1).join('/') : file.name] = await file.text()
    }
    try {
      const manifest = JSON.parse(contents['skill.json'] || '{}')
      if (!contents['prompts/system.md']) throw new Error(t('skillsMarket.missingPrompt'))
      setImportState({ files: contents, preview: { ...manifest, promptPreview: contents['prompts/system.md'].slice(0, 180) }, error: '', busy: false })
    } catch (error) {
      setImportState({ files: contents, preview: null, error: error.message || t('skillsMarket.readFailed'), busy: false })
    }
  }

  const closeImport = () => setImportState({ files: null, preview: null, error: '', busy: false })
  const confirmImport = async () => {
    if (!importState.files) return
    setImportState((current) => ({ ...current, busy: true, error: '' }))
    try {
      await importSkillPack(importState.files)
      const { skills } = await listSkills()
      setRuntimeSkills(skills)
      closeImport()
    } catch (error) {
      setImportState((current) => ({ ...current, error: error.message, busy: false }))
      toast.error({ title: t('toast.importFailed'), body: error.message })
    }
  }

  const openGithub = (presetId) => {
    const preset = presetId ? getOfficialSkillPreset(presetId) : null
    setGithubState({ open: true, url: preset?.url || '', busy: false, error: '', success: null })
  }
  const closeGithub = () => setGithubState((current) => current.busy ? current : { ...current, open: false })
  const installGithub = async () => {
    if (!githubState.url.trim()) return setGithubState((current) => ({ ...current, error: t('skillsMarket.githubUrlRequired') }))
    setGithubState((current) => ({ ...current, busy: true, error: '', success: null }))
    try {
      const response = await importSkillFromGithubUrl(githubState.url.trim())
      if (!response?.skill) throw new Error(response?.error || t('skillsMarket.installFailed'))
      const { skills } = await listSkills().catch(() => ({ skills: null }))
      if (Array.isArray(skills)) setRuntimeSkills(skills)
      setGithubState((current) => ({ ...current, url: '', busy: false, success: { name: response.skill.name || response.skill.id, source: response.source, repo: response.repo } }))
    } catch (error) {
      setGithubState((current) => ({ ...current, busy: false, error: error.message || t('skillsMarket.installFailed') }))
      toast.error({ title: t('toast.installFailed'), body: error.message || t('skillsMarket.installFailed') })
    }
  }

  const openPlugins = async () => {
    setPluginState({ open: true, bundles: [], loading: true, error: '', installingId: null })
    try {
      const { plugins } = await listPluginsApi({ type: 'skill-bundle' })
      setPluginState((current) => ({ ...current, bundles: Array.isArray(plugins) ? plugins : [], loading: false }))
    } catch (error) {
      setPluginState((current) => ({ ...current, loading: false, error: error.message || t('skillsMarket.pluginsLoadFailed') }))
    }
  }
  const installPlugin = async (pluginId) => {
    setPluginState((current) => ({ ...current, error: '', installingId: pluginId }))
    try {
      const response = await installPluginAsSkillApi(pluginId)
      if (!response?.ok || !response.skill) throw new Error(response?.error || t('skillsMarket.installFailed'))
      const { skills } = await listSkills().catch(() => ({ skills: null }))
      if (Array.isArray(skills) && skills.length) setRuntimeSkills(skills)
      setPluginState((current) => ({ ...current, open: false, installingId: null }))
    } catch (error) {
      setPluginState((current) => ({ ...current, error: error.message || t('skillsMarket.installFailed'), installingId: null }))
      toast.error({ title: t('toast.installFailed'), body: error.message || t('skillsMarket.installFailed') })
    }
  }

  return {
    query, setQuery, activeFilter, setActiveFilter, filterDefs, filteredSkills, selectedSkill, setSelectedSkill,
    searchRef, folderInputRef, customModal, setCustomModal, draft, setDraft, draftError, setDraftError,
    importState, githubState, setGithubState, pluginState, setPluginState,
    openCustomModal, saveCustomSkill, deleteCustomSkill, selectFolder, closeImport, confirmImport,
    openGithub, closeGithub, installGithub, openPlugins, installPlugin,
    useSelectedSkill: () => { if (selectedSkill?.runnable !== false) onUseSkill(selectedSkill) },
  }
}
