import { hasConfiguredLspProvider } from './lspRuntime.js'
import { normalizePromptContextIds, prepareOptionalPromptContextAsync } from './optionalPromptContext.js'
import { assertPromptContextActive } from './backgroundMemoryQuery.js'
import { buildUserModelEnv } from './modelProviderStore.js'
import { buildSafetyBlock, prepareInlineSkillsForPrompt } from './promptCompiler.js'
import { SUBAGENT_MAX_PER_BATCH } from './subagentBatchConfig.js'
import { MAX_SUBAGENT_DEPTH, SUBAGENT_TYPES } from './subagentRuntimePolicy.js'
import { now, saveRunTrace } from './subagentRunState.js'

/** Owns only prompt assembly; the durable run/approval lifecycle stays in SubagentRuntime. */
export async function buildSubagentMessages(runtime) {
  const { input } = runtime
  const { system, tools } = SUBAGENT_TYPES[input.type]
  const effectiveTools = tools.filter((spec) => (
    spec?.function?.name !== 'lsp' || hasConfiguredLspProvider()
  ))
  assertPromptContextActive(input.signal)
  if (Array.isArray(runtime.state.checkpointState?.messages)) {
    return { effectiveTools, messages: runtime.state.checkpointState.messages }
  }
  const initial = runtime.trace.find((event) => event.type === 'start')
  const agentId = runtime.storedRun && Object.hasOwn(initial || {}, 'agentId') ? initial.agentId : input.agentId
  const env = Object.freeze({ ...(runtime.modelBinding.env || buildUserModelEnv({ userId: input.userId })) })
  const promptContext = await prepareOptionalPromptContextAsync({
    preparePromptContext: input.preparePromptContext,
    input: {
      userId: input.userId, agentId, skillIds: normalizePromptContextIds(input.skillIds),
      skillDefinitions: prepareInlineSkillsForPrompt({ skillIds: input.skillIds, skillDefinitions: input.skillDefinitions }),
      query: input.normalizedPrompt, env, signal: input.signal, resuming: Boolean(runtime.storedRun),
    },
    scope: 'subagent.prompt',
  })
  assertPromptContextActive(input.signal)
  runtime.trace.push({ type: 'prompt_context', userId: input.userId, agentId,
    memoryIds: promptContext.memoryIds || [], memoryDiagnostics: promptContext.memoryDiagnostics || null, at: now() })
  await saveRunTrace(runtime.runPersistence, { id: input.id, userId: input.userId, trace: runtime.trace })
  return {
    effectiveTools,
    messages: [
      { role: 'system', content: buildSafetyBlock().text },
      ...promptContext.messages,
      { role: 'system', content: input.type === 'general'
        ? `${system}\nYou may call Agent with up to ${SUBAGENT_MAX_PER_BATCH} independent tasks to run them in parallel. Nested delegation is bounded to ${MAX_SUBAGENT_DEPTH} levels.`
        : system },
      ...(input.team ? [{ role: 'system',
        content: `# Team Context\nTeam: ${input.team.name} (${input.team.id})\nMode: ${input.team.mode}\nYour role: ${input.team.role || input.description || input.type}\nWork only on your assigned scope. Your transcript is isolated from other members; return a concise result for the leader to merge.`,
      }] : []),
      { role: 'user', content: input.normalizedPrompt },
    ],
  }
}
