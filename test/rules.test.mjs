import assert from 'node:assert/strict'
import test from 'node:test'

import { resolvePool, scopeMatches, toolActive } from '../src/rules.js'

/** A v3-shaped document: repositories, skills and their scopes. */
function legacyDocument() {
  return {
    version: 3,
    settings: { enabled: true, mcpGate: true, gateDefaultSkills: false },
    sources: {
      src_lark: {
        id: 'src_lark',
        kind: 'git',
        label: 'larksuite/cli skills',
        url: 'https://github.com/larksuite/cli',
        provider: 'github',
        project: 'larksuite/cli',
        branch: 'main',
        subdir: 'skills',
        skills: ['lark-doc', 'lark-im'],
        createdAt: '2026-11-13T07:40:31.938Z',
      },
      src_obra: {
        id: 'src_obra',
        kind: 'git',
        label: 'obra/superpowers',
        url: 'https://github.com/obra/superpowers',
        provider: 'github',
        project: 'obra/superpowers',
        branch: 'main',
        subdir: 'skills',
        skills: ['brainstorming'],
        createdAt: '2026-11-13T07:40:19.897Z',
      },
    },
    skills: {
      'lark-doc': { enabled: true, modes: ['standard'], workspaces: [], sourceId: 'src_lark', installedAt: '2026-11-13T00:00:00.000Z' },
      'lark-im': { enabled: true, modes: ['standard'], workspaces: [], sourceId: 'src_lark', installedAt: '2026-11-13T00:00:00.000Z' },
      brainstorming: { enabled: true, modes: [], workspaces: [], sourceId: 'src_obra', installedAt: '2026-11-13T00:00:00.000Z' },
    },
    mcp: {
      openviking: { enabled: true, modes: ['standard'], workspaces: [], installedAt: '2026-11-13T00:00:00.000Z' },
    },
  }
}

test('scopeMatches filters each dimension independently', () => {
  assert.equal(scopeMatches({ modes: [], workspaces: [] }, { mode: 'cordis', cwd: '/x' }), true)
  assert.equal(scopeMatches({ modes: ['standard'] }, { mode: 'cordis' }), false)
  assert.equal(scopeMatches({ modes: ['standard'] }, { mode: 'standard' }), true)
  assert.equal(scopeMatches({ workspaces: ['/w'] }, { mode: 'x', cwd: '/w/sub' }), true)
  assert.equal(scopeMatches({ workspaces: ['/w'] }, { mode: 'x', cwd: '/other' }), false)
})

test('allModes / allWorkspaces drop one dimension instead of matching an empty value', () => {
  const entry = { modes: ['standard'], workspaces: ['/w'] }
  // An empty mode is a real mode, so the filter still applies.
  assert.equal(scopeMatches(entry, { mode: '', cwd: '/w' }), false)
  assert.equal(scopeMatches(entry, { mode: 'standard', cwd: '' }), false)
  // The preview's "all" options ask for the union across the dimension.
  assert.equal(scopeMatches(entry, { mode: '', cwd: '/w', allModes: true }), true)
  assert.equal(scopeMatches(entry, { mode: 'standard', cwd: '', allWorkspaces: true }), true)
  assert.equal(scopeMatches(entry, { mode: '', cwd: '', allModes: true, allWorkspaces: true }), true)
})

test('a v4 group scopes every inheriting member', () => {
  const state = {
    ...legacyDocument(),
    version: 4,
    groups: {
      'repo:larksuite/cli': { key: 'repo:larksuite/cli', kind: 'repo', modes: ['cordis'], workspaces: [] },
    },
    skills: {
      'lark-doc': { enabled: true, modes: ['standard'], workspaces: [], modesFrom: 'group', workspacesFrom: 'group', sourceId: 'src_lark', installedAt: '' },
      'lark-im': { enabled: true, modes: [], workspaces: [], modesFrom: 'self', workspacesFrom: 'group', sourceId: 'src_lark', installedAt: '' },
      brainstorming: { enabled: true, modes: [], workspaces: [], modesFrom: 'group', workspacesFrom: 'group', sourceId: 'src_obra', installedAt: '' },
    },
  }
  const pool = resolvePool(state, { mode: 'cordis', cwd: '/w' })
  // lark-doc inherits `cordis`; lark-im opted out and stays on "all modes".
  assert.deepEqual(pool.skills, ['brainstorming', 'lark-doc', 'lark-im'])
  const standard = resolvePool(state, { mode: 'standard', cwd: '/w' })
  assert.deepEqual(standard.skills, ['brainstorming', 'lark-im'])
})

test('a member with no group keeps its own scope', () => {
  const state = {
    version: 4,
    settings: { enabled: true, mcpGate: true },
    sources: {},
    groups: {},
    skills: {
      local: { enabled: true, modes: ['standard'], workspaces: [], modesFrom: 'group', workspacesFrom: 'group', sourceId: '', installedAt: '' },
    },
    mcp: {},
  }
  assert.deepEqual(resolvePool(state, { mode: 'standard' }).skills, ['local'])
  assert.deepEqual(resolvePool(state, { mode: 'cordis' }).skills, [])
})

test('ambiguous MCP names include overlapping separators and malformed splits', async () => {
  const { isAmbiguousMcpToolName } = await import('../src/rules.js')
  for (const name of [
    'mcp__a___b',          // server a_ / raw b, or server a / raw _b
    'mcp__alpha__a__x',    // multiple separators
    'mcp__alpha__',        // empty raw
    'mcp__alpha',          // no separator
    'mcp____x',            // empty server
    'mcp__alpha__' + 'b'.repeat(36) + '_0123456789ab', // lossy hash suffix
    'mcp__alpha__report_0123456789ab', // clean raw that merely looks like the suffix
  ]) {
    assert.equal(isAmbiguousMcpToolName(name), true, name)
  }
  for (const name of ['mcp__a__b', 'mcp__alpha__search', 'mcp__a_b__c', 'not-mcp']) {
    assert.equal(isAmbiguousMcpToolName(name), false, name)
  }
})

test('toolActive applies enabled and AND scope', () => {
  assert.equal(toolActive({ enabled: false }, { mode: 'standard', cwd: '/w' }), false)
  assert.equal(toolActive({ enabled: true, modes: ['standard'] }, { mode: 'fleet', cwd: '/w' }), false)
  assert.equal(toolActive({ enabled: true, modes: ['standard'] }, { mode: 'standard', cwd: '/w' }), true)
  assert.equal(toolActive({ enabled: true, modes: [], workspaces: ['/w'] }, { mode: 'standard', cwd: '/w/sub' }), true)
  assert.equal(toolActive({ enabled: true, workspaces: ['/w'] }, { mode: 'standard', cwd: '/other' }), false)
})
