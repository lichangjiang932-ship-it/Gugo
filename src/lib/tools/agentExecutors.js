import { callJson } from './toolHttpClient.js'

async function execAgent(args) {
  const tasks = Array.isArray(args.tasks) && args.tasks.length ? args.tasks : [args]
  const settled = await Promise.allSettled(tasks.map((task) => callJson('/api/subagent/run', {
    subagent_type: task.subagent_type,
    prompt: task.prompt,
    description: task.description,
  })))
  const runs = settled.map((result, index) => result.status === 'fulfilled'
    ? {
        ok: true,
        runId: result.value.run?.id || result.value.id || null,
        status: result.value.run?.status || result.value.status || 'completed',
        description: tasks[index].description,
        result: result.value.result_text || result.value.run?.resultText || result.value.result || '',
      }
    : {
        ok: false,
        status: 'failed',
        description: tasks[index].description,
        error: result.reason?.message || String(result.reason),
      })
  return {
    content: JSON.stringify({
      ok: runs.some((run) => run.ok),
      parallel: runs.length > 1,
      runs,
    }),
  }
}

// Feature 8: Todo \u2014 \u7eaf\u524d\u7aef,\u8fd4\u56de todos \u5b57\u6bb5\u4f9b caller dispatch SET_TODOS
async function execManageTodos(args) {
  const todos = Array.isArray(args.todos) ? args.todos : []
  const summary = {
    pending: todos.filter((t) => t.status === 'pending').length,
    in_progress: todos.filter((t) => t.status === 'in_progress').length,
    completed: todos.filter((t) => t.status === 'completed').length,
  }
  const inProgressItem = todos.find((t) => t.status === 'in_progress')
  return {
    content: JSON.stringify({
      ok: true,
      total: todos.length,
      summary,
      currentTask: inProgressItem?.activeForm || null,
      message: `Todo \u5df2\u66f4\u65b0: ${summary.completed}/${todos.length} \u5b8c\u6210${inProgressItem ? `; \u5f53\u524d: ${inProgressItem.activeForm}` : ''}`,
    }),
    todos,
  }
}

export const AGENT_EXECUTORS = {
  Agent: execAgent,
  manage_todos: execManageTodos,
}

