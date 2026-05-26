import { getDb } from '../db.js'
import { buildAgentSystemBlock, getAgent } from './agentStore.js'
import { parseMentions } from './mentionsParser.js'
import {
  appendMessage,
  getChannel,
  getLatestAgentMessage,
  getMessage,
  getMessageDepth,
  listMessages,
} from './channelStore.js'
import { newSubagentRunId, runSubagent } from './subagentRuntime.js'

const MAX_AGENT_CHAIN_DEPTH = 3

let runtime = { runSubagent }

export function configureChannelDispatcherForTests(nextRuntime = {}) {
  runtime = { runSubagent: nextRuntime.runSubagent || runSubagent }
}

function channelOwner(channelId) {
  const row = getDb().prepare('SELECT user_id FROM channels WHERE id = ?').get(channelId)
  return row?.user_id || null
}

function normalizeUserArgs(channelIdOrArgs, userId, text, opts = {}) {
  if (typeof channelIdOrArgs === 'object' && channelIdOrArgs !== null) return channelIdOrArgs
  return { channelId: channelIdOrArgs, userId, text, ...opts }
}

function normalizeAgentArgs(channelIdOrArgs, fromAgentId, text, opts = {}) {
  if (typeof channelIdOrArgs === 'object' && channelIdOrArgs !== null) return channelIdOrArgs
  return { channelId: channelIdOrArgs, fromAgentId, text, ...opts }
}

function memberMap(channel) {
  const map = new Map()
  for (const agent of channel?.agents || []) map.set(agent.id, agent)
  return map
}

function resolveTargetsForUser({ channel, mentions }) {
  const members = memberMap(channel)
  if (mentions.length > 0) return mentions.map((id) => members.get(id)).filter(Boolean)
  if (channel.defaultAgentId && members.has(channel.defaultAgentId)) {
    return [members.get(channel.defaultAgentId)]
  }
  return []
}

function formatMessageForPrompt(message, channel) {
  const sender = message.senderKind === 'user'
    ? 'user'
    : (channel.agents || []).find((agent) => agent.id === message.senderId)?.name || message.senderId
  return `[${new Date(message.createdAt).toISOString()}] ${sender}: ${message.content}`
}

function buildPrompt({ channel, targetAgent, sourceMessage, cleanedText, recentMessages, fromAgentId = null }) {
  const source = sourceMessage.senderKind === 'user'
    ? 'the user'
    : ((channel.agents || []).find((agent) => agent.id === sourceMessage.senderId)?.name || sourceMessage.senderId)
  const fullAgent = getAgent({ userId: channel.userId, id: targetAgent.id }) || targetAgent
  const persona = buildAgentSystemBlock(fullAgent)
  const context = recentMessages.map((message) => formatMessageForPrompt(message, channel)).join('\n')
  const fromNote = fromAgentId
    ? `This turn was delegated by agent ${fromAgentId}.`
    : 'This turn was delegated from a user channel message.'
  return [
    `You are replying inside a multi-agent channel named "${channel.name}".`,
    `Target agent: ${targetAgent.name} (${targetAgent.id}).`,
    persona ? `Persona:\n${persona}` : '',
    fromNote,
    'Recent channel transcript:',
    context || '(no prior messages)',
    '',
    `Respond to ${source}'s latest message. Keep the answer suitable for posting back into the channel.`,
    'If you need another channel member, mention them with @Name in your final answer.',
    '',
    `Latest message:\n${cleanedText || sourceMessage.content}`,
  ].filter(Boolean).join('\n\n')
}

function runAgentTurn({ userId, channelId, targetAgent, sourceMessage, cleanedText, fromAgentId = null }) {
  const channel = getChannel({ userId, channelId })
  if (!channel) return null
  const recentMessages = listMessages({ userId, channelId, limit: 10 })
  const id = newSubagentRunId()
  const prompt = buildPrompt({ channel, targetAgent, sourceMessage, cleanedText, recentMessages, fromAgentId })
  const promise = runtime.runSubagent({
    id,
    userId,
    type: 'general',
    prompt,
    description: `channel:${channel.name} -> ${targetAgent.name}`,
    parentSessionId: `channel:${channelId}`,
    parentMessageId: sourceMessage.id,
  })
  Promise.resolve(promise).then((run) => {
    const resultText = String(run?.resultText || run?.result_text || '').trim()
    if (!resultText) return
    const latestChannel = getChannel({ userId, channelId })
    if (!latestChannel) return
    const parsed = parseMentions(resultText, latestChannel.agents || [])
    const agentMessage = appendMessage({
      userId,
      channelId,
      senderKind: 'agent',
      senderId: targetAgent.id,
      content: resultText,
      mentions: parsed.mentions,
      parentMessageId: sourceMessage.id,
    })
    dispatchAgentMessage({
      channelId,
      userId,
      fromAgentId: targetAgent.id,
      text: resultText,
      parentMessageId: agentMessage.id,
    }).catch((err) => {
      console.error('[channelDispatcher] chained agent dispatch failed:', err?.stack || err)
    })
  }).catch((err) => {
    console.error('[channelDispatcher] subagent run failed:', err?.stack || err)
  })
  return id
}

export async function dispatchUserMessage(channelIdOrArgs, userIdArg, textArg, optsArg = {}) {
  const { channelId, userId, text, now = Date.now() } = normalizeUserArgs(channelIdOrArgs, userIdArg, textArg, optsArg)
  if (!channelId || !userId) throw new Error('channelId + userId required')
  const channel = getChannel({ userId, channelId })
  if (!channel) {
    const err = new Error('channel not found')
    err.statusCode = 404
    throw err
  }
  const parsed = parseMentions(text, channel.agents || [])
  const message = appendMessage({
    userId,
    channelId,
    senderKind: 'user',
    senderId: userId,
    content: text,
    mentions: parsed.mentions,
    now,
  })

  let targets = resolveTargetsForUser({ channel, mentions: parsed.mentions })
  if (targets.length === 0 && parsed.mentions.length === 0) {
    const recent = getLatestAgentMessage({ userId, channelId })
    const members = memberMap(channel)
    if (recent?.senderId && members.has(recent.senderId)) targets = [members.get(recent.senderId)]
  }

  const jobIds = targets
    .map((targetAgent) => runAgentTurn({
      userId,
      channelId,
      targetAgent,
      sourceMessage: message,
      cleanedText: parsed.cleanedText,
    }))
    .filter(Boolean)

  return { messageId: message.id, jobIds, mentions: parsed.mentions }
}

export async function dispatchAgentMessage(channelIdOrArgs, fromAgentIdArg, textArg, optsArg = {}) {
  const args = normalizeAgentArgs(channelIdOrArgs, fromAgentIdArg, textArg, optsArg)
  const channelId = args.channelId
  const userId = args.userId || channelOwner(channelId)
  const fromAgentId = args.fromAgentId
  const text = args.text
  if (!channelId || !userId || !fromAgentId) throw new Error('channelId + fromAgentId required')
  const channel = getChannel({ userId, channelId })
  if (!channel) {
    const err = new Error('channel not found')
    err.statusCode = 404
    throw err
  }

  const parsed = parseMentions(text, channel.agents || [])
  const targets = parsed.mentions
    .filter((agentId) => agentId !== fromAgentId)
    .map((agentId) => memberMap(channel).get(agentId))
    .filter(Boolean)
  if (targets.length === 0) return { jobIds: [], mentions: parsed.mentions }

  let sourceMessage = args.parentMessageId
    ? getMessage({ userId, channelId, messageId: args.parentMessageId })
    : null
  if (!sourceMessage) sourceMessage = getLatestAgentMessage({ userId, channelId })
  if (!sourceMessage) return { jobIds: [], mentions: parsed.mentions }

  const depth = getMessageDepth({ userId, channelId, messageId: sourceMessage.id, max: MAX_AGENT_CHAIN_DEPTH + 1 })
  if (depth >= MAX_AGENT_CHAIN_DEPTH) {
    return { jobIds: [], mentions: parsed.mentions, rejected: 'max_depth' }
  }

  const jobIds = targets
    .map((targetAgent) => runAgentTurn({
      userId,
      channelId,
      targetAgent,
      sourceMessage,
      cleanedText: parsed.cleanedText,
      fromAgentId,
    }))
    .filter(Boolean)

  return { jobIds, mentions: parsed.mentions }
}
