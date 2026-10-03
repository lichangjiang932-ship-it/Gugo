import { createTurnActivity } from '../../../shared/turnActivity.js'
createTurnActivity({ sessionId: 's', turnId: 't', kind: 'tool_output_delta', toolName: 'shell', chunk: 42 })
