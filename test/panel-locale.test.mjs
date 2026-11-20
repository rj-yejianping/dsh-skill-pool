/**
 * The spec-mandated Chinese wording of the discover registration failure.
 *
 * The settings page picks its language from `navigator.language` at load time,
 * so this file pins a Chinese locale before importing the bundle and asserts
 * the exact sentence the design doc names: 「发现入口不可用：名称冲突」.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'zh-CN' },
  configurable: true,
})

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

test('the discover failure notice matches the documented Chinese wording', () => {
  const text = plugin.boardState.discoverUnavailableText
  assert.equal(typeof text, 'function')
  assert.equal(text({ ok: false, reason: 'name-conflict' }), '发现入口不可用：名称冲突')
  assert.equal(text({ ok: false, reason: 'invalid-name' }), '发现入口不可用：名称不合法')
  assert.equal(text({ ok: false, reason: 'tools-unavailable' }), '发现入口不可用：工具列表不可读')
  // An unknown/absent reason is never echoed as raw text.
  assert.equal(text({ ok: false, reason: 'something-else' }), '发现入口不可用：渐进注入当前不可用')
  assert.equal(text({ ok: true }), '')
})
