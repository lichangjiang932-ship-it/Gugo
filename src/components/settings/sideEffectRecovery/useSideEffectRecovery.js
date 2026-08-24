import { useCallback, useEffect, useState } from 'react'
import {
  listSideEffectRecoveryHistoryApi,
  listUnknownSideEffectsApi,
  resolveUnknownSideEffectApi,
} from '../../../lib/sideEffectRecoveryClient.js'
import { mergeRecords, recordKey } from './recoveryUtils.js'

export default function useSideEffectRecovery(t) {
  const [records, setRecords] = useState([])
  const [nextCursor, setNextCursor] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [historyRecords, setHistoryRecords] = useState([])
  const [historyNextCursor, setHistoryNextCursor] = useState(null)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [continuation, setContinuation] = useState(null)
  const [resolvingKey, setResolvingKey] = useState('')

  const refreshRecords = useCallback(async ({ signal } = {}) => {
    setLoading(true)
    setHistoryLoading(true)
    setNextCursor(null)
    setHistoryNextCursor(null)
    setLoadError('')
    setHistoryError('')
    setContinuation(null)
    const [pendingResult, historyResult] = await Promise.allSettled([
      listUnknownSideEffectsApi({ signal }),
      listSideEffectRecoveryHistoryApi({ signal }),
    ])
    if (signal?.aborted) return
    if (pendingResult.status === 'fulfilled') {
      setRecords(pendingResult.value.records)
      setNextCursor(pendingResult.value.nextCursor)
    } else if (pendingResult.reason?.name !== 'AbortError') {
      setLoadError(t('sideEffectRecovery.loadFailed', {
        reason: pendingResult.reason?.message || pendingResult.reason,
      }))
    }
    if (historyResult.status === 'fulfilled') {
      setHistoryRecords(historyResult.value.records)
      setHistoryNextCursor(historyResult.value.nextCursor)
    } else if (historyResult.reason?.name !== 'AbortError') {
      setHistoryError(t('sideEffectRecovery.historyLoadFailed', {
        reason: historyResult.reason?.message || historyResult.reason,
      }))
    }
    setLoading(false)
    setHistoryLoading(false)
  }, [t])

  const loadMorePending = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    setLoadError('')
    try {
      const page = await listUnknownSideEffectsApi({ cursor: nextCursor })
      setRecords((current) => mergeRecords(current, page.records))
      setNextCursor(page.nextCursor)
    } catch (error) {
      setLoadError(t('sideEffectRecovery.loadFailed', { reason: error?.message || error }))
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, nextCursor, t])

  const loadMoreHistory = useCallback(async () => {
    if (!historyNextCursor || historyLoadingMore) return
    setHistoryLoadingMore(true)
    setHistoryError('')
    try {
      const page = await listSideEffectRecoveryHistoryApi({ cursor: historyNextCursor })
      setHistoryRecords((current) => mergeRecords(current, page.records))
      setHistoryNextCursor(page.nextCursor)
    } catch (error) {
      setHistoryError(t('sideEffectRecovery.historyLoadFailed', { reason: error?.message || error }))
    } finally {
      setHistoryLoadingMore(false)
    }
  }, [historyLoadingMore, historyNextCursor, t])

  useEffect(() => {
    const controller = new AbortController()
    Promise.resolve().then(() => {
      if (!controller.signal.aborted) return refreshRecords({ signal: controller.signal })
      return undefined
    })
    return () => controller.abort()
  }, [refreshRecords])

  const resolveRecord = useCallback(async (record, resolution, note, confirmation) => {
    const key = recordKey(record)
    setResolvingKey(key)
    setActionError('')
    setNotice('')
    setContinuation(null)
    try {
      const result = await resolveUnknownSideEffectApi({
        record,
        scopeKey: record.scopeKey,
        toolCallId: record.toolCallId,
        verificationConfirmed: confirmation?.verificationConfirmed,
        confirmToolCallId: confirmation?.confirmToolCallId,
        resolution,
        note,
      })
      const resolvedRecord = {
        ...record,
        ...(result.record || {}),
        scopeKind: record.scopeKind,
        scopeKey: record.scopeKey,
        sessionId: record.sessionId,
        turnId: record.turnId,
        jobId: record.jobId,
        stepId: record.stepId,
        toolCallId: record.toolCallId,
        status: resolution,
      }
      setRecords((current) => current.filter((item) => recordKey(item) !== key))
      setHistoryRecords((current) => mergeRecords([resolvedRecord], current))
      setContinuation({ record: resolvedRecord, resume: result.resume })
      setNotice(t(
        resolution === 'committed'
          ? 'sideEffectRecovery.committedRecorded'
          : 'sideEffectRecovery.failedRecorded',
      ))
    } catch (error) {
      setActionError(t('sideEffectRecovery.resolveFailed', { reason: error?.message || error }))
      if (error?.status === 404 || error?.status === 409) await refreshRecords()
    } finally {
      setResolvingKey('')
    }
  }, [refreshRecords, t])

  return {
    actionError,
    continuation,
    historyError,
    historyLoading,
    historyLoadingMore,
    historyNextCursor,
    historyRecords,
    loadError,
    loading,
    loadingMore,
    loadMoreHistory,
    loadMorePending,
    nextCursor,
    notice,
    records,
    refreshRecords,
    resolveRecord,
    resolvingKey,
  }
}
