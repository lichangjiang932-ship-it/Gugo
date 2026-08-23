import { useCallback, useEffect, useMemo, useState } from 'react'
import { SKILLS } from '../../data.js'
import { getModelStatus } from '../../lib/modelClient.js'
import {
  readStoredModelSelection,
  resolveInitialModelSelection,
  writeStoredModelSelection,
} from '../../lib/modelSelection.js'
import { listSkills } from '../../lib/skillClient.js'
import { listLocalSkills, mergeRuntimeSkills } from '../../lib/localSkills.js'
import { presentSkillCollection } from '../../lib/skillPresentation.js'
import { listPromptTemplatesApi, getPromptTemplateContentApi, renderPromptTemplate } from '../../lib/pluginClient.js'
import { createSlashCommandRegistry, normalizeSlashCommandName } from '../../lib/slashCommandRegistry.js'
import { CORE_SLASH_COMMANDS, registerCoreSlashCommands } from '../../lib/slashCoreCommands.js'
import { INITIAL_MODEL_CATALOG_STATE, modelCatalogStateFromStatus, modelOptionsFromStatus } from './chatModelReadiness.js'

export { modelOptionsFromStatus } from './chatModelReadiness.js'

function promptTemplateCommandName(template) {
  return normalizeSlashCommandName(template?.name) || normalizeSlashCommandName(template?.id)
}

export default function useChatRuntimeCatalog({ lang, skillConfigs, t }) {
  const [modelOptions, setModelOptions] = useState([])
  const [selectedModelSelection, setSelectedModelSelection] = useState({ modelName: '', providerId: '' })
  const [modelCatalogState, setModelCatalogState] = useState(INITIAL_MODEL_CATALOG_STATE)
  const [modelCatalogRevision, setModelCatalogRevision] = useState(0)
  const [runtimeSkills, setRuntimeSkills] = useState(() => mergeRuntimeSkills(listLocalSkills(), SKILLS))
  const [promptTemplates, setPromptTemplates] = useState([])
  const presentedRuntimeSkills = useMemo(() => presentSkillCollection(runtimeSkills, lang), [runtimeSkills, lang])

  const slashRegistry = useMemo(() => {
    const registry = createSlashCommandRegistry()
    registerCoreSlashCommands(registry, { t, lang })
    for (const skill of presentedRuntimeSkills) {
      if (!skill?.id || skill.runnable === false || skillConfigs?.[skill.id]?.enabled === false) continue
      const name = normalizeSlashCommandName(skill.id)
      if (!name || CORE_SLASH_COMMANDS.includes(name)) continue
      registry.register({
        name,
        description: skill.name || skill.desc || skill.description || skill.id,
        hint: '<prompt>',
        kind: 'skill',
        handler: async () => `/${name} `,
        meta: { displayName: skill.name || skill.id },
      }, 'core')
    }
    for (const template of promptTemplates) registerPromptTemplate(registry, template)
    return registry
  }, [lang, presentedRuntimeSkills, promptTemplates, skillConfigs, t])

  const reloadModels = useCallback(() => {
    setModelCatalogRevision((revision) => revision + 1)
  }, [])

  const setSelectedModel = useCallback((modelName, providerId = '') => {
    setSelectedModelSelection({
      modelName: String(modelName || '').trim(),
      providerId: String(providerId || '').trim(),
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    async function loadModels() {
      setModelCatalogState(INITIAL_MODEL_CATALOG_STATE)
      try {
        const status = await getModelStatus()
        if (cancelled) return
        const models = modelOptionsFromStatus(status)
        setModelOptions(models)
        setModelCatalogState(modelCatalogStateFromStatus(status, models))
        setSelectedModelSelection((current) => {
          const selected = resolveInitialModelSelection(
            models,
            current.modelName ? current : readStoredModelSelection(),
          )
          writeStoredModelSelection(selected)
          return selected
        })
      } catch {
        if (!cancelled) {
          setModelOptions([])
          setSelectedModelSelection({ modelName: '', providerId: '' })
          setModelCatalogState({ kind: 'error' })
        }
      }
    }
    loadModels()
    return () => { cancelled = true }
  }, [modelCatalogRevision])

  useEffect(() => {
    window.addEventListener('model-providers:changed', reloadModels)
    return () => window.removeEventListener('model-providers:changed', reloadModels)
  }, [reloadModels])

  useEffect(() => {
    let cancelled = false
    listSkills()
      .then(({ skills }) => {
        if (!cancelled && Array.isArray(skills) && skills.length) setRuntimeSkills(mergeRuntimeSkills(listLocalSkills(), skills))
      })
      .catch((error) => {
        console.warn('[ChatSplit] Failed to load remote skills; using local skills.', error?.message || error)
        if (!cancelled) setRuntimeSkills(mergeRuntimeSkills(listLocalSkills(), SKILLS))
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    listPromptTemplatesApi()
      .then((list) => { if (!cancelled && Array.isArray(list)) setPromptTemplates(list) })
      .catch(() => { if (!cancelled) setPromptTemplates([]) })
    return () => { cancelled = true }
  }, [])

  return {
    modelCatalogState,
    modelOptions,
    reloadModels,
    runtimeSkills,
    selectedModel: selectedModelSelection.modelName,
    selectedModelProviderId: selectedModelSelection.providerId,
    setSelectedModel,
    slashRegistry,
  }
}

function registerPromptTemplate(registry, template) {
  if (!template?.id) return
  let name = promptTemplateCommandName(template)
  if (!name) return
  if (registry.getCommand(name)?.source === 'core') name = normalizeSlashCommandName(template.id)
  if (!name || registry.getCommand(name)?.source === 'core') return
  registry.register({
    name,
    description: template.description || template.name || template.id,
    kind: 'prompt-template',
    handler: async () => {
      try {
        const content = await getPromptTemplateContentApi(template.id)
        if (!content) return `# ${template.name || template.id}\n`
        return renderPromptTemplate(content, { name: template.name || '', description: template.description || '' })
      } catch {
        return `# ${template.name || template.id}\n`
      }
    },
    meta: { pluginId: template.id, displayName: template.name || template.id },
  }, 'plugin')
}
