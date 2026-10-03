/**
 * The response-format contract the interface parses.
 *
 * `shared/agentReportSections.js` reads 【任务完成报告】 / 【Thought】 / 【Action】 /
 * 【Observation】 and the `<collapsible>` container out of the model's answer, and
 * the interface folds the steps away. None of that happens unless the model is
 * told the shape, which is what this block does — it is the only place that asks
 * for it, so keep the labels here byte-identical to the ones the parser accepts.
 *
 * `tests/turnOutputContractPrompt.test.js` fails if the contract and the parser
 * drift apart, and `tests/agentReportSections.test.js` pins the parser side.
 *
 * Static by design: same text on every turn, so it belongs to the stable prompt
 * prefix and never invalidates the provider cache on its own.
 */
import { fingerprintFor } from './promptCompilerCache.js'

const OUTPUT_CONTRACT_TEXT = [
  '# Output Contract — follow strictly',
  '',
  '## While you work',
  'Advance the task in ReAct rounds, one round at a time. Each round has exactly this shape:',
  '【Thought】what you are thinking and why',
  '【Action】the tool call or command you are about to run',
  '【Observation】the result you received',
  'Then think again from that result and continue. Repeat until the task is finished.',
  '',
  '## When the task is finished',
  'Produce exactly two things.',
  '',
  '1. A top-level 【任务完成报告】: a short summary for the user — what was done, the outcome, and the files that were produced. This is the only part shown expanded by default.',
  '2. Every intermediate 【Thought】 / 【Action】 / 【Observation】 inside one container, marked exactly like this:',
  '',
  '<collapsible title="完整执行过程（点击展开）">',
  '【Thought】…',
  '【Action】…',
  '【Observation】…',
  '</collapsible>',
  '',
  '## Rules',
  '- Write the section labels exactly as above, including the 【】 brackets.',
  '- Always emit 【任务完成报告】, even when the task was short and even when there was nothing to change.',
  '- Whenever you ran at least one tool, put those steps in the container. Never leave them loose in the report.',
  '- Never put intermediate logs, raw tool output, or step narration inside 【任务完成报告】.',
  '- Do not open with a greeting or preamble, and do not explain these rules or restate the request.',
  '- Emit no other tags or markup. The interface owns all layout and renders the container collapsed.',
].join('\n')

export function buildOutputContractBlock() {
  return {
    text: OUTPUT_CONTRACT_TEXT,
    fingerprint: fingerprintFor({ version: 1, text: OUTPUT_CONTRACT_TEXT }),
    sources: { fields: ['outputContract'], version: 1 },
  }
}

export { OUTPUT_CONTRACT_TEXT }
