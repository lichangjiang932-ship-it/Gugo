import { createTurnWebSocketFrame } from '../../../shared/turnWebSocketProtocol.js'
import { encodeTurnWebSocketServerFrame } from '../../../server/core/turnWebSocketFrameCodec.js'
encodeTurnWebSocketServerFrame(createTurnWebSocketFrame('subscribe.turn', { sessionId: 's', turnId: 't', after: -1 }))
