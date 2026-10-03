/** Match the batch runtime's task selection without granting unknown types read privileges. */
export function subagentTasks(request = {}) {
  return Array.isArray(request?.tasks) && request.tasks.length ? request.tasks : [request]
}

export function subagentTaskType(task = {}) {
  return String(task?.subagent_type || task?.type || 'general').trim()
}

export function isReadOnlySubagentRequest(request = {}) {
  return subagentTasks(request).every((task) => ['explore', 'plan'].includes(subagentTaskType(task)))
}
