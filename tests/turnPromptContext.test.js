import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearPromptCompilerCache,
  getPromptCompilerStats,
} from '../server/services/promptCompiler.js'
import { prepareTurnPromptContext } from '../server/services/turnPromptContext.js'

const AGENT = {
  id: 'agent-cache-stable',
  name: 'Stable Agent',
  identityMd: 'Keep the identity stable.',
  soulMd: 'Keep the soul stable.',
}

const SKILL = {
  id: 'skill-cache-stable',
  name: 'Stable Skill',
  description: 'A stable skill description.',
  permissions: ['read'],
  systemPrompt: 'Use the stable skill instructions.',
}

function prepare(workspaceText) {
  return prepareTurnPromptContext({
    userId: 'prompt-cache-user',
    agentId: AGENT.id,
    skillIds: [SKILL.id],
    sessionId: 'prompt-cache-session',
    recentMessages: [{ role: 'user', content: 'Keep this session context stable.' }],
    query: 'Stable query',
    env: { WORKSPACE_TEXT: workspaceText },
  }, {
    getAgent: () => AGENT,
    prepareSkillsForPrompt: () => [SKILL],
    prepareMemoryInjectionContext: () => ({
      text: '# Long-term memory\nStable memory.',
      memoryIds: ['memory-cache-stable'],
    }),
    readWorkspaceInstructions: ({ env }) => ({ text: env.WORKSPACE_TEXT }),
  })
}

test('turn prompt keeps compiled blocks in stable order before dynamic context', () => {
  clearPromptCompilerCache()
  const prepared = prepare('# Workspace instructions\nVersion one.')
  const contents = prepared.messages.map((message) => message.content)

  assert.match(contents[0], /^# Agent: Stable Agent/)
  assert.match(contents[1], /## SOUL/)
  assert.match(contents[2], /^# Skills/)
  assert.match(contents[3], /^# Session Context/)
  assert.match(contents[4], /^# Long-term memory/)
  assert.match(contents[5], /^# Workspace instructions/)
})
test('trusted runtime prompt blocks use a fixed additive slot and receive only frozen scope metadata', () => {
  const observedScopes = []
  const warnings = []
  const prepared = prepareTurnPromptContext({
    userId: 'runtime-prompt-user',
    agentId: AGENT.id,
    skillIds: [SKILL.id],
    sessionId: 'runtime-prompt-session',
    query: 'raw query must not reach the runtime prompt callback',
    env: { WORKSPACE_TEXT: '# Workspace instructions\nRemain authoritative.' },
  }, {
    getAgent: () => AGENT,
    prepareSkillsForPrompt: () => [SKILL],
    prepareMemoryInjectionContext: () => ({
      text: '# Long-term memory\nStable memory.',
      memoryIds: ['runtime-prompt-memory'],
    }),
    readWorkspaceInstructions: ({ env }) => ({ text: env.WORKSPACE_TEXT }),
    renderRuntimePromptBlocks: (scope) => {
      observedScopes.push(scope)
      return {
        blocks: [{
          id: 'project-hints',
          pluginId: 'trusted-project-plugin',
          text: 'Use the trusted project hints.',
        }],
        errors: [{
          id: 'failed-hints',
          pluginId: 'trusted-project-plugin',
          code: 'PLUGIN_PROMPT_RENDER_FAILED',
        }],
      }
    },
    logWarn: (...args) => warnings.push(args.join(' ')),
  })
  const contents = prepared.messages.map((message) => message.content)
  const memoryIndex = contents.findIndex((content) => content.startsWith('# Long-term memory'))
  const pluginIndex = contents.findIndex((content) => content.startsWith('# Runtime Plugin Context: project-hints'))
  const workspaceIndex = contents.findIndex((content) => content.startsWith('# Workspace instructions'))

  assert.equal(memoryIndex >= 0, true)
  assert.equal(pluginIndex, memoryIndex + 1)
  assert.equal(workspaceIndex, pluginIndex + 1)
  assert.match(contents[pluginIndex], /Source: trusted-project-plugin/)
  assert.deepEqual(prepared.pluginPromptBlockIds, ['trusted-project-plugin:project-hints'])
  assert.deepEqual(observedScopes, [{
    userId: 'runtime-prompt-user',
    sessionId: 'runtime-prompt-session',
    agentId: AGENT.id,
    skillIds: [SKILL.id],
  }])
  assert.equal('query' in observedScopes[0], false)
  assert.equal(warnings.some((warning) => warning.includes('failed-hints')), true)
})

test('changing workspace instructions preserves compiled block cache hits and contents', () => {
  clearPromptCompilerCache()
  const first = prepare('# Workspace instructions\nVersion one.')
  const afterFirst = getPromptCompilerStats()
  const second = prepare('# Workspace instructions\nVersion two.')
  const afterSecond = getPromptCompilerStats()

  assert.deepEqual(
    second.messages.slice(0, 4),
    first.messages.slice(0, 4),
    'dynamic workspace text must not alter the four compiled blocks',
  )
  for (const type of ['identity', 'ishiki', 'skills', 'sessions']) {
    assert.equal(afterFirst[type].misses, 1)
    assert.equal(afterSecond[type].hits, 1)
    assert.equal(afterSecond[type].misses, 1)
  }
  assert.notEqual(second.messages.at(-1).content, first.messages.at(-1).content)
})

test('turn prompt executes an unknown local skill definition with the quality contract', () => {
  const prepared = prepareTurnPromptContext({
    userId: 'local-skill-user',
    skillIds: ['local-writer'],
    skillDefinitions: [{
      id: 'local-writer',
      name: 'Local writer',
      description: 'A browser-local custom skill.',
      permissions: ['read'],
      systemPrompt: 'Use this exact custom workflow.',
    }],
    env: { AGENT_INJECT_ENABLED: '0' },
  }, {
    prepareSkillsForPrompt: () => [],
    prepareMemoryInjectionContext: () => ({ text: '', memoryIds: [] }),
    readWorkspaceInstructions: () => null,
  })

  assert.deepEqual(prepared.skillIds, ['local-writer'])
  const skillBlock = prepared.messages.find((message) => message.content.startsWith('# Skills'))?.content || ''
  assert.match(skillBlock, /Use this exact custom workflow\./)
  assert.match(skillBlock, /gugo-skill-quality:v1/)
  assert.match(skillBlock, /then inspect the result, run the most relevant checks/i)
})

test('registered skills take precedence over conflicting inline definitions', () => {
  const prepared = prepareTurnPromptContext({
    userId: 'registered-priority-user',
    skillIds: ['shared-skill-id'],
    skillDefinitions: [{
      id: 'shared-skill-id',
      name: 'Inline copy',
      description: 'Browser-local fallback.',
      permissions: [],
      systemPrompt: 'INLINE PROMPT MUST NOT WIN.',
    }],
    env: { AGENT_INJECT_ENABLED: '0' },
  }, {
    prepareSkillsForPrompt: () => [{
      id: 'shared-skill-id',
      name: 'Registered skill',
      description: 'Server-authoritative workflow.',
      permissions: ['read'],
      systemPrompt: 'REGISTERED PROMPT WINS.',
    }],
    prepareMemoryInjectionContext: () => ({ text: '', memoryIds: [] }),
    readWorkspaceInstructions: () => null,
  })

  const skillBlock = prepared.messages.find((message) => message.content.startsWith('# Skills'))?.content || ''
  assert.match(skillBlock, /REGISTERED PROMPT WINS\./)
  assert.doesNotMatch(skillBlock, /INLINE PROMPT MUST NOT WIN\./)
  assert.deepEqual(prepared.skillIds, ['shared-skill-id'])
})

test('skill catalog failure does not block an explicitly selected skill', () => {
  const warnings = []
  const prepared = prepareTurnPromptContext({
    userId: 'catalog-fallback-user',
    skillIds: ['explicit-writer'],
    env: { AGENT_INJECT_ENABLED: '0' },
  }, {
    prepareSkillCatalogForPrompt: () => {
      throw new Error('catalog unavailable')
    },
    prepareSkillsForPrompt: () => [{
      id: 'explicit-writer',
      name: 'Explicit writer',
      description: 'Selected directly by the request.',
      systemPrompt: 'EXPLICIT_SKILL_BODY_SURVIVES_CATALOG_FAILURE',
    }],
    prepareMemoryInjectionContext: () => ({ text: '', memoryIds: [] }),
    readWorkspaceInstructions: () => null,
    logWarn: (...args) => warnings.push(args.join(' ')),
  })

  assert.deepEqual(prepared.skillIds, ['explicit-writer'])
  assert.match(prepared.messages.map((message) => message.content).join('\n'), /EXPLICIT_SKILL_BODY_SURVIVES_CATALOG_FAILURE/)
  assert.equal(warnings.some((warning) => warning.includes('catalog unavailable')), true)
})

test('an unselected skill contributes catalog metadata without its instructions', () => {
  const prepared = prepareTurnPromptContext({
    userId: 'catalog-only-user',
    env: { AGENT_INJECT_ENABLED: '0' },
  }, {
    prepareSkillCatalogForPrompt: () => [{
      id: 'optional-reviewer',
      name: 'Optional reviewer',
      description: 'Load only when explicitly selected.',
      systemPrompt: 'UNSELECTED_BODY_MUST_NOT_BE_IN_PROMPT',
      loadable: true,
    }],
    prepareSkillsForPrompt: () => [],
    prepareMemoryInjectionContext: () => ({ text: '', memoryIds: [] }),
    readWorkspaceInstructions: () => null,
  })

  const text = prepared.messages.map((message) => message.content).join('\n')
  assert.deepEqual(prepared.skillIds, [])
  assert.match(text, /optional-reviewer.*loadable: \/optional-reviewer/)
  assert.doesNotMatch(text, /UNSELECTED_BODY_MUST_NOT_BE_IN_PROMPT/)
})
