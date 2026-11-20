import assert from 'node:assert/strict'
import test from 'node:test'
import { mcpGuardReason } from '../src/mcp-guard.js'

const rec = (over = {}) => ({
  activated: true,
  gateMcp: true,
  allowedServers: new Set(['alpha']),
  progressiveServers: new Set(['alpha']),
  expandedServers: new Set(),
  toolDenied: new Set(),
  ...over,
})

test('agent-less MCP calls are never denied', () => {
  assert.equal(mcpGuardReason({ name: 'mcp__alpha__search', hasAgent: false, record: undefined }), undefined)
})

test('a live agent with no record denies every MCP call', () => {
  assert.equal(mcpGuardReason({ name: 'mcp__alpha__search', hasAgent: true, record: undefined }), 'pool-not-activated')
})

test('non-MCP names and disabled tools', () => {
  assert.equal(mcpGuardReason({ name: 'read', hasAgent: true, record: rec() }), undefined)
  assert.equal(
    mcpGuardReason({ name: 'mcp__alpha__search', hasAgent: true, record: rec({ toolDenied: new Set(['mcp__alpha__search']) }) }),
    'tool-disabled',
  )
})

test('out-of-pool server, unexpanded progressive service, expanded service', () => {
  assert.equal(mcpGuardReason({ name: 'mcp__beta__x', hasAgent: true, record: rec() }), 'server-not-in-pool')
  assert.equal(mcpGuardReason({ name: 'mcp__alpha__search', hasAgent: true, record: rec() }), 'server-not-expanded')
  assert.equal(
    mcpGuardReason({ name: 'mcp__alpha__search', hasAgent: true, record: rec({ expandedServers: new Set(['alpha']) }) }),
    undefined,
  )
})

test('gate off: only per-tool denial applies', () => {
  const off = rec({ gateMcp: false })
  assert.equal(mcpGuardReason({ name: 'mcp__beta__x', hasAgent: true, record: off }), undefined)
  assert.equal(
    mcpGuardReason({ name: 'mcp__alpha__x', hasAgent: true, record: rec({ gateMcp: false, toolDenied: new Set(['mcp__alpha__x']) }) }),
    'tool-disabled',
  )
})

test('a missing argument is allowed; a throwing record reports guard-error', () => {
  // The guard runs on every tool call, so it must never throw.
  assert.equal(mcpGuardReason(), undefined)
  assert.equal(mcpGuardReason(null), undefined)
  assert.equal(
    mcpGuardReason({ name: 'mcp__alpha__search', hasAgent: true, record: { activated: true, get gateMcp() { throw new Error('boom') } } }),
    'guard-error',
  )
})

test('a present but non-Set collection fails closed', () => {
  // A malformed deny-all collection must not release a progressive server.
  assert.equal(
    mcpGuardReason({ name: 'mcp__alpha__search', hasAgent: true, record: rec({ progressiveServers: ['alpha'] }) }),
    'guard-error',
  )
  // An array must not count as evidence that the service was expanded.
  assert.equal(
    mcpGuardReason({ name: 'mcp__alpha__search', hasAgent: true, record: rec({ expandedServers: ['alpha'] }) }),
    'guard-error',
  )
})

test('an ambiguous public name is refused instead of allowed by prefix', () => {
  assert.equal(
    mcpGuardReason({ name: 'mcp__alpha__search__extra', hasAgent: true, record: rec({ expandedServers: new Set(['alpha']) }) }),
    'server-not-in-pool',
  )
})
