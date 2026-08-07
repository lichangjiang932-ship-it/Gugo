import { useEffect, useMemo, useState } from 'react'
import { SKILLS } from '../../data.js'
import { getModelStatus } from '../../lib/modelClient.js'
import { readStoredModel, resolveInitialModel } from '../../lib/modelSelection.js'
import { listSkills } from '../../lib/skillClient.js'
import { listLocalSkills, mergeRuntimeSkills } from '../../lib/localSkills.js'
import { presentSkillCollection } from '../../lib/skillPresentation.js'
import { listPromptTemplatesApi, getPromptTemplateContentApi, renderPromptTemplate } from '../../lib/pluginClient.js'
import { createSlashCommandRegistry, normalizeSlashCommandName } from '../../lib/slashCommandRegistry.js'
import { CORE_SLASH_COMMANDS, registerCoreSlashCommands } from '../../lib/slashCoreCommands.js'

function promptTemplateCommandName(template) {
  return normalizeSlashCommandName(template?.name) || normalizeSlashCommandName(template?.id)
}

export default function useChatRuntimeCatalog({ lang, skillConfigs, t }) {
  const [modelOptions, setModelOptions] = useState([])
  const [selectedModel, setSelectedModel] = useState('')
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

  useEffect(() => {
    let cancelled = false
    async function loadModels() {
      try {
        const status = await getModelStatus()
        if (cancelled) return
        const models = status.models?.length
          ? status.models
          : status.modelName
            ? [{ name: status.modelName, multiplier: 1, active: true }]
            : []
        setModelOptions(models)
        setSelectedModel((current) => resolveInitialModel(models, current || readStoredModel()))
      } catch {
        if (!cancelled) setModelOptions([])
      }
    }
    loadModels()
    window.addEventListener('model-providers:changed', loadModels)
    return () => {
      cancelled = true
      window.removeEventListener('model-providers:changed', loadModels)
    }
  }, [])

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

  return { modelOptions, runtimeSkills, selectedModel, setSelectedModel, slashRegistry }
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
