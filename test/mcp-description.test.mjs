/**
 * Task 2 — the MCP purpose summary (description) API, public-state projection
 * and the per-Agent model summary.
 *
 * These tests drive the real route handlers registered by `registerWebApi`
 * against a real `StateStore` on a temporary file, so they cover the same path
 * the Settings panel uses. No real credentials appear anywhere: every token
 * below is an obvious fixture that must never be returned.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createActivation } from '../src/activation.js'
import { ROUTE_PREFIX, registerWebApi } from '../src/web-api.js'
import { normalizeState, StateStore, upsertItem } from '../src/store.js'

const SECRET_HEADER = 'Bearer header-fixture-not-a-real-token'
const SECRET_ENV = 'env-fixture-not-a-real-token'
const SECRET_URL = 'url-fixture-not-a-real-token'
const SECRETS = [SECRET_HEADER, SECRET_ENV, SECRET_URL, 'header-fixture-not-a-real-token']

/** Fixture document: one described MCP member, one without a purpose summary. */
function fixtureState() {
  return normalizeState({
    version: 4,
    settings: { enabled: true, mcpGate: true, injectSummary: true, gateDefaultSkills: false },
    skills: {},
    sources: {},
    groups: {},
    mcp: {
      kb: {
        enabled: true,
        modes: ['a'],
        workspaces: [],
        description: 'Knowledge base search',
        installedAt: '2026-11-18T00:00:00.000Z',
        definition: {
          serverName: 'kb',
          transport: 'streamable-http',
          url: `https://mcp.example.test/mcp?token=${SECRET_URL}`,
          headers: { Authorization: SECRET_HEADER },
          env: { API_KEY: SECRET_ENV },
        },
      },
      private: {
        enabled: true,
        modes: ['b'],
        workspaces: [],
        installedAt: '2026-11-18T00:00:00.000Z',
        definition: { serverName: 'private', command: 'npx', args: ['-y', 'private-mcp'], env: { TOKEN: SECRET_ENV } },
      },
    },
  })
}

/** Assert that every secret and every connection definition is absent. */
function assertProjected(payload, label = 'response') {
  const text = JSON.stringify(payload)
  for (const secret of SECRETS) {
    assert.equal(text.includes(secret), false, `${label} leaked ${secret}`)
  }
  for (const name of ['kb', 'private']) {
    const member = payload?.state?.mcp?.[name]
    if (member === undefined) continue
    assert.equal(Object.hasOwn(member, 'definition'), false, `${label} exposed state.mcp.${name}.definition`)
  }
}

/** Build an API bound to a temporary store and the real route handlers. */
async function makeApi(initial = fixtureState()) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pool-description-'))
  const file = join(dir, 'state.json')
  const store = new StateStore({ file })
  await store.write(initial)
  const handlers = new Map()
  const services = {
    connection: {
      admit: () => ({}),
      fetch: {
        register(route) {
          const key = `${route.methods[0]} ${route.path}`
          handlers.set(key, route.fetch)
          return () => handlers.delete(key)
        },
      },
    },
  }
  const ctx = {
    get: (name) => services[name],
    inject: (_names, callback) =>
      callback({ get: (name) => services[name], effect: (register) => register() }),
    effect: (register) => register(),
  }
  registerWebApi({ ctx, store, meta: { file, version: 'test' }, onChanged: async () => {}, logger: {} })

  const call = async (method, suffix, body) => {
    const handler = handlers.get(`${method} ${ROUTE_PREFIX}${suffix}`)
    assert.equal(typeof handler, 'function', `route ${method} ${suffix} is registered`)
    const init = { method }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const response = await handler(new Request(`http://dsh.invalid${ROUTE_PREFIX}${suffix}`, init))
    return { status: response.status, payload: await response.json() }
  }

  return {
    call,
    store,
    file,
    async persisted() {
      return JSON.parse(await readFile(file, 'utf8'))
    },
    async dispose() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('overview returns purposes and scopes but never an MCP definition or its secrets', async () => {
  const api = await makeApi()
  try {
    const { status, payload } = await api.call('GET', '')
    assert.equal(status, 200)
    assert.equal(payload.ok, true)
    assertProjected(payload, 'overview')
    assert.equal(payload.state.mcp.kb.description, 'Knowledge base search')
    assert.deepEqual(payload.state.mcp.kb.modes, ['a'])
    assert.deepEqual(payload.state.mcp.kb.workspaces, [])
    assert.equal(payload.state.mcp.kb.enabled, true)
    assert.equal(payload.state.mcp.private.description, undefined)

    const kb = payload.inventory.mcp.find((row) => row.server === 'kb')
    assert.equal(kb.description, 'Knowledge base search')
    assert.equal(Object.hasOwn(kb, 'definition'), false)

    // Redaction is response-only: the persisted definition still re-mounts.
    const saved = await api.persisted()
    assert.equal(saved.mcp.kb.definition.headers.Authorization, SECRET_HEADER)
    assert.equal(saved.mcp.kb.definition.env.API_KEY, SECRET_ENV)
  } finally {
    await api.dispose()
  }
})

test('every committed mutation response uses the same safe state projection', async () => {
  const api = await makeApi()
  try {
    const calls = [
      ['POST', '/item', { kind: 'mcp', name: 'kb', enabled: true }],
      ['POST', '/settings', { patch: { mcpGate: true } }],
      ['POST', '/group', { key: 'repo:example/project', modes: [] }],
      ['POST', '/source/check', {}],
    ]
    for (const [method, suffix, body] of calls) {
      const { status, payload } = await api.call(method, suffix, body)
      assert.equal(status, 200, `${method} ${suffix} succeeded`)
      assertProjected(payload, `${method} ${suffix}`)
    }
  } finally {
    await api.dispose()
  }
})

test('an existing MCP member description can be set, bounded and cleared without touching its definition', async () => {
  const api = await makeApi()
  try {
    const saved = await api.call('POST', '/item', {
      kind: 'mcp',
      name: 'kb',
      description: '  Search the internal knowledge base.  ',
    })
    assert.equal(saved.status, 200)
    assertProjected(saved.payload, 'description save')
    assert.equal(saved.payload.state.mcp.kb.description, 'Search the internal knowledge base.')
    assert.deepEqual(saved.payload.state.mcp.kb.modes, ['a'])

    const refreshed = await api.call('GET', '')
    assert.equal(refreshed.payload.state.mcp.kb.description, 'Search the internal knowledge base.')
    assert.equal((await api.persisted()).mcp.kb.definition.headers.Authorization, SECRET_HEADER)

    const atLimit = await api.call('POST', '/item', { kind: 'mcp', name: 'kb', description: 'x'.repeat(300) })
    assert.equal(atLimit.status, 200)
    assert.equal(atLimit.payload.state.mcp.kb.description.length, 300)
    const tooLong = await api.call('POST', '/item', { kind: 'mcp', name: 'kb', description: 'x'.repeat(301) })
    assert.equal(tooLong.status, 400)
    assert.equal((await api.call('GET', '')).payload.state.mcp.kb.description, 'x'.repeat(300))

    const cleared = await api.call('POST', '/item', { kind: 'mcp', name: 'kb', description: '' })
    assert.equal(cleared.status, 200)
    assert.equal(cleared.payload.state.mcp.kb.description, undefined)
    const savedDoc = await api.persisted()
    assert.equal(Object.hasOwn(savedDoc.mcp.kb, 'description'), false)
    assert.equal(savedDoc.mcp.kb.definition.headers.Authorization, SECRET_HEADER)
  } finally {
    await api.dispose()
  }
})

test('a description edit never creates a member, changes a skill or accepts a non-string', async () => {
  const api = await makeApi()
  try {
    const ghost = await api.call('POST', '/item', { kind: 'mcp', name: 'ghost', description: 'invented' })
    assert.equal(ghost.status, 400)
    assert.equal((await api.call('GET', '')).payload.state.mcp.ghost, undefined)

    const skill = await api.call('POST', '/item', { kind: 'skill', name: 'ghost-skill', description: 'invented' })
    assert.equal(skill.status, 400)
    assert.equal((await api.call('GET', '')).payload.state.skills['ghost-skill'], undefined)

    const wrongType = await api.call('POST', '/item', { kind: 'mcp', name: 'kb', description: 42 })
    assert.equal(wrongType.status, 400)
    assert.equal((await api.call('GET', '')).payload.state.mcp.kb.description, 'Knowledge base search')
  } finally {
    await api.dispose()
  }
})

test('a condition edit without the description property keeps the stored purpose', async () => {
  const api = await makeApi()
  try {
    const edited = await api.call('POST', '/item', {
      kind: 'mcp',
      name: 'kb',
      enabled: false,
      modes: ['b'],
      workspaces: [],
      modesFrom: 'self',
      workspacesFrom: 'self',
    })
    assert.equal(edited.status, 200)
    assert.equal(edited.payload.state.mcp.kb.description, 'Knowledge base search')
    assert.deepEqual(edited.payload.state.mcp.kb.modes, ['b'])
    assert.equal(edited.payload.state.mcp.kb.enabled, false)
    const saved = await api.persisted()
    assert.equal(saved.mcp.kb.description, 'Knowledge base search')
    assert.equal(saved.mcp.kb.definition.headers.Authorization, SECRET_HEADER)
  } finally {
    await api.dispose()
  }
})

test('re-importing a connection without a description keeps the stored purpose', async () => {
  const api = await makeApi()
  try {
    const imported = await api.call('POST', '/mcp/import', {
      payload: { mcpServers: { kb: { url: 'https://mcp2.example.test/mcp' } } },
      scope: { modes: ['a'] },
    })
    assert.equal(imported.status, 200)
    assertProjected(imported.payload, 'mcp import')
    assert.equal(imported.payload.state.mcp.kb.description, 'Knowledge base search')
    const saved = await api.persisted()
    assert.equal(saved.mcp.kb.description, 'Knowledge base search')
    assert.equal(saved.mcp.kb.definition.url, 'https://mcp2.example.test/mcp')
  } finally {
    await api.dispose()
  }
})

/** One fake live Agent whose registrations this harness can inspect. */
function makeAgent({ mode, cwd }) {
  const sections = []
  const denies = []
  const agent = {
    session: { header: { agentPreset: mode, cwd } },
    sections,
    denies,
    ctx: {
      modeId: mode,
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
          denies.push([...(rule?.deny ?? [])])
          return () => {}
        },
      },
      systemPrompt: {
        section({ text }) {
          sections.push(text)
          return () => {
            const index = sections.indexOf(text)
            if (index >= 0) sections.splice(index, 1)
          }
        },
      },
    },
  }
  return agent
}

/** An activation manager over mutable state with two fake Agents. */
function makeActivation(initial, { promptLanguage = () => 'zh' } = {}) {
  const stateRef = { current: normalizeState(initial) }
  const agents = []
  const services = {
    agentPresets: { composedPreset: (agentCtx) => agentCtx.modeId },
    agents: { list: () => agents },
    systemPrompt: { getSectionOrder: () => 100 },
    tools: { schemas: () => [{ name: 'mcp__kb__search' }, { name: 'mcp__private__x' }] },
  }
  const ctx = { get: (name) => services[name] }
  const activation = createActivation({
    ctx,
    getState: async () => stateRef.current,
    promptLanguage,
    libraryRoot: () => '/nonexistent-library',
    logger: {},
  })
  return {
    stateRef,
    activation,
    addAgent(mode, cwd) {
      const agent = makeAgent({ mode, cwd })
      agents.push(agent)
      return agent
    },
  }
}

test('the model summary shows only the current Agent MCP services and their purposes', async () => {
  const harness = makeActivation(fixtureState())
  const a = harness.addAgent('a', '/workspace/a')
  const b = harness.addAgent('b', '/workspace/b')
  try {
    await harness.activation.applyToAgent(a)
    await harness.activation.applyToAgent(b)

    const textA = a.sections.at(-1)
    assert.ok(textA.includes('kb'), 'Agent A sees its authorized server')
    assert.ok(textA.includes('Knowledge base search'), 'Agent A sees the server purpose')
    assert.equal(textA.includes('private'), false, 'Agent A never sees the unauthorized server')
    for (const secret of SECRETS) assert.equal(textA.includes(secret), false)

    const textB = b.sections.at(-1)
    assert.ok(textB.includes('private'), 'Agent B sees its authorized server')
    assert.equal(textB.includes('kb'), false, 'Agent B never sees Agent A server')
    assert.ok(
      textB.includes('未填写用途摘要'),
      'an authorized service without a purpose is called out explicitly',
    )
  } finally {
    harness.activation.disposeAll()
  }
})

test('an English summary marks a missing purpose in English too', async () => {
  const harness = makeActivation(fixtureState(), { promptLanguage: () => 'en' })
  const b = harness.addAgent('b', '/workspace/b')
  try {
    await harness.activation.applyToAgent(b)
    const text = b.sections.at(-1)
    assert.ok(text.includes('private'))
    assert.ok(text.toLowerCase().includes('no purpose summary'), text)
    assert.equal(text.includes('kb'), false)
  } finally {
    harness.activation.disposeAll()
  }
})

test('changing a purpose recomputes the summary without a forced re-apply', async () => {
  const harness = makeActivation(fixtureState())
  const a = harness.addAgent('a', '/workspace/a')
  try {
    await harness.activation.applyToAgent(a)
    assert.ok(a.sections.at(-1).includes('Knowledge base search'))

    const kb = harness.stateRef.current.mcp.kb
    harness.stateRef.current = upsertItem(harness.stateRef.current, 'mcp', 'kb', kb, {
      description: 'Changed knowledge base purpose',
    })

    // No `force`: the description is part of the activation signature, so an
    // ordinary re-apply must notice it.
    await harness.activation.applyToAgent(a)
    const text = a.sections.at(-1)
    assert.ok(text.includes('Changed knowledge base purpose'), text)
    assert.equal(text.includes('Knowledge base search'), false)
  } finally {
    harness.activation.disposeAll()
  }
})
