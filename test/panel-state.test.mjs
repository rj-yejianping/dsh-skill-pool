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

/** Document shape the panel consumes. */
function documentWith(description) {
  return {
    version: 4,
    settings: { enabled: true, mcpGate: true, injectSummary: true, gateDefaultSkills: false },
    skills: {},
    mcp: {
      kb: { enabled: true, modes: ['a'], workspaces: [], description },
      private: { enabled: true, modes: ['b'], workspaces: [] },
    },
    sources: {},
    groups: {},
  }
}

function draftOf(description) {
  return { enabled: true, modes: ['a'], workspaces: [], description }
}

test('board reconciliation is a real export of the client bundle', () => {
  assert.equal(typeof plugin.boardState?.applyLoadedBoard, 'function')
})

test('a reload with the same edit revision keeps an unsaved local draft', () => {
  const current = {
    state: documentWith('Draft purpose typed but not saved'),
    inventory: { mcp: [] },
    mounts: { kb: { state: 'ready' } },
    meta: { version: 'old' },
  }
  const loaded = {
    state: documentWith('Stored purpose from disk'),
    inventory: { mcp: [{ server: 'kb' }] },
    mounts: {},
    meta: { version: 'new' },
  }

  const next = plugin.boardState.applyLoadedBoard(current, loaded, {
    startedRevision: 7,
    currentRevision: 7,
    drafts: new Map([['mcp:kb', draftOf('Draft purpose typed but not saved')]]),
  })

  // The row draft survives, while inventory/meta/metadata are still refreshed.
  assert.equal(next.state.mcp.kb.description, 'Draft purpose typed but not saved')
  assert.deepEqual(next.inventory, loaded.inventory)
  assert.deepEqual(next.mounts, loaded.mounts)
  assert.deepEqual(next.meta, loaded.meta)
})

test('a reload started before a newer edit never replaces the state', () => {
  const current = {
    state: documentWith('Newest local purpose'),
    inventory: { mcp: [] },
    mounts: {},
    meta: { version: 'old' },
  }
  const loaded = {
    state: documentWith('Stale server purpose'),
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
  assert.equal(next.state.mcp.kb.description, 'Newest local purpose')
  assert.deepEqual(next.inventory, loaded.inventory)
  assert.deepEqual(next.meta, loaded.meta)
})

test('a reload with no local changes applies the server document', () => {
  const current = {
    state: documentWith('Old local purpose'),
    inventory: { mcp: [] },
    mounts: {},
    meta: { version: 'old' },
  }
  const loaded = {
    state: documentWith('Fresh server purpose'),
    inventory: { mcp: [{ server: 'kb' }] },
    mounts: {},
    meta: { version: 'new' },
  }

  const next = plugin.boardState.applyLoadedBoard(current, loaded, {
    startedRevision: 7,
    currentRevision: 7,
    drafts: new Map(),
  })

  assert.equal(next.state.mcp.kb.description, 'Fresh server purpose')
  assert.deepEqual(next.inventory, loaded.inventory)
})

test('the initial load is applied unchanged', () => {
  const loaded = {
    state: documentWith('Initial purpose'),
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
