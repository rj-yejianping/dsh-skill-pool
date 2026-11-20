import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { StateStore } from '../src/store.js'
import { ROUTE_PREFIX, publicMcpMember, registerWebApi } from '../src/web-api.js'

/**
 * One v4 document with two MCP members:
 *
 * - `alpha` carries display configuration, a connection definition holding a
 *   secret, and one historical per-tool entry whose tool is not registered.
 * - `beta` exists only so a tool name can be attributed to the wrong service.
 */
function fixtureState() {
  return {
    version: 4,
    settings: { enabled: true, mcpGate: true, gateDefaultSkills: false },
    skills: {},
    sources: {},
    groups: {},
    mcp: {
      alpha: {
        enabled: true,
        modes: [],
        workspaces: [],
        description: '知识库',
        disclosure: 'full',
        tools: { 'mcp__alpha__gone': { enabled: false, modes: [], workspaces: [] } },
        definition: {
          transport: 'streamable-http',
          url: 'http://secret',
          headers: { Authorization: 'x' },
        },
        installedAt: '2026-11-01T00:00:00.000Z',
      },
      beta: {
        enabled: true,
        modes: [],
        workspaces: [],
        description: '',
        disclosure: 'full',
        tools: {},
        installedAt: '2026-11-01T00:00:00.000Z',
      },
    },
  }
}

/** Tool schemas the fake global tool registry reports. */
function fixtureSchemas() {
  return [
    { name: 'mcp__alpha__search', description: 'search docs' },
    { name: 'mcp__alpha__read', description: 'read one doc' },
    // Two possible server separators: attributable by prefix only, so an
    // ambiguous name must never be saved through the per-tool route.
    { name: 'mcp__alpha__x__y', description: 'ambiguous name' },
    { name: 'mcp__beta__x', description: 'other service' },
    { name: 'resource_pool_status', description: 'not an MCP tool' },
  ]
}

/**
 * Build the real route handlers over a temporary Store plus a fake context.
 *
 * `registerWebApi` returns its internal `routes` array so a Node test can call
 * one handler directly, without a web server or a connection service.
 */
async function apiHarness({ toolsUnavailable = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'skill-pool-web-api-mcp-'))
  const file = join(dir, 'state.json')
  const store = new StateStore({ file })
  await store.write(fixtureState())
  const services = toolsUnavailable ? {} : { tools: { schemas: () => fixtureSchemas() } }
  const ctx = {
    get: (name) => services[name],
    inject: (_names, callback) =>
      callback({ get: (name) => services[name], effect: (register) => register() }),
    effect: (register) => register(),
  }
  const registry = registerWebApi({ ctx, store, meta: { file, version: 'test' }, onChanged: async () => {}, logger: {} })
  assert.ok(Array.isArray(registry.routes), 'registerWebApi returns its routes array')

  const invoke = async (method, target, body) => {
    const pathname = target.split('?')[0]
    const route = registry.routes.find(([suffix, methods]) => suffix === pathname && methods.includes(method))
    assert.equal(typeof route?.[2], 'function', `route ${method} ${pathname} is registered`)
    const request = {
      url: `http://x${ROUTE_PREFIX}${target}`,
      ...(body === undefined ? {} : { json: async () => body }),
    }
    const response = await route[2](request)
    return { status: response.status, payload: await response.json() }
  }
  const call = async (method, target, body) => (await invoke(method, target, body)).payload

  return {
    call,
    invoke,
    store,
    routes: registry.routes,
    async dispose() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('public projection keeps config and drops the connection definition', () => {
  const view = publicMcpMember({
    enabled: true,
    modes: [],
    workspaces: [],
    description: 'd',
    disclosure: 'progressive',
    tools: {},
    definition: { url: 'http://secret', headers: { Authorization: 'x' } },
  })
  assert.equal(view.description, 'd')
  assert.equal(view.disclosure, 'progressive')
  assert.equal(view.definition, undefined)
  assert.equal(JSON.stringify(view).includes('secret'), false)
})

test('public projection defaults description, disclosure and tools', () => {
  const view = publicMcpMember({ enabled: true, modes: [], workspaces: [] })
  assert.equal(view.description, '')
  assert.equal(view.disclosure, 'full')
  assert.deepEqual(view.tools, {})
  assert.equal(view.definition, undefined)
})

test('public projection deep-copies per-tool config', () => {
  const source = { enabled: true, modes: [], workspaces: [], tools: { 'mcp__alpha__search': { enabled: false, modes: ['draft'], workspaces: [] } } }
  const view = publicMcpMember(source)
  view.tools['mcp__alpha__search'].modes.push('mutated')
  assert.deepEqual(source.tools['mcp__alpha__search'].modes, ['draft'])
})

test('GET /mcp/tools lists current tools plus preserved history', async () => {
  const api = await apiHarness()
  try {
    const payload = await api.call('GET', '/mcp/tools?server=alpha')
    assert.equal(payload.ok, true)
    assert.equal(payload.server, 'alpha')
    assert.equal(payload.description, '知识库')
    assert.equal(payload.disclosure, 'full')
    const names = payload.tools.map((t) => t.name)
    assert.ok(names.includes('mcp__alpha__search'))
    assert.ok(names.includes('mcp__alpha__read'))
    assert.equal(payload.tools.find((t) => t.name === 'mcp__alpha__search').registered, true)

    const byName = new Map(payload.tools.map((tool) => [tool.name, tool]))
    assert.equal(byName.get('mcp__alpha__search').summary, 'search docs')
    assert.equal(byName.get('mcp__alpha__search').config, null)
    assert.equal(byName.get('mcp__alpha__search').ambiguous, false)

    // A tool that disappeared keeps its stored configuration, marked unavailable.
    const history = byName.get('mcp__alpha__gone')
    assert.equal(history.registered, false)
    assert.deepEqual(history.config, { enabled: false, modes: [], workspaces: [] })

    assert.equal(byName.get('mcp__alpha__x__y').ambiguous, true)
    // Another service's tools and non-MCP tools are not listed.
    assert.equal(names.includes('mcp__beta__x'), false)
    assert.equal(names.includes('resource_pool_status'), false)
    // No connection data may reach the browser.
    assert.equal(JSON.stringify(payload).includes('secret'), false)
    assert.equal(JSON.stringify(payload).includes('Authorization'), false)
  } finally {
    await api.dispose()
  }
})

test('GET /mcp/tools validates the server and reports unavailable tools', async () => {
  const api = await apiHarness()
  try {
    const missing = await api.invoke('GET', '/mcp/tools')
    assert.equal(missing.status, 400)
    assert.equal(missing.payload.ok, false)

    const unknown = await api.invoke('GET', '/mcp/tools?server=ghost')
    assert.equal(unknown.status, 404)
    assert.equal(unknown.payload.ok, false)
  } finally {
    await api.dispose()
  }

  const broken = await apiHarness({ toolsUnavailable: true })
  try {
    const unavailable = await broken.invoke('GET', '/mcp/tools?server=alpha')
    assert.equal(unavailable.status, 500)
    assert.equal(unavailable.payload.ok, false)
  } finally {
    await broken.dispose()
  }
})

test('POST /mcp/tool saves and clears one tool config', async () => {
  const api = await apiHarness()
  try {
    const saved = await api.call('POST', '/mcp/tool', { server: 'alpha', tool: 'mcp__alpha__search', enabled: false, modes: ['standard'] })
    assert.equal(saved.ok, true)
    assert.equal(saved.state.mcp.alpha.tools['mcp__alpha__search'].enabled, false)
    assert.deepEqual(saved.state.mcp.alpha.tools['mcp__alpha__search'].modes, ['standard'])
    // The browser projection never carries the connection definition ...
    assert.equal(saved.state.mcp.alpha.definition, undefined)
    // ... and the serialized read-modify-write kept it on disk.
    const persisted = await api.store.read({ fresh: true })
    assert.equal(persisted.mcp.alpha.definition.url, 'http://secret')
    assert.equal(persisted.mcp.alpha.definition.headers.Authorization, 'x')
    assert.equal(persisted.mcp.alpha.installedAt, '2026-11-01T00:00:00.000Z')
    assert.equal(persisted.mcp.alpha.disclosure, 'full')

    const cleared = await api.call('POST', '/mcp/tool', { server: 'alpha', tool: 'mcp__alpha__search', clear: true })
    assert.equal(cleared.state.mcp.alpha.tools['mcp__alpha__search'], undefined)

    // A historical entry (tool currently unregistered) can still be edited.
    const history = await api.call('POST', '/mcp/tool', { server: 'alpha', tool: 'mcp__alpha__gone', enabled: true, modes: ['draft'] })
    assert.equal(history.ok, true)
    assert.deepEqual(history.state.mcp.alpha.tools['mcp__alpha__gone'].modes, ['draft'])
    assert.equal(history.state.mcp.alpha.tools['mcp__alpha__gone'].enabled, true)
  } finally {
    await api.dispose()
  }
})

test('POST /mcp/tool refuses an unattributable tool name', async () => {
  const api = await apiHarness()
  try {
    const payload = await api.call('POST', '/mcp/tool', { server: 'alpha', tool: 'mcp__beta__x', enabled: false })
    assert.equal(payload.ok, false)

    // A name with two possible server separators cannot be attributed safely.
    const ambiguous = await api.call('POST', '/mcp/tool', { server: 'alpha', tool: 'mcp__alpha__x__y', enabled: false })
    assert.equal(ambiguous.ok, false)

    const persisted = await api.store.read({ fresh: true })
    assert.equal(persisted.mcp.alpha.tools['mcp__beta__x'], undefined)
    assert.equal(persisted.mcp.alpha.tools['mcp__alpha__x__y'], undefined)
  } finally {
    await api.dispose()
  }
})

test('POST /mcp/tool rejects malformed scope fields', async () => {
  const api = await apiHarness()
  try {
    const badEnabled = await api.call('POST', '/mcp/tool', { server: 'alpha', tool: 'mcp__alpha__search', enabled: 'false' })
    assert.equal(badEnabled.ok, false)
    const badModes = await api.call('POST', '/mcp/tool', { server: 'alpha', tool: 'mcp__alpha__search', modes: ['bad mode'] })
    assert.equal(badModes.ok, false)
    const badWorkspaces = await api.call('POST', '/mcp/tool', { server: 'alpha', tool: 'mcp__alpha__search', workspaces: ['relative'] })
    assert.equal(badWorkspaces.ok, false)
    const unknownServer = await api.call('POST', '/mcp/tool', { server: 'ghost', tool: 'mcp__ghost__x', enabled: false })
    assert.equal(unknownServer.ok, false)

    const persisted = await api.store.read({ fresh: true })
    assert.equal(Object.hasOwn(persisted.mcp.alpha.tools, 'mcp__alpha__search'), false)
  } finally {
    await api.dispose()
  }
})

test('POST /mcp/config validates disclosure and description', async () => {
  const api = await apiHarness()
  try {
    const bad = await api.call('POST', '/mcp/config', { server: 'alpha', disclosure: 'later' })
    assert.equal(bad.ok, false)
    const control = await api.call('POST', '/mcp/config', { server: 'alpha', description: 'a\u0000b' })
    assert.equal(control.ok, false)
    const tooLong = await api.call('POST', '/mcp/config', { server: 'alpha', description: 'x'.repeat(501) })
    assert.equal(tooLong.ok, false)
    const unknown = await api.call('POST', '/mcp/config', { server: 'ghost', disclosure: 'full' })
    assert.equal(unknown.ok, false)

    const ok = await api.call('POST', '/mcp/config', { server: 'alpha', disclosure: 'progressive', description: '知识库' })
    assert.equal(ok.ok, true)
    assert.equal(ok.state.mcp.alpha.description, '知识库')
    assert.equal(ok.state.mcp.alpha.disclosure, 'progressive')
    assert.equal(ok.state.mcp.alpha.definition, undefined)
    assert.equal(JSON.stringify(ok).includes('secret'), false)

    const persisted = await api.store.read({ fresh: true })
    assert.equal(persisted.mcp.alpha.definition.headers.Authorization, 'x')
    assert.equal(persisted.mcp.alpha.installedAt, '2026-11-01T00:00:00.000Z')
    assert.deepEqual(persisted.mcp.alpha.modes, [])
    assert.deepEqual(persisted.mcp.alpha.workspaces, [])

    // An empty description clears the stored value instead of storing ''.
    const cleared = await api.call('POST', '/mcp/config', { server: 'alpha', description: '' })
    assert.equal(cleared.ok, true)
    assert.equal(cleared.state.mcp.alpha.description, '')
  } finally {
    await api.dispose()
  }
})
