/**
 * Task 3 feasibility probes for MCP tool identity, scoping, atomic shutdown and
 * disclosure channels.
 *
 * These tests drive the *installed* DeepSeek Harness packages (Cordis, tools,
 * system-prompt, native executor, MCP client/manager/resources) against two
 * controlled MCP child processes created in a temporary directory. Everything
 * is isolated: no live profile is loaded, no user configuration is written, no
 * OpenViking service is contacted, and the test servers only exist for the
 * lifetime of one test.
 *
 * The checks deliberately separate three outcomes:
 *   - PROVEN: the assertion describes a capability the live pipeline provides.
 *   - OBSERVED FAIL: the assertion describes current behaviour that violates a
 *     Task 3 requirement. Such a test passes by pinning the observed failure;
 *     it does not skip the truth or turn the failure into a success claim.
 *   - UNVERIFIED: the package/DSH path was not exercised (reported in
 *     docs/mcp-feasibility-results.md), never a silent skip inside a check.
 *
 * If the installed runtime/version is absent, every test is explicitly skipped
 * with an "unverified" reason so the default npm test stays portable. Set
 * DSH_FEASIBILITY_REQUIRED=1 (npm run verify:feasibility) to turn that absence
 * into a nonzero failure.
 *
 * Run with: node --test test/mcp-feasibility.test.mjs
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

/** Published naming contract of dsh-mcp-client; re-implemented here so the test
 * compares observed registrations with an independent reference, not the
 * client's own private helper (which is not exported). */
const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12

const RESOURCE_TOOL_NAMES = new Set([
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
])

const DSH_ROOT = process.env.DSH_FEASIBILITY_ROOT
  ?? '/opt/dsh/lib/node_modules/@deepseek-ai/dsh'
/** Required mode makes an absent host runtime fail the command instead of skipping. */
const REQUIRE_FEASIBILITY = process.env.DSH_FEASIBILITY_REQUIRED === '1'

const ALPHA_TOOLS = [
  'search',
  'a__x',
  'a.b',
  'a/b',
  '工具 名',
  `${'L'.repeat(70)}A`,
  `${'L'.repeat(70)}B`,
  'feasibility_echo',
  'feasibility_change_tools',
  'feasibility_duplicate_tools',
  'feasibility_crash',
]

const BETA_TOOLS = [
  'search',
  'beta.only',
  'feasibility_echo',
  'feasibility_crash',
]

/**
 * A minimal MCP server over stdio (newline-delimited JSON-RPC 2.0).
 *
 * The modern `server/discover` probe is answered with an ordinary JSON-RPC
 * error, which the installed SDK classifies as legacy and falls back to the
 * standard `initialize` handshake. This keeps the fixture independent of the
 * 2026-07-28 wire revision while exercising the same installed client.
 */
const TEST_SERVER_SOURCE = String.raw`
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const NAME = process.env.MCP_TEST_NAME || 'alpha'
const STATE_DIR = process.env.MCP_TEST_STATE_DIR || ''
const DEFAULT_TOOLS = NAME === 'alpha'
  ? ['search', 'a__x', 'a.b', 'a/b', '工具 名', 'L'.repeat(70) + 'A', 'L'.repeat(70) + 'B', 'feasibility_echo', 'feasibility_change_tools', 'feasibility_duplicate_tools', 'feasibility_crash']
  : ['search', 'beta.only', 'feasibility_echo', 'feasibility_crash']
const INITIAL_TOOLS = process.env.MCP_TEST_TOOLS_JSON
  ? JSON.parse(process.env.MCP_TEST_TOOLS_JSON)
  : DEFAULT_TOOLS
const INSTRUCTIONS = process.env.MCP_TEST_INSTRUCTIONS || (NAME.toUpperCase() + '_INSTRUCTIONS_MARKER')
const RESOURCE_URI = process.env.MCP_TEST_RESOURCE_URI || (NAME + '://secret')
const RESOURCES = [{ uri: RESOURCE_URI, name: NAME + '-secret', mimeType: 'text/plain' }]
let tools = [...INITIAL_TOOLS]

function event(kind, detail) {
  if (!STATE_DIR) return
  try {
    appendFileSync(join(STATE_DIR, 'events.log'), kind + (detail === undefined ? '' : ' ' + detail) + '\n')
  } catch {}
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id: id, result: result })
}

function rpcError(id, code, message) {
  send({ jsonrpc: '2.0', id: id, error: { code: code, message: message } })
}

function toolDefinitions() {
  return tools.map(function (name) {
    return {
      name: name,
      description: NAME + ' tool ' + name,
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: true },
    }
  })
}

function textResult(text) {
  return { content: [{ type: 'text', text: text }] }
}

const reader = createInterface({ input: process.stdin })

reader.on('line', function (line) {
  if (!line.trim()) return
  let message
  try { message = JSON.parse(line) } catch { return }

  if (message.method === 'server/discover') {
    rpcError(message.id, -32601, 'method not found')
    return
  }

  if (message.method === 'initialize') {
    reply(message.id, {
      protocolVersion: message.params && message.params.protocolVersion ? message.params.protocolVersion : '2025-11-25',
      capabilities: { tools: { listChanged: true }, resources: { subscribe: false, listChanged: false } },
      serverInfo: { name: NAME + '-test-server', version: '1.0.0' },
      instructions: INSTRUCTIONS,
    })
    return
  }

  if (typeof message.method === 'string' && message.method.indexOf('notifications/') === 0) return
  if (message.method === 'ping') { reply(message.id, {}); return }
  if (message.method === 'tools/list') { reply(message.id, { tools: toolDefinitions() }); return }

  if (message.method === 'tools/call') {
    const raw = message.params && message.params.name
    const args = (message.params && message.params.arguments) || {}
    event('call', raw)
    if (raw === 'feasibility_crash') {
      reply(message.id, textResult('crash scheduled'))
      event('crash-scheduled')
      setTimeout(function () { process.exit(42) }, 150)
      return
    }
    if (raw === 'feasibility_change_tools') {
      reply(message.id, textResult('changed'))
      tools = INITIAL_TOOLS.filter(function (name) { return name !== 'search' }).concat(['new.tool'])
      event('changed')
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
      return
    }
    if (raw === 'feasibility_duplicate_tools') {
      reply(message.id, textResult('duplicate scheduled'))
      tools = INITIAL_TOOLS.concat(['dup.raw', 'dup.raw'])
      event('duplicate-notified')
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
      return
    }
    if (raw === 'feasibility_echo') {
      reply(message.id, textResult(NAME + ' raw=' + raw + ' args=' + JSON.stringify(args)))
      return
    }
    if (!tools.includes(raw)) {
      rpcError(message.id, -32602, 'unknown tool: ' + raw)
      return
    }
    reply(message.id, textResult(NAME + ' raw=' + raw + ' args=' + JSON.stringify(args)))
    return
  }

  if (message.method === 'resources/list') { reply(message.id, { resources: RESOURCES }); return }
  if (message.method === 'resources/templates/list') { reply(message.id, { resourceTemplates: [] }); return }
  if (message.method === 'resources/read') {
    const uri = message.params && message.params.uri
    if (uri !== RESOURCE_URI) { rpcError(message.id, -32602, 'unknown resource: ' + uri); return }
    reply(message.id, { contents: [{ uri: uri, mimeType: 'text/plain', text: NAME.toUpperCase() + '_RESOURCE_PAYLOAD' }] })
    return
  }

  rpcError(message.id, -32601, 'method not found: ' + message.method)
})

reader.on('close', function () { process.exit(0) })
`

// ---------------------------------------------------------------------------
// Installed DSH loading
// ---------------------------------------------------------------------------

let dsh
let dshError

async function loadDsh() {
  if (!existsSync(join(DSH_ROOT, 'package.json'))) {
    throw new Error(`installed DSH package not found at ${DSH_ROOT}`)
  }
  const pkg = JSON.parse(await readFile(join(DSH_ROOT, 'package.json'), 'utf8'))
  if (pkg.version !== '0.2.2-rc.3') {
    throw new Error(`expected installed DSH 0.2.2-rc.3, found ${String(pkg.version)} at ${DSH_ROOT}`)
  }
  const load = id => import(pathToFileURL(join(DSH_ROOT, 'node_modules', id)).href)
  const [cordis, scope, systemPrompt, tools, pipeline, native, resources, client, manager] = await Promise.all([
    load('@deepseek-ai/cordis/lib/index.js'),
    load('@deepseek-ai/dsh-scope/lib/index.js'),
    load('@deepseek-ai/dsh-system-prompt/lib/index.js'),
    load('@deepseek-ai/dsh-tools/lib/index.js'),
    load('@deepseek-ai/dsh-tools/lib/pipeline.js'),
    load('@deepseek-ai/dsh-tool-executor-native/lib/index.js'),
    load('@deepseek-ai/dsh-mcp-resources/lib/index.js'),
    load('@deepseek-ai/dsh-mcp-client/lib/index.js'),
    load('@deepseek-ai/dsh-mcp-manager/lib/index.js'),
  ])
  return {
    version: pkg.version,
    Context: cordis.Context,
    createScope: scope.createScope,
    SystemPrompt: systemPrompt.default,
    renderPrompt: systemPrompt.renderPrompt,
    ToolsService: tools.default,
    ToolExecutionPipeline: pipeline.ToolExecutionPipeline,
    NativeExecutor: native,
    McpResources: resources.default,
    McpClient: client,
    McpManager: manager.default,
  }
}

try {
  dsh = await loadDsh()
} catch (error) {
  dshError = error
}

/** Register a test but report an absent/unusable installed runtime honestly. */
function feasibilityTest(name, fn) {
  test(name, async t => {
    if (dshError !== undefined) {
      if (REQUIRE_FEASIBILITY) {
        assert.fail(`feasibility runtime unavailable (required mode): ${dshError.message}`)
      }
      t.skip(`unverified — ${dshError.message}`)
      return
    }
    await fn(t)
  })
}

// ---------------------------------------------------------------------------
// Reference mapping and harness
// ---------------------------------------------------------------------------

/** Independent implementation of the published MCP public-name contract. */
function expectedPublicName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(check, label, timeoutMs = 10_000, intervalMs = 25) {
  const started = Date.now()
  for (;;) {
    if (check()) return
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await delay(intervalMs)
  }
}

let callCounter = 0

/** Minimal tool definition used for scoping/guard probes. */
function fakeDefinition(name, execute, description = name) {
  return {
    name,
    description,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: () => [{ type: 'text', text: description }],
    },
    execute,
  }
}

function textOf(result) {
  return result.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Canonical denial a tools/execute waterfall listener can return without next(). */
function dispatchDenial(reason) {
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${reason}` }],
    error: { message: reason },
  }
}

function mcpPublicNames(root) {
  return root.tools.definitions()
    .map(definition => definition.name)
    .filter(name => name.startsWith('mcp__'))
    .sort()
}

function normalizeSpec(spec) {
  return {
    serverName: spec.serverName,
    rawTools: spec.rawTools,
    instructions: spec.instructions ?? `${spec.serverName.toUpperCase()}_INSTRUCTIONS_MARKER`,
    resourceUri: spec.resourceUri ?? `${spec.serverName}://secret`,
    failOnStartupError: spec.failOnStartupError ?? false,
    reconnect: spec.reconnect ?? { enabled: false },
  }
}

function clientConfig(harness, spec) {
  return {
    transport: 'stdio',
    serverName: spec.serverName,
    command: process.execPath,
    args: [harness.serverFile],
    env: {
      MCP_TEST_NAME: spec.serverName,
      MCP_TEST_STATE_DIR: harness.dir,
      MCP_TEST_TOOLS_JSON: JSON.stringify(spec.rawTools),
      MCP_TEST_INSTRUCTIONS: spec.instructions,
      MCP_TEST_RESOURCE_URI: spec.resourceUri,
    },
    cwd: '',
    toolCallTimeoutMs: 5_000,
    startupTimeoutMs: 15_000,
    closeTimeoutMs: 1_000,
    expandTemplates: false,
    failOnStartupError: spec.failOnStartupError,
    reconnect: spec.reconnect,
  }
}

function managerEntry(harness, spec) {
  return {
    transport: 'stdio',
    command: process.execPath,
    args: [harness.serverFile],
    env: {
      MCP_TEST_NAME: spec.serverName,
      MCP_TEST_STATE_DIR: harness.dir,
      MCP_TEST_TOOLS_JSON: JSON.stringify(spec.rawTools),
      MCP_TEST_INSTRUCTIONS: spec.instructions,
      MCP_TEST_RESOURCE_URI: spec.resourceUri,
    },
    cwd: '',
    enabled: true,
    toolCallTimeoutMs: 5_000,
    startupTimeoutMs: 15_000,
    closeTimeoutMs: 1_000,
    reconnect: spec.reconnect,
  }
}

/**
 * Build an isolated Cordis host with the real tools, system-prompt, native
 * executor and resource services. Servers are either mounted as direct
 * mcp-client rows or through the real mcp-manager.
 */
async function createHarness(t, options = {}) {
  if (dshError !== undefined) throw dshError
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-feasibility-'))
  const serverFile = join(dir, 'test-mcp-server.mjs')
  await writeFile(serverFile, TEST_SERVER_SOURCE, { mode: 0o600 })

  const root = new dsh.Context()
  await root.plugin(dsh.SystemPrompt)
  await root.plugin(dsh.ToolsService)
  await root.plugin(dsh.NativeExecutor)
  await root.plugin(dsh.McpResources)

  const harness = {
    root,
    dir,
    serverFile,
    clients: new Map(),
    disposed: false,
    async mount(spec) {
      const normalized = normalizeSpec(spec)
      const fiber = await root.plugin(dsh.McpClient, clientConfig(harness, normalized))
      const statusHandle = dsh.McpClient.connectionStatusOf(fiber)
      assert.ok(statusHandle, `mcp-client(${normalized.serverName}) exposes a status handle`)
      harness.clients.set(normalized.serverName, { spec: normalized, fiber, statusHandle })
      return normalized
    },
    async unmount(serverName) {
      const record = harness.clients.get(serverName)
      if (record === undefined) return
      harness.clients.delete(serverName)
      await record.fiber.dispose()
      await waitFor(
        () => mcpPublicNames(root).every(name => !name.startsWith(`mcp__${serverName}__`)),
        `tools of ${serverName} to unregister`,
      )
    },
    status(serverName) {
      return harness.clients.get(serverName)?.statusHandle.current()
    },
    async readEvents() {
      try {
        return (await readFile(join(dir, 'events.log'), 'utf8')).split('\n').filter(Boolean)
      } catch {
        return []
      }
    },
    async dispose() {
      if (harness.disposed) return
      harness.disposed = true
      try {
        await root.fiber.dispose()
      } catch {
        // A rejected initial connection may leave a failed fiber; disposal is
        // best-effort and must not hide the test's own assertion.
      }
      await delay(25)
      await rm(dir, { recursive: true, force: true })
    },
  }

  t.after(() => harness.dispose())

  if (options.manager === true) {
    const servers = {}
    for (const spec of options.servers ?? []) {
      const normalized = normalizeSpec(spec)
      servers[normalized.serverName] = managerEntry(harness, normalized)
    }
    await root.plugin(dsh.McpManager, { servers })
    harness.manager = true
  } else {
    for (const spec of options.servers ?? []) await harness.mount(spec)
  }

  return harness
}

async function createAgentScopes(t, root, { withPreset = false } = {}) {
  const scopes = { a: {}, b: {}, preset: {} }
  await root.plugin({
    name: 'feasibility-scope-host',
    inject: ['tools'],
    apply(ctx) {
      scopes.hostCtx = ctx
      if (withPreset) {
        scopes.presetScope = dsh.createScope(ctx, scopes.preset)
        scopes.scopeA = dsh.createScope(ctx, scopes.a, { parent: scopes.preset })
        scopes.scopeB = dsh.createScope(ctx, scopes.b, { parent: scopes.preset })
      } else {
        scopes.scopeA = dsh.createScope(ctx, scopes.a)
        scopes.scopeB = dsh.createScope(ctx, scopes.b)
      }
    },
  })
  return scopes
}

function modelSelection() {
  return { provider: 'feasibility-fixture', model: 'fixture-model' }
}

function resolveFor(root, agent) {
  return root.tools.resolve({
    agent,
    modelSelection: modelSelection(),
    signal: new AbortController().signal,
  })
}

async function callTool(root, name, args = {}, options = {}) {
  const batch = await root.tools.execute({
    signal: options.signal ?? new AbortController().signal,
    ...options.agent === undefined ? {} : { agent: options.agent },
    ...options.toolSet === undefined ? {} : { toolSet: options.toolSet },
    calls: [{
      type: 'tool-call',
      id: `feasibility-call-${++callCounter}`,
      name,
      arguments: JSON.stringify(args),
    }],
  })
  return batch.results[0].result
}

function expectedNames(specs) {
  return specs.flatMap(spec => spec.rawTools.map(raw => expectedPublicName(spec.serverName, raw))).sort()
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

feasibilityTest('environment: the installed DSH tools/scoping/execution packages are the tested version', async () => {
  assert.equal(dsh.version, '0.2.2-rc.3')
  assert.equal(typeof dsh.Context, 'function')
  assert.equal(typeof dsh.ToolsService, 'function')
  assert.equal(typeof dsh.ToolExecutionPipeline, 'function')
  assert.equal(typeof dsh.McpClient.apply, 'function')
  assert.equal(typeof dsh.McpClient.connectionStatusOf, 'function')
  assert.equal(typeof dsh.McpManager, 'function')
  // The public client export surface intentionally has no naming helper.
  assert.equal(Object.hasOwn(dsh.McpClient, 'publicToolName'), false)
})

feasibilityTest('identity: live registration yields deterministic public names, but no server/raw origin API', async t => {
  const h = await createHarness(t, {
    servers: [
      { serverName: 'alpha', rawTools: ALPHA_TOOLS },
      { serverName: 'beta', rawTools: BETA_TOOLS },
    ],
  })

  const observed = mcpPublicNames(h.root)
  assert.deepEqual(observed, expectedNames([
    { serverName: 'alpha', rawTools: ALPHA_TOOLS },
    { serverName: 'beta', rawTools: BETA_TOOLS },
  ]), 'observed public names match the published (serverName, rawName) contract')

  // Normal and delimiter-containing raw names stay legible.
  assert.ok(observed.includes('mcp__alpha__search'))
  assert.ok(observed.includes('mcp__alpha__a__x'))
  assert.ok(observed.includes('mcp__beta__search'))
  assert.equal(new Set(observed).size, observed.length, 'the live generation registers each public name once')

  // Lossy normalization always carries a 12-hex identity hash.
  const dot = expectedPublicName('alpha', 'a.b')
  const slash = expectedPublicName('alpha', 'a/b')
  assert.notEqual(dot, slash)
  assert.match(dot, /^mcp__alpha__a_b_[0-9a-f]{12}$/)
  assert.match(slash, /^mcp__alpha__a_b_[0-9a-f]{12}$/)
  assert.equal(dot.slice(0, dot.length - HASH_LENGTH - 1), slash.slice(0, slash.length - HASH_LENGTH - 1))

  const unicode = expectedPublicName('alpha', '工具 名')
  assert.match(unicode, /^mcp__alpha___*_[0-9a-f]{12}$/)

  // Truncation respects the 64-character function-name contract and keeps the hash.
  const longA = expectedPublicName('alpha', `${'L'.repeat(70)}A`)
  const longB = expectedPublicName('alpha', `${'L'.repeat(70)}B`)
  assert.equal(longA.length, MAX_PUBLIC_NAME_LENGTH)
  assert.equal(longB.length, MAX_PUBLIC_NAME_LENGTH)
  assert.notEqual(longA, longB)
  assert.match(longA, /^[A-Za-z0-9_-]+_[0-9a-f]{12}$/)

  // Dispatch always reaches the raw upstream name; the public name is never parsed.
  for (const raw of [
    'search',
    'a__x',
    'a.b',
    'a/b',
    '工具 名',
    `${'L'.repeat(70)}A`,
    `${'L'.repeat(70)}B`,
  ]) {
    const publicName = expectedPublicName('alpha', raw)
    const result = await callTool(h.root, publicName, { probe: raw })
    assert.equal(result.isError, false, `calling ${publicName} succeeds`)
    assert.ok(textOf(result).includes(`raw=${raw}`), `dispatch preserved raw name ${raw}: ${textOf(result)}`)
  }

  // The current-generation status reports counts, not identities.
  const status = h.status('alpha')
  assert.equal(status.state, 'connected')
  assert.equal(status.toolCount, ALPHA_TOOLS.length)
  assert.deepEqual(Object.keys(status).sort(), ['connectedAt', 'state', 'toolCount'])
  assert.equal(Object.hasOwn(status, 'toolNames'), false)
  assert.equal(Object.hasOwn(status, 'tools'), false)

  // A live ToolDefinition exposes no server/raw/source metadata.
  const definition = h.root.tools.get('mcp__alpha__search')
  assert.ok(definition)
  assert.equal(Object.hasOwn(definition, 'serverName'), false)
  assert.equal(Object.hasOwn(definition, 'rawName'), false)
  assert.equal(Object.hasOwn(definition, 'source'), false)
  assert.equal(Object.hasOwn(definition, 'mcp'), false)

  // No supported API maps a public name back to (serverName, rawName).
  assert.equal(Object.hasOwn(dsh.McpClient, 'publicToolName'), false)
})

feasibilityTest('identity: delimiter-bearing server names make the public name ambiguous', async t => {
  const first = await createHarness(t, {
    servers: [{ serverName: 'alpha', rawTools: ['a__x', 'feasibility_echo'] }],
  })
  const firstNames = mcpPublicNames(first.root)
  const ambiguous = expectedPublicName('alpha', 'a__x')
  assert.ok(firstNames.includes(ambiguous))
  await first.dispose()

  // The very same public name is produced by a different (server, raw) pair.
  const second = await createHarness(t, {
    servers: [{ serverName: 'alpha__a', rawTools: ['x', 'feasibility_echo'] }],
  })
  const secondNames = mcpPublicNames(second.root)
  const sameName = expectedPublicName('alpha__a', 'x')
  assert.equal(sameName, ambiguous)
  assert.ok(secondNames.includes(sameName))
  await second.dispose()

  // `mcp__alpha__a__x` can therefore be (alpha, a__x) or (alpha__a, x);
  // no live registry or status field distinguishes them.
  const [parsedServer] = ambiguous.slice('mcp__'.length).split('__')
  assert.equal(parsedServer, 'alpha')
  assert.notEqual(parsedServer, 'alpha__a')
})

feasibilityTest('collision: a foreign registration rolls back the whole generation; a duplicate list keeps the previous one', async t => {
  const h = await createHarness(t, { servers: [] })

  // A foreign global tool squatting on the namespace makes the initial sync fail
  // atomically: no partial alpha tool set is published.
  h.root.tools.register(fakeDefinition('mcp__alpha__search', async () => ({}), 'foreign squatter'))
  await assert.rejects(
    () => h.mount({ serverName: 'alpha', rawTools: ['search', 'feasibility_echo'], failOnStartupError: true }),
    /initial connection or tool synchronization failed/,
  )
  const afterConflict = mcpPublicNames(h.root)
  assert.deepEqual(afterConflict, ['mcp__alpha__search'], 'only the foreign registration remains; no partial generation')
  assert.equal(h.root.tools.get('mcp__alpha__search')?.description, 'foreign squatter')

  const live = await createHarness(t, {
    servers: [{ serverName: 'alpha', rawTools: ALPHA_TOOLS }],
  })
  const before = mcpPublicNames(live.root)
  const duplicate = await callTool(live.root, expectedPublicName('alpha', 'feasibility_duplicate_tools'))
  assert.equal(duplicate.isError, false)
  await waitFor(async () => (await live.readEvents()).some(line => line === 'duplicate-notified'), 'duplicate notification event')
  await delay(300)
  assert.deepEqual(mcpPublicNames(live.root), before, 'a duplicate raw list does not replace the previous generation')
  assert.equal(live.status('alpha').state, 'connected')
  const echo = await callTool(live.root, expectedPublicName('alpha', 'feasibility_echo'))
  assert.equal(echo.isError, false, 'the previous generation still executes after a rejected list')
})

feasibilityTest('dynamic sync: a tool added between steps appears only in the next resolved step', async t => {
  const h = await createHarness(t, { servers: [{ serverName: 'alpha', rawTools: ALPHA_TOOLS }] })
  const scopes = await createAgentScopes(t, h.root)
  const search = expectedPublicName('alpha', 'search')
  const added = expectedPublicName('alpha', 'new.tool')
  const echo = expectedPublicName('alpha', 'feasibility_echo')

  const oldSet = await resolveFor(h.root, scopes.a)
  assert.equal(oldSet.view(scopes.a).has(search), true)
  assert.equal(oldSet.view(scopes.a).has(added), false)

  const result = await callTool(h.root, expectedPublicName('alpha', 'feasibility_change_tools'), {}, {
    agent: scopes.a,
    toolSet: oldSet,
  })
  assert.equal(result.isError, false)
  await waitFor(
    () => h.root.tools.definitions().some(definition => definition.name === added)
      && !h.root.tools.definitions().some(definition => definition.name === search),
    'MCP tool-list resync',
  )

  // A re-sync swaps the complete generation, so every definition in the closed
  // step snapshot is invalidated - including tools whose raw name did not
  // change. The removed tool is unreachable and the new tool was never admitted.
  assert.equal(oldSet.view(scopes.a).has(search), false, 'removed registration vanishes from the step snapshot')
  assert.equal(oldSet.view(scopes.a).has(added), false, 'new registration did not leak into the running step')
  assert.equal(oldSet.view(scopes.a).has(echo), false, 'observed: a full generation swap also invalidates unchanged definitions in the closed step')

  const nextSet = await resolveFor(h.root, scopes.a)
  assert.equal(nextSet.view(scopes.a).has(added), true, 'the next step admits the newly registered tool')
  assert.equal(nextSet.view(scopes.a).has(search), false)
  assert.equal(nextSet.view(scopes.a).has(echo), true, 'the unchanged tool is visible again in the next step')
  // A ResolvedToolSet is bound to its requesting agent; resolve B separately.
  assert.equal(nextSet.view(scopes.b).has(added), false, 'an A-owned set never admits B')
  const nextSetB = await resolveFor(h.root, scopes.b)
  assert.equal(nextSetB.view(scopes.b).has(added), true, "the tool is global, so another agent's next step sees it too")

  const echoResult = await callTool(h.root, echo, {}, { agent: scopes.a, toolSet: oldSet })
  assert.equal(echoResult.isError, true, 'the closed step cannot execute even an unchanged MCP tool after a generation swap')
  assert.ok(textOf(echoResult).includes('unknown tool'))
})

feasibilityTest('dynamic registration: a synchronous tools/change listener can re-enter the registry', async t => {
  const h = await createHarness(t, { servers: [] })
  let changes = 0
  let canaryDisposer
  let addingCanary = false
  const off = h.root.on('tools/change', () => {
    changes++
    if (canaryDisposer !== undefined || addingCanary) return
    // The registry emits tools/change synchronously from inside register(),
    // before register() returns its disposer; set the guard first to keep the
    // nested notification from attempting a duplicate registration.
    addingCanary = true
    canaryDisposer = h.root.tools.register(fakeDefinition('feasibility_reentrant_canary', async () => ({}), 'first'))
  })

  await h.mount({ serverName: 'alpha', rawTools: ['search', 'a__x', 'feasibility_echo'] })
  off()
  assert.ok(changes > 0)
  assert.equal(h.root.tools.get('feasibility_reentrant_canary')?.description, 'first')
  assert.deepEqual(
    mcpPublicNames(h.root),
    expectedNames([{ serverName: 'alpha', rawTools: ['search', 'a__x', 'feasibility_echo'] }]),
    'the synchronous listener did not corrupt the MCP generation',
  )

  // Replacement of a same-name tool is one visible definition, not a duplicate.
  canaryDisposer()
  assert.equal(h.root.tools.get('feasibility_reentrant_canary'), undefined)
  h.root.tools.register(fakeDefinition('feasibility_reentrant_canary', async () => ({}), 'replacement'))
  assert.equal(h.root.tools.get('feasibility_reentrant_canary')?.description, 'replacement')

  // Naive re-entry is not safe: register() emits tools/change from inside the
  // insertion, before it returns its disposer, so a listener that calls
  // register() unconditionally observes a nested change and a duplicate-name
  // error. Callers must set a re-entry guard before registering.
  let naiveAttempts = 0
  let naiveError
  const offNaive = h.root.on('tools/change', () => {
    naiveAttempts++
    try {
      h.root.tools.register(fakeDefinition('feasibility_naive_canary', async () => ({})))
    } catch (error) {
      naiveError = error
    }
  })
  h.root.tools.register(fakeDefinition('feasibility_trigger', async () => ({})))
  offNaive()
  assert.equal(naiveAttempts >= 2, true)
  assert.ok(naiveError instanceof Error)
  assert.match(naiveError.message, /already registered/)
})

feasibilityTest('scoping: agent restrictions intersect and only affect their own agent', async t => {
  const h = await createHarness(t, {
    servers: [
      { serverName: 'alpha', rawTools: ['search', 'a.b', 'feasibility_echo'] },
      { serverName: 'beta', rawTools: ['search', 'feasibility_echo'] },
    ],
  })
  const scopes = await createAgentScopes(t, h.root, { withPreset: true })
  const alphaSearch = expectedPublicName('alpha', 'search')
  const alphaAll = ['search', 'a.b', 'feasibility_echo'].map(raw => expectedPublicName('alpha', raw))
  const betaSearch = expectedPublicName('beta', 'search')

  const presetDisposer = scopes.presetScope.ctx.tools.restrict({ deny: alphaAll })
  assert.equal(h.root.tools.schemas(scopes.a).some(schema => alphaAll.includes(schema.name)), false)
  assert.equal(h.root.tools.schemas(scopes.b).some(schema => alphaAll.includes(schema.name)), false)
  assert.equal(h.root.tools.schemas(scopes.a).some(schema => schema.name === betaSearch), true, 'beta is not affected')

  // A narrower allow in the child intersects with (cannot lift) the ancestor deny.
  const allowDisposer = scopes.scopeA.ctx.tools.restrict({ allow: [alphaSearch, betaSearch] })
  const visibleA = h.root.tools.schemas(scopes.a).map(schema => schema.name)
  assert.ok(visibleA.includes(betaSearch))
  assert.equal(visibleA.includes(alphaSearch), false, 'child allow cannot release the ancestor deny')
  allowDisposer()
  assert.equal(h.root.tools.schemas(scopes.a).some(schema => alphaAll.includes(schema.name)), false, 'disposing the child mask leaves the ancestor deny')
  presetDisposer()
  assert.equal(h.root.tools.schemas(scopes.a).some(schema => alphaAll.includes(schema.name)), true, 'only disposing the deny lifts it')
})

feasibilityTest('scoping: per-agent expansion canaries are isolated and cannot release other restrictions', async t => {
  const h = await createHarness(t, {
    servers: [
      { serverName: 'alpha', rawTools: ['search', 'feasibility_echo'] },
      { serverName: 'beta', rawTools: ['search', 'feasibility_echo'] },
    ],
  })
  const scopes = await createAgentScopes(t, h.root, { withPreset: true })
  const alphaSearch = expectedPublicName('alpha', 'search')
  const presetDisposer = scopes.presetScope.ctx.tools.restrict({ deny: [alphaSearch] })

  let expansion = 0
  scopes.scopeA.ctx.tools.register(
    fakeDefinition('feasibility_canary_service1', async () => ({})),
    { when: () => expansion === 1 },
  )
  scopes.scopeA.ctx.tools.register(
    fakeDefinition('feasibility_canary_service2', async () => ({})),
    { when: () => expansion === 2 },
  )

  expansion = 1
  const [setA, setB, setA2] = await Promise.all([
    resolveFor(h.root, scopes.a),
    resolveFor(h.root, scopes.b),
    (async () => {
      await delay(5)
      return resolveFor(h.root, scopes.a)
    })(),
  ])
  for (const set of [setA, setA2]) {
    assert.equal(set.view(scopes.a).has('feasibility_canary_service1'), true)
    assert.equal(set.view(scopes.a).has('feasibility_canary_service2'), false, 'expanding one service cannot expand the second')
    assert.equal(set.view(scopes.a).has(alphaSearch), false, 'expansion cannot release the other restriction')
  }
  assert.equal(setB.view(scopes.b).has('feasibility_canary_service1'), false, 'A expansion does not affect B')
  assert.equal(setB.view(scopes.b).has('feasibility_canary_service2'), false)

  expansion = 2
  const setA3 = await resolveFor(h.root, scopes.a)
  assert.equal(setA3.view(scopes.a).has('feasibility_canary_service1'), false)
  assert.equal(setA3.view(scopes.a).has('feasibility_canary_service2'), true)

  // Registry inspection (no toolSet) ignores `when`: disclosure surfaces must
  // never use definitions()/schemas() as the step view.
  const inspected = h.root.tools.definitions(scopes.a).map(definition => definition.name)
  assert.ok(inspected.includes('feasibility_canary_service1'))
  assert.ok(inspected.includes('feasibility_canary_service2'))
  presetDisposer()
})

feasibilityTest('scoping: a same-name agent shadow can execute a restricted MCP tool (observed unsafe path)', async t => {
  const h = await createHarness(t, { servers: [{ serverName: 'alpha', rawTools: ['search', 'feasibility_echo'] }] })
  const scopes = await createAgentScopes(t, h.root)
  const name = expectedPublicName('alpha', 'search')
  const original = h.root.tools.get(name)
  assert.ok(original, 'the global MCP definition is readable by public name')

  scopes.scopeA.ctx.tools.restrict({ deny: [name] })
  assert.equal(h.root.tools.schemas(scopes.a).some(schema => schema.name === name), false)

  let expanded = false
  scopes.scopeA.ctx.tools.register(
    {
      ...original,
      description: 'shadow',
      execute: (args, exec) => original.execute(args, exec),
    },
    { when: () => expanded },
  )

  // A registry inspection without a step toolSet still shows the conditional
  // shadow; only resolve() is condition-aware.
  assert.equal(h.root.tools.schemas(scopes.a).some(schema => schema.name === name), true)
  const before = await resolveFor(h.root, scopes.a)
  assert.equal(before.view(scopes.a).has(name), false, 'condition keeps the shadow out of the step')

  expanded = true
  const after = await resolveFor(h.root, scopes.a)
  assert.equal(after.view(scopes.a).has(name), true, 'expansion admits the shadow in A')
  assert.equal(h.root.tools.get(name, scopes.b)?.description, 'alpha tool search', 'B still sees the original global tool')

  const result = await callTool(h.root, name, { via: 'shadow' }, { agent: scopes.a, toolSet: after })
  assert.equal(result.isError, false, 'the shadow delegates to the real MCP execute body')
  assert.ok(textOf(result).includes('raw=search'))

  // This is the observed failure: an agent-local shadow is exempt from
  // tools.restrict(), so expansion can release an admission restriction. The
  // design explicitly forbids relying on this path.
  assert.equal(h.root.tools.schemas(scopes.a).some(schema => schema.name === name), true)
})

feasibilityTest('shutdown: guard runs before dispatch but not again in the guard-to-body window (observed race)', async t => {
  const h = await createHarness(t, { servers: [] })
  const scopes = await createAgentScopes(t, h.root)
  let globalDeny = false
  let agentDeny = false
  let bodyCalls = 0

  h.root.tools.register(fakeDefinition('feasibility_guarded', async () => { bodyCalls++; return {} }))
  h.root.tools.guard(() => (globalDeny ? 'global-disabled' : undefined))
  scopes.scopeA.ctx.tools.guard(() => (agentDeny ? 'agent-a-disabled' : undefined))

  // Global guard covers agent-less and every agent.
  globalDeny = true
  for (const agent of [undefined, scopes.a, scopes.b]) {
    const denied = await callTool(h.root, 'feasibility_guarded', {}, { agent })
    assert.equal(denied.isError, true)
    assert.ok(textOf(denied).includes('global-disabled'))
  }
  assert.equal(bodyCalls, 0, 'a guard denial before dispatch never runs the body')
  globalDeny = false

  // A guard registered in A's scope covers A only.
  agentDeny = true
  assert.equal((await callTool(h.root, 'feasibility_guarded', {}, { agent: scopes.a })).isError, true)
  assert.equal((await callTool(h.root, 'feasibility_guarded', {}, { agent: scopes.b })).isError, false)
  assert.equal((await callTool(h.root, 'feasibility_guarded')).isError, false)
  agentDeny = false

  // The race: prepare() evaluates the guard, then the switch commits, then
  // dispatch() runs the body without re-checking the guard.
  const pipeline = new dsh.ToolExecutionPipeline(h.root)
  const prepared = await pipeline.prepare({
    callId: 'feasibility-race',
    name: 'feasibility_guarded',
    arguments: {},
    signal: new AbortController().signal,
  })
  assert.equal(prepared.kind, 'dispatch')
  globalDeny = true
  const before = bodyCalls
  const dispatched = await pipeline.dispatch(prepared.exec)
  const completed = await pipeline.complete(prepared.exec, dispatched)
  assert.equal(bodyCalls, before + 1, 'observed: the body executed after the switch committed post-guard')
  assert.equal(completed.isError, false)

  // The ordinary path (prepare happens after the commit) is denied.
  const deniedPrepare = await pipeline.prepare({
    callId: 'feasibility-denied',
    name: 'feasibility_guarded',
    arguments: {},
    signal: new AbortController().signal,
  })
  assert.equal(deniedPrepare.kind, 'post-result')
  const deniedResult = await pipeline.complete(deniedPrepare.exec, deniedPrepare)
  assert.equal(deniedResult.isError, true)
  assert.equal(bodyCalls, before + 1)
})

feasibilityTest('shutdown: old step snapshots and removed registrations cannot execute', async t => {
  const h = await createHarness(t, { servers: [] })
  const scopes = await createAgentScopes(t, h.root)
  let bodyCalls = 0
  const disposer = h.root.tools.register(fakeDefinition('feasibility_snapshot', async () => { bodyCalls++; return {} }))
  const set = await resolveFor(h.root, scopes.a)
  assert.equal(set.view(scopes.a).has('feasibility_snapshot'), true)

  disposer()
  const result = await callTool(h.root, 'feasibility_snapshot', {}, { agent: scopes.a, toolSet: set })
  assert.equal(result.isError, true)
  assert.equal(bodyCalls, 0, 'a registration removed after the step snapshot cannot run')

  // Already-dispatched work is not forcibly interrupted; cancellation settles
  // the started body as aborted.
  let started = false
  let finished = false
  h.root.tools.register(fakeDefinition('feasibility_slow', async () => {
    started = true
    await delay(60)
    finished = true
    return {}
  }))
  const controller = new AbortController()
  const slow = callTool(h.root, 'feasibility_slow', {}, { agent: scopes.a, signal: controller.signal })
  await waitFor(() => started, 'slow body to start')
  controller.abort('feasibility-stop')
  const slowResult = await slow
  assert.equal(finished, true, 'the started body runs to quiescence')
  assert.equal(slowResult.isError, true)
  assert.ok(textOf(slowResult).includes('aborted'))
})

feasibilityTest('resources/instructions: hiding business tools leaves resource access and server instructions visible', async t => {
  const h = await createHarness(t, {
    servers: [
      { serverName: 'alpha', rawTools: ['search', 'feasibility_echo'] },
      { serverName: 'beta', rawTools: ['search', 'feasibility_echo'] },
    ],
  })
  const scopes = await createAgentScopes(t, h.root)
  const alphaAll = ['search', 'feasibility_echo'].map(raw => expectedPublicName('alpha', raw))

  const businessDeny = scopes.scopeA.ctx.tools.restrict({ deny: alphaAll })
  const visible = h.root.tools.schemas(scopes.a).map(schema => schema.name)
  assert.equal(visible.some(name => alphaAll.includes(name)), false)
  assert.ok(visible.includes('read_mcp_resource'), 'shared resource tools stay visible')
  assert.ok(visible.includes(expectedPublicName('beta', 'search')))

  const assembly = await h.root.systemPrompt.assemble({ scope: scopes.a })
  const prompt = dsh.renderPrompt(assembly)
  assert.ok(prompt.includes('ALPHA_INSTRUCTIONS_MARKER'), 'server instructions are an independent prompt channel')
  assert.ok(prompt.includes('"alpha"'), 'the resource-server prompt lists the filtered server')
  assert.ok(prompt.includes('"beta"'))

  const read = await callTool(h.root, 'read_mcp_resource', {
    server: 'alpha',
    uri: 'alpha://secret',
  }, { agent: scopes.a })
  assert.equal(read.isError, false, 'the filtered server resource remains readable')
  assert.ok(textOf(read).includes('ALPHA_RESOURCE_PAYLOAD'))

  const list = await callTool(h.root, 'list_mcp_resources', { server: 'alpha' }, { agent: scopes.a })
  assert.equal(list.isError, false)
  assert.ok(textOf(list).includes('alpha://secret'))

  const templates = await callTool(h.root, 'list_mcp_resource_templates', { server: 'alpha' }, { agent: scopes.a })
  assert.equal(templates.isError, false, 'the shared template-list tool is callable for the filtered server')
  assert.ok(textOf(templates).includes('resourceTemplates'))

  // Hiding the three shared resource tools is all-or-nothing and still does
  // not remove the server instruction section.
  const resourceDeny = scopes.scopeA.ctx.tools.restrict({
    deny: ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'],
  })
  assert.equal(h.root.tools.schemas(scopes.a).some(schema => RESOURCE_TOOL_NAMES.has(schema.name)), false)
  const hiddenRead = await callTool(h.root, 'read_mcp_resource', {
    server: 'alpha',
    uri: 'alpha://secret',
  }, { agent: scopes.a })
  assert.equal(hiddenRead.isError, true)
  assert.ok(textOf(hiddenRead).includes('unknown tool'))
  const hiddenPrompt = dsh.renderPrompt(await h.root.systemPrompt.assemble({ scope: scopes.a }))
  assert.ok(hiddenPrompt.includes('ALPHA_INSTRUCTIONS_MARKER'), 'server instructions survive resource-tool hiding')
  const otherRead = await callTool(h.root, 'read_mcp_resource', {
    server: 'alpha',
    uri: 'alpha://secret',
  }, { agent: scopes.b })
  assert.equal(otherRead.isError, false, 'B still has the shared resource path')

  businessDeny()
  resourceDeny()
})

feasibilityTest('offline: failed connection leaves stale schemas and server instructions registered (observed inconsistency)', async t => {
  const h = await createHarness(t, {
    servers: [{
      serverName: 'alpha',
      rawTools: ['search', 'feasibility_echo', 'feasibility_crash'],
      reconnect: { enabled: false },
    }],
  })
  const before = mcpPublicNames(h.root)
  assert.equal(h.status('alpha').state, 'connected')

  const crash = await callTool(h.root, expectedPublicName('alpha', 'feasibility_crash'))
  assert.equal(crash.isError, false)
  await waitFor(() => h.status('alpha').state === 'failed', 'failed connection state')
  assert.equal(h.status('alpha').reason, 'reconnect-disabled')

  // The model-facing registration is stale while the service is offline.
  assert.deepEqual(mcpPublicNames(h.root), before, 'offline status does not remove the last registered schemas')
  const assembly = await h.root.systemPrompt.assemble({})
  assert.ok(dsh.renderPrompt(assembly).includes('ALPHA_INSTRUCTIONS_MARKER'), 'offline status does not remove stale server instructions')

  const call = await callTool(h.root, expectedPublicName('alpha', 'search'))
  assert.equal(call.isError, true)
  const read = await callTool(h.root, 'read_mcp_resource', { server: 'alpha', uri: 'alpha://secret' })
  assert.equal(read.isError, true)
  assert.ok(textOf(read).includes('disconnected'))
  const list = await callTool(h.root, 'list_mcp_resources', { server: 'alpha' })
  assert.equal(list.isError, true, 'offline resource listing fails')
  assert.ok(textOf(list).includes('disconnected'))
  const templates = await callTool(h.root, 'list_mcp_resource_templates', { server: 'alpha' })
  assert.equal(templates.isError, true, 'offline resource template listing fails')
  assert.ok(textOf(templates).includes('disconnected'))

  // Status says failed with no toolCount, while the registry still lists tools.
  assert.equal(Object.hasOwn(h.status('alpha'), 'toolCount'), false)
  assert.ok(mcpPublicNames(h.root).length > 0)
})

feasibilityTest('reconnect/remount: public names survive generations, but generation identity is not exposed', async t => {
  const h = await createHarness(t, {
    servers: [{
      serverName: 'alpha',
      rawTools: ['search', 'feasibility_echo', 'feasibility_crash'],
      reconnect: { enabled: true, initialDelayMs: 50, maxDelayMs: 100, maxAttempts: 5 },
    }],
  })
  const record = h.clients.get('alpha')
  const before = mcpPublicNames(h.root)
  const firstConnectedAt = record.statusHandle.current().connectedAt
  const states = []
  const off = record.statusHandle.onChange(status => states.push(status.state))

  const crash = await callTool(h.root, expectedPublicName('alpha', 'feasibility_crash'))
  assert.equal(crash.isError, false)
  await waitFor(() => states.includes('reconnecting'), 'reconnecting state')
  await waitFor(() => {
    const status = record.statusHandle.current()
    return status.state === 'connected' && status.connectedAt !== firstConnectedAt
  }, 'reconnected generation')

  assert.deepEqual(mcpPublicNames(h.root), before, 'a new connection generation reproduces the same public names')
  const echo = await callTool(h.root, expectedPublicName('alpha', 'feasibility_echo'))
  assert.equal(echo.isError, false)
  off()

  await h.unmount('alpha')
  assert.deepEqual(mcpPublicNames(h.root), [], 'unmount removes the generation')
  await h.mount({ serverName: 'alpha', rawTools: ['search', 'feasibility_echo', 'feasibility_crash'] })
  assert.deepEqual(mcpPublicNames(h.root), before, 'remount reproduces the same public names')
})

feasibilityTest('manager/probe: status and probe expose no current-generation server/raw mapping', async t => {
  const h = await createHarness(t, {
    manager: true,
    servers: [
      { serverName: 'alpha', rawTools: ['search', 'a.b', 'feasibility_echo'] },
      { serverName: 'beta', rawTools: ['search', 'feasibility_echo'] },
    ],
  })
  await waitFor(
    () => h.root.mcpManager.list().length === 2
      && h.root.mcpManager.list().every(entry => entry.status.state === 'connected'),
    'managed servers to connect',
    15_000,
  )
  const views = h.root.mcpManager.list()
  assert.equal(views.length, 2)
  for (const view of views) {
    assert.deepEqual(Object.keys(view).sort(), ['configured', 'name', 'status'])
    assert.equal(Object.hasOwn(view, 'toolNames'), false)
    assert.equal(Object.hasOwn(view, 'tools'), false)
    assert.equal(Object.hasOwn(view.status, 'toolNames'), false)
    assert.equal(Object.hasOwn(view.status, 'toolCount'), true)
  }
  const managerText = JSON.stringify(views)
  assert.equal(managerText.includes('mcp__'), false, 'manager views do not expose public names')
  assert.equal(managerText.includes('a.b'), false, 'manager views do not expose raw names')

  const namesBefore = mcpPublicNames(h.root)
  const connectedAtBefore = views.find(view => view.name === 'alpha').status.connectedAt
  const probe = await h.root.mcpManager.probe('alpha')
  assert.equal(probe.ok, true)
  assert.deepEqual(probe.toolNames, ['search', 'a.b', 'feasibility_echo'])
  assert.equal(probe.closeConfirmed, true)

  // The probe is an independent connection: it neither changes the live
  // registry nor the current generation's identity, and it only returns raw
  // names. It is therefore not evidence for mapping the live generation.
  assert.deepEqual(mcpPublicNames(h.root), namesBefore)
  assert.equal(h.root.mcpManager.list().find(view => view.name === 'alpha').status.connectedAt, connectedAtBefore)
})

feasibilityTest('shutdown: tools/execute denial stops prepared A/B/agent-less MCP calls; allowed calls continue', async t => {
  const h = await createHarness(t, {
    servers: [
      { serverName: 'alpha', rawTools: ['search', 'feasibility_echo'] },
      { serverName: 'beta', rawTools: ['search', 'feasibility_echo'] },
    ],
  })
  const scopes = await createAgentScopes(t, h.root)
  const echo = expectedPublicName('alpha', 'feasibility_echo')
  let closed = false
  let executeVisits = 0
  const off = h.root.on('tools/execute', async (exec, next) => {
    executeVisits++
    if (closed && exec.name === echo) return dispatchDenial('switch closed after prepare')
    return next()
  })

  const pipeline = new dsh.ToolExecutionPipeline(h.root)
  const prepared = []
  for (const agent of [scopes.a, scopes.b, undefined]) {
    const call = await pipeline.prepare({
      callId: `feasibility-dispatch-${prepared.length}`,
      name: echo,
      arguments: {},
      ...agent === undefined ? {} : { agent },
      signal: new AbortController().signal,
    })
    assert.equal(call.kind, 'dispatch')
    prepared.push(call)
  }

  const countCalls = async () => (await h.readEvents()).filter(line => line.startsWith('call ')).length
  const before = await countCalls()
  closed = true
  for (const call of prepared) {
    const dispatched = await pipeline.dispatch(call.exec)
    const result = await pipeline.complete(call.exec, dispatched)
    assert.equal(result.isError, true)
    assert.ok(textOf(result).includes('switch closed after prepare'))
  }
  await delay(50)
  assert.equal(await countCalls(), before, 'denied prepared calls never reached the MCP body')

  // A tools/execute listener that calls next() leaves ordinary calls working.
  closed = false
  for (const agent of [scopes.a, scopes.b, undefined]) {
    const result = await callTool(h.root, echo, {}, { agent })
    assert.equal(result.isError, false, 'allowed call executes through next()')
  }
  assert.equal(await countCalls(), before + 3)
  assert.ok(executeVisits >= 6)
  off()
})

feasibilityTest('shutdown: dispatch-stage path preserves approval and cancellation behaviour', async t => {
  const h = await createHarness(t, {
    servers: [
      { serverName: 'alpha', rawTools: ['search', 'feasibility_echo'] },
      { serverName: 'beta', rawTools: ['search', 'feasibility_echo'] },
    ],
  })
  const scopes = await createAgentScopes(t, h.root)
  const echo = expectedPublicName('alpha', 'feasibility_echo')
  let approvalOutcome = 'allowed-once'
  let approvalRequests = 0
  h.root.provide('approval', {
    request: async () => {
      approvalRequests++
      return approvalOutcome
    },
  })
  let ask = true
  const offPre = h.root.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === echo && ask) return { kind: 'ask', reason: 'feasibility approval' }
    return next()
  })
  let executeVisits = 0
  const offExec = h.root.on('tools/execute', async (_exec, next) => {
    executeVisits++
    return next()
  })
  const countCalls = async () => (await h.readEvents()).filter(line => line.startsWith('call ')).length

  const before = await countCalls()
  const allowed = await callTool(h.root, echo, {}, { agent: scopes.a })
  assert.equal(allowed.isError, false)
  assert.equal(approvalRequests, 1)
  assert.equal(await countCalls(), before + 1)
  assert.ok(executeVisits >= 1)

  approvalOutcome = 'rejected'
  const rejected = await callTool(h.root, echo, {}, { agent: scopes.a })
  assert.equal(rejected.isError, true)
  assert.ok(textOf(rejected).includes('rejected'))
  assert.equal(await countCalls(), before + 1, 'a rejected approval does not reach the body')

  approvalOutcome = 'cancelled'
  const cancelled = await callTool(h.root, echo, {}, { agent: scopes.a })
  assert.equal(cancelled.isError, true)
  assert.ok(textOf(cancelled).includes('cancelled'))
  assert.equal(await countCalls(), before + 1)

  // Cancellation between prepare and dispatch still wins through the wrapper.
  ask = false
  const controller = new AbortController()
  const pipeline = new dsh.ToolExecutionPipeline(h.root)
  const prepared = await pipeline.prepare({
    callId: 'feasibility-cancel-between',
    name: echo,
    arguments: {},
    agent: scopes.a,
    signal: controller.signal,
  })
  assert.equal(prepared.kind, 'dispatch')
  controller.abort('feasibility-stop')
  const dispatched = await pipeline.dispatch(prepared.exec)
  const aborted = await pipeline.complete(prepared.exec, dispatched)
  assert.equal(aborted.isError, true)
  assert.ok(textOf(aborted).includes('aborted before dispatch'))
  assert.equal(await countCalls(), before + 1, 'cancelled-before-dispatch never reaches the body')
  assert.equal(approvalRequests, 3)
  offPre()
  offExec()
})

feasibilityTest('shutdown: post-prepare agent restriction blocks dispatch with and without a step set', async t => {
  const h = await createHarness(t, {
    servers: [
      { serverName: 'alpha', rawTools: ['search', 'feasibility_echo'] },
      { serverName: 'beta', rawTools: ['search', 'feasibility_echo'] },
    ],
  })
  const scopes = await createAgentScopes(t, h.root)
  const echo = expectedPublicName('alpha', 'feasibility_echo')
  const pipeline = new dsh.ToolExecutionPipeline(h.root)
  const countCalls = async () => (await h.readEvents()).filter(line => line.startsWith('call ')).length
  const before = await countCalls()

  // No step set: dispatch re-resolves through tools.executable() and sees the
  // restriction added after prepare.
  const noSet = await pipeline.prepare({
    callId: 'feasibility-restrict-no-set',
    name: echo,
    arguments: {},
    agent: scopes.a,
    signal: new AbortController().signal,
  })
  assert.equal(noSet.kind, 'dispatch')
  const layerNoSet = scopes.scopeA.ctx.tools.restrict({ deny: [echo] })
  assert.equal(h.root.tools.schemas(scopes.a).some(schema => schema.name === echo), false, 'changed status is visible immediately')
  const noSetOutcome = await pipeline.complete(noSet.exec, await pipeline.dispatch(noSet.exec))
  assert.equal(noSetOutcome.isError, true)
  assert.ok(textOf(noSetOutcome).includes('unknown tool'))
  layerNoSet()

  // With a step set: the set itself now excludes the restricted name at
  // dispatch, even though the set was resolved before the restriction.
  const set = await resolveFor(h.root, scopes.a)
  assert.equal(set.view(scopes.a).has(echo), true)
  const withSet = await pipeline.prepare({
    callId: 'feasibility-restrict-with-set',
    name: echo,
    arguments: {},
    agent: scopes.a,
    toolSet: set,
    signal: new AbortController().signal,
  })
  assert.equal(withSet.kind, 'dispatch')
  const layerWithSet = scopes.scopeA.ctx.tools.restrict({ deny: [echo] })
  assert.equal(set.view(scopes.a).has(echo), false, 'the resolved set observes the new restriction')
  const withSetOutcome = await pipeline.complete(withSet.exec, await pipeline.dispatch(withSet.exec))
  assert.equal(withSetOutcome.isError, true)
  assert.ok(textOf(withSetOutcome).includes('unknown tool'))
  layerWithSet()

  await delay(50)
  assert.equal(await countCalls(), before, 'neither restriction path reached the MCP body')
})

feasibilityTest('scoping: per-agent restrict disclosure layer reveals the original MCP tool; ancestor deny remains', async t => {
  const h = await createHarness(t, {
    servers: [
      { serverName: 'alpha', rawTools: ['search', 'feasibility_echo'] },
      { serverName: 'beta', rawTools: ['search', 'feasibility_echo'] },
    ],
  })
  const scopes = await createAgentScopes(t, h.root, { withPreset: true })
  const alphaAll = ['search', 'feasibility_echo'].map(raw => expectedPublicName('alpha', raw))
  const alphaSearch = expectedPublicName('alpha', 'search')
  const betaSearch = expectedPublicName('beta', 'search')
  const betaEcho = expectedPublicName('beta', 'feasibility_echo')

  const presetDeny = scopes.presetScope.ctx.tools.restrict({ deny: [betaSearch] })
  const alphaLayer = scopes.scopeA.ctx.tools.restrict({ deny: alphaAll })
  const betaEchoLayer = scopes.scopeA.ctx.tools.restrict({ deny: [betaEcho] })
  let switchClosed = true
  const switchDisposer = h.root.tools.guard(exec => (
    exec.name === betaEcho && switchClosed ? { reason: 'independent switch closed' } : undefined
  ))

  const visible = agent => h.root.tools.schemas(agent).map(schema => schema.name)
  assert.equal(visible(scopes.a).some(name => alphaAll.includes(name)), false)
  assert.equal(visible(scopes.a).includes(betaEcho), false)
  assert.equal(visible(scopes.a).includes(betaSearch), false)
  assert.equal(visible(scopes.b).some(name => alphaAll.includes(name)), true)
  assert.equal(visible(scopes.b).includes(betaEcho), true)
  assert.equal(visible(scopes.b).includes(betaSearch), false, 'ancestor deny applies to both agents')

  const oldSet = await resolveFor(h.root, scopes.a)
  assert.equal(oldSet.view(scopes.a).has(alphaSearch), false)
  alphaLayer()
  assert.equal(visible(scopes.a).some(name => alphaAll.includes(name)), true, 'disposing the A layer reveals the original global MCP names')
  assert.equal(oldSet.view(scopes.a).has(alphaSearch), false, 'the step resolved before disposal stays closed')
  const nextSet = await resolveFor(h.root, scopes.a)
  assert.equal(nextSet.view(scopes.a).has(alphaSearch), true, 'the next step sees the revealed tool')
  assert.equal(visible(scopes.a).includes(betaEcho), false, 'the second service layer is still independent')
  assert.equal(visible(scopes.a).includes(betaSearch), false, 'disposing the A layer cannot release the ancestor deny')
  assert.equal(visible(scopes.b).includes(betaEcho), true, 'B is unaffected')

  const alphaCall = await callTool(h.root, alphaSearch, {}, { agent: scopes.a })
  assert.equal(alphaCall.isError, false)
  assert.ok(textOf(alphaCall).includes('alpha raw=search'), 'the original MCP body, not a shadow, executed')
  const hiddenBetaEcho = await callTool(h.root, betaEcho, {}, { agent: scopes.a })
  assert.equal(hiddenBetaEcho.isError, true, 'A cannot call beta echo through either the scope layer or the switch')

  // A separate global switch (guard) is not released by the A disclosure
  // disposal, and B's visible tool is still denied before its body.
  const countCalls = async () => (await h.readEvents()).filter(line => line.startsWith('call ')).length
  const beforeSwitch = await countCalls()
  const switchedB = await callTool(h.root, betaEcho, {}, { agent: scopes.b })
  assert.equal(switchedB.isError, true)
  assert.ok(textOf(switchedB).includes('independent switch closed'))
  assert.equal(await countCalls(), beforeSwitch)
  switchClosed = false
  const openB = await callTool(h.root, betaEcho, {}, { agent: scopes.b })
  assert.equal(openB.isError, false)
  assert.equal(await countCalls(), beforeSwitch + 1)
  switchDisposer()

  const [setA, setB] = await Promise.all([resolveFor(h.root, scopes.a), resolveFor(h.root, scopes.b)])
  assert.equal(setA.view(scopes.a).has(alphaSearch), true)
  assert.equal(setA.view(scopes.a).has(betaEcho), false)
  assert.equal(setA.view(scopes.a).has(betaSearch), false)
  assert.equal(setB.view(scopes.b).has(alphaSearch), true)
  assert.equal(setB.view(scopes.b).has(betaEcho), true)
  assert.equal(setB.view(scopes.b).has(betaSearch), false)

  presetDeny()
  betaEchoLayer()
})

feasibilityTest('scoping: deny-list disclosure layer does not hide MCP tools registered after it (observed gap)', async t => {
  const h = await createHarness(t, {
    servers: [
      { serverName: 'alpha', rawTools: ['search', 'feasibility_echo', 'feasibility_change_tools'] },
      { serverName: 'beta', rawTools: ['search', 'feasibility_echo'] },
    ],
  })
  const scopes = await createAgentScopes(t, h.root)
  const existing = ['search', 'feasibility_echo', 'feasibility_change_tools']
    .map(raw => expectedPublicName('alpha', raw))
  const newName = expectedPublicName('alpha', 'new.tool')
  const layer = scopes.scopeA.ctx.tools.restrict({ deny: existing })
  const visible = agent => h.root.tools.schemas(agent).map(schema => schema.name)
  assert.equal(visible(scopes.a).some(name => existing.includes(name)), false)

  // B (unrestricted for alpha) triggers a dynamic list change.
  const changed = await callTool(h.root, expectedPublicName('alpha', 'feasibility_change_tools'), {}, { agent: scopes.b })
  assert.equal(changed.isError, false)
  await waitFor(
    () => h.root.tools.definitions().some(definition => definition.name === newName),
    'new alpha tool registration',
  )
  assert.equal(visible(scopes.a).includes(newName), true, 'observed: a name added after the deny layer is visible before disclosure')
  assert.equal(visible(scopes.a).some(name => existing.includes(name)), false)
  const newCall = await callTool(h.root, newName, {}, { agent: scopes.a })
  assert.equal(newCall.isError, false, 'the dynamically added tool is callable before expansion')

  // Removal/reload while the layer is active: same names stay hidden for A.
  await h.unmount('alpha')
  await h.mount({ serverName: 'alpha', rawTools: ['search', 'feasibility_echo', 'feasibility_change_tools'] })
  assert.equal(visible(scopes.a).some(name => existing.includes(name)), false, 'the layer still hides the same names after remount')
  assert.equal(visible(scopes.b).some(name => existing.includes(name)), true)
  const [setA, setB] = await Promise.all([resolveFor(h.root, scopes.a), resolveFor(h.root, scopes.b)])
  assert.equal(setA.view(scopes.a).has(expectedPublicName('alpha', 'search')), false)
  assert.equal(setB.view(scopes.b).has(expectedPublicName('alpha', 'search')), true)

  layer()
  assert.equal(visible(scopes.a).some(name => existing.includes(name)), true, 'disposing the layer reveals the original names')
})

feasibilityTest('dynamic sync: tools/change observers see a partial generation during a swap (observed)', async t => {
  const h = await createHarness(t, {
    servers: [{ serverName: 'alpha', rawTools: ['search', 'feasibility_echo', 'feasibility_change_tools'] }],
  })
  const alphaCount = () => h.root.tools.definitions()
    .filter(definition => definition.name.startsWith('mcp__alpha__')).length
  const snapshots = []
  const off = h.root.on('tools/change', () => snapshots.push(alphaCount()))
  const changed = await callTool(h.root, expectedPublicName('alpha', 'feasibility_change_tools'))
  assert.equal(changed.isError, false)
  const newName = expectedPublicName('alpha', 'new.tool')
  await waitFor(
    () => h.root.tools.definitions().some(definition => definition.name === newName)
      && !h.root.tools.definitions().some(definition => definition.name === expectedPublicName('alpha', 'search')),
    'alpha resync',
  )
  off()
  const finalCount = alphaCount()
  assert.equal(finalCount, 3)
  assert.equal(snapshots.includes(0), true, 'observers can see the fully disposed intermediate state')
  assert.equal(snapshots.some(count => count > 0 && count < finalCount), true, 'observers can see a partial new generation')
})
