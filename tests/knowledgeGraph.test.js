import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createEntities,
  findEntityByName,
  deleteEntities,
  createRelations,
  addObservations,
  searchNodes,
  readGraph,
  openNodes,
} from '../server/services/knowledgeGraph.js'
import { issueTestSession } from './helpers/testAuth.js'

const { userId: TEST_USER } = issueTestSession({ email: 'kg-test@example.com' })

test('createEntities creates entities and returns them', () => {
  const result = createEntities({
    userId: TEST_USER,
    entities: [
      { name: 'Project Alpha', entityType: 'project' },
      { name: 'User Smith', entityType: 'person' },
      { name: 'Feature X', entityType: 'feature' },
    ],
  })
  assert.equal(result.length, 3)
  assert.ok(result[0].id)
  assert.equal(result[0].name, 'Project Alpha')
  assert.equal(result[0].entityType, 'project')
})

test('findEntityByName returns entity or null', () => {
  const e = findEntityByName({ userId: TEST_USER, name: 'Project Alpha' })
  assert.ok(e)
  assert.equal(e.name, 'Project Alpha')
  const missing = findEntityByName({ userId: TEST_USER, name: 'nonexistent' })
  assert.equal(missing, null)
})

test('createRelations links entities', () => {
  createRelations({
    userId: TEST_USER,
    relations: [
      { from: 'Project Alpha', to: 'Feature X', relationType: 'has_feature' },
      { from: 'User Smith', to: 'Project Alpha', relationType: 'works_on' },
    ],
  })
  // Verify by reading graph
  const graph = readGraph({ userId: TEST_USER })
  assert.ok(graph.relations.length >= 2)
  const relTypes = graph.relations.map((r) => r.relationType)
  assert.ok(relTypes.includes('has_feature'))
  assert.ok(relTypes.includes('works_on'))
})

test('addObservations attaches observations to entities', () => {
  addObservations({
    userId: TEST_USER,
    observations: [
      { entityName: 'Project Alpha', contents: ['这是一个测试项目', '使用 React 构建'] },
      { entityName: 'Feature X', contents: ['核心功能模块'] },
    ],
  })
  const opened = openNodes({ userId: TEST_USER, names: ['Project Alpha'] })
  assert.equal(opened.length, 1)
  assert.ok(opened[0].observations.length >= 2)
})

test('searchNodes finds matching entities, relations, observations', () => {
  const result = searchNodes({ userId: TEST_USER, query: 'Alpha' })
  assert.ok(result.entities.length >= 1)
  assert.equal(result.entities[0].name, 'Project Alpha')
})

test('openNodes returns entities with relations and observations', () => {
  const result = openNodes({ userId: TEST_USER, names: ['Project Alpha', 'Feature X'] })
  assert.equal(result.length, 2)
  for (const node of result) {
    assert.ok(node.relations)
    assert.ok(node.observations)
  }
})

test('deleteEntities removes entity and cascades', () => {
  createEntities({ userId: TEST_USER, entities: [{ name: 'Temp Entity', entityType: 'temp' }] })
  assert.ok(findEntityByName({ userId: TEST_USER, name: 'Temp Entity' }))
  deleteEntities({ userId: TEST_USER, entityNames: ['Temp Entity'] })
  assert.equal(findEntityByName({ userId: TEST_USER, name: 'Temp Entity' }), null)
})

test('readGraph returns full graph structure', () => {
  const graph = readGraph({ userId: TEST_USER })
  assert.ok(Array.isArray(graph.entities))
  assert.ok(Array.isArray(graph.relations))
  assert.ok(Array.isArray(graph.observations))
  assert.ok(graph.entities.length >= 3) // Project Alpha, User Smith, Feature X
})

test('knowledge graph is isolated by user', () => {
  const { userId: otherUser } = issueTestSession({ email: 'kg-other@example.com' })
  createEntities({ userId: otherUser, entities: [{ name: 'Secret', entityType: 'secret' }] })
  const myGraph = readGraph({ userId: TEST_USER })
  const names = myGraph.entities.map((e) => e.name)
  assert.ok(!names.includes('Secret'), 'other user entities should not leak')
  // cleanup
  deleteEntities({ userId: otherUser, entityNames: ['Secret'] })
})
