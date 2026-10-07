import { useEffect, useState } from 'react'
import { BookOpen, Plus, RefreshCw } from 'lucide-react'
import { applyModelList, formatContextTokens, parseModelList, removeModelFromList } from './providerConfig.js'

function KnowledgeBaseModelRow({ model, inList, onToggle, t }) {
  const context = formatContextTokens(model.context)
  const known = [
    context ? t('modelProviders.modelContext', { tokens: context }) : '',
    model.vision ? t('modelProviders.modelVision') : '',
    model.tools ? t('modelProviders.modelTools') : '',
  ].filter(Boolean)
  return <li className="flex items-center gap-2 border-b border-ink/5 px-2.5 py-1.5 last:border-b-0 hover:bg-paper-2">
    <button
      type="button"
      aria-pressed={inList}
      aria-label={t(inList ? 'modelProviders.removeKnowledgeBaseModel' : 'modelProviders.addKnowledgeBaseModel', { model: model.id })}
      title={t(inList ? 'modelProviders.removeKnowledgeBaseModel' : 'modelProviders.addKnowledgeBaseModel', { model: model.id })}
      onClick={() => onToggle(model.id, inList)}
      className="flex min-w-0 flex-1 items-center gap-2 text-left"
    >
      <span className={`shrink-0 text-sm leading-none ${inList ? 'text-accent-ink' : 'text-ink-fade'}`}>{inList ? '✓' : '+'}</span>
      <span className="min-w-0">
        <span className={`block truncate text-xs ${inList ? 'font-medium text-ink' : 'text-ink-soft'}`}>{model.id}</span>
        {known.length > 0 && <span className="block truncate text-[10px] text-ink-fade">{known.join(' · ')}</span>}
      </span>
    </button>
    {model.deprecated === true && <span className="shrink-0 rounded bg-paper-2 px-1.5 py-0.5 text-[10px] text-danger">{t('modelProviders.deprecatedModel')}</span>}
    {inList && <span className="shrink-0 rounded bg-accent-soft/40 px-1.5 py-0.5 text-[10px] text-accent-ink">{t('modelProviders.inList')}</span>}
  </li>
}

/**
 * The knowledge-base model list: a second, clearly-labelled source beside the
 * provider's own `/models` endpoint.
 *
 * The endpoint answers "what does this exact credential serve right now"; the
 * knowledge base answers "which ids does this provider publish", including ids
 * released after this build was cut. Both feed the same editable list, so a
 * reader can apply the published list and still type an id by hand.
 */
export default function ProviderKnowledgeBase({
  editing, setEditing, catalogModels, catalogLoading = false, catalogError = '',
  onLoadModels, onMessage, t,
}) {
  const [draft, setDraft] = useState('')
  const providerId = String(editing.catalogProviderId || '').trim()
  const known = Array.isArray(catalogModels) ? catalogModels : []
  const models = parseModelList(editing.modelsText)
  const missing = known.map((model) => model.id).filter((id) => !models.includes(id))

  useEffect(() => {
    if (!providerId) return
    Promise.resolve().then(() => onLoadModels?.(providerId))
    // The provider id is the whole input: a different selection is a different list.
  }, [providerId, onLoadModels])

  const addModels = (ids) => {
    const incoming = (Array.isArray(ids) ? ids : [ids]).map((id) => String(id || '').trim()).filter(Boolean)
    if (!incoming.length) return
    const knownIds = new Set(known.map((model) => model.id))
    const next = applyModelList(models, incoming, editing.defaultModel)
    setEditing((current) => ({
      ...current,
      modelsText: next.models.join('\n'),
      defaultModel: next.defaultModel,
      modelProfiles: {
        ...(current.modelProfiles || {}),
        ...Object.fromEntries(incoming.flatMap((id) => {
          const model = known.find((entry) => entry.id === id)
          const context = Number(model?.context)
          if (!Number.isFinite(context) || context <= 0) return []
          if (current.modelProfiles?.[id]?.contextWindow != null) return []
          return [[id, { ...(current.modelProfiles?.[id] || {}), contextWindow: context }]]
        })),
      },
    }))
    // An id the caller passed but the knowledge base never listed is the manual
    // box's business, so the receipt is computed from what was actually known.
    onMessage?.(next.added.filter((id) => knownIds.has(id)).length
      ? t('modelProviders.knowledgeBaseAdded', { count: next.added.length })
      : t('modelProviders.knowledgeBaseNoChange'))
  }

  const removeModel = (id) => setEditing((current) => {
    const next = removeModelFromList(current.modelsText, id, current.defaultModel)
    return { ...current, modelsText: next.models.join('\n'), defaultModel: next.defaultModel }
  })

  const commitDraft = () => {
    const value = draft.trim()
    if (!value) return
    addModels([value])
    setDraft('')
  }

  return <div data-testid="provider-knowledge-base" className="flex flex-col gap-2 rounded-xl border border-ink/15 p-3">
    <div className="flex items-center gap-2">
      <BookOpen className="h-4 w-4 shrink-0 text-accent-ink" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-ink">{t('modelProviders.knowledgeBaseModels')}</div>
        <div className="mt-0.5 text-xs text-ink-fade">{t('modelProviders.knowledgeBaseModelsHint')}</div>
      </div>
      {providerId && <span data-catalog-provider-id className="shrink-0 rounded bg-paper-2 px-1.5 py-0.5 text-[10px] text-ink-fade">{providerId}</span>}
      {known.length > 0 && <span className="shrink-0 rounded bg-paper-2 px-1.5 py-0.5 text-[10px] text-ink-fade">{t('modelProviders.modelCount', { count: known.length })}</span>}
      <button
        type="button"
        disabled={!providerId || catalogLoading}
        onClick={() => onLoadModels?.(providerId)}
        aria-label={t('modelProviders.loadKnowledgeBaseModels')}
        title={t('modelProviders.loadKnowledgeBaseModels')}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-ink/20 px-3 text-xs text-ink-soft hover:bg-ink/[0.04] hover:text-ink disabled:opacity-40"
      ><RefreshCw className={`h-3.5 w-3.5 ${catalogLoading ? 'animate-spin' : ''}`} />{catalogLoading ? t('modelProviders.loadingKnowledgeBase') : t('modelProviders.loadKnowledgeBaseModels')}</button>
    </div>
    {catalogError && <div role="alert" className="text-xs text-danger">{catalogError}</div>}
    {known.length > 0 && <ul className="flex max-h-56 flex-col overflow-y-auto rounded-md border border-ink/10 bg-paper">
      {known.map((model) => <KnowledgeBaseModelRow
        key={model.id}
        model={model}
        inList={models.includes(model.id)}
        onToggle={(id, inList) => (inList ? removeModel(id) : addModels([id]))}
        t={t}
      />)}
    </ul>}
    {missing.length > 1 && <button
      type="button"
      onClick={() => addModels(missing)}
      className="inline-flex h-8 items-center gap-1 self-start rounded-md border border-ink/20 px-3 text-xs text-ink-soft hover:bg-ink/[0.04] hover:text-ink"
    ><Plus className="h-3.5 w-3.5" />{t('modelProviders.addAllKnowledgeBaseModels', { count: missing.length })}</button>}
    <div className="flex items-center gap-2">
      <input value={draft} onChange={(event) => setDraft(event.target.value)} onInput={(event) => setDraft(event.currentTarget.value)} onKeyDown={(event) => { if (event.key !== 'Enter') return; event.preventDefault(); commitDraft() }} aria-label={t('modelProviders.addModel')} placeholder={t('modelProviders.addKnowledgeBaseModelPlaceholder')} className="h-8 min-w-0 flex-1 rounded-md border border-ink/15 bg-paper-2 px-2 text-xs" />
      <button type="button" disabled={!draft.trim()} onClick={commitDraft} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-ink/20 px-3 text-xs text-ink-soft hover:bg-ink/[0.04] hover:text-ink disabled:opacity-40"><Plus className="h-3.5 w-3.5" />{t('modelProviders.addModel')}</button>
    </div>
  </div>
}
