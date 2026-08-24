import { useMemo } from 'react'
import { resolveModelOptionReadiness } from '../chatModelReadiness.js'
import { groupModelOptions } from '../modelPickerGroups.js'
import { modelIdentity } from './modelPickerState.js'

export default function useModelPickerView({
  modelOptions,
  selectedModel,
  selectedModelProviderId,
}) {
  const displayGroups = useMemo(() => groupModelOptions(modelOptions), [modelOptions])
  const visibleModels = useMemo(() => displayGroups.flatMap((group) => group.models), [displayGroups])
  const tabStopModel = useMemo(() => {
    const selected = visibleModels.find((model) => (
      model.name === selectedModel
      && (!selectedModelProviderId || model.provider === selectedModelProviderId)
      && resolveModelOptionReadiness(model).canSelect !== false
    ))
    return selected || visibleModels.find((model) => resolveModelOptionReadiness(model).canSelect !== false)
  }, [selectedModel, selectedModelProviderId, visibleModels])

  return {
    displayGroups,
    tabStopIdentity: tabStopModel ? modelIdentity(tabStopModel) : '',
    visibleModels,
  }
}
