import assert from 'node:assert/strict'
import test from 'node:test'

import { runToolLoop } from '../server/services/loop/index.js'
import { SERVER_TOOL_SPECS } from '../server/services/jobTools.js'
import { hasMutationExecutionIntent, shouldRequireExecution } from '../server/utils/executionIntent.js'

const CASES = [
  {
    language: 'es',
    repair: 'corrige el error en src/app.js',
    polite: 'Por favor, corrige el error en `src/app.js`.',
    common: ['Por favor, arregla README.md', 'Actualiza README.md'],
    explanation: 'Explica cómo corregir el error en src/app.js.',
    prohibition: 'No corrijas el error en src/app.js.',
    constraint: 'corrige el error en src/app.js; solo lectura, no modifiques archivos.',
    quotation: 'Traduce esta frase: «corrige el error en src/app.js».',
    report: 'Escribe un informe breve sobre el progreso del proyecto.',
  },
  {
    language: 'fr',
    repair: 'corrige le bug dans src/app.js',
    polite: "S’il vous plaît, corrigez le bug dans `src/app.js`.",
    common: ['Mets à jour README.md', 'Corrige README.md'],
    explanation: 'Explique comment corriger le bug dans src/app.js.',
    prohibition: 'Ne corrige pas le bug dans src/app.js.',
    constraint: 'corrige le bug dans src/app.js; lecture seule, ne modifie aucun fichier.',
    quotation: 'Explique cette citation : «corrige le bug dans src/app.js».',
    report: 'Rédige un bref rapport sur le progrès du projet.',
  },
  {
    language: 'de',
    repair: 'repariere den Fehler in src/app.js',
    polite: 'Bitte behebe den Fehler in `src/app.js`.',
    common: ['Bitte ändere README.md'],
    explanation: 'Erkläre, wie ich den Fehler in src/app.js repariere.',
    prohibition: 'Repariere den Fehler in src/app.js nicht.',
    constraint: 'repariere den Fehler in src/app.js; nur lesen, keine Dateien ändern.',
    quotation: 'Erkläre das Zitat „repariere den Fehler in src/app.js“.',
    report: 'Schreibe einen kurzen Bericht über den Projektfortschritt.',
  },
  {
    language: 'ja',
    repair: 'src/app.js のバグを修正してください',
    polite: '`src/app.js` の不具合を修正してください。',
    common: ['README.mdを直してください'],
    explanation: 'src/app.js のバグを修正する方法を説明してください。',
    prohibition: 'src/app.js のバグを修正しないでください。',
    constraint: 'src/app.js のバグを修正してください。ただし読み取り専用で、ファイルは変更しないでください。',
    quotation: '「src/app.js のバグを修正してください」という文を説明してください。',
    report: 'プロジェクトの進捗について短いレポートを書いてください。',
  },
  {
    language: 'ko',
    repair: 'src/app.js 버그를 수정해주세요',
    polite: '`src/app.js`의 오류를 수정해 주세요.',
    common: ['README.md 고쳐 주세요'],
    explanation: 'src/app.js 버그를 수정하는 방법을 설명해주세요.',
    prohibition: 'src/app.js 버그를 수정하지 마세요.',
    constraint: 'src/app.js 버그를 수정해주세요. 읽기 전용이며 파일은 변경하지 마세요.',
    quotation: '"src/app.js 버그를 수정해주세요"라는 문장을 설명해주세요.',
    report: '프로젝트 진행 상황에 대한 짧은 보고서를 작성해주세요.',
  },
  {
    language: 'ru',
    repair: 'исправь ошибку в src/app.js',
    polite: 'Пожалуйста, исправьте ошибку в `src/app.js`.',
    common: ['Почини README.md', 'Исправь README.md'],
    explanation: 'Объясни, как исправить ошибку в src/app.js.',
    prohibition: 'Не исправляй ошибку в src/app.js.',
    constraint: 'исправь ошибку в src/app.js; только чтение, не изменяй файлы.',
    quotation: 'Объясни цитату «исправь ошибку в src/app.js».',
    report: 'Напиши краткий отчёт о ходе проекта.',
  },
]

for (const entry of CASES) {
  test(`${entry.language}: direct file repair requests require execution and mutation evidence`, () => {
    for (const text of [entry.repair, entry.polite, ...entry.common]) {
      assert.equal(shouldRequireExecution({ intentMode: 'auto', text }), true, text)
      assert.equal(hasMutationExecutionIntent(text), true, text)
      assert.equal(shouldRequireExecution({ intentMode: 'answer', text }), false, text)
    }
  })

  test(`${entry.language}: explanations, prohibitions, quotations and read-only constraints are not repair orders`, () => {
    const negatives = [entry.explanation, entry.prohibition, entry.constraint, entry.quotation,
      `"${entry.repair}"`, `\`${entry.repair}\``, `\`\`\`text\n${entry.repair}\n\`\`\``,
      `> ${entry.repair}`, `read-only: ${entry.repair}`, `只分析，不要修改文件：${entry.repair}`]
    for (const text of negatives) {
      assert.equal(shouldRequireExecution({ intentMode: 'auto', text }), false, text)
      assert.equal(hasMutationExecutionIntent(text), false, text)
    }
  })
}

async function textOnlyLoop(text, { intentMode = 'auto', content = 'Completed.' } = {}) {
  let toolCalls = 0
  const result = await runToolLoop({
    job: { id: 'multilingual-file-repair', origin: 'chat', prompt: text, userPrompt: text, userId: null },
    step: { id: 'multilingual-file-repair', kind: 'chat' },
    messages: [{ role: 'user', content: text }],
    toolSpecs: [], intentMode, maxIters: 1, enableToolHooks: false,
    runModel: async () => ({ content, toolCalls: [] }),
    executeTool: async () => { toolCalls += 1; throw new Error('text-only fixture must not invoke a tool') },
  })
  assert.equal(toolCalls, 0)
  return result
}

test('canonical auto-mode loop rejects a tool-free Completed claim for all six supported repair forms', async () => {
  for (const { language, repair } of CASES) {
    const result = await textOnlyLoop(repair)
    assert.equal(result.incomplete, true, language)
    assert.equal(result.reason, 'execution_evidence_missing', language)
  }
})

test('read-file evidence alone cannot satisfy a multilingual mutation request', async () => {
  const readFile = SERVER_TOOL_SPECS.find((tool) => tool.function?.name === 'read_file')
  for (const { language, repair } of CASES) {
    let modelCalls = 0
    const executed = []
    const result = await runToolLoop({
      job: {
        id: `multilingual-read-${language}`, origin: 'chat', prompt: repair,
        userPrompt: repair, userId: 'multilingual-read-fixture-user',
      },
      step: { id: `multilingual-read-${language}`, kind: 'chat' },
      messages: [{ role: 'user', content: repair }],
      toolSpecs: [readFile], intentMode: 'auto', maxIters: 3, enableToolHooks: false,
      requestToolApproval: async ({ args }) => ({ proceed: true, args, approvalId: 'offline-read-approved' }),
      runModel: async () => ++modelCalls === 1
        ? { content: '', toolCalls: [{ id: 'inspect', type: 'function', function: {
          name: 'read_file', arguments: JSON.stringify({ path: 'src/app.js' }),
        } }] }
        : { content: 'Completed.', toolCalls: [] },
      executeTool: async ({ name, args }) => {
        executed.push({ name, path: args.path })
        return { ok: true, path: args.path, content: 'original content', truncated: false }
      },
    })
    assert.deepEqual(executed, [{ name: 'read_file', path: 'src/app.js' }], language)
    assert.equal(result.incomplete, true, language)
    assert.equal(result.reason, 'execution_evidence_missing', language)
  }
})

test('canonical loop preserves explicit answer intent and normal multilingual text reports', async () => {
  for (const { language, repair, report } of CASES) {
    const answer = 'This is an explanation only.'
    const explained = await textOnlyLoop(repair, { intentMode: 'answer', content: answer })
    assert.equal(explained.incomplete, undefined, language)
    assert.equal(explained.text, answer, language)
    const reportText = `Project progress report (${language}): implementation is under review.`
    const reported = await textOnlyLoop(report, { content: reportText })
    assert.equal(reported.incomplete, undefined, language)
    assert.equal(reported.text, reportText, language)
  }
})

test('a filename or an unsupported language alone does not imply a mutation order', () => {
  for (const text of ['src/app.js', 'कृपया src/app.js के बारे में बताएं।', 'src/app.js の状態はどうですか？']) {
    assert.equal(shouldRequireExecution({ text }), false, text)
    assert.equal(hasMutationExecutionIntent(text), false, text)
  }
})
