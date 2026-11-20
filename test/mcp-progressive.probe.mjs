/**
 * Host-bound probes for progressive MCP disclosure, per-tool switches and the
 * global MCP guard.
 *
 * These tests drive the *installed* DeepSeek Harness packages (Cordis, scopes,
 * tools, system-prompt, native executor, MCP client/resources) and the real
 * plugin entry point (`index.js`) against two controlled stdio MCP servers in a
 * temporary directory. Everything is isolated: no live profile is loaded, no
 * user configuration is written, and the fixtures only exist for the lifetime
 * of one test.
 *
 * The checks answer the questions a unit test cannot: does the model-facing
 * step really omit the business schemas, does a discover call really reveal the
 * original public names on the next step and execute them, does the installed
 * global guard really refuse a direct call, and does a `tools/change` addition
 * really stay refused until re-applied?
 *
 * Outcomes stay honest:
 *   - a passing check describes behaviour observed on the host;
 *   - an absent or mismatched installed runtime makes every check explicitly
 *     skipped as `unverified` (default), and a nonzero failure with
 *     `DSH_FEASIBILITY_REQUIRED=1` (`npm run verify:progressive`);
 *   - a check never silently degrades into a skip.
 *
 * Run with: node --test test/mcp-progressive.probe.mjs
 * (Deliberately not named *.test.mjs: the portable `npm test` suite does not
 * include host-bound probes.)
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { normalizeState } from '../src/store.js'

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH_ROOT = process.env.DSH_FEASIBILITY_ROOT ?? '/opt/dsh/lib/node_modules/@deepseek-ai/dsh'
/** Version the host-bound evidence in this repository was produced against. */
const DSH_VERSION = '0.2.2-rc.3'
/** Required mode makes an absent host runtime fail the command instead of skipping. */
const REQUIRE_HOST = process.env.DSH_FEASIBILITY_REQUIRED === '1'

const SERVERS = ['alpha', 'beta']
const RAW_TOOLS = ['search', 'echo', 'scoped', 'change_tools']
const NEW_TOOL = 'newtool'
const MODES = { a: 'a', b: 'b' }
const WORKSPACES = { a: '/workspace/alice', b: '/workspace/bob' }

/** Stable public names of the fixture tools (no lossy normalization applies). */
function publicName(server, raw) {
  return `mcp__${server}__${raw}`
}

const BUSINESS_NAMES = SERVERS.flatMap((server) => RAW_TOOLS.map((raw) => publicName(server, raw)))

/**
 * The per-tool switch and scope mismatch used by every harness.
 *
 * - `echo` is switched off in both services (both disclosure modes);
 * - `scoped` is restricted to mode `b`;
 * - `beta/search` is restricted to Alice's workspace, so Bob may not see it.
 *
 * The configs use the public name of each tool, exactly as the store and the
 * panel do.
 */
function perToolConfig() {
  const off = { enabled: false, modes: [], workspaces: [] }
  const modeB = { enabled: true, modes: [MODES.b], workspaces: [] }
  const aliceOnly = { enabled: true, modes: [], workspaces: [WORKSPACES.a] }
  return {
    [publicName('alpha', 'echo')]: off,
    [publicName('alpha', 'scoped')]: modeB,
    [publicName('beta', 'echo')]: off,
    [publicName('beta', 'scoped')]: modeB,
    [publicName('beta', 'search')]: aliceOnly,
  }
}

/**
 * One deterministic document for both fixtures.
 *
 * `disclosure` selects the mode under test; everything else (member scope,
 * per-tool switches, description) is identical so full and progressive results
 * are comparable.
 */
function stateFor(disclosure) {
  const tools = perToolConfig()
  const member = (server) => ({
    enabled: true,
    modes: [],
    workspaces: [],
    disclosure,
    description: `${server} service`,
    installedAt: '2026-11-20T00:00:00.000Z',
    tools: Object.fromEntries(
      Object.entries(tools).filter(([name]) => name.startsWith(`mcp__${server}__`)),
    ),
  })
  return normalizeState({
    version: 4,
    settings: { enabled: true, mcpGate: true, gateDefaultSkills: false },
    skills: {},
    sources: {},
    groups: {},
    mcp: { alpha: member('alpha'), beta: member('beta') },
  })
}

/**
 * A minimal MCP server over stdio (newline-delimited JSON-RPC 2.0).
 *
 * `change_tools` adds one new tool and emits `tools/list_changed`, which lets a
 * test exercise the host's dynamic-registration window against a real client
 * generation swap. Resources and server instructions exist so the documented
 * boundary ("only tool schemas and calls are hidden") can be observed.
 */
const FIXTURE_SOURCE = String.raw`
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const NAME = process.env.MCP_PROGRESSIVE_NAME || 'alpha'
const STATE_DIR = process.env.MCP_PROGRESSIVE_STATE || ''
const INITIAL_TOOLS = ['search', 'echo', 'scoped', 'change_tools']
const RESOURCE_URI = NAME + '://secret'
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
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        additionalProperties: true,
      },
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
      protocolVersion: '2025-11-25',
      capabilities: { tools: { listChanged: true }, resources: { subscribe: false, listChanged: false } },
      serverInfo: { name: NAME + '-fixture', version: '1.0.0' },
      instructions: NAME.toUpperCase() + '_INSTRUCTIONS_MARKER',
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
    if (raw === 'change_tools') {
      reply(message.id, textResult('changed'))
      if (!tools.includes('${NEW_TOOL}')) {
        tools = tools.concat(['${NEW_TOOL}'])
        send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
        event('changed')
      }
      return
    }
    if (!tools.includes(raw)) {
      rpcError(message.id, -32602, 'unknown tool: ' + raw)
      return
    }
    reply(message.id, textResult(NAME + ' raw=' + raw + ' args=' + JSON.stringify(args)))
    return
  }

  if (message.method === 'resources/list') {
    reply(message.id, { resources: [{ uri: RESOURCE_URI, name: NAME + '-secret', mimeType: 'text/plain' }] })
    return
  }
  if (message.method === 'resources/templates/list') { reply(message.id, { resourceTemplates: [] }); return }
  if (message.method === 'resources/read') {
    const uri = message.params && message.params.uri
    if (uri !== RESOURCE_URI) { rpcError(message.id, -32602, 'unknown resource: ' + uri); return }
    reply(message.id, {
      contents: [{ uri: uri, mimeType: 'text/plain', text: NAME.toUpperCase() + '_RESOURCE_PAYLOAD' }],
    })
    return
  }

  rpcError(message.id, -32601, 'method not found: ' + message.method)
})

reader.on('close', function () { process.exit(0) })
`

// ---------------------------------------------------------------------------
// Installed DSH loading and honest skip/fail
// ---------------------------------------------------------------------------

let dsh
let dshError

async function loadDsh() {
  if (!existsSync(join(DSH_ROOT, 'package.json'))) {
    throw new Error(`installed DSH package not found at ${DSH_ROOT}`)
  }
  const pkg = JSON.parse(await readFile(join(DSH_ROOT, 'package.json'), 'utf8'))
  if (pkg.version !== DSH_VERSION) {
    throw new Error(`expected installed DSH ${DSH_VERSION}, found ${String(pkg.version)} at ${DSH_ROOT}`)
  }
  const load = (id) => import(pathToFileURL(join(DSH_ROOT, 'node_modules', id)).href)
  const [cordis, scope, systemPrompt, tools, native, client, resources] = await Promise.all([
    load('@deepseek-ai/cordis/lib/index.js'),
    load('@deepseek-ai/dsh-scope/lib/index.js'),
    load('@deepseek-ai/dsh-system-prompt/lib/index.js'),
    load('@deepseek-ai/dsh-tools/lib/index.js'),
    load('@deepseek-ai/dsh-tool-executor-native/lib/index.js'),
    load('@deepseek-ai/dsh-mcp-client/lib/index.js'),
    load('@deepseek-ai/dsh-mcp-resources/lib/index.js'),
  ])
  return {
    version: pkg.version,
    Context: cordis.Context,
    createScope: scope.createScope,
    scopeOf: scope.scopeOf,
    SystemPrompt: systemPrompt.default,
    renderPrompt: systemPrompt.renderPrompt,
    ToolsService: tools.default,
    NativeExecutor: native,
    McpClient: client,
    McpResources: resources.default,
  }
}

try {
  dsh = await loadDsh()
} catch (error) {
  dshError = error
}

if (dshError !== undefined && !REQUIRE_HOST) {
  console.error(`[unverified] progressive probe will skip: ${dshError.message}`)
}

/** Register a test but report an absent/unusable installed runtime honestly. */
function hostTest(name, fn) {
  test(name, async (t) => {
    if (dshError !== undefined) {
      if (REQUIRE_HOST) {
        assert.fail(`host runtime unavailable (required mode): ${dshError.message}`)
      }
      t.skip(`unverified — ${dshError.message}`)
      return
    }
    await fn(t)
  })
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check, label, timeoutMs = 15_000, intervalMs = 25) {
  const started = Date.now()
  for (;;) {
    if (await check()) return
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await delay(intervalMs)
  }
}

let callCounter = 0

function clientConfig(server, serverFile, dir) {
  return {
    transport: 'stdio',
    serverName: server,
    command: process.execPath,
    args: [serverFile],
    env: {
      MCP_PROGRESSIVE_NAME: server,
      MCP_PROGRESSIVE_STATE: dir,
    },
    cwd: '',
    toolCallTimeoutMs: 5_000,
    startupTimeoutMs: 15_000,
    closeTimeoutMs: 1_000,
    expandTemplates: false,
    failOnStartupError: true,
    reconnect: { enabled: false },
  }
}

function textOf(result) {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/** Sorted model-facing names of one resolved step. */
function namesOf(set, agent) {
  return [...set.view(agent).keys()].sort()
}

/**
 * Boot two fixture servers, one temporary state document, the real plugin and
 * two real scoped Agent contexts, then activate both Agents through the host's
 * serial `agent/created` dispatch.
 *
 * The `agents` service is a two-entry registry stub: the plugin only reads
 * `list()` (re-apply on unload/reload and the preset replay). It exists so the
 * probe can trigger a real re-apply and a real plugin remount without a
 * full session runtime.
 */
async function createHarness(t, { disclosure, registerAgents = false }) {
  if (dshError !== undefined) throw dshError
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-progressive-'))
  const serverFile = join(dir, 'fixture-mcp-server.mjs')
  await writeFile(serverFile, FIXTURE_SOURCE, { mode: 0o600 })

  const root = new dsh.Context()
  await root.plugin(dsh.SystemPrompt)
  await root.plugin(dsh.ToolsService)
  await root.plugin(dsh.NativeExecutor)
  await root.plugin(dsh.McpResources)

  const statuses = new Map()
  for (const server of SERVERS) {
    const fiber = await root.plugin(dsh.McpClient, clientConfig(server, serverFile, dir))
    const status = dsh.McpClient.connectionStatusOf(fiber)
    assert.ok(status, `mcp-client(${server}) exposes a connection status handle`)
    statuses.set(server, status)
  }
  await waitFor(
    () => [...statuses.values()].every((status) => status.current().state === 'connected')
      && root.tools.definitions().filter((definition) => definition.name.startsWith('mcp__')).length
        === SERVERS.length * RAW_TOOLS.length,
    'both fixture servers to connect and register their initial tools',
  )

  const file = join(dir, 'state.json')
  await writeFile(file, JSON.stringify(stateFor(disclosure), null, 2))

  const plugin = await import('../index.js')
  const pluginFibers = []
  const addPlugin = async () => {
    const fiber = await root.plugin(plugin, { file, enabled: true })
    pluginFibers.push(fiber)
    return fiber
  }
  await addPlugin()

  const agents = {}
  await root.plugin({
    name: 'progressive-probe-agent-scopes',
    inject: ['tools'],
    apply(hostCtx) {
      for (const [key, preset] of Object.entries(MODES)) {
        // The Agent object is the host's scope key: restrictions installed on
        // its own context are resolved from the same object at dispatch.
        const agent = {
          id: `session-${key}`,
          session: { id: `session-${key}`, header: { agentPreset: preset, cwd: WORKSPACES[key] } },
        }
        const scope = dsh.createScope(hostCtx, agent)
        agent.ctx = scope.ctx
        agents[key] = { agent, scope }
      }
    },
  })

  if (registerAgents) {
    // Only the two checks that need a real re-apply / remount provide the live
    // registry. Doing it once here keeps the startup re-apply out of the middle
    // of a test's expansion.
    root.provide('agents', {
      list: () => [agents.a.agent, agents.b.agent],
    })
  }

  const liveSets = new Set()
  const resolveFor = async (agent) => {
    const set = await root.tools.resolve({
      agent,
      modelSelection: { provider: 'progressive-probe', model: 'fixture-model' },
      signal: new AbortController().signal,
    })
    liveSets.add(set)
    return set
  }

  const harness = {
    root,
    dir,
    file,
    plugin,
    pluginFibers,
    agents,
    /** Resolve one fresh model step and return it with its visible names. */
    async step(agent) {
      const set = await resolveFor(agent)
      return { set, names: namesOf(set, agent) }
    },
    /** Resolve, read the names and release the snapshot immediately. */
    async stepNames(agent) {
      const { set, names } = await harness.step(agent)
      set.dispose()
      liveSets.delete(set)
      return names
    },
    async call(name, args = {}, { agent, toolSet } = {}) {
      const batch = await root.tools.execute({
        signal: new AbortController().signal,
        ...(agent === undefined ? {} : { agent }),
        ...(toolSet === undefined ? {} : { toolSet }),
        calls: [{
          type: 'tool-call',
          id: `progressive-call-${++callCounter}`,
          name,
          arguments: JSON.stringify(args),
        }],
      })
      return batch.results[0].result
    },
    /** The reason the installed global guard gives for this exact call. */
    guardReason(name, agent) {
      return root.tools.checkGuards({ name, agent })?.reason
    },
    async events() {
      try {
        return (await readFile(join(dir, 'events.log'), 'utf8')).split('\n').filter(Boolean)
      } catch {
        return []
      }
    },
    async callEvents(raw) {
      return (await harness.events()).filter((line) => line === `call ${raw}`).length
    },
    /** Wait until the plugin's discover sync and the Agent activation settled. */
    async waitReady() {
      if (disclosure === 'progressive') {
        await waitFor(async () => {
          const names = await harness.stepNames(agents.a.agent)
          return names.includes('alpha_discover')
            && names.includes('beta_discover')
            && !names.some((name) => name.startsWith('mcp__alpha__') || name.startsWith('mcp__beta__'))
        }, 'progressive discover entries to become visible for Agent A')
      } else {
        await waitFor(async () => {
          const names = await harness.stepNames(agents.a.agent)
          return names.includes(publicName('alpha', 'search'))
            && names.includes(publicName('beta', 'search'))
            && !names.includes(publicName('alpha', 'echo'))
            && !names.includes(publicName('alpha', 'scoped'))
        }, 'full-mode per-tool hides to apply for Agent A')
      }
    },
    /** Activate both Agents through the host's serial creation dispatch. */
    async activate() {
      await root.parallel('agent/created', { agent: agents.a.agent, source: 'startup' })
      await root.parallel('agent/created', { agent: agents.b.agent, source: 'startup' })
      await harness.waitReady()
    },
    /** Remount the plugin exactly as a profile reload would. */
    async remount() {
      const current = pluginFibers.pop()
      await current.dispose()
      const fiber = await addPlugin()
      // The live-registry re-apply starts from the injected `agents` service.
      // Let that startup apply settle before the Agent re-created below is
      // expanded by the test, so an in-flight re-apply cannot overwrite it.
      await delay(150)
      await root.parallel('agent/created', { agent: agents.a.agent, source: 'startup' })
      await root.parallel('agent/created', { agent: agents.b.agent, source: 'startup' })
      await harness.waitReady()
      return fiber
    },
    async dispose() {
      for (const set of liveSets) {
        try { set.dispose() } catch { /* already disposed */ }
      }
      for (const fiber of pluginFibers.splice(0).reverse()) {
        try { await fiber.dispose() } catch { /* a failed mount may already be gone */ }
      }
      try { await root.fiber.dispose() } catch { /* fixture processes may already be gone */ }
      await delay(25)
      await rm(dir, { recursive: true, force: true })
    },
  }

  t.after(() => harness.dispose())
  await harness.activate()
  return harness
}

/** Ask the plugin to force a re-apply of one Agent through its preset path. */
async function requestPresetReapply(harness, agent) {
  await harness.root.parallel('agent-preset/selected', agent.session.id)
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

hostTest('environment: the installed DSH host and the package under test are the expected versions', async () => {
  assert.equal(dsh.version, DSH_VERSION)
  assert.equal(typeof dsh.Context, 'function')
  assert.equal(typeof dsh.createScope, 'function')
  assert.equal(typeof dsh.ToolsService, 'function')
  assert.equal(typeof dsh.McpClient.apply, 'function')
  assert.equal(typeof dsh.McpClient.connectionStatusOf, 'function')
  assert.notEqual(dsh.NativeExecutor, undefined, 'the native executor module is loadable')

  const packageJson = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'package.json'), 'utf8'))
  assert.equal(packageJson.name, 'dsh-skill-pool')
  assert.equal(packageJson.version, '0.5.0', 'the progressive release is 0.5.0')
})

hostTest('progressive: the initial model step offers only the discover entries, not the business tools', async (t) => {
  const h = await createHarness(t, { disclosure: 'progressive' })
  const a = h.agents.a.agent
  const b = h.agents.b.agent

  const stepA = await h.step(a)
  const stepB = await h.step(b)
  t.after(() => stepA.set.dispose())
  t.after(() => stepB.set.dispose())

  // The discover entries are the only service-facing tools in the step.
  for (const names of [stepA.names, stepB.names]) {
    assert.ok(names.includes('alpha_discover'))
    assert.ok(names.includes('beta_discover'))
    assert.equal(
      names.some((name) => name.startsWith('mcp__alpha__') || name.startsWith('mcp__beta__')),
      false,
      `no business tool is admitted before expansion: ${names.join(', ')}`,
    )
  }

  // The model-facing schema projection follows the same admission.
  for (const [step, agent] of [[stepA, a], [stepB, b]]) {
    const schemaNames = h.root.tools.schemas(agent, step.set).map((schema) => schema.name).sort()
    assert.deepEqual(schemaNames, step.names)
    assert.equal(schemaNames.some((name) => name.startsWith('mcp__')), false)
  }

  // Honest boundary: the tools are registered; progressive hides them from the
  // Agent's step, it does not remove them from the global registry.
  const registered = h.root.tools.definitions().map((definition) => definition.name)
  for (const name of BUSINESS_NAMES) assert.ok(registered.includes(name), `${name} is registered globally`)
  assert.ok(registered.includes('alpha_discover'))
  assert.ok(registered.includes('beta_discover'))

  // A direct call is refused by the installed global guard, not just absent
  // from the step view, and never reaches the fixture.
  const call = await h.call(publicName('alpha', 'search'), {}, { agent: b })
  assert.equal(call.isError, true)
  assert.match(textOf(call), /server-not-expanded/)
  assert.equal(h.guardReason(publicName('alpha', 'search'), b), 'server-not-expanded')
  assert.equal(await h.callEvents('search'), 0, 'a refused call never reached the MCP server')

  // Documented boundary: hiding tool schemas/calls leaves MCP resources and
  // server instructions untouched.
  const read = await h.call('read_mcp_resource', { server: 'alpha', uri: 'alpha://secret' }, { agent: a })
  assert.equal(read.isError, false)
  assert.ok(textOf(read).includes('ALPHA_RESOURCE_PAYLOAD'))
  const prompt = dsh.renderPrompt(await h.root.systemPrompt.assemble({ scope: a }))
  assert.ok(prompt.includes('ALPHA_INSTRUCTIONS_MARKER'), 'server instructions remain in the prompt')
  assert.ok(prompt.includes('BETA_INSTRUCTIONS_MARKER'))
})

hostTest('discover: the next step admits the original public names, and they execute', async (t) => {
  const h = await createHarness(t, { disclosure: 'progressive' })
  const a = h.agents.a.agent
  const b = h.agents.b.agent

  const before = await h.step(a)
  t.after(() => before.set.dispose())
  const staleB = await h.step(b)
  t.after(() => staleB.set.dispose())

  // The discover call is admitted by this step, exactly as the model would see it.
  const discover = await h.call('alpha_discover', {}, { agent: a, toolSet: before.set })
  assert.equal(discover.isError, false)
  const catalog = JSON.parse(textOf(discover))
  assert.equal(catalog.ok, true)
  assert.equal(catalog.service, 'alpha')
  assert.equal(catalog.expanded, true)
  assert.equal(catalog.nextStep, 'Expansion takes effect on the next model step.')
  assert.deepEqual(
    catalog.tools.map((tool) => tool.name).sort(),
    [publicName('alpha', 'change_tools'), publicName('alpha', 'search')],
    'the catalog carries only the tools this Agent may see, not the switched-off or out-of-scope ones',
  )
  assert.deepEqual(catalog.hidden, { total: 4, disabled: 1, outOfScope: 1, ambiguous: 0 })
  assert.equal(textOf(discover).includes('inputSchema'), false, 'the catalog carries summaries, never tool definitions')
  assert.equal(textOf(discover).includes('definition'), false)

  // The running step was closed before the expansion: it stays closed.
  assert.equal(namesOf(before.set, a).includes(publicName('alpha', 'search')), false)

  // The next step admits the original public names and actually executes them.
  const after = await h.step(a)
  t.after(() => after.set.dispose())
  assert.deepEqual(
    after.names.filter((name) => name.startsWith('mcp__alpha__')),
    [publicName('alpha', 'change_tools'), publicName('alpha', 'search')],
  )
  const search = await h.call(publicName('alpha', 'search'), { value: 'x' }, { agent: a, toolSet: after.set })
  assert.equal(search.isError, false)
  assert.match(textOf(search), /alpha raw=search/)
  assert.equal(await h.callEvents('search'), 1)

  // Expansion is per Agent: B's very next step still sees no alpha business tool.
  const bAfter = await h.step(b)
  t.after(() => bAfter.set.dispose())
  assert.equal(bAfter.names.some((name) => name.startsWith('mcp__alpha__')), false)
  assert.ok(bAfter.names.includes('alpha_discover'))

  // Expansion lifts only the progressive layer: the per-tool switch/scope layer
  // stays, and a direct call is still refused by the guard.
  assert.equal(after.names.includes(publicName('alpha', 'echo')), false)
  assert.equal(after.names.includes(publicName('alpha', 'scoped')), false)
  const echoCall = await h.call(publicName('alpha', 'echo'), {}, { agent: a })
  assert.equal(echoCall.isError, true)
  assert.match(textOf(echoCall), /tool-disabled/)
  const scopedCall = await h.call(publicName('alpha', 'scoped'), {}, { agent: a })
  assert.equal(scopedCall.isError, true)
  assert.match(textOf(scopedCall), /tool-disabled/)
  assert.equal(await h.callEvents('echo'), 0)
  assert.equal(await h.callEvents('scoped'), 0)

  // B's direct call to the same expanded-for-A service is still refused.
  const bCall = await h.call(publicName('alpha', 'search'), {}, { agent: b })
  assert.equal(bCall.isError, true)
  assert.match(textOf(bCall), /server-not-expanded/)
  assert.equal(await h.callEvents('search'), 1, 'only A\'s expanded call reached the fixture')
})

hostTest('full injection: per-tool switches and scope mismatches hide the tool, and the guard refuses direct calls', async (t) => {
  const h = await createHarness(t, { disclosure: 'full' })
  const a = h.agents.a.agent
  const b = h.agents.b.agent

  const stepA = await h.step(a)
  const stepB = await h.step(b)
  t.after(() => stepA.set.dispose())
  t.after(() => stepB.set.dispose())

  // Full mode registers no discover entry at all.
  assert.equal(
    h.root.tools.definitions().some((definition) => definition.name.endsWith('_discover')),
    false,
    'full injection never registers a discover entry',
  )

  assert.deepEqual(
    stepA.names.filter((name) => name.startsWith('mcp__')).sort(),
    [publicName('alpha', 'change_tools'), publicName('alpha', 'search'),
      publicName('beta', 'change_tools'), publicName('beta', 'search')],
    'A: disabled echo and mode-b scoped are absent from both services',
  )
  assert.deepEqual(
    stepB.names.filter((name) => name.startsWith('mcp__')).sort(),
    [publicName('alpha', 'change_tools'), publicName('alpha', 'scoped'),
      publicName('alpha', 'search'), publicName('beta', 'change_tools'),
      publicName('beta', 'scoped')],
    'B: beta/search is workspace-restricted to Alice; both scoped tools match mode b',
  )

  // Direct calls for hidden tools are refused by the installed guard, before
  // dispatch, and never reach a fixture.
  for (const name of [publicName('alpha', 'echo'), publicName('alpha', 'scoped')]) {
    const refused = await h.call(name, {}, { agent: a })
    assert.equal(refused.isError, true, `${name} is refused for A`)
    assert.match(textOf(refused), /tool-disabled/)
    assert.equal(h.guardReason(name, a), 'tool-disabled')
  }
  assert.equal(await h.callEvents('echo'), 0)
  assert.equal(await h.callEvents('scoped'), 0)
  assert.equal(await h.callEvents('search'), 0)

  // The tools that do pass their scope execute normally.
  const betaSearchForA = await h.call(publicName('beta', 'search'), {}, { agent: a })
  assert.equal(betaSearchForA.isError, false)
  assert.match(textOf(betaSearchForA), /beta raw=search/)
  const scopedForB = await h.call(publicName('beta', 'scoped'), {}, { agent: b, toolSet: stepB.set })
  assert.equal(scopedForB.isError, false)
  assert.equal(await h.callEvents('search'), 1)
  assert.equal(await h.callEvents('scoped'), 1)

  // B may not see beta/search (workspace) or any echo (switch), and a direct
  // call is refused by the guard.
  const hiddenForB = await h.call(publicName('beta', 'search'), {}, { agent: b })
  assert.equal(hiddenForB.isError, true)
  assert.match(textOf(hiddenForB), /tool-disabled/)
  assert.equal(await h.callEvents('search'), 1)
})

hostTest('isolation: each Agent expands its own service, and cross-service calls stay refused', async (t) => {
  const h = await createHarness(t, { disclosure: 'progressive' })
  const a = h.agents.a.agent
  const b = h.agents.b.agent

  // A expands alpha; B expands beta. Neither expansion touches the other Agent
  // or the other service.
  const stepA0 = await h.step(a)
  const stepB0 = await h.step(b)
  const discoverA = await h.call('alpha_discover', {}, { agent: a, toolSet: stepA0.set })
  const discoverB = await h.call('beta_discover', {}, { agent: b, toolSet: stepB0.set })
  stepA0.set.dispose()
  stepB0.set.dispose()
  assert.equal(discoverA.isError, false)
  assert.equal(discoverB.isError, false)

  const stepA = await h.step(a)
  const stepB = await h.step(b)
  t.after(() => stepA.set.dispose())
  t.after(() => stepB.set.dispose())
  const alphaNames = stepA.names.filter((name) => name.startsWith('mcp__alpha__'))
  const betaNamesForA = stepA.names.filter((name) => name.startsWith('mcp__beta__'))
  const betaNames = stepB.names.filter((name) => name.startsWith('mcp__beta__'))
  const alphaNamesForB = stepB.names.filter((name) => name.startsWith('mcp__alpha__'))

  assert.deepEqual(alphaNames, [publicName('alpha', 'change_tools'), publicName('alpha', 'search')])
  assert.deepEqual(betaNames, [publicName('beta', 'change_tools'), publicName('beta', 'scoped')])
  assert.deepEqual(betaNamesForA, [], 'A expanded alpha, not beta')
  assert.deepEqual(alphaNamesForB, [], 'B expanded beta, not alpha')
  assert.equal(stepA.names.includes('beta_discover'), true)
  assert.equal(stepB.names.includes('alpha_discover'), true)

  // Cross-service direct calls: the other Agent's expansion grants nothing.
  const aBeta = await h.call(publicName('beta', 'search'), {}, { agent: a })
  assert.equal(aBeta.isError, true)
  assert.match(textOf(aBeta), /server-not-expanded/)
  assert.equal(h.guardReason(publicName('beta', 'search'), a), 'server-not-expanded')
  const bAlpha = await h.call(publicName('alpha', 'search'), {}, { agent: b })
  assert.equal(bAlpha.isError, true)
  assert.match(textOf(bAlpha), /server-not-expanded/)
  assert.equal(h.guardReason(publicName('alpha', 'search'), b), 'server-not-expanded')

  // The expansions themselves still execute for their owner.
  const aAlpha = await h.call(publicName('alpha', 'search'), {}, { agent: a, toolSet: stepA.set })
  assert.equal(aAlpha.isError, false)
  const bBeta = await h.call(publicName('beta', 'scoped'), {}, { agent: b, toolSet: stepB.set })
  assert.equal(bBeta.isError, false)
  assert.equal(await h.callEvents('search'), 1, 'only A\'s alpha/search reached a fixture')
  assert.equal(await h.callEvents('scoped'), 1, 'only B\'s beta/scoped reached a fixture')
})

hostTest('dynamic registration: a tool added through tools/change stays refused on an unexpanded service', async (t) => {
  const h = await createHarness(t, { disclosure: 'progressive', registerAgents: true })
  const a = h.agents.a.agent
  const b = h.agents.b.agent
  const newName = publicName('alpha', NEW_TOOL)

  // A expands alpha so the dynamic case is tested against B, for whom alpha is
  // still unexpanded.
  const stepA0 = await h.step(a)
  const opened = await h.call('alpha_discover', {}, { agent: a, toolSet: stepA0.set })
  stepA0.set.dispose()
  assert.equal(opened.isError, false)

  // Trigger the fixture's list change without an Agent: the global guard
  // deliberately leaves Agent-less calls alone, so the probe can force a real
  // client generation swap independently of the pool's own visibility.
  const changed = await h.call(publicName('alpha', 'change_tools'), {})
  assert.equal(changed.isError, false)
  await waitFor(
    () => h.root.tools.definitions().some((definition) => definition.name === newName),
    'the newly registered alpha tool to appear in the registry',
  )
  assert.ok((await h.events()).includes('changed'), 'the fixture emitted tools/list_changed')

  // The new registration is new to the deny snapshots; whether it is visible in
  // a step before the next re-apply is the documented dynamic window. Record it
  // instead of claiming the schema never appears.
  const beforeReapply = await h.stepNames(b)
  t.diagnostic(
    `before re-apply: B's next step ${beforeReapply.includes(newName) ? 'does' : 'does not'} list ${newName}`,
  )

  // The contract: a direct call is refused by the installed guard and never
  // reaches the MCP server, even though the registration happened after
  // activation and no deny layer covers the name yet.
  const refused = await h.call(newName, {}, { agent: b })
  assert.equal(refused.isError, true)
  assert.match(textOf(refused), /server-not-expanded/)
  assert.equal(h.guardReason(newName, b), 'server-not-expanded')
  assert.equal(await h.callEvents(NEW_TOOL), 0, 'the refused call never reached the MCP server')

  // The plugin subscribes to `tools/change` and re-applies the affected live
  // Agents, so the window closes without an explicit preset replay.
  await waitFor(
    async () => !(await h.stepNames(b)).includes(newName),
    'the tools/change re-apply to cover the dynamically registered tool',
  )
  const afterReapply = await h.stepNames(b)
  assert.equal(afterReapply.includes(newName), false)
  const refusedAgain = await h.call(newName, {}, { agent: b })
  assert.equal(refusedAgain.isError, true)
  assert.match(textOf(refusedAgain), /server-not-expanded/)
  assert.equal(await h.callEvents(NEW_TOOL), 0)
})

hostTest('reconnect: a tool configured off before it registers is denied once it connects', async (t) => {
  const h = await createHarness(t, { disclosure: 'progressive', registerAgents: true })
  const a = h.agents.a.agent
  const newName = publicName('alpha', NEW_TOOL)

  // A expands alpha, so only the per-tool switch — not the progressive layer —
  // can hide the tool that reconnects below.
  const before = await h.step(a)
  const opened = await h.call('alpha_discover', {}, { agent: a, toolSet: before.set })
  before.set.dispose()
  assert.equal(opened.isError, false)

  // The user switches the still-unregistered tool off. Saving the document
  // re-applies every live Agent, which records the refusal as a dispatch fact.
  const document = JSON.parse(await readFile(h.file, 'utf8'))
  document.mcp.alpha.tools[newName] = { enabled: false, modes: [], workspaces: [] }
  await writeFile(h.file, JSON.stringify(document, null, 2))
  await requestPresetReapply(h, a)
  await waitFor(
    () => h.guardReason(newName, a) === 'tool-disabled',
    'the configured refusal to enter the guard snapshot',
  )

  // Reconnect replays the fixture's tool list: the new tool registers and the
  // host emits tools/change synchronously.
  const changed = await h.call(publicName('alpha', 'change_tools'), {})
  assert.equal(changed.isError, false)
  await waitFor(
    () => h.root.tools.definitions().some((definition) => definition.name === newName),
    'the reconnecting service to register the configured-off tool',
  )

  // The tools/change re-apply installs its `reason: 'tool'` deny layer, so the
  // expanded Agent does not see it and the guard refuses the direct call.
  await waitFor(
    async () => !(await h.stepNames(a)).includes(newName),
    'the tools/change re-apply to deny the configured-off tool',
  )
  assert.equal(h.guardReason(newName, a), 'tool-disabled')
  const refused = await h.call(newName, {}, { agent: a })
  assert.equal(refused.isError, true)
  assert.match(textOf(refused), /tool-disabled/)
  assert.equal(await h.callEvents(NEW_TOOL), 0, 'the refused call never reached the MCP server')
})

hostTest('reload: a plugin remount forgets expansions and requires a fresh discover', async (t) => {
  const h = await createHarness(t, { disclosure: 'progressive', registerAgents: true })
  const a = h.agents.a.agent

  const before = await h.step(a)
  const opened = await h.call('alpha_discover', {}, { agent: a, toolSet: before.set })
  before.set.dispose()
  assert.equal(opened.isError, false)
  const expanded = await h.stepNames(a)
  assert.ok(expanded.includes(publicName('alpha', 'search')))

  // Remount: the live Agent keeps its scope, but the activation memory (and the
  // expansion) belongs to the unloaded plugin instance.
  await h.remount()

  const after = await h.step(a)
  t.after(() => after.set.dispose())
  assert.equal(
    after.names.some((name) => name.startsWith('mcp__alpha__')),
    false,
    'the reloaded plugin does not inherit the old expansion',
  )
  assert.ok(after.names.includes('alpha_discover'), 'the discover entry is offered again')
  assert.equal(h.guardReason(publicName('alpha', 'search'), a), 'server-not-expanded')

  // Re-discovery is required and works on the reloaded instance.
  const reopened = await h.call('alpha_discover', {}, { agent: a, toolSet: after.set })
  assert.equal(reopened.isError, false)
  const next = await h.stepNames(a)
  assert.ok(next.includes(publicName('alpha', 'search')))
  const search = await h.call(publicName('alpha', 'search'), {}, { agent: a })
  assert.equal(search.isError, false)
  assert.equal(await h.callEvents('search'), 1)
})
