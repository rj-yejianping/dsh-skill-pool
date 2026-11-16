# dsh-skill-pool · 技能池（Skill / MCP）

Skills pile up, and nobody knows which one loads where. **Skill Pool** keeps them in one
place: import from files, ZIP, GitHub or GitLab, auto-group them by repository, and pick the
exact Agent modes and workspaces each skill loads in — from the Settings panel, applied instantly.

在 **设置 → 技能池**（无侧边栏入口）里维护**一个全局技能池**。技能池就是你的资源库：
导入的技能与 MCP 连接**立即成为池成员**，不需要再"搬到池里"。每条成员单独设置
「Agent 模式」与「工作区」条件，命中条件的会话才能看到它。

## 界面

| 技能按仓库分组、默认折叠 | 组头直接设整组条件 |
|---|---|
| ![groups folded](https://raw.githubusercontent.com/rj-yejianping/dsh-skill-pool/main/docs/screenshots/v0.3.7-groups-folded.png) | ![group editor](https://raw.githubusercontent.com/rj-yejianping/dsh-skill-pool/main/docs/screenshots/v0.3.7-group-editor.png) |

| 来源按仓库折叠，组头带检查/更新 | 设置页的整组开关 |
|---|---|
| ![sources folded](https://raw.githubusercontent.com/rj-yejianping/dsh-skill-pool/main/docs/screenshots/v0.3.7-sources-folded.png) | ![group switches](https://raw.githubusercontent.com/rj-yejianping/dsh-skill-pool/main/docs/screenshots/v0.3.7-settings-group-switches.png) |

## 三个 Tab

| Tab | 作用 |
|---|---|
| **资源** | 池成员清单（技能 / MCP）。技能**按仓库分组、默认折叠**（点组名或 ▸ 展开），组头一次设整组的模式/工作区，成员默认继承、可单独覆盖；每行还能改启用状态、删除。顶部可按当前预览条件查看"此处可用 N 项"；底部只读列出系统自带技能 |
| **来源** | 导入来源（Git / ZIP / 文件），**按仓库分组、默认折叠**，组内按每次导入列出。组头直接带「检查 / 更新」对该仓库**全部导入**依次执行，并显示汇总状态；展开后每次导入仍可单独检查更新、更新、删除。ZIP/文件来源只读展示 |
| **设置** | 总开关、MCP 门控、提示摘要、**分组开关**、状态文件路径、版本 |

导入入口是页面右上角的**导入资源**：文件、ZIP、GitHub/GitLab、MCP JSON。
**导入只负责导入**：新资源默认对所有模式/工作区生效，导入对话框不问条件；条件在资源行上单独设置，两件事分开。

## 条件语义

条件是**两个并列维度、同时生效（AND）**：

- `模式` 留空 = 所有 Agent 模式；否则需命中其中之一（如 `standard`、`cordis`）。
- `工作区` 留空 = 所有工作区；否则会话工作目录需等于其中之一，或位于其子目录下。
- 两者都留空 = 处处可用（导入默认值）；`启用` 关掉 = 等价于不生效。
- 只填模式 / 只填工作区 / 两个都填，就是"仅模式""仅工作区""两者都要"三种用法。

**整组开关**：组头（资源 tab）和设置页的「分组开关」各有一个开关。关掉一个仓库组等于把它所有成员关掉，
但**不改成员自己的开关**——重新打开就恢复原样。

**按仓库分组时**，条件有一层继承：

- 组（`repo:<project>`）上设一份模式/工作区，成员默认 `inherit` 这一份；
- 单个成员可以切到 `self` 单独设置，此时它完全不看组；
- 组不存在（本地 ZIP/文件导入、来源被删）时，成员用自己那份；
- `inherit` 与"显式全部"是两回事：前者跟着组走，后者写死"所有模式/工作区"。

## 删除与排除

- **删除一个技能** = 删磁盘文件 + 移出池 + 在它所属来源的 `excluded[]` 里记一笔。
  之后这个来源**再更新也不会把它装回来**（更新时跳过 `excluded`）。
- **把一个来源的技能删光** = 这个来源记录连同它的「检查更新/更新/删除」入口一起消失，
  仓库组也会在它是该仓库最后一个来源时删掉。想重新用就先重新导入。
- 来源 tab 里，有排除记录的 Git 来源显示「已排除 N 个」和**恢复已排除**按钮：
  清空 `excluded` 并强制重装当前提交（`force`），被删的技能回到池里并重新继承组配置。
- 上游自己删掉了某个技能时，更新会正常清理，不算排除。

**模式列表只列真实预设**（来自 `agentPresets`，如 `standard` / `cordis` / `minimal` / `ptc`）。
宿主在"会话没有任何预设"时会内部兜底一个 `default`，那是实现细节，不提供给用户选择，
免得被当成"全部模式"。

**存储只有一份。** 所有模式、所有工作区读的是同一个库目录；条件只决定**可见性**，
不复制、不隔离文件。

生效方式（`agent/created` 时应用；配置变更后重放到所有活动会话）：

1. **技能严格隐藏（registry 级）**：每个 Agent 注册一个**只列本会话可用技能**的技能来源。
   未通过条件的技能在该 Agent 的技能注册表里**根本不存在**——既不出现在目录里，也无法被加载。
   不再摘改原生 `skill` 工具。
2. **MCP 隐藏**：池外 Server 的 `mcp__<server>__*` 工具被 `restrict` 掉。
3. **提示段**：注入「技能池已激活」，说明模式、工作区与可用资源，并要求不要调用未列出的。

## 资源库：独立目录

```
$DSH_HOME/resource-pool/library/skills/<name>/SKILL.md
```

**不与 `$DSH_HOME/skills/` 混放**。技能池拥有自己的目录，也拥有自己的供给方式
（插件注册的技能来源），因此：

- 系统自带技能照常可用，不属于技能池管理；面板里以「系统技能」只读展示。
- 技能池技能的导入/更新/删除完全由本插件负责，不会被其它工具误改。
- 技能正文支持 `disable-model-invocation` / `user-invocable` / `whenToUse` / `metadata`，
  安装时**原样保留**未被使用的 frontmatter 键。
- `description` 写成 YAML 块标量（`>` / `|`）或续行也能正确解析；安装时会被规范化成单行描述，
  其余键不变。

导入方式：

- **文件**：选 `.md`（可多选/目录），或粘贴带 frontmatter 的 Markdown。
- **ZIP**：内置解析（store/deflate），无需系统 `unzip`；支持「一个目录一个技能」与「整包一个技能」。
- **Git**：任意 GitHub / GitLab 地址，**自建（内网）实例同样支持**——主机与 API 路径从 URL 推导，不写死域名。
  - 可直接粘贴浏览器地址：`https://yfgit.example.com/group/repo/-/tree/main/skills`
    会自动识别仓库、**分支 `main`** 与**子目录 `skills`**（GitLab 的 `/-/tree/`、`/-/blob/` 形态）。
  - 也接受 `https://host/group/repo`、`https://host/group/repo.git`、`git@host:group/repo.git`、无协议粘贴。
  - 可选**分支**、**子目录**、**访问令牌**（私有仓库，GitLab 用 `PRIVATE-TOKEN`、GitHub 用 `Bearer`）。
  - 仓库类型默认**自动识别**（含 `/-/tree/` 判定为 GitLab，未知域名默认按 GitLab 处理）；
    GitHub Enterprise 可在导入对话框里显式选 `GitHub / GHE`（走 `/api/v3`）。
  - 走 tarball 下载 + `tar` 解包，**不依赖 `git` 二进制**。
  - 若实例**禁用了归档接口**（对 `/repository/archive.*` 返回 406，常见于加固过的内网 GitLab），
    自动改走 `tree` + 逐文件 `raw` 接口重建同一份目录树，导入结果一致（代价是请求数变多）。
- **检查更新**：按来源查询远端提交（GitHub/GitLab commits API），**不下载归档**即可判断；
  「有更新」后再执行更新。更新只覆盖该来源安装的技能，保留池内条件；上游删除的技能会一并清理。
  - 未配置 token 时，GitHub 的 commits API 可能被限流（403）。此时若安装时记录的也是归档身份
    （`archive:<hash>`），检查会改为下载归档重算哈希再比对，结论依然准确；若记录的是真实 commit
    sha，则如实回报查询失败，不会臆测。
- **删除来源**：只删该来源安装、且没有被其它来源引用的技能；被引用的会跳过并提示。

## 安装

```bash
# npm（公开发布后）
dsh plugin add dsh-skill-pool

# 本地开发：先从源码目录打包，再装真实包
npm pack                      # → dsh-skill-pool-0.3.7.tgz
plugin_manager(action: "install_bundle", target: "/path/to/dsh-skill-pool-0.3.7.tgz")
```

> 不要用 `link:` / 软链安装：Host 在 profile 目录下按 importer 路径做包解析，
> 软链会让 `@deepseek-ai/dsh-tools` 解析到 profile 之外而启动失败（`ERR_MODULE_NOT_FOUND`）。

配置项（`cordis.patch.yml` 的 `config`）：`file`（状态文件路径）、`promptLanguage`（`zh`/`en`）、
`enabled`（插件级总开关）。

> **改代码后必须 `remove_bundle` + `install_bundle`** 才会重新加载；`set_plugin` 会返回
> `overridden` / `restart-required`，不会热加载。装完请确认 profile 的 `dsh.profile.bundles`
> 没有丢条目。

> **包名与数据目录是两件事。** 插件从 `@dsh/resource-pool` 改名为 `dsh-skill-pool` 后，
> 磁盘上的数据目录**仍然是** `$DSH_HOME/resource-pool/`（状态文件、技能库），
> 因此升级不会丢已有技能与配置。只有包名、客户端模块 id、Web 路由前缀变了。

## 数据与状态

`$DSH_HOME/resource-pool/state.json`（原子写，v4）：

```jsonc
{
  "version": 4,
  "settings": { "enabled": true, "mcpGate": true, "injectSummary": true, "gateDefaultSkills": false },
  "groups": {
    "repo:larksuite/cli": { "key": "repo:larksuite/cli", "kind": "repo", "modes": ["standard"], "workspaces": [] }
  },
  "skills": { "<name>": { "enabled": true, "modes": [], "workspaces": [],
                          "modesFrom": "group", "workspacesFrom": "group",
                          "sourceId": "src_x", "digest": "sha256:…", "installedAt": "…" } },
  "mcp":    { "<server>": { "enabled": true, "modes": [], "workspaces": [],
                             "definition": { "transport": "streamable-http", "url": "http://…/mcp", "headers": { "Authorization": "Bearer …" } } } },
  "sources": { "<id>": { "kind": "git|zip|files", "skills": ["<name>"], "excluded": ["<name>"],
                         "sha": "…", "lastCheck": { "status": "up-to-date" } } }
}
```

组键：Git 来源用 `repo:<project>`（同仓库多次导入共用一个组），没有仓库的本地导入用
`import:<sourceId>`（一次导入一组），没有来源的成员不分组。

状态文件与技能目录、MCP 连接记录分离：删掉状态文件只重置配置（库目录里的文件仍在，
但不再被供给——重新导入即可）。

`groups` 里每项还有 `enabled`（默认 `true`），生效条件 = 成员开关 **且** 组开关。

v3 文档会被**迁移**到 v4 而不是丢弃：按仓库推出组、把成员已一致的取值灌给组并让成员继承，
因此迁移前后每个会话看到的资源完全相同；组内本来就不一致的维度留空，成员保留自己的取值。
v1 / v2 文档仍然读到即重置（那两版的成员模型不同，猜映射会悄悄改变门控）。

MCP 成员额外保存 `definition`（连接定义：URL/命令/请求头），**这是为了扛住 Host 重启**：
Loader 行本身只存在于运行时，重启即消失；插件激活后会按 `definition` 重建
`rp-<server>` 行，所以导入过的 MCP 不会在重启后变成"0 个工具"的僵尸成员。
没有 `definition` 的历史成员（0.3.5 及更早导入的）会被跳过，重新导入一次即补上。
状态文件因此按 `0600` 写入——`definition.headers` 里可能有令牌。

## 已知限制

- 技能池只管理自己导入的资源；**系统自带技能始终可用**，不参与门控
  （`gateDefaultSkills` 设置位保留，v3 未启用）。
- MCP 的门控粒度是 **Server**，不是单个工具。
- 工作区按**会话创建时的工作目录**判定；子会话继承父工作区。路径比较是词法的，不解析符号链接。
- 技能文件被外部手改后，下一次重新应用（任一保存、重启插件）才保证刷新。
- 自建 GitHub Enterprise 需要显式选择类型（未知域名默认按 GitLab 处理）。
- 内网实例若使用自签证书，需要运行环境信任该证书（插件不做证书跳过）。
- 由本插件导入的 MCP 使用 `rp-<server>` Loader 行；`dsh-mcp-connector` 管理的 `mcp-<key>` 行不受影响。

## 开发

```
npm run lint   # node --check 全部源码
npm test       # node --test test/*.test.mjs
```

契约见 `CONTRACTS-v3.md`（v2 在 `CONTRACTS.md`，v1 在 `CONTRACTS-v1.md`）。

## License

MIT © yejianping
