/**
 * The Settings panel's board reconciliation.
 *
 * The browser bundle is a plain module-loader factory with no renderer test
 * harness in this package. It exposes its pure reconciliation seam so this test
 * can exercise the exact production function used by `loadBoard`: a GET that was
 * started before a newer local edit (or before a save response) must not replace
 * that edit, while a failure-time reload still preserves an unsaved draft.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

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

/** Document shape the panel consumes; `mode` distinguishes local from server rows. */
function documentWith(mode = 'a') {
  return {
    version: 4,
    settings: { enabled: true, mcpGate: true, gateDefaultSkills: false },
    skills: {},
    mcp: {
      kb: { enabled: true, modes: [mode], workspaces: [] },
      private: { enabled: true, modes: ['b'], workspaces: [] },
    },
    sources: {},
    groups: {},
  }
}

function draftOf(mode) {
  return { enabled: true, modes: [mode], workspaces: [] }
}

test('board reconciliation is a real export of the client bundle', () => {
  assert.equal(typeof plugin.boardState?.applyLoadedBoard, 'function')
})

test('a reload with the same edit revision keeps an unsaved local draft', () => {
  const current = {
    state: documentWith('draft'),
    inventory: { mcp: [] },
    mounts: { kb: { state: 'ready' } },
    meta: { version: 'old' },
  }
  const loaded = {
    state: documentWith('stored'),
    inventory: { mcp: [{ server: 'kb' }] },
    mounts: {},
    meta: { version: 'new' },
  }

  const next = plugin.boardState.applyLoadedBoard(current, loaded, {
    startedRevision: 7,
    currentRevision: 7,
    drafts: new Map([['mcp:kb', draftOf('draft')]]),
  })

  // The row draft survives, while inventory/meta/metadata are still refreshed.
  assert.deepEqual(next.state.mcp.kb.modes, ['draft'])
  assert.deepEqual(next.inventory, loaded.inventory)
  assert.deepEqual(next.mounts, loaded.mounts)
  assert.deepEqual(next.meta, loaded.meta)
})

test('a reload started before a newer edit never replaces the state', () => {
  const current = {
    state: documentWith('new'),
    inventory: { mcp: [] },
    mounts: {},
    meta: { version: 'old' },
  }
  const loaded = {
    state: documentWith('stale'),
    inventory: { mcp: [{ server: 'kb' }] },
    mounts: {},
    meta: { version: 'new' },
  }

  const next = plugin.boardState.applyLoadedBoard(current, loaded, {
    startedRevision: 7,
    currentRevision: 8,
    drafts: new Map(),
  })

  assert.equal(next.state, current.state, 'stale GET does not replace state')
  assert.deepEqual(next.state.mcp.kb.modes, ['new'])
  assert.deepEqual(next.inventory, loaded.inventory)
  assert.deepEqual(next.meta, loaded.meta)
})

test('a reload with no local changes applies the server document', () => {
  const current = {
    state: documentWith('old'),
    inventory: { mcp: [] },
    mounts: {},
    meta: { version: 'old' },
  }
  const loaded = {
    state: documentWith('fresh'),
    inventory: { mcp: [{ server: 'kb' }] },
    mounts: {},
    meta: { version: 'new' },
  }

  const next = plugin.boardState.applyLoadedBoard(current, loaded, {
    startedRevision: 7,
    currentRevision: 7,
    drafts: new Map(),
  })

  assert.deepEqual(next.state.mcp.kb.modes, ['fresh'])
  assert.deepEqual(next.inventory, loaded.inventory)
})

test('the initial load is applied unchanged', () => {
  const loaded = {
    state: documentWith('initial'),
    inventory: { mcp: [] },
    mounts: {},
    meta: { version: 'new' },
  }
  const next = plugin.boardState.applyLoadedBoard(null, loaded, {
    startedRevision: 0,
    currentRevision: 0,
    drafts: new Map(),
  })
  assert.equal(next, loaded)
})

test('a draft for a member absent from the authoritative document is never re-added', () => {
  const current = {
    state: documentWith('draft'),
    inventory: { mcp: [] },
    mounts: {},
    meta: { version: 'old' },
  }
  const authoritative = documentWith('unused')
  delete authoritative.mcp.kb
  const loaded = {
    state: authoritative,
    inventory: { mcp: [{ server: 'private' }] },
    mounts: {},
    meta: { version: 'new' },
  }

  const next = plugin.boardState.applyLoadedBoard(current, loaded, {
    startedRevision: 9,
    currentRevision: 9,
    drafts: new Map([['mcp:kb', draftOf('draft')]]),
  })

  assert.equal(Object.hasOwn(next.state.mcp, 'kb'), false, 'no phantom row is resurrected')
  assert.equal(next.state.mcp.private.enabled, true)
  assert.deepEqual(next.inventory, loaded.inventory)
})

test('orphaned drafts are exposed with their unsaved entry for a visible warning', () => {
  const authoritative = documentWith('server')
  delete authoritative.mcp.kb
  authoritative.skills['still-here'] = { enabled: true, modes: ['a'], workspaces: [] }
  const orphans = plugin.boardState.orphanedDrafts(authoritative, new Map([
    ['mcp:kb', draftOf('unsaved-modes')],
    ['skill:still-here', { enabled: false, modes: ['a'], workspaces: [] }],
  ]))

  assert.equal(orphans.length, 1)
  assert.equal(orphans[0].key, 'mcp:kb')
  assert.deepEqual(orphans[0].entry.modes, ['unsaved-modes'])
})

test('a save response cannot resurrect a member deleted meanwhile', () => {
  const current = documentWith('fresh-local')
  delete current.mcp.kb
  const canonical = { enabled: true, modes: ['a'], workspaces: [] }
  const next = plugin.boardState.applyItemSave(current, 'mcp', 'kb', canonical)
  assert.equal(next, current, 'the removed row is not re-added by its old save response')
  assert.equal(Object.hasOwn(next.mcp, 'kb'), false)
})

test('a save response still updates an existing member', () => {
  const current = documentWith('old')
  const canonical = { enabled: true, modes: ['saved'], workspaces: [] }
  const next = plugin.boardState.applyItemSave(current, 'mcp', 'kb', canonical)
  assert.deepEqual(next.mcp.kb.modes, ['saved'])
  assert.equal(next.mcp.private.enabled, true)
})

test('the discarded-draft warning preserves the unsaved text visibly', () => {
  const message = plugin.boardState.draftLossMessage([
    { key: 'mcp:kb', entry: { enabled: true, modes: ['unsaved-modes'], workspaces: [] } },
  ])
  assert.ok(message.includes('kb'), message)
  assert.ok(message.includes('unsaved-modes'), message)
  assert.ok(message.toLowerCase().includes('unsaved'), message)
})


test('an activation warning persists across unrelated successes and is explicitly dismissible', () => {
  const warning = { code: 'resource-pool/activation-degraded', message: '状态已保存，但仍有会话未生效' }
  assert.deepEqual(plugin.boardState.activationWarningOf({ warning }), warning)
  assert.equal(plugin.boardState.activationWarningOf({ ok: true }), null)
  assert.deepEqual(plugin.boardState.mergeActivationWarning(null, { warning }), warning)
  // A later successful response without a warning must not clear the banner.
  assert.deepEqual(plugin.boardState.mergeActivationWarning(warning, { state: {} }), warning)
  assert.equal(plugin.boardState.dismissActivationWarning(), null)
})


test('the panel inherit payload keeps current values and switches the marker to group', () => {
  const body = plugin.boardState.buildItemSaveBody(
    {
      kind: 'skill',
      name: 'shared',
      entry: { enabled: true, modes: ['x'], workspaces: ['/x'], modesFrom: 'group', workspacesFrom: 'group' },
    },
  )
  assert.equal(body.modesFrom, 'group')
  assert.equal(body.workspacesFrom, 'group')
  assert.deepEqual(body.modes, ['x'])
  assert.deepEqual(body.workspaces, ['/x'])
})

test('normalizeEntry keeps MCP description, disclosure and tool config', () => {
  const entry = plugin.boardState.normalizeEntry({
    enabled: true,
    modes: [],
    workspaces: [],
    description: '知识库',
    disclosure: 'progressive',
    tools: { mcp__a__x: { enabled: false, modes: ['standard'], workspaces: ['/w'] } },
  })
  assert.equal(entry.description, '知识库')
  assert.equal(entry.disclosure, 'progressive')
  assert.deepEqual(entry.tools['mcp__a__x'], { enabled: false, modes: ['standard'], workspaces: ['/w'] })
  assert.deepEqual(entry.tools['mcp__a__missing'], undefined)
})

test('normalizeEntry defaults missing MCP fields without widening a member', () => {
  const entry = plugin.boardState.normalizeEntry({ enabled: true, modes: [], workspaces: [] })
  assert.equal(entry.description, '')
  assert.equal(entry.disclosure, 'full')
  assert.deepEqual(entry.tools, {})

  const invalid = plugin.boardState.normalizeEntry({
    description: '',
    disclosure: 'later',
    tools: { 'resource_pool_status': { enabled: false }, 'mcp__a__x': { enabled: 'yes' } },
  })
  assert.equal(invalid.disclosure, 'full')
  assert.equal(Object.hasOwn(invalid.tools, 'resource_pool_status'), false)
  assert.deepEqual(invalid.tools['mcp__a__x'], { enabled: true, modes: [], workspaces: [] })
})

test('buildToolSaveBody sends clear or the full draft', () => {
  assert.deepEqual(plugin.boardState.buildToolSaveBody('alpha', 'mcp__alpha__x', { enabled: false, modes: ['standard'] }), {
    server: 'alpha',
    tool: 'mcp__alpha__x',
    enabled: false,
    modes: ['standard'],
    workspaces: [],
  })
  assert.deepEqual(plugin.boardState.buildToolSaveBody('alpha', 'mcp__alpha__x', { clear: true }), {
    server: 'alpha',
    tool: 'mcp__alpha__x',
    clear: true,
  })
})

test('the MCP helpers are exported for the panel and its tests', () => {
  assert.equal(typeof plugin.boardState.normalizeMcpTools, 'function')
  assert.equal(typeof plugin.boardState.buildToolSaveBody, 'function')
  assert.deepEqual(plugin.boardState.normalizeMcpTools({ 'mcp__a__x': {} }), {
    'mcp__a__x': { enabled: true, modes: [], workspaces: [] },
  })
})

test('a describe failure reason is readable from both API error shapes', () => {
  // `/mcp/describe` answers with a flat `{ok:false, error:<code>, message}`;
  // other routes answer `{ok:false, error:{code,message}}`. The panel must show
  // the reason for either shape instead of a bare HTTP status.
  assert.equal(plugin.boardState.failureTextOf({ error: 'offline', message: '服务 alpha 当前离线' }), 'offline: 服务 alpha 当前离线')
  assert.equal(plugin.boardState.failureTextOf({ error: { code: 'x', message: '原因' } }), '原因')
  assert.equal(plugin.boardState.failureTextOf({ error: { code: 'resource-pool/x' } }), 'resource-pool/x')
  assert.equal(plugin.boardState.failureTextOf(null), '')
})
