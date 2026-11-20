import assert from 'node:assert/strict'
import test from 'node:test'
import { createActivation } from '../src/activation.js'

const baseState = (over = {}) => ({
  version: 4,
  settings: { enabled: true, mcpGate: true, gateDefaultSkills: false },
  skills: {},
  sources: {},
  groups: {},
  mcp: {
    alpha: { enabled: true, modes: [], workspaces: [], disclosure: 'progressive', tools: {} },
    beta: { enabled: true, modes: [], workspaces: [], disclosure: 'full', tools: {} },
    ...over,
  },
})

function harness(state) {
  const schemas = [
    { name: 'read', description: 'read a file' },
    { name: 'mcp__alpha__search', description: 'search' },
    { name: 'mcp__alpha__read', description: 'read doc' },
    { name: 'mcp__beta__echo', description: 'echo' },
    { name: 'mcp__hidden__x', description: 'outside pool' },
  ]
  const layers = []
  let guard
  const tools = {
    schemas: () => schemas,
    register: () => () => {},
    restrict: (filter) => {
      const entry = { filter, active: true }
      layers.push(entry)
      return () => { entry.active = false }
    },
    guard: (fn) => { guard = fn; return () => {} },
  }
  const ctx = {
    get: (name) => (name === 'tools' ? tools : undefined),
    effect: (fn) => (typeof fn === 'function' ? fn() : () => {}),
    on: () => {},
    logger: { warn() {}, debug() {}, info() {} },
  }
  const activation = createActivation({ ctx, getState: async () => state, logger: ctx.logger })
  return { activation, layers, tools, getGuard: () => guard }
}

const agentOf = (id, tools) => ({
  id,
  ctx: {
    get: () => undefined,
    // The activation layer registers per-Agent restrict layers through
    // `agent.ctx.effect`; the fake must run the callback so layers are recorded.
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    tools,
  },
  session: { header: { cwd: '/w', agentPreset: 'standard' } },
})

test('progressive service tools are denied before expansion; full service tools stay visible', async () => {
  const h = harness(baseState())
  const agent = agentOf('a1', h.tools)
  await h.activation.applyToAgent(agent)
  const denied = h.layers.filter((l) => l.active).flatMap((l) => l.filter.deny)
  assert.ok(denied.includes('mcp__alpha__search'))
  assert.ok(denied.includes('mcp__alpha__read'))
  assert.ok(denied.includes('mcp__hidden__x'))
  assert.ok(!denied.includes('mcp__beta__echo'))
})

test('expandService lifts only the progressive layers for that service', async () => {
  const h = harness(baseState())
  const agent = agentOf('a1', h.tools)
  await h.activation.applyToAgent(agent)
  assert.equal(h.activation.expandService(agent, 'alpha').ok, true)
  const denied = h.layers.filter((l) => l.active).flatMap((l) => l.filter.deny)
  assert.ok(!denied.includes('mcp__alpha__search'))
  assert.ok(denied.includes('mcp__hidden__x'))
})

test('per-tool disabled and out-of-scope tools are denied in full mode too', async () => {
  const h = harness(baseState({
    beta: {
      enabled: true, modes: [], workspaces: [], disclosure: 'full',
      tools: {
        'mcp__beta__echo': { enabled: true, modes: ['fleet'], workspaces: [] },
      },
    },
  }))
  const agent = agentOf('a1', h.tools)
  await h.activation.applyToAgent(agent)
  const denied = h.layers.filter((l) => l.active).flatMap((l) => l.filter.deny)
  assert.ok(denied.includes('mcp__beta__echo'))
})

test('the global guard rejects unexpanded, then allows after expansion', async () => {
  const h = harness(baseState())
  const agent = agentOf('a1', h.tools)
  await h.activation.applyToAgent(agent)
  const guard = h.getGuard()
  assert.equal(guard({ name: 'mcp__alpha__search', agent }), 'server-not-expanded')
  h.activation.expandService(agent, 'alpha')
  assert.equal(guard({ name: 'mcp__alpha__search', agent }), undefined)
  assert.equal(guard({ name: 'mcp__hidden__x', agent }), 'server-not-in-pool')
})

test('an agent with no activation record is denied by the global guard', () => {
  const h = harness(baseState())
  assert.equal(h.getGuard()({ name: 'mcp__beta__echo', agent: agentOf('cold', h.tools) }), 'pool-not-activated')
})
