const LEGACY_RUNTIME_STATUS_PATTERNS = Object.freeze([
  /^任务未全部完成，但已保存的文件仍可打开；请按文件旁的状态确认结果。$/u,
  /^任務未全部完成，但已儲存的檔案仍可開啟；請依檔案旁的狀態確認結果。$/u,
  /^The task is incomplete, but saved files can still be opened\. Check the status (?:beside|next to) each file to confirm the result\.$/iu,
  /^タスクは完了していませんが、保存済みのファイルは開けます。各ファイルの横に表示された状態を確認してください。$/u,
  /^작업이 완료되지는 않았지만 저장된 파일은 열 수 있습니다\. 각 파일 옆의 상태를 확인하세요\.$/u,
  /^任务中断\s*[：:]\s*后续模型请求未能继续[，,]任务尚未完成。请重试以继续。(?:\s*已经完成的部分\s*[：:][\s\S]*)?$/u,
  /^模型预算已用尽[，,]任务尚未完成。请重试以继续。(?:\s*已经完成的部分\s*[：:][\s\S]*)?$/u,
  /^任务执行被中断[，,]尚未完成/u,
  /^模型推理超过安全上限[，,]任务已停止/u,
  /^任务尚未完成。请重试以继续/u,
  /^已达到\s*\d+\s*轮工具调用上限[，,]任务尚未完成/u,
  /^网页文件尚未通过资源完整性验证/u,
  /^Turn (?:execution did not complete|interrupted)\.?$/iu,
])

export function modelAuthoredTurnEvidenceText({
  content,
  failureMessage = '',
  state = '',
} = {}) {
  const text = String(content ?? '')
  const trimmed = text.trim()
  const normalizedState = String(state || '').trim()
  const normalizedFailure = String(failureMessage || '').trim()
  if (normalizedFailure && trimmed === normalizedFailure) return ''
  if (normalizedState === 'cancelled' && /^cancelled by user$/iu.test(trimmed)) return ''
  if (['blocked', 'failed', 'interrupted'].includes(normalizedState)
    && LEGACY_RUNTIME_STATUS_PATTERNS.some((pattern) => pattern.test(trimmed))) return ''
  return text
}
