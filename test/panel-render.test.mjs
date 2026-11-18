/**
 * Real Panel render smoke test.
 *
 * The browser bundle has no renderer harness, so this uses a minimal React stub
 * that exercises the Panel function body (hooks, branches, warning banner). A
 * pure helper test cannot catch an undefined hook variable.
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

test('the settings Panel renders without undefined hook state', () => {
  let Panel
  const ctx = {
    slots: {
      inject: (_name, callback) => callback(),
      register: (_spec, component) => {
        Panel = component
      },
    },
  }
  plugin.apply(ctx)
  assert.equal(typeof Panel, 'function', 'Panel was registered')
  assert.doesNotThrow(() => Panel())
})
