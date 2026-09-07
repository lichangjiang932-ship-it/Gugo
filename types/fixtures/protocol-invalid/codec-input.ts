import { decodeTurnWebSocketClientFrame } from '../../../server/core/turnWebSocketFrameCodec.js'
decodeTurnWebSocketClientFrame({ v: 1, type: 'ready' })
