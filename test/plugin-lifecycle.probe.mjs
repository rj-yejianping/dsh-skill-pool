/**
 * Host-wiring probe for `index.js` lifecycle and degraded-state recovery.
 *
 * Covers both halves the entry point owns: the per-Agent activation layers and
 * the global progressive-disclosure controller (discover entries, their
 * per-Agent visibility rule, the panel `onChanged` ordering and teardown).
 *
 * Deliberately not named `*.test.mjs`: importing `index.js` needs the installed
 * DSH tool packages, so this is not part of the portable default suite. It uses
 * a temporary state file and a fake Cordis context; it never touches a live
 * profile or the user's state.
 *
 * Run: node --test test/plugin-lifecycle.probe.mjs
 */

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { normalizeState } from '../src/store.js'
import { ROUTE_PREFIX } from '../src/web-api.js'

let pluginPromise
async function loadPlugin() {
  pluginPromise ??= import('../index.js')
  return pluginPromise
}

/** A valid state with one MCP member restricted to mode b. */
function validState() {
  return normalizeState({
    version: 4,
    settings: { enabled: true, mcpGate: true, gateDefaultSkills: false },
    skills: {}, sources: {}, groups: {},
    mcp: { kb: { enabled: true, modes: ['b'], workspaces: [], installedAt: '2026-11-18T00:00:00.000Z' } },
  })
}

/** A valid state whose one MCP member is configured for progressive injection. */
function progressiveState({ disclosure = 'progressive' } = {}) {
  return normalizeState({
    version: 4,
    settings: { enabled: true, mcpGate: true, gateDefaultSkills: false },
    skills: {}, sources: {}, groups: {},
    mcp: {
      kb: {
        enabled: true,
        modes: [],
        workspaces: [],
        disclosure,
        description: '知识库',
        installedAt: '2026-11-18T00:00:00.000Z',
      },
    },
  })
}

function makeAgent() {
  const restrictions = []
  return {
    session: { header: { agentPreset: 'a', cwd: '/workspace' } },
    restrictions,
    ctx: {
      get(name) {
        if (name === 'skills') return { registerProvider: () => () => {} }
        return undefined
      },
      effect(register) {
        const dispose = register()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      tools: {
        restrict(rule) {
          const entry = { deny: [...(rule?.deny ?? [])], disposed: false }
          restrictions.push(entry)
          return () => {
            entry.disposed = true
          }
        },
      },
      systemPrompt: { section: () => () => {} },
    },
  }
}

/** Poll a synchronous condition until it becomes true. */
async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for lifecycle transition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * Mount `apply()` over a fake context and expose its wiring.
 *
 * The fake host mirrors a real Cordis composition where `ctx.tools` and
 * `ctx.get('tools')` are the same service, so the activation layer and the
 * discover controller talk to one registry. `progressive` adds the global
 * `guard()` the activation layer requires before it offers progressive injection
 * at all; without it every mount would silently degrade to full injection.
 * `beforeList` runs on every `agents.list()` so a test can corrupt the document
 * exactly between a committed save and the re-apply it triggers.
 */
async function mount({ file, enabled = true, liveAgents = [], progressive = false, beforeList } = {}) {
  const { apply } = await loadPlugin()
  const handlers = new Map()
  const tools = []
  const registrations = []
  const guards = []
  const warnings = []
  const cleanups = []
  const injects = []
  const services = {
    tools: {
      schemas: () => [{ name: 'mcp__kb__search', description: 'search the knowledge base' }],
      register(definition, options = {}) {
        tools.push(definition)
        const entry = { name: definition?.name, when: options?.when, disposed: false }
        registrations.push(entry)
        return () => {
          entry.disposed = true
        }
      },
    },
    agents: {
      list() {
        beforeList?.()
        return liveAgents
      },
    },
  }
  if (progressive) {
    services.tools.guard = (rule) => {
      const entry = { rule, disposed: false }
      guards.push(entry)
      return () => {
        entry.disposed = true
      }
    }
  }
  const ctx = {
    logger: {
      warn(message) {
        warnings.push(String(message))
      },
      debug() {},
      info() {},
    },
    on(name, callback) {
      handlers.set(name, callback)
    },
    inject(names, callback) {
      injects.push({ names, callback })
    },
    effect(register) {
      const dispose = register()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return dispose
    },
    get(name) {
      return services[name]
    },
    tools: services.tools,
  }
  apply(ctx, { file, enabled })

  let fetchRoutes
  /** Register the panel's exact-fetch routes once, as a composition without a webServer does. */
  const panelRoutes = () => {
    if (fetchRoutes !== undefined) return fetchRoutes
    fetchRoutes = []
    const entry = injects.find(
      (candidate) => candidate.names.includes('webServer') && candidate.names.includes('connection'),
    )
    assert.equal(typeof entry?.callback, 'function', 'the plugin injects the panel transport')
    entry.callback({
      get(name) {
        // No webServer: the plugin falls back to exact-Fetch routes.
        if (name !== 'connection') return undefined
        return {
          fetch: {
            register(route) {
              fetchRoutes.push(route)
              return () => {}
            },
          },
        }
      },
      effect(register) {
        return register()
      },
    })
    return fetchRoutes
  }

  return {
    handlers,
    tools,
    registrations,
    guards,
    warnings,
    injects,
    status: tools.find((tool) => tool.name === 'resource_pool_status'),
    /** Invoke one panel route the way the Fetch transport would. */
    async panel(method, pathname, body) {
      const route = panelRoutes().find(
        (candidate) => candidate.path === `${ROUTE_PREFIX}${pathname}` && candidate.methods.includes(method),
      )
      assert.equal(typeof route?.fetch, 'function', `panel route ${method} ${pathname} is registered`)
      const response = await route.fetch({
        url: `http://x${ROUTE_PREFIX}${pathname}`,
        ...(body === undefined ? {} : { json: async () => body }),
      })
      return { status: response.status, payload: await response.json() }
    },
    async dispose() {
      for (const dispose of cleanups.reverse()) {
        try {
          dispose()
        } catch {
          /* already disposed */
        }
      }
    },
  }
}

/** Let pending startup work (one file read plus a reconcile) settle. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 50))
}

test('agent/created rejects when the state is unreadable and reports it through status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skill-pool-index-probe-'))
  const file = join(dir, 'state.json')
  try {
    await writeFile(file, '{"version":4,"mcp":', 'utf8')
    const mounted = await mount({ file })
    try {
      await assert.rejects(mounted.handlers.get('agent/created')({ agent: makeAgent() }), (error) => {
        assert.equal(error.code, 'resource-pool/state-invalid-json')
        return true
      })
      const status = await mounted.status.execute({}, { agent: makeAgent() })
      assert.equal(status.stateStatus.ok, false)
      assert.equal(status.stateStatus.code, 'resource-pool/state-invalid-json')
      assert.equal(status.pool, null)
    } finally {
      await mounted.dispose()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('repairing the file restores creation and a normal restriction without rewriting it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skill-pool-index-probe-'))
  const file = join(dir, 'state.json')
  try {
    await writeFile(file, JSON.stringify(validState()), 'utf8')
    const mounted = await mount({ file })
    try {
      const agent = makeAgent()
      await mounted.handlers.get('agent/created')({ agent })
      assert.deepEqual(agent.restrictions[0].deny, ['mcp__kb__search'])
      const status = await mounted.status.execute({}, { agent })
      assert.equal(status.stateStatus.ok, true)
      assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 4)
    } finally {
      await mounted.dispose()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the profile-level disabled switch does not turn corrupt state into a creation failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skill-pool-index-probe-'))
  const file = join(dir, 'state.json')
  try {
    await writeFile(file, '{"version":4,"mcp":', 'utf8')
    const mounted = await mount({ file, enabled: false })
    try {
      const agent = makeAgent()
      await mounted.handlers.get('agent/created')({ agent })
      assert.equal(agent.restrictions.length, 0)
      // Diagnostics still tell the truth about the stored document.
      const status = await mounted.status.execute({}, { agent })
      assert.equal(status.stateStatus.ok, false)
    } finally {
      await mounted.dispose()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reapplyAll lifecycle fallback denies visible MCP tools for a live Agent when state is corrupt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skill-pool-index-probe-'))
  const file = join(dir, 'state.json')
  const live = makeAgent()
  try {
    await writeFile(file, '{"version":4,"mcp":', 'utf8')
    const mounted = await mount({ file, liveAgents: [live] })
    try {
      const agentsInject = mounted.injects.find((entry) => entry.names.includes('agents'))
      assert.equal(typeof agentsInject?.callback, 'function')
      agentsInject.callback()
      await waitFor(() => live.restrictions.length > 0)
      assert.deepEqual(live.restrictions[0]?.deny, ['mcp__kb__search'])

      // Repairing and explicitly re-applying replaces the fallback after the
      // normal deny is installed.
      await writeFile(file, JSON.stringify(validState()), 'utf8')
      mounted.injects.find((entry) => entry.names.includes('agents')).callback()
      await waitFor(() => live.restrictions[0]?.disposed === true)
      const status = await mounted.status.execute({}, { agent: live })
      assert.equal(status.stateStatus.ok, true)
      assert.equal(live.restrictions[0].disposed, true)
      assert.deepEqual(live.restrictions.at(-1).deny, ['mcp__kb__search'])
    } finally {
      await mounted.dispose()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('startup publishes a discover entry per progressive service, gated by the Agent record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skill-pool-index-probe-'))
  const file = join(dir, 'state.json')
  try {
    await writeFile(file, JSON.stringify(progressiveState()), 'utf8')
    const mounted = await mount({ file, progressive: true })
    try {
      await waitFor(() => mounted.registrations.some((entry) => entry.name === 'kb_discover'))
      const discover = mounted.registrations.find((entry) => entry.name === 'kb_discover')
      assert.equal(typeof discover.when, 'function')
      // The entry is global; before an activation record exists it must stay
      // invisible instead of guessing what the pool holds.
      const early = makeAgent()
      assert.equal(discover.when({ agent: early }), false)
      await mounted.handlers.get('agent/created')({ agent: early })
      assert.equal(discover.when({ agent: early }), true)

      const definition = mounted.tools.find((tool) => tool.name === 'kb_discover')
      assert.equal(typeof definition?.execute, 'function')
      assert.match(definition.description, /"kb"/)
      // Registering the discover entry did not disturb the status tool.
      assert.equal(mounted.registrations.find((entry) => entry.name === 'resource_pool_status').when, undefined)
    } finally {
      await mounted.dispose()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the profile master switch registers no discover entry and gates no Agent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skill-pool-index-probe-'))
  const file = join(dir, 'state.json')
  try {
    await writeFile(file, JSON.stringify(progressiveState()), 'utf8')
    const mounted = await mount({ file, enabled: false, progressive: true })
    try {
      await settle()
      assert.equal(mounted.registrations.some((entry) => entry.name === 'kb_discover'), false)
      const agent = makeAgent()
      await mounted.handlers.get('agent/created')({ agent })
      assert.equal(agent.restrictions.length, 0)
      assert.equal(mounted.registrations.some((entry) => entry.name === 'kb_discover'), false)
    } finally {
      await mounted.dispose()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('without the global guard no discover entry is offered and the service injects fully', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skill-pool-index-probe-'))
  const file = join(dir, 'state.json')
  try {
    await writeFile(file, JSON.stringify(progressiveState()), 'utf8')
    const mounted = await mount({ file })
    try {
      await settle()
      // Progressive without a dispatch-time backstop would hide a schema it
      // cannot refuse, so the whole load degrades to full injection.
      assert.equal(mounted.registrations.some((entry) => entry.name === 'kb_discover'), false)
      assert.equal(
        mounted.warnings.some((line) => line.includes('global MCP guard unavailable')),
        true,
      )
      const agent = makeAgent()
      await mounted.handlers.get('agent/created')({ agent })
      assert.equal(agent.restrictions.length, 0)
    } finally {
      await mounted.dispose()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('unload releases the discover entry, the global guard and the Agent layers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skill-pool-index-probe-'))
  const file = join(dir, 'state.json')
  try {
    await writeFile(file, JSON.stringify(progressiveState()), 'utf8')
    const agent = makeAgent()
    const mounted = await mount({ file, progressive: true, liveAgents: [agent] })
    try {
      await waitFor(() => mounted.registrations.some((entry) => entry.name === 'kb_discover'))
      const discover = mounted.registrations.find((entry) => entry.name === 'kb_discover')
      const guard = mounted.guards[0]
      assert.equal(typeof guard?.rule, 'function')
      await mounted.handlers.get('agent/created')({ agent })
      assert.deepEqual(agent.restrictions.at(-1)?.deny, ['mcp__kb__search'])
      assert.equal(discover.when({ agent }), true)

      await mounted.dispose()

      assert.equal(discover.disposed, true)
      assert.equal(guard.disposed, true)
      assert.equal(agent.restrictions.every((entry) => entry.disposed), true)
      // The record is gone with the plugin: the entry cannot be reached anymore.
      assert.equal(discover.when({ agent }), false)
    } finally {
      await mounted.dispose()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a committed panel save re-applies live Agents before reconciling discover', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skill-pool-index-probe-'))
  const file = join(dir, 'state.json')
  const live = makeAgent()
  try {
    await writeFile(file, JSON.stringify(progressiveState({ disclosure: 'full' })), 'utf8')
    const mounted = await mount({ file, liveAgents: [live], progressive: true })
    try {
      await mounted.handlers.get('agent/created')({ agent: live })
      assert.equal(mounted.registrations.some((entry) => entry.name === 'kb_discover'), false)

      const response = await mounted.panel('POST', '/mcp/config', { server: 'kb', disclosure: 'progressive' })
      assert.equal(response.status, 200)
      assert.equal(response.payload.ok, true)
      assert.equal(response.payload.state.mcp.kb.disclosure, 'progressive')
      // No degraded re-apply, so the panel receives no warning.
      assert.equal(response.payload.warning, undefined)

      // The live Agent was re-applied (the progressive deny landed) ...
      assert.deepEqual(live.restrictions.at(-1)?.deny, ['mcp__kb__search'])
      // ... and the discover registry was reconciled before the response: the
      // registration exists synchronously here and answers from the new record.
      const discover = mounted.registrations.find((entry) => entry.name === 'kb_discover')
      assert.equal(typeof discover?.when, 'function')
      assert.equal(discover.when({ agent: live }), true)
    } finally {
      await mounted.dispose()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a discover sync that cannot read the document never fails the panel save', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skill-pool-index-probe-'))
  const file = join(dir, 'state.json')
  const live = makeAgent()
  try {
    await writeFile(file, JSON.stringify(progressiveState({ disclosure: 'full' })), 'utf8')
    // Corrupt the document exactly inside the re-apply that follows a commit, so
    // the controller's own read happens after the save has already succeeded.
    const mounted = await mount({
      file,
      liveAgents: [live],
      progressive: true,
      beforeList: () => writeFileSync(file, '{"version":4,"mcp":'),
    })
    try {
      await mounted.handlers.get('agent/created')({ agent: live })
      const response = await mounted.panel('POST', '/mcp/config', { server: 'kb', description: '知识库' })
      // The state was committed; the failed discover sync is logged, not thrown,
      // and the re-apply result still reaches the panel.
      assert.equal(response.status, 200)
      assert.equal(response.payload.ok, true)
      assert.equal(typeof response.payload.warning?.code, 'string')
      assert.equal(
        mounted.warnings.some((line) => line.includes('discover registry sync failed')),
        true,
      )
      assert.equal(mounted.registrations.some((entry) => entry.name === 'kb_discover'), false)
    } finally {
      await mounted.dispose()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
