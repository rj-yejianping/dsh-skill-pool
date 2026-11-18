# dsh-resource-pool v3 契约（冻结）

> 本文件是 v3 重构的唯一接口契约。Host / Client / 测试三方都以此为准。
> v2 契约见 `CONTRACTS.md`（归档参考，不再生效）。

## v4 增量（2026-11-13，覆盖下文冲突处）

1. **文档版本 4**：新增顶层 `groups`；技能的 `modes` / `workspaces` 旁增加
   `modesFrom` / `workspacesFrom`（`group` = 继承组，`self` = 用自己的）。
2. **组的键**：Git 来源 `repo:<source.project>`；无仓库的本地导入 `import:<sourceId>`；
   没有来源的成员不分组。组记录 `{key, kind, modes[], workspaces[]}`。
3. **生效条件**：每个维度独立——`from === 'group'` 且组存在则用组的值，否则用成员自己的值；
   组不存在时回落成员自己的值。`resolvePool` 语义不变，判定前先算生效条件。
4. **迁移**：v3 → v4 是显式迁移（`store.migrateV3`），按组内现状推出组值并标记继承，
   保证迁移前后 `resolvePool` 对任意会话逐条相同；其余未知版本仍重置为空文档。
5. **模式列表**：`inventory.modes` 不再注入 `default`；`default` 只是 `modeOf()` 的内部兜底。
   `buildInventory` 额外返回 `defaultMode`（预设注册表的默认预设）供面板初始化预览。
6. **预览**：`/resolve` 增加 `allModes` / `allWorkspaces`（值为 `1`），用于"全部模式/全部工作区"
   这一预览选项——它要求忽略该维度，而不是把空串当成一个真实模式/工作区。
7. **接口**：新增 `POST /group {key, modes?, workspaces?}`；`POST /item` 接受
   `modesFrom` / `workspacesFrom`。技能行（`inventory.skills[]`）增加
   `groupKey` / `groupName` / `modesFrom` / `workspacesFrom` / `effectiveModes` / `effectiveWorkspaces`。
8. **来源**：面板按仓库分组展示，组内按每次导入列出；检查/更新/删除的粒度仍是
   **一次导入**（每条 source 有自己的 `subdir` 与 `sha`），组头只汇总检查结果。
9. **排除**：`source.excluded[]` 记录用户删掉的技能名；`installFromTree` 与
   `updateGitSource` 跳过这些名字，所以更新不会把它们装回来。删除技能时写入排除。
10. **清空即删除来源**：某个来源的技能被删光（或更新后一个都不剩）时，**连同来源记录一起删除**
    （不再保留可更新的空壳）；它是该仓库最后一个来源时，组也一并删除。
11. **恢复**：`POST /source/update {id, force?, restore?}`；`restore` 先清空 `excluded` 再强制重装，
    `force` 表示提交未变也重装。面板在来源行显示「已排除 N 个」与恢复入口。
12. **整组开关**：组记录增加 `enabled`（默认 true）。生效 = 成员 `enabled` 且组 `enabled`；
    组开关不改成员自己的值，重新打开即恢复。`POST /group` 接受 `enabled`。
    面板：资源组头一个开关 + 设置 tab「分组开关」卡片（按仓库列出成员数、模式、工作区）。
13. **折叠**：资源 tab 的仓库组与来源 tab 的仓库组都默认折叠，点 ▸ 或组名展开；折叠状态只在客户端内存里。
14. **组级检查/更新**：来源 tab 的仓库组头显示汇总检查状态（任一 `update-available` → 有更新；
    否则任一 `error` → 失败；否则已是最新）与「检查 / 更新」按钮。检查走 `POST /source/check {ids}`，
    更新对组内每条 Git 来源依次 `POST /source/update {id}`，一条失败不影响其余。

## 1. 产品模型

**一个全局资源池 = 用户的资源库。** 没有"资源库 → 资源池"的两步搬运。

- 用户导入一个技能或一个 MCP 连接，它**立即**成为池成员。
- 每个成员单独携带条件：`modes[]`（Agent 模式）与 `workspaces[]`（工作区），都可多选。
- 条件语义：**AND，空表示不限**。
  - 只填 modes ⇒ 这些模式下的所有工作区可用。
  - 只填 workspaces ⇒ 所有模式下、这些工作区内可用。
  - 都填 ⇒ 两者同时满足才可用。
  - 都空 ⇒ 处处可用（导入默认值）。
- 存储一份、全局共享：任何模式/工作区读的是同一个目录。条件只控制**可见性**，不复制文件。
- 设置页三个 Tab：**资源**（池成员列表）/ **来源**（Git 与 ZIP 导入来源、检查更新）/ **设置**。
- 不出现侧边栏入口。

## 2. 存储

### 2.1 状态文件

`$DSH_HOME/resource-pool/state.json`（可用 `Config.file` 覆盖）：

```jsonc
{
  "version": 3,
  "settings": {
    "enabled": true,          // 总开关；false 时完全不干预任何会话
    "mcpGate": true,          // MCP 命名空间门控
    "injectSummary": true,    // 是否注入系统提示摘要
    "gateDefaultSkills": false // 是否连系统自带技能一起严格隐藏（默认关）
  },
  "skills": {
    "<name>": {
      "enabled": true,
      "modes": [],            // string[]
      "workspaces": [],       // string[] 绝对路径
      "sourceId": "src_xxx",  // 可空：手工/ZIP 导入的来源记录
      "digest": "sha256:...", // 可空：内容摘要，用于更新判定
      "installedAt": "2026-10-22T03:04:05.000Z"
    }
  },
  "mcp": {
    "<server>": {
      "enabled": true, "modes": [], "workspaces": [], "installedAt": "...",
      // 用户填写的用途摘要（模型可见的元数据；不进入 definition，可缺省）
      "description": "Search the internal knowledge base",
      // 连接定义：Host 重启后由资源池据此重建 rp-<server> 的 Loader 行
      "definition": {
        "transport": "streamable-http" | "stdio",
        "serverName": "<server>",
        "url": "http://.../mcp",            // streamable-http
        "headers": { "Authorization": "Bearer ..." }, // 可空
        "command": "npx", "args": [], "env": {}, "cwd": "" // stdio
      }
    }
  },
  "sources": {
    "<sourceId>": {
      "id": "src_xxx",
      "kind": "git" | "zip" | "files",
      "label": "owner/repo#main",
      "provider": "github" | "gitlab",   // kind=git 时
      "project": "owner/repo",           // kind=git 时
      "branch": "main",                  // kind=git 时
      "subdir": "",                      // kind=git 时
      "tokenCredential": "RESOURCE_POOL_GIT_SRC_X", // 只存凭据名
      "skills": ["a", "b"],              // 该来源安装的技能名
      "digest": "sha256:...",
      "sha": "abc123",                   // kind=git 时的远端提交
      "lastCheck": { "at": "...", "status": "up-to-date" | "update-available" | "error", "remote": "sha", "error": "" },
      "createdAt": "..."
    }
  }
}
```

版本不符的旧文档一律重置为默认（`normalizeState` 既有行为）。

**读取失败与损坏**：

- 普通读取（`read()`，含面板 GET）宽松回退为默认文档：非法 JSON、JSON 非对象、非 `ENOENT`
  的 I/O 错误都只影响本次显示，不写盘。
- 写操作（`store.update`）在覆盖前**严格读取**：上述任一情况直接失败，**不修改原文件字节**。
  HTTP 返回 500（如 `resource-pool/save-failed`），错误消息只说明无法读取/不是合法 JSON，
  **不回显文件内容、definition 或其中的凭据**；`ENOENT` 仍视为空文档。
- 恢复前应先**备份** `state.json`（`0600`，可能含 MCP 令牌），再人工修复或从备份还原；
  插件不会自动备份，也不会自动重写损坏文件。

### 2.2 资源目录（独立文件夹，不与系统技能混放）

```
$DSH_HOME/resource-pool/library/skills/<name>/SKILL.md
$DSH_HOME/resource-pool/library/skills/<name>/...   # 该技能的 references/scripts/assets
```

- **绝不**写入 `$DSH_HOME/skills/`（系统 filesystem provider 扫描的位置）。
- 该目录由本插件自己的 skill provider 供给（见 §3），不依赖系统 provider 的 watch。
- 布局固定为目录包 `<name>/SKILL.md`；平铺 `*.md` 在安装时被规范成目录包。

### 2.3 SKILL.md 格式

YAML frontmatter + Markdown 正文；必需 `name`（kebab-case）与 `description`；可选 `whenToUse`、`disable-model-invocation`、`user-invocable`、`metadata`。

## 3. 技能供给（本插件的 provider）

新文件 `src/provider.js`：

```js
export const PROVIDER_NAME = 'resource-pool'

/**
 * @param {{root: string, allowed: Set<string>|string[], logger?: object}} options
 * @returns {import('@deepseek-ai/dsh-skill').SkillProvider}
 */
export function createLibraryProvider({ root, allowed, logger })
```

行为：

- `list(options)`：扫描 `root` 下的一级目录，只返回 `allowed` 内、且存在合法 `SKILL.md` 的技能。
  - 返回 `SkillCandidate[]`（同步完成，不读网络）。
  - 字段：`name`（frontmatter `name`，非法则用目录名）、`description`（必填，缺失则跳过该技能）、`whenToUse?`、`invocation:{modelInvocable,userInvocable}`（由 `disable-model-invocation` / `user-invocable` 解析，默认 `true/true`）、`source:'custom'`、`provider:PROVIDER_NAME`、`rank:350`、`locator:{dir,file}`、`path:file`、`resourceBase:{kind:'directory', path:dir}`。
  - 非法/不可读技能跳过并 `logger?.warn`，**不抛错**。
  - 允许 1s 级别的 mtime 缓存；`list` 必须能容忍目录不存在（返回 `[]`）。
- `get(candidate, options)`：读取 `candidate.locator.file`，剥掉 frontmatter 后返回 `{...summary, content, metadata}`；文件消失返回 `undefined`。

注册方式（属于 `src/activation.js`）：**按 Agent 注册**，即
`agent.ctx.skills.registerProvider((control) => createLibraryProvider({ root, allowed }))`。
因为 `SkillRegistry.registerProvider` 的文件化层语义由调用方 ctx 的 scope 决定，注册到 `agent.ctx` 就只对该 Agent 可见 ⇒ 未激活的库内技能在 registry 层就不存在，天然严格隐藏，**不再需要**摘掉原生 `skill` 工具或注册同名替代工具。

- 注册必须由 `agent.ctx.effect(...)` 持有，随 Agent 释放。
- 池内容或条件变化 ⇒ 释放旧注册并重新注册（旧注册 dispose 会自动失效 catalog 缓存）。
- `allowed` = `resolvePool()` 得出的技能名集合，与 `modes/workspaces` 无关的库内技能不进入 `allowed`。
- 库内文件被安装/更新/删除后，同样释放并重新注册（或调用 `control.invalidate()`）以刷新 catalog。

## 4. 判定（`src/rules.js`，不改）

```js
resolvePool(state, {mode, cwd}) -> {gated, skills: string[], mcpServers: string[], gateSkills, gateMcp}
```

- 条件匹配：`scopeMatches`，modes ∧ workspaces，空即不限；工作区用 `isUnder` 词法前缀匹配。
- `gateSkills = 有技能成员 && settings.enabled !== false`（`gateDefaultSkills` 只影响是否连系统技能一起隐藏）。
- `gateMcp = 有 MCP 成员 && settings.mcpGate !== false`。
- 空池 ⇒ `gated:false` ⇒ 不干预。

## 5. 生效（`src/activation.js`）

每个 Agent 一次激活，三步：

1. **技能层**：按 §3 注册 provider（`allowed` 为本次判定结果）。`gateDefaultSkills === true` 时额外摘掉全局技能……（v3 不实现该分支，仅保留设置位，见 §9）。
2. **MCP 层**：从全局 `ctx.tools.schemas()` 取 `mcp__<server>__*`，不在 `mcpServers` 内的名字 `agent.ctx.tools.restrict({deny})`。
3. **提示词**：`agent.ctx.systemPrompt.section({name:'resource-pool:active', order: getSectionOrder('TOOL_READ')-30, text})`，说明模式、工作区、可用技能与 MCP。

生命周期与并发（不变）：`agent/created` 必须 `await`；先算后放；每 Agent 一条 promise chain；`signature` 去重；`agent/disposed` 释放；插件卸载 `disposeAll`；`ctx.inject(['agents'], () => reapplyAll())`。

## 6. HTTP API

前缀 `/dsh-resource-pool`，全部经 `connection.admit(req)`；响应 `{ok:true, ...}` / `{ok:false, error:{code,message}}`。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `` | — | `{ok, meta, state, inventory, mounts}` |
| POST | `/item` | `{kind:'skill'\|'mcp', name, enabled?, modes?, workspaces?, modesFrom?, workspacesFrom?, description?}` | `{ok, state}` |
| POST | `/item/remove` | `{kind, name}` | `{ok, state, removed}` |
| POST | `/settings` | `{patch}` | `{ok, state}` |
| GET | `/resolve?mode=&cwd=` | — | `{ok, pool}` |
| POST | `/skill/upload` | `{name?, description?, files:[{path, contentBase64}], scope?:{modes,workspaces}, overwrite?}` | `{ok, state, installed: string[], failures:[{name,error}]}` |
| POST | `/skill/zip` | `{label?, archiveBase64, scope?, overwrite?}` | 同上 |
| POST | `/source/git` | `{url, provider?, branch?, subdir?, token?, label?, scope?, overwrite?}` | `{ok, state, source, installed, failures}` |
| POST | `/source/check` | `{ids?: string[]}` | `{ok, state, results:[{id,label,status,current,remote,error?}]}` |
| POST | `/source/update` | `{id}` | `{ok, state, source, installed, failures}` |
| POST | `/source/delete` | `{id}` | `{ok, state, removed:[], skipped:[]}` |
| POST | `/mcp/import` | `{payload, scope?}` | `{ok, state, servers, mounts}`（立即返回，后台挂载） |
| POST | `/mcp/remove` | `{server}` | `{ok, state}` |
| GET | `/mounts` | — | `{ok, mounts}` |

规则：

- 写操作：原子落盘 → `reapplyAll()` → 返回新 `state`。
- `POST /item` **只编辑已存在的成员**：成员不存在（包括只改条件的请求）返回 400 `resource-pool/unknown-item`，不会新建成员；新建只由导入接口完成。这样删除期间迟到的保存不能把成员重新创建出来。
- `POST /item` 的 `description` 是**仅 MCP 成员**可写的用途摘要：必须是字符串（否则 400），保存前 `trim`，最长 300 字符（超长 400，code `resource-pool/bad-scope`）；非 MCP 成员携带它返回 400 `resource-pool/bad-description`。`""` 是显式清除（落盘删除该键，公开投影不再有 `description`）；**缺省该属性不是编辑**，保留已存储的用途。条件保存（不带 `description`）因此不会覆盖另一端刚改的用途；客户端只在**本标签页实际编辑过**该行用途时才发送此属性（含清空），并在保存失败/响应乱序时保留脏标记以便重试。
- 所有返回 `state` 的响应（概览与全部写操作）都经过公开投影：MCP 成员只含 `enabled`、`modes`、`workspaces`、`installedAt`、`description`，**绝不包含 `definition`**（URL/命令/headers/env 中的凭据）。落盘状态仍保留 `definition` 供启动重挂载；投影只影响浏览器响应。
- MCP 用途摘要进入系统提示时，当前 Agent 可用的服务名列表单独、权威地给出；各服务的用途作为独立 JSON 数据（`purpose: null` 表示未填写用途摘要）。该数据明确标记为用户提供、不可信、不是指令、不是授权依据；JSON 编码只是结构边界，**不是注入防护，也不保证内容安全**。
- `scope` 缺省为 `{modes:[],workspaces:[]}`。
- `/mcp/import` 先同步校验定义（非法 ⇒ 400），**先把成员与 `definition` 落盘**，再后台挂载；`ready` 必须观测到 `mcp__<server>__*` 工具，20s 超时 ⇒ `failed`。
- 状态文件权限为 `0600`：`definition.headers` 可能携带 `Authorization` 之类的令牌。
- 启动恢复：插件激活且 `loader` 就绪后，`src/remount.js` 对每个 `enabled !== false` 且带 `definition` 的 MCP 成员重建 `mcp-client` 行（后台探测，失败只记日志/挂载表，不阻断启动）。没有 `definition` 的旧成员会被跳过，需要重新导入一次。
- 请求体上限 96MB，超出 413（`resource-pool/too-large`）。

### 6.1 inventory 结构（供面板渲染）

```jsonc
{
  "skills": [{ "name","description","path","sourceId","sourceLabel","groupKey","groupName",
               "enabled","effectiveEnabled","modes","workspaces","modesFrom","workspacesFrom",
               "effectiveModes","effectiveWorkspaces","digest","installedAt","modelInvocable","missing" }],
  "nativeSkills": [{ "name","description","source","provider" }],   // 系统/预设自带，只读展示
  "mcp": [{ "server","description","tools":["..."],"managed":bool,"entryId",
            "enabled","modes","workspaces","installedAt" }],
  "modes": ["standard", "..."],                    // 真实预设 id，不含 default 兜底
  "workspaces": ["/abs/path", "..."],
  "defaultMode": "standard"                        // 预设注册表默认值，可空
}
```

- `mcp[].description` 是用途摘要（`trim`、最长 300，未填写为 `''`），**不是**连接定义；
  inventory 与任何 `state` 响应都不含 `definition`。
- `mcp[].tools` 只包含当前可观察到的 `mcp__<server>__*` 公开名；挂载状态在 `/mounts`，
  且断线时 schema/工具名可能仍是上一代（不能把"有 schema"当作在线）。
- 该接口只读；条件与用途通过 `POST /item` 写入，不经过 inventory。

## 7. 资源库函数签名（`src/library.js`，供 web-api 调用）

```js
export function librarySkillsRoot()                                   // <dshHome>/resource-pool/library/skills
export function parseSkillDocument(text)                              // {meta, body, hadFrontmatter, frontmatter, spans}
export function bundleDigest(files)                                   // 'sha256:<32hex>'
export async function listLibrarySkills({ root })                     // [{name, description, path, dir, modelInvocable, userInvocable, digest, whenToUse?}]
export async function installFromFiles({ files, root, overwrite, name, description, scope })   // {installed, failures, digests}
export async function installFromZip({ archiveBase64, root, overwrite, label, scope })         // {installed, failures, digests}
export async function installFromGit({ url, branch, subdir, token, label, root, overwrite, scope }) // {source, installed, failures, digests}
export async function updateGitSource({ source, token, root })        // {changed, source, installed, failures, digests, removed}
export async function removeSourceSkills({ source, root, skipSkills }) // {removed, skipped}
export async function checkGitSource({ source, token })               // {id, label, status, current, remote} | throws
export async function removeSkillDir({ root, name })                  // boolean
```

- `installed` 是技能名数组；`failures` 是 `[{name, error}]`；`digests` 是 `{name: 'sha256:…'}`。
- `scope` 由调用方写入 state，本层不读 state。
- 安装落点一律 `librarySkillsRoot()`；**绝不写 `$DSH_HOME/skills/`**。
- ZIP/文件/Git 三条路径都必须先把平铺 `*.md` 规范成 `<name>/SKILL.md`。
- `parseSkillDocument` 必须解析 YAML 块标量（`>` / `|`，可带 chomping）与续行，并返回每个键的行范围 `spans`，供安装时整段替换。
- 安装时只重写 `name` 与 `description` 两个键；其余 frontmatter（含嵌套 `metadata:`）原样保留。
- `listLibrarySkills` 读磁盘真值：inventory 不能依赖 registry 全局视图（v3 的库 provider 是按 Agent 注册的）。
- Git 仓库地址：**任意主机**，`parseRepoUrl(url, {provider})` 从 URL 推导 `provider/project/host/origin/apiBase`。
  - `/-/tree|blob|src/<branch>/<subdir>` 段被剥离为 `branchHint`/`subdirHint`（粘贴浏览器地址即可用）。
  - 判定：`github.com` → github；否则 gitlab（`/-/` 标记亦判定 gitlab）；`provider` 显式传入时优先。
  - API 基址：github.com → `https://api.github.com`；GHE → `<origin>/api/v3`；GitLab（含自建）→ `<origin>/api/v4`。
- Git 身份：`source.sha` = 安装时记录的提交身份。GitHub 取 `repos/<p>/commits/<branch>` 的 `sha`，GitLab 取 `projects/<enc>/repository/commits/<branch>` 的 `id`；API 不可用时回退为 `archive:<sha256 前 16 位>`。
- 下载回退：归档接口返回 **406/403/415** 时（实例禁用归档），GitLab 走 `repository/tree?recursive` + `repository/files/:path/raw`
  重建目录树再入库；结果与归档路径一致，`sha` 仍取 commits API。GitHub 无此回退。
- 当 subdir 直接指向技能包本身（`SKILL.md` 位于 base 根）时，技能名回退为该目录名。
- `checkGitSource` 必须与记录的身份**同类比较**：`source.sha` 为 `archive:` 前缀时，API 失败可下载归档重算哈希再比较；记录的是真实 commit 时不得用归档哈希臆测，直接报错。检查**不得**覆盖 `source.sha`。

## 8. 面板（`client.js`）

三个 Tab：

1. **资源**
   - 顶部：条件预览（选择模式/工作区后显示"此处可用 N 项"）+「导入资源」按钮。
   - 技能区：每行 = 名称、描述、来源标签、`模式` 多选、`工作区` 多选、启用开关、删除。
   - MCP 区：同上，另显示工具数量与挂载状态（mounting/ready/failed）。
   - 只读区「系统技能」：列出 `nativeSkills`，说明"不归资源池管理"。
   - 空态：引导导入。
2. **来源**
   - 每行：label、kind、技能数、`上次检查` 状态徽标（已是最新 / 有更新 / 错误）、「检查更新」「更新」「删除」。
   - 顶部「检查全部更新」。
   - ZIP/文件导入来源只读展示，无更新按钮。
3. **设置**：总开关、MCP 门控、提示摘要、`gateDefaultSkills`（灰显标注 v3 未启用）、状态文件路径、版本。

交互约定：

- **导入与设条件分离**：导入对话框只收集来源信息（文件 / ZIP / Git / MCP JSON），**不问模式与工作区**；
  新导入的资源默认对所有模式与工作区生效。条件的唯一编辑入口是资源行上的模式/工作区芯片。
  API 仍接受 `scope`（给脚本/未来复用），但面板不再发送。
- 「导入资源」是页面级动作，位于**页面右上角**，与「刷新」并列；「资源」Tab 内不再出现导入按钮（空态只给文字引导）。
- 行内自动保存（320ms debounce，无保存按钮）；错误就地显示。
- 上方选择器（Agent 模式 / 工作区）只用于**预览**"此处可用 N 项"，不写任何资源。
- 字体与配色：根节点 13px 基准字号，控件禁止使用 `font` 简写（会重置字号）；
  强调色用 `--dsw-alias-link`（随主题翻转的蓝），**不用** `--dsw-alias-brand-primary`（那是主按钮填充，暗色主题下近白）。

## 9. 明确不在 v3 范围

- `gateDefaultSkills = true` 的严格模式（隐藏系统自带技能）——保留设置位，默认关，UI 标注"暂未启用"。
- MCP 细到单工具的门控（仍以 Server 为单位）。
- Git 自动轮询检查（只做手动「检查更新」）。
