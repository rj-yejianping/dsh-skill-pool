import assert from 'node:assert/strict'
import test from 'node:test'

import {
  defaultState,
  excludeSourceSkill,
  normalizeState,
  removeItem,
  removeSource,
  upsertGroup,
  upsertItem,
  upsertSource,
  withoutExcluded,
} from '../src/store.js'
import { resolvePool } from '../src/rules.js'

/** A v3 document with one uniform repository and one mixed repository. */
function legacyDocument() {
  return {
    version: 3,
    settings: { enabled: true, mcpGate: true, injectSummary: true, gateDefaultSkills: false },
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
      src_mixed: {
        id: 'src_mixed',
        kind: 'git',
        label: 'mixed/repo',
        url: 'https://github.com/mixed/repo',
        provider: 'github',
        project: 'mixed/repo',
        branch: 'main',
        subdir: 'skills',
        skills: ['scoped', 'unscoped'],
        createdAt: '2026-11-13T07:40:19.897Z',
      },
    },
    skills: {
      'lark-doc': { enabled: true, modes: ['standard'], workspaces: [], sourceId: 'src_lark', installedAt: '2026-11-13T00:00:00.000Z' },
      'lark-im': { enabled: true, modes: ['standard'], workspaces: [], sourceId: 'src_lark', installedAt: '2026-11-13T00:00:00.000Z' },
      scoped: { enabled: true, modes: ['standard'], workspaces: [], sourceId: 'src_mixed', installedAt: '2026-11-13T00:00:00.000Z' },
      unscoped: { enabled: true, modes: [], workspaces: [], sourceId: 'src_mixed', installedAt: '2026-11-13T00:00:00.000Z' },
    },
    mcp: {},
  }
}

test('a v3 document migrates to v4 without changing what a session sees', () => {
  const legacy = legacyDocument()
  const migrated = normalizeState(legacy)
  assert.equal(migrated.version, 4)

  // A uniform repository becomes one group and all its members inherit it.
  assert.deepEqual(migrated.groups['repo:larksuite/cli'].modes, ['standard'])
  assert.equal(migrated.skills['lark-doc'].modesFrom, 'group')
  assert.equal(migrated.skills['lark-im'].workspacesFrom, 'group')

  // A mixed repository starts empty; the member that differed keeps its own list.
  assert.deepEqual(migrated.groups['repo:mixed/repo'].modes, [])
  assert.equal(migrated.skills.scoped.modesFrom, 'self')
  assert.equal(migrated.skills.unscoped.modesFrom, 'group')

  // The whole point: gating is identical before and after.
  const modes = ['standard', 'cordis', 'ptc', 'minimal', '']
  const workspaces = ['', '/root/workspace/default', '/tmp']
  for (const mode of modes) {
    for (const cwd of workspaces) {
      assert.deepEqual(
        resolvePool(migrated, { mode, cwd }),
        resolvePool(legacy, { mode, cwd }),
        `mode=${mode} cwd=${cwd}`,
      )
    }
  }
})

test('migration is idempotent', () => {
  const once = normalizeState(legacyDocument())
  const twice = normalizeState(once)
  assert.deepEqual(twice, once)
})

test('an unknown version still resets to an empty document', () => {
  assert.deepEqual(normalizeState({ version: 2, skills: { x: {} } }), defaultState())
  assert.deepEqual(normalizeState(null), defaultState())
})

test('upsertGroup edits one group and leaves the others alone', () => {
  const state = normalizeState(legacyDocument())
  const next = upsertGroup(state, { key: 'repo:larksuite/cli', modes: ['cordis'] })
  assert.deepEqual(next.groups['repo:larksuite/cli'].modes, ['cordis'])
  assert.deepEqual(next.groups['repo:mixed/repo'].modes, [])
  // Members inherit, so the pool follows the group without touching members.
  assert.deepEqual(resolvePool(next, { mode: 'cordis' }).skills.includes('lark-doc'), true)
  assert.deepEqual(resolvePool(next, { mode: 'standard' }).skills.includes('lark-doc'), false)
})

test('upsertItem keeps the inheritance flags it is given', () => {
  const state = normalizeState(legacyDocument())
  const next = upsertItem(
    state,
    'skill',
    'lark-doc',
    { enabled: true, modes: [], workspaces: [] },
    { modesFrom: 'self', workspacesFrom: 'group', sourceId: 'src_lark', installedAt: '2026-11-13T00:00:00.000Z' },
  )
  assert.equal(next.skills['lark-doc'].modesFrom, 'self')
  assert.equal(next.skills['lark-doc'].workspacesFrom, 'group')
})

test('a new skill with no scope inherits its group by default', () => {
  const state = normalizeState(legacyDocument())
  const next = upsertItem(
    state,
    'skill',
    'lark-new',
    { enabled: true, modes: [], workspaces: [] },
    { sourceId: 'src_lark', installedAt: '2026-11-13T00:00:00.000Z' },
  )
  assert.equal(next.skills['lark-new'].modesFrom, 'group')
  assert.deepEqual(resolvePool(next, { mode: 'standard' }).skills.includes('lark-new'), true)
  assert.deepEqual(resolvePool(next, { mode: 'cordis' }).skills.includes('lark-new'), false)
})

test('deleting a skill records it as excluded on its source', () => {
  const state = normalizeState(legacyDocument())
  const next = excludeSourceSkill(removeItem(state, 'skill', 'lark-doc'), 'lark-doc')
  assert.deepEqual(next.sources.src_lark.skills, ['lark-im'])
  assert.deepEqual(next.sources.src_lark.excluded, ['lark-doc'])
  // The repository still has a member, so its group survives.
  assert.equal(next.groups['repo:larksuite/cli'] !== undefined, true)
  assert.deepEqual(withoutExcluded(['lark-doc', 'lark-im'], next.sources.src_lark.excluded), ['lark-im'])
})

test('removing the last source of a repository drops its group', () => {
  const state = normalizeState(legacyDocument())
  const next = removeSource(state, 'src_lark')
  assert.equal(next.sources.src_lark, undefined)
  assert.equal(next.groups['repo:larksuite/cli'], undefined)
  assert.equal(next.groups['repo:mixed/repo'] !== undefined, true)
})

test('removing one of two sources of the same repository keeps the group', () => {
  const base = normalizeState(legacyDocument())
  const twin = { ...base.sources.src_lark, id: 'src_lark_twin', subdir: 'skills/other', excluded: ['lark-doc'] }
  const state = upsertSource(base, twin)
  const next = removeSource(state, 'src_lark')
  assert.equal(next.groups['repo:larksuite/cli'] !== undefined, true)
  assert.deepEqual(next.sources.src_lark_twin.excluded, ['lark-doc'])
})

test('a group switch turns every inheriting member off without touching them', () => {
  const state = normalizeState(legacyDocument())
  const off = upsertGroup(state, { key: 'repo:larksuite/cli', enabled: false })
  assert.equal(off.groups['repo:larksuite/cli'].enabled, false)
  // Members keep their own flags, so switching the group back restores them.
  assert.equal(off.skills['lark-doc'].enabled, true)
  assert.deepEqual(resolvePool(off, { mode: 'standard' }).skills, ['scoped', 'unscoped'])
  assert.deepEqual(resolvePool(off, { mode: 'cordis' }).skills, ['unscoped'])
  const on = upsertGroup(off, { key: 'repo:larksuite/cli', enabled: true })
  assert.deepEqual(resolvePool(on, { mode: 'standard' }).skills.includes('lark-doc'), true)
})

test('a disabled member stays off even when its group is on', () => {
  const state = normalizeState(legacyDocument())
  const next = upsertItem(state, 'skill', 'lark-im', { enabled: false, modes: ['standard'], workspaces: [] }, {})
  const pool = resolvePool(next, { mode: 'standard' })
  assert.deepEqual(pool.skills.includes('lark-im'), false)
  assert.deepEqual(pool.skills.includes('lark-doc'), true)
})
