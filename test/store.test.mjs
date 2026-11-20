import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  StateStore,
  cleanDescription,
  clearMcpToolConfig,
  defaultState,
  excludeSourceSkill,
  normalizeMcpTools,
  normalizeReadableState,
  normalizeState,
  removeItem,
  removeSource,
  setMcpConfig,
  setMcpToolConfig,
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

/** Fake connection definition; the token is a test-only value, never a real secret. */
const mcpDefinition = {
  transport: 'streamable-http',
  serverName: 'kb',
  url: 'http://127.0.0.1:65535/mcp',
  headers: { Authorization: 'Bearer fake-test-token-not-real' },
}

const mcpScope = { enabled: true, modes: ['standard'], workspaces: [] }

/** Create a store over a private temporary directory. */
async function temporaryStore() {
  const dir = await mkdtemp(join(tmpdir(), 'skill-pool-store-'))
  const file = join(dir, 'state.json')
  return { file, store: new StateStore({ file }) }
}

test('a scope change or re-import preserves the stored connection definition and panel configuration', () => {
  const base = upsertItem(defaultState(), 'mcp', 'kb', mcpScope, {
    definition: mcpDefinition,
    description: '知识库检索',
    disclosure: 'progressive',
    tools: { 'mcp__kb__search': { enabled: false, modes: ['standard'], workspaces: [] } },
  })

  // Editing conditions must not drop the definition or the panel configuration.
  const scoped = upsertItem(base, 'mcp', 'kb', { enabled: false, modes: [], workspaces: [] })
  assert.equal(scoped.mcp.kb.enabled, false)
  assert.deepEqual(scoped.mcp.kb.definition, mcpDefinition)
  assert.equal(scoped.mcp.kb.description, '知识库检索')
  assert.equal(scoped.mcp.kb.disclosure, 'progressive')
  assert.deepEqual(scoped.mcp.kb.tools, {
    'mcp__kb__search': { enabled: false, modes: ['standard'], workspaces: [] },
  })

  // Re-importing a changed connection replaces the definition.
  const replacement = { ...mcpDefinition, url: 'http://127.0.0.1:65534/mcp' }
  const reimported = upsertItem(scoped, 'mcp', 'kb', mcpScope, { definition: replacement })
  assert.deepEqual(reimported.mcp.kb.definition, replacement)

  // A write without a definition keeps the stored connection and panel config.
  const untouched = upsertItem(reimported, 'mcp', 'kb', mcpScope)
  assert.deepEqual(untouched.mcp.kb.definition, replacement)
  assert.equal(untouched.mcp.kb.description, '知识库检索')
  assert.equal(untouched.mcp.kb.disclosure, 'progressive')
  assert.deepEqual(untouched.mcp.kb.tools, {
    'mcp__kb__search': { enabled: false, modes: ['standard'], workspaces: [] },
  })
})

test('concurrent updates to different fields both survive on disk', async () => {
  const { file, store } = await temporaryStore()
  await store.write(upsertItem(defaultState(), 'mcp', 'kb', mcpScope, { definition: mcpDefinition }))

  const replacement = { ...mcpDefinition, url: 'http://127.0.0.1:65534/mcp' }

  await Promise.all([
    store.update((current) => upsertItem(current, 'mcp', 'kb', mcpScope, { definition: replacement })),
    store.update((current) => upsertItem(current, 'mcp', 'kb', { ...mcpScope, enabled: false })),
  ])

  const persisted = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(persisted.mcp.kb.enabled, false)
  assert.deepEqual(persisted.mcp.kb.definition, replacement)
})

test('many concurrent updates all land instead of overwriting each other', async () => {
  const { file, store } = await temporaryStore()
  await store.write(defaultState())

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.update((current) => upsertItem(current, 'mcp', `server-${index}`, mcpScope)),
    ),
  )

  const persisted = JSON.parse(await readFile(file, 'utf8'))
  for (let index = 0; index < 20; index += 1) {
    assert.equal(persisted.mcp[`server-${index}`]?.enabled, true, `server-${index} survived`)
  }
})

test('a direct write queued before an update is seen by that update', async () => {
  const { file, store } = await temporaryStore()
  const seeding = store.write(upsertItem(defaultState(), 'mcp', 'kb', mcpScope, { definition: mcpDefinition }))
  const updated = store.update((current) =>
    upsertItem(current, 'mcp', 'kb', { ...mcpScope, enabled: false }),
  )
  await Promise.all([seeding, updated])

  const persisted = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(persisted.mcp.kb.definition, mcpDefinition)
  assert.equal(persisted.mcp.kb.enabled, false)
})

test('a failed update rejects but later updates still run', async () => {
  const { file, store } = await temporaryStore()
  await store.write(defaultState())
  await assert.rejects(
    store.update(() => {
      throw new Error('boom')
    }),
    /boom/,
  )
  const next = await store.update((current) =>
    upsertItem(current, 'mcp', 'kb', { ...mcpScope, enabled: false }),
  )
  assert.equal(next.mcp.kb.enabled, false)
  const persisted = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(persisted.mcp.kb.enabled, false)
})

test('the persisted document is owner-only and a fresh read keeps the definition', async () => {
  const { file, store } = await temporaryStore()
  await store.update((current) =>
    upsertItem(current, 'mcp', 'kb', mcpScope, { definition: mcpDefinition }),
  )

  const info = await stat(file)
  assert.equal(info.mode & 0o777, 0o600, 'state file is readable by its owner only')

  const reopened = new StateStore({ file })
  const reread = await reopened.read({ fresh: true })
  assert.deepEqual(reread.mcp.kb.definition, mcpDefinition)
  assert.deepEqual(reread.mcp.kb.modes, ['standard'])
})

test('a fresh read sees conditions changed outside the store', async () => {
  const { file, store } = await temporaryStore()
  await store.write(defaultState())
  const external = upsertItem(defaultState(), 'mcp', 'kb', mcpScope, {
    definition: mcpDefinition,
  })
  external.mcp.kb.enabled = false
  await writeFile(file, JSON.stringify(external), { encoding: 'utf8', mode: 0o600 })

  const fresh = await store.read({ fresh: true })
  assert.equal(fresh.mcp.kb.enabled, false)
  assert.deepEqual(fresh.mcp.kb.definition, mcpDefinition)
})

/**
 * Reject if a promise does not settle in time, so a queue deadlock fails the
 * test with a clear error instead of hanging the whole suite. The message is
 * deliberately different from the store's own reentrancy message.
 */
async function withDeadline(promise, label, ms = 2000) {
  let timer
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`deadline exceeded: ${label} did not settle`)), ms)
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    clearTimeout(timer)
  }
}

test('a nested store.write inside an update mutator fails fast instead of deadlocking', async () => {
  const { file, store } = await temporaryStore()
  await store.write(upsertItem(defaultState(), 'mcp', 'kb', mcpScope, { definition: mcpDefinition }))
  const before = await readFile(file, 'utf8')

  await assert.rejects(
    withDeadline(
      store.update(async (current) => {
        await store.write(defaultState())
        return current
      }),
      'nested write',
    ),
    /cannot be called from inside an update mutator/,
  )
  assert.equal(await readFile(file, 'utf8'), before, 'a rejected nested write must not alter the document')

  // The queue recovers: the rejected task settled and later updates still run.
  const recovered = await store.update((current) => upsertItem(current, 'mcp', 'after', mcpScope))
  assert.equal(recovered.mcp.after.enabled, true)
  assert.deepEqual(recovered.mcp.kb.definition, mcpDefinition)
})

test('a nested store.update inside an update mutator fails fast instead of deadlocking', async () => {
  const { file, store } = await temporaryStore()
  await store.write(upsertItem(defaultState(), 'mcp', 'kb', mcpScope, { definition: mcpDefinition }))
  const before = await readFile(file, 'utf8')

  await assert.rejects(
    withDeadline(
      store.update(async (current) => {
        await store.update((state) => state)
        return current
      }),
      'nested update',
    ),
    /cannot be called from inside an update mutator/,
  )
  assert.equal(await readFile(file, 'utf8'), before, 'a rejected nested update must not alter the document')

  const recovered = await store.update((current) => upsertItem(current, 'mcp', 'after', mcpScope))
  assert.equal(recovered.mcp.after.enabled, true)
  assert.deepEqual(recovered.mcp.kb.definition, mcpDefinition)
})

test('independent concurrent external updates still queue while an async update runs', async () => {
  const { file, store } = await temporaryStore()
  await store.write(defaultState())

  let entered
  const started = new Promise((resolve) => {
    entered = resolve
  })
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const slow = store.update(async (current) => {
    entered()
    await gate
    return upsertItem(current, 'mcp', 'slow', mcpScope)
  })
  await started

  // This caller is outside the running task's async context, so it must queue,
  // not be mistaken for reentrancy by a process-wide "busy" flag.
  const fast = store.update((current) => upsertItem(current, 'mcp', 'fast', mcpScope))
  release()
  const [, state] = await Promise.all([slow, fast])

  assert.equal(state.mcp.slow.enabled, true)
  assert.equal(state.mcp.fast.enabled, true)
  const persisted = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(persisted.mcp.slow.enabled, true)
  assert.equal(persisted.mcp.fast.enabled, true)
})

test('an async mutation result is persisted once it settles', async () => {
  const { file, store } = await temporaryStore()
  const state = await store.update(async (current) => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    return upsertItem(current, 'mcp', 'kb', mcpScope, { definition: mcpDefinition })
  })
  assert.deepEqual(state.mcp.kb.definition, mcpDefinition)
  const persisted = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(persisted.mcp.kb.definition, mcpDefinition)
})

test('an invalid mutation result is rejected and leaves the document bytes untouched', async () => {
  const { file, store } = await temporaryStore()
  await store.write(upsertItem(defaultState(), 'mcp', 'kb', mcpScope, { definition: mcpDefinition }))
  const before = await readFile(file)

  const invalidMutators = [
    ['undefined (sync)', () => undefined],
    ['undefined (async)', async () => undefined],
    ['null', () => null],
    ['string', () => 'not-a-state'],
    ['plain object without version', () => ({})],
  ]
  for (const [label, mutate] of invalidMutators) {
    await assert.rejects(store.update(mutate), /must return a complete v4 state document/, label)
    assert.deepEqual(await readFile(file), before, `${label} must not rewrite the document`)
  }

  // The queue recovers and the stored configuration is still there.
  const recovered = await store.update((current) => upsertItem(current, 'mcp', 'after', mcpScope))
  assert.equal(recovered.mcp.after.enabled, true)
  assert.deepEqual(recovered.mcp.kb.definition, mcpDefinition)
  assert.deepEqual(recovered.mcp.kb.definition, mcpDefinition)
})

test('an update refuses to overwrite a corrupt state file and recovers after repair', async () => {
  const { file, store } = await temporaryStore()
  await store.write(upsertItem(defaultState(), 'mcp', 'kb', mcpScope, { definition: mcpDefinition }))
  const good = await readFile(file, 'utf8')
  await writeFile(file, '{"version":4,"mcp":', 'utf8')
  const corrupt = await readFile(file)

  await assert.rejects(
    store.update((current) => upsertItem(current, 'mcp', 'new', mcpScope)),
    /not valid JSON; refusing to overwrite/,
  )
  assert.deepEqual(await readFile(file), corrupt, 'corrupt bytes stay untouched for manual recovery')

  // Repairing the file lets the next update proceed and keeps the original data.
  await writeFile(file, good, 'utf8')
  const repaired = await store.update((current) => upsertItem(current, 'mcp', 'new', mcpScope))
  assert.deepEqual(repaired.mcp.kb.definition, mcpDefinition)
  assert.equal(repaired.mcp.new.enabled, true)
})

test('an update refuses a JSON document that is not a state object', async () => {
  const { file, store } = await temporaryStore()
  await store.write(defaultState())
  for (const text of ['null', '[]', '"text"']) {
    await writeFile(file, text, 'utf8')
    const before = await readFile(file)
    await assert.rejects(store.update((current) => current), /not a JSON object; refusing to overwrite/)
    assert.deepEqual(await readFile(file), before, `${text} must not be overwritten`)
  }
  await writeFile(file, JSON.stringify(defaultState()), 'utf8')
  const recovered = await store.update((current) => upsertItem(current, 'mcp', 'after', mcpScope))
  assert.equal(recovered.mcp.after.enabled, true)
})

test('a plain read fails closed too instead of returning defaults', async () => {
  const { file, store } = await temporaryStore()
  await store.write(defaultState())
  await writeFile(file, '{not json', 'utf8')
  await assert.rejects(store.read({ fresh: true }), (error) => {
    assert.equal(error?.code, 'resource-pool/state-invalid-json')
    return true
  })
})

test('an update rejects v4 fragments and wrong section shapes without rewriting the document', async () => {
  const { file, store } = await temporaryStore()
  await store.write(upsertItem(defaultState(), 'mcp', 'kb', mcpScope, { definition: mcpDefinition }))
  const before = await readFile(file)
  const complete = defaultState()

  const invalid = [
    ['missing every section', () => ({ version: 4 })],
    ['missing groups', () => ({ ...complete, groups: undefined })],
  ]
  for (const section of ['settings', 'skills', 'mcp', 'sources', 'groups']) {
    invalid.push([`${section} is null`, () => ({ ...complete, [section]: null })])
    invalid.push([`${section} is an array`, () => ({ ...complete, [section]: [] })])
  }

  for (const [label, mutate] of invalid) {
    await assert.rejects(store.update(mutate), /must return a complete v4 state document/, label)
    assert.deepEqual(await readFile(file), before, `${label} must not rewrite the document`)
  }

  // The queue recovers and the credential-bearing member is still intact.
  const recovered = await store.update((current) => upsertItem(current, 'mcp', 'after', mcpScope))
  assert.deepEqual(recovered.mcp.kb.definition, mcpDefinition)
  assert.equal(recovered.mcp.after.enabled, true)
})

test('an update over a stored v3 document still migrates it to v4', async () => {
  const { file, store } = await temporaryStore()
  await writeFile(file, JSON.stringify(legacyDocument()), { encoding: 'utf8', mode: 0o600 })

  const state = await store.update((current) =>
    upsertItem(current, 'mcp', 'kb', mcpScope, { definition: mcpDefinition }),
  )
  assert.equal(state.version, 4)
  assert.equal(state.skills['lark-doc'].modesFrom, 'group')
  assert.deepEqual(state.groups['repo:larksuite/cli'].modes, ['standard'])
  assert.deepEqual(state.mcp.kb.definition, mcpDefinition)

  const persisted = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(persisted.version, 4)
  assert.equal(persisted.skills['lark-doc'].modesFrom, 'group')
  assert.deepEqual(persisted.groups['repo:larksuite/cli'].modes, ['standard'])
  assert.deepEqual(persisted.mcp.kb.definition, mcpDefinition)
})

test('an update refuses a non-ENOENT read error (EISDIR) without touching the path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skill-pool-store-'))
  const file = join(dir, 'state.json')
  await mkdir(file)
  const store = new StateStore({ file })

  await assert.rejects(store.update((current) => current), /could not be read; refusing to overwrite/)
  assert.equal((await stat(file)).isDirectory(), true, 'the path is still the directory we created')
  assert.deepEqual(await readdir(dir), ['state.json'], 'no temporary file was written next to it')
})

test('mcp member normalizes description, disclosure and per-tool config', () => {
  const state = normalizeState({
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
        description: '知识库检索',
        disclosure: 'progressive',
        tools: {
          'mcp__alpha__search': { enabled: false, modes: ['standard'], workspaces: ['/w'] },
          'mcp__alpha__read': {},
        },
      },
    },
  })
  assert.equal(state.mcp.alpha.description, '知识库检索')
  assert.equal(state.mcp.alpha.disclosure, 'progressive')
  assert.deepEqual(state.mcp.alpha.tools['mcp__alpha__search'], {
    enabled: false,
    modes: ['standard'],
    workspaces: ['/w'],
  })
  assert.deepEqual(state.mcp.alpha.tools['mcp__alpha__read'], { enabled: true, modes: [], workspaces: [] })
})

test('mcp member defaults to full injection and drops invalid disclosure', () => {
  const state = normalizeState({
    version: 4,
    settings: { enabled: true, mcpGate: true, gateDefaultSkills: false },
    skills: {},
    sources: {},
    groups: {},
    mcp: { alpha: { enabled: true, modes: [], workspaces: [], disclosure: 'bogus', tools: { 'mcp__alpha__x': { enabled: 'yes' } } } },
  })
  assert.equal(state.mcp.alpha.disclosure, 'full')
  assert.deepEqual(state.mcp.alpha.tools['mcp__alpha__x'], { enabled: true, modes: [], workspaces: [] })
})

test('readable state rejects an unknown disclosure and over-long description', () => {
  const base = {
    version: 4,
    settings: { enabled: true, mcpGate: true, gateDefaultSkills: false },
    skills: {},
    sources: {},
    groups: {},
  }
  assert.throws(
    () => normalizeReadableState({ ...base, mcp: { a: { enabled: true, modes: [], workspaces: [], disclosure: 'later' } } }),
    /disclosure/,
  )
  assert.throws(
    () => normalizeReadableState({ ...base, mcp: { a: { enabled: true, modes: [], workspaces: [], description: 'x'.repeat(501) } } }),
    /description/,
  )
})

test('readable state rejects invalid mcp tool configs and control characters', () => {
  const base = {
    version: 4,
    settings: { enabled: true, mcpGate: true, gateDefaultSkills: false },
    skills: {},
    sources: {},
    groups: {},
  }
  const withMember = (extra) => ({ ...base, mcp: { a: { enabled: true, modes: [], workspaces: [], ...extra } } })
  assert.throws(
    () => normalizeReadableState(withMember({ tools: { 'mcp__a__x': { enabled: 'yes', modes: [], workspaces: [] } } })),
    /enabled/,
  )
  assert.throws(
    () => normalizeReadableState(withMember({ tools: { 'a__x': { enabled: true, modes: [], workspaces: [] } } })),
    /invalid tool key/,
  )
  assert.throws(() => normalizeReadableState(withMember({ description: 'bad\u0000text' })), /description/)
})

test('setMcpConfig and setMcpToolConfig preserve definition and scope', () => {
  const initial = normalizeState({
    version: 4,
    settings: { enabled: true, mcpGate: true, gateDefaultSkills: false },
    skills: {},
    sources: {},
    groups: {},
    mcp: {
      alpha: {
        enabled: true,
        modes: ['standard'],
        workspaces: ['/w'],
        definition: { transport: 'streamable-http', serverName: 'alpha', url: 'http://x/mcp' },
      },
    },
  })
  const configured = setMcpConfig(initial, 'alpha', { description: '检索', disclosure: 'progressive' })
  assert.equal(configured.mcp.alpha.definition.url, 'http://x/mcp')
  assert.deepEqual(configured.mcp.alpha.modes, ['standard'])
  assert.equal(configured.mcp.alpha.description, '检索')
  const tooled = setMcpToolConfig(configured, 'alpha', 'mcp__alpha__search', { enabled: false })
  assert.equal(tooled.mcp.alpha.tools['mcp__alpha__search'].enabled, false)
  const cleared = clearMcpToolConfig(tooled, 'alpha', 'mcp__alpha__search')
  assert.equal(cleared.mcp.alpha.tools['mcp__alpha__search'], undefined)
  assert.equal(cleared.mcp.alpha.description, '检索')
})

test('cleanDescription strips control characters and caps at 500 characters', () => {
  assert.equal(cleanDescription(42), '')
  assert.equal(cleanDescription('  spaced  '), 'spaced')
  assert.equal(cleanDescription('a\u0000b\nc\u007f'), 'abc')
  assert.equal(cleanDescription('x'.repeat(600)).length, 500)
})

test('normalizeMcpTools keeps only usable mcp__ keys and defaults the scope', () => {
  assert.deepEqual(normalizeMcpTools(null), {})
  assert.deepEqual(
    normalizeMcpTools({
      'mcp__alpha__search': { enabled: false, modes: ['standard'], workspaces: ['/w'] },
      'mcp__alpha__read': {},
      'alpha__search': {},
      [`mcp__alpha__${'x'.repeat(200)}`]: {},
      'mcp__alpha__string': 'nope',
    }),
    {
      'mcp__alpha__search': { enabled: false, modes: ['standard'], workspaces: ['/w'] },
      'mcp__alpha__read': { enabled: true, modes: [], workspaces: [] },
    },
  )
})

test('mcp config mutators leave an unknown server untouched', () => {
  const state = normalizeState({
    version: 4,
    settings: { enabled: true, mcpGate: true, gateDefaultSkills: false },
    skills: {},
    sources: {},
    groups: {},
    mcp: { alpha: { enabled: true, modes: [], workspaces: [] } },
  })
  assert.equal(setMcpConfig(state, 'missing', { description: 'x' }), state)
  assert.equal(setMcpToolConfig(state, 'missing', 'mcp__missing__x', { enabled: false }), state)
  assert.equal(clearMcpToolConfig(state, 'missing', 'mcp__missing__x'), state)
})

test('setMcpToolConfig merges a partial patch over the stored tool config', () => {
  const state = setMcpToolConfig(
    normalizeState({
      version: 4,
      settings: { enabled: true, mcpGate: true, gateDefaultSkills: false },
      skills: {},
      sources: {},
      groups: {},
      mcp: { alpha: { enabled: true, modes: [], workspaces: [] } },
    }),
    'alpha',
    'mcp__alpha__search',
    { enabled: false, modes: ['standard'] },
  )
  assert.deepEqual(state.mcp.alpha.tools['mcp__alpha__search'], {
    enabled: false,
    modes: ['standard'],
    workspaces: [],
  })
  // A second patch only changes the fields it names.
  const scoped = setMcpToolConfig(state, 'alpha', 'mcp__alpha__search', { workspaces: ['/w'] })
  assert.deepEqual(scoped.mcp.alpha.tools['mcp__alpha__search'], {
    enabled: false,
    modes: ['standard'],
    workspaces: ['/w'],
  })
})
