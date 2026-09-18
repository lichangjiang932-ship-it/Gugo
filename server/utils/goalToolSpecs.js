/**
 * Goal-plan tool schemas — pure data, no service imports.
 *
 * Deliberately separate from `goalTools.js` so `toolSchemaCatalog.js` can
 * register these schemas without importing the plan service. Keeping them in
 * one module created a cycle
 * (catalog -> goalTools -> goalPlanService -> ... -> catalog) and the specs
 * were then evaluated after the catalog body that consumes them.
 */
export const GOAL_TOOL_NAMES = Object.freeze([
  'goal_plan_status',
  'goal_step_update',
  'goal_plan_rewrite',
])

export const GOAL_STEP_STATUS_ENUM = Object.freeze(['pending', 'in_progress', 'done', 'blocked', 'skipped'])

export const GOAL_TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'goal_plan_status',
      description: [
        '★ 读取当前会话的持久化目标计划与每个步骤的状态/证据。',
        '计划由用户创建并批准,宿主保存;步骤只有在带可核验证据时才能标成 done。',
        '不确定自己做到哪一步、或需要 plan_id/step_id 时先调它,不要凭记忆编造进度。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          plan_id: { type: 'string', description: '省略时返回本会话当前未终结的计划。' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'goal_step_update',
      description: [
        '★ 推进目标计划里的一个步骤。status=done 必须带证据,宿主会回到持久 Turn 事件核验:',
        'turn_id 必须是真实发生过的 Turn;tool_call_id 指向该 Turn 里一次成功的工具调用。',
        '不带 tool_call_id 时,该 Turn 必须成功完成且有成功工具调用或宿主验证通过。',
        '证据对不上时调用会失败且步骤状态不变——不要改写证据,去把活真正干完再调。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          plan_id: { type: 'string' },
          step_id: { type: 'string' },
          status: { type: 'string', enum: GOAL_STEP_STATUS_ENUM },
          turn_id: { type: 'string', description: '证据所在 Turn,省略时用当前 Turn。必须是本计划所在会话的 Turn。' },
          tool_call_id: { type: 'string', description: '该 Turn 里一次成功工具调用的 id,且必须命中该步骤声明的验收条件。' },
          note: { type: 'string', description: '可选说明,不改判定。' },
          expected_version: { type: 'integer', minimum: 1, description: '上次读取的计划 version，已变化时拒绝旧操作。人工确认不能通过模型工具提交。' },
        },
        required: ['plan_id', 'step_id', 'status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'goal_plan_rewrite',
      description: [
        '★ 当计划确实走不通(步骤 blocked、验收条件写错、范围变了)时,提出一版新计划。',
        '它不会改写旧步骤:宿主创建 revision+1 并把旧计划标记为 superseded,新计划需要用户重新批准。',
        '只在真的需要换方案时用,不要为了绕过某一步的证据要求而重写。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          plan_id: { type: 'string' },
          objective: { type: 'string', description: '省略时沿用原目标。' },
          expected_version: { type: 'integer', minimum: 1, description: '上次读取的计划 version，避免覆盖用户的新决定。' },
          steps: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                acceptance: {
                  type: 'array',
                  description: [
                    '可机器核验的验收条件,决定该步骤能不能被标成 done。',
                    '字符串=人工可读说明(不参与判定)。对象按 kind 校验:',
                    '  {kind:"command", command?, tools?:[...], cwd?} 需要匹配明确命令/目录且已终结，退出码为 0;',
                    '  {kind:"file", path, sha256?} 需要写入该路径(带 sha256 时同时校验摘要);',
                    '  {kind:"artifact", artifactId?|type?} 需要产生对应产物;',
                    '  {kind:"verification"} 需要宿主 taskVerification 通过;',
                    '  {kind:"manual"} 只能由用户在可信人工入口确认，模型不得代为提交确认。',
                    '不声明任何对象条件时默认等价于 {kind:"tool"}(同会话内任意成功工具调用)。',
                    '带对象条件的步骤属于必需工作,不能被 skipped。',
                  ].join('\n'),
                  items: {
                    anyOf: [
                      { type: 'string' },
                      { type: 'object', properties: { kind: { type: 'string' } } },
                    ],
                  },
                },
              },
              required: ['title'],
            },
          },
        },
        required: ['plan_id', 'steps'],
      },
    },
  },
]
