import {
  createTurnEvent,
  parseTurnEvent,
  TURN_EVENT_PAYLOAD_SCHEMAS,
  createTurnEventTransportEnvelope,
  parseTurnEventTransportPayload,
  canAdvanceTurnEventCursor,
} from '../../shared/turnEvents.js'
import { createTurnActivity } from '../../shared/turnActivity.js'
import { createTurnWebSocketFrame, validateTurnWebSocketClientFrame } from '../../shared/turnWebSocketProtocol.js'
import {
  decodeTurnWebSocketClientFrame,
  encodeTurnWebSocketEvent,
  encodeTurnWebSocketServerFrame,
} from '../../server/core/turnWebSocketFrameCodec.js'
import type {
  CreateTurnEventInput,
  TurnEvent,
  TurnEventPayload,
  TurnWebSocketClientFrame,
  TurnWebSocketServerFrame,
} from '../turn-protocol.js'

type Assert<T extends true> = T
type IsChecked<T> = 0 extends (1 & T) ? false : true
type _EventIsChecked = Assert<IsChecked<TurnEvent>>
type _EventInputIsChecked = Assert<IsChecked<Parameters<typeof createTurnEvent>[0]>>
type _FrameInputIsChecked = Assert<IsChecked<Parameters<typeof encodeTurnWebSocketServerFrame>[0]>>
type _DecodeResultIsChecked = Assert<IsChecked<ReturnType<typeof decodeTurnWebSocketClientFrame>>>

const input: CreateTurnEventInput = {
  id: 'event-1', sessionId: 'session-1', turnId: 'turn-1', sequence: 0,
  type: 'heartbeat', payload: { at: 1 },
}
const event = createTurnEvent(input)
const envelope = createTurnEventTransportEnvelope(event)
const version: 1 = envelope.v
const parsed: TurnEvent = parseTurnEvent(event)
const persisted: TurnEvent = parseTurnEventTransportPayload(envelope)
const advanced: boolean = canAdvanceTurnEventCursor(parsed, -1)
const serializedEvent: string = encodeTurnWebSocketEvent(persisted)
const payload: TurnEventPayload<'assistant.delta'> = { text: 'delta' }
const validatedText: string = TURN_EVENT_PAYLOAD_SCHEMAS['assistant.delta'].parse(payload).text

const subscription = createTurnWebSocketFrame('subscribe.turn', {
  sessionId: 'session-1', turnId: 'turn-1', after: -1,
})
const after: number = subscription.after
const clientFrame: TurnWebSocketClientFrame = subscription
const ready: TurnWebSocketServerFrame = createTurnWebSocketFrame('ready')
const serializedReady: string = encodeTurnWebSocketServerFrame(ready)
const activity = createTurnActivity({
  sessionId: 'session-1', turnId: 'turn-1', kind: 'tool_output_delta',
  toolName: 'shell', stream: 'stdout', chunk: 'done',
})
encodeTurnWebSocketServerFrame(createTurnWebSocketFrame('turn.activity', { activity }))
createTurnWebSocketFrame('approval.decide', { approvalId: 'approval-1', decision: 'approve' })

const decoded = decodeTurnWebSocketClientFrame(JSON.stringify(clientFrame))
if (decoded.ok && decoded.value.type === 'subscribe.turn') {
  const cursor: number = decoded.value.after
  canAdvanceTurnEventCursor(parsed, cursor)
} else if (!decoded.ok) {
  const code: 'INVALID_JSON' | 'VERSION_MISMATCH' | 'INVALID_FRAME' = decoded.code
  String(code)
}
const validated = validateTurnWebSocketClientFrame(JSON.parse(serializedReady) as unknown)
if (!validated.ok && validated.code === 'VERSION_MISMATCH') {
  const expected: 1 = validated.expectedVersion
  String(expected)
}
export { advanced, after, serializedEvent, serializedReady, validatedText, version }
