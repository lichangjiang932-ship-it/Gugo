import { redactSensitiveText } from '../../utils/toolCallHarness.js'

const NON_VERDICT_CODES = new Set([
  'approval_denied',
  'tool_budget_exceeded',
  'tool_execution_skipped',
  'tool_execution_superseded_by_steering',
  'tool_arguments_invalid',
  'tool_arguments_validation_failed',
  'tool_call_parse_error',
  'side_effect_outcome_unknown',
  'side_effect_ledger_conflict',
])

const STABLE_VERIFICATION_DIAGNOSTIC_CODES = new Set([
  'PROCESS_TREE_CLEANUP_FAILED',
])

export function isDeterministicVerificationFailure(result) {
  if (result?.verificationVerdict === 'indeterminate'
    || result?.failureKind === 'infrastructure'
    || result?.passed === null) return false
  if (result?.ok !== false
    || result?.timedOut === true
    || result?.cancelled === true
    || result?.denied === true
    || result?.policyDenied === true
    || result?.systemFailure === true
    || result?.requiresUserVerification === true
    || result?.retryable === true) return false
  const code = String(result?.code || '').trim().toLowerCase()
  if (NON_VERDICT_CODES.has(code)
    || /(?:timeout|cancel|denied|permission|authori[sz]|unknown|conflict|invalid|parse)/iu.test(code)) {
    return false
  }
  if (Object.hasOwn(result || {}, 'passed')) return result.passed === false
  if (result?.verificationVerdict) return result.verificationVerdict === 'failed'
  const exitCode = Number(result?.exitCode)
  return Number.isInteger(exitCode) && exitCode !== 0
}

export function isDeterministicVerificationSuccess(result) {
  if (result?.verificationVerdict === 'indeterminate'
    || result?.failureKind === 'infrastructure'
    || result?.passed === null) return false
  if (result?.ok !== true
    || result?.passed === false
    || result?.timedOut === true
    || result?.cancelled === true
    || result?.denied === true
    || result?.policyDenied === true
    || result?.systemFailure === true
    || result?.requiresUserVerification === true
    || result?.retryable === true) return false
  const code = String(result?.code || '').trim().toLowerCase()
  if (NON_VERDICT_CODES.has(code)
    || /(?:timeout|cancel|denied|permission|authori[sz]|unknown|conflict|invalid|parse)/iu.test(code)) {
    return false
  }
  if (Object.hasOwn(result || {}, 'passed')) return result.passed === true
  if (result?.verificationVerdict) return result.verificationVerdict === 'passed'
  if (result?.exitCode == null) return true
  return Number(result.exitCode) === 0
}

export function compactVerificationDiagnostic(
  value,
  fallback = 'The verification command returned a failing result.',
) {
  const text = String(value || fallback).trim()
  const compact = [...text].filter((character) => {
    const code = character.codePointAt(0)
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
  }).join('')
  const bounded = compact.length > 1_200 ? compact.slice(-1_200) : compact
  return redactSensitiveText(bounded)
}

export function compactVerificationFailure(
  result,
  fallback = 'The verification command returned a failing result.',
) {
  const stableCode = result?.processTreeCleanupFailed === true
    ? 'PROCESS_TREE_CLEANUP_FAILED'
    : String(result?.code || '').trim().toUpperCase()
  if (STABLE_VERIFICATION_DIAGNOSTIC_CODES.has(stableCode)) {
    return compactVerificationDiagnostic(stableCode, fallback)
  }
  const candidates = [result?.stderr, result?.stdout, result?.error]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
  return compactVerificationDiagnostic(candidates[0], fallback)
}
