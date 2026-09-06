import { createTurnWebSocketFrame } from '../../../shared/turnWebSocketProtocol.js'
createTurnWebSocketFrame('approval.decide', { approvalId: 'a', decision: 'approve_everything' })
