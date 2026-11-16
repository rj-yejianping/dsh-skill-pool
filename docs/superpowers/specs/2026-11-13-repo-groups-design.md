# 资源池：按仓库分组 + 继承式统一配置（状态文档 v4）

日期：2026-11-13　　状态：已确认并实现（0.3.7，本地）

## 1. 意图

现在 42 个技能、4 次导入，条件只能一条一条设：larksuite 的 25 个技能全都要
`standard`，只能点 25 次。目标是把「来自同一个仓库」的技能归为一组，组上设一次
模式/工作区，成员默认继承；个别成员要例外时再单独覆盖。

同时修掉两个让人误读「default 就是全部」的地方。

## 2. 目标 / 非目标

| 目标 | 非目标 |
|---|---|
| 技能按仓库（`source.project`）分组，组上设 模式/工作区 | MCP 不分组建配置，仍逐条 |
| 成员默认继承组配置，可切「单独设置」覆盖（含显式「全部」） | 不做跨仓库的自定义分组（原方案 C） |
| 模式列表去掉伪模式 `default` | 不改 `activation.modeOf()` 的内部兜底值 |
| 预览模式下拉补「全部模式」，初始值 = 预设注册表的默认预设（当前 `standard`），工作区取列表第一个 | 不做「预览默认用当前会话模式」的会话管道 |
| 数据升级 v3 → v4，迁移前后可见性完全一致 | 不发布 npm |

## 3. 数据模型（v4）

```jsonc
{
  "version": 4,
  "settings": { "...": "不变" },
  "sources": { "<id>": { "...": "不变（project/url/subdir/sha 已在）" } },
  "skills": {
    "<name>": {
      "enabled": true,
      "modes": ["standard"],
      "workspaces": [],
      "modesFrom": "group",        // 'group' | 'self'
      "workspacesFrom": "group",   // 'group' | 'self'
      "sourceId": "src_x", "digest": "sha256:…", "installedAt": "…"
    }
  },
  "mcp": { "<server>": { "...": "不变" } },
  "groups": {
    "repo:larksuite/cli": {
      "key": "repo:larksuite/cli",
      "name": "larksuite/cli",
      "kind": "repo",              // 'repo' | 'import'
      "modes": ["standard"],
      "workspaces": []
    }
  }
}
```

- 组的键：`repo:<project>`（git 来源）；没有仓库的本地导入（ZIP/文件）退化为
  `import:<sourceId>`，名称用该来源的 label。没有来源的技能 → 不分组，自管。
- 生效条件（每个维度独立）：
  `from === 'group'` 且组存在 → 组的值；否则 → 成员自己的值。
- 组不存在、来源被删、维度为 `self` → 回落到成员自己的值，和今天一致。

## 4. 迁移 v3 → v4

`normalizeState()` 现在对版本不符**直接返回空文档**（store.js:397），必须先改成
显式迁移分支，否则升级会清空整个池。

每个组内按维度推断，保证**迁移前后可见性逐条相同**：

1. 组内所有技能的 `modes` 完全相同 → `groups[k].modes = 该值`，成员 `modesFrom='group'`；
   否则 `groups[k].modes = []`，成员保持 `modesFrom='self'`（保留各自的值）。
2. `workspaces` 同理，独立判断。
3. 无来源 / 本地导入的成员不动（`self`）。

按当前数据的结果：

| 组 | 技能数 | 迁移后的组配置 | 成员 |
|---|---|---|---|
| `repo:mattpocock/skills` | 2 | 模式 全部、工作区 全部 | 继承 |
| `repo:obra/superpowers` | 15 | 模式 全部、工作区 全部 | 继承 |
| `repo:larksuite/cli` | 25 | 模式 `standard`、工作区 全部 | 继承 |

迁移是幂等的纯函数，读出来不会被写回也可以反复执行；任何一次面板改动才会落盘。

## 5. 解析

`src/rules.js` 增加：

- `groupKeyOfSource(source)` → `repo:<project>` / `import:<id>` / `''`
- `effectiveEntry(state, item)` → 把 `from` 解析成实际 `{modes, workspaces}`

`resolvePool()` 与 `scopeMatches()` 的判定语义不变，只是判定前先算生效条件。

## 6. 接口

| 方法 | 路由 | 变化 |
|---|---|---|
| GET | `/dsh-resource-pool` | `state` 带 `groups`；技能行增加 `group{key,name}`、`modesFrom/workspacesFrom`、`effectiveModes/effectiveWorkspaces` |
| POST | `/dsh-resource-pool/group` | 新增：`{key, modes?, workspaces?}` 改整组配置 |
| POST | `/dsh-resource-pool/item` | 增加 `modesFrom` / `workspacesFrom` |

## 7. 界面

资源 tab：

```
▾ larksuite/cli                    25 项   模式: standard ▾   工作区: 全部 ▾
    lark-im         模式: standard（继承）   工作区: 全部（继承）   [启用]
    lark-doc        模式: standard（继承）   工作区: 全部（继承）   [启用]
▾ obra/superpowers                 15 项   模式: 全部 ▾       工作区: 全部 ▾
    brainstorming   模式: 全部（继承）
```

- 组默认**折叠**：组头一个 ▸ 标记 + 组名可点，展开才显示成员行；组条件 chip 独立于点开/收起，
  折叠时也能改整组配置。
- 成员行 chip 显示**生效值**并标「继承」；展开行后每个维度二选一：
  「继承来源（值）」/「单独设置（多选）」。
- 没有来源的成员放「未分组」段。
- 来源 tab **按仓库分组**，组头显示「N 次导入」，组内每次导入一行（导入时间 / 子目录 / sha），
  检查、更新、删除的粒度仍是一次导入；组头的「检查全部」只汇总结果。

模式列表：`inventory.modes` 不再注入 `default`（`src/inventory.js:413` 与
`collectModes` 的 `add('default')`）；预览下拉第一位补「全部模式」（`value: ''`，
与「全部工作区」对齐），初始值取真实列表第一项。`activation.modeOf()` 返回
`'default'` 的内部兜底保留，只是不再出现在界面里。

## 7.5 删除与排除（2026-11-13 追加）

- 删除技能 = 删文件 + 移出池 + 写进所属来源的 `excluded[]`；更新/重装跳过这些名字。
- 来源的技能被删光 → 连来源记录（检查/更新入口）一起删除；是该仓库最后一个来源时组也删除。
- 来源行显示「已排除 N 个」，提供「恢复已排除」（清空 excluded + `force` 重装当前提交）。

## 7.6 折叠与整组开关（2026-11-13 追加）

- 资源 tab 的仓库组、来源 tab 的仓库组都默认折叠（▸ 可点）；折叠状态只在组件内存。
- 组记录增加 `enabled`：组头一个开关 + 设置 tab「分组开关」卡片。生效 = 成员开关且组开关；
  关组不改成员自己的开关，重新打开即恢复。

## 7.7 来源组头的检查/更新（2026-11-13 追加）

仓库组头加「检查 / 更新」与汇总状态：检查用组内全部 Git 来源 id 调 `/source/check`；
更新按条依次调 `/source/update`，单条失败不中断。展开后每条导入仍可单独操作。

## 8. 测试

`package.json` 已有 `node --test test/*.test.mjs`，但 `test/` 不存在，本次补上：

1. `rules`：继承 / 覆盖 / 无组 / 空组 / 显式「全部」覆盖。
2. 迁移等价：同一份 v3 数据，迁移前后 `resolvePool()` 对所有会话逐条相同。
3. `inventory`：模式列表不含 `default`。
4. `store`：v3 → v4 迁移幂等；未知版本仍回空文档。

## 9. 验收

- `node --check` 全绿，单测通过。
- `install_bundle` 装进 `web` profile，面板出现 3 个仓库组；把 larksuite 组改成
  `standard` 后 25 项立即生效；改回后恢复。
- 修完先留在本地，版本号 0.3.7，发布到 `npm-cbg` 前另行确认。
