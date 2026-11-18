/**
 * Fail-closed state reads and per-Agent activation.
 *
 * A corrupt, unreadable, unsupported or semantically invalid state document must
 * never be normalized into a broader pool. Nothing here touches live state: every
 * store lives in its own temporary directory.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createActivation } from '../src/activation.js'
import { registerWebApi, ROUTE_PREFIX } from '../src/web-api.js'
import { StateStore, defaultState, normalizeState, upsertItem } from '../src/store.js'

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
async function makeApi(initial = validState()) {
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
  registerWebApi({ ctx, store, meta: { file, version: 'test' }, onChanged: async () => {}, logger: {} })

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
