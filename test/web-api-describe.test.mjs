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

    const invoke = async (method, target, body) => {
      const pathname = target.split('?')[0]
      const route = registry.routes.find(([suffix, methods]) => suffix === pathname && methods.includes(method))
      assert.equal(typeof route?.[2], 'function', `route ${method} ${pathname} is registered`)
      const request = {
        url: `http://x${ROUTE_PREFIX}${target}`,
        ...(body === undefined ? {} : { json: async () => body }),
      }
      const response = await route[2](request)
      return { status: response.status, payload: await response.json() }
    }
    const describe = (body = { server: 'alpha' }) => invoke('POST', '/mcp/describe', body)

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
  const llm = {
    stream: (options) => {
      signal = options.signal
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: '半' }
          await new Promise((_resolve, reject) => {
            const onAbort = () => {
              aborted = true
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            }
            // Tolerate an abort that landed before this listener was attached;
            // event listeners on an already-aborted signal never fire.
            if (options.signal.aborted) onAbort()
            else options.signal.addEventListener('abort', onAbort, { once: true })
          })
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
})

test('describe reports a failed generation without a partial description', async () => {
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
    llm: { stream: async function* () {} },
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
