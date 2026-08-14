// 任务/工具调用状态枚举,把 magic string 收敛到一处。
// 散落在 store / page 里的 'pending' / 'running' / 'completed' / ... 都引这里。

export const TASK_STATUS = Object.freeze({
  PENDING:   'pending',
  RUNNING:   'running',
  COMPLETED: 'completed',
  FAILED:    'failed',
  CANCELLED: 'cancelled',
})

export const TOOL_CALL_STATUS = Object.freeze({
  RUNNING: 'running',
  SUCCESS: 'success',
  ERROR:   'error',
  CANCELLED: 'cancelled',
})

export const HISTORY_STATUS = Object.freeze({
  SUCCESS: 'success',
  FAILED:  'failed',
})

export const TASK_STATUSES = Object.values(TASK_STATUS)
export const TOOL_CALL_STATUSES = Object.values(TOOL_CALL_STATUS)
export const HISTORY_STATUSES = Object.values(HISTORY_STATUS)

export function isTaskStatus(s) { return TASK_STATUSES.includes(s) }
export function isToolCallStatus(s) { return TOOL_CALL_STATUSES.includes(s) }

// 显示用 (中文标签)
export const TASK_STATUS_LABEL = Object.freeze({
  [TASK_STATUS.PENDING]:   '等待中',
  [TASK_STATUS.RUNNING]:   '运行中',
  [TASK_STATUS.COMPLETED]: '已完成',
  [TASK_STATUS.FAILED]:    '已失败',
  [TASK_STATUS.CANCELLED]: '已取消',
})
