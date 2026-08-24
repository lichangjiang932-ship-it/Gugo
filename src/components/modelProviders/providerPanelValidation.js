import {
  providerBaseUrlError,
  providerHasCredentials,
  providerHeadersError,
  providerKeyError,
  providerLabelError,
  providerModelsError,
  providerNumericFieldError,
  PROVIDER_PRESETS,
} from './providerConfig.js'

function requiredFieldError(label, t) {
  const template = String(t('modelProviders.baseUrlErrorRequired'))
  return template.includes('Base URL') ? template.replaceAll('Base URL', label) : `${label}: ${template}`
}

function providerKeyErrorMessage(code, t) {
  if (!code) return ''
  if (code === 'required') return requiredFieldError('Provider ID', t)
  return 'Provider ID · a-z first · a-z / 0-9 / _ / - · 1–40'
}

function numericFieldErrorMessage(error, label, t) {
  if (!error) return ''
  if (error.reason === 'min') return t('modelProviders.numericErrorMin', { field: label, min: error.min })
  if (error.reason === 'max' || error.reason === 'safeInteger') {
    return t('modelProviders.numericErrorMax', { field: label, max: error.max })
  }
  return t('modelProviders.numericErrorInteger', { field: label })
}

export function buildProviderValidation(editing, t) {
  const selectedPreset = editing ? PROVIDER_PRESETS.find((preset) => preset.id === editing.presetId) : null
  const isLocalPreset = selectedPreset?.local === true
  const keyErrorCode = editing ? providerKeyError(editing.key) : ''
  const labelErrorCode = editing ? providerLabelError(editing.label) : ''
  const baseUrlErrorCode = editing ? providerBaseUrlError(editing.baseUrl) : ''
  const modelsErrorCode = editing ? providerModelsError(editing.modelsText) : ''
  const headersErrorCode = editing ? providerHeadersError(editing.headersText) : ''
  const keyError = providerKeyErrorMessage(keyErrorCode, t)
  const labelError = labelErrorCode ? requiredFieldError(t('modelProviders.name'), t) : ''
  const baseUrlError = baseUrlErrorCode
    ? t(`modelProviders.baseUrlError${baseUrlErrorCode[0].toUpperCase()}${baseUrlErrorCode.slice(1)}`)
    : ''
  const modelsError = modelsErrorCode ? requiredFieldError(t('modelProviders.defaultModel'), t) : ''
  const headersError = headersErrorCode
    ? t(`modelProviders.headersError${headersErrorCode[0].toUpperCase()}${headersErrorCode.slice(1)}`)
    : ''
  const contextWindowError = editing
    ? numericFieldErrorMessage(providerNumericFieldError(editing.contextWindow, 'contextWindow'), t('modelProviders.contextWindow'), t)
    : ''
  const firstTokenTimeoutError = editing
    ? numericFieldErrorMessage(providerNumericFieldError(editing.firstTokenTimeoutMs, 'firstTokenTimeoutMs'), t('modelProviders.firstTokenTimeout'), t)
    : ''
  const idleTimeoutError = editing
    ? numericFieldErrorMessage(providerNumericFieldError(editing.idleTimeoutMs, 'idleTimeoutMs'), t('modelProviders.idleTimeout'), t)
    : ''
  const modelContextErrors = editing ? Object.fromEntries(
    [...new Set(String(editing.modelsText || '').split(/[\n,]/).map((model) => model.trim()).filter(Boolean))]
      .flatMap((model) => {
        const error = providerNumericFieldError(editing.modelProfiles?.[model]?.contextWindow, 'contextWindow')
        const message = numericFieldErrorMessage(error, `${model} · ${t('modelProviders.contextWindow')}`, t)
        return message ? [[model, message]] : []
      }),
  ) : {}
  const numericValidationError = contextWindowError || firstTokenTimeoutError || idleTimeoutError
    || Object.values(modelContextErrors)[0] || ''
  const hasCredentials = providerHasCredentials(editing)
  const canSave = Boolean(editing && !keyErrorCode && !labelErrorCode && !baseUrlErrorCode && !modelsErrorCode
    && !headersErrorCode && !numericValidationError
    && (isLocalPreset || editing.presetId === 'custom' || hasCredentials))

  return {
    baseUrlError,
    canSave,
    contextWindowError,
    firstTokenTimeoutError,
    hasCredentials,
    headersError,
    idleTimeoutError,
    keyError,
    labelError,
    modelContextErrors,
    modelsError,
    numericValidationError,
  }
}

export function readinessFromTestResult(result, modelName) {
  return result?.readiness
    || result?.provider?.modelReadiness?.[modelName]
    || (result?.provider?.defaultModel === modelName ? result?.provider?.readiness : null)
    || result?.capabilities
    || null
}

export function isAgentReady(readiness) {
  return readiness?.mode === 'agent'
    && readiness.chat === true
    && readiness.tools === true
    && readiness.agent === true
}
