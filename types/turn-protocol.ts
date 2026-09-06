import type { z } from 'zod'
import type {
  PersistedTurnEventSchema,
  TURN_EVENT_PAYLOAD_SCHEMAS,
  TurnEventSchema,
  TurnEventTransportEnvelopeSchema,
} from '../shared/turnEvents.js'
import type { TurnActivitySchema } from '../shared/turnActivity.js'
import type {
  TURN_WEBSOCKET_CLIENT_FRAME_SCHEMA,
  TURN_WEBSOCKET_SERVER_FRAME_SCHEMA,
} from '../shared/turnWebSocketProtocol.js'

/** The runtime schemas remain the sole field/version authorities. */
export type TurnEvent = z.output<typeof TurnEventSchema>
export type PersistedTurnEvent = z.output<typeof PersistedTurnEventSchema>
export type TurnEventTransportEnvelope = z.output<typeof TurnEventTransportEnvelopeSchema>
export type TurnEventType = keyof typeof TURN_EVENT_PAYLOAD_SCHEMAS
export type TurnEventPayload<Type extends TurnEventType> =
  z.input<(typeof TURN_EVENT_PAYLOAD_SCHEMAS)[Type]>

type EventIdentity = Omit<z.input<typeof TurnEventSchema>, 'type' | 'payload' | 'createdAt'>
export type CreateTurnEventInput = {
  [Type in TurnEventType]: EventIdentity & { type: Type; createdAt?: number }
    & ({} extends TurnEventPayload<Type>
      ? { payload?: TurnEventPayload<Type> }
      : { payload: TurnEventPayload<Type> })
}[TurnEventType]

export type TurnActivity = z.output<typeof TurnActivitySchema>
export type CreateTurnActivityInput = Omit<TurnActivity, 'createdAt'> & { createdAt?: number }
export type TurnWebSocketClientFrame = z.output<typeof TURN_WEBSOCKET_CLIENT_FRAME_SCHEMA>
export type TurnWebSocketServerFrame = z.output<typeof TURN_WEBSOCKET_SERVER_FRAME_SCHEMA>
export type TurnWebSocketFrame = TurnWebSocketClientFrame | TurnWebSocketServerFrame
export type TurnWebSocketFrameType = TurnWebSocketFrame['type']
export type TurnWebSocketFrameOf<Type extends TurnWebSocketFrameType> =
  Extract<TurnWebSocketFrame, { type: Type }>
export type TurnWebSocketFramePayload<Type extends TurnWebSocketFrameType> =
  Omit<TurnWebSocketFrameOf<Type>, 'v' | 'type'> & { v?: never; type?: never }

export type FrameValidationFailure = {
  ok: false
  code: 'VERSION_MISMATCH'
  message: string
  expectedVersion: TurnWebSocketFrame['v']
  receivedVersion: number | null
} | {
  ok: false
  code: 'INVALID_FRAME'
  message: string
  issues: string[]
}

export type FrameValidationResult<Frame> = { ok: true; value: Frame } | FrameValidationFailure
export type ClientFrameDecodeResult = FrameValidationResult<TurnWebSocketClientFrame>
  | { ok: false; code: 'INVALID_JSON' }
