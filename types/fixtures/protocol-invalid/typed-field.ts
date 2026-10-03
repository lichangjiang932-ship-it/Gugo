import { createTurnWebSocketFrame } from '../../../shared/turnWebSocketProtocol.js'
const frame = createTurnWebSocketFrame('subscribe.turn', { sessionId: 's', turnId: 't', after: -1 })
const incorrect: boolean = frame.after
export { incorrect }
