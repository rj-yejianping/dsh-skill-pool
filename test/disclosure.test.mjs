import assert from 'node:assert/strict'
import test from 'node:test'
import { createMcpDisclosure, deriveDiscoverName } from '../src/disclosure.js'

/**
 * Fake document: `alpha` is a progressive service with one per-tool refusal and
 * a connection definition that must never reach a discover result; `beta` stays
 * fully injected.
 */
const baseState = () => ({
  settings: { enabled: true, mcpGate: true },
  mcp: {
    alpha: {
      enabled: true,
      disclosure: 'progressive',
      description: '知识库',
      tools: { 'mcp__alpha__read': { enabled: false } },
      definition: {
        url: 'http://secret.example',
        headers: { Authorization: 'token-secret' },
        env: { KEY: 'secret' },
      },
    },
    beta: { enabled: true, disclosure: 'full' },
  },
})

/**
 * Fake controller inputs. The registry `register` captures the `when` option the
 * real `tools.register` receives, rejects a duplicate exactly like the host, and
 * — also like the host — makes a registered tool appear in `schemas()`.
 */
function makeHarness(over = {}) {
  const state = over.state ?? baseState()
  const record = over.record ?? {
    activated: true,
    gateMcp: true,
    allowedServers: new Set(['alpha']),
    progressiveServers: new Set(['alpha']),
    expandedServers: new Set(),
    toolDenied: new Set(['mcp__alpha__read']),
  }
  const registered = new Map()
  const expanded = []
  const warnings = []
  let onRegister
  let schemas = over.schemas ?? [
    { name: 'mcp__alpha__search', description: 'search docs' },
    { name: 'mcp__alpha__read', description: 'read docs' },
  ]
  let manager
  let schemasThrows = over.schemasThrows === true
  const tools = {
    schemas: () => {
      if (schemasThrows) throw new Error('tool registry is unavailable')
      // A globally registered tool is visible here, exactly as in the host.
      return [
        ...schemas,
        ...[...registered.values()].map((def) => ({ name: def.name, description: def.description })),
      ]
    },
    register: (def, options) => {
      if (registered.has(def.name)) throw new Error(`tool "${def.name}" is already registered`)
      registered.set(def.name, { ...def, when: options?.when })
      // Registration publishes `tools/change`; the callback below models a
      // synchronous listener that calls back into sync.
      onRegister?.(def)
      return () => registered.delete(def.name)
    },
  }
  const ctx = {
    get: (name) => (name === 'mcpManager' ? manager : undefined),
    effect: (fn) => (typeof fn === 'function' ? fn() : () => {}),
    tools,
  }
  const controller = createMcpDisclosure({
    ctx,
    logger: {
      warn: (message) => warnings.push(message),
      debug() {},
    },
    getState: over.getState ?? (async () => state),
    recordOf: over.recordOf ?? (() => record),
    expandService:
      over.expandService ??
      ((agent, server) => {
        if (!record.progressiveServers.has(server)) return { ok: false, error: 'not-in-pool' }
        record.expandedServers.add(server)
        expanded.push(server)
        return { ok: true }
      }),
    modeOf: () => 'standard',
    workspaceOf: () => '/w',
    enabled: over.enabled ?? (() => true),
  })
  return {
    controller,
    registered,
    expanded,
    warnings,
    record,
    state,
    setSchemasThrows: (next) => {
      schemasThrows = next
    },
    setManager: (next) => {
      manager = next
    },
    setOnRegister: (next) => {
      onRegister = next
    },
  }
}

test('deriveDiscoverName sanitizes server names and refuses empty ones', () => {
  assert.deepEqual(deriveDiscoverName('openviking'), { name: 'openviking_discover', error: '' })
  assert.deepEqual(deriveDiscoverName('My KB'), { name: 'my_kb_discover', error: '' })
  assert.deepEqual(deriveDiscoverName('***'), { name: '', error: 'empty' })
})

test('deriveDiscoverName collapses separators, refuses leading digits and over-long names', () => {
  assert.deepEqual(deriveDiscoverName('  One__Two  '), { name: 'one_two_discover', error: '' })
  assert.deepEqual(deriveDiscoverName('9lives'), { name: '', error: 'invalid' })
  assert.deepEqual(deriveDiscoverName('a'.repeat(64)), { name: '', error: 'empty' })
})

test('sync registers only progressive services', () => {
  const h = makeHarness()
  h.controller.sync(h.state)
  assert.equal(h.registered.has('alpha_discover'), true)
  assert.equal(h.registered.has('beta_discover'), false)
})

test('the discover description carries the user description and the fixed template', () => {
  const h = makeHarness()
  h.controller.sync(h.state)
  const description = h.registered.get('alpha_discover').description
  assert.ok(description.startsWith('知识库'))
  assert.ok(description.includes('for this session'))
  assert.ok(description.includes('grants no extra permission'))
})

test('sync unregisters a service switched back to full', () => {
  const h = makeHarness()
  h.controller.sync(h.state)
  assert.equal(h.registered.has('alpha_discover'), true)
  h.controller.sync({
    ...h.state,
    mcp: { ...h.state.mcp, alpha: { ...h.state.mcp.alpha, disclosure: 'full' } },
  })
  assert.equal(h.registered.has('alpha_discover'), false)
})

test('sync is idempotent and refreshes the description on an edit', () => {
  const h = makeHarness()
  h.controller.sync(h.state)
  const first = h.registered.get('alpha_discover')
  assert.equal(h.registered.size, 1)
  // The fake registry now reports `alpha_discover` in `schemas()`, so this pass
  // only succeeds if our own registration is not mistaken for a conflict.
  h.controller.sync(h.state)
  assert.equal(h.registered.size, 1)
  // Retained, not re-registered: an unchanged document must not churn tools.
  assert.equal(h.registered.get('alpha_discover'), first)
  assert.deepEqual(h.warnings, [])
  h.state.mcp.alpha.description = '新的用途'
  h.controller.sync(h.state)
  assert.equal(h.registered.size, 1)
  assert.ok(h.registered.get('alpha_discover').description.startsWith('新的用途'))
})

test('a synchronous re-entrant sync returns immediately without a false conflict', () => {
  const h = makeHarness()
  let nested = 0
  h.setOnRegister(() => {
    // Models the host's synchronous `tools/change` listener calling back while
    // the outer registration exists but has not been recorded yet.
    nested += 1
    h.controller.sync(h.state)
  })
  h.controller.sync(h.state)
  assert.equal(nested, 1)
  assert.equal(h.registered.size, 1)
  assert.equal(h.registered.has('alpha_discover'), true)
  // The nested pass must not report our own fresh registration as taken.
  assert.deepEqual(h.warnings, [])
})

test('sync registers nothing while the MCP gate is off', () => {
  const h = makeHarness()
  h.controller.sync(h.state)
  assert.equal(h.registered.has('alpha_discover'), true)
  h.controller.sync({ ...h.state, settings: { ...h.state.settings, mcpGate: false } })
  assert.equal(h.registered.has('alpha_discover'), false)
})

test('sync registers nothing while the master switch is off', () => {
  const h = makeHarness()
  h.controller.sync(h.state)
  h.controller.sync({ ...h.state, settings: { ...h.state.settings, enabled: false } })
  assert.equal(h.registered.has('alpha_discover'), false)
})

test('sync registers nothing while progressive is not available', () => {
  const h = makeHarness({ enabled: () => false })
  h.controller.sync(h.state)
  assert.equal(h.registered.size, 0)
})

test('name conflict with an existing global tool refuses registration without throwing', () => {
  const h = makeHarness({
    state: {
      settings: { enabled: true, mcpGate: true },
      mcp: { 'open viking': { enabled: true, disclosure: 'progressive' } },
    },
    schemas: [{ name: 'open_viking_discover', description: 'taken' }],
  })
  assert.doesNotThrow(() => h.controller.sync(h.state))
  assert.equal(h.registered.has('open_viking_discover'), false)
})

test('two services deriving the same discover name register at most one', () => {
  const h = makeHarness({
    state: {
      settings: { enabled: true, mcpGate: true },
      mcp: {
        'a b': { enabled: true, disclosure: 'progressive' },
        'a-b': { enabled: true, disclosure: 'progressive' },
      },
    },
    schemas: [],
  })
  assert.doesNotThrow(() => h.controller.sync(h.state))
  assert.equal(h.registered.has('a_b_discover'), true)
  assert.equal(h.registered.size, 1)
})

test('discover expands and returns only allowed tools', async () => {
  const h = makeHarness()
  h.controller.sync(h.state)
  const payload = await h.registered.get('alpha_discover').execute({}, { agent: {} })
  assert.equal(payload.ok, true)
  assert.equal(payload.service, 'alpha')
  assert.equal(payload.expanded, true)
  assert.deepEqual(payload.tools.map((tool) => tool.name), ['mcp__alpha__search'])
  assert.equal(payload.tools[0].summary, 'search docs')
  assert.deepEqual(payload.hidden, { total: 2, disabled: 1, outOfScope: 0, ambiguous: 0 })
  assert.ok(h.expanded.includes('alpha'))
})

test('discover never returns the connection definition or its credentials', async () => {
  const h = makeHarness()
  h.controller.sync(h.state)
  const payload = await h.registered.get('alpha_discover').execute({}, { agent: {} })
  const serialized = JSON.stringify(payload)
  assert.equal(serialized.includes('secret.example'), false)
  assert.equal(serialized.includes('token-secret'), false)
  assert.equal(serialized.includes('definition'), false)
})

test('discover refuses when not in pool', async () => {
  const h = makeHarness()
  h.record.progressiveServers.clear()
  h.controller.sync(h.state)
  const payload = await h.registered.get('alpha_discover').execute({}, { agent: {} })
  assert.deepEqual(payload, { ok: false, error: 'not-in-pool' })
  assert.deepEqual(h.expanded, [])
})

test('discover refuses when the service left the allowed pool', async () => {
  const h = makeHarness()
  h.record.allowedServers.clear()
  h.controller.sync(h.state)
  const payload = await h.registered.get('alpha_discover').execute({}, { agent: {} })
  assert.deepEqual(payload, { ok: false, error: 'not-in-pool' })
})

test('discover refuses when the service switched back to full injection', async () => {
  const h = makeHarness()
  h.controller.sync(h.state)
  // The record still says progressive: the live document must win, because the
  // re-apply that follows a switch has not necessarily run yet.
  h.state.mcp.alpha.disclosure = 'full'
  const payload = await h.registered.get('alpha_discover').execute({}, { agent: {} })
  assert.deepEqual(payload, { ok: false, error: 'not-in-pool' })
})

test('discover reports an offline service and never expands it', async () => {
  const h = makeHarness()
  h.controller.sync(h.state)
  h.setManager({ list: () => [{ name: 'alpha', status: { state: 'failed' } }] })
  const payload = await h.registered.get('alpha_discover').execute({}, { agent: {} })
  assert.deepEqual(payload, { ok: false, error: 'offline', service: 'alpha' })
  assert.deepEqual(h.expanded, [])
})

test('discover degrades to the registry when the manager has no entry', async () => {
  const h = makeHarness()
  h.controller.sync(h.state)
  h.setManager({ list: () => [{ name: 'beta', status: { state: 'failed' } }] })
  const payload = await h.registered.get('alpha_discover').execute({}, { agent: {} })
  assert.equal(payload.ok, true)
})

test('discover fails honestly when the catalog is empty', async () => {
  const h = makeHarness({ schemas: [] })
  h.controller.sync(h.state)
  const payload = await h.registered.get('alpha_discover').execute({}, { agent: {} })
  assert.equal(payload.ok, false)
  assert.equal(payload.error, 'no-tools')
  assert.equal(payload.service, 'alpha')
  assert.deepEqual(h.expanded, [])
})

test('discover classifies per-tool refusals and never claims success on an empty catalog', async () => {
  const h = makeHarness({
    state: {
      settings: { enabled: true, mcpGate: true },
      mcp: {
        alpha: {
          enabled: true,
          disclosure: 'progressive',
          tools: {
            'mcp__alpha__read': { enabled: false },
            'mcp__alpha__search': { enabled: true, modes: ['fleet'], workspaces: [] },
          },
        },
      },
    },
    record: {
      activated: true,
      gateMcp: true,
      allowedServers: new Set(['alpha']),
      progressiveServers: new Set(['alpha']),
      expandedServers: new Set(),
      toolDenied: new Set(['mcp__alpha__read', 'mcp__alpha__search']),
    },
  })
  h.controller.sync(h.state)
  const payload = await h.registered.get('alpha_discover').execute({}, { agent: {} })
  assert.equal(payload.ok, false)
  assert.equal(payload.error, 'no-tools')
  assert.deepEqual(payload.hidden, { total: 2, disabled: 1, outOfScope: 1, ambiguous: 0 })
})

test('discover omits ambiguous tool names and counts them', async () => {
  const h = makeHarness({
    schemas: [
      { name: 'mcp__alpha__search', description: 'search docs' },
      { name: 'mcp__alpha__read', description: 'read docs' },
      { name: 'mcp__alpha__notes__v2', description: 'ambiguous origin' },
    ],
  })
  h.controller.sync(h.state)
  const payload = await h.registered.get('alpha_discover').execute({}, { agent: {} })
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.tools.map((tool) => tool.name), ['mcp__alpha__search'])
  assert.deepEqual(payload.hidden, { total: 3, disabled: 1, outOfScope: 0, ambiguous: 1 })
})

test('discover refuses when the state cannot be read', async () => {
  const h = makeHarness({
    getState: async () => {
      throw new Error('state file is corrupt')
    },
  })
  h.controller.sync(h.state)
  const payload = await h.registered.get('alpha_discover').execute({}, { agent: {} })
  assert.deepEqual(payload, { ok: false, error: 'state-unavailable' })
  assert.deepEqual(h.expanded, [])
})

test('discover refuses when the Agent has no activation record', async () => {
  const h = makeHarness({ recordOf: () => undefined })
  h.controller.sync(h.state)
  const payload = await h.registered.get('alpha_discover').execute({}, { agent: {} })
  assert.deepEqual(payload, { ok: false, error: 'state-unavailable' })
})

test('discover fails closed on malformed record collections', async () => {
  const h = makeHarness()
  h.controller.sync(h.state)
  const { execute } = h.registered.get('alpha_discover')
  const toolDenied = h.record.toolDenied
  // An unreadable per-tool snapshot must not become an empty (allowing) set.
  h.record.toolDenied = undefined
  assert.deepEqual(await execute({}, { agent: {} }), { ok: false, error: 'state-unavailable' })
  h.record.toolDenied = toolDenied
  // A malformed progressive set is "not in this Agent's pool", still refused.
  h.record.progressiveServers = undefined
  assert.deepEqual(await execute({}, { agent: {} }), { ok: false, error: 'not-in-pool' })
})

test('discover refuses when the tool catalog cannot be read', async () => {
  const h = makeHarness()
  h.controller.sync(h.state)
  h.setSchemasThrows(true)
  // The service is still targeted, so the entry is kept; a later sync cannot
  // verify names, so it must not add (or blindly remove) anything.
  h.controller.sync(h.state)
  assert.equal(h.registered.has('alpha_discover'), true)
  const payload = await h.registered.get('alpha_discover').execute({}, { agent: {} })
  assert.deepEqual(payload, { ok: false, error: 'tools-unavailable' })
  assert.deepEqual(h.expanded, [])
})

test('sync still removes stale entries while the tool list is unreadable', () => {
  const h = makeHarness()
  h.controller.sync(h.state)
  assert.equal(h.registered.has('alpha_discover'), true)
  h.setSchemasThrows(true)
  // alpha leaves the progressive target set, gamma joins it. Removal needs no
  // name list; the gamma addition does, so it is skipped instead of guessed.
  h.state.mcp.alpha.disclosure = 'full'
  h.state.mcp.gamma = { enabled: true, disclosure: 'progressive' }
  h.controller.sync(h.state)
  assert.equal(h.registered.has('alpha_discover'), false)
  assert.equal(h.registered.has('gamma_discover'), false)
})

test('an expansion refusal is mapped onto the documented error codes', async () => {
  const stale = makeHarness({ expandService: () => ({ ok: false, error: 'not-activated' }) })
  stale.controller.sync(stale.state)
  assert.deepEqual(
    await stale.registered.get('alpha_discover').execute({}, { agent: {} }),
    { ok: false, error: 'state-unavailable' },
  )
  const refused = makeHarness({ expandService: () => ({ ok: false, error: 'not-in-pool' }) })
  refused.controller.sync(refused.state)
  assert.deepEqual(
    await refused.registered.get('alpha_discover').execute({}, { agent: {} }),
    { ok: false, error: 'expand-failed' },
  )
  const broken = makeHarness({
    expandService: () => {
      throw new Error('upstream exploded')
    },
  })
  broken.controller.sync(broken.state)
  assert.deepEqual(
    await broken.registered.get('alpha_discover').execute({}, { agent: {} }),
    { ok: false, error: 'expand-failed' },
  )
})

test('discover reports a failed expansion instead of success', async () => {
  const h = makeHarness({ expandService: () => ({ ok: false, error: 'expand-failed' }) })
  h.controller.sync(h.state)
  const payload = await h.registered.get('alpha_discover').execute({}, { agent: {} })
  assert.deepEqual(payload, { ok: false, error: 'expand-failed' })
})

test('the discover registration is visible only to an activated, gated, progressive Agent', () => {
  const h = makeHarness()
  h.controller.sync(h.state)
  const when = h.registered.get('alpha_discover').when
  assert.equal(when({ agent: { id: 'a1' } }), true)
  assert.equal(when({}), false)
  assert.equal(when(undefined), false)
  h.record.activated = false
  assert.equal(when({ agent: { id: 'a1' } }), false)
  h.record.activated = true
  h.record.gateMcp = false
  assert.equal(when({ agent: { id: 'a1' } }), false)
  h.record.gateMcp = true
  h.record.progressiveServers.clear()
  assert.equal(when({ agent: { id: 'a1' } }), false)
})

test('an unreadable-state fallback record hides the entry and answers state-unavailable', async () => {
  const h = makeHarness()
  h.controller.sync(h.state)
  // The conservative activation keeps activated/gateMcp/snapshots but denies
  // every visible tool because the document was unreadable.
  h.record.conservative = true
  h.record.stateUnreadable = true
  h.record.toolDenied = new Set(['mcp__alpha__search', 'mcp__alpha__read'])
  assert.equal(h.registered.get('alpha_discover').when({ agent: { id: 'a1' } }), false)
  const payload = await h.registered.get('alpha_discover').execute({}, { agent: {} })
  assert.deepEqual(payload, { ok: false, error: 'state-unavailable' })
  assert.deepEqual(h.expanded, [])
})

test('a successful apply that merely retained an invisible layer still offers discover', async () => {
  const h = makeHarness()
  h.controller.sync(h.state)
  // A successful apply can set `conservative` for its refresh semantics (an old
  // layer covers a currently invisible name) without the document being
  // unreadable. That must not hide the discover entry.
  h.record.conservative = true
  assert.equal(h.record.stateUnreadable, undefined)
  assert.equal(h.registered.get('alpha_discover').when({ agent: { id: 'a1' } }), true)
  const payload = await h.registered.get('alpha_discover').execute({}, { agent: {} })
  assert.equal(payload.ok, true)
  assert.equal(payload.service, 'alpha')
  assert.deepEqual(h.expanded, ['alpha'])
})

test('the controller reports per-server discover registration failures without leaking names', () => {
  const conflict = makeHarness({
    state: {
      settings: { enabled: true, mcpGate: true },
      mcp: { 'open viking': { enabled: true, disclosure: 'progressive' } },
    },
    schemas: [{ name: 'open_viking_discover', description: 'taken' }],
  })
  conflict.controller.sync(conflict.state)
  assert.deepEqual(conflict.controller.statusOf('open viking'), { ok: false, reason: 'name-conflict' })
  const reported = JSON.stringify(conflict.controller.statusOf('open viking'))
  assert.equal(reported.includes('open_viking_discover'), false, 'the conflicting name is not echoed')

  const invalid = makeHarness({
    state: {
      settings: { enabled: true, mcpGate: true },
      mcp: { '9lives': { enabled: true, disclosure: 'progressive' } },
    },
    schemas: [],
  })
  invalid.controller.sync(invalid.state)
  assert.deepEqual(invalid.controller.statusOf('9lives'), { ok: false, reason: 'invalid-name' })

  const unreadable = makeHarness({ schemasThrows: true })
  unreadable.controller.sync(unreadable.state)
  assert.deepEqual(unreadable.controller.statusOf('alpha'), { ok: false, reason: 'tools-unavailable' })
})

test('the controller reports a registered entry as available and drops the status when it leaves progressive', () => {
  const h = makeHarness()
  h.controller.sync(h.state)
  assert.deepEqual(h.controller.statusOf('alpha'), { ok: true })
  assert.equal(h.controller.statusOf('beta'), null, 'a full-injection service has no discover entry')
  assert.equal(h.controller.statusOf('ghost'), null)
  h.state.mcp.alpha.disclosure = 'full'
  h.controller.sync(h.state)
  assert.equal(h.controller.statusOf('alpha'), null)
})

test('dispose releases every registration', () => {
  const h = makeHarness()
  h.controller.sync(h.state)
  assert.equal(h.registered.size, 1)
  h.controller.dispose()
  assert.equal(h.registered.size, 0)
})

test('preflight answers whether a service could register its discover entry without registering it', () => {
  const h = makeHarness()
  h.controller.sync(h.state)
  // `alpha` is the registered progressive service; our own registration is not
  // a conflict. `beta` is fully injected and its name is free.
  assert.deepEqual(h.controller.preflightOf('alpha'), { ok: true })
  assert.deepEqual(h.controller.preflightOf('beta'), { ok: true })

  const conflict = makeHarness({ schemas: [{ name: 'beta_discover', description: 'taken' }] })
  conflict.controller.sync(conflict.state)
  assert.deepEqual(conflict.controller.preflightOf('beta'), { ok: false, reason: 'name-conflict' })

  const invalid = makeHarness({ schemas: [] })
  invalid.controller.sync(invalid.state)
  assert.deepEqual(invalid.controller.preflightOf('9lives'), { ok: false, reason: 'invalid-name' })

  const unreadable = makeHarness({ schemasThrows: true })
  unreadable.controller.sync(unreadable.state)
  assert.deepEqual(unreadable.controller.preflightOf('beta'), { ok: false, reason: 'tools-unavailable' })
})
