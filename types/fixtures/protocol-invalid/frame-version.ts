import { encodeTurnWebSocketServerFrame } from '../../../server/core/turnWebSocketFrameCodec.js'
encodeTurnWebSocketServerFrame({ v: 2, type: 'ready' })
