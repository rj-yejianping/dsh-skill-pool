# 技能池 MCP 渐进披露与逐接口开关实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `dsh-skill-pool` 增加「每服务一个 `<server>_discover` 入口 + 按需展开」的 MCP 渐进披露，以及每个 MCP 工具的单独开关与 modes/workspaces 作用域。

**Architecture:** 渐进层用现有 per-Agent `tools.restrict({deny})` 层实现初始隐藏，走 `restrict-dispose` 展开原全局工具；一个全局 `tools.guard` 按 per-Agent record 兜底拒绝未展开/池外/被逐接口关闭的工具。逐接口配置存进 `state.json` 的 `mcp.<server>.tools`，在完整与渐进两种模式下都生效。面板新增服务用途描述、AI 生成按钮、逐接口行。

**Tech Stack:** Node ESM、`node:test`、DSH 0.2.2-rc.3（`tools.register/restrict/guard/schemas`、`agentDefaultModel`、`llm.stream`、`mcpManager`）、无构建步骤的 `client.js`（`window.__ModuleLoader__`）。

**Spec:** `docs/superpowers/specs/2026-11-20-mcp-progressive-disclosure-design.md`

## Global Constraints

- 不修改 DSH 安装本身；只依赖已安装版本暴露的公开服务与事件。
- 默认完整注入；`disclosure: 'progressive'` 才启用渐进。`settings.mcpGate === false` 时渐进不注册、不隐藏。
- 逐接口配置是全局的（所有 Agent 共用），作用域按每个 Agent 的 mode/cwd 求值；`modes`/`workspaces` 语义与成员条件一致（AND，空 = 不限）。
- 不使用 `restrict({allow})` 白名单。
- 浏览器响应与 AI 生成输入不得含 `definition`、URL、headers、env、凭据。
- 未展开/池外/被关闭的 MCP 工具必须不可调用（guard）；无法证明的收益不得声称。
- 代码风格沿用现有文件：纯 ESM、JSDoc 注释、`node --check` 通过、`node:test` 测试。
- 每个任务一次提交；提交信息用 `feat:` / `test:` / `fix:` 前缀。

## Review Focus

- **Agent-less 的 MCP 调用**（没有 `exec.agent` 的程序化调用）：guard 不应拒绝，也不能因此让某个 Agent 逃过限制。
- **无法唯一归属的公开工具名**（含 `__` 歧义或 12-hex 归一化后缀）：永远不可单独配置，且继续被拒绝。
- **插件重载窗口**（旧 restrict 层已释放、`reapplyAll()` 未完成）：有 Agent 但无 record 时，所有 `mcp__*` 必须被拒。
- **离线服务的陈旧 Schema**：`mcpManager` 报未连接时 discover 必须报 `offline` 并拒绝展开，不能拿 registry 里的旧工具当成功。
- **工具消失后同名重出现**：历史配置按公开名恢复，但不能把另一个服务的同名工具套上这份配置。

---

### Task 1: 存储层 — 描述、注入模式、逐接口配置

**Files:**
- Modify: `src/store.js`（`normalizeMember`、`validateMember`、`itemExtras`、文件末尾导出区）
- Test: `test/store.test.mjs`

**Interfaces:**
- Produces:
  - `export const DISCLOSURE_MODES = ['full', 'progressive']`
  - `export function cleanDescription(raw: unknown): string` — ≤500 字符、去控制字符、trim。
  - `export function normalizeMcpTools(raw: unknown): Record<string, { enabled: boolean, modes: string[], workspaces: string[] }>`
  - `export function setMcpConfig(state: object, server: string, patch: { description?: string, disclosure?: 'full' | 'progressive' }): object`
  - `export function setMcpToolConfig(state: object, server: string, tool: string, patch: { enabled?: boolean, modes?: string[], workspaces?: string[] }): object`
  - `export function clearMcpToolConfig(state: object, server: string, tool: string): object`

- [ ] **Step 1: 写失败测试**

在 `test/store.test.mjs` 末尾追加：

```js
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
```

导入行补上 `clearMcpToolConfig, normalizeReadableState, setMcpConfig, setMcpToolConfig`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/store.test.mjs`
Expected: FAIL — `setMcpConfig is not a function` / 字段缺失。

- [ ] **Step 3: 实现**

`src/store.js`：
- 文件顶部导出 `DISCLOSURE_MODES`；实现 `cleanDescription`（`String(raw)` 仅接受字符串，剥 `[\u0000-\u001f\u007f]`，slice 500）。
- `normalizeMcpTools`：对象；键必须 `typeof string`、`startsWith('mcp__')`、长度 ≤ 128；值用 `normalizeScope` 同款字段，`enabled` 默认 true。
- `normalizeMember(kind === 'mcp')`：`member.disclosure = DISCLOSURE_MODES.includes(raw.disclosure) ? raw.disclosure : 'full'`；非空 description 才写入；非空 tools 才写入。
- `itemExtras(kind === 'mcp')`：从 provided/previous 保留 `description`、`disclosure`、`tools`（`normalizeMcpTools`）。
- `validateMember(kind === 'mcp')`：`description` 可选字符串 ≤500 且无控制字符；`disclosure` 若存在必须是枚举值；`tools` 若存在逐条校验键（`mcp__` 前缀、≤128）与值（`enabled` 布尔、modes/workspaces 列表）。
- 导出三个 mutator：`setMcpConfig`/`setMcpToolConfig`/`clearMcpToolConfig` 都通过 `normalizeState({...state, mcp: next})` 返回；未知 server 原样返回。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/store.test.mjs`
Expected: PASS（全部）。

- [ ] **Step 5: 提交**

```bash
git add src/store.js test/store.test.mjs
git commit -m "feat(store): store MCP description, disclosure mode and per-tool config"
```

---

### Task 2: 纯规则 — 逐接口作用域与 guard 判定

**Files:**
- Modify: `src/rules.js`
- Create: `src/mcp-guard.js`
- Test: `test/rules.test.mjs`

**Interfaces:**
- Produces:
  - `export function toolActive(toolConfig: object, target?: { mode?: string, cwd?: string, allModes?: boolean, allWorkspaces?: boolean }): boolean` — 复用 `itemActive`。
  - `src/mcp-guard.js`：`export function mcpGuardReason({ name, hasAgent, record })` → `string | undefined`；`record` 形状 `{ activated: boolean, gateMcp: boolean, allowedServers: Set<string>, progressiveServers: Set<string>, expandedServers: Set<string>, toolDenied: Set<string> } | undefined`。

- [ ] **Step 1: 写失败测试**

`test/rules.test.mjs` 追加：

```js
test('toolActive applies enabled and AND scope', () => {
  assert.equal(toolActive({ enabled: false }, { mode: 'standard', cwd: '/w' }), false)
  assert.equal(toolActive({ enabled: true, modes: ['standard'] }, { mode: 'fleet', cwd: '/w' }), false)
  assert.equal(toolActive({ enabled: true, modes: ['standard'] }, { mode: 'standard', cwd: '/w' }), true)
  assert.equal(toolActive({ enabled: true, modes: [], workspaces: ['/w'] }, { mode: 'standard', cwd: '/w/sub' }), true)
  assert.equal(toolActive({ enabled: true, workspaces: ['/w'] }, { mode: 'standard', cwd: '/other' }), false)
})
```

新建 `test/mcp-guard.test.mjs`：

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/rules.test.mjs test/mcp-guard.test.mjs`
Expected: FAIL — `toolActive` / `mcpGuardReason` 未导出。

- [ ] **Step 3: 实现**

- `rules.js` 末尾：

```js
export function toolActive(toolConfig, target = {}) {
  return itemActive(toolConfig, target)
}
```

- `src/mcp-guard.js`：按上面测试的判定顺序实现（`name` 非 `mcp__` 前缀 → undefined；`hasAgent === false` → undefined；record 缺失 → `'pool-not-activated'`；`toolDenied.has(name)` → `'tool-disabled'`；`gateMcp === true` 时：server 不在 `allowedServers` → `'server-not-in-pool'`，progressive 且未展开 → `'server-not-expanded'`；其余 undefined）。用 `mcpServerOf(name)` 取 server；整个过程 try/catch，异常返回 `'guard-error'`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/rules.test.mjs test/mcp-guard.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/rules.js src/mcp-guard.js test/rules.test.mjs test/mcp-guard.test.mjs
git commit -m "feat(rules): per-tool scope predicate and MCP guard decision"
```

---

### Task 3: 激活层 — deny 原因、展开、全局 guard

**Files:**
- Modify: `src/activation.js`
- Test: `test/activation-disclosure.test.mjs`（新建；用 fake ctx/tools）

**Interfaces:**
- Consumes: `toolActive`（Task 2）、`mcpGuardReason`（Task 2）。
- Produces:
  - `createActivation(...)` 返回值新增：`recordOf(agent): record | undefined`、`expandService(agent, server): { ok: true } | { ok: false, error: string }`、`progressiveAvailable: boolean`。
  - record 新增字段：`gateMcp: boolean`、`allowedServers: Set<string>`、`progressiveServers: Set<string>`、`expandedServers: Set<string>`、`toolDenied: Set<string>`。
  - disposer entry 新增：`reason: 'pool' | 'progressive' | 'tool'`、`service: string`。

- [ ] **Step 1: 写失败测试**

`test/activation-disclosure.test.mjs` 用最小 fake ctx：

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { createActivation } from '../src/activation.js'

const baseState = (over = {}) => ({
  version: 4,
  settings: { enabled: true, mcpGate: true, gateDefaultSkills: false },
  skills: {},
  sources: {},
  groups: {},
  mcp: {
    alpha: { enabled: true, modes: [], workspaces: [], disclosure: 'progressive', tools: {} },
    beta: { enabled: true, modes: [], workspaces: [], disclosure: 'full', tools: {} },
    ...over,
  },
})

function harness(state) {
  const schemas = [
    { name: 'read', description: 'read a file' },
    { name: 'mcp__alpha__search', description: 'search' },
    { name: 'mcp__alpha__read', description: 'read doc' },
    { name: 'mcp__beta__echo', description: 'echo' },
    { name: 'mcp__hidden__x', description: 'outside pool' },
  ]
  const layers = []
  let guard
  const tools = {
    schemas: () => schemas,
    register: () => () => {},
    restrict: (filter) => {
      const entry = { filter, active: true }
      layers.push(entry)
      return () => { entry.active = false }
    },
    guard: (fn) => { guard = fn; return () => {} },
  }
  const ctx = {
    get: (name) => (name === 'tools' ? tools : undefined),
    effect: (fn) => (typeof fn === 'function' ? fn() : () => {}),
    on: () => {},
    logger: { warn() {}, debug() {}, info() {} },
  }
  const activation = createActivation({ ctx, getState: async () => state, logger: ctx.logger })
  return { activation, layers, tools, getGuard: () => guard }
}

const agentOf = (id, tools) => ({
  id,
  ctx: {
    get: () => undefined,
    // The activation layer registers per-Agent restrict layers through
    // `agent.ctx.effect`; the fake must run the callback so layers are recorded.
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    tools,
  },
  session: { header: { cwd: '/w', agentPreset: 'standard' } },
})
```

测试：

```js
test('progressive service tools are denied before expansion; full service tools stay visible', async () => {
  const h = harness(baseState())
  const agent = agentOf('a1', h.tools)
  await h.activation.applyToAgent(agent)
  const denied = h.layers.filter((l) => l.active).flatMap((l) => l.filter.deny)
  assert.ok(denied.includes('mcp__alpha__search'))
  assert.ok(denied.includes('mcp__alpha__read'))
  assert.ok(denied.includes('mcp__hidden__x'))
  assert.ok(!denied.includes('mcp__beta__echo'))
})

test('expandService lifts only the progressive layers for that service', async () => {
  const h = harness(baseState())
  const agent = agentOf('a1', h.tools)
  await h.activation.applyToAgent(agent)
  assert.equal(h.activation.expandService(agent, 'alpha').ok, true)
  const denied = h.layers.filter((l) => l.active).flatMap((l) => l.filter.deny)
  assert.ok(!denied.includes('mcp__alpha__search'))
  assert.ok(denied.includes('mcp__hidden__x'))
})

test('per-tool disabled and out-of-scope tools are denied in full mode too', async () => {
  const h = harness(baseState({
    beta: {
      enabled: true, modes: [], workspaces: [], disclosure: 'full',
      tools: {
        'mcp__beta__echo': { enabled: true, modes: ['fleet'], workspaces: [] },
      },
    },
  }))
  const agent = agentOf('a1', h.tools)
  await h.activation.applyToAgent(agent)
  const denied = h.layers.filter((l) => l.active).flatMap((l) => l.filter.deny)
  assert.ok(denied.includes('mcp__beta__echo'))
})

test('the global guard rejects unexpanded, then allows after expansion', async () => {
  const h = harness(baseState())
  const agent = agentOf('a1', h.tools)
  await h.activation.applyToAgent(agent)
  const guard = h.getGuard()
  assert.equal(guard({ name: 'mcp__alpha__search', agent }), 'server-not-expanded')
  h.activation.expandService(agent, 'alpha')
  assert.equal(guard({ name: 'mcp__alpha__search', agent }), undefined)
  assert.equal(guard({ name: 'mcp__hidden__x', agent }), 'server-not-in-pool')
})

test('an agent with no activation record is denied by the global guard', () => {
  const h = harness(baseState())
  assert.equal(h.getGuard()({ name: 'mcp__beta__echo', agent: agentOf('cold', h.tools) }), 'pool-not-activated')
})
```

（`harness` 返回的 `tools` 要同时被 `ctx.get('tools')` 和 `agent.ctx.tools` 使用；上面的 `agentOf(id, tools)` 负责后者。）

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/activation-disclosure.test.mjs`
Expected: FAIL — `expandService` 未定义 / deny 不含 alpha。

- [ ] **Step 3: 实现**

`src/activation.js`：
- 创建 record 的字段集补上新 Set/布尔。
- `applyNow` 里 `progressiveServers = progressiveAvailable ? new Set(pool.mcpServers.filter((n) => state.mcp?.[n]?.disclosure === 'progressive')) : new Set()`；`allowedServers = new Set(pool.mcpServers)`；`gateMcp = pool.gateMcp`。
- deny 计算改为携带原因：ambiguous → `pool`；不在 `allowedServers` → `pool`；`toolDenied` 判定（`toolActive(state.mcp[server].tools[name], { mode, cwd }) === false`）→ `tool`；progressive 且未展开 → `progressive`。每个 entry 写入 `{ label: 'mcp-restrict', reason, service, deny: [name] }`。
- `record.toolDenied` 在每次计算时重建为 tool 原因集合。
- `record.expandedServers` 保留：`new Set([...record.expandedServers].filter((s) => progressiveServers.has(s)))`。
- `expandService`：校验 record/activated、`progressiveServers.has(server)`，只 dispose `reason === 'progressive' && service === server` 的层并加入 `expandedServers`。
- 全局 guard：在 `createActivation` 内 `try { ctx.effect(() => ctx.tools.guard((exec) => mcpGuardReason({ name: exec?.name, hasAgent: exec?.agent !== undefined && exec?.agent !== null, record: agents.get(exec?.agent) })), 'resource-pool.mcp-guard') } catch { progressiveAvailable = false; logger?.warn?.(...) }`；`progressiveAvailable` 为 false 时 `progressiveServers` 为空（渐进不生效）。
- `signatureOf` 增加 `disc`（每个 pool 服务的 disclosure 与 tools JSON）与 `expanded`，保证配置变化重新 apply。
- 返回值加 `recordOf: (agent) => agents.get(agent)`、`expandService`、`progressiveAvailable`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/activation-disclosure.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/activation.js test/activation-disclosure.test.mjs
git commit -m "feat(activation): progressive MCP deny layers, expansion and global guard"
```

---

### Task 4: 发现控制器 — 命名、注册、discover 语义

**Files:**
- Create: `src/disclosure.js`
- Test: `test/disclosure.test.mjs`

**Interfaces:**
- Consumes: `recordOf`/`expandService`（Task 3）、`mcpServerOf`/`isAmbiguousMcpToolName`（rules）、`toolActive`。
- Produces:
  - `export function deriveDiscoverName(server: string): { name: string, error: '' | 'empty' | 'invalid' }`
  - `export function createMcpDisclosure({ ctx, logger, getState, recordOf, expandService, modeOf, workspaceOf, enabled, defineTool }): { sync(state: object): void, dispose(): void }`

  `sync` 为同步：注册/注销 `<server>_discover`；`when(context)` 读 `recordOf`；`execute` 见下。
  `defineTool` 由 `index.js` 注入真实的 `@deepseek-ai/dsh-tools` 版本（本仓库没有该依赖，
  测试里省略时用 `(def) => def` 恒等实现，保证 `src/disclosure.js` 可被 Node 单测直接导入）。

- [ ] **Step 1: 写失败测试**

`test/disclosure.test.mjs`：

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { createMcpDisclosure, deriveDiscoverName } from '../src/disclosure.js'

test('deriveDiscoverName sanitizes server names and refuses empty ones', () => {
  assert.deepEqual(deriveDiscoverName('openviking'), { name: 'openviking_discover', error: '' })
  assert.deepEqual(deriveDiscoverName('My KB'), { name: 'my_kb_discover', error: '' })
  assert.deepEqual(deriveDiscoverName('***'), { name: '', error: 'empty' })
})
```

控制器测试用 fake：

```js
const state = {
  settings: { enabled: true, mcpGate: true },
  mcp: {
    alpha: { enabled: true, disclosure: 'progressive', description: '知识库', tools: { 'mcp__alpha__read': { enabled: false } } },
    beta: { enabled: true, disclosure: 'full' },
  },
}
const record = {
  activated: true,
  gateMcp: true,
  allowedServers: new Set(['alpha']),
  progressiveServers: new Set(['alpha']),
  expandedServers: new Set(),
  toolDenied: new Set(['mcp__alpha__read']),
}
const registered = new Map()
let expanded = []
const ctx = {
  get: () => undefined,
  effect: (fn) => (typeof fn === 'function' ? fn() : () => {}),
  tools: {
    schemas: () => [
      { name: 'mcp__alpha__search', description: 'search docs' },
      { name: 'mcp__alpha__read', description: 'read docs' },
    ],
    register: (def) => {
      registered.set(def.name, def)
      return () => registered.delete(def.name)
    },
  },
}
const controller = createMcpDisclosure({
  ctx,
  getState: async () => state,
  recordOf: () => record,
  expandService: (agent, server) => { if (!record.progressiveServers.has(server)) return { ok: false, error: 'not-in-pool' }; record.expandedServers.add(server); expanded.push(server); return { ok: true } },
  modeOf: () => 'standard',
  workspaceOf: () => '/w',
  enabled: () => true,
})
controller.sync(state)
```

测试项（逐个 test）：
1. `sync registers only progressive services` — `registered.has('alpha_discover') === true`，`registered.has('beta_discover') === false`。
2. `sync unregisters a service switched back to full` — 再次 `controller.sync({...state, mcp:{...state.mcp, alpha:{...state.mcp.alpha, disclosure:'full'}}})` 后 `registered.has('alpha_discover') === false`。
3. `discover expands and returns only allowed tools` — `await registered.get('alpha_discover').execute({}, { agent: {} })` 返回 `ok:true`、`tools` 只含 search（read 被 `toolDenied` 排除）、`expanded:true`，且 `expanded` 数组包含 alpha。
4. `discover refuses when not in pool` — record.progressiveServers 清空后返回 `{ok:false, error:'not-in-pool'}`。
5. `name conflict refuses registration` — 服务名 `open viking` 与已有工具 `open_viking_discover`（`ctx.tools.schemas()` 加入该名）→ `registered.has(...) === false`，`sync` 不抛错。

（测试里 `record.toolDenied` 用 `new Set(['mcp__alpha__read'])`；`execute` 的 `agent` 用任意对象，recordOf 恒返回 record。）

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/disclosure.test.mjs`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

`src/disclosure.js`：
- `deriveDiscoverName`：小写、`[^a-z0-9_]+` → `_`、折叠 `_`、去首尾；结果为空或长度 > 64 → `{name:'', error:'empty'}`。
- `createMcpDisclosure`：内部 `Map<server, {dispose, name}>`；`const make = typeof defineTool === 'function' ? defineTool : (def) => def`。
- `sync(state)`：目标服务 = `settings.mcpGate !== false` 且 `member.enabled !== false` 且 `disclosure === 'progressive'`；`enabled()` 为 false 时目标为空。对每个目标：派生名；冲突检查（`ctx.tools.schemas()` 现有名字 + 其他目标名）；冲突记录失败原因（`logger?.warn`）并跳过。新增注册用 `defineTool({ name, description, parameters: {}, output, execute })` 与 `ctx.effect(() => ctx.tools.register(def, { when }), 'resource-pool.discover:' + server)`；移除的 dispose。
- `description`：`${member.description || 通用句}\n\nCall this tool to reveal the MCP tools of server "<server>" for this session. Expansion takes effect on the next model step and grants no extra permission.`
- `when`：`recordOf(context?.agent)` 存在且 `activated && gateMcp && progressiveServers.has(server)`。
- `execute`：按 spec §3 检查 record/池/离线（`ctx.get('mcpManager')?.list()` 中 `view.name === server` 且 `view.status?.state !== 'connected'` → `offline`）；读 `tools.schemas()` 筛 `mcpServerOf(name) === server && !isAmbiguousMcpToolName(name)`；`allowed = names.filter(n => !record.toolDenied.has(n))`；空 → `no-tools`；否则 `expandService(agent, server)`，失败返回错误，成功返回 `{ ok:true, service, description, expanded:true, tools: allowed.map(n => ({ name:n, summary })), hidden:{total, disabled, outOfScope, ambiguous}, nextStep }`。所有异常包成 `{ok:false, error:'tools-unavailable'}`。
- `dispose`：dispose 全部注册。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/disclosure.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/disclosure.js test/disclosure.test.mjs
git commit -m "feat(disclosure): per-service discover tools with expansion semantics"
```

---

### Task 5: Web API — 投影、配置、逐接口、工具列表

**Files:**
- Modify: `src/web-api.js`（`publicMcpMember`、routes 数组、新 handler、helper 导出）
- Test: `test/web-api-mcp.test.mjs`（新建；用 `StateStore` 临时目录 + fake ctx）

**Interfaces:**
- Consumes: 存储 mutator（Task 1）、`mcpServerOf`/`isAmbiguousMcpToolName`。
- Produces:
  - `publicMcpMember` 投影 `description`、`disclosure`、`tools`。
  - `POST /mcp/config`、`POST /mcp/tool`、`GET /mcp/tools`。

- [ ] **Step 1: 写失败测试**

`test/web-api-mcp.test.mjs`：构造临时 `StateStore`（参考 `test/store.test.mjs` 的 `mkdtemp` 用法），写一份含 alpha 服务的文档；fake `ctx` 提供 `get('tools').schemas()` 返回 `mcp__alpha__search`/`mcp__alpha__read`；通过 `registerWebApi` 拿到路由（或直接调用导出的 handler 若实现时导出）。测试：

```js
test('public projection keeps config and drops the connection definition', () => {
  const view = publicMcpMember({ enabled: true, modes: [], workspaces: [], description: 'd', disclosure: 'progressive', tools: {}, definition: { url: 'http://secret', headers: { Authorization: 'x' } } })
  assert.equal(view.description, 'd')
  assert.equal(view.disclosure, 'progressive')
  assert.equal(view.definition, undefined)
  assert.equal(JSON.stringify(view).includes('secret'), false)
})

test('GET /mcp/tools lists current tools plus preserved history', async () => {
  const { call } = await apiHarness()
  const payload = await call('GET', '/mcp/tools?server=alpha')
  assert.equal(payload.ok, true)
  const names = payload.tools.map((t) => t.name)
  assert.ok(names.includes('mcp__alpha__search'))
  assert.ok(names.includes('mcp__alpha__read'))
  assert.equal(payload.tools.find((t) => t.name === 'mcp__alpha__search').registered, true)
})

test('POST /mcp/tool saves and clears one tool config', async () => {
  const { call } = await apiHarness()
  const saved = await call('POST', '/mcp/tool', { server: 'alpha', tool: 'mcp__alpha__search', enabled: false, modes: ['standard'] })
  assert.equal(saved.ok, true)
  assert.equal(saved.state.mcp.alpha.tools['mcp__alpha__search'].enabled, false)
  const cleared = await call('POST', '/mcp/tool', { server: 'alpha', tool: 'mcp__alpha__search', clear: true })
  assert.equal(cleared.state.mcp.alpha.tools['mcp__alpha__search'], undefined)
})

test('POST /mcp/tool refuses an unattributable tool name', async () => {
  const { call } = await apiHarness()
  const payload = await call('POST', '/mcp/tool', { server: 'alpha', tool: 'mcp__beta__x', enabled: false })
  assert.equal(payload.ok, false)
})

test('POST /mcp/config validates disclosure and description', async () => {
  const { call } = await apiHarness()
  const bad = await call('POST', '/mcp/config', { server: 'alpha', disclosure: 'later' })
  assert.equal(bad.ok, false)
  const ok = await call('POST', '/mcp/config', { server: 'alpha', disclosure: 'progressive', description: '知识库' })
  assert.equal(ok.state.mcp.alpha.description, '知识库')
})
```

（`apiHarness`：`registerWebApi` 返回 `{ routes }`，元素为 `[suffix, methods, handler]`；测试用
`routes.find(([suffix]) => suffix === '/mcp/tool')[2]` 取 handler，用
`{ json: async () => body, url: 'http://x/dsh-skill-pool/mcp/tool' }` 调用。现有调用方忽略返回值，
不影响运行。）

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/web-api-mcp.test.mjs`
Expected: FAIL — 路由 404 / 字段缺失。

- [ ] **Step 3: 实现**

- `publicMcpMember`：允许列表补 `description`（字符串默认 `''`）、`disclosure`（默认 `'full'`）、`tools`（深拷贝，缺省 `{}`）。
- `/mcp/config`：`server` 必须存在；`description` 字符串 ≤500 无控制字符（可复用 store 的 `cleanDescription` + 显式校验拒绝非法）；`disclosure` ∈ 枚举；`store.update((s) => setMcpConfig(s, server, patch))`；返回 `committed`。
- `/mcp/tool`：`clear: true` → `clearMcpToolConfig`；否则校验 `enabled` 布尔、`strictModes`/`strictWorkspaces`，工具名必须能归属到 server（`mcpServerOf(tool) === server && !isAmbiguousMcpToolName(tool)`）或已存在于 `member.tools`；`store.update((s) => setMcpToolConfig(...))`。
- `/mcp/tools`：`readState()` + `ctx.get('tools')?.schemas()`；返回 `{ ok:true, server, description, disclosure, tools }`，每项 `{ name, summary, registered: boolean, config: {...}|null, ambiguous: boolean }`；历史条目 `registered:false`；`tools` 不可用 → 500 failure。
- `registerWebApi` 返回 `{ routes }`（内部同一数组），供 Node 测试直接调用 handler；现有调用方不依赖返回值。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/web-api-mcp.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/web-api.js test/web-api-mcp.test.mjs
git commit -m "feat(web-api): MCP description, disclosure and per-tool config endpoints"
```

---

### Task 6: Web API — AI 生成描述

**Files:**
- Modify: `src/web-api.js`
- Test: `test/web-api-describe.test.mjs`

**Interfaces:**
- Produces: `POST /mcp/describe { server, language? }`；`export function buildDescribePrompt({ server, tools, language })`（纯函数，便于测试）。

- [ ] **Step 1: 写失败测试**

```js
test('buildDescribePrompt includes tool names, not connection data', () => {
  const prompt = buildDescribePrompt({ server: 'alpha', language: 'zh', tools: [{ name: 'mcp__alpha__search', description: 'search docs' }] })
  assert.ok(prompt.user.includes('mcp__alpha__search'))
  assert.ok(prompt.user.includes('search docs'))
  assert.equal(prompt.user.includes('http'), false)
  assert.ok(prompt.system.includes('1–2'))
})

test('describe refuses without a default model', async () => {
  const payload = await describeHarness({ llm: undefined, selection: undefined })
  assert.equal(payload.ok, false)
  assert.equal(payload.error, 'no-default-model')
})

test('describe returns generated text and never saves it', async () => {
  const payload = await describeHarness({
    llm: { stream: async function* () { yield { type: 'text-delta', text: '用于检索知识库。' } } },
    selection: { provider: 'p', model: 'm' },
  })
  assert.equal(payload.ok, true)
  assert.equal(payload.description, '用于检索知识库。')
})
```

（`describeHarness` 用 fake `ctx.get('llm')`/`get('agentDefaultModel')` 调 handler。）

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/web-api-describe.test.mjs`
Expected: FAIL — handler/构建函数不存在。

- [ ] **Step 3: 实现**

- `buildDescribePrompt`：system 中文/英文按 `language`；user 列出 `- <name>: <description>`（总字符预算 8 KB）。
- handler：读 state（fail-closed）；服务存在；`ctx.get('tools')` 筛该服务工具；空 → `{ok:false,error:'no-tools'}`；`llm`/`agentDefaultModel` 缺失 → `no-llm`/`no-default-model`；`selection = currentSelection()`；`AbortController` + 30 s 定时器；`for await` 收集 `text-delta`；`maxTokens: 200`；超时 → `timeout`；返回 `{ok:true, description}`。错误只返回代码与短消息，不落日志敏感内容。
- 路由 `['/mcp/describe', ['POST'], guarded(describeRoute)]`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/web-api-describe.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/web-api.js test/web-api-describe.test.mjs
git commit -m "feat(web-api): generate MCP purpose summary with the default model"
```

---

### Task 7: 面板 — 描述、注入开关、逐接口行

**Files:**
- Modify: `client.js`（`normalizeEntry`、`blankEntry`、`boardState` 暴露、`renderItemRow`、`renderGroup(MCP)` 附近新增 `renderMcpToolRows`）
- Test: `test/panel-state.test.mjs`、`test/panel-render.test.mjs`

**Interfaces:**
- Consumes: `POST /mcp/config`、`POST /mcp/tool`、`GET /mcp/tools`（Task 5/6）。
- Produces（`boardState` 新增，供测试）：
  - `normalizeMcpTools(raw): Record<string, {enabled, modes, workspaces}>`
  - `buildToolSaveBody(server, tool, draft): object`（`clear` 为 true 时只带 `{server, tool, clear: true}`）

- [ ] **Step 1: 写失败测试**

`test/panel-state.test.mjs`：

```js
test('normalizeEntry keeps MCP description, disclosure and tool config', () => {
  const entry = client.boardState.normalizeEntry({
    enabled: true, modes: [], workspaces: [],
    description: '知识库', disclosure: 'progressive',
    tools: { 'mcp__a__x': { enabled: false, modes: ['standard'], workspaces: ['/w'] } },
  })
  assert.equal(entry.description, '知识库')
  assert.equal(entry.disclosure, 'progressive')
  assert.deepEqual(entry.tools['mcp__a__x'], { enabled: false, modes: ['standard'], workspaces: ['/w'] })
  assert.deepEqual(entry.tools['mcp__a__missing'], undefined)
})

test('buildToolSaveBody sends clear or the full draft', () => {
  assert.deepEqual(client.boardState.buildToolSaveBody('alpha', 'mcp__alpha__x', { enabled: false, modes: ['standard'] }), {
    server: 'alpha', tool: 'mcp__alpha__x', enabled: false, modes: ['standard'], workspaces: [],
  })
  assert.deepEqual(client.boardState.buildToolSaveBody('alpha', 'mcp__alpha__x', { clear: true }), {
    server: 'alpha', tool: 'mcp__alpha__x', clear: true,
  })
})
```

`test/panel-render.test.mjs` 增加 smoke：渲染含一个 MCP 行的 board，断言输出包含 `TEXT.cardMcp` 与工具块标题（具体文本由实现定，测试在实现后按常量补；先写 `assert.ok(html.includes('工具'))` 之类的目标文案，并在实现里固定该文案）。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/panel-state.test.mjs test/panel-render.test.mjs`
Expected: FAIL — 字段/辅助函数缺失。

- [ ] **Step 3: 实现**

- `normalizeEntry` / `blankEntry`：补 `description: ''`、`disclosure: 'full'`、`tools: {}`，并用 `normalizeMcpTools` 清洗。
- 新增 `renderMcpToolRows(server, entry)`：折叠块；行内容 = 工具名、开关（Toggle）、modes/workspaces 选择器（复用现有 scope 编辑器组件）、不可用标记；数据来自 `GET /mcp/tools?server=`（按需加载，失败显示错误）。
- `renderItemRow` 的 MCP 分支追加：描述输入框（textarea，≤500）、「AI 生成」按钮（调 `/mcp/describe`，成功填入草稿）、`完整注入/渐进注入` 开关（调 `/mcp/config`）、逐接口块。
- 保存统一走 `queueItem` 风格的新 `queueToolSave(server, tool, draft)`，串行写。
- `boardState` 暴露 `normalizeMcpTools`、`buildToolSaveBody`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/panel-state.test.mjs test/panel-render.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add client.js test/panel-state.test.mjs test/panel-render.test.mjs
git commit -m "feat(panel): MCP description, disclosure switch and per-tool rows"
```

---

### Task 8: 主入口接线与生命周期

**Files:**
- Modify: `index.js`
- Test: `test/plugin-lifecycle.probe.mjs`（host-bound；若不可用，至少 `node --check` + 手工验证）

**Interfaces:**
- Consumes: `createActivation`（Task 3）、`createMcpDisclosure`（Task 4）。

- [ ] **Step 1: 接线**

`index.js`：
- `const disclosure = createMcpDisclosure({ ctx, logger, getState, recordOf: activation.recordOf, expandService: activation.expandService, modeOf: (agent) => modeOf(ctx, agent), workspaceOf: (agent) => workspaceOf(agent), enabled: () => activation.progressiveAvailable, defineTool })`
- 启动时 `void (async () => { try { disclosure.sync(await getState()) } catch (e) { logger?.warn?.(...) } })()`
- `registerWebApi` 的 `onChanged` 改为 `async () => { const result = await activation.reapplyAll(); try { disclosure.sync(await getState()) } catch { /* 已记录 */ } return result }`
- `ctx.effect(() => () => { disclosure.dispose(); activation.disposeAll() }, 'resource-pool.lifecycle')`
- 保持 `agent/created`/`agent/disposed`/`agent-preset/selected` 现有接线不变；`disposeAgent` 仍清理 record（展开状态随之丢弃）。

- [ ] **Step 2: 静态检查**

Run: `npm run lint`
Expected: PASS（新增 `src/disclosure.js`、`src/mcp-guard.js` 加进 lint 脚本）。

- [ ] **Step 3: 全量单测**

Run: `npm test`
Expected: PASS（全部 portable 测试）。

- [ ] **Step 4: 提交**

```bash
git add index.js package.json
git commit -m "feat: wire MCP disclosure controller into plugin lifecycle"
```

（`package.json` 的 lint 脚本加两个新文件检查。）

---

### Task 9: host-bound 探针、文档与发布

**Files:**
- Create: `test/mcp-progressive.probe.mjs`
- Modify: `test/verify-feasibility.mjs`、`package.json`（脚本）、`README.md`、`package.json`（version → `0.5.0`）

**Interfaces:**
- Produces: `npm run verify:progressive`（host-bound；缺运行时时明确 skip/fail，不冒充通过）。

- [ ] **Step 1: 写探针**

按 spec「host-bound 验证」实现，至少覆盖：
- progressive 下 `tools.resolve` 初始不含业务工具；
- `alpha_discover` 调用后下一步出现原名工具并可调用；
- 逐接口关闭/作用域不匹配在完整/渐进下都不出现、直接调用被 guard 拒；
- A/B 各自展开互不影响；
- 未展开服务的 guard 拒绝覆盖 `tools/change` 新注册工具。

探针自建隔离环境（临时 state、两个 stdio fixture、真实 `dsh-tools`/`dsh-scope`），不碰用户 profile。

- [ ] **Step 2: 运行**

Run: `DSH_FEASIBILITY_REQUIRED=1 node --test test/mcp-progressive.probe.mjs`
Expected: PASS（已装 0.2.2-rc.3）。

- [ ] **Step 3: 版本与文档**

- `package.json` `version: "0.5.0"`；scripts 增加 `test:progressive`、`verify:progressive`。
- `README.md` 增加「渐进注入 / 逐接口开关 / 已知边界」小节（中文 + 英文摘要），写明 resources/instructions 不覆盖、展开 per-Agent、重启后重新发现。
- `CONTRACTS-v3.md` 增补 v5 字段说明（`description`、`disclosure`、`tools`）与三个新路由。

- [ ] **Step 4: 打包与安装（部署动作单独确认）**

```bash
npm run lint && npm test
npm pack
```

安装前备份 `/root/.dsh/resource-pool/state.json`；用插件管理入口 `install_bundle` 装 tarball；重启/重载后验证设置页与 discover。部署属于破坏性动作，执行前向用户报告影响并等待确认。

- [ ] **Step 5: 提交**

```bash
git add test/mcp-progressive.probe.mjs test/verify-feasibility.mjs package.json README.md CONTRACTS-v3.md
git commit -m "feat: progressive MCP probe, docs and 0.5.0"
```

---

## Self-Review 检查（已执行）

- 规格覆盖：存储/命名/发现/展开/guard/逐接口/离线/mcpGate/面板/失败降级/验证 → 均有任务。
- Review Focus 五项：agent-less（Task 2）、ambiguous（Task 2/4/5）、重载窗口（Task 3）、离线（Task 4）、同名重现（Task 1/5）。
- 类型一致：`expandService`、`recordOf`、`sync`、`setMcpConfig`、`setMcpToolConfig`、`toolActive`、`mcpGuardReason` 在计划中名称统一。
- 未把 `definition` 放进浏览器响应或 AI 输入。
