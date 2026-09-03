import assert from 'node:assert/strict'
import test from 'node:test'

import { modelAuthoredTurnEvidenceText } from '../shared/turnEvidenceText.js'

const LEGACY_STATUS_CASES = [
  {
    state: 'blocked',
    content: '任務未全部完成，但已儲存的檔案仍可開啟；請依檔案旁的狀態確認結果。',
  },
  {
    state: 'failed',
    content: 'タスクは完了していませんが、保存済みのファイルは開けます。各ファイルの横に表示された状態を確認してください。',
  },
  {
    state: 'interrupted',
    content: '작업이 완료되지는 않았지만 저장된 파일은 열 수 있습니다. 각 파일 옆의 상태를 확인하세요.',
  },
]

test('legacy Traditional Chinese, Japanese, and Korean runtime status copy is not model evidence', () => {
  for (const fixture of LEGACY_STATUS_CASES) {
    assert.equal(modelAuthoredTurnEvidenceText(fixture), '', fixture.state)
  }
})

test('ordinary Traditional Chinese, Japanese, and Korean model text remains readable', () => {
  const modelTextCases = [
    { state: 'blocked', content: '這是模型整理出的實際分析內容。' },
    { state: 'failed', content: 'これはモデルが作成した通常の回答です。' },
    { state: 'interrupted', content: '이 내용은 모델이 작성한 일반 답변입니다.' },
  ]

  for (const fixture of modelTextCases) {
    assert.equal(modelAuthoredTurnEvidenceText(fixture), fixture.content, fixture.state)
  }
})
