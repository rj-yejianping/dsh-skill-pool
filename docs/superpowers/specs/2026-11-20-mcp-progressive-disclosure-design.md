# 技能池 MCP 渐进披露与逐接口开关设计

日期：2026-11-20
状态：已批准（2026-11-20，用户确认）
范围：`dsh-skill-pool`（0.4.1 → 0.5.0），运行在 DSH 0.2.2-rc.3

## 意图

技能池里的 MCP 服务现在把连接的全部工具 Schema 一次性注入每个会话。工具多的服务
（如知识库）会一直占着上下文，而多数会话并不用它。本次改动：

1. 每个 MCP 服务可以单独选择「渐进注入」：会话里先只出现一个 `<server>_discover` 入口，
   其描述词由用户手填或由当前默认模型生成；模型决定用它时调用入口，才展开该服务的其余工具。
2. 每个 MCP 服务下的**单个工具**可以单独开关，并单独设置 Agent 模式/工作区作用域；
   被关闭或作用域不匹配的工具在完整注入和渐进注入下都不可见、不可调用。

用户已确认的决定：

1. **每个 MCP 服务一个入口**，名字 `<server>_discover`（服务名规范化后派生）。
2. **默认完整注入**（与现状一致）；每个服务卡片上有开关切到渐进注入。
3. 描述词：设置页手填优先；另有「AI 生成」按钮，用**当前默认模型**
   （`agentDefaultModel.currentSelection()`）按该服务的实时工具清单生成短描述。
4. 调用 discover 即展开该服务**全部**工具（指其中对该 Agent 允许的工具），下一步模型请求生效。
5. 展开状态只属于当前 Agent，Agent 结束清零，不跨会话、不持久化。
6. 逐接口开关是全局配置（所有 Agent 共用），但每个接口的 modes/workspaces 作用域按
   Agent 求值；它与渐进展开是两层，互不替代。

## 目标与非目标

目标：

- 渐进模式下，未展开服务的业务工具不出现在模型请求的 Schema 里（deny 层）。
- 未展开服务的工具**不可调用**（guard 兜底），即使 deny 快照没来得及覆盖。
- 单个工具可关闭或限定 modes/workspaces；两种注入模式下都不可见、不可调用。
- 展开只影响调用它的 Agent：父子、兄弟 Agent 互不影响，展开不授予任何新权限。
- 完整注入模式的现有行为、池内/池外 gate、技能过滤、失败关闭语义全部不变。

非目标：

- 不改 DSH 底层 MCP 客户端或工具注册接口。
- 不隐藏 MCP resources、server instructions（见「已知边界」，如实说明）。
- 不做按工具粒度的展开、不做跨会话记忆、不做「收起」。
- 不重写现有池内/池外 MCP gate；渐进是 gate 之上的一个附加层。

反目标（做了就算失败）：

- 用 allow 白名单实现（会连带隐藏后来动态注册的非 MCP 工具）。
- 把 discover 展开说成「授权」或「资源隔离」。
- 在状态不可读/工具清单不可得时假装展开成功或放开 deny。
- 静默覆盖同名工具或改服务名。

## 方案比较

### 选定：deny 初始隐藏 + discover 撤层 + guard 兜底

- 对 progressive 服务的每个已注册 `mcp__<server>__*` 工具注册一条
  `agent.ctx.tools.restrict({ deny: [name] })` 层（沿用现有 activation.js 的
  per-Agent 限制写法）。
- 调用 discover 时，只 dispose 该服务对应的 deny 层，下一步可见；原全局工具直接复活，
  不重新注册、不改名。
- 同时注册**全局** `tools.guard`：拒绝「池外服务」和「未展开的 progressive 服务」的
  `mcp__*` 调用。guard 在派发前运行，覆盖新注册工具在 deny 更新前出现的窗口，也覆盖
  插件重载时旧层已释放、重新 apply 还没跑完的窗口。

可行性依据：`docs/mcp-feasibility-results.md` 的 #6（restrict-dispose 展开原工具、
A/B 隔离）、#8/#9（迁移前 guard/restrict 在派发阶段单调拒绝）、#11（同步
`tools/change` 重入需要 caller guard）。技能池已经用同一套 restrict 层做池内/池外 gate，
本次是同一机制的扩展。

### 否决的备选

| 备选 | 为什么不行 |
| --- | --- |
| 只做 deny-dispose，无 guard | 新连接/重连后注册的工具在 deny 更新前可见**且可调用**（实验 #12 起的动态窗口）。 |
| allow 白名单 | `restrict({allow})` 只保留列出的名字，会把随后动态注册的**非 MCP** 工具一并隐藏，破坏其他插件。 |
| 给 MCP 工具加 `when` 条件 | 技能池不拥有这些注册，改不了；只能通过 restrict/guard 影响可见性。 |
| 改 DSH 底层暴露 MCP 动态注册钩子 | 用户已排除扩展底层；版本/回滚面扩大。 |

## 行为规格

### 1. 存储字段

`state.json` 的 `mcp.<server>` 成员新增（`store.js` 的 normalize/validate 同时改）：

- `description: string`，默认 `''`；长度上限 500 字符；只允许纯文本（拒绝控制字符）。
- `disclosure: 'full' | 'progressive'`，默认 `'full'`。旧文档缺这两个字段时按默认补齐；
  读取不因字段缺失失败，写入保留用户值。
- `tools: { <public tool name>: { enabled: boolean, modes: string[], workspaces: string[] } }`，
  默认空对象。条目缺省 = 启用且不限作用域；`modes`/`workspaces` 语义与成员条件一致
  （AND，空表示不限）。工具键必须是合法的 `mcp__<server>__*` 公开名，长度受限；无法唯一
  归属到该服务的键拒绝保存。历史条目在工具暂时消失时保留（面板标记「不可用」），
  重新出现且公开名一致时恢复；服务删除时随成员一起删除。

`description` 与连接 `definition`（URL/headers/env）分开存储；面板响应只投影面板需要的
字段，不把 `definition`/`headers` 返回浏览器（沿用 0.4.1 的投影规则）。`publicMcpMember`
增加投影 `description`、`disclosure`。

接口（沿用现有 `/item` 之外的独立路由，避免把连接定义混进通用 patch）：

- `POST /mcp/config {server, description?, disclosure?}`：串行化 `store.update`，只改这两个
  字段，保留 `definition`/scope/`installedAt`；`server` 必须是已有成员。
- `POST /mcp/tool {server, tool, enabled?, modes?, workspaces?}`：串行化保存单个工具的配置；
  `tool` 必须是当前可唯一归属到 `server` 的公开名（或已存在的历史条目）；空数组表示清除。
- `GET /mcp/tools?server=`：返回该服务当前注册的工具（公开名、描述摘要、是否可唯一归属、
  当前配置），供面板渲染逐接口行；不返回连接定义。
- `POST /mcp/describe {server}`：见 §5。

### 2. 入口注册

- 渐进只在 MCP 门控生效时有效：`settings.mcpGate !== false` 且池内有 MCP 成员。门控关闭时
  不注册 discover、不按服务隐藏，面板在渐进开关旁提示「MCP 门控已关闭，渐进注入不生效」。
  理由：门控关闭的语义是「完全不干预 MCP」，渐进不能反过来偷偷隐藏。
- 池内每个 `disclosure === 'progressive'` 的服务注册一个全局工具
  `<server>_discover`，`ctx.effect(() => ctx.tools.register(def, { when }), label)`。
- `when(context)`：同步、无副作用、不抛错；`true` 当且仅当 `context.agent` 是活 Agent、
  该服务在当前 Agent 的 `pool.mcpServers` 里、且该服务对此 Agent 是 progressive
  （用 activation 维护的 per-Agent record；record 缺失或状态不可读一律 `false`）。
- 名称规范化：服务名转小写，非 `[a-z0-9_]` 替换为 `_`，折叠连续 `_`，去首尾 `_`；
  结果为空、以数字开头、超过平台长度上限，或与当前全局工具重名（含其他池服务的
  discover 名）时，**不注册并记录失败原因**，面板对应服务卡显示「发现入口不可用：名称冲突」。
  不做静默改名。
- 工具定义：`parameters` 为空对象；`description` 为用户描述的模板化拼接（见 §5）；
  `execute` 走 §3。

### 3. discover 语义

调用即展开（幂等）：

```
{ ok: true, service, description, expanded: true,
  tools: [{ name: '<public tool name>', summary: '<前 200 字符描述>' }],
  nextStep: 'Expansion takes effect on the next model step.' }
```

- 只返回**当前 Agent 有权使用**的服务的目录；先校验池解析结果，再读 `tools.schemas()`
  中该服务名字前缀的条目。目录里只列「启用且 modes/workspaces 匹配该 Agent」的工具；
  被逐接口开关关掉、作用域不匹配或无法唯一归属（`isAmbiguousMcpToolName`）的工具不列出，
  只返回被省略的数量分类（如 `hidden: {disabled, outOfScope, ambiguous}`），不列名字。
- 离线判断优先用 `ctx.get('mcpManager')`（可选依赖）：有该服务条目且状态不是已连接 →
  `{ok:false, error:'offline', service}`。manager 不可用或没有该条目时，退化为「registry
  里有没有该服务的工具」：有工具视为可展开，没有则 `{ok:false, error:'no-tools', service}`。
  这两种失败都**不改变 deny 层**，也不把空目录/旧目录当成功。
- 服务未启用、不在本 Agent 池内或已切回完整注入：`{ok:false, error:'not-in-pool'}`；
  不展开、不泄露工具名。
- 状态不可读：`{ok:false, error:'state-unavailable'}`；不放宽任何限制。
- 工具清单读取抛错：`{ok:false, error:'tools-unavailable'}`。
- record 缺失（Agent 尚未激活）：discover 的 `when` 为 `false`，工具不会出现；若在
  record 被清掉后仍被调用，按 `state-unavailable` 拒绝。
- 返回体不得包含连接定义、headers、env、URL 或资源载荷。

### 4. 初始隐藏与展开

- 渐进服务：`applyToAgent` 计算 deny 时，除「池外服务」外，把「本 Agent 尚未展开的
  渐进服务」的已注册工具也加入 deny。每个工具一条 restrict 层，层上带
  `service` 与 `reason: 'pool' | 'progressive' | 'tool'` 标记，便于按原因/服务 dispose。
- 逐接口层（`reason: 'tool'`）：对池内服务的每个公开工具，若配置存在且（`enabled === false`
  或 modes/workspaces 不匹配该 Agent）→ deny。**完整注入和渐进注入都生效**；展开不解除
  这层。未配置的新工具默认启用、不限作用域。
- 展开：只 dispose `entry.label === 'mcp-restrict' && entry.reason === 'progressive' &&
  entry.service === <server>` 的层，不重装技能 provider、系统提示或其他层；记录
  `expandedServers` 集合。重新 apply（scope/开关变化、preset 切换）时保留该集合，
  只丢弃已不在池内或已切回完整的服务。
- 展开后新注册的该服务工具：`tools/change` 触发时**不**为已展开服务补 `progressive` deny；
  未展开服务及逐接口配置的新工具尝试补 deny（尽力而为，异步去抖、防同步重入），
  补不上就依赖 guard 拒绝调用。
- **guard 是全局注册，不是 per-Agent**：插件 apply 时在根 ctx 上 `ctx.tools.guard(...)`
  一次，规则读取 per-Agent record：
  - `exec.agent` 缺失（无 Agent 调用）：不拒绝（从未被池门控过，也不涉及模型 Schema）；
  - record 存在且 `gateMcp`：拒绝不在 `allowedServers` 里的 `mcp__*`；拒绝 record 快照里
    逐接口配置为关闭/作用域不匹配的 `mcp__*`；拒绝 progressive 且未展开的服务的 `mcp__*`；
  - record 存在且 `gateMcp === false`：只按逐接口开关拒绝（渐进不生效），池外不拒绝；
  - record 缺失且 `exec.agent` 存在：拒绝所有 `mcp__*`（fail-closed）。
  全局注册是为了盖住插件重载时「旧层已释放、`reapplyAll()` 还没跑完」的窗口；per-Agent
  guard 在那个窗口里根本不存在。可行性实验已证明根 ctx 的 guard 覆盖无 Agent、A、B。
  逐接口判断用 record 里 apply 时固化的配置快照；配置变更会重新 apply，快照随之更新。
- 插件卸载/Agent 销毁：dispose 所有层与 guard，清理 WeakMap。全局 guard 随插件
  fiber 卸载一起释放，不能在插件停用后继续拦工具。
- 同一模型步骤内展开只对下一步生效；本步提前调用该工具按未知/未准入处理（不额外做
  特殊放行）。

### 5. 描述词

- 面板输入框保存到 `state.json`。存储值可以是空串（= 无用户描述）。
- discover 的工具 description 由固定模板 + 用户描述组成：

  ```
  <用户描述（可为空）>
  Call this tool to reveal the tools of MCP server "<server>" for this session.
  Expansion takes effect on the next model step; it grants no extra permission.
  ```

  空描述时使用通用一句：「Discover the tools of MCP server "<server>"…」；
  不猜测服务用途，不编造。
- AI 生成：`POST /mcp/describe {server, language?}`（Host 侧，`language` 为 `'zh'|'en'`，
  由面板按当前界面语言传入，缺省 `'zh'`；0.4.0 起没有 `promptLanguage` 配置，不新增配置项）：
  1. 校验服务在池内且 progressive（或用户点按钮时允许任意服务）；
  2. 读 `tools.schemas()`，筛该服务前缀、非 ambiguous 的工具，取 `name + description`
     （截断到合理预算，如 8 KB）；
  3. 用 `agentDefaultModel.currentSelection()`（插件 `ctx.inject(['agentDefaultModel','llm'])`）
     调 `llm.stream`，system 提示要求输出 1–2 句、说明「适合什么任务、什么时候该调用」，
     用 `language` 指定的语言；限制输出 token、超时（如 30 s）；
  4. 返回 `{ok:true, description}` 给面板填入输入框，**不自动保存**；用户确认后走普通保存。
  5. 无工具清单/离线/无默认模型/超时/生成失败 → `{ok:false, error, message}`，面板显示原因。
  生成请求不得把 URL、headers、env 或凭据发给模型。

### 6. 面板

MCP 成员卡片（沿用现有卡片布局与主题）增加：

- 「用途描述」输入框（多行，≤500 字符）+「AI 生成」按钮（生成中禁用、显示进度/错误）。
- 「工具注入」开关：完整注入（默认）/ 渐进注入；切换立即保存并重算所有 Agent 的门控。
- 逐接口列表（可折叠，默认展开但只渲染当前工具）：每行 = 工具公开名 + 描述摘要 +
  启用开关 + modes/workspaces 选择器；历史条目（当前未注册）置灰标「不可用」但仍可开关/
  清除；无法唯一归属的工具标「名称无法唯一归属，不能单独配置」并保持拒绝。
- 一行说明文字：渐进注入只隐藏工具 Schema；MCP resources 与 server instructions
  不受影响；展开状态每个会话独立，重启/重连后重新发现；逐接口作用域与成员作用域是 AND。
- 入口注册失败（名称冲突等）或工具列表读取失败时在卡片显示不可用原因，不提供假开关。

### 7. 失败与降级

- 状态不可读：新 Agent 不创建（现有 fail-closed 行为保持）；已有 Agent 保留旧层；
  discover 不注册/不展示。
- deny 层注册失败：新 Agent 创建失败；已有 Agent 保留旧层并记录不完整状态（沿用现有逻辑）。
- 全局 guard 注册失败：渐进的前置条件不成立，**本次插件加载不提供渐进**（不注册
  discover、progressive 服务按完整注入处理），在状态/面板报错；绝不出现「隐藏了
  Schema 但调用拦不住」。guard 在插件重载后重新注册。
- 无法判断服务是否展开/是否在池内：按「未展开/不可见」处理（拒绝），不全局回退到完整注入。
- 逐接口配置不存在：默认启用、不限作用域（旧配置和新发现的工具一致）。
- 逐接口配置存在但无法唯一归属：该工具始终拒绝，面板不可配置；不按公共前缀猜。
- 工具暂时消失：配置保留并在面板标记不可用；重新注册前不假装它可用，也不因配置存在
  就放行同名但归属不同的新工具。

## 8. 逐接口开关与作用域

每个 MCP 服务下的单个工具（公开名 `mcp__<server>__<raw>`）可配置：

- `enabled`：false 时在完整/渐进两种模式下都不出现、不可调用（deny + guard 双保险）。
- `modes` / `workspaces`：与成员条件同语义（AND，空 = 不限）。工具可见要求
  「服务成员允许」且「工具作用域匹配」；服务作用域与工具作用域是 AND，不是覆盖。
- 生效时机：保存后立即对所有存活 Agent 重算（apply），不需要重连；已展开的服务也立即
  体现关闭/作用域变化。
- 与渐进的关系：完整模式下只看逐接口层；渐进模式下额外受「服务是否展开」约束；
  展开只解除前者（progressive 层），不解除 `tool` 层。
- 归属规则：工具公开名必须能由 `mcpServerOf` 唯一解析到该服务；`isAmbiguousMcpToolName`
  为真的名字不能单独配置，且继续按现有逻辑拒绝（不因配置放行）。
- 不跨服务共享配置：同名 raw 工具在不同服务下各自配置；服务移除时其 `tools` 一起删除。
- 逐接口配置是全局的（所有 Agent 共用），但作用域按每个 Agent 的 mode/cwd 求值；
  与「按 Agent 的展开状态」分开存储、分开测试。

## 已知边界（必须如实告知用户）

1. 渐进只覆盖**工具 Schema 与调用**；MCP resources、server instructions、服务端自身的
   其他访问路径不受影响（可行性实验 #16）。
2. 动态注册窗口：连接建立/重连后新出现的工具可能在 `tools/change` 补 deny 之前短暂可见；
   期间调用由 guard 拒绝。不声称「Schema 从未出现过」。
3. 离线时 registry 里可能残留旧 Schema（实验 #17）；本设计用 `mcpManager` 状态优先判断
   离线并拒绝展开，不清理残留 Schema，也不把旧目录当成功。
4. 展开是 per-Agent 的内存状态：重启、插件重载、恢复会话后需要重新发现。

## 验证

自动化测试（`npm test`，不得把 host-bound 探针混入默认套件）：

- store：新字段 normalize/validate、旧文档缺省补齐、非法 `disclosure` 拒绝、`description`
  超长/控制字符拒绝、保存串行化不丢 `definition`；`tools` 条目校验（键归属、enabled 布尔、
  modes/workspaces 列表）、删除成员时连带删除、历史条目保留。
- activation：渐进服务初始 deny 覆盖其全部已注册工具；展开只撤该服务层；A/B 隔离；
  无 Agent 的调用被 guard 拒；池外服务仍全隐藏；完整注入模式行为不变；逐接口关闭/作用域
  不匹配在两种模式下都 deny；展开不解除 `tool` 层；服务作用域与工具作用域是 AND。
- discover：幂等；未在池内/离线/空目录/状态不可读的诚实失败；ambiguous 工具省略；
  返回体不含定义；名称冲突不注册；目录只列启用且作用域匹配的工具，省略计数正确。
- guard：全局 guard 覆盖无 record（拒绝）、A/B 各自 record、`gateMcp === false`（放行）；
  未展开服务调用被拒；展开后放行（仍受原有权限约束）；池外服务始终拒绝；
  `tools/change` 后新工具在未展开服务上仍被拒；插件重载窗口内（旧层已释放、reapply 未完成）
  仍然拒绝。
- 离线：`mcpManager` 报未连接 → 拒绝展开且不放宽 deny；manager 缺失时按 registry 退化。
- 开关关系：`mcpGate === false` 时渐进不注册、不隐藏；池内无 MCP 成员时同样不注册。
- web-api：描述保存/清除、AI 生成成功/失败/超时、投影不含定义与凭据；`/mcp/tool` 保存/
  清除与非法归属拒绝；`/mcp/tools` 只列当前注册工具并带配置。
- 面板：开关切换后立即生效、描述编辑保存、错误提示、说明文字存在；逐接口行渲染、
  不可用标记、关闭后立刻从资源视图消失。

host-bound 验证（`npm run verify:feasibility` 扩展或新增独立探针）：

- progressive 下初始 `tools.resolve` 的 schema 不含该服务业务工具；
- discover 调用后下一步出现原名工具、原名可直接调用；
- 逐接口关闭/作用域不匹配的工具在完整与渐进下都不出现，直接调用被 guard 拒绝；
- 未展开时 guard 拒绝直接调用（含新注册工具）；
- 两个 Agent 各自展开互不影响；同一服务下 A/B 因工具作用域不同看到不同工具集；
- Host 重启/插件重载后重新发现。

部署：备份 `state.json`；`npm run lint && npm test`；打包 tarball；用插件管理入口
`install_bundle` 升级；验证设置页、discover 调用、展开与 guard；保留回滚到 0.4.1 的方法。

## 留给实施者

- 名称规范化的精确算法与长度上限（按 DSH 注册校验、真实工具名长度校准）。
- `tools/change` 补 deny 的去抖/防重入策略（同步监听 + 微任务）。
- `llm.stream` 的输入裁剪、token 上限、超时与错误映射的具体数值。
- 面板文案、布局细节与测试结构；沿用现有样式与主题。
- 版本号与发布方式（tarball → profile 安装），以及是否需要迁移版本号提升。
