import { useState } from 'react'
import { RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import { addLlmModel, probeLlmModels, removeLlmModel } from '../../lib/llmConfigClient.js'

const BUTTON = 'h-8 rounded-control border border-ink/15 bg-paper px-3 text-xs text-ink transition-colors hover:bg-paper-2 disabled:opacity-50'
const LINK = 'inline-flex items-center gap-1 text-xs text-accent hover:underline disabled:opacity-50'

/**
 * The model directory of one provider: what the model picker will offer.
 * "获取可用模型" asks the endpoint; anything typed by hand stays until removed.
 */
export default function ProviderModelDirectory({ defaultModel, onChangeDefault, onChanged, provider, t }) {
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState('')
  const models = provider?.models || []

  const probe = async () => {
    setBusy(true)
    setNote('')
    try {
      const result = await probeLlmModels(provider.id)
      setNote(t('settingsModels.probeFound', { count: result.discovered?.length || 0 }))
      await onChanged?.()
    } catch (error) {
      setNote(error.message)
    } finally {
      setBusy(false)
    }
  }
  const add = async () => {
    const model = draft.trim()
    if (!model) return
    setBusy(true)
    try {
      await addLlmModel(provider.id, model)
      setDraft('')
      await onChanged?.()
    } catch (error) {
      setNote(error.message)
    } finally {
      setBusy(false)
    }
  }
  const remove = async (modelId) => {
    setBusy(true)
    try {
      await removeLlmModel(provider.id, modelId)
      await onChanged?.()
    } catch (error) {
      setNote(error.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="model-directory" data-provider={provider?.id}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-ink">{t('settingsModels.modelDirectory')}</span>
        <button type="button" className={LINK} data-testid="probe-models" disabled={busy} onClick={probe}>
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
          {t('settingsModels.probeModels')}
        </button>
      </div>
      {models.length === 0 ? (
        <p className="rounded-control border border-dashed border-ink/20 px-3 py-2 text-xs text-ink-fade" data-testid="model-directory-empty">
          {t('settingsModels.modelsEmptyHint')}
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {models.map((model) => (
            <li key={model.id} className="flex items-center gap-1 rounded-pill bg-paper-2 px-2 py-0.5 text-xs text-ink-soft">
              {onChangeDefault && defaultModel ? (
                <button
                  type="button"
                  className={`underline-offset-2 hover:underline ${defaultModel.model === model.id ? 'font-medium text-accent-ink' : ''}`}
                  data-testid="set-default-model"
                  data-model={model.id}
                  onClick={() => onChangeDefault(provider.id, model.id)}
                >
                  {model.id}
                </button>
              ) : <span>{model.id}</span>}
              <button type="button" data-testid="remove-model" data-model={model.id} aria-label={t('settingsModels.removeModel')}
                className="text-ink-fade hover:text-danger" onClick={() => remove(model.id)}>
                <Trash2 className="h-3 w-3" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t('settingsModels.modelIdPlaceholder')}
          data-testid="model-id-input"
          className="h-8 min-w-0 flex-1 rounded-control border border-ink/15 bg-paper px-2 text-xs text-ink outline-none focus:border-focus"
        />
        <button type="button" className={BUTTON} data-testid="add-model" disabled={busy || !draft.trim()} onClick={add}>
          <Sparkles className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
          {t('settingsModels.addModel')}
        </button>
      </div>
      {note && <p role="status" className="text-xs text-ink-fade">{note}</p>}
    </div>
  )
}
