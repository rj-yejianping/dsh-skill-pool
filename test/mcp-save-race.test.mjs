/**
 * MCP purpose-summary save races (final review I1).
 *
 * The Settings panel sends one `/item` request per row. Conditions are always
 * sent, but the purpose summary must only travel when *this tab* actually
 * edited it; otherwise a condition toggle in tab A would copy A's stale purpose
 * over a purpose tab B changed meanwhile.
 *
 * These tests use the exact production helpers the browser bundle calls, then
 * post the generated bodies to the real route handlers over a real
 * `StateStore`, so the debounce/in-flight/retry rules and the server-side
 * "omitted means untouched" merge are both exercised.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ROUTE_PREFIX, registerWebApi } from '../src/web-api.js'
import { normalizeState, StateStore } from '../src/store.js'

// The client is a plain browser module-loader factory. Expose the production
// board helpers exactly as the Settings panel receives them.
let captured
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec
    },
  },
}
await import('../client.js')

const React = {
  createElement: () => null,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (current) => ({ current }),
  Fragment: {},
}
const plugin = captured.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected client require: ${id}`)
})
const { buildItemSaveBody, markDescriptionEdited, settleDescriptionDirty } = plugin.boardState

function fixtureState(description = 'Knowledge base search') {
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
        description,
        installedAt: '2026-11-18T00:00:00.000Z',
        definition: { serverName: 'kb', transport: 'streamable-http', url: 'https://mcp.example.test/mcp' },
      },
    },
  })
}

async function makeApi(initial = fixtureState()) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pool-save-race-'))
  const file = join(dir, 'state.json')
  const store = new StateStore({ file })
  await store.write(initial)
  const handlers = new Map()
  const services = {
    connection: {
      admit: () => ({}),
      fetch: {
        register(route) {
          handlers.set(`${route.methods[0]} ${route.path}`, route.fetch)
          return () => handlers.delete(`${route.methods[0]} ${route.path}`)
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

  return {
    async call(method, suffix, body) {
      const handler = handlers.get(`${method} ${ROUTE_PREFIX}${suffix}`)
      assert.equal(typeof handler, 'function', `route ${method} ${suffix} is registered`)
      const init = { method }
      if (body !== undefined) {
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify(body)
      }
      const response = await handler(new Request(`http://dsh.invalid${ROUTE_PREFIX}${suffix}`, init))
      return { status: response.status, payload: await response.json() }
    },
    async persisted() {
      return JSON.parse(await readFile(file, 'utf8'))
    },
    async dispose() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function rowEntry(description) {
  return { enabled: true, modes: ['a'], workspaces: [], modesFrom: 'group', workspacesFrom: 'group', description }
}

test('a condition-only save never carries a purpose this row did not edit', async () => {
  const dirty = new Set()
  // The local document still holds the purpose tab B is about to replace.
  const body = buildItemSaveBody({ kind: 'mcp', name: 'kb', entry: rowEntry('Stale purpose from tab A') }, dirty)
  assert.equal(Object.hasOwn(body, 'description'), false, 'condition-only body omits description')
  assert.equal(body.enabled, true)
  assert.deepEqual(body.modes, ['a'])

  const api = await makeApi()
  try {
    const fromB = await api.call('POST', '/item', { kind: 'mcp', name: 'kb', description: 'Purpose from tab B' })
    assert.equal(fromB.status, 200)

    // Tab A toggles `enabled` using the body it built from its older document.
    const fromA = await api.call('POST', '/item', body)
    assert.equal(fromA.status, 200)
    assert.equal(fromA.payload.state.mcp.kb.description, 'Purpose from tab B', 'B purpose survives A condition save')
    assert.equal((await api.persisted()).mcp.kb.description, 'Purpose from tab B')
  } finally {
    await api.dispose()
  }
})

test('an in-flight condition save landing after another tab purpose edit cannot revert it', async () => {
  const api = await makeApi()
  try {
    // A prepares and sends its request before B's purpose save, but A's write
    // lands after it (the server serializes writes).
    const fromA = buildItemSaveBody({ kind: 'mcp', name: 'kb', entry: rowEntry('Old purpose') }, new Set())
    assert.equal(Object.hasOwn(fromA, 'description'), false)

    const fromB = await api.call('POST', '/item', { kind: 'mcp', name: 'kb', description: 'Purpose from tab B' })
    assert.equal(fromB.status, 200)

    const lateA = await api.call('POST', '/item', { ...fromA, enabled: false })
    assert.equal(lateA.status, 200)
    assert.equal(lateA.payload.state.mcp.kb.description, 'Purpose from tab B')
    assert.equal(lateA.payload.state.mcp.kb.enabled, false)
  } finally {
    await api.dispose()
  }
})

test('an edited purpose is sent even when it is cleared to the empty string', async () => {
  const dirty = new Set()
  const key = 'mcp:kb'
  assert.equal(markDescriptionEdited(dirty, key, { description: 'Typed purpose' }), true)
  assert.equal(buildItemSaveBody({ kind: 'mcp', name: 'kb', entry: rowEntry('Typed purpose') }, dirty).description, 'Typed purpose')

  // The user deletes every character: an empty string is a real edit and must
  // be transmitted, not mistaken for "no description field".
  markDescriptionEdited(dirty, key, { description: '' })
  const cleared = buildItemSaveBody({ kind: 'mcp', name: 'kb', entry: rowEntry('') }, dirty)
  assert.equal(Object.hasOwn(cleared, 'description'), true)
  assert.equal(cleared.description, '')

  const api = await makeApi()
  try {
    const saved = await api.call('POST', '/item', cleared)
    assert.equal(saved.status, 200)
    assert.equal(saved.payload.state.mcp.kb.description, undefined)
    assert.equal(Object.hasOwn((await api.persisted()).mcp.kb, 'description'), false)
  } finally {
    await api.dispose()
  }
})

test('a condition edit in the debounce window keeps the row purpose edit', () => {
  const dirty = new Set()
  const key = 'mcp:kb'
  markDescriptionEdited(dirty, key, { description: 'Typed purpose' })
  // A condition-only edit arrives before the debounce timer fires. It builds
  // from the local draft row, which already contains the typed purpose.
  markDescriptionEdited(dirty, key, { enabled: false })
  const body = buildItemSaveBody(
    { kind: 'mcp', name: 'kb', entry: { ...rowEntry('Typed purpose'), enabled: false, modes: ['b'] } },
    dirty,
  )
  assert.equal(body.description, 'Typed purpose')
  assert.equal(body.enabled, false)
  assert.deepEqual(body.modes, ['b'])
  assert.deepEqual(body.workspaces, [])
})

test('a request body snapshotted before a purpose edit never picks that edit up later', () => {
  const dirty = new Set()
  const key = 'mcp:kb'
  // The condition-only request is built/flushed first.
  const earlier = buildItemSaveBody({ kind: 'mcp', name: 'kb', entry: rowEntry('Old purpose') }, dirty)
  assert.equal(Object.hasOwn(earlier, 'description'), false)

  // The user types while that request is in flight: the edit belongs to the
  // next queued save, not to the request already on the wire.
  markDescriptionEdited(dirty, key, { description: 'Newly typed purpose' })
  assert.equal(Object.hasOwn(earlier, 'description'), false, 'an already-built body is not mutated')
  const next = buildItemSaveBody({ kind: 'mcp', name: 'kb', entry: rowEntry('Newly typed purpose') }, dirty)
  assert.equal(next.description, 'Newly typed purpose')
})

test('a stale save response cannot clear a newer purpose edit, so the retry carries it', () => {
  const dirty = new Set()
  const key = 'mcp:kb'
  markDescriptionEdited(dirty, key, { description: 'First purpose' })
  const firstSequence = 1
  // While the first request is in flight the user edits conditions; the new
  // save sequence is 2. The older response must not acknowledge the purpose.
  const secondSequence = 2
  assert.equal(settleDescriptionDirty(dirty, key, firstSequence, secondSequence), false)
  assert.equal(dirty.has(key), true)
  const retried = buildItemSaveBody({ kind: 'mcp', name: 'kb', entry: rowEntry('First purpose') }, dirty)
  assert.equal(retried.description, 'First purpose', 'newer save retries the still-unsaved purpose')

  // Once the newest save lands it acknowledges the purpose; a later
  // condition-only save omits it again.
  assert.equal(settleDescriptionDirty(dirty, key, secondSequence, secondSequence), true)
  assert.equal(dirty.has(key), false)
  const laterCondition = buildItemSaveBody({ kind: 'mcp', name: 'kb', entry: rowEntry('First purpose') }, dirty)
  assert.equal(Object.hasOwn(laterCondition, 'description'), false)
})

test('a failed purpose save leaves the edit dirty and a later condition save retries it', async () => {
  const dirty = new Set()
  const key = 'mcp:kb'
  markDescriptionEdited(dirty, key, { description: 'Unsaved purpose' })
  const failed = buildItemSaveBody({ kind: 'mcp', name: 'kb', entry: rowEntry('Unsaved purpose') }, dirty)
  assert.equal(failed.description, 'Unsaved purpose')

  // Failure does not settle the flag (the client keeps the draft entry).
  assert.equal(dirty.has(key), true)
  const retried = buildItemSaveBody(
    { kind: 'mcp', name: 'kb', entry: { ...rowEntry('Unsaved purpose'), enabled: false } },
    dirty,
  )
  assert.equal(retried.description, 'Unsaved purpose')
  assert.equal(retried.enabled, false)

  const api = await makeApi()
  try {
    const saved = await api.call('POST', '/item', retried)
    assert.equal(saved.status, 200)
    assert.equal(saved.payload.state.mcp.kb.description, 'Unsaved purpose')
    assert.equal(saved.payload.state.mcp.kb.enabled, false)
  } finally {
    await api.dispose()
  }
})

test('the server trims an edited purpose while a condition-only save keeps it exact', async () => {
  const api = await makeApi()
  try {
    const dirty = new Set()
    markDescriptionEdited(dirty, 'mcp:kb', { description: '  spaced purpose  ' })
    const edited = buildItemSaveBody({ kind: 'mcp', name: 'kb', entry: rowEntry('  spaced purpose  ') }, dirty)
    assert.equal(edited.description, '  spaced purpose  ', 'the client sends the raw typed text')
    const saved = await api.call('POST', '/item', edited)
    assert.equal(saved.status, 200)
    assert.equal(saved.payload.state.mcp.kb.description, 'spaced purpose')

    const conditionOnly = buildItemSaveBody(
      { kind: 'mcp', name: 'kb', entry: rowEntry('spaced purpose') },
      new Set(),
    )
    const again = await api.call('POST', '/item', { ...conditionOnly, enabled: false })
    assert.equal(again.status, 200)
    assert.equal(again.payload.state.mcp.kb.description, 'spaced purpose')
  } finally {
    await api.dispose()
  }
})
