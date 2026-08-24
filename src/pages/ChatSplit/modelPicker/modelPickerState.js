import { modelProviderLabel } from '../modelPickerGroups.js'

export function modelIdentity(model = {}) {
  return `${String(model.provider || '').trim()}\u0000${String(model.name || '').trim()}`
}

export function modelTriggerLabel({
  modelOptions = [],
  selectedModel = '',
  selectedModelProviderId = '',
} = {}) {
  const modelName = String(selectedModel || '').trim()
  if (!modelName) return ''

  const selectedProviderId = String(selectedModelProviderId || '').trim()
  const selectedOption = modelOptions.find((model) => (
    String(model?.name || '').trim() === modelName
    && (!selectedProviderId || String(model?.provider || '').trim() === selectedProviderId)
  ))
  const providerId = String(selectedOption?.provider || selectedProviderId).trim()
  const providerLabel = modelProviderLabel(providerId, selectedOption?.providerLabel)
  if (!providerLabel) return modelName

  const normalizedModelName = modelName.toLocaleLowerCase()
  const existingPrefixes = [providerId, providerLabel]
    .map((value) => String(value || '').trim().toLocaleLowerCase())
    .filter(Boolean)
  if (existingPrefixes.some((prefix) => normalizedModelName.startsWith(`${prefix}/`))) {
    return modelName
  }
  return `${providerLabel}/${modelName}`
}
