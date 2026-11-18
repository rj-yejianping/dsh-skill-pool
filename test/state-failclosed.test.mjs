/**
 * Fail-closed state reads and per-Agent activation.
 *
 * A corrupt, unreadable, unsupported or semantically invalid state document must
 * never be normalized into a broader pool. Nothing here touches live state: every
 * store lives in its own temporary directory.
 */

import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createActivation } from '../src/activation.js'
import { registerWebApi, ROUTE_PREFIX } from '../src/web-api.js'
import { StateStore, defaultState, normalizeState, upsertGroup, upsertItem, upsertSource } from '../src/store.js'

/** A valid v4 document with one MCP member that only mode `b` may use. */
function validState() {
  return normalizeState({
    version: 4,
    settings: { enabled: true, mcpGate: true, injectSummary: true, gateDefaultSkills: false },
    skills: {},
    mcp: {
      kb: { enabled: true, modes: ['b'], workspaces: [], installedAt: '2026-11-18T00:00:00.000Z' },
    },
    sources: {},
    groups: {},
  })
}

/** A v3 document with one repository and two skills scoped to `standard`. */
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
        skills: ['lark-doc'],
        createdAt: '2026-11-13T07:40:31.938Z',
      },
    },
    skills: {
      'lark-doc': { enabled: true, modes: ['standard'], workspaces: [], sourceId: 'src_lark', installedAt: '2026-11-13T00:00:00.000Z' },
    },
    mcp: {},
  }
}

/** Create a store over a private temporary directory. */
async function temporaryStore() {
  const dir = await mkdtemp(join(tmpdir(), 'skill-pool-failclosed-'))
  const file = join(dir, 'state.json')
  return { dir, file, store: new StateStore({ file }) }
}

/** Assert a rejection is a clean, safe state error rather than a broad read. */
async function rejectsClosed(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code)
    // Error text may explain the shape, never echo file bytes or credentials.
    assert.equal(/Bearer|Authorization|fake-token|"?version"?\s*:/i.test(String(error?.message)), false)
    return true
  })
}

test('an absent file is a valid first run that reads the documented defaults', async () => {
  const { dir, store } = await temporaryStore()
  try {
    assert.deepEqual(await store.read({ fresh: true }), defaultState())
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a deliberately empty v4 document and a deliberately disabled document still read', async () => {
  const empty = await temporaryStore()
  try {
    await empty.store.write(defaultState())
    const state = await empty.store.read({ fresh: true })
    assert.deepEqual(state, defaultState())
    assert.equal(state.settings.enabled, true)
  } finally {
    await rm(empty.dir, { recursive: true, force: true })
  }

  const disabled = await temporaryStore()
  try {
    const document = defaultState()
    document.settings.enabled = false
    await disabled.store.write(document)
    const state = await disabled.store.read({ fresh: true })
    assert.equal(state.settings.enabled, false)
  } finally {
    await rm(disabled.dir, { recursive: true, force: true })
  }
})

test('malformed JSON fails closed instead of reading defaults', async () => {
  const { dir, file, store } = await temporaryStore()
  try {
    await writeFile(file, '{"version":4,"mcp":', 'utf8')
    await rejectsClosed(store.read({ fresh: true }), 'resource-pool/state-invalid-json')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unsupported version fails closed instead of resetting to a broad default', async () => {
  const { dir, file, store } = await temporaryStore()
  try {
    for (const version of [1, 2, 5, '4']) {
      await writeFile(file, JSON.stringify({ version, mcp: { kb: { enabled: true } } }), 'utf8')
      await rejectsClosed(store.read({ fresh: true }), 'resource-pool/state-unsupported-version')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('semantic invalidity fails closed instead of normalizing into wider rights', async () => {
  const { dir, file, store } = await temporaryStore()
  const broaden = [
    ['a non-boolean settings switch normalizes to true', (doc) => { doc.settings.mcpGate = 'false' }],
    ['an absent settings switch would default to true', (doc) => { delete doc.settings.mcpGate }],
    ['a string modes value would normalize to "all modes"', (doc) => { doc.mcp.kb.modes = 'b' }],
    ['an invalid mode entry would be dropped, widening the list', (doc) => { doc.mcp.kb.modes = ['b', 'bad mode'] }],
    ['a non-array workspaces value would normalize to "all workspaces"', (doc) => { doc.mcp.kb.workspaces = '/w' }],
    ['a relative workspace entry would be dropped, widening the list', (doc) => { doc.mcp.kb.workspaces = ['relative'] }],
    ['a non-boolean member enabled flag would normalize to true', (doc) => { doc.mcp.kb.enabled = 'false' }],
    ['a missing required section would be invented as empty', (doc) => { delete doc.groups }],
    ['a missing top-level member map would be invented as empty', (doc) => { delete doc.mcp }],
    ['an invalid member key would be dropped silently', (doc) => { doc.mcp['bad name'] = doc.mcp.kb; delete doc.mcp.kb }],
    ['a non-member value would be dropped silently', (doc) => { doc.mcp.kb = 'not a member' }],
    ['an invalid inheritance marker changes effective scope', (doc) => { doc.mcp.kb.modesFrom = 'everything' }],
    ['a non-boolean group switch would normalize to true', (doc) => {
      doc.groups['repo:example/project'] = {
        key: 'repo:example/project', kind: 'repo', enabled: 'false', modes: [], workspaces: [],
      }
    }],
    ['an unusable source would be dropped, detaching its group scope', (doc) => {
      doc.sources.bad = { id: 'bad', kind: 'git', label: 'bad', skills: [] }
    }],
    ['a source id that does not match its map key would be relocated', (doc) => {
      doc.sources.src = { id: 'other', kind: 'files', label: 'x', skills: [], excluded: [] }
    }],
  ]
  try {
    for (const [label, mutate] of broaden) {
      const doc = validState()
      mutate(doc)
      await writeFile(file, JSON.stringify(doc), 'utf8')
      await assert.rejects(store.read({ fresh: true }), (error) => {
        assert.equal(error?.code, 'resource-pool/state-invalid-document', label)
        return true
      })
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a fully migrated v4 document with sources and groups round-trips through strict reads', async () => {
  const { dir, store } = await temporaryStore()
  try {
    const rich = normalizeState(legacyDocument())
    await store.write(rich)
    assert.deepEqual(await store.read({ fresh: true }), rich)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a valid v3 document still migrates, but a malformed v3 document fails closed', async () => {
  const { dir, file, store } = await temporaryStore()
  try {
    await writeFile(file, JSON.stringify(legacyDocument()), 'utf8')
    const migrated = await store.read({ fresh: true })
    assert.equal(migrated.version, 4)
    assert.equal(migrated.skills['lark-doc'].modesFrom, 'group')
    assert.deepEqual(migrated.groups['repo:larksuite/cli'].modes, ['standard'])

    const malformed = legacyDocument()
    malformed.skills['lark-doc'].modes = 'standard'
    await writeFile(file, JSON.stringify(malformed), 'utf8')
    await rejectsClosed(store.read({ fresh: true }), 'resource-pool/state-invalid-document')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a v3 document missing optional switches still migrates without inventing a wider scope', async () => {
  const { dir, file, store } = await temporaryStore()
  try {
    const legacy = legacyDocument()
    delete legacy.settings.injectSummary
    delete legacy.settings.gateDefaultSkills
    await writeFile(file, JSON.stringify(legacy), 'utf8')
    const migrated = await store.read({ fresh: true })
    assert.equal(migrated.version, 4)
    assert.equal(migrated.settings.enabled, true)
    assert.equal(migrated.settings.mcpGate, true)
    assert.deepEqual(migrated.skills['lark-doc'].modes, ['standard'])
    assert.deepEqual(migrated.groups['repo:larksuite/cli'].modes, ['standard'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a file that disappears after a successful read is a failure, not a first run', async () => {
  const { dir, file, store } = await temporaryStore()
  try {
    await store.write(validState())
    await store.read({ fresh: true })
    await unlink(file)

    await rejectsClosed(store.read({ fresh: true }), 'resource-pool/state-missing')
    await assert.rejects(store.update((current) => current), (error) => {
      assert.equal(error?.code, 'resource-pool/state-missing')
      return true
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an update refuses unsupported or semantically invalid bytes and preserves them exactly', async () => {
  const { dir, file, store } = await temporaryStore()
  try {
    const unsupported = JSON.stringify({ version: 5, settings: {}, skills: {}, mcp: {}, sources: {}, groups: {} })
    await writeFile(file, unsupported, 'utf8')
    const before = await readFile(file)
    await rejectsClosed(store.update((current) => current), 'resource-pool/state-unsupported-version')
    assert.deepEqual(await readFile(file), before)

    const invalid = validState()
    invalid.settings.mcpGate = 'false'
    await writeFile(file, JSON.stringify(invalid), 'utf8')
    const invalidBytes = await readFile(file)
    await rejectsClosed(store.update((current) => current), 'resource-pool/state-invalid-document')
    assert.deepEqual(await readFile(file), invalidBytes)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/** One fake live Agent whose registrations this harness can inspect. */
function makeAgent({ mode, cwd, failRestrict = false }) {
  const sections = []
  const restrictions = []
  const agent = {
    session: { header: { agentPreset: mode, cwd } },
    sections,
    restrictions,
    ctx: {
      modeId: mode,
      get(name) {
        if (name === 'skills') return { registerProvider: () => () => {} }
        return undefined
      },
      effect(register) {
        const dispose = register()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      tools: {
        restrict(rule) {
          if (failRestrict) throw new Error('restrict registration failed')
          const entry = { deny: [...(rule?.deny ?? [])], disposed: false }
          restrictions.push(entry)
          return () => {
            entry.disposed = true
          }
        },
      },
      systemPrompt: {
        section({ text }) {
          sections.push(text)
          return () => {
            const index = sections.indexOf(text)
            if (index >= 0) sections.splice(index, 1)
          }
        },
      },
    },
  }
  return agent
}

/** An activation manager over a real store whose `getState` is the host getter. */
function makeActivation(store, { schemas = () => [{ name: 'mcp__kb__search' }, { name: 'mcp__other__x' }] } = {}) {
  const agents = []
  const services = {
    agentPresets: { composedPreset: (agentCtx) => agentCtx.modeId },
    agents: { list: () => agents },
    systemPrompt: { getSectionOrder: () => 100 },
    tools: { schemas },
  }
  const ctx = { get: (name) => services[name] }
  const activation = createActivation({
    ctx,
    getState: async () => store.read({ fresh: true }),
    promptLanguage: () => 'zh',
    libraryRoot: () => '/nonexistent-library',
    logger: {},
  })
  return {
    activation,
    addAgent(mode, cwd = '/workspace/a', options = {}) {
      const agent = makeAgent({ mode, cwd, ...options })
      agents.push(agent)
      return agent
    },
  }
}

test('a corrupt state never releases an existing Agent gate and fails new Agent creation', async () => {
  const { dir, file, store } = await temporaryStore()
  const harness = makeActivation(store)
  try {
    await store.write(validState())
    const existing = harness.addAgent('a')
    await harness.activation.applyToAgent(existing)
    assert.equal(existing.restrictions.length, 1)
    assert.deepEqual(existing.restrictions[0].deny, ['mcp__kb__search', 'mcp__other__x'])

    await writeFile(file, '{"version":4,"mcp":', 'utf8')

    // Re-applying to a live Agent keeps its previous restriction.
    await harness.activation.applyToAgent(existing, { force: true })
    assert.equal(existing.restrictions[0].disposed, false, 'the old deny layer is still installed')
    assert.deepEqual(existing.restrictions[0].deny, ['mcp__kb__search', 'mcp__other__x'])

    // A new Agent cannot be created with unknown state.
    const fresh = harness.addAgent('a')
    await assert.rejects(
      harness.activation.applyToAgent(fresh),
      (error) => {
        assert.equal(error?.code, 'resource-pool/state-invalid-json')
        return true
      },
    )
    assert.equal(fresh.restrictions.length, 0, 'no ungated Agent is published')

    // Correcting the file restores normal activation.
    await writeFile(file, JSON.stringify(validState()), 'utf8')
    await harness.activation.applyToAgent(fresh)
    assert.equal(fresh.restrictions.length, 1)
    assert.deepEqual(fresh.restrictions[0].deny, ['mcp__kb__search', 'mcp__other__x'])
    await harness.activation.applyToAgent(existing, { force: true })
    assert.equal(existing.restrictions.length, 2)
    assert.equal(existing.restrictions[0].disposed, true, 'the stale layer is replaced after recovery')
  } finally {
    harness.activation.disposeAll()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed restrict registration keeps the old gate and fails a new Agent', async () => {
  const { dir, store } = await temporaryStore()
  const harness = makeActivation(store)
  try {
    await store.write(validState())
    const existing = harness.addAgent('a')
    await harness.activation.applyToAgent(existing)
    assert.equal(existing.restrictions.length, 1)

    // Force a change so the existing signature is recomputed, then make the
    // critical restrict registration fail.
    const next = validState()
    next.mcp.kb.modes = []
    await store.write(next)
    existing.ctx.tools.restrict = () => {
      throw new Error('restrict registration failed')
    }
    const failing = harness.addAgent('a', '/workspace/a', { failRestrict: true })
    await assert.rejects(harness.activation.applyToAgent(failing), /restrict registration failed/)
    assert.equal(failing.restrictions.length, 0)

    await harness.activation.applyToAgent(existing, { force: true })
    assert.equal(existing.restrictions[0].disposed, false, 'the previous gate was not released before the new one was safe')
  } finally {
    harness.activation.disposeAll()
    await rm(dir, { recursive: true, force: true })
  }
})

/** Build the real route handlers over a temporary Store. */
async function makeApi(initial = validState(), { onChanged = async () => {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'skill-pool-failclosed-api-'))
  const file = join(dir, 'state.json')
  const store = new StateStore({ file })
  await store.write(initial)
  const handlers = new Map()
  const services = {
    connection: {
      admit: () => ({}),
      fetch: {
        register(route) {
          const key = `${route.methods[0]} ${route.path}`
          handlers.set(key, route.fetch)
          return () => handlers.delete(key)
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
  const registry = registerWebApi({ ctx, store, meta: { file, version: 'test' }, onChanged, logger: {} })

  const call = async (method, suffix, body) => {
    const pathname = suffix.split('?')[0]
    const handler = handlers.get(`${method} ${ROUTE_PREFIX}${pathname}`)
    assert.equal(typeof handler, 'function', `route ${method} ${pathname} is registered`)
    const init = { method }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const response = await handler(new Request(`http://dsh.invalid${ROUTE_PREFIX}${suffix}`, init))
    return { status: response.status, payload: await response.json() }
  }

  return {
    call,
    store,
    testHooks: registry?.testHooks,
    dir,
    file,
    async dispose() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('the settings API reports a corrupt state explicitly and never echoes its bytes', async () => {
  const api = await makeApi()
  try {
    const secret = 'Bearer fixture-secret-not-real'
    await writeFile(api.file, `{"version":4,"mcp":{"kb":{"definition":{"headers":{"Authorization":"${secret}"}}}`, 'utf8')

    const overview = await api.call('GET', '')
    assert.equal(overview.status, 500)
    assert.equal(overview.payload.ok, false)
    assert.equal(overview.payload.error.code, 'resource-pool/state-invalid-json')
    assert.equal(JSON.stringify(overview.payload).includes(secret), false)
    assert.equal(JSON.stringify(overview.payload).includes('Authorization'), false)

    const resolve = await api.call('GET', '/resolve?mode=a&cwd=%2Fw')
    assert.equal(resolve.status, 500)
    assert.equal(resolve.payload.error.code, 'resource-pool/state-invalid-json')

    const corruptBytes = await readFile(api.file)
    const write = await api.call('POST', '/settings', { patch: { mcpGate: false } })
    assert.equal(write.status, 500)
    assert.equal(write.payload.error.code, 'resource-pool/state-invalid-json')
    assert.deepEqual(await readFile(api.file), corruptBytes, 'a failed panel write preserves the bytes')

    const remove = await api.call('POST', '/item/remove', { kind: 'skill', name: 'ghost' })
    assert.equal(remove.status, 500)
    assert.equal(remove.payload.error.code, 'resource-pool/state-invalid-json')

    // Repairing the file restores the panel and the live preview.
    await writeFile(api.file, JSON.stringify(validState()), 'utf8')
    const recovered = await api.call('GET', '')
    assert.equal(recovered.status, 200)
    assert.equal(recovered.payload.ok, true)
    assert.equal(recovered.payload.state.settings.enabled, true)
    const recoveredResolve = await api.call('GET', '/resolve?mode=a&cwd=%2Fw')
    assert.equal(recoveredResolve.status, 200)
    assert.equal(recoveredResolve.payload.pool.gated, true)
  } finally {
    await api.dispose()
  }
})

test('the settings API rejects a semantically invalid document instead of showing a widened pool', async () => {
  const api = await makeApi()
  try {
    const invalid = validState()
    invalid.settings.mcpGate = 'false'
    await writeFile(api.file, JSON.stringify(invalid), 'utf8')
    const overview = await api.call('GET', '')
    assert.equal(overview.status, 500)
    assert.equal(overview.payload.error.code, 'resource-pool/state-invalid-document')
  } finally {
    await api.dispose()
  }
})

test('a file observed but unparseable is not a first run when it then disappears', async () => {
  const { dir, file, store } = await temporaryStore()
  try {
    await writeFile(file, '{not json', 'utf8')
    await rejectsClosed(store.read({ fresh: true }), 'resource-pool/state-invalid-json')
    await unlink(file)
    await rejectsClosed(store.read({ fresh: true }), 'resource-pool/state-missing')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a direct write refuses an unreadable document and preserves existing bytes', async () => {
  const { dir, file, store } = await temporaryStore()
  try {
    await store.write(validState())
    const before = await readFile(file)
    const unsupported = { version: 5, settings: {}, skills: {}, mcp: {}, sources: {}, groups: {} }
    await rejectsClosed(store.write(unsupported), 'resource-pool/state-unsupported-version')
    assert.deepEqual(await readFile(file), before)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


test('an unreadable global tool list is an activation failure, not "nothing to hide"', async () => {
  const { dir, store } = await temporaryStore()
  try {
    await store.write(validState())
    const harness = makeActivation(store, {
      schemas: () => {
        throw new Error('tool registry unavailable')
      },
    })
    const agent = harness.addAgent('a')
    await assert.rejects(harness.activation.applyToAgent(agent), /global tool list could not be read/)
    assert.equal(agent.restrictions.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a deliberately disabled pool creates a new Agent without a gate', async () => {
  const { dir, store } = await temporaryStore()
  try {
    const document = validState()
    document.settings.enabled = false
    await store.write(document)
    const harness = makeActivation(store)
    const agent = harness.addAgent('a')
    await harness.activation.applyToAgent(agent)
    assert.equal(agent.restrictions.length, 0)
    assert.equal(agent.sections.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reapplyAll conservatively denies visible MCP tools for a live Agent with no prior layer', async () => {
  const { dir, file, store } = await temporaryStore()
  const harness = makeActivation(store)
  try {
    await writeFile(file, '{"version":4,"mcp":', 'utf8')
    const live = harness.addAgent('a')
    await harness.activation.reapplyAll()
    assert.equal(live.restrictions.length, 1, 'the live Agent is not left ungated')
    assert.deepEqual(live.restrictions[0].deny, ['mcp__kb__search', 'mcp__other__x'])
    assert.equal(live.restrictions[0].disposed, false)

    // A repaired document replaces the fallback only after the normal layer is
    // installed; the fallback is treated as a restriction, not as disposable
    // metadata.
    await store.write(validState())
    await harness.activation.reapplyAll()
    assert.equal(live.restrictions[0].disposed, true)
    assert.equal(live.restrictions.length, 2)
    assert.deepEqual(live.restrictions[1].deny, ['mcp__kb__search', 'mcp__other__x'])
  } finally {
    harness.activation.disposeAll()
    await rm(dir, { recursive: true, force: true })
  }
})


test('an unsupported version is not echoed, even when it contains sensitive text', async () => {
  const { dir, file, store } = await temporaryStore()
  try {
    const sensitive = 'Bearer unsupported-version-fixture-not-real'
    await writeFile(file, JSON.stringify({ version: sensitive }), 'utf8')
    await assert.rejects(store.read({ fresh: true }), (error) => {
      assert.equal(error.code, 'resource-pool/state-unsupported-version')
      assert.equal(String(error.message).includes(sensitive), false)
      return true
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an inert legacy group written by an older API still reads, but its key is not treated as a scope', async () => {
  const { dir, file, store } = await temporaryStore()
  try {
    const legacy = validState()
    // The old API accepted any group key. Only repo:/import: keys can ever be
    // referenced by a source, so preserving this entry cannot widen access.
    legacy.groups['legacy-group'] = {
      key: 'legacy-group',
      kind: 'repo',
      enabled: true,
      modes: ['a-mode-that-does-not-exist'],
      workspaces: ['/legacy-workspace'],
    }
    await writeFile(file, JSON.stringify(legacy), 'utf8')
    const read = await store.read({ fresh: true })
    assert.deepEqual(read.groups['legacy-group'], legacy.groups['legacy-group'])
    // The MCP member has no source/group, so the inert group cannot change it.
    assert.equal(read.mcp.kb.modesFrom, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a dangerous legacy group key is still rejected by the strict reader', async () => {
  const { dir, file, store } = await temporaryStore()
  try {
    const base = JSON.stringify(validState())
    const text = base.replace(
      '"groups":{}',
      '"groups":{"__proto__":{"key":"__proto__","kind":"repo","modes":[],"workspaces":[]}}',
    )
    await writeFile(file, text, 'utf8')
    await rejectsClosed(store.read({ fresh: true }), 'resource-pool/state-invalid-document')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the panel rejects invalid scope and switch inputs without widening or rewriting state', async () => {
  const api = await makeApi()
  try {
    const before = await readFile(api.file)
    const badRequests = [
      ['POST', '/item', { kind: 'mcp', name: 'kb', modes: [123] }, 'resource-pool/bad-scope'],
      ['POST', '/item', { kind: 'mcp', name: 'kb', modes: ['bad mode'] }, 'resource-pool/bad-scope'],
      ['POST', '/item', { kind: 'mcp', name: 'kb', workspaces: ['relative/path'] }, 'resource-pool/bad-scope'],
      ['POST', '/item', { kind: 'mcp', name: 'kb', enabled: 'false' }, 'resource-pool/bad-scope'],
      ['POST', '/group', { key: 'repo:example/project', modes: [123] }, 'resource-pool/bad-group'],
      ['POST', '/group', { key: 'repo:example/project', workspaces: ['relative'] }, 'resource-pool/bad-group'],
      ['POST', '/group', { key: 'legacy-group', enabled: false }, 'resource-pool/bad-group'],
      ['POST', '/settings', { patch: { enabled: 'false' } }, 'resource-pool/bad-settings'],
      ['POST', '/mcp/import', { payload: { mcpServers: { probe: { url: 'http://127.0.0.1:65535/mcp' } } }, scope: { modes: [123] } }, 'resource-pool/bad-scope'],
    ]
    for (const [method, path, body, code] of badRequests) {
      const response = await api.call(method, path, body)
      assert.equal(response.status, 400, `${method} ${path}`)
      assert.equal(response.payload.error.code, code, `${method} ${path}`)
      assert.deepEqual(await readFile(api.file), before, `${method} ${path} preserves bytes`)
    }
    const after = await api.call('GET', '')
    assert.deepEqual(after.payload.state.mcp.kb.modes, ['b'])
    assert.deepEqual(after.payload.state.mcp.kb.workspaces, [])
  } finally {
    await api.dispose()
  }
})

test('a partial valid item update still preserves the untouched condition fields', async () => {
  const api = await makeApi()
  try {
    const response = await api.call('POST', '/item', { kind: 'mcp', name: 'kb', enabled: false })
    assert.equal(response.status, 200)
    assert.equal(response.payload.state.mcp.kb.enabled, false)
    assert.deepEqual(response.payload.state.mcp.kb.modes, ['b'])
    assert.deepEqual(response.payload.state.mcp.kb.workspaces, [])
  } finally {
    await api.dispose()
  }
})

test('a committed but degraded re-application is reported as a redacted warning', async () => {
  const api = await makeApi(validState(), {
    onChanged: async () => ({
      total: 1,
      failed: 1,
      warnings: [{ code: 'resource-pool/activation-degraded', message: 'Bearer hidden-fixture-not-real' }],
    }),
  })
  try {
    const response = await api.call('POST', '/item', { kind: 'mcp', name: 'kb', enabled: false })
    assert.equal(response.status, 200)
    assert.equal(response.payload.ok, true)
    assert.equal(response.payload.state.mcp.kb.enabled, false)
    assert.equal(response.payload.warning?.code, 'resource-pool/activation-degraded')
    assert.equal(JSON.stringify(response.payload).includes('hidden-fixture-not-real'), false)
    const persisted = JSON.parse(await readFile(api.file, 'utf8'))
    assert.equal(persisted.mcp.kb.enabled, false, 'the committed state is retained')
  } finally {
    await api.dispose()
  }
})

test('reapplyAll reports a failed count when an existing healthy layer is kept', async () => {
  const { dir, file, store } = await temporaryStore()
  const harness = makeActivation(store)
  try {
    await store.write(validState())
    const agent = harness.addAgent('a')
    await harness.activation.applyToAgent(agent)
    assert.equal(agent.restrictions.length, 1)

    await writeFile(file, '{"version":4,"mcp":', 'utf8')
    const result = await harness.activation.reapplyAll()
    assert.equal(result.failed, 1)
    assert.equal(agent.restrictions[0].disposed, false)
  } finally {
    harness.activation.disposeAll()
    await rm(dir, { recursive: true, force: true })
  }
})

test('conservative fallback refreshes on every explicit reapply when new MCP tools appear', async () => {
  const { dir, file, store } = await temporaryStore()
  const schemasRef = { current: [] }
  const harness = makeActivation(store, { schemas: () => schemasRef.current })
  try {
    await writeFile(file, '{"version":4,"mcp":', 'utf8')
    const agent = harness.addAgent('a')

    // No visible MCP tools yet: the live Agent is recorded as conservative but
    // there is no restriction to install.
    await harness.activation.reapplyAll()
    assert.equal(agent.restrictions.length, 0)

    schemasRef.current = [{ name: 'mcp__kb__search' }]
    await harness.activation.reapplyAll()
    assert.equal(agent.restrictions.length, 1, 'a later explicit reapply sees the new tool')
    assert.deepEqual(agent.restrictions[0].deny, ['mcp__kb__search'])

    schemasRef.current = [{ name: 'mcp__kb__search' }, { name: 'mcp__new__x' }]
    await harness.activation.reapplyAll()
    assert.equal(agent.restrictions.length, 2)
    assert.equal(agent.restrictions[0].disposed, true, 'the old fallback is released after the new one is safe')
    assert.deepEqual(agent.restrictions[1].deny, ['mcp__kb__search', 'mcp__new__x'])
  } finally {
    harness.activation.disposeAll()
    await rm(dir, { recursive: true, force: true })
  }
})


test('a v4 body mislabeled as v3 is rejected instead of dropping groups and inheritance', async () => {
  const { dir, file, store } = await temporaryStore()
  try {
    const v4 = normalizeState(legacyDocument())
    const mislabeled = { ...v4, version: 3 }
    await writeFile(file, JSON.stringify(mislabeled), 'utf8')
    await rejectsClosed(store.read({ fresh: true }), 'resource-pool/state-invalid-document')

    // A v3-shaped document that merely adds an empty top-level groups object is
    // still safe to migrate; the v4-only fields are what must be rejected.
    const contractV3 = legacyDocument()
    contractV3.groups = {}
    await writeFile(file, JSON.stringify(contractV3), 'utf8')
    assert.equal((await store.read({ fresh: true })).version, 4)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('v4 members and groups must state enabled explicitly, never default it to true', async () => {
  const { dir, file, store } = await temporaryStore()
  try {
    const memberMissing = validState()
    delete memberMissing.mcp.kb.enabled
    await writeFile(file, JSON.stringify(memberMissing), 'utf8')
    await rejectsClosed(store.read({ fresh: true }), 'resource-pool/state-invalid-document')

    const groupMissing = validState()
    groupMissing.groups['repo:example/project'] = {
      key: 'repo:example/project', kind: 'repo', modes: [], workspaces: [],
    }
    await writeFile(file, JSON.stringify(groupMissing), 'utf8')
    await rejectsClosed(store.read({ fresh: true }), 'resource-pool/state-invalid-document')

    const v3MemberMissing = legacyDocument()
    delete v3MemberMissing.skills['lark-doc'].enabled
    await writeFile(file, JSON.stringify(v3MemberMissing), 'utf8')
    await rejectsClosed(store.read({ fresh: true }), 'resource-pool/state-invalid-document')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a dangling source reference is rejected only when an inherited scope depends on it', async () => {
  const { dir, file, store } = await temporaryStore()
  try {
    const inherited = validState()
    inherited.skills.shared = {
      enabled: true, modes: [], workspaces: [], modesFrom: 'group', workspacesFrom: 'group', sourceId: 'missing',
    }
    await writeFile(file, JSON.stringify(inherited), 'utf8')
    await rejectsClosed(store.read({ fresh: true }), 'resource-pool/state-invalid-document')

    // Explicit self scopes keep their own lists authoritative, so stale
    // provenance cannot widen anything; older legal data remains readable.
    const selfScoped = validState()
    selfScoped.skills.shared = {
      enabled: true, modes: ['a'], workspaces: ['/w'], modesFrom: 'self', workspacesFrom: 'self', sourceId: 'missing',
    }
    await writeFile(file, JSON.stringify(selfScoped), 'utf8')
    const read = await store.read({ fresh: true })
    assert.deepEqual(read.skills.shared.modes, ['a'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/** Build a minimal stored ZIP with one `name/SKILL.md` entry. */
function storedZip(name, content) {
  const data = Buffer.from(content, 'utf8')
  const file = Buffer.from(`${name}/SKILL.md`, 'utf8')
  const crc = zlib.crc32(data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6)
  local.writeUInt16LE(0, 8)
  local.writeUInt16LE(0, 10)
  local.writeUInt16LE(0, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(file.length, 26)
  local.writeUInt16LE(0, 28)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 8)
  central.writeUInt16LE(0, 10)
  central.writeUInt16LE(0, 12)
  central.writeUInt16LE(0, 14)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(file.length, 28)
  central.writeUInt16LE(0, 30)
  central.writeUInt16LE(0, 32)
  central.writeUInt16LE(0, 34)
  central.writeUInt16LE(0, 36)
  central.writeUInt32LE(0, 38)
  central.writeUInt32LE(0, 42)
  const centralOffset = local.length + file.length + data.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + file.length, 12)
  end.writeUInt32LE(centralOffset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([local, file, data, central, file, end])
}

/** A shared skill state where one repo group scopes two sources. */
function sharedSourceState({ groupEnabled = true, memberMode = 'group' } = {}) {
  return normalizeState({
    version: 4,
    settings: { enabled: true, mcpGate: true, injectSummary: true, gateDefaultSkills: false },
    sources: {
      src_a: {
        id: 'src_a', kind: 'git', label: 'a', url: 'https://github.com/example/project', provider: 'github',
        project: 'example/project', branch: 'main', subdir: '', skills: ['shared'], excluded: [], createdAt: '2026-11-18T00:00:00.000Z',
      },
      src_b: {
        id: 'src_b', kind: 'git', label: 'b', url: 'https://github.com/example/project', provider: 'github',
        project: 'example/project', branch: 'main', subdir: 'other', skills: ['shared'], excluded: [], createdAt: '2026-11-18T00:00:00.000Z',
      },
    },
    groups: {
      'repo:example/project': {
        key: 'repo:example/project', kind: 'repo', enabled: groupEnabled, modes: ['standard'], workspaces: ['/workspace'],
      },
    },
    skills: {
      shared: {
        enabled: true, modes: [], workspaces: [],
        modesFrom: memberMode, workspacesFrom: memberMode,
        sourceId: 'src_a', installedAt: '2026-11-18T00:00:00.000Z',
      },
    },
    mcp: {},
  })
}

test('deleting one of several shared sources materializes the effective scope before clearing sourceId', async () => {
  const api = await makeApi(sharedSourceState({ groupEnabled: false }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = api.dir
  try {
    const before = await api.call('GET', '/resolve?mode=standard&cwd=%2Fworkspace')
    assert.equal(before.payload.pool.gated, true)
    assert.deepEqual(before.payload.pool.skills, [], 'the disabled group makes the shared skill inactive')

    const removed = await api.call('POST', '/source/delete', { id: 'src_a' })
    assert.equal(removed.status, 200)
    const member = removed.payload.state.skills.shared
    assert.ok(member, 'the skill remains because src_b still lists it')
    assert.equal(member.sourceId ?? '', '')
    assert.equal(member.enabled, false, 'effective disabled state is materialized')
    assert.deepEqual(member.modes, ['standard'])
    assert.deepEqual(member.workspaces, ['/workspace'])
    assert.equal(member.modesFrom, 'self')
    assert.equal(member.workspacesFrom, 'self')

    const after = await api.call('GET', '/resolve?mode=standard&cwd=%2Fworkspace')
    assert.deepEqual(after.payload.pool.skills, [], 'effective visibility did not widen')
    // It must still be readable by the strict reader (no dangling group scope).
    assert.equal((await api.call('GET', '')).status, 200)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await api.dispose()
  }
})

test('concurrent deletion of all shared sources cannot widen the remaining member', async () => {
  const api = await makeApi(sharedSourceState({ groupEnabled: true }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = api.dir
  try {
    const before = await api.call('GET', '/resolve?mode=standard&cwd=%2Fworkspace')
    assert.deepEqual(before.payload.pool.skills, ['shared'])

    const [first, second] = await Promise.all([
      api.call('POST', '/source/delete', { id: 'src_a' }),
      api.call('POST', '/source/delete', { id: 'src_b' }),
    ])
    for (const response of [first, second]) {
      assert.ok(response.status === 200 || response.status === 404, `unexpected status ${response.status}`)
    }

    const overview = await api.call('GET', '')
    assert.equal(overview.status, 200, 'the final document is still readable')
    const member = overview.payload.state.skills.shared
    if (member !== undefined) {
      assert.equal(member.modesFrom, 'self')
      assert.equal(member.workspacesFrom, 'self')
      assert.deepEqual(member.modes, ['standard'])
      assert.deepEqual(member.workspaces, ['/workspace'])
    }
    const after = await api.call('GET', '/resolve?mode=standard&cwd=%2Fworkspace')
    assert.deepEqual(
      after.payload.pool.skills.filter((name) => !before.payload.pool.skills.includes(name)),
      [],
      'concurrent deletes cannot add a visible skill',
    )
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await api.dispose()
  }
})

test('a self-scoped shared member keeps its own scope when its source is deleted', async () => {
  const api = await makeApi(sharedSourceState({ memberMode: 'self' }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = api.dir
  try {
    const member = sharedSourceState({ memberMode: 'self' }).skills.shared
    member.modes = ['special']
    member.workspaces = ['/special']
    // Rewrite the fixture with the member's real self scope.
    await writeFile(api.file, JSON.stringify({
      ...sharedSourceState({ memberMode: 'self' }),
      skills: { shared: { ...sharedSourceState({ memberMode: 'self' }).skills.shared, modes: ['special'], workspaces: ['/special'] } },
    }), 'utf8')

    const removed = await api.call('POST', '/source/delete', { id: 'src_a' })
    assert.equal(removed.status, 200)
    const after = removed.payload.state.skills.shared
    assert.deepEqual(after.modes, ['special'])
    assert.deepEqual(after.workspaces, ['/special'])
    assert.equal(after.modesFrom, 'self')
    assert.equal(after.workspacesFrom, 'self')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await api.dispose()
  }
})

test('ambiguous mcp__ names are denied even when their prefix names an allowed server', async () => {
  const state = normalizeState({
    version: 4,
    settings: { enabled: true, mcpGate: true, injectSummary: false, gateDefaultSkills: false },
    skills: {}, sources: {}, groups: {},
    mcp: { alpha: { enabled: true, modes: [], workspaces: [], installedAt: '2026-11-18T00:00:00.000Z' } },
  })
  const harness = makeActivation({
    async read() { return state },
  }, {
    schemas: () => [{ name: 'mcp__alpha__search' }, { name: 'mcp__alpha__a__x' }],
  })
  try {
    const agent = harness.addAgent('a')
    await harness.activation.applyToAgent(agent)
    assert.deepEqual(agent.restrictions[0]?.deny, ['mcp__alpha__a__x'])
  } finally {
    harness.activation.disposeAll()
  }
})

test('a new StateStore in the same process still remembers an observed state file', async () => {
  const { dir, file } = await temporaryStore()
  try {
    const first = new StateStore({ file })
    await first.write(validState())
    const second = new StateStore({ file })
    await unlink(file)
    await rejectsClosed(second.read({ fresh: true }), 'resource-pool/state-missing')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('state error messages never echo map keys, newlines or long sensitive text', async () => {
  const { dir, file, store } = await temporaryStore()
  try {
    const sensitive = 'fixture-secret-map-key\nBearer not-a-real-token-' + 'x'.repeat(400)
    const document = validState()
    document.sources = { [sensitive]: 'not-an-object' }
    await writeFile(file, JSON.stringify(document), 'utf8')
    await assert.rejects(store.read({ fresh: true }), (error) => {
      assert.equal(error.code, 'resource-pool/state-invalid-document')
      assert.equal(String(error.message).includes('fixture-secret-map-key'), false)
      assert.equal(/[\r\n]/.test(String(error.message)), false)
      assert.ok(String(error.message).length <= 300, `message is bounded: ${String(error.message).length}`)
      return true
    })

    const groupDoc = validState()
    groupDoc.groups = { [sensitive]: 'not-an-object' }
    await writeFile(file, JSON.stringify(groupDoc), 'utf8')
    await assert.rejects(store.read({ fresh: true }), (error) => {
      assert.equal(String(error.message).includes('fixture-secret-map-key'), false)
      assert.equal(/[\r\n]/.test(String(error.message)), false)
      return true
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


test('a non-ENOENT read error is remembered process-wide before the path disappears', async () => {
  const { dir, file } = await temporaryStore()
  try {
    await mkdir(file)
    const first = new StateStore({ file })
    await rejectsClosed(first.read({ fresh: true }), 'resource-pool/state-unreadable')
    await rm(file, { recursive: true, force: true })

    const second = new StateStore({ file })
    await rejectsClosed(second.read({ fresh: true }), 'resource-pool/state-missing')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a group marker without a resolvable group remains a valid legacy fallback to own scope', async () => {
  const { dir, file, store } = await temporaryStore()
  try {
    const state = validState()
    state.skills.local = {
      enabled: true,
      modes: [],
      workspaces: [],
      modesFrom: 'group',
      workspacesFrom: 'group',
      installedAt: '',
    }
    await writeFile(file, JSON.stringify(state), 'utf8')
    const read = await store.read({ fresh: true })
    assert.deepEqual(read.skills.local.modes, [])
    // This is the documented no-group fallback: own scope, which here is "all".
    assert.equal(read.skills.local.modesFrom, 'group')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an API mode edit that would be ignored by a resolvable group is rejected instead of silently discarded', async () => {
  const api = await makeApi(sharedSourceState({ groupEnabled: true }))
  try {
    const before = await readFile(api.file)
    const inherited = await api.call('POST', '/item', {
      kind: 'skill', name: 'shared', modes: ['x'],
    })
    assert.equal(inherited.status, 400)
    assert.equal(inherited.payload.error.code, 'resource-pool/bad-scope')
    assert.match(inherited.payload.error.message, /self/)
    assert.deepEqual(await readFile(api.file), before)

    const ignoredWorkspaces = await api.call('POST', '/item', {
      kind: 'skill', name: 'shared', workspaces: ['/other'],
    })
    assert.equal(ignoredWorkspaces.status, 400)
    assert.match(ignoredWorkspaces.payload.error.message, /workspacesFrom: 'self'/)

    const selfEdit = await api.call('POST', '/item', {
      kind: 'skill', name: 'shared', modes: ['x'], modesFrom: 'self',
    })
    assert.equal(selfEdit.status, 200)
    assert.deepEqual(selfEdit.payload.state.skills.shared.modes, ['x'])
    assert.equal(selfEdit.payload.state.skills.shared.modesFrom, 'self')
  } finally {
    await api.dispose()
  }
})

test('an API group marker with no resolvable group is rejected only when it would change scope', async () => {
  const fixture = validState()
  // A normal no-source skill with the legacy default marker and an empty own
  // scope. Missing group falls back to the member's own list by contract.
  fixture.skills.local = {
    enabled: true, modes: [], workspaces: [], modesFrom: 'group', workspacesFrom: 'group', installedAt: '',
  }
  const api = await makeApi(fixture)
  try {
    // No source and no group: changing modes while continuing to claim group
    // inheritance is ambiguous, so reject it.
    const ambiguous = await api.call('POST', '/item', {
      kind: 'skill', name: 'local', modes: ['c'], modesFrom: 'group',
    })
    assert.equal(ambiguous.status, 400)
    assert.equal(ambiguous.payload.error.code, 'resource-pool/bad-scope')
    assert.equal(/state/i.test(ambiguous.payload.error.message), false, 'this is not a corrupt-state error')

    // An enabled-only panel save sends the unchanged legacy marker and values;
    // it must keep working (partial-update compatibility).
    const enabledOnly = await api.call('POST', '/item', {
      kind: 'skill', name: 'local', enabled: false, modes: [], workspaces: [], modesFrom: 'group', workspacesFrom: 'group',
    })
    assert.equal(enabledOnly.status, 200)
    assert.equal(enabledOnly.payload.state.skills.local.enabled, false)
    assert.deepEqual(enabledOnly.payload.state.skills.local.modes, [])

    // Explicitly switching to self is the documented way to change the scope.
    const selfEdit = await api.call('POST', '/item', {
      kind: 'skill', name: 'local', modes: ['c'], modesFrom: 'self',
    })
    assert.equal(selfEdit.status, 200)
    assert.equal(selfEdit.payload.state.skills.local.modesFrom, 'self')
    assert.deepEqual(selfEdit.payload.state.skills.local.modes, ['c'])
  } finally {
    await api.dispose()
  }
})


test('a conservative fallback keeps its old deny when the visible tool list becomes empty', async () => {
  const { dir, file, store } = await temporaryStore()
  const schemasRef = { current: [{ name: 'mcp__kv__read' }] }
  const harness = makeActivation(store, { schemas: () => schemasRef.current })
  try {
    await writeFile(file, '{"version":4,"mcp":', 'utf8')
    const agent = harness.addAgent('a')
    await harness.activation.reapplyAll()
    assert.deepEqual(agent.restrictions[0].deny, ['mcp__kv__read'])

    // A transient empty tool surface must not release the only deny we have.
    schemasRef.current = []
    await harness.activation.reapplyAll()
    assert.equal(agent.restrictions[0].disposed, false, 'the previous conservative deny is retained')
    assert.deepEqual(agent.restrictions[0].deny, ['mcp__kv__read'])

    // If the same tool reappears without another reapply, the retained layer
    // still denies it.
    schemasRef.current = [{ name: 'mcp__kv__read' }]
    assert.equal(agent.restrictions.filter((entry) => entry.disposed === false).length, 1)
    assert.deepEqual(agent.restrictions[0].deny, ['mcp__kv__read'])
  } finally {
    harness.activation.disposeAll()
    await rm(dir, { recursive: true, force: true })
  }
})


test('re-importing a group-scoped skill through files preserves effective scope and disabled state', async () => {
  const api = await makeApi(sharedSourceState())
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = api.dir
  const content = '---\nname: shared\ndescription: probe\n---\nbody\n'
  try {
    const upload = await api.call('POST', '/skill/upload', {
      files: [{ path: 'shared/SKILL.md', content }],
      overwrite: true,
    })
    assert.equal(upload.status, 200)
    const member = upload.payload.state.skills.shared
    assert.notEqual(member.sourceId, 'src_a')
    assert.equal(member.modesFrom, 'self')
    assert.equal(member.workspacesFrom, 'self')
    assert.deepEqual(member.modes, ['standard'])
    assert.deepEqual(member.workspaces, ['/workspace'])
    assert.equal(member.enabled, true)

    const allowed = await api.call('GET', '/resolve?mode=standard&cwd=%2Fworkspace')
    assert.deepEqual(allowed.payload.pool.skills, ['shared'])
    const denied = await api.call('GET', '/resolve?mode=ptc&cwd=%2Felsewhere')
    assert.deepEqual(denied.payload.pool.skills, [])
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await api.dispose()
  }
})

test('re-importing a group-scoped skill with an explicit scope stores self, not a group that overrides it', async () => {
  const api = await makeApi(sharedSourceState())
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = api.dir
  const content = '---\nname: shared\ndescription: probe\n---\nbody\n'
  try {
    const upload = await api.call('POST', '/skill/upload', {
      files: [{ path: 'shared/SKILL.md', content }],
      overwrite: true,
      scope: { modes: ['upload-mode'] },
    })
    assert.equal(upload.status, 200)
    const member = upload.payload.state.skills.shared
    assert.equal(member.modesFrom, 'self')
    assert.deepEqual(member.modes, ['upload-mode'])
    assert.deepEqual(member.workspaces, ['/workspace'], 'unmodified dimension keeps its effective scope')
    const allowed = await api.call('GET', '/resolve?mode=upload-mode&cwd=%2Fworkspace')
    assert.deepEqual(allowed.payload.pool.skills, ['shared'])
    const oldMode = await api.call('GET', '/resolve?mode=standard&cwd=%2Fworkspace')
    assert.deepEqual(oldMode.payload.pool.skills, [])
    const elsewhere = await api.call('GET', '/resolve?mode=upload-mode&cwd=%2Felsewhere')
    assert.deepEqual(elsewhere.payload.pool.skills, [])
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await api.dispose()
  }
})

test('re-importing a skill whose old group was disabled keeps it disabled', async () => {
  const api = await makeApi(sharedSourceState({ groupEnabled: false }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = api.dir
  const content = '---\nname: shared\ndescription: probe\n---\nbody\n'
  try {
    const upload = await api.call('POST', '/skill/upload', {
      files: [{ path: 'shared/SKILL.md', content }],
      overwrite: true,
    })
    assert.equal(upload.status, 200)
    const member = upload.payload.state.skills.shared
    assert.equal(member.enabled, false)
    const resolve = await api.call('GET', '/resolve?mode=standard&cwd=%2Fworkspace')
    assert.deepEqual(resolve.payload.pool.skills, [])
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await api.dispose()
  }
})

test('the ZIP re-import path shares the same effective-scope preservation', async () => {
  const api = await makeApi(sharedSourceState())
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = api.dir
  const archive = storedZip('shared', '---\nname: shared\ndescription: probe\n---\nbody\n').toString('base64')
  try {
    const upload = await api.call('POST', '/skill/zip', { archiveBase64: archive, overwrite: true })
    assert.equal(upload.status, 200)
    const member = upload.payload.state.skills.shared
    assert.equal(member.modesFrom, 'self')
    assert.deepEqual(member.modes, ['standard'])
    assert.deepEqual(member.workspaces, ['/workspace'])
    const denied = await api.call('GET', '/resolve?mode=ptc&cwd=%2Felsewhere')
    assert.deepEqual(denied.payload.pool.skills, [])
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await api.dispose()
  }
})

test('an empty import: group key is rejected without touching bytes', async () => {
  const api = await makeApi()
  try {
    const before = await readFile(api.file)
    for (const key of ['import:', 'repo:']) {
      const response = await api.call('POST', '/group', { key })
      assert.equal(response.status, 400, key)
      assert.equal(response.payload.error.code, 'resource-pool/bad-group')
      assert.deepEqual(await readFile(api.file), before)
    }
  } finally {
    await api.dispose()
  }
})


test('the panel inheritance action self -> group is accepted when the group resolves', async () => {
  const state = sharedSourceState({ memberMode: 'self' })
  state.skills.shared.modes = ['x']
  state.skills.shared.workspaces = ['/x']
  const api = await makeApi(state)
  try {
    // This is the body the panel's inherit button flushes: current values are
    // still sent, but modesFrom/workspacesFrom switch to group.
    const response = await api.call('POST', '/item', {
      kind: 'skill', name: 'shared', enabled: true,
      modes: ['x'], workspaces: ['/x'], modesFrom: 'group', workspacesFrom: 'group',
    })
    assert.equal(response.status, 200)
    const member = response.payload.state.skills.shared
    assert.equal(member.modesFrom, 'group')
    assert.equal(member.workspacesFrom, 'group')
    const groupMode = await api.call('GET', '/resolve?mode=standard&cwd=%2Fworkspace')
    assert.deepEqual(groupMode.payload.pool.skills, ['shared'])
    const ownMode = await api.call('GET', '/resolve?mode=x&cwd=%2Fx')
    assert.deepEqual(ownMode.payload.pool.skills, [])
  } finally {
    await api.dispose()
  }
})

test('a marker-only group -> self switch materializes the effective scope instead of widening', async () => {
  const api = await makeApi(sharedSourceState())
  try {
    // The panel's inherit-off action sends the unchanged own (empty) values.
    const response = await api.call('POST', '/item', {
      kind: 'skill', name: 'shared', modes: [], workspaces: [], modesFrom: 'self', workspacesFrom: 'self',
    })
    assert.equal(response.status, 200)
    const member = response.payload.state.skills.shared
    assert.equal(member.modesFrom, 'self')
    assert.equal(member.workspacesFrom, 'self')
    assert.deepEqual(member.modes, ['standard'])
    assert.deepEqual(member.workspaces, ['/workspace'])

    const groupMode = await api.call('GET', '/resolve?mode=standard&cwd=%2Fworkspace')
    assert.deepEqual(groupMode.payload.pool.skills, ['shared'])
    const other = await api.call('GET', '/resolve?mode=ptc&cwd=%2Felsewhere')
    assert.deepEqual(other.payload.pool.skills, [])
  } finally {
    await api.dispose()
  }
})


test('a transient empty tool list keeps the healthy restrict layer until a real change is visible', async () => {
  const { dir, file, store } = await temporaryStore()
  const schemasRef = { current: [{ name: 'mcp__kb__search' }] }
  const harness = makeActivation(store, { schemas: () => schemasRef.current })
  try {
    await store.write(validState())
    const agent = harness.addAgent('a')
    await harness.activation.applyToAgent(agent)
    assert.equal(agent.restrictions.length, 1)
    assert.equal(agent.restrictions[0].disposed, false)

    schemasRef.current = []
    await harness.activation.applyToAgent(agent, { force: true })
    assert.equal(agent.restrictions[0].disposed, false, 'an empty snapshot must not release the previous deny')

    schemasRef.current = [{ name: 'mcp__kb__search' }]
    await harness.activation.applyToAgent(agent, { force: true })
    assert.equal(agent.restrictions[0].disposed, true)
    assert.equal(agent.restrictions.length, 2)
    assert.deepEqual(agent.restrictions[1].deny, ['mcp__kb__search'])
  } finally {
    harness.activation.disposeAll()
    await rm(dir, { recursive: true, force: true })
  }
})

test('an explicit mcpGate off still releases the old deny even with an empty tool list', async () => {
  const { dir, store } = await temporaryStore()
  const schemasRef = { current: [{ name: 'mcp__kb__search' }] }
  const harness = makeActivation(store, { schemas: () => schemasRef.current })
  try {
    await store.write(validState())
    const agent = harness.addAgent('a')
    await harness.activation.applyToAgent(agent)
    assert.equal(agent.restrictions.length, 1)

    schemasRef.current = []
    const off = validState()
    off.settings.mcpGate = false
    await store.write(off)
    await harness.activation.applyToAgent(agent, { force: true })
    assert.equal(agent.restrictions[0].disposed, true, 'the user explicitly disabled MCP gating')
  } finally {
    harness.activation.disposeAll()
    await rm(dir, { recursive: true, force: true })
  }
})


test('source/update on the same disabled group keeps the member enabled flag for re-enabling', async () => {
  const api = await makeApi(sharedSourceState({ groupEnabled: false }))
  try {
    const hooks = api.testHooks
    assert.equal(typeof hooks?.installItems, 'function')
    const current = await api.store.read({ fresh: true })
    const previous = hooks.captureEffectiveScopes(current, ['shared'])
    const movedSource = { ...current.sources.src_a, subdir: 'moved' }
    let next = upsertSource(current, movedSource)
    next = hooks.installItems(next, ['shared'], {
      scope: undefined, sourceId: 'src_a', digests: {}, installedAt: '2026-11-19T00:00:00.000Z', previous,
    })
    assert.equal(next.skills.shared.enabled, true, 'the member own enabled flag is preserved')
    assert.equal(next.skills.shared.modesFrom, 'group')
    const disabled = await (await import('../src/rules.js')).resolvePool(next, { mode: 'standard', cwd: '/workspace' })
    assert.deepEqual(disabled.skills, [], 'the disabled group still makes it inactive')

    const enabled = upsertGroup(next, { key: 'repo:example/project', enabled: true })
    const restored = await (await import('../src/rules.js')).resolvePool(enabled, { mode: 'standard', cwd: '/workspace' })
    assert.deepEqual(restored.skills, ['shared'], 're-enabling the same group restores the member')
  } finally {
    await api.dispose()
  }
})

test('source/update that loses its group materializes the old effective disabled state', async () => {
  const api = await makeApi(sharedSourceState({ groupEnabled: false }))
  try {
    const hooks = api.testHooks
    const current = await api.store.read({ fresh: true })
    const previous = hooks.captureEffectiveScopes(current, ['shared'])
    const projectChanged = { ...current.sources.src_a, project: 'example/other', url: 'https://github.com/example/other' }
    let next = upsertSource(current, projectChanged)
    next = hooks.installItems(next, ['shared'], {
      scope: undefined, sourceId: 'src_a', digests: {}, installedAt: '2026-11-19T00:00:00.000Z', previous,
    })
    assert.equal(next.skills.shared.enabled, false, 'old effective disabled is materialized')
    assert.equal(next.skills.shared.modesFrom, 'self')
    assert.deepEqual(next.skills.shared.modes, ['standard'])
    const enabled = upsertGroup(next, { key: 'repo:example/project', enabled: true })
    const restored = await (await import('../src/rules.js')).resolvePool(enabled, { mode: 'standard', cwd: '/workspace' })
    assert.deepEqual(restored.skills, [], 'the old group must not resurrect a detached member')
  } finally {
    await api.dispose()
  }
})


test('a non-empty snapshot where every visible MCP tool is now allowed releases the old deny', async () => {
  const { dir, file, store } = await temporaryStore()
  const schemasRef = { current: [{ name: 'mcp__kb__search' }] }
  const harness = makeActivation(store, { schemas: () => schemasRef.current })
  try {
    await store.write(validState())
    const agent = harness.addAgent('a')
    await harness.activation.applyToAgent(agent)
    assert.deepEqual(agent.restrictions[0].deny, ['mcp__kb__search'])

    // The user enables the member for every mode; the snapshot is still
    // non-empty and the same tool is now authorized.
    const widened = validState()
    widened.mcp.kb.modes = []
    await store.write(widened)
    await harness.activation.applyToAgent(agent, { force: true })
    assert.equal(agent.restrictions[0].disposed, true, 'a real all-allowed snapshot releases the old deny')
    assert.equal(agent.restrictions.filter((entry) => entry.disposed === false).length, 0)
  } finally {
    harness.activation.disposeAll()
    await rm(dir, { recursive: true, force: true })
  }
})

test('empty snapshot then reappearing all-allowed tools releases the retained deny', async () => {
  const { dir, store } = await temporaryStore()
  const schemasRef = { current: [{ name: 'mcp__kb__search' }] }
  const harness = makeActivation(store, { schemas: () => schemasRef.current })
  try {
    await store.write(validState())
    const agent = harness.addAgent('a')
    await harness.activation.applyToAgent(agent)

    schemasRef.current = []
    await harness.activation.applyToAgent(agent, { force: true })
    assert.equal(agent.restrictions[0].disposed, false, 'empty snapshot retains the old deny')

    const widened = validState()
    widened.mcp.kb.modes = []
    await store.write(widened)
    schemasRef.current = [{ name: 'mcp__kb__search' }]
    await harness.activation.applyToAgent(agent, { force: true })
    assert.equal(agent.restrictions[0].disposed, true)
  } finally {
    harness.activation.disposeAll()
    await rm(dir, { recursive: true, force: true })
  }
})


test('a re-import into a different disabled group leaves the new group switch in charge', async () => {
  const api = await makeApi(sharedSourceState({ groupEnabled: true }))
  try {
    const hooks = api.testHooks
    const current = await api.store.read({ fresh: true })
    const previous = hooks.captureEffectiveScopes(current, ['shared'])
    const other = {
      id: 'src_other', kind: 'git', label: 'other', url: 'https://github.com/example/other',
      provider: 'github', project: 'example/other', branch: 'main', subdir: '',
      skills: ['shared'], excluded: [], createdAt: '2026-11-19T00:00:00.000Z',
    }
    let next = upsertSource(current, other)
    next = {
      ...next,
      groups: {
        ...next.groups,
        'repo:example/other': { key: 'repo:example/other', kind: 'repo', enabled: false, modes: ['standard'], workspaces: ['/workspace'] },
      },
    }
    next = hooks.installItems(next, ['shared'], {
      scope: undefined, sourceId: 'src_other', digests: {}, installedAt: '2026-11-19T00:00:00.000Z', previous,
    })
    assert.equal(next.skills.shared.enabled, true, 'own enabled stays as before')
    assert.equal(next.skills.shared.modesFrom, 'group', 'equivalent group values keep inheritance')
    const rules = await import('../src/rules.js')
    assert.deepEqual(rules.resolvePool(next, { mode: 'standard', cwd: '/workspace' }).skills, [], 'the new disabled group switch hides it')
    const enabled = upsertGroup(next, { key: 'repo:example/other', enabled: true })
    assert.deepEqual(rules.resolvePool(enabled, { mode: 'standard', cwd: '/workspace' }).skills, ['shared'])
  } finally {
    await api.dispose()
  }
})


test('a recovered-but-empty snapshot stays conservative after the file breaks again', async () => {
  const { dir, file, store } = await temporaryStore()
  const schemasRef = { current: [{ name: 'mcp__kv__read' }] }
  const harness = makeActivation(store, { schemas: () => schemasRef.current })
  try {
    await writeFile(file, '{"version":4,"mcp":', 'utf8')
    const agent = harness.addAgent('a')
    await harness.activation.reapplyAll()
    assert.deepEqual(agent.restrictions[0].deny, ['mcp__kv__read'])

    // File repaired, but the host is between generations: keep the fallback.
    await store.write(validState())
    schemasRef.current = []
    await harness.activation.reapplyAll()
    assert.equal(agent.restrictions[0].disposed, false)
    assert.equal(agent.restrictions[0].deny.includes('mcp__kv__read'), true)

    // File breaks again and a new MCP tool appears. The retained fallback must
    // still be classified conservative so the new tool is denied too.
    await writeFile(file, '{"version":4,"mcp":', 'utf8')
    schemasRef.current = [{ name: 'mcp__kv__read' }, { name: 'mcp__new__write' }]
    await harness.activation.reapplyAll()
    assert.equal(agent.restrictions[0].disposed, true)
    assert.deepEqual(agent.restrictions.at(-1).deny, ['mcp__kv__read', 'mcp__new__write'])
  } finally {
    harness.activation.disposeAll()
    await rm(dir, { recursive: true, force: true })
  }
})
