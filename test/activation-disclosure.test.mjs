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

function harness(state, overrides = {}) {
  let schemas = [
    { name: 'read', description: 'read a file' },
    { name: 'mcp__alpha__search', description: 'search' },
    { name: 'mcp__alpha__read', description: 'read doc' },
    { name: 'mcp__beta__echo', description: 'echo' },
    { name: 'mcp__hidden__x', description: 'outside pool' },
  ]
  const layers = []
  const listeners = new Map()
  // Live Agent registry the plugin re-applies after a `tools/change`; a test
  // opts an Agent in with `addLive` (the activation layer only reads `list()`).
  const liveAgents = []
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
    get: (name) => {
      if (name === 'tools') return tools
      if (name === 'agents') return { list: () => liveAgents }
      return undefined
    },
    effect: (fn) => (typeof fn === 'function' ? fn() : () => {}),
    // A real host emits `tools/change` synchronously from inside register(); the
    // fake keeps the same contract so the subscription is exercised.
    on: (event, listener) => {
      const bucket = listeners.get(event) ?? []
      bucket.push(listener)
      listeners.set(event, bucket)
      return () => {
        const index = bucket.indexOf(listener)
        if (index >= 0) bucket.splice(index, 1)
      }
    },
    logger: { warn() {}, debug() {}, info() {} },
  }
  const emit = (event) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener()
  }
  const activation = createActivation({
    ctx,
    getState: overrides.getState ?? (async () => state),
    logger: ctx.logger,
  })
  return {
    activation,
    layers,
    tools,
    setSchemas: (next) => { schemas = next },
    addLive: (agent) => {
      liveAgents.push(agent)
      return agent
    },
    /** Append one newly registered schema and publish `tools/change`. */
    registerTool: (schema) => {
      schemas = [...schemas, schema]
      emit('tools/change')
    },
    getGuard: () => guard,
  }
}

/** Wait until `predicate` holds; the tools/change re-apply is asynchronous. */
async function settle(predicate, timeoutMs = 1000) {
  const started = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the re-apply to settle')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
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

test('per-tool switches still apply when the MCP gate is off', async () => {
  const state = baseState({
    beta: {
      enabled: true, modes: [], workspaces: [], disclosure: 'full',
      tools: { 'mcp__beta__echo': { enabled: false, modes: [], workspaces: [] } },
    },
  })
  state.settings.mcpGate = false
  const h = harness(state)
  const agent = agentOf('a1', h.tools)
  await h.activation.applyToAgent(agent)
  const denied = h.layers.filter((l) => l.active).flatMap((l) => l.filter.deny)
  assert.ok(denied.includes('mcp__beta__echo'), 'a user refusal is not a pool gate')
  assert.equal(h.activation.recordOf(agent).gateMcp, false)
  assert.equal(h.getGuard()({ name: 'mcp__beta__echo', agent }), 'tool-disabled')
  // Gate off still means no pool-level hiding, progressive services included.
  assert.ok(!denied.includes('mcp__alpha__search'))
  assert.equal(h.getGuard()({ name: 'mcp__hidden__x', agent }), undefined)
})

test('a transient empty MCP surface keeps the per-tool guard snapshot', async () => {
  const h = harness(baseState({
    beta: {
      enabled: true, modes: [], workspaces: [], disclosure: 'full',
      tools: { 'mcp__beta__echo': { enabled: false, modes: [], workspaces: [] } },
    },
  }))
  const agent = agentOf('a1', h.tools)
  await h.activation.applyToAgent(agent)
  assert.equal(h.getGuard()({ name: 'mcp__beta__echo', agent }), 'tool-disabled')
  // A host generation change: no MCP tool is visible right now. The old deny
  // layers are retained, so their names must stay refused by the guard.
  h.setSchemas([{ name: 'read', description: 'read a file' }])
  await h.activation.applyToAgent(agent, { force: true })
  assert.equal(h.getGuard()({ name: 'mcp__beta__echo', agent }), 'tool-disabled')
  assert.equal(h.activation.recordOf(agent).toolDenied.has('mcp__beta__echo'), true)
})

test('the conservative deny is guard-backed for every visible MCP name', async () => {
  const h = harness(baseState(), {
    getState: async () => { throw new Error('synthetic unreadable state') },
  })
  const agent = agentOf('a1', h.tools)
  const result = await h.activation.applyToAgent(agent, { conservative: true })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'resource-pool/activation-conservative')
  const record = h.activation.recordOf(agent)
  assert.deepEqual([...record.toolDenied].sort(), [
    'mcp__alpha__read',
    'mcp__alpha__search',
    'mcp__beta__echo',
    'mcp__hidden__x',
  ])
  assert.equal(h.getGuard()({ name: 'mcp__beta__echo', agent }), 'tool-disabled')
})

test('expansion is per Agent: A expands while B stays unexpanded', async () => {
  const h = harness(baseState())
  const a = agentOf('a1', h.tools)
  const b = agentOf('b1', h.tools)
  await h.activation.applyToAgent(a)
  await h.activation.applyToAgent(b)
  assert.equal(h.activation.expandService(a, 'alpha').ok, true)
  const guard = h.getGuard()
  assert.equal(guard({ name: 'mcp__alpha__search', agent: a }), undefined)
  assert.equal(guard({ name: 'mcp__alpha__search', agent: b }), 'server-not-expanded')
  assert.deepEqual(h.activation.recordOf(a).expandedServers, new Set(['alpha']))
  assert.deepEqual(h.activation.recordOf(b).expandedServers, new Set())
})

test('expanding a service does not lift a per-tool refusal', async () => {
  const h = harness(baseState({
    alpha: {
      enabled: true, modes: [], workspaces: [], disclosure: 'progressive',
      tools: { 'mcp__alpha__read': { enabled: false, modes: [], workspaces: [] } },
    },
  }))
  const agent = agentOf('a1', h.tools)
  await h.activation.applyToAgent(agent)
  const readLayer = h.layers.find((layer) => layer.active && layer.filter.deny.includes('mcp__alpha__read'))
  assert.ok(readLayer, 'the disabled tool has its own tool-reason layer')
  assert.deepEqual(h.activation.recordOf(agent).toolDenied, new Set(['mcp__alpha__read']))

  assert.equal(h.activation.expandService(agent, 'alpha').ok, true)
  const denied = h.layers.filter((l) => l.active).flatMap((l) => l.filter.deny)
  assert.ok(denied.includes('mcp__alpha__read'), 'the tool layer survives expansion')
  assert.ok(!denied.includes('mcp__alpha__search'), 'the progressive layer is lifted')
  assert.equal(h.getGuard()({ name: 'mcp__alpha__read', agent }), 'tool-disabled')
})

test('expansion survives a re-apply and is dropped when the service leaves progressive mode', async () => {
  const state = baseState()
  const h = harness(state)
  const agent = agentOf('a1', h.tools)
  await h.activation.applyToAgent(agent)
  assert.equal(h.activation.expandService(agent, 'alpha').ok, true)
  await h.activation.applyToAgent(agent, { force: true })
  assert.deepEqual(h.activation.recordOf(agent).expandedServers, new Set(['alpha']))
  assert.equal(h.getGuard()({ name: 'mcp__alpha__search', agent }), undefined)
  assert.ok(!h.layers.filter((l) => l.active).flatMap((l) => l.filter.deny).includes('mcp__alpha__search'))
  assert.equal(state.mcp.alpha.disclosure, 'progressive')

  // Switched back to full injection: the expansion fact is dropped.
  state.mcp.alpha.disclosure = 'full'
  await h.activation.applyToAgent(agent, { force: true })
  assert.deepEqual(h.activation.recordOf(agent).expandedServers, new Set())

  // Moved out of the Agent's pool: the expansion fact is dropped again.
  state.mcp.alpha.disclosure = 'progressive'
  await h.activation.applyToAgent(agent, { force: true })
  assert.equal(h.activation.expandService(agent, 'alpha').ok, true)
  state.mcp.alpha.modes = ['fleet']
  await h.activation.applyToAgent(agent, { force: true })
  assert.deepEqual(h.activation.recordOf(agent).expandedServers, new Set())
  assert.equal(h.getGuard()({ name: 'mcp__alpha__search', agent }), 'server-not-in-pool')
})

test('service scope and tool scope are ANDed', async () => {
  const h = harness(baseState({
    beta: {
      enabled: true, modes: ['standard'], workspaces: [], disclosure: 'full',
      tools: { 'mcp__beta__echo': { enabled: true, modes: ['fleet'], workspaces: [] } },
    },
  }))
  const agent = agentOf('a1', h.tools)
  await h.activation.applyToAgent(agent)
  const denied = h.layers.filter((l) => l.active).flatMap((l) => l.filter.deny)
  assert.ok(denied.includes('mcp__beta__echo'), 'service scope matches, tool scope does not')
  assert.equal(h.getGuard()({ name: 'mcp__beta__echo', agent }), 'tool-disabled')
})

test('expandService refuses while the MCP gate is off', async () => {
  const state = baseState()
  state.settings.mcpGate = false
  const h = harness(state)
  const agent = agentOf('a1', h.tools)
  await h.activation.applyToAgent(agent)
  assert.deepEqual(h.activation.expandService(agent, 'alpha'), { ok: false, error: 'not-in-pool' })
  assert.deepEqual(h.activation.recordOf(agent).expandedServers, new Set())
  assert.equal(h.getGuard()({ name: 'mcp__alpha__search', agent }), undefined)
})

test('a configured-off tool that registers after activation is denied and gets its layer after tools/change', async () => {
  const h = harness(baseState({
    beta: {
      enabled: true, modes: [], workspaces: [], disclosure: 'full',
      tools: { 'mcp__beta__echo': { enabled: false, modes: [], workspaces: [] } },
    },
  }))
  // The server is disconnected: its disabled tool is not registered yet.
  h.setSchemas([{ name: 'mcp__alpha__search', description: 'search' }])
  const agent = h.addLive(agentOf('a1', h.tools))
  await h.activation.applyToAgent(agent)
  assert.equal(h.getGuard()({ name: 'mcp__beta__echo', agent }), 'tool-disabled')
  assert.equal(h.activation.recordOf(agent).toolDenied.has('mcp__beta__echo'), true)
  assert.equal(
    h.layers.some((layer) => layer.active && layer.filter.deny.includes('mcp__beta__echo')),
    false,
    'there is no layer to install while the tool is unregistered',
  )

  // Reconnect registers the disabled tool and emits tools/change.
  h.registerTool({ name: 'mcp__beta__echo', description: 'echo' })
  await settle(() =>
    h.activation.recordOf(agent).disposers.some(
      (entry) => entry.label === 'mcp-restrict' && entry.reason === 'tool' && entry.deny.includes('mcp__beta__echo'),
    ),
  )
  assert.equal(h.getGuard()({ name: 'mcp__beta__echo', agent }), 'tool-disabled')
  assert.ok(
    h.layers.some((layer) => layer.active && layer.filter.deny.includes('mcp__beta__echo')),
    'the tool has a restrict layer again once it is registered',
  )
})

test('a tool that registers after activation gets its progressive layer without an explicit re-apply', async () => {
  const h = harness(baseState())
  h.setSchemas([{ name: 'mcp__alpha__search', description: 'search' }])
  const agent = h.addLive(agentOf('a1', h.tools))
  await h.activation.applyToAgent(agent)
  const newName = 'mcp__alpha__newtool'
  assert.equal(
    h.activation.recordOf(agent).disposers.some((entry) => entry.deny?.includes(newName)),
    false,
  )

  h.registerTool({ name: newName, description: 'newly registered' })
  await settle(() =>
    h.activation.recordOf(agent).disposers.some(
      (entry) => entry.label === 'mcp-restrict' && entry.reason === 'progressive' && entry.deny.includes(newName),
    ),
  )
  assert.equal(h.getGuard()({ name: newName, agent }), 'server-not-expanded')
  assert.ok(h.layers.some((layer) => layer.active && layer.filter.deny.includes(newName)))
})

test('a successful apply that retained an invisible layer is not an unreadable-state fallback', async () => {
  const h = harness(baseState({
    beta: {
      enabled: true, modes: [], workspaces: [], disclosure: 'full',
      tools: { 'mcp__beta__echo': { enabled: false, modes: [], workspaces: [] } },
    },
  }))
  const agent = agentOf('a1', h.tools)
  await h.activation.applyToAgent(agent)
  assert.equal(h.activation.recordOf(agent).stateUnreadable, false)

  // The disabled tool is temporarily invisible (a host generation change). Its
  // old layer is retained, which is conservative in the refresh sense only.
  h.setSchemas([{ name: 'mcp__alpha__search', description: 'search' }])
  await h.activation.applyToAgent(agent, { force: true })
  const record = h.activation.recordOf(agent)
  assert.equal(record.conservative, true, 'the retained layer keeps the refresh semantics')
  assert.equal(record.stateUnreadable, false, 'the document was readable, so discover stays offered')
})

test('a conservative fallback denies tools that register during the outage from a previously allowed server', async () => {
  const state = {
    version: 4,
    settings: { enabled: true, mcpGate: true, gateDefaultSkills: false },
    skills: {},
    sources: {},
    groups: {},
    mcp: { beta: { enabled: true, modes: [], workspaces: [], disclosure: 'full', tools: {} } },
  }
  let readable = true
  const h = harness(state, {
    getState: async () => {
      if (!readable) throw new Error('synthetic unreadable state')
      return state
    },
  })
  // A healthy activation that allows its only visible tool installs no layer.
  h.setSchemas([{ name: 'mcp__beta__echo', description: 'echo' }])
  const agent = h.addLive(agentOf('a1', h.tools))
  await h.activation.applyToAgent(agent)
  assert.equal(h.layers.length, 0)
  assert.equal(h.getGuard()({ name: 'mcp__beta__echo', agent }), undefined)
  assert.equal(h.activation.recordOf(agent).allowedServers.has('beta'), true)

  readable = false
  const result = await h.activation.applyToAgent(agent, { force: true, conservative: true })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'resource-pool/activation-conservative')
  const record = h.activation.recordOf(agent)
  assert.deepEqual([...record.allowedServers], [], 'the outage fallback denies every server, not the old snapshot')
  assert.equal(record.stateUnreadable, true)
  // A name that was allowed before the outage cannot slip through the old snapshot.
  assert.equal(h.getGuard()({ name: 'mcp__beta__brandnew', agent }), 'server-not-in-pool')
  assert.equal(h.getGuard()({ name: 'mcp__beta__echo', agent }), 'tool-disabled')

  h.registerTool({ name: 'mcp__beta__brandnew', description: 'registered during the outage' })
  await settle(() => h.layers.some((layer) => layer.active && layer.filter.deny.includes('mcp__beta__brandnew')))
  // The refreshed fallback lists every visible name, so the reason is
  // `tool-disabled`; it is still a refusal, which is the fail-closed contract.
  assert.notEqual(h.getGuard()({ name: 'mcp__beta__brandnew', agent }), undefined)
})
