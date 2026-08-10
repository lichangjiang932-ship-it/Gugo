export const AGENT_TOOL_SPECS = {
  Agent: {
    type: 'function',
    function: {
      name: 'Agent',
      description: 'Delegate focused work to isolated sub-agents. Pass one task, or up to 3 independent tasks to run them in parallel. Returns final summaries only.',
      parameters: {
        type: 'object',
        properties: {
          subagent_type: { type: 'string', enum: ['explore', 'plan', 'general'] },
          prompt: { type: 'string', description: 'Full instructions; the sub-agent cannot see hidden parent context unless you include it.' },
          description: { type: 'string', description: '5-10 word label shown to the user.' },
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: 3,
            items: {
              type: 'object',
              properties: {
                subagent_type: { type: 'string', enum: ['explore', 'plan', 'general'] },
                prompt: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['subagent_type', 'prompt'],
            },
          },
        },
        anyOf: [
          { required: ['subagent_type', 'prompt'] },
          { required: ['tasks'] },
        ],
      },
    },
  },

  // Feature 8: Todo \u8ffd\u8e2a \u2014 \u6a21\u578b\u7528\u6765\u7ba1\u7406\u591a\u6b65\u4efb\u52a1\u6e05\u5355,UI \u9876\u90e8 sticky \u6e32\u67d3
  manage_todos: {
    type: 'function',
    function: {
      name: 'manage_todos',
      description: '\u7ef4\u62a4\u5f53\u524d\u4efb\u52a1\u7684 Todo \u6e05\u5355\u3002\u591a\u6b65\u4efb\u52a1\u5fc5\u987b\u8c03\u7528\u672c\u5de5\u5177\u8ba9\u7528\u6237\u5b9e\u65f6\u770b\u5230\u8fdb\u5ea6;\u6bcf\u6b21\u4f20\u6574\u7ec4\u66ff\u6362,\u540c\u4e00\u65f6\u95f4\u53ea\u5141\u8bb8\u4e00\u4e2a in_progress\u3002content \u7528\u7948\u4f7f\u53e5(\u5982"\u6dfb\u52a0\u9519\u8bef\u5904\u7406"),activeForm \u7528\u8fdb\u884c\u65f6(\u5982"\u6dfb\u52a0\u9519\u8bef\u5904\u7406\u4e2d")\u3002\u6a21\u578b\u53ef\u53cd\u590d\u8c03\u7528\u66f4\u65b0\u72b6\u6001\u3002',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '\u7948\u4f7f\u53e5\u5f62\u5f0f,\u5982"\u4fee\u590d\u767b\u5f55\u95ea\u9000"' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                activeForm: { type: 'string', description: '\u8fdb\u884c\u65f6,\u5982"\u4fee\u590d\u767b\u5f55\u95ea\u9000\u4e2d"' },
              },
              required: ['content', 'status', 'activeForm'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
  reflect: {
    type: 'function',
    function: {
      name: 'reflect',
      description: 'Record a concise, observable reflection after a meaningful task step. State what happened and the concrete next step; this tool has no external side effects.',
      parameters: {
        type: 'object',
        properties: {
          observation: { type: 'string', description: 'Facts observed from the preceding action or tool result.' },
          what_worked: { type: 'string', description: 'Optional effective approach or useful result.' },
          what_didnt: { type: 'string', description: 'Optional failed approach or unexpected result.' },
          next_step: { type: 'string', description: 'Concrete next action, or "done" when the task is complete.' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['observation', 'next_step'],
      },
    },
  },
  request_clarification: {
    type: 'function',
    function: {
      name: 'request_clarification',
      description: 'Pause the current tool loop and ask the user a specific question when indispensable information, intent, permission, or a risk decision is missing. Do not use it to claim that an available tool is unavailable.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'A concrete, decision-ready question for the user.' },
          why: { type: 'string', description: 'Optional explanation of why the answer is required.' },
          blocker_kind: { type: 'string', enum: ['missing_info', 'ambiguous_intent', 'permission', 'risk_decision', 'other'] },
          options: { type: 'array', maxItems: 8, items: { type: 'string' }, description: 'Optional concise answer choices.' },
        },
        required: ['question'],
      },
    },
  },
  remember: {
    type: 'function',
    function: {
      name: 'remember',
      description: 'Store a durable fact that will be useful across conversations, such as a user preference, project convention, recurring correction, or stable reference. Reusing a title updates the existing memory.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'], description: 'Memory category.' },
          title: { type: 'string', description: 'Short stable title. An existing memory with the same title is updated.' },
          body: { type: 'string', description: 'The durable fact in one or two concise sentences.' },
        },
        required: ['type', 'title', 'body'],
      },
    },
  },
}

