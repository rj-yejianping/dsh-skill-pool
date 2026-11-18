import assert from 'node:assert/strict'
import test from 'node:test'

import { hasServerTools } from '../src/mount.js'

function ctxWith(schemas) {
  return { get: (name) => (name === 'tools' ? { schemas: () => schemas } : undefined) }
}

test('mount readiness ignores ambiguous public names that merely share a prefix', () => {
  assert.equal(hasServerTools(ctxWith([{ name: 'mcp__a___b' }]), 'a'), false)
  assert.equal(hasServerTools(ctxWith([{ name: 'mcp__alpha__report_0123456789ab' }]), 'alpha'), false)
  assert.equal(hasServerTools(ctxWith([{ name: 'mcp__a__search' }]), 'a'), true)
  assert.equal(hasServerTools(ctxWith([{ name: 'mcp__alpha__a__x' }]), 'alpha'), false)
})
