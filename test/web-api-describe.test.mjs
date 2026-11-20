import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { StateStore } from '../src/store.js'
import { ROUTE_PREFIX, buildDescribePrompt, registerWebApi } from '../src/web-api.js'

/** Connection values stored in the fixture that no generation request may carry. */
const SECRET_URL = 'http://mcp.internal.example/alpha'
const SECRET_HEADER = 'Bearer describe-secret'
const SECRET_ENV = 'describe-secret-env'

/**
 * One v4 document with two MCP members.
 *
 * `alpha` carries a connection definition holding a URL, an `Authorization`
 * header and an environment token; `beta` exists only so a tool name can be
 * attributed to the wrong service. Neither definition may ever reach the model.
 */
function fixtureState() {
  return {
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
        description: '已有的描述',
        disclosure: 'progressive',
        tools: {},
        definition: {
          transport: 'streamable-http',
          url: SECRET_URL,
          headers: { Authorization: SECRET_HEADER },
          env: { API_TOKEN: SECRET_ENV },
        },
        installedAt: '2026-11-01T00:00:00.000Z',
      },
      beta: {
        enabled: true,
        modes: [],
        workspaces: [],
        description: '',
        disclosure: 'full',
        tools: {},
        installedAt: '2026-11-01T00:00:00.000Z',
      },
    },
  }
}

/** Tool schemas the fake global tool registry reports. */
function fixtureSchemas() {
  return [
    { name: 'mcp__alpha__search', description: 'search docs' },
    { name: 'mcp__alpha__read', description: 'read one doc' },
    // Two possible server separators: never attributable, so never offered to
    // the model as one of this service's tools.
    { name: 'mcp__alpha__x__y', description: 'ambiguous name' },
    { name: 'mcp__beta__x', description: 'other service' },
    { name: 'resource_pool_status', description: 'not an MCP tool' },
  ]
}

/** Record one `text-delta` stream of the given text. */
function textStream(text) {
  return {
    stream: async function* () {
      yield { type: 'text-delta', text }
    },
  }
}

/**
 * Emit chunks the way the real `LlmRuntime.stream()` does: text deltas followed
 * by a terminal `finish` chunk. The runtime never throws on adapter failures; it
 * normalizes them into `error`/`aborted` finish reasons.
 */
function chunkStream(chunks) {
  return {
    stream: async function* () {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** Terminal chunk of a complete, non-truncated completion. */
const stopFinish = { type: 'finish', reason: { kind: 'stop' } }

/**
 * Build the real route handlers over a temporary Store plus a fake context.
 *
 * `registerWebApi` returns its internal `routes` array so a Node test can call
 * one handler directly, without a web server or a connection service. Host
 * services are optional: an omitted `llm`/`selection` models a deployment that
 * does not provide them.
 */
async function withApi(options, run) {
  const { llm, selection, describeTimeoutMs } = options
  const schemas = options.schemas ?? fixtureSchemas
  const dir = await mkdtemp(join(tmpdir(), 'skill-pool-web-api-describe-'))
  try {
    const file = join(dir, 'state.json')
    const store = new StateStore({ file })
    await store.write(fixtureState())
    const services = {
      ...(options.tools === false ? {} : { tools: { schemas: () => schemas() } }),
      ...(selection === undefined ? {} : { agentDefaultModel: { currentSelection: () => selection } }),
      ...(llm === undefined ? {} : { llm }),
      ...(options.mcpManager === undefined ? {} : { mcpManager: options.mcpManager }),
    }
    const ctx = {
      get: (name) => services[name],
      inject: (_names, callback) =>
        callback({ get: (name) => services[name], effect: (register) => register() }),
      effect: (register) => register(),
    }
    const registry = registerWebApi({
      ctx,
      store,
      meta: { file, version: 'test' },
      onChanged: async () => {},
      logger: {},
      ...(describeTimeoutMs === undefined ? {} : { describeTimeoutMs }),
    })
    assert.ok(Array.isArray(registry.routes), 'registerWebApi returns its routes array')

    const invoke = async (method, target, body, extra = {}) => {
      const pathname = target.split('?')[0]
      const route = registry.routes.find(([suffix, methods]) => suffix === pathname && methods.includes(method))
      assert.equal(typeof route?.[2], 'function', `route ${method} ${pathname} is registered`)
      const request = {
        url: `http://x${ROUTE_PREFIX}${target}`,
        ...(body === undefined ? {} : { json: async () => body }),
        ...extra,
      }
      const response = await route[2](request)
      return { status: response.status, payload: await response.json() }
    }
    const describe = (body = { server: 'alpha' }, extra) => invoke('POST', '/mcp/describe', body, extra)

    return await run({ invoke, describe, store, file })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Run one `POST /mcp/describe` and return the JSON payload alone.
 *
 * This is the brief's `describeHarness`: it fakes `ctx.get('llm')` and
 * `ctx.get('agentDefaultModel')` and asserts on the route's response body.
 */
async function describeHarness(options = {}) {
  return withApi(options, (api) => api.describe(options.body).then((result) => result.payload))
}

test('buildDescribePrompt includes tool names, not connection data', () => {
  const prompt = buildDescribePrompt({
    server: 'alpha',
    language: 'zh',
    tools: [{ name: 'mcp__alpha__search', description: 'search docs' }],
  })
  assert.ok(prompt.user.includes('mcp__alpha__search'))
  assert.ok(prompt.user.includes('search docs'))
  assert.equal(prompt.user.includes('http'), false)
  assert.ok(prompt.system.includes('1–2'))
})

test('buildDescribePrompt switches language and stays inside the 8 KB budget', () => {
  const tools = Array.from({ length: 200 }, (_, index) => ({
    name: `mcp__alpha__tool_${index}`,
    description: 'x'.repeat(200),
  }))
  const zh = buildDescribePrompt({ server: 'alpha', language: 'zh', tools })
  const en = buildDescribePrompt({ server: 'alpha', language: 'en', tools })
  const fallback = buildDescribePrompt({ server: 'alpha', language: 'fr', tools })

  for (const prompt of [zh, en]) {
    assert.ok(prompt.user.length <= 8 * 1024, 'the tool list stays inside the 8 KB budget')
    assert.ok(prompt.system.includes('1–2'))
    assert.ok(prompt.user.includes('mcp__alpha__tool_0'))
  }
  assert.notEqual(zh.system, en.system)
  assert.equal(fallback.system, zh.system, 'an unknown language falls back to Chinese')
})

test('buildDescribePrompt skips one oversized tool without dropping later tools', () => {
  const prompt = buildDescribePrompt({
    server: 'alpha',
    language: 'zh',
    tools: [
      // The name alone already exceeds the whole budget, so this line can never
      // fit; the tools after it must still reach the prompt.
      { name: `mcp__alpha__${'x'.repeat(9000)}`, description: 'oversized entry' },
      { name: 'mcp__alpha__search', description: 'search docs' },
    ],
  })
  assert.ok(prompt.user.length <= 8 * 1024)
  assert.equal(prompt.user.includes('oversized entry'), false)
  assert.ok(prompt.user.includes('mcp__alpha__search: search docs'))
})

test('describe refuses without a default model', async () => {
  const payload = await describeHarness({ llm: undefined, selection: undefined })
  assert.equal(payload.ok, false)
  assert.equal(payload.error, 'no-default-model')
})

test('describe refuses without the llm service', async () => {
  const payload = await describeHarness({ llm: undefined, selection: { provider: 'p', model: 'm' } })
  assert.equal(payload.ok, false)
  assert.equal(payload.error, 'no-llm')
})

test('describe refuses a service without registered tools', async () => {
  let called = false
  const llm = {
    stream: async function* () {
      called = true
      yield { type: 'text-delta', text: 'never' }
    },
  }
  const empty = await describeHarness({
    llm,
    selection: { provider: 'p', model: 'm' },
    schemas: () => [{ name: 'mcp__beta__x', description: 'other service' }],
  })
  assert.equal(empty.ok, false)
  assert.equal(empty.error, 'no-tools')
  assert.equal(called, false, 'no model call happens without a tool list')
})

test('describe refuses when the tool registry is unavailable', async () => {
  const payload = await describeHarness({
    llm: textStream('用'),
    selection: { provider: 'p', model: 'm' },
    tools: false,
  })
  assert.equal(payload.ok, false)
  assert.equal(payload.error, 'tools-unavailable')
})

test('describe returns generated text and never saves it', async () => {
  const payload = await describeHarness({
    llm: {
      stream: async function* () {
        yield { type: 'text-delta', text: '用于检索知识库。' }
      },
    },
    selection: { provider: 'p', model: 'm' },
  })
  assert.equal(payload.ok, true)
  assert.equal(payload.description, '用于检索知识库。')
})

test('describe asks the default model with the tool list only', async () => {
  const calls = []
  const llm = {
    stream: (options) => {
      calls.push(options)
      return (async function* () {
        yield { type: 'text-delta', text: '用于检索知识库。' }
        yield stopFinish
      })()
    },
  }
  await withApi(
    { llm, selection: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'low' } },
    async (api) => {
      const before = await api.store.read({ fresh: true })
      const { status, payload } = await api.describe({ server: 'alpha', language: 'zh' })
      assert.equal(status, 200)
      assert.equal(payload.ok, true)

      // The generated text is a draft for the panel; the state file keeps the
      // value the user already saved (never auto-saved by the route).
      const after = await api.store.read({ fresh: true })
      assert.equal(after.mcp.alpha.description, before.mcp.alpha.description)
      assert.equal(after.mcp.alpha.description, '已有的描述')

      assert.equal(calls.length, 1)
      const options = calls[0]
      assert.equal(options.provider, 'deepseek')
      assert.equal(options.model, 'deepseek-chat')
      assert.equal(options.reasoningEffort, 'low')
      assert.equal(options.maxTokens, 200)
      assert.ok(options.signal instanceof AbortSignal, 'the stream receives an abort signal')
      assert.ok(typeof options.system === 'string' && options.system.length > 0)
      assert.ok(Array.isArray(options.messages) && options.messages.length === 1)
      assert.equal(options.messages[0].role, 'user')
      // The installed host takes request content as model-facing text blocks.
      assert.ok(Array.isArray(options.messages[0].content))
      assert.equal(options.messages[0].content[0].type, 'text')
      assert.ok(options.messages[0].content[0].text.includes('mcp__alpha__search'))

      const sent = JSON.stringify({ system: options.system, messages: options.messages })
      assert.ok(sent.includes('search docs'), 'tool descriptions reach the model')
      assert.equal(sent.includes('http'), false, 'no connection URL reaches the model')
      assert.equal(sent.includes('Bearer'), false)
      assert.equal(sent.includes(SECRET_HEADER), false)
      assert.equal(sent.includes(SECRET_ENV), false)
      // Ambiguous and foreign tool names are not this service's tools.
      assert.equal(sent.includes('mcp__alpha__x__y'), false)
      assert.equal(sent.includes('mcp__beta__x'), false)
      assert.equal(sent.includes('resource_pool_status'), false)
    },
  )
})

test('describe omits reasoningEffort when the default selection has none', async () => {
  const calls = []
  const llm = {
    stream: (options) => {
      calls.push(options)
      return (async function* () {
        yield { type: 'text-delta', text: '用于检索知识库。' }
        yield stopFinish
      })()
    },
  }
  const payload = await describeHarness({ llm, selection: { provider: 'p', model: 'm' } })
  assert.equal(payload.ok, true)
  assert.equal('reasoningEffort' in calls[0], false)
})

test('describe aborts the model stream when generation times out', async () => {
  let aborted = false
  let signal
  let closed = false
  const llm = {
    stream: (options) => {
      signal = options.signal
      return {
        async *[Symbol.asyncIterator]() {
          try {
            yield { type: 'text-delta', text: '半' }
            await new Promise((resolve) => {
              if (options.signal.aborted) resolve()
              else options.signal.addEventListener('abort', resolve, { once: true })
            })
            aborted = true
            // The runtime's normalized terminal chunk for an aborted request.
            yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } }
          } finally {
            closed = true
          }
        },
      }
    },
  }
  const payload = await describeHarness({
    llm,
    selection: { provider: 'p', model: 'm' },
    describeTimeoutMs: 100,
  })
  assert.equal(payload.ok, false)
  assert.equal(payload.error, 'timeout')
  assert.equal(aborted, true, 'the route aborted the request instead of leaving it hanging')
  assert.equal(signal.aborted, true)
  assert.equal(closed, true, 'the route closed the abandoned stream')
})

test('describe cancels generation when the panel request is aborted', async () => {
  const controller = new AbortController()
  let entered = false
  let closed = false
  let signal
  const llm = {
    stream: (options) => {
      signal = options.signal
      return {
        async *[Symbol.asyncIterator]() {
          try {
            yield { type: 'text-delta', text: '半' }
            entered = true
            await new Promise((resolve) => {
              if (options.signal.aborted) resolve()
              else options.signal.addEventListener('abort', resolve, { once: true })
            })
            yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } }
          } finally {
            closed = true
          }
        },
      }
    },
  }
  const result = await withApi({ llm, selection: { provider: 'p', model: 'm' } }, async (api) => {
    const pending = api.describe({ server: 'alpha' }, { signal: controller.signal })
    for (let tick = 0; tick < 100 && !entered; tick += 1) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(entered, true, 'the request reached the model before the client aborted')
    controller.abort()
    return pending
  })
  // The client abort is not our deadline, so it is a failed generation, not a timeout.
  assert.equal(result.payload.ok, false)
  assert.equal(result.payload.error, 'generate-failed')
  assert.equal(result.payload.description, undefined)
  assert.equal(signal.aborted, true)
  for (let tick = 0; tick < 100 && !closed; tick += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(closed, true, 'a closed panel request closes the stream iterator')
})

test('describe discards the text of an error finish', async () => {
  const payload = await describeHarness({
    llm: chunkStream([
      { type: 'text-delta', index: 0, text: '半成品的描述' },
      { type: 'finish', reason: { kind: 'error', failure: { code: 'PROVIDER_ERROR', message: 'sk-secret' } } },
    ]),
    selection: { provider: 'p', model: 'm' },
  })
  assert.equal(payload.ok, false)
  assert.equal(payload.error, 'generate-failed')
  assert.equal('description' in payload, false, 'a failed generation returns no draft')
  assert.equal(JSON.stringify(payload).includes('sk-secret'), false)
})

test('describe refuses a truncated max-tokens completion', async () => {
  const payload = await describeHarness({
    llm: chunkStream([
      { type: 'text-delta', index: 0, text: '用于检索' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]),
    selection: { provider: 'p', model: 'm' },
  })
  assert.equal(payload.ok, false)
  assert.equal(payload.error, 'generate-failed')
  assert.equal('description' in payload, false)
})

test('describe answers timeout for an aborted finish once the deadline fired', async () => {
  let signal
  const llm = {
    stream: (options) => {
      signal = options.signal
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', index: 0, text: '半' }
          await new Promise((resolve) => {
            if (options.signal.aborted) resolve()
            else options.signal.addEventListener('abort', resolve, { once: true })
          })
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } }
        },
      }
    },
  }
  const payload = await describeHarness({
    llm,
    selection: { provider: 'p', model: 'm' },
    describeTimeoutMs: 100,
  })
  assert.equal(payload.ok, false)
  assert.equal(payload.error, 'timeout')
  assert.equal(signal.aborted, true)
})

test('describe refuses an offline server before reading the tool list', async () => {
  let listed = false
  const payload = await describeHarness({
    llm: textStream('用'),
    selection: { provider: 'p', model: 'm' },
    mcpManager: { list: () => [{ name: 'alpha', status: { state: 'disconnected' } }] },
    schemas: () => {
      listed = true
      return fixtureSchemas()
    },
  })
  assert.equal(payload.ok, false)
  assert.equal(payload.error, 'offline')
  assert.equal(listed, false, 'a dead connection never has its stale catalog read')
})

test('describe keeps the registry path without a usable manager entry', async () => {
  const selection = { provider: 'p', model: 'm' }
  const cases = {
    // No mcpManager service at all.
    absent: {},
    // A manager that reports other services but not this one.
    noEntry: { mcpManager: { list: () => [{ name: 'beta', status: { state: 'connected' } }] } },
    // A manager whose list cannot be read degrades to the registry.
    unreadable: {
      mcpManager: {
        list: () => {
          throw new Error('manager exploded')
        },
      },
    },
  }
  for (const [label, options] of Object.entries(cases)) {
    const payload = await describeHarness({
      llm: chunkStream([{ type: 'text-delta', index: 0, text: '用于检索知识库。' }, stopFinish]),
      selection,
      ...options,
    })
    assert.equal(payload.ok, true, `${label}: generation still works`)
    assert.equal(payload.description, '用于检索知识库。')
  }
})

test('describe reports a middleware throw without a partial description', async () => {
  const payload = await describeHarness({
    llm: {
      stream: async function* () {
        yield { type: 'text-delta', text: '半成品' }
        throw new Error('provider exploded: sk-secret')
      },
    },
    selection: { provider: 'p', model: 'm' },
  })
  assert.equal(payload.ok, false)
  assert.equal(payload.error, 'generate-failed')
  assert.equal(payload.description, undefined)
  assert.equal(JSON.stringify(payload).includes('sk-secret'), false)
})

test('describe reports an empty generation as a failure', async () => {
  const payload = await describeHarness({
    llm: chunkStream([stopFinish]),
    selection: { provider: 'p', model: 'm' },
  })
  assert.equal(payload.ok, false)
  assert.equal(payload.error, 'generate-failed')
})

test('describe validates the server name', async () => {
  await withApi({ llm: textStream('用'), selection: { provider: 'p', model: 'm' } }, async (api) => {
    const missing = await api.describe({})
    assert.equal(missing.status, 400)
    assert.equal(missing.payload.ok, false)
    assert.equal(missing.payload.error, 'bad-server')

    const unknown = await api.describe({ server: 'ghost' })
    assert.equal(unknown.status, 404)
    assert.equal(unknown.payload.ok, false)
    assert.equal(unknown.payload.error, 'unknown-server')
  })
})

test('describe fails closed when the state cannot be read', async () => {
  await withApi({ llm: textStream('用'), selection: { provider: 'p', model: 'm' } }, async (api) => {
    await writeFile(api.file, '{ not json', 'utf8')
    const { status, payload } = await api.describe({ server: 'alpha' })
    assert.equal(status, 500)
    assert.equal(payload.ok, false)
    assert.equal(payload.error, 'resource-pool/state-invalid-json')
    assert.equal(payload.description, undefined)
  })
})
