/**
 * Host-wiring probe for `index.js` lifecycle and degraded-state recovery.
 *
 * Deliberately not named `*.test.mjs`: importing `index.js` needs the installed
 * DSH tool packages, so this is not part of the portable default suite. It uses
 * a temporary state file and a fake Cordis context; it never touches a live
 * profile or the user's state.
 *
 * Run: node --test test/plugin-lifecycle.probe.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { normalizeState } from '../src/store.js'

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

/** Mount `apply()` over a fake context and expose its wiring. */
async function mount({ file, enabled = true, liveAgents = [] } = {}) {
  const { apply } = await loadPlugin()
  const handlers = new Map()
  const tools = []
  const cleanups = []
  const injects = []
  const services = {
    tools: { schemas: () => [{ name: 'mcp__kb__search' }] },
    agents: { list: () => liveAgents },
  }
  const ctx = {
    logger: { warn() {}, debug() {}, info() {} },
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
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
  }
  apply(ctx, { file, enabled })
  return {
    handlers,
    tools,
    injects,
    status: tools.find((tool) => tool.name === 'resource_pool_status'),
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
