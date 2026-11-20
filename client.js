/**
 * dsh-skill-pool — Settings panel (browser half), contract v3.
 *
 * One page under `settings.section` with three tabs — Resources / Sources /
 * Settings. There is a single global pool: importing a skill or an MCP server
 * makes it a pool member immediately, and every member carries its own Agent
 * mode and workspace conditions (both dimensions must match; empty = any).
 *
 * All reads and writes go through the Host routes under `/dsh-skill-pool`,
 * so the browser never touches the state file or browser storage. React is the
 * only package required.
 */
// The module id MUST be the package name: the module system indexes bundle
// factories by `window.__ModuleLoader__.load({id})` and looks each one up under
// the package name in the composed graph. A mismatch leaves the row registered
// but never activated, which fails the whole client-plugin load with
// "1 entry did not activate". Keep this string equal to package.json's `name`.
window.__ModuleLoader__.load({
  id: 'dsh-skill-pool',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    const ZH = typeof navigator !== 'undefined' && String(navigator.language || '').toLowerCase().startsWith('zh')

    const TEXT = {
      zh: {
        navTitle: '技能池',
        title: '技能池',
        subtitle: '一个全局技能池：导入即入池。每个资源单独设置 Agent 模式与工作区，两者同时满足才可见；都留空表示所有模式与工作区。',
        refresh: '刷新',
        refreshing: '刷新中…',
        loading: '加载中…',
        retry: '重试',
        retryHint: '无法读取技能池数据。确认插件已启用后重试。',
        networkFailed: '网络请求失败',
        badResponse: '响应格式异常',
        rowFailed: '这一行渲染失败',
        close: '关闭',
        cancel: '取消',
        done: '完成',
        confirm: '确认',
        enabled: '已启用',
        disabled: '已关闭',
        on: '开',
        off: '关',
        saving: '保存中…',
        tabResources: '资源',
        tabSources: '来源',
        tabSettings: '设置',
        // resources tab
        cardSkills: '技能',
        cardMcp: 'MCP Server',
        countUnit: '项',
        importResource: '导入资源',
        previewMode: 'Agent 模式',
        previewWorkspace: '工作区',
        previewAllModes: '全部模式',
        previewAllWorkspaces: '全部工作区',
        previewAvailable: '此处可用 {count} 项',
        previewSkills: '技能',
        previewMcp: 'MCP',
        previewNone: '无',
        previewGateSkills: '技能门控',
        previewGateMcp: 'MCP 门控',
        previewGated: '已门控',
        previewNotGated: '未门控',
        previewBusy: '解析中…',
        previewFailed: '解析失败',
        rowModes: '模式',
        rowWorkspaces: '工作区',
        draftDiscarded: '以下未保存的修改因为对应资源已在别处删除而被丢弃；请先复制需要保留的内容：',
        allModes: '全部模式',
        allWorkspaces: '全部工作区',
        editConditions: '设置条件',
        hideConditions: '收起条件',
        groupInherit: '继承',
        groupInheritTag: '（继承）',
        groupSelf: '单独设置',
        groupInheritFrom: '继承来源',
        groupUngrouped: '未分组',
        groupImports: '{count} 次导入',
        groupImportOne: '{count} 次导入',
        groupExpand: '展开',
        groupCollapse: '收起',
        settingsGroups: '分组开关',
        groupDisabledTag: '整组已关闭',
        groupHint: '同仓库成员默认继承这组条件；单个资源可以改为单独设置。',
        addPathPlaceholder: '/root/workspace/foo 回车添加',
        addPath: '+',
        addPathLabel: '添加工作区路径',
        savingItem: '保存中…',
        removeItem: '删除',
        removing: '删除中…',
        confirmRemove: '确认删除',
        itemRemoved: '已删除',
        toolsUnit: '个工具',
        mountMounting: '挂载中…',
        mountReady: '已就绪',
        mountFailed: '挂载失败',
        sourceFrom: '来源',
        sourceNone: '无来源',
        skillMissing: '（清单中已不存在，可能已被删除）',
        // MCP member card: purpose description, injection mode and per-tool rows.
        mcpDescription: '用途描述',
        mcpDescriptionPlaceholder: '这个 MCP 服务适合什么任务？',
        mcpDescriptionHint: '用于发现入口的说明；留空时使用通用描述。最多 {count} 字符。',
        mcpDescribe: 'AI 生成',
        mcpDescribing: '生成中…',
        mcpDescribeFailed: '生成失败',
        mcpDescribeEmpty: '模型没有返回可用的描述',
        mcpInjectMode: '工具注入',
        mcpInjectFull: '完整注入',
        mcpInjectProgressive: '渐进注入',
        mcpInjectFullHint: '会话启动时注入该服务的全部工具。',
        mcpInjectProgressiveHint: '会话先只出现一个发现入口，调用后才展开工具。',
        mcpGateOff: 'MCP 门控已关闭，渐进注入不生效',
        mcpToolsTitle: '工具',
        mcpToolsLoading: '工具加载中…',
        mcpToolsFailed: '工具列表读取失败',
        mcpToolsEmpty: '当前没有可配置的工具。',
        mcpToolUnavailable: '不可用',
        mcpToolAmbiguous: '名称无法唯一归属，不能单独配置',
        mcpToolClear: '清除配置',
        mcpScopeHint: '逐接口作用域与成员作用域是 AND。',
        mcpHint: '渐进注入只隐藏工具 Schema；MCP resources 与 server instructions 不受影响；展开状态每个会话独立，重启/重连后重新发现；逐接口作用域与成员作用域是 AND。',
        emptyTitle: '还没有资源',
        emptyHint: '用右上角的「导入资源」上传技能文件、ZIP 包、从 Git 导入，或粘贴 MCP JSON。导入后立即成为技能池成员，条件在资源行上单独设置。',
        systemSkillsTitle: '系统技能',
        systemSkillsHint: '这些技能由宿主或预设提供，不归技能池管理，仅作展示。',
        systemSkillsEmpty: '没有系统技能。',
        modelInvocableOff: '模型不可调用',
        groupEmptySkills: '还没有技能资源。',
        groupEmptyMcp: '还没有 MCP 资源。',
        // import dialog
        importTitle: '导入资源',
        importSubtitle: '导入后立即成为技能池成员，默认对所有模式与工作区生效；条件在资源行上单独设置。',
        segFiles: '文件',
        segZip: 'ZIP',
        segGit: 'Git',
        segMcp: 'MCP',
        overwrite: '覆盖同名资源',
        filesPick: '选择 .md 文件',
        filesPickFolder: '选择技能文件夹',
        filesChosen: '已选',
        filesName: '技能名（留空 = 文件名）',
        filesNamePlaceholder: 'my-skill',
        filesDesc: '描述（留空 = frontmatter）',
        filesDescPlaceholder: '一句话描述这个技能',
        filesBody: '或直接粘贴 Markdown 内容',
        filesBodyPlaceholder: '---\nname: my-skill\ndescription: One line\n---\n\n# Instructions',
        filesNeed: '先选择文件或粘贴内容',
        filesTooLarge: '文件过大（上限 5 MB）',
        filesReadFailed: '读取文件失败',
        zipPick: '选择 .zip 文件',
        zipChosen: '已选',
        zipLabel: '来源名称（留空 = 自动识别）',
        zipNeed: '先选择 ZIP 文件',
        zipTooLarge: '压缩包过大（上限 20 MB）',
        gitUrl: '仓库地址',
        gitUrlPlaceholder: 'https://gitlab.company.com/group/repo 或 …/-/tree/main/skills',
        gitBranch: '分支 / 标签',
        gitSubdir: '子目录（可选）',
        gitType: '仓库类型',
        gitTypeAuto: '自动识别',
        gitTypeGitlab: 'GitLab（含自建）',
        gitTypeGithub: 'GitHub / GHE',
        gitTypeHint: '自建 GitLab 直接粘贴仓库或 /-/tree/ 链接即可；私有仓库填访问令牌。',
        gitToken: '访问令牌（私有仓库，可选）',
        gitTokenHint: '令牌写入宿主凭据库，状态文件只保存名字。',
        gitLabel: '来源名称（可选）',
        gitNeedUrl: '先填写仓库地址',
        gitRunning: '正在拉取仓库…（最多 45 秒）',
        mcpJson: 'mcpServers JSON',
        mcpJsonHint: '立即返回，后台挂载；下方实时刷新挂载状态。',
        mcpJsonInvalid: '请先填写 JSON',
        mcpJsonBad: 'JSON 解析失败',
        mcpNotice: '已提交导入：',
        mcpMountBackground: '挂载在后台继续，可在资源列表查看状态。',
        importSubmit: '导入',
        importing: '导入中…',
        importInstalled: '已导入',
        importFailures: '失败',
        importPartial: '部分导入成功',
        importDone: '完成',
        importRetryHint: '可修正后重试；已成功的资源已入池。',
        // sources tab
        sourcesHint: 'Git 来源可检查更新与更新；ZIP / 文件来源只读展示。',
        checkAll: '检查全部更新',
        checkingAll: '检查中…',
        sourceCheck: '检查更新',
        sourceChecking: '检查中…',
        sourceUpdate: '更新',
        sourceUpdating: '更新中…',
        sourceDelete: '删除',
        sourceDeleting: '删除中…',
        sourceDeleteConfirm: '只删除没有被其它来源引用的技能',
        sourceDeleteYes: '确认删除',
        sourceDeleteCancel: '取消',
        sourceKindGit: 'Git',
        sourceKindZip: 'ZIP',
        sourceKindFiles: '文件',
        sourceKindUnknown: '来源',
        sourceSkillsUnit: '个技能',
        sourceSkillsUnitOne: '个技能',
        sourceSha: '提交',
        sourceDigest: '摘要',
        sourceCreatedAt: '创建于',
        sourceReadOnly: '只读',
        sourceNotGit: '该来源不支持检查更新',
        lastCheck: '上次检查',
        neverChecked: '未检查',
        statusUpToDate: '已是最新',
        statusUpdateAvailable: '有更新',
        statusError: '检查失败',
        sourcesEmpty: '还没有导入来源。导入 ZIP / 文件 / Git 时会自动记录。',
        checkResult: '检查完成：{updated} 个有更新，{upToDate} 个最新，{failed} 个失败',
        noticeSourceUpdated: '来源已更新',
        sourceExcluded: '已排除 {count} 个',
        sourceRestore: '恢复已排除',
        sourceRestoreHint: '这些技能被删除后不再随更新安装；恢复会把它们重新装回来',
        sourceRestoring: '恢复中…',
        noticeSourceRestored: '已恢复被排除的技能',
        noticeGroupUpdated: '组内导入已更新（{count} 个技能）',
        noticeSourceUpToDate: '来源已是最新',
        noticeSourceDeleted: '来源已删除',
        sourceSkipped: '（保留 {count} 个仍被其它来源引用的技能）',
        noticeSourceChecked: '检查完成',
        // settings tab
        settingsHint: '改动即时生效；已存在的会话保留启动时的状态。',
        setEnabled: '总开关',
        setEnabledHint: '关闭后完全不干预任何会话。',
        setMcpGate: 'MCP 门控',
        setMcpGateHint: '隐藏未命中条件的 MCP 工具。',
        setGateDefaultSkills: '系统技能严格隐藏',
        setGateDefaultSkillsHint: '暂未启用（系统技能始终可用）。',
        stateFile: '状态文件',
        version: '版本',
        settingsSaved: '设置已保存',
        settingsSaving: '保存中…',
        notAvailable: '暂未启用',
        missingFile: '文件缺失',
        missingFileHint: '磁盘上找不到这个技能文件；可以重新导入，或删除该行。',
        deleteSkillConfirm: '确认删除？会删除磁盘上的技能文件，且此来源以后更新不再安装它',
        deleteMcpConfirm: '确认删除？会同时卸载该 MCP Server',
        selectAll: '全选',
        clearAll: '清空',
        noMatches: '没有匹配项。',
        addNoneSelected: '还没有选择',
      },
      en: {
        navTitle: 'Skill Pool',
        title: 'Skill Pool',
        subtitle: 'One global pool: importing a resource puts it in the pool. Every member carries its own Agent mode and workspace conditions (both must match; empty = any).',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        loading: 'Loading…',
        retry: 'Retry',
        retryHint: 'Could not read the skill pool. Make sure the plugin is enabled, then retry.',
        networkFailed: 'Network request failed',
        badResponse: 'Unexpected response',
        rowFailed: 'This row failed to render',
        close: 'Close',
        cancel: 'Cancel',
        done: 'Done',
        confirm: 'Confirm',
        enabled: 'Enabled',
        disabled: 'Disabled',
        on: 'on',
        off: 'off',
        saving: 'Saving…',
        tabResources: 'Resources',
        tabSources: 'Sources',
        tabSettings: 'Settings',
        cardSkills: 'Skills',
        cardMcp: 'MCP servers',
        countUnit: 'items',
        importResource: 'Import',
        previewMode: 'Agent mode',
        previewWorkspace: 'Workspace',
        previewAllModes: 'All modes',
        previewAllWorkspaces: 'All workspaces',
        previewAvailable: '{count} available here',
        previewSkills: 'Skills',
        previewMcp: 'MCP',
        previewNone: 'none',
        previewGateSkills: 'Skill gate',
        previewGateMcp: 'MCP gate',
        previewGated: 'gated',
        previewNotGated: 'not gated',
        previewBusy: 'Resolving…',
        previewFailed: 'Resolve failed',
        rowModes: 'Modes',
        rowWorkspaces: 'Workspaces',
        draftDiscarded: 'These unsaved edits were discarded because the matching resource was deleted elsewhere; copy anything you need to keep:',
        allModes: 'All modes',
        allWorkspaces: 'All workspaces',
        editConditions: 'Conditions',
        hideConditions: 'Hide conditions',
        groupInherit: 'inherit',
        groupInheritTag: ' (inherited)',
        groupSelf: 'custom',
        groupInheritFrom: 'Inherits from source',
        groupUngrouped: 'Ungrouped',
        groupImports: '{count} imports',
        groupImportOne: '{count} import',
        groupExpand: 'Expand',
        groupCollapse: 'Collapse',
        settingsGroups: 'Group switches',
        groupDisabledTag: 'group off',
        groupHint: 'Members of one repository inherit this scope by default; a single resource can opt out.',
        addPathPlaceholder: '/root/workspace/foo then Enter',
        addPath: '+',
        addPathLabel: 'Add workspace path',
        savingItem: 'Saving…',
        removeItem: 'Delete',
        removing: 'Deleting…',
        confirmRemove: 'Confirm delete',
        itemRemoved: 'Deleted',
        toolsUnit: 'tools',
        mountMounting: 'Mounting…',
        mountReady: 'Ready',
        mountFailed: 'Mount failed',
        sourceFrom: 'Source',
        sourceNone: 'No source',
        skillMissing: '(no longer in the inventory; it may have been deleted)',
        // MCP member card: purpose description, injection mode and per-tool rows.
        mcpDescription: 'Purpose description',
        mcpDescriptionPlaceholder: 'What is this MCP server good for?',
        mcpDescriptionHint: 'Used in the discover entry description; empty falls back to the generic one. At most {count} characters.',
        mcpDescribe: 'AI generate',
        mcpDescribing: 'Generating…',
        mcpDescribeFailed: 'Generation failed',
        mcpDescribeEmpty: 'The model returned no usable description',
        mcpInjectMode: 'Tool injection',
        mcpInjectFull: 'Full injection',
        mcpInjectProgressive: 'Progressive injection',
        mcpInjectFullHint: 'Every tool of this server is injected when a session starts.',
        mcpInjectProgressiveHint: 'A session starts with one discover entry and expands the tools only when it is called.',
        mcpGateOff: 'MCP gate is off, progressive injection has no effect',
        mcpToolsTitle: 'Tools',
        mcpToolsLoading: 'Loading tools…',
        mcpToolsFailed: 'Could not read the tool list',
        mcpToolsEmpty: 'No configurable tools right now.',
        mcpToolUnavailable: 'Unavailable',
        mcpToolAmbiguous: 'Name cannot be attributed uniquely; it cannot be configured alone',
        mcpToolClear: 'Clear config',
        mcpScopeHint: 'Per-tool scope and member scope are combined with AND.',
        mcpHint: 'Progressive injection hides tool schemas only; MCP resources and server instructions are unaffected. Expansion is per session and is rediscovered after a restart/reconnect. Per-tool scope and member scope are combined with AND.',
        emptyTitle: 'No resources yet',
        emptyHint: 'Use “Import” in the top-right corner to upload skill files, a ZIP archive, import from Git, or paste MCP JSON. Everything you import joins the pool immediately; conditions are set on its row.',
        systemSkillsTitle: 'System skills',
        systemSkillsHint: 'These skills come from the host or a preset. They are not managed by the pool and are listed for reference only.',
        systemSkillsEmpty: 'No system skills.',
        modelInvocableOff: 'not model-invocable',
        groupEmptySkills: 'No skill resources yet.',
        groupEmptyMcp: 'No MCP resources yet.',
        importTitle: 'Import resources',
        importSubtitle: 'Imported items join the pool immediately and apply to every mode and workspace by default. Set conditions on the resource row afterwards.',
        segFiles: 'Files',
        segZip: 'ZIP',
        segGit: 'Git',
        segMcp: 'MCP',
        overwrite: 'Overwrite resources with the same name',
        filesPick: 'Choose .md files',
        filesPickFolder: 'Choose a skill folder',
        filesChosen: 'Selected',
        filesName: 'Skill name (empty = file name)',
        filesNamePlaceholder: 'my-skill',
        filesDesc: 'Description (empty = frontmatter)',
        filesDescPlaceholder: 'One line about this skill',
        filesBody: 'Or paste Markdown content',
        filesBodyPlaceholder: '---\nname: my-skill\ndescription: One line\n---\n\n# Instructions',
        filesNeed: 'Choose a file or paste content',
        filesTooLarge: 'File too large (5 MB max)',
        filesReadFailed: 'Could not read the file',
        zipPick: 'Choose a .zip file',
        zipChosen: 'Selected',
        zipLabel: 'Source name (empty = auto-detect)',
        zipNeed: 'Choose a ZIP file first',
        zipTooLarge: 'Archive too large (20 MB max)',
        gitUrl: 'Repository URL',
        gitUrlPlaceholder: 'https://gitlab.company.com/group/repo or …/-/tree/main/skills',
        gitBranch: 'Branch / tag',
        gitSubdir: 'Subdirectory (optional)',
        gitType: 'Repository type',
        gitTypeAuto: 'Detect automatically',
        gitTypeGitlab: 'GitLab (incl. self-hosted)',
        gitTypeGithub: 'GitHub / GHE',
        gitTypeHint: 'Paste a self-hosted GitLab repository or /-/tree/ link directly; add a token for private repos.',
        gitToken: 'Access token (private repos, optional)',
        gitTokenHint: 'The token goes to the Host credential store; the state file keeps only its name.',
        gitLabel: 'Source name (optional)',
        gitNeedUrl: 'Enter a repository URL first',
        gitRunning: 'Fetching repository… (45 s max)',
        mcpJson: 'mcpServers JSON',
        mcpJsonHint: 'Import returns immediately; servers mount in the background and the status refreshes live.',
        mcpJsonInvalid: 'Enter JSON first',
        mcpJsonBad: 'Could not parse JSON',
        mcpNotice: 'Import submitted:',
        mcpMountBackground: 'Mounting continues in the background; check the resource list for status.',
        importSubmit: 'Import',
        importing: 'Importing…',
        importInstalled: 'Imported',
        importFailures: 'Failed',
        importPartial: 'Partially imported',
        importDone: 'Done',
        importRetryHint: 'Fix the input and retry; successful resources are already in the pool.',
        sourcesHint: 'Git sources support checking for updates and updating; ZIP / file sources are read-only.',
        checkAll: 'Check all for updates',
        checkingAll: 'Checking…',
        sourceCheck: 'Check',
        sourceChecking: 'Checking…',
        sourceUpdate: 'Update',
        sourceUpdating: 'Updating…',
        sourceDelete: 'Delete',
        sourceDeleting: 'Deleting…',
        sourceDeleteConfirm: 'Only skills not referenced by another source are deleted',
        sourceDeleteYes: 'Confirm delete',
        sourceDeleteCancel: 'Cancel',
        sourceKindGit: 'Git',
        sourceKindZip: 'ZIP',
        sourceKindFiles: 'Files',
        sourceKindUnknown: 'Source',
        sourceSkillsUnit: 'skills',
        sourceSkillsUnitOne: 'skill',
        sourceSha: 'commit',
        sourceDigest: 'digest',
        sourceCreatedAt: 'created',
        sourceReadOnly: 'read-only',
        sourceNotGit: 'This source does not support update checks',
        lastCheck: 'Last check',
        neverChecked: 'Not checked',
        statusUpToDate: 'Up to date',
        statusUpdateAvailable: 'Update available',
        statusError: 'Check failed',
        sourcesEmpty: 'No sources yet. Importing a ZIP / files / Git repository records one automatically.',
        checkResult: 'Checked: {updated} with updates, {upToDate} up to date, {failed} failed',
        noticeSourceUpdated: 'Source updated',
        sourceExcluded: 'excluded: {count}',
        sourceRestore: 'Restore excluded',
        sourceRestoreHint: 'Deleted skills are no longer installed by updates; restore installs them again',
        sourceRestoring: 'Restoring…',
        noticeSourceRestored: 'Excluded skills restored',
        noticeGroupUpdated: 'Group updated ({count} skills)',
        noticeSourceUpToDate: 'Source already up to date',
        noticeSourceDeleted: 'Source deleted',
        sourceSkipped: ' ({count} skills kept because another source references them)',
        noticeSourceChecked: 'Check completed',
        settingsHint: 'Changes apply immediately; sessions that already started keep the state they began with.',
        setEnabled: 'Master switch',
        setEnabledHint: 'Off leaves every session completely untouched.',
        setMcpGate: 'MCP gate',
        setMcpGateHint: 'Hide the tools of MCP servers that do not match.',
        setGateDefaultSkills: 'Strictly hide system skills',
        setGateDefaultSkillsHint: 'Not enabled yet (system skills are always available).',
        stateFile: 'State file',
        version: 'Version',
        settingsSaved: 'Settings saved',
        settingsSaving: 'Saving…',
        notAvailable: 'not enabled yet',
        missingFile: 'Missing files',
        missingFileHint: 'The skill files are gone from disk; import it again or delete this row.',
        deleteSkillConfirm: 'Delete? Its files are removed and this source will not install it again',
        deleteMcpConfirm: 'Delete? This MCP server is unmounted too',
        selectAll: 'Select all',
        clearAll: 'Clear',
        noMatches: 'No matches.',
        addNoneSelected: 'Nothing selected',
      },
    }[ZH ? 'zh' : 'en']

    const t = (key) => {
      const value = TEXT[key]
      return typeof value === 'string' ? value : String(key)
    }

    /** Interpolate `{name}` placeholders in a localized string. */
    function tf(key, vars) {
      const template = t(key)
      const source = vars && typeof vars === 'object' ? vars : {}
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(source, name) ? String(source[name]) : match,
      )
    }

    /** Absolute route prefix (contract v3 §6). */
    const API = '/dsh-skill-pool'
    const DEFAULT_SETTINGS = Object.freeze({
      enabled: true,
      mcpGate: true,
      gateDefaultSkills: false,
    })
    const EMPTY_INVENTORY = Object.freeze({
      skills: [],
      nativeSkills: [],
      mcp: [],
      modes: [],
      workspaces: [],
      defaultMode: '',
    })
    const EMPTY_STATE = Object.freeze({
      version: 4,
      settings: DEFAULT_SETTINGS,
      skills: {},
      mcp: {},
      sources: {},
      groups: {},
    })
    const TABS = Object.freeze([
      ['resources', 'tabResources'],
      ['sources', 'tabSources'],
      ['settings', 'tabSettings'],
    ])
    const SKILL = 'skill'
    const MCP = 'mcp'
    const ITEM_DEBOUNCE_MS = 320
    const ROW_DRAFT_KEYS = Object.freeze([
      'enabled',
      'modes',
      'workspaces',
      'modesFrom',
      'workspacesFrom',
    ])
    // Mirrors the Host's limits so the panel can stop an invalid draft before
    // it reaches a route that would reject it with 400.
    const MCP_DESCRIPTION_LIMIT = 500
    const MCP_TOOL_KEY_LIMIT = 128
    const MOUNT_POLL_MS = 1600
    const MAX_UPLOAD_BYTES = 5 * 1024 * 1024
    const MAX_ZIP_BYTES = 20 * 1024 * 1024

    /**
     * Read the branch and sub-directory out of a pasted repository web URL.
     *
     * Mirrors `parseRepoUrl` in `src/library.js`, which is the authority for the
     * Host; this copy exists only so the form can prefill the two fields. Both
     * shapes must be handled here or the fields stay empty while the import still
     * works, which reads as "the URL was not recognised":
     *
     *   GitLab  <host>/<group>/<repo>/-/tree/<branch>/<subdir>
     *   GitHub  <host>/<owner>/<repo>/tree/<branch>/<subdir>
     *
     * @param {string} value - raw text from the URL field.
     * @returns {{branch: string, subdir: string}|undefined} parsed hint, if any.
     */
    function deepLinkHint(value) {
      const text = asString(value).trim()
      if (text.length === 0) return undefined
      const gitlab = /\/-\/(?:tree|blob|src)\/([^/?#]+)(?:\/([^?#]+))?/.exec(text)
      const github = /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/(?:tree|blob|raw)\/([^/?#]+)(?:\/([^?#]+))?/.exec(text)
      const match = gitlab ?? github
      if (match === null) return undefined
      const branch = asString(match[1]).replace(/\/+$/, '')
      let subdir = asString(match[2]).replace(/\/+$/, '')
      // A link to a file names its directory for the importer.
      if (/\.md$/i.test(subdir)) subdir = subdir.split('/').slice(0, -1).join('/')
      return { branch, subdir }
    }

    // ------------------------------------------------------------------ utils

    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    function asObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
    }

    function asString(value, fallback) {
      if (typeof value === 'string') return value
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
      return fallback === undefined ? '' : fallback
    }

    function asNumber(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback
    }

    function asBool(value, fallback) {
      return typeof value === 'boolean' ? value : fallback
    }

    function uniqueStrings(values) {
      const seen = new Set()
      const out = []
      for (const item of asArray(values)) {
        if (typeof item !== 'string') continue
        const text = item.trim()
        if (text.length === 0 || seen.has(text)) continue
        seen.add(text)
        out.push(text)
      }
      return out
    }

    function asStringArray(value) {
      return uniqueStrings(value)
    }

    function messageOf(cause) {
      if (cause instanceof Error) return cause.message || String(cause)
      return String(cause === undefined || cause === null ? '' : cause)
    }

    /**
     * Readable failure text from an API failure body.
     *
     * Most routes answer `{ok:false, error:{code,message}}`, but `/mcp/describe`
     * answers the flat `{ok:false, error:<code>, message}` shape. The panel must
     * show the reason for both instead of a bare HTTP status; a body without a
     * message falls back to the code.
     */
    function failureTextOf(payload) {
      const source = asObject(payload)
      const error = source.error
      if (typeof error === 'string') {
        const code = error.trim()
        const message = asString(source.message).trim()
        if (message.length === 0) return code
        return code.length === 0 ? message : `${code}: ${message}`
      }
      const detail = asObject(error)
      const message = asString(detail.message).trim()
      return message.length > 0 ? message : asString(detail.code).trim()
    }

    function baseName(path) {
      const text = asString(path).replace(/\\/g, '/')
      const parts = text.split('/').filter((part) => part.length > 0)
      return parts.length > 0 ? parts[parts.length - 1] : text
    }

    function normalizePath(value) {
      const text = asString(value).trim().replace(/\\/g, '/')
      if (text.length === 0) return ''
      const trimmed = text.replace(/\/+$/, '')
      return trimmed.length === 0 ? '/' : trimmed
    }

    function formatTime(value) {
      const text = asString(value)
      if (text.length === 0) return ''
      const date = new Date(text)
      if (Number.isNaN(date.getTime())) return text
      return date.toLocaleString()
    }

    function shortDigest(value) {
      const text = asString(value).replace(/^sha256:/, '')
      return text.length > 10 ? text.slice(0, 8) + '…' : text
    }

    /**
     * Strip the characters the `/mcp/config` route rejects (C0 controls and DEL)
     * before a draft is shown or sent. The textarea must never hand the Host a
     * value it will answer with 400, including pasted multi-line text.
     */
    function cleanPanelDescription(raw) {
      return asString(raw)
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .slice(0, MCP_DESCRIPTION_LIMIT)
    }

    /** Normalize one per-tool scope, defaulting to enabled/unrestricted. */
    function normalizeToolScope(raw) {
      const source = asObject(raw)
      return {
        enabled: source.enabled !== false,
        modes: asStringArray(source.modes),
        workspaces: uniqueStrings(asArray(source.workspaces).map(normalizePath)),
      }
    }

    /**
     * Normalize the per-tool configuration map of one MCP member.
     *
     * The Host accepts only keys that can be MCP tool names, and the panel keeps
     * the same rule so a malformed draft can never become a toggle that writes
     * something the route will reject. An unusable entry is dropped.
     */
    function normalizeMcpTools(raw) {
      const source = asObject(raw)
      const out = {}
      for (const [key, value] of Object.entries(source)) {
        if (typeof key !== 'string' || !key.startsWith('mcp__') || key.length > MCP_TOOL_KEY_LIMIT) continue
        out[key] = normalizeToolScope(value)
      }
      return out
    }

    /**
     * Scope-only projection of a member. Row drafts carry exactly these keys:
     * copying the whole entry would let an unsaved scope draft restore stale
     * `description`/`disclosure`/`tools` over newer saved values on a reload.
     */
    function rowDraftOf(raw) {
      const source = asObject(raw)
      return {
        enabled: source.enabled !== false,
        modes: asStringArray(source.modes),
        workspaces: uniqueStrings(asArray(source.workspaces).map(normalizePath)),
        modesFrom: asString(source.modesFrom) === 'self' ? 'self' : 'group',
        workspacesFrom: asString(source.workspacesFrom) === 'self' ? 'self' : 'group',
      }
    }

    function blankEntry() {
      return {
        enabled: true,
        modes: [],
        workspaces: [],
        modesFrom: 'group',
        workspacesFrom: 'group',
        sourceId: '',
        digest: '',
        installedAt: '',
        description: '',
        disclosure: 'full',
        tools: {},
      }
    }

    function normalizeEntry(raw) {
      const source = asObject(raw)
      const entry = {
        ...rowDraftOf(source),
        sourceId: asString(source.sourceId),
        digest: asString(source.digest),
        installedAt: asString(source.installedAt),
        description: cleanPanelDescription(source.description),
        disclosure: source.disclosure === 'progressive' ? 'progressive' : 'full',
        tools: normalizeMcpTools(source.tools),
      }
      return entry
    }

    /** Build the `/item` request body for one pending row save. */
    function buildItemSaveBody(job) {
      const entry = asObject(job.entry)
      return {
        kind: job.kind,
        name: job.name,
        enabled: entry.enabled !== false,
        modes: asStringArray(entry.modes),
        workspaces: uniqueStrings(asArray(entry.workspaces).map(normalizePath)),
        modesFrom: entry.modesFrom === 'self' ? 'self' : 'group',
        workspacesFrom: entry.workspacesFrom === 'self' ? 'self' : 'group',
      }
    }

    /**
     * Build the `/mcp/tool` request body for one pending per-tool save.
     *
     * A clear request carries only the identity: sending `enabled`/`modes` with
     * `clear` would make the route's intent ambiguous. Any other draft is sent in
     * full so one toggle can never drop the tool's other fields.
     */
    function buildToolSaveBody(server, tool, draft) {
      const source = asObject(draft)
      if (source.clear === true) return { server, tool, clear: true }
      const scope = normalizeToolScope(source)
      return {
        server,
        tool,
        enabled: scope.enabled,
        modes: scope.modes,
        workspaces: scope.workspaces,
      }
    }

    /**
     * Remove the config fields a completed save wrote from the local draft map.
     *
     * A request carries only the fields the user changed; deleting the whole
     * server entry would throw away a newer draft that was never sent (for
     * example an AI-generated description followed by an injection-mode save).
     * A field still queued or holding a newer local value is kept.
     */
    function configDraftAfterSave(draft, patch, queued) {
      const source = asObject(draft)
      const sent = asObject(patch)
      const waiting = asObject(queued)
      const out = { ...source }
      for (const key of ['description', 'disclosure']) {
        if (sent[key] === undefined) continue
        if (waiting[key] !== undefined) continue
        if (Object.hasOwn(out, key) && out[key] === sent[key]) delete out[key]
      }
      return out
    }

    /**
     * Parse the host's redacted re-application warning. Kept as a pure helper so
     * the panel tests can assert it persists until explicitly dismissed.
     */
    function activationWarningOf(payload) {
      const warning = asObject(payload && payload.warning)
      const message = asString(warning.message).trim()
      if (message.length === 0) return null
      return { code: asString(warning.code), message }
    }

    /** Merge a response warning without clearing an existing one on success. */
    function mergeActivationWarning(current, payload) {
      return activationWarningOf(payload) || current || null
    }

    /** An explicit close clears the banner; nothing time-based does. */
    function dismissActivationWarning() {
      return null
    }

    function normalizeSettings(raw) {
      const source = asObject(raw)
      return {
        enabled: source.enabled !== false,
        mcpGate: source.mcpGate !== false,
        gateDefaultSkills: source.gateDefaultSkills === true,
      }
    }

    function normalizeScope(raw) {
      const source = asObject(raw)
      return {
        modes: asStringArray(source.modes),
        workspaces: uniqueStrings(asArray(source.workspaces).map(normalizePath)),
      }
    }

    function normalizeItemMap(raw) {
      const source = asObject(raw)
      const out = {}
      for (const [name, entry] of Object.entries(source)) {
        const key = asString(name).trim()
        if (key.length === 0) continue
        out[key] = normalizeEntry(entry)
      }
      return out
    }

    function normalizeLastCheck(raw) {
      const source = asObject(raw)
      const status = asString(source.status)
      return {
        at: asString(source.at),
        status:
          status === 'up-to-date' || status === 'update-available' || status === 'error' ? status : '',
        remote: asString(source.remote),
        error: asString(source.error),
      }
    }

    function normalizeSource(raw, fallbackId) {
      const source = asObject(raw)
      return {
        id: asString(source.id) || asString(fallbackId),
        kind: asString(source.kind) || 'files',
        label: asString(source.label),
        provider: asString(source.provider),
        project: asString(source.project),
        branch: asString(source.branch),
        subdir: asString(source.subdir),
        skills: asStringArray(source.skills),
        excluded: asStringArray(source.excluded),
        digest: asString(source.digest),
        sha: asString(source.sha),
        lastCheck: normalizeLastCheck(source.lastCheck),
        createdAt: asString(source.createdAt),
        updatedAt: asString(source.updatedAt),
      }
    }

    function normalizeGroup(raw, fallbackKey) {
      const source = asObject(raw)
      const key = asString(source.key) || asString(fallbackKey)
      if (key.length === 0) return null
      return {
        key,
        kind: asString(source.kind) === 'import' || key.startsWith('import:') ? 'import' : 'repo',
        enabled: source.enabled !== false,
        modes: asStringArray(source.modes),
        workspaces: uniqueStrings(asArray(source.workspaces).map(normalizePath)),
      }
    }

    function normalizeGroups(raw) {
      const source = asObject(raw)
      const out = {}
      for (const [key, value] of Object.entries(source)) {
        const group = normalizeGroup(value, key)
        if (group) out[group.key] = group
      }
      return out
    }

    function normalizeState(raw) {
      const source = asObject(raw)
      const sourcesRaw = asObject(source.sources)
      const sources = {}
      for (const [id, item] of Object.entries(sourcesRaw)) {
        const entry = normalizeSource(item, id)
        const key = entry.id || asString(id)
        if (key.length === 0) continue
        sources[key] = entry
      }
      return {
        version: asNumber(source.version, 4),
        settings: normalizeSettings(source.settings),
        skills: normalizeItemMap(source.skills),
        mcp: normalizeItemMap(source.mcp),
        sources,
        groups: normalizeGroups(source.groups),
      }
    }

    /** Modes come back as `string[]` in v3; objects are accepted defensively. */
    function normalizeModeList(raw) {
      const out = []
      const seen = new Set()
      for (const item of asArray(raw)) {
        const row = typeof item === 'string' ? { id: item } : asObject(item)
        const id = asString(row.id || row.value || row.name).trim()
        if (id.length === 0 || seen.has(id)) continue
        seen.add(id)
        out.push({ id, name: asString(row.name) || id })
      }
      return out
    }

    /** Workspaces come back as `string[]` (absolute paths) in v3. */
    function normalizeWorkspaceList(raw) {
      const out = []
      const seen = new Set()
      for (const item of asArray(raw)) {
        const row = typeof item === 'string' ? { path: item } : asObject(item)
        const path = normalizePath(row.path || row.value)
        if (path.length === 0 || seen.has(path)) continue
        seen.add(path)
        out.push({ id: asString(row.id), name: asString(row.name) || baseName(path), path })
      }
      return out
    }

    function normalizeInventory(raw) {
      const source = asObject(raw)
      const skills = []
      for (const item of asArray(source.skills)) {
        const row = asObject(item)
        const name = asString(row.name).trim()
        if (name.length === 0) continue
        skills.push({
          name,
          description: asString(row.description),
          path: asString(row.path),
          dir: asString(row.dir),
          missing: row.missing === true,
          sourceId: asString(row.sourceId),
          sourceLabel: asString(row.sourceLabel),
          enabled: row.enabled !== false,
          modes: asStringArray(row.modes),
          workspaces: uniqueStrings(asArray(row.workspaces).map(normalizePath)),
          modesFrom: asString(row.modesFrom) === 'self' ? 'self' : 'group',
          workspacesFrom: asString(row.workspacesFrom) === 'self' ? 'self' : 'group',
          groupKey: asString(row.groupKey),
          groupName: asString(row.groupName),
          effectiveModes: asStringArray(row.effectiveModes),
          effectiveWorkspaces: uniqueStrings(asArray(row.effectiveWorkspaces).map(normalizePath)),
          digest: asString(row.digest),
          installedAt: asString(row.installedAt),
          modelInvocable: row.modelInvocable !== false,
        })
      }
      skills.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

      const nativeSkills = []
      for (const item of asArray(source.nativeSkills)) {
        const row = asObject(item)
        const name = asString(row.name).trim()
        if (name.length === 0) continue
        nativeSkills.push({
          name,
          description: asString(row.description),
          source: asString(row.source),
          provider: asString(row.provider),
        })
      }
      nativeSkills.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

      // v3 field is `mcp[].server`; `mcpServers[].serverName` is tolerated only for reads.
      const mcpRows = asArray(source.mcp).length > 0 ? asArray(source.mcp) : asArray(source.mcpServers)
      const mcp = []
      for (const item of mcpRows) {
        const row = asObject(item)
        const server = asString(row.server || row.serverName).trim()
        if (server.length === 0) continue
        const tools = asStringArray(row.tools)
        mcp.push({
          server,
          tools,
          toolCount: asNumber(row.toolCount, tools.length),
          managed: row.managed === true,
          entryId: asString(row.entryId),
          enabled: row.enabled !== false,
          modes: asStringArray(row.modes),
          workspaces: uniqueStrings(asArray(row.workspaces).map(normalizePath)),
          installedAt: asString(row.installedAt),
        })
      }
      mcp.sort((left, right) => (left.server < right.server ? -1 : left.server > right.server ? 1 : 0))

      return {
        skills,
        nativeSkills,
        mcp,
        modes: normalizeModeList(source.modes),
        workspaces: normalizeWorkspaceList(source.workspaces),
        defaultMode: asString(source.defaultMode),
      }
    }

    function normalizeMount(raw) {
      const out = {}
      const rows = Array.isArray(raw)
        ? raw.map((item) => {
            const row = asObject(item)
            return [asString(row.server || row.serverName || row.name), row]
          })
        : Object.entries(asObject(raw))
      for (const [rawKey, value] of rows) {
        const key = asString(rawKey).trim()
        if (key.length === 0) continue
        const row = typeof value === 'string' ? { state: value } : asObject(value)
        const state = asString(row.state)
        out[key] = {
          state: state === 'mounting' || state === 'failed' ? state : 'ready',
          error: asString(row.error),
        }
      }
      return out
    }

    function normalizePool(raw) {
      const source = asObject(raw)
      return {
        mode: asString(source.mode),
        cwd: asString(source.cwd),
        gated: source.gated === true,
        gateSkills: source.gateSkills === true,
        gateMcp: source.gateMcp === true,
        skills: asStringArray(source.skills),
        mcpServers: asStringArray(source.mcpServers),
      }
    }

    async function request(path, options) {
      const init = {
        method: asString(options && options.method, 'GET'),
        headers: { accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
      }
      if (init.method !== 'GET') {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify((options && options.body) || {})
      }
      let response
      try {
        response = await fetch(path, init)
      } catch (cause) {
        throw new Error(`${TEXT.networkFailed}: ${messageOf(cause)}`)
      }
      const payload = await response.json().catch(() => null)
      // Accept both failure shapes: most routes nest `{error:{code,message}}`,
      // while `/mcp/describe` returns `{ok:false, error:<code>, message}`.
      const apiError = payload && typeof payload === 'object' ? failureTextOf(payload) : ''
      if (!response.ok) throw new Error(apiError || `HTTP ${response.status}`)
      if (!payload || typeof payload !== 'object' || payload.ok !== true) {
        throw new Error(apiError || TEXT.badResponse)
      }
      return payload
    }

    function withEntry(state, kind, name, entry) {
      const key = kind === MCP ? 'mcp' : 'skills'
      return { ...state, [key]: { ...state[key], [name]: entry } }
    }

    function withoutEntry(state, kind, name) {
      const key = kind === MCP ? 'mcp' : 'skills'
      const next = { ...state[key] }
      delete next[name]
      return { ...state, [key]: next }
    }

    /**
     * Stable queue key for one per-tool save. A NUL separator cannot appear in a
     * server or public tool name, so two members can never collide.
     */
    function mcpToolJobKey(server, tool) {
      return `${asString(server)}\u0000${asString(tool)}`
    }

    /** Split a `server\0tool` job key back into its two names. */
    function mcpToolJobParts(key) {
      const text = asString(key)
      const separator = text.indexOf('\u0000')
      if (separator <= 0) return null
      return { server: text.slice(0, separator), tool: text.slice(separator + 1) }
    }

    /** Split a `kind:name` row key into its namespace and member name. */
    function rowKeyOf(key) {
      if (typeof key !== 'string') return null
      if (key.startsWith('mcp:')) return { kind: MCP, name: key.slice(4) }
      if (key.startsWith('skill:')) return { kind: 'skill', name: key.slice(6) }
      return null
    }

    /** Whether the loaded document still contains this row. */
    function hasLoadedMember(loadedState, key) {
      const row = rowKeyOf(key)
      if (row === null) return false
      const bucket = row.kind === MCP ? loadedState.mcp : loadedState.skills
      return bucket !== null && typeof bucket === 'object' && Object.hasOwn(bucket, row.name)
    }

    /**
     * Drafts whose member is gone from the authoritative document.
     *
     * The panel surfaces these as a visible warning (with the unsaved text)
     * instead of silently discarding them; they must never be rendered as rows.
     */
    function orphanedDrafts(loadedState, drafts) {
      const out = []
      if (!drafts || typeof drafts[Symbol.iterator] !== 'function') return out
      for (const [key, entry] of drafts) {
        if (rowKeyOf(key) === null || entry === null || typeof entry !== 'object') continue
        if (!hasLoadedMember(loadedState, key)) out.push({ key, entry })
      }
      return out
    }

    /**
     * Overlay unsaved row drafts on a document loaded from the Host.
     *
     * A debounced/in-flight/failed save is a local draft that the server does
     * not know yet; a GET response must not make the user's text disappear. A
     * draft whose member is gone is skipped (never turned into a phantom row).
     */
    function mergeRowDrafts(loadedState, drafts) {
      let next = loadedState
      if (!drafts || typeof drafts[Symbol.iterator] !== 'function') return next
      for (const [key, entry] of drafts) {
        const row = rowKeyOf(key)
        if (row === null || entry === null || typeof entry !== 'object') continue
        // Never resurrect a member the authoritative document no longer has:
        // another tab may have deleted it while this draft was being typed.
        if (!hasLoadedMember(loadedState, key)) continue
        const bucket = row.kind === MCP ? next.mcp : next.skills
        const loaded = bucket[row.name] || {}
        // A row draft owns the scope only; never let it roll back MCP display or
        // per-tool fields that a newer save may have written.
        const patch = {}
        for (const field of ROW_DRAFT_KEYS) {
          if (Object.hasOwn(entry, field)) patch[field] = entry[field]
        }
        next = withEntry(next, row.kind, row.name, { ...loaded, ...patch })
      }
      return next
    }

    /**
     * Decide what a completed GET may replace.
     *
     * A load started at revision R may only apply its document when no local
     * edit or save response landed meanwhile; otherwise it keeps the current
     * rows and refreshes only the derived views. When the revision still
     * matches, per-row drafts are merged over the server document so a
     * failure-triggered reload cannot drop an unsaved edit.
     *
     * @param {object|null} current - board currently rendered.
     * @param {{state: object, inventory: object, mounts: object, meta: object}} loaded - response.
     * @param {{startedRevision: number, currentRevision: number, drafts: Map<string, object>}} options - race inputs.
     * @returns {object} board to render.
     */
    function applyLoadedBoard(current, loaded, options) {
      if (!current) return loaded
      const refreshed = { ...current, inventory: loaded.inventory, mounts: loaded.mounts, meta: loaded.meta }
      if (options.startedRevision !== options.currentRevision) return refreshed
      return { ...loaded, state: mergeRowDrafts(loaded.state, options.drafts) }
    }

    /**
     * Apply one save response to the current document.
     *
     * A save response is a snapshot from the moment that write completed; if the
     * member was deleted in another tab before the response was rendered, adding
     * it back would create a phantom row that every later save rejects with 400.
     */
    function applyItemSave(currentState, kind, name, canonical) {
      const bucket = kind === MCP ? currentState.mcp : currentState.skills
      if (bucket === null || typeof bucket !== 'object' || !Object.hasOwn(bucket, name)) return currentState
      // No canonical member means no safe partial update; never fall back to the
      // response's whole document, which may still contain removed rows.
      return canonical ? withEntry(currentState, kind, name, canonical) : currentState
    }

    /** Visible warning text for drafts that lost their member while unsaved. */
    function draftLossMessage(orphans) {
      const parts = orphans.map((orphan) => {
        const row = rowKeyOf(orphan.key)
        const entry = asObject(orphan.entry)
        const text = JSON.stringify({
          enabled: entry.enabled !== false,
          modes: asStringArray(entry.modes),
          workspaces: asStringArray(entry.workspaces),
        })
        return `${row ? row.name : orphan.key}: ${text}`
      })
      return `${TEXT.draftDiscarded} ${parts.join(' | ')}`
    }

    function summarizeList(values, allLabel, labeler, limit) {
      const list = asStringArray(values)
      if (list.length === 0) return allLabel
      const labels = list.map((value) => (typeof labeler === 'function' ? labeler(value) : value))
      const max = typeof limit === 'number' ? limit : 2
      if (labels.length <= max) return labels.join(' / ')
      return `${labels.slice(0, max).join(' / ')} +${labels.length - max}`
    }

    function kindLabel(kind) {
      if (kind === 'git') return TEXT.sourceKindGit
      if (kind === 'zip') return TEXT.sourceKindZip
      if (kind === 'files') return TEXT.sourceKindFiles
      return TEXT.sourceKindUnknown
    }

    function mountLabel(state) {
      if (state === 'mounting') return TEXT.mountMounting
      if (state === 'failed') return TEXT.mountFailed
      return TEXT.mountReady
    }

    function mountDotStyle(state) {
      if (state === 'mounting') return S.dotMounting
      if (state === 'failed') return S.dotFailed
      return S.dotReady
    }

    function statusLabel(status) {
      if (status === 'up-to-date') return TEXT.statusUpToDate
      if (status === 'update-available') return TEXT.statusUpdateAvailable
      if (status === 'error') return TEXT.statusError
      return TEXT.neverChecked
    }

    /** Combined check status of one repository group ('' when nothing checked). */
    function sourceGroupStatus(rows) {
      const checked = (Array.isArray(rows) ? rows : []).filter(
        (row) => row && row.lastCheck && asString(row.lastCheck.status).length > 0,
      )
      if (checked.length === 0) return ''
      if (checked.some((row) => row.lastCheck.status === 'update-available')) return 'update-available'
      if (checked.some((row) => row.lastCheck.status === 'error')) return 'error'
      return 'up-to-date'
    }

    function statusBadgeStyle(status) {
      if (status === 'up-to-date') return { ...S.badge, ...S.badgeOn }
      if (status === 'update-available') return { ...S.badge, ...S.badgeWarn }
      if (status === 'error') return { ...S.badge, ...S.badgeError }
      return S.badge
    }

    // ------------------------------------------------------------- file utils

    function bytesToBase64(bytes) {
      let binary = ''
      const chunk = 0x8000
      for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk))
      }
      return btoa(binary)
    }

    function encodeTextBase64(text) {
      return bytesToBase64(new TextEncoder().encode(asString(text)))
    }

    function readFileBase64(file) {
      return Promise.resolve()
        .then(() => file.arrayBuffer())
        .then((buffer) => bytesToBase64(new Uint8Array(buffer)))
    }
    // ----------------------------------------------------------------- styles

    const S = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        minHeight: 0,
        fontSize: '13px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-primary)',
        // The Host sets this token on <body>; form controls do not inherit it,
        // so the panel declares it here and resets controls in the style block.
        fontFamily:
          'var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif)',
      },
      headerRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' },
      titleWrap: { minWidth: 0 },
      title: { margin: 0, fontSize: '18px', fontWeight: 600, lineHeight: 1.3 },
      subtitle: { margin: '4px 0 0', fontSize: '13px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5, maxWidth: '760px' },
      toolbar: { display: 'flex', alignItems: 'flex-start', gap: '8px', flex: '0 0 auto', paddingTop: '2px' },
      statusBar: {
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        border: '1px solid var(--rp-line)',
        background: 'var(--rp-card-2)',
        borderRadius: '10px',
        padding: '8px 12px',
      },
      statusMain: { display: 'flex', alignItems: 'center', gap: '8px', flex: '0 0 auto' },
      statusLabel: { fontSize: '13px', fontWeight: 500 },
      onText: { fontSize: '13px', color: 'var(--dsw-alias-state-success-primary)' },
      offText: { fontSize: '13px', color: 'var(--dsw-alias-state-error-primary)' },
      chipRow: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '2px 9px',
        borderRadius: '999px',
        border: '1px solid var(--rp-line)',
        background: 'var(--rp-card)',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary)',
        maxWidth: '460px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      chipDot: { width: '6px', height: '6px', borderRadius: '999px', background: 'var(--rp-accent)' },
      // Tabs are pills, never underlines. An underline needs a border on the
      // container or on every tab, and any of those can survive a state change and
      // read as a stray white line. A tinted pill has exactly one source of truth:
      // the active tab's own background.
      tabs: { display: 'flex', gap: '4px' },
      tab: {
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        padding: '5px 12px',
        borderRadius: '7px',
        fontSize: '13px',
        lineHeight: 1.4,
        cursor: 'pointer',
        outline: 'none',
      },
      tabActive: {
        background: 'var(--rp-accent-weak)',
        color: 'var(--rp-accent)',
        fontWeight: 600,
      },
      error: {
        border: '1px solid var(--dsw-alias-state-error-primary)',
        background: 'var(--rp-card)',
        color: 'var(--dsw-alias-state-error-primary)',
        borderRadius: '8px',
        padding: '7px 10px',
        fontSize: '13px',
        lineHeight: 1.5,
        wordBreak: 'break-word',
      },
      notice: {
        border: '1px solid var(--dsw-alias-state-success-primary)',
        background: 'var(--rp-card)',
        color: 'var(--dsw-alias-state-success-primary)',
        borderRadius: '8px',
        padding: '7px 10px',
        fontSize: '13px',
      },
      activationWarning: {
        border: '1px solid var(--rp-warn, var(--dsw-alias-state-warn-primary))',
        background: 'var(--rp-card)',
        color: 'var(--rp-warn, var(--dsw-alias-state-warn-primary))',
        borderRadius: '8px',
        padding: '7px 10px',
        fontSize: '13px',
        lineHeight: 1.5,
        wordBreak: 'break-word',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
      },
      noticeText: { fontSize: '13px', color: 'var(--dsw-alias-state-success-primary)', alignSelf: 'center' },
      empty: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)', padding: '14px 4px', lineHeight: 1.6 },
      loadingRow: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' },
      button: {
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
        height: '30px',
        whiteSpace: 'nowrap',
        lineHeight: 1,
        border: '1px solid var(--rp-line)',
        background: 'var(--rp-card)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '8px',
        padding: '0 12px',
        fontSize: '13px',
        cursor: 'pointer',
      },
      buttonSmall: {
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
        height: '26px',
        whiteSpace: 'nowrap',
        lineHeight: 1,
        border: '1px solid var(--rp-line)',
        background: 'var(--rp-card)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '7px',
        padding: '0 9px',
        fontSize: '12px',
        cursor: 'pointer',
      },
      buttonPrimary: {
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
        height: '30px',
        whiteSpace: 'nowrap',
        lineHeight: 1,
        border: '1px solid var(--rp-accent)',
        background: 'var(--rp-accent)',
        // White on the blue accent in both themes; the inverted-label token would
        // turn dark-on-blue in the light theme.
        color: '#fff',
        borderRadius: '8px',
        padding: '0 12px',
        fontSize: '13px',
        fontWeight: 500,
        cursor: 'pointer',
      },
      buttonDanger: {
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
        height: '28px',
        whiteSpace: 'nowrap',
        lineHeight: 1,
        border: '1px solid var(--dsw-alias-state-error-primary)',
        background: 'var(--rp-card-2)',
        color: 'var(--dsw-alias-state-error-primary)',
        borderRadius: '8px',
        padding: '0 12px',
        fontSize: '13px',
        fontWeight: 500,
        cursor: 'pointer',
      },
      linkButton: {
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: 'var(--rp-accent)',
        cursor: 'pointer',
        fontSize: '12px',
        padding: '0 2px',
        fontFamily: 'inherit',
      },
      ghostDanger: {
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '22px',
        whiteSpace: 'nowrap',
        border: '1px solid var(--rp-line)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        borderRadius: '6px',
        padding: '0 8px',
        fontSize: '12px',
        cursor: 'pointer',
        flex: '0 0 auto',
      },
      toggleTrack: {
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        flex: '0 0 auto',
        width: '38px',
        height: '20px',
        padding: '2px',
        border: '1px solid var(--rp-line-strong)',
        borderRadius: '999px',
        background: 'var(--rp-card)',
        cursor: 'pointer',
      },
      toggleTrackOn: {
        borderColor: 'var(--rp-accent)',
        background: 'var(--rp-accent)',
        justifyContent: 'flex-end',
      },
      toggleKnob: { display: 'block', width: '14px', height: '14px', borderRadius: '999px', background: 'var(--dsw-alias-label-secondary)' },
      toggleKnobOn: { background: '#fff' },
      switchRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', padding: '6px 0' },
      switchText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      switchLabel: { fontSize: '13px', fontWeight: 500 },
      stack: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 },
      card: {
        border: '1px solid var(--rp-line)',
        borderRadius: '12px',
        background: 'var(--rp-card)',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        minWidth: 0,
      },
      // A namespace accent stripe: skills are content (brand), MCP is a connection
      // (amber). The stripe is the fastest way to tell the two groups apart.
      cardSkill: { borderLeft: '3px solid var(--rp-accent)' },
      cardMcp: { borderLeft: '3px solid var(--rp-mcp)' },
      cardSystem: { borderLeft: '3px solid var(--rp-line-strong)' },
      cardHead: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        flexWrap: 'wrap',
        paddingBottom: '8px',
        borderBottom: '1px solid var(--rp-line)',
      },
      cardTitleRow: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 },
      cardTitle: { fontSize: '14px', fontWeight: 600 },
      countBadge: {
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)',
        border: '1px solid var(--rp-line)',
        borderRadius: '999px',
        padding: '0 7px',
        lineHeight: '16px',
      },
      cardDesc: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5, marginTop: '-4px' },
      rowItem: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '9px 2px',
        borderBottom: '1px solid var(--rp-line)',
        minWidth: 0,
      },
      rowItemLast: { borderBottom: 'none' },
      rowMain: { display: 'flex', alignItems: 'flex-start', gap: '10px', minWidth: 0 },
      rowText: { flex: 1, minWidth: 0 },
      rowName: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px', fontSize: '13px', fontWeight: 600, minWidth: 0 },
      // Real skill descriptions can run for paragraphs (some list every command).
      // Clamp them so one resource never swallows the whole panel; the full text
      // stays available as the row's hover title.
      rowDesc: {
        fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary)',
        lineHeight: 1.5,
        marginTop: '2px',
        wordBreak: 'break-word',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      },
      rowMeta: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px', marginTop: '5px' },
      rowActions: { display: 'flex', alignItems: 'center', gap: '6px', flex: '0 0 auto' },
      condChip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        border: '1px solid var(--rp-line)',
        background: 'var(--rp-card-2)',
        borderRadius: '999px',
        padding: '1px 8px',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary)',
        maxWidth: '320px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      condPanel: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
        gap: '10px',
        background: 'var(--rp-card-2)',
        border: '1px solid var(--rp-line)',
        borderRadius: '8px',
        padding: '10px',
      },
      badge: {
        flex: '0 0 auto',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)',
        border: '1px solid var(--rp-line)',
        borderRadius: '5px',
        padding: '1px 6px',
      },
      badgeOn: {
        flex: '0 0 auto',
        fontSize: '11px',
        color: 'var(--rp-ok)',
        background: 'var(--rp-ok-weak)',
        border: '1px solid transparent',
        borderRadius: '5px',
        padding: '1px 6px',
      },
      badgeWarn: {
        flex: '0 0 auto',
        fontSize: '11px',
        color: 'var(--rp-warn, var(--dsw-alias-label-secondary))',
        background: 'var(--rp-mcp-weak)',
        border: '1px solid transparent',
        borderRadius: '5px',
        padding: '1px 6px',
      },
      badgeError: {
        flex: '0 0 auto',
        fontSize: '11px',
        color: 'var(--rp-err)',
        background: 'var(--rp-err-weak)',
        border: '1px solid transparent',
        borderRadius: '5px',
        padding: '1px 6px',
      },
      managedTag: {
        flex: '0 0 auto',
        fontSize: '11px',
        color: 'var(--rp-accent)',
        border: '1px solid var(--rp-accent)',
        borderRadius: '4px',
        padding: '0 5px',
      },
      savingDot: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
      field: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 },
      fieldLabel: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      fieldHint: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', opacity: 0.85, lineHeight: 1.5 },
      input: {
        flex: 1,
        minWidth: 0,
        border: '1px solid var(--rp-line-strong)',
        background: 'var(--rp-control)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '8px',
        padding: '7px 10px',
        fontSize: '13px',
        lineHeight: 1.2,
        outline: 'none',
        fontFamily: 'inherit',
      },
      inputSearch: {
        flex: '0 1 320px',
        minWidth: '180px',
        border: '1px solid var(--rp-line-strong)',
        background: 'var(--rp-control)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '8px',
        padding: '7px 10px',
        fontSize: '13px',
        lineHeight: 1.2,
        outline: 'none',
        fontFamily: 'inherit',
      },
      textarea: {
        minWidth: 0,
        resize: 'vertical',
        border: '1px solid var(--rp-line-strong)',
        background: 'var(--rp-control)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '8px',
        padding: '7px 10px',
        fontSize: '13px',
        lineHeight: 1.2,
        outline: 'none',
        fontFamily: 'inherit',
        lineHeight: 1.5,
      },
      select: {
        appearance: 'none',
        height: '30px',
        flex: '0 0 auto',
        border: '1px solid var(--rp-line-strong)',
        background: 'var(--rp-control)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '8px',
        padding: '0 26px 0 10px',
        fontSize: '13px',
        cursor: 'pointer',
        backgroundImage:
          'linear-gradient(45deg, transparent 50%, var(--dsw-alias-label-secondary) 50%), linear-gradient(135deg, var(--dsw-alias-label-secondary) 50%, transparent 50%)',
        backgroundPosition: 'calc(100% - 13px) 50%, calc(100% - 9px) 50%',
        backgroundSize: '4px 4px, 4px 4px',
        backgroundRepeat: 'no-repeat',
      },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: 0 },
      rowWrap: { display: 'flex', alignItems: 'flex-end', flexWrap: 'wrap', gap: '10px', minWidth: 0 },
      searchRow: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', minWidth: 0 },
      multi: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        border: '1px solid var(--rp-line-strong)',
        borderRadius: '8px',
        padding: '8px',
        background: 'var(--rp-control)',
        minWidth: 0,
      },
      multiChips: { display: 'flex', flexWrap: 'wrap', gap: '4px' },
      mchip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        border: '1px solid var(--rp-line)',
        background: 'var(--rp-card-2)',
        borderRadius: '999px',
        padding: '1px 8px',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-primary)',
        maxWidth: '100%',
      },
      mchipLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      mchipX: {
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        fontSize: '13px',
        lineHeight: 1,
        padding: '0 0 1px',
      },
      multiList: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        maxHeight: '200px',
        overflow: 'auto',
        borderTop: '1px solid var(--rp-line)',
        paddingTop: '4px',
      },
      multiRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        appearance: 'none',
        border: '1px solid transparent',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '6px',
        padding: '4px 6px',
        fontSize: '13px',
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        minWidth: 0,
        fontFamily: 'inherit',
      },
      multiRowActive: { background: 'var(--rp-card-2)', borderColor: 'var(--rp-line-strong)' },
      itemName: { fontSize: '13px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      multiHint: {
        flex: 1,
        minWidth: 0,
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        textAlign: 'right',
      },
      check: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '14px',
        height: '14px',
        flex: '0 0 auto',
        borderRadius: '4px',
        border: '1px solid var(--rp-line-strong)',
        fontSize: '11px',
        color: 'var(--rp-accent)',
        lineHeight: 1,
      },
      checkOn: { borderColor: 'var(--rp-accent)', background: 'var(--rp-accent)', color: '#fff' },
      hintBlock: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 },
      previewBox: {
        border: '1px solid var(--rp-accent-line)',
        borderRadius: '8px',
        background: 'var(--rp-accent-weak)',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        minWidth: 0,
      },
      resourceLine: { display: 'flex', alignItems: 'flex-start', gap: '8px', flexWrap: 'wrap', minWidth: 0 },
      resourceLabel: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', flex: '0 0 auto', paddingTop: '2px' },
      importBar: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '10px' },
      importTile: {
        appearance: 'none',
        textAlign: 'left',
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
        border: '1px solid var(--rp-line)',
        background: 'var(--rp-card-2)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '9px',
        padding: '10px 12px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        minWidth: 0,
      },
      importTileTitle: { fontSize: '13px', fontWeight: 600 },
      importTileHint: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.4 },
      sourceRow: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '10px',
        padding: '9px 2px',
        borderBottom: '1px solid var(--rp-line)',
        minWidth: 0,
      },
      sourceMain: { flex: 1, minWidth: 0 },
      sourceName: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', fontSize: '13px', fontWeight: 600, minWidth: 0 },
      sourceMeta: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: '4px', minWidth: 0 },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary)',
        wordBreak: 'break-all',
        minWidth: 0,
      },
      mountRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        flexWrap: 'wrap',
        padding: '7px 2px',
        borderBottom: '1px solid var(--rp-line)',
      },
      mountMain: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: 0 },
      dot: { width: '7px', height: '7px', borderRadius: '999px', flex: '0 0 auto', background: 'var(--dsw-alias-label-secondary)' },
      dotMounting: { background: 'var(--rp-accent)' },
      dotReady: { background: 'var(--dsw-alias-state-success-primary)' },
      dotFailed: { background: 'var(--dsw-alias-state-error-primary)' },
      overlay: {
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 40,
        padding: '24px',
      },
      modal: {
        width: 'min(720px, 100%)',
        maxHeight: '84vh',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        background: 'var(--rp-card)',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--rp-line-strong)',
        borderRadius: '14px',
        padding: '18px',
        overflow: 'auto',
        boxShadow: '0 24px 64px rgba(0, 0, 0, 0.38)',
      },
      modalWide: { width: 'min(820px, 100%)' },
      // A divider under the title separates "what am I doing" from "the form".
      modalHead: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        paddingBottom: '12px',
        borderBottom: '1px solid var(--rp-line)',
      },
      modalTitle: { margin: 0, fontSize: '16px', fontWeight: 600 },
      modalFoot: { display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' },
      uploadTextarea: { minHeight: '150px', resize: 'vertical', lineHeight: 1.5 },
      fileRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: 0 },
      addList: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        maxHeight: '320px',
        overflow: 'auto',
        border: '1px solid var(--rp-line)',
        borderRadius: '8px',
        padding: '4px',
      },
      addRow: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        appearance: 'none',
        border: '1px solid transparent',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '6px',
        padding: '5px 6px',
        fontSize: '13px',
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        minWidth: 0,
        fontFamily: 'inherit',
      },
      addRowActive: { background: 'var(--rp-card-2)', borderColor: 'var(--rp-line-strong)' },
      addText: { flex: 1, minWidth: 0 },
      addName: { fontSize: '13px', fontWeight: 500 },
      addDesc: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.4, marginTop: '1px', wordBreak: 'break-word' },
      pills: { display: 'flex', flexWrap: 'wrap', gap: '4px' },
      wizStep: { display: 'flex', flexDirection: 'column', gap: '8px', border: '1px solid var(--rp-line)', borderRadius: '8px', padding: '10px' },
    }

    // ------------------------------------------------------------ components

    function Chip(props) {
      const label = asString(props.label)
      const value = asString(props.value)
      return h(
        'span',
        { style: S.chip, title: asString(props.title) || `${label}: ${value}` },
        props.dot ? h('span', { style: { ...S.chipDot, background: props.dot } }) : null,
        `${label}: ${value}`,
      )
    }

    function Toggle(props) {
      const on = props.checked === true
      const disabled = props.disabled === true
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': on ? 'true' : 'false',
          'aria-label': asString(props.label) || (on ? TEXT.enabled : TEXT.disabled),
          title: asString(props.title) || asString(props.label),
          disabled,
          style: {
            ...S.toggleTrack,
            ...(on ? S.toggleTrackOn : null),
            ...(disabled ? { opacity: 0.55, cursor: 'default' } : null),
          },
          onClick: () => {
            if (!disabled && typeof props.onChange === 'function') props.onChange(!on)
          },
        },
        h('span', { style: { ...S.toggleKnob, ...(on ? S.toggleKnobOn : null) } }),
      )
    }

    function SwitchRow(props) {
      return h(
        'div',
        { style: S.switchRow },
        h(
          'div',
          { style: S.switchText },
          h('span', { style: S.switchLabel }, asString(props.label)),
          props.hint ? h('span', { style: S.fieldHint }, asString(props.hint)) : null,
        ),
        h(Toggle, {
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: props.onChange,
          label: asString(props.label),
        }),
      )
    }

    /** Render one or more children as keyed fragments so arrays never warn. */
    function renderChildren(children) {
      if (children === undefined || children === null) return null
      const list = Array.isArray(children) ? children : [children]
      return list.map((child, index) => h(React.Fragment, { key: `child-${index}` }, child))
    }

    function Field(props) {
      return h(
        'div',
        { style: S.field },
        h('span', { style: S.fieldLabel }, asString(props.label)),
        ...renderChildren(props.children),
        props.hint ? h('span', { style: S.fieldHint }, asString(props.hint)) : null,
      )
    }

    function MultiSelect(props) {
      const items = useMemo(() => asArray(props.items), [props.items])
      const selected = useMemo(() => asStringArray(props.selected), [props.selected])
      const [search, setSearch] = useState('')
      const query = search.trim().toLowerCase()
      const labelOf = useMemo(() => {
        const map = new Map()
        for (const item of items) map.set(asString(item.value), asString(item.label) || asString(item.value))
        return map
      }, [items])
      const filtered = useMemo(() => {
        const list = items.filter((item) => {
          if (query.length === 0) return true
          const haystack = `${asString(item.label)} ${asString(item.hint)}`.toLowerCase()
          return haystack.includes(query)
        })
        return list
      }, [items, query])
      const toggleValue = (value) => {
        const next = selected.filter((candidate) => candidate !== value)
        if (!selected.includes(value)) next.push(value)
        if (typeof props.onChange === 'function') props.onChange(next)
      }
      const selectVisible = () => {
        const next = selected.slice()
        for (const item of filtered) {
          const value = asString(item.value)
          if (value.length > 0 && !next.includes(value)) next.push(value)
        }
        if (typeof props.onChange === 'function') props.onChange(next)
      }
      const clearAll = () => {
        if (typeof props.onChange === 'function') props.onChange([])
      }
      return h(
        'div',
        { style: S.multi },
        selected.length === 0
          ? h('span', { style: S.fieldHint }, asString(props.emptyHint) || TEXT.addNoneSelected)
          : h(
              'div',
              { style: S.multiChips },
              ...selected.map((value) =>
                h(
                  'span',
                  { key: value, style: S.mchip },
                  h('span', { style: S.mchipLabel }, labelOf.get(value) || value),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: S.mchipX,
                      title: asString(props.removeLabel) || '×',
                      onClick: () => toggleValue(value),
                    },
                    '×',
                  ),
                ),
              ),
            ),
        h(
          'div',
          { style: S.row },
          h('input', {
            style: { ...S.input, minWidth: '100px' },
            value: search,
            placeholder: asString(props.searchPlaceholder),
            onChange: (event) => setSearch(asString(event.target.value)),
          }),
          h('button', { type: 'button', style: S.buttonSmall, onClick: selectVisible }, asString(props.selectAllLabel) || TEXT.selectAll),
          h('button', { type: 'button', style: S.buttonSmall, onClick: clearAll }, asString(props.clearAllLabel) || TEXT.clearAll),
        ),
        filtered.length === 0
          ? h('div', { style: S.empty }, items.length === 0 ? asString(props.emptyText) || TEXT.noMatches : TEXT.noMatches)
          : h(
              'div',
              { style: S.multiList },
              ...filtered.map((item) => {
                const value = asString(item.value)
                const active = selected.includes(value)
                return h(
                  'button',
                  {
                    key: value,
                    type: 'button',
                    style: { ...S.multiRow, ...(active ? S.multiRowActive : null) },
                    title: asString(item.hint) || value,
                    onClick: () => toggleValue(value),
                  },
                  h('span', { style: { ...S.check, ...(active ? S.checkOn : null) } }, active ? '✓' : ''),
                  h('span', { style: S.itemName }, asString(item.label) || value),
                  // The hint only earns its space when it adds information: for a
                  // mode it would just repeat the label on the right.
                  item.hint && asString(item.hint) !== (asString(item.label) || value)
                    ? h('span', { style: S.multiHint }, asString(item.hint))
                    : null,
                )
              }),
            ),
      )
    }

    function AddPathRow(props) {
      const [value, setValue] = useState('')
      const add = () => {
        const path = normalizePath(value)
        if (path.length === 0) return
        if (typeof props.onAdd === 'function') props.onAdd(path)
        setValue('')
      }
      return h(
        'div',
        { style: S.row },
        h('input', {
          style: { ...S.input, minWidth: '140px' },
          value,
          placeholder: asString(props.placeholder),
          onChange: (event) => setValue(asString(event.target.value)),
          onKeyDown: (event) => {
            if (event.key === 'Enter') add()
          },
        }),
        h('button', { type: 'button', style: S.buttonSmall, onClick: add }, asString(props.label) || '+'),
      )
    }

    function Modal(props) {
      const wide = props.wide === true
      return h(
        'div',
        { style: S.overlay, role: 'dialog', 'aria-modal': 'true', 'aria-label': asString(props.title) },
        h(
          'div',
          {
            style: { ...S.modal, ...(wide ? S.modalWide : null) },
            onMouseDown: (event) => event.stopPropagation(),
          },
          h(
            'div',
            { style: S.modalHead },
            h('h3', { style: S.modalTitle }, asString(props.title)),
            h(
              'button',
              { type: 'button', style: S.buttonSmall, onClick: props.onClose, disabled: props.busy === true },
              TEXT.close,
            ),
          ),
          props.subtitle ? h('p', { style: S.subtitle }, asString(props.subtitle)) : null,
          props.error ? h('div', { style: S.error, role: 'alert' }, asString(props.error)) : null,
          h('div', { style: S.stack }, ...renderChildren(props.children)),
          props.footer ? h('div', { style: S.modalFoot }, props.footer) : null,
        ),
      )
    }

    function safeNode(key, render) {
      try {
        return h(React.Fragment, { key }, render())
      } catch (cause) {
        return h(React.Fragment, { key }, h('div', { style: S.error }, `${TEXT.rowFailed}: ${messageOf(cause)}`))
      }
    }
    // ------------------------------------------------------- v3 style extras

    // Palette. Every colour is derived from the Host theme tokens with color-mix,
    // so the panel follows the light and dark themes instead of hard-coding values.
    // The plain token before each color-mix is the fallback for engines without
    // color-mix support: the later declaration wins only when it is valid.
    //
    // The accent is `--dsw-alias-link` (the DeepSeek blue, which flips between the
    // 400 and 500 step per theme) and NOT `--dsw-alias-brand-primary`: that token is
    // the primary-button FILL, i.e. near-white in the dark theme and near-black in
    // the light one, so using it as an accent painted white-on-dark "markers".
    const RP_VARS = [
      '--rp-card:var(--dsw-alias-bg-layer-1)',
      '--rp-card:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 94%,var(--dsw-alias-link))',
      '--rp-card-2:var(--dsw-alias-bg-layer-2)',
      '--rp-card-2:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 92%,var(--dsw-alias-link))',
      '--rp-control:var(--dsw-alias-bg-layer-2)',
      '--rp-control:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 90%,var(--dsw-alias-link))',
      '--rp-line:var(--dsw-alias-border-l1)',
      '--rp-line-strong:var(--dsw-alias-border-l2)',
      '--rp-accent:var(--dsw-alias-link)',
      '--rp-accent-weak:var(--dsw-alias-bg-layer-2)',
      '--rp-accent-weak:color-mix(in srgb,var(--dsw-alias-link) 16%,transparent)',
      '--rp-accent-line:var(--dsw-alias-link)',
      '--rp-accent-line:color-mix(in srgb,var(--dsw-alias-link) 45%,transparent)',
      // MCP is a different kind of resource (a connection, not content), so it gets
      // its own hue instead of competing with the skill accent.
      '--rp-mcp:var(--dsw-static-amber-500)',
      '--rp-mcp-weak:color-mix(in srgb,var(--dsw-static-amber-500) 16%,transparent)',
      '--rp-mcp-line:color-mix(in srgb,var(--dsw-static-amber-500) 40%,transparent)',
      '--rp-ok:var(--dsw-alias-state-success-primary)',
      '--rp-ok-weak:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)',
      '--rp-err:var(--dsw-alias-state-error-primary)',
      '--rp-err-weak:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent)',
      '--rp-warn:var(--dsw-alias-state-warn-primary)',
    ].join(';')

    const PAGE_CSS =
      // Form controls do not inherit the page font from the Host, so establish it
      // here. Never use the `font` shorthand for this: it also resets font-size,
      // which silently made every control render at the host body size (≈16px)
      // while the surrounding labels stayed small.
      '.dsh-rp-root button,.dsh-rp-root input,.dsh-rp-root select,.dsh-rp-root textarea{font-family:inherit}' +
      '.dsh-rp-root button,.dsh-rp-root input,.dsh-rp-root select,.dsh-rp-root textarea{font-size:inherit}' +
      '.dsh-rp-root button{letter-spacing:inherit}' +
      '.dsh-rp-root{' + RP_VARS + '}' +
      // Every control the panel renders is a styled <button>, <label> or input. A
      // UA or host focus ring on any of them leaves a box behind after a click and
      // reads as "the button I pressed keeps a white border". Suppressing it here
      // is deliberate: the panels convey state with fills, and the only control
      // that needs a ring is a text field, which gets one below.
      '.dsh-rp-root button:focus,.dsh-rp-root button:focus-visible,' +
      '.dsh-rp-root label:focus,.dsh-rp-root label:focus-visible,' +
      '.dsh-rp-root label:focus-within,' +
      '.dsh-rp-root input[type="file"]:focus,.dsh-rp-root input[type="file"]:focus-visible' +
      '{outline:none !important;box-shadow:none !important}' +
      // A text field still needs a visible focus state.
      '.dsh-rp-root input:not([type="file"]):focus-visible,.dsh-rp-root select:focus-visible,' +
      '.dsh-rp-root textarea:focus-visible' +
      '{outline:2px solid var(--rp-accent);outline-offset:1px}' +
      '@keyframes dsh-rp-pulse{0%,100%{opacity:.35}50%{opacity:1}}'

    const SX = {
      previewBox: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        border: '1px solid var(--rp-accent-line)',
        borderLeft: '3px solid var(--rp-accent)',
        background: 'var(--rp-accent-weak)',
        borderRadius: '10px',
        padding: '8px 12px',
        minWidth: 0,
      },
      previewBar: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', minWidth: 0 },
      previewMeta: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', minWidth: 0 },
      previewCount: {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 10px',
        borderRadius: '999px',
        border: '1px solid var(--rp-accent)',
        background: 'var(--rp-card)',
        color: 'var(--rp-accent)',
        fontSize: '12px',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      },
      spacer: { flex: 1, minWidth: 0 },
      condChipOn: { borderColor: 'var(--rp-accent-line)', background: 'var(--rp-accent-weak)', color: 'var(--rp-accent)' },
      groupBox: { borderTop: '1px solid var(--rp-line)', paddingTop: '2px', minWidth: 0 },
      groupHead: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '8px',
        padding: '9px 2px 7px',
        minWidth: 0,
      },
      groupName: {
        fontSize: '13px',
        fontWeight: 700,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      },
      groupCaret: {
        width: '14px',
        flex: '0 0 auto',
        textAlign: 'center',
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-secondary)',
        transition: 'transform 120ms ease',
        userSelect: 'none',
      },
      inheritOn: {
        borderColor: 'var(--rp-accent-line)',
        background: 'var(--rp-accent-weak)',
        color: 'var(--rp-accent)',
      },
      rowError: {
        marginTop: '6px',
        border: '1px solid var(--dsw-alias-state-error-primary)',
        background: 'var(--rp-card)',
        color: 'var(--dsw-alias-state-error-primary)',
        borderRadius: '8px',
        padding: '6px 9px',
        fontSize: '12px',
        lineHeight: 1.5,
        wordBreak: 'break-word',
      },
      inlineError: {
        fontSize: '12px',
        color: 'var(--dsw-alias-state-error-primary)',
        lineHeight: 1.5,
        wordBreak: 'break-word',
      },
      groupEmpty: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)', padding: '8px 2px' },
      emptyBox: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: '6px',
        border: '1px dashed var(--rp-line-strong)',
        borderRadius: '10px',
        background: 'var(--rp-card)',
        padding: '16px',
      },
      emptyTitle: { fontSize: '14px', fontWeight: 600 },
      seg: {
        display: 'inline-flex',
        alignSelf: 'flex-start',
        gap: '4px',
        padding: '0',
        // No container border and no per-segment border: the selected segment is
        // marked by its own tint, so nothing white is ever drawn.
        border: 'none',
        borderRadius: '9px',
        background: 'transparent',
        flexWrap: 'wrap',
      },
      segBtn: {
        appearance: 'none',
        border: '1px solid transparent',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        borderRadius: '7px',
        padding: '4px 12px',
        fontSize: '13px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        outline: 'none',
      },
      segActive: {
        background: 'var(--rp-accent-weak)',
        borderColor: 'transparent',
        color: 'var(--rp-accent)',
        fontWeight: 600,
      },
      confirmRow: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: '6px' },
      confirmText: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)', lineHeight: 1.5 },
      scopeBox: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: '14px',
        borderTop: '1px solid var(--rp-line)',
        paddingTop: '12px',
      },
      // MCP member card: display configuration sits above the per-tool rows so
      // the row's enabled switch keeps its usual place on the right.
      mcpConfig: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        border: '1px solid var(--rp-line)',
        borderRadius: '8px',
        background: 'var(--rp-card-2)',
        padding: '10px',
        minWidth: 0,
      },
      mcpConfigActions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: 0 },
      mcpToolBlock: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      mcpToolHead: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '8px',
        padding: '2px',
        cursor: 'pointer',
        minWidth: 0,
      },
      mcpToolRow: {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        borderTop: '1px solid var(--rp-line)',
        padding: '7px 2px',
        minWidth: 0,
      },
      mcpToolMain: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      mcpToolHistory: { opacity: 0.62 },
      mcpToolEditor: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: '10px',
        border: '1px solid var(--rp-line)',
        borderRadius: '8px',
        background: 'var(--rp-card-2)',
        padding: '10px',
      },
      mcpHint: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
      resultBox: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        border: '1px solid var(--rp-line)',
        background: 'var(--rp-card-2)',
        borderRadius: '8px',
        padding: '10px',
      },
      resultLine: { fontSize: '12px', lineHeight: 1.5, wordBreak: 'break-word' },
      mountLine: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', minWidth: 0 },
      nativeRow: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        padding: '6px 2px',
        borderBottom: '1px solid var(--rp-line)',
        minWidth: 0,
      },
      nativeRowLast: { borderBottom: 'none' },
      sectionHint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
    }

    // ------------------------------------------------------------------ panel

    function Panel() {
      const [board, setBoard] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [activationWarning, setActivationWarning] = useState(null)
      const [tab, setTab] = useState('resources')
      const [expanded, setExpanded] = useState({})
      const [groupOpen, setGroupOpen] = useState({})
      const [busy, setBusy] = useState({})
      const [saving, setSaving] = useState({})
      const [rowErrors, setRowErrors] = useState({})
      const [confirmItem, setConfirmItem] = useState('')
      const [confirmSource, setConfirmSource] = useState('')
      const [dialog, setDialog] = useState(false)
      const [previewMode, setPreviewMode] = useState('')
      const [previewCwd, setPreviewCwd] = useState('')
      const [pool, setPool] = useState(null)
      const [previewBusy, setPreviewBusy] = useState(false)
      const [previewError, setPreviewError] = useState('')
      // Per-server `GET /mcp/tools` result. Kept outside the board because it is
      // a derived catalog: the Host remains the authority for the board state.
      const [mcpToolCatalog, setMcpToolCatalog] = useState({})
      const mounted = useRef(true)
      const loadingRef = useRef(false)
      const pendingRef = useRef(new Map())
      const editSeqRef = useRef(new Map())
      const writeChainsRef = useRef(new Map())
      const draftsRef = useRef(new Map())
      const removingRef = useRef(new Set())
      const boardRevisionRef = useRef(0)
      const timersRef = useRef(new Map())
      const groupTimersRef = useRef(new Map())
      // MCP display configuration and per-tool saves are debounced and
      // serialized like rows, but kept in their own queues: a description save
      // must never be merged into the member-scope `/item` body (that route does
      // not own those fields).
      const configQueueRef = useRef(new Map())
      const configSeqRef = useRef(new Map())
      const configTimersRef = useRef(new Map())
      const configChainsRef = useRef(new Map())
      const configDraftsRef = useRef(new Map())
      const toolQueueRef = useRef(new Map())
      const toolSeqRef = useRef(new Map())
      const toolTimersRef = useRef(new Map())
      const toolChainsRef = useRef(new Map())
      const toolDraftsRef = useRef(new Map())
      const noticeTimer = useRef(null)
      const previewInitialized = useRef(false)
      const boardRef = useRef(null)
      const loadBoardRef = useRef(null)
      boardRef.current = board

      useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
          for (const timer of timersRef.current.values()) clearTimeout(timer)
          timersRef.current.clear()
          for (const timer of configTimersRef.current.values()) clearTimeout(timer)
          configTimersRef.current.clear()
          for (const timer of toolTimersRef.current.values()) clearTimeout(timer)
          toolTimersRef.current.clear()
          pendingRef.current.clear()
          editSeqRef.current.clear()
          writeChainsRef.current.clear()
          draftsRef.current.clear()
          configQueueRef.current.clear()
          configSeqRef.current.clear()
          configChainsRef.current.clear()
          configDraftsRef.current.clear()
          toolQueueRef.current.clear()
          toolSeqRef.current.clear()
          toolChainsRef.current.clear()
          toolDraftsRef.current.clear()
          removingRef.current.clear()
          if (noticeTimer.current) clearTimeout(noticeTimer.current)
        }
      }, [])

      const flash = useCallback((message) => {
        const text = asString(message)
        if (text.length === 0) return
        setNotice(text)
        if (noticeTimer.current) clearTimeout(noticeTimer.current)
        noticeTimer.current = setTimeout(() => {
          if (mounted.current) setNotice('')
        }, 3200)
      }, [])

      /**
       * A successful write can still leave live sessions on their previous
       * gate (the host keeps the committed state). Show the server's redacted
       * warning instead of silently claiming every session was updated.
       */
      const surfaceWarning = useCallback((payload) => {
        // Persistent and closable: a re-application failure must stay visible
        // even after the next successful request and beyond the 3.2s toast.
        setActivationWarning((current) => mergeActivationWarning(current, payload))
      }, [])

      const setBusyKey = useCallback((key, value) => {
        const name = asString(key)
        if (name.length === 0) return
        setBusy((current) => {
          const active = current[name] === true
          if (value === true && active) return current
          if (value !== true && !active) return current
          const next = { ...current }
          if (value === true) next[name] = true
          else delete next[name]
          return next
        })
      }, [])

      const isBusy = useCallback((key) => busy[asString(key)] === true, [busy])

      const markSaving = useCallback((key, value) => {
        setSaving((current) => {
          const active = current[key] === true
          if (value === true && active) return current
          if (value !== true && !active) return current
          const next = { ...current }
          if (value === true) next[key] = true
          else delete next[key]
          return next
        })
      }, [])

      const setRowError = useCallback((key, message) => {
        setRowErrors((current) => {
          // A superseded failure still has to surface; only an identical message
          // is deduped, never dropped because a newer request exists.
          if (current[key] === message) return current
          return { ...current, [key]: message }
        })
      }, [])

      const clearRowError = useCallback((key) => {
        setRowErrors((current) => {
          if (!Object.prototype.hasOwnProperty.call(current, key)) return current
          const next = { ...current }
          delete next[key]
          return next
        })
      }, [])

      // --------------------------------------------------------- autosave

      const flushItem = useCallback(
        async (key) => {
          const job = pendingRef.current.get(key)
          if (!job) {
            markSaving(key, false)
            return
          }
          pendingRef.current.delete(key)
          markSaving(key, true)
          const sequence = editSeqRef.current.get(key) ?? 0
          // Snapshot the request body now. A condition edit made *after* this
          // flush must travel with the newer queued save, never be squeezed into
          // this older request (whose entry may not even contain it).
          const body = buildItemSaveBody(job)
          // One in-flight save per member: an older request must never land after
          // a newer one and restore the previous conditions.
          const previous = writeChainsRef.current.get(key) ?? Promise.resolve()
          const run = previous.then(async () => {
            if (!mounted.current) return
            try {
              const payload = await request(`${API}/item`, { method: 'POST', body })
              if (!mounted.current) return
              surfaceWarning(payload)
              // The user kept typing while this request was in flight: the local
              // draft is newer than this response, so never replace it.
              const currentSequence = editSeqRef.current.get(key) ?? 0
              if (currentSequence !== sequence) return
              draftsRef.current.delete(key)
              // Any GET that started before this save response carries older
              // rows; let it refresh the derived views but keep this state.
              boardRevisionRef.current += 1
              clearRowError(key)
              if (payload.state) {
                const nextState = normalizeState(payload.state)
                const canonical = job.kind === MCP ? nextState.mcp[job.name] : nextState.skills[job.name]
                setBoard((current) => {
                  if (!current) return current
                  // `/item` owns only the member scope. Its response is a snapshot
                  // and may predate a concurrent config/tool save, so keep the
                  // fields that route never writes from the local document.
                  let effective = canonical
                  if (job.kind === MCP && canonical) {
                    const local = current.state.mcp[job.name]
                    if (local) {
                      effective = {
                        ...canonical,
                        description: local.description,
                        disclosure: local.disclosure,
                        tools: local.tools,
                      }
                    }
                  }
                  const state = applyItemSave(current.state, job.kind, job.name, effective)
                  return state === current.state ? current : { ...current, state }
                })
              }
            } catch (cause) {
              if (mounted.current && (editSeqRef.current.get(key) ?? 0) === sequence) {
                setRowError(key, messageOf(cause))
                if (loadBoardRef.current) void loadBoardRef.current({ silent: true })
              }
            } finally {
              // A queued newer save keeps the row marked as saving until it lands.
              if (
                mounted.current &&
                !pendingRef.current.has(key) &&
                (editSeqRef.current.get(key) ?? 0) === sequence
              ) {
                markSaving(key, false)
              }
            }
          })
          writeChainsRef.current.set(key, run.catch(() => {}))
          // The chain is already settled for later saves; an unexpected local
          // rendering error must not surface as an unhandled rejection.
          await run.catch(() => {})
        },
        [clearRowError, markSaving, setRowError, surfaceWarning],
      )

      const queueItem = useCallback(
        (kind, name, entry) => {
          const key = `${kind}:${name}`
          pendingRef.current.set(key, { kind, name, entry })
          editSeqRef.current.set(key, (editSeqRef.current.get(key) ?? 0) + 1)
          boardRevisionRef.current += 1
          const timer = timersRef.current.get(key)
          if (timer) clearTimeout(timer)
          markSaving(key, true)
          timersRef.current.set(
            key,
            setTimeout(() => {
              timersRef.current.delete(key)
              void flushItem(key)
            }, ITEM_DEBOUNCE_MS),
          )
        },
        [flushItem, markSaving],
      )

      /**
       * Flush one server's pending `/mcp/config` patch.
       *
       * Only the fields this request owns are applied from the canonical
       * response: the route returns the whole member, and replacing it wholesale
       * could roll back a concurrent per-tool or scope save.
       */
      const flushMcpConfig = useCallback(
        async (server) => {
          const job = configQueueRef.current.get(server)
          if (!job) {
            markSaving(`mcp-config:${server}`, false)
            return
          }
          configQueueRef.current.delete(server)
          markSaving(`mcp-config:${server}`, true)
          const sequence = configSeqRef.current.get(server) ?? 0
          const patch = { ...job }
          const body = { server, ...patch }
          const previous = configChainsRef.current.get(server) ?? Promise.resolve()
          const run = previous.then(async () => {
            if (!mounted.current) return
            try {
              const payload = await request(`${API}/mcp/config`, { method: 'POST', body })
              if (!mounted.current) return
              surfaceWarning(payload)
              boardRevisionRef.current += 1
              // Drop only the fields this request carried. A description that
              // arrived later (an AI draft, or a queued edit) must survive an
              // injection-mode save; a field still queued stays a draft too.
              const remaining = configDraftAfterSave(
                configDraftsRef.current.get(server),
                patch,
                configQueueRef.current.get(server),
              )
              if (Object.keys(remaining).length === 0) configDraftsRef.current.delete(server)
              else configDraftsRef.current.set(server, remaining)
              const currentSequence = configSeqRef.current.get(server) ?? 0
              if (currentSequence !== sequence) return
              const canonical = payload.state ? normalizeState(payload.state).mcp[server] : undefined
              if (canonical) {
                setBoard((current) => {
                  if (!current) return current
                  const member = current.state.mcp[server]
                  if (!member) return current
                  const next = { ...member }
                  if (patch.description !== undefined) next.description = canonical.description
                  if (patch.disclosure !== undefined) next.disclosure = canonical.disclosure
                  return { ...current, state: withEntry(current.state, MCP, server, next) }
                })
              }
              if (!configQueueRef.current.has(server)) clearRowError(`mcp-config:${server}`)
            } catch (cause) {
              // Keep the optimistic value and its draft: an inline error means the
              // user can retry, never that the text silently vanished. A failure
              // whose edit was superseded still surfaces (an identical message is
              // deduped by setRowError) instead of vanishing with its sequence.
              if (mounted.current) setRowError(`mcp-config:${server}`, messageOf(cause))
            } finally {
              if (
                mounted.current &&
                !configQueueRef.current.has(server) &&
                (configSeqRef.current.get(server) ?? 0) === sequence
              ) {
                markSaving(`mcp-config:${server}`, false)
              }
            }
          })
          configChainsRef.current.set(server, run.catch(() => {}))
          await run.catch(() => {})
        },
        [clearRowError, markSaving, setRowError, surfaceWarning],
      )

      /**
       * Queue a description/disclosure patch with the same debounce and serial
       * chain as row saves. `immediate` is used by the injection switch: the
       * spec wants the mode change to take effect at once.
       */
      const queueMcpConfig = useCallback(
        (server, patch, options) => {
          const name = asString(server)
          const changes = asObject(patch)
          if (name.length === 0 || Object.keys(changes).length === 0) return
          // Once removal owns the member, an edit must not schedule a write that
          // would hit a deleted row (and could resurrect its draft).
          if (removingRef.current.has(`mcp:${name}`)) return
          const current = boardRef.current
          const member = current ? current.state.mcp[name] : null
          if (!member) return
          const queued = configQueueRef.current.get(name) || {}
          configQueueRef.current.set(name, { ...queued, ...changes })
          configDraftsRef.current.set(name, { ...(configDraftsRef.current.get(name) || {}), ...changes })
          configSeqRef.current.set(name, (configSeqRef.current.get(name) ?? 0) + 1)
          boardRevisionRef.current += 1
          setBoard((boardNow) => {
            if (!boardNow) return boardNow
            const existing = boardNow.state.mcp[name]
            if (!existing) return boardNow
            return { ...boardNow, state: withEntry(boardNow.state, MCP, name, { ...existing, ...changes }) }
          })
          clearRowError(`mcp-config:${name}`)
          const timer = configTimersRef.current.get(name)
          if (timer) clearTimeout(timer)
          markSaving(`mcp-config:${name}`, true)
          const delay = options && options.immediate === true ? 0 : ITEM_DEBOUNCE_MS
          configTimersRef.current.set(
            name,
            setTimeout(() => {
              configTimersRef.current.delete(name)
              void flushMcpConfig(name)
            }, delay),
          )
        },
        [clearRowError, flushMcpConfig, markSaving],
      )

      /** Flush one pending `/mcp/tool` save for `server` + NUL + `tool`. */
      const flushTool = useCallback(
        async (jobKey) => {
          const job = toolQueueRef.current.get(jobKey)
          if (!job) {
            markSaving(`mcp-tool:${jobKey}`, false)
            return
          }
          toolQueueRef.current.delete(jobKey)
          markSaving(`mcp-tool:${jobKey}`, true)
          const sequence = toolSeqRef.current.get(jobKey) ?? 0
          const body = buildToolSaveBody(job.server, job.tool, job.draft)
          const previous = toolChainsRef.current.get(jobKey) ?? Promise.resolve()
          const run = previous.then(async () => {
            if (!mounted.current) return
            try {
              const payload = await request(`${API}/mcp/tool`, { method: 'POST', body })
              if (!mounted.current) return
              surfaceWarning(payload)
              boardRevisionRef.current += 1
              const currentSequence = toolSeqRef.current.get(jobKey) ?? 0
              if (currentSequence !== sequence) return
              const canonical = payload.state ? normalizeState(payload.state).mcp[job.server] : undefined
              setBoard((current) => {
                if (!current) return current
                const member = current.state.mcp[job.server]
                if (!member) return current
                const tools = { ...member.tools }
                if (body.clear === true) {
                  if (!Object.hasOwn(tools, job.tool)) return current
                  delete tools[job.tool]
                } else if (canonical && canonical.tools && Object.hasOwn(canonical.tools, job.tool)) {
                  tools[job.tool] = canonical.tools[job.tool]
                } else {
                  tools[job.tool] = normalizeToolScope(body)
                }
                return { ...current, state: withEntry(current.state, MCP, job.server, { ...member, tools }) }
              })
              if (!toolQueueRef.current.has(jobKey)) {
                toolDraftsRef.current.delete(jobKey)
                clearRowError(`mcp-tool:${jobKey}`)
              }
            } catch (cause) {
              if (mounted.current && (toolSeqRef.current.get(jobKey) ?? 0) === sequence) {
                setRowError(`mcp-tool:${jobKey}`, messageOf(cause))
              }
            } finally {
              if (
                mounted.current &&
                !toolQueueRef.current.has(jobKey) &&
                (toolSeqRef.current.get(jobKey) ?? 0) === sequence
              ) {
                markSaving(`mcp-tool:${jobKey}`, false)
              }
            }
          })
          toolChainsRef.current.set(jobKey, run.catch(() => {}))
          await run.catch(() => {})
        },
        [clearRowError, markSaving, setRowError, surfaceWarning],
      )

      /**
       * Queue one per-tool save. `draft` is either a complete
       * `{enabled,modes,workspaces}` scope or `{clear:true}`; the optimistic
       * board update happens here so a row never waits for the round trip.
       */
      const queueToolSave = useCallback(
        (server, tool, draft) => {
          const name = asString(server)
          const toolName = asString(tool)
          if (name.length === 0 || !toolName.startsWith('mcp__')) return
          if (removingRef.current.has(`mcp:${name}`)) return
          const current = boardRef.current
          const member = current ? current.state.mcp[name] : null
          if (!member) return
          const key = mcpToolJobKey(name, toolName)
          const source = asObject(draft)
          const next = source.clear === true ? { clear: true } : normalizeToolScope(source)
          toolQueueRef.current.set(key, { server: name, tool: toolName, draft: next })
          toolSeqRef.current.set(key, (toolSeqRef.current.get(key) ?? 0) + 1)
          boardRevisionRef.current += 1
          if (next.clear === true) toolDraftsRef.current.set(key, { clear: true })
          else toolDraftsRef.current.set(key, next)
          setBoard((boardNow) => {
            if (!boardNow) return boardNow
            const existing = boardNow.state.mcp[name]
            if (!existing) return boardNow
            const tools = { ...existing.tools }
            if (next.clear === true) delete tools[toolName]
            else tools[toolName] = next
            return { ...boardNow, state: withEntry(boardNow.state, MCP, name, { ...existing, tools }) }
          })
          clearRowError(`mcp-tool:${key}`)
          const timer = toolTimersRef.current.get(key)
          if (timer) clearTimeout(timer)
          markSaving(`mcp-tool:${key}`, true)
          toolTimersRef.current.set(
            key,
            setTimeout(() => {
              toolTimersRef.current.delete(key)
              void flushTool(key)
            }, ITEM_DEBOUNCE_MS),
          )
        },
        [clearRowError, flushTool, markSaving],
      )

      /**
       * Keep this tab's MCP display/tool fields when a whole-document response
       * replaces the board. Those routes never write them, and their snapshot can
       * predate a concurrent save; only members still present are touched.
       */
      function preserveLocalMcpConfig(nextState, currentState) {
        let next = nextState
        for (const [server, member] of Object.entries(currentState.mcp || {})) {
          if (!next.mcp[server]) continue
          next = withEntry(next, MCP, server, {
            ...next.mcp[server],
            description: member.description,
            disclosure: member.disclosure,
            tools: member.tools,
          })
        }
        return next
      }

      /** Discard every queued/draft MCP write for a member that is being removed. */
      function dropMcpPending(server) {
        const name = asString(server)
        if (name.length === 0) return
        const configTimer = configTimersRef.current.get(name)
        if (configTimer) {
          clearTimeout(configTimer)
          configTimersRef.current.delete(name)
        }
        configQueueRef.current.delete(name)
        configSeqRef.current.delete(name)
        configDraftsRef.current.delete(name)
        markSaving(`mcp-config:${name}`, false)
        for (const key of [...toolQueueRef.current.keys()]) {
          const parts = mcpToolJobParts(key)
          if (!parts || parts.server !== name) continue
          const timer = toolTimersRef.current.get(key)
          if (timer) {
            clearTimeout(timer)
            toolTimersRef.current.delete(key)
          }
          toolQueueRef.current.delete(key)
          toolSeqRef.current.delete(key)
          toolDraftsRef.current.delete(key)
          markSaving(`mcp-tool:${key}`, false)
        }
      }

      const flushPending = useCallback(async () => {
        const keys = [...pendingRef.current.keys()]
        for (const key of keys) {
          const timer = timersRef.current.get(key)
          if (timer) {
            clearTimeout(timer)
            timersRef.current.delete(key)
          }
          await flushItem(key)
        }
        // MCP display/tool saves share the same debounce; flush them before a GET
        // so the reload reads what the user already sees.
        for (const name of [...configQueueRef.current.keys()]) {
          const timer = configTimersRef.current.get(name)
          if (timer) {
            clearTimeout(timer)
            configTimersRef.current.delete(name)
          }
          await flushMcpConfig(name)
        }
        for (const key of [...toolQueueRef.current.keys()]) {
          const timer = toolTimersRef.current.get(key)
          if (timer) {
            clearTimeout(timer)
            toolTimersRef.current.delete(key)
          }
          await flushTool(key)
        }
      }, [flushItem, flushMcpConfig, flushTool])

      // ---------------------------------------------------------- loading

      const runResolve = useCallback(async (mode, cwd, options) => {
        setPreviewBusy(true)
        setPreviewError('')
        try {
          const allModes = options && options.allModes === true
          const allWorkspaces = options && options.allWorkspaces === true
          const query =
            `?mode=${encodeURIComponent(asString(mode))}&cwd=${encodeURIComponent(asString(cwd).trim())}` +
            (allModes ? '&allModes=1' : '') +
            (allWorkspaces ? '&allWorkspaces=1' : '')
          const payload = await request(`${API}/resolve${query}`, { method: 'GET' })
          if (mounted.current) setPool(normalizePool(payload.pool || payload.resolved))
        } catch (cause) {
          if (mounted.current) setPreviewError(messageOf(cause))
        } finally {
          if (mounted.current) setPreviewBusy(false)
        }
      }, [])

      /**
       * Re-apply unsaved MCP display/tool drafts over a document just read from
       * the Host. `applyLoadedBoard` only knows the row-draft map; description,
       * disclosure and per-tool edits live in their own queues, and a failed save
       * must not lose them on a refresh.
       */
      function mergeMcpPendingDrafts(loadedState) {
        let next = loadedState
        for (const [server, patch] of configDraftsRef.current) {
          const member = next.mcp[server]
          if (!member) continue
          next = withEntry(next, MCP, server, { ...member, ...patch })
        }
        for (const [jobKey, draft] of toolDraftsRef.current) {
          const parts = mcpToolJobParts(jobKey)
          if (!parts) continue
          const member = next.mcp[parts.server]
          if (!member) continue
          const tools = { ...member.tools }
          if (draft.clear === true) delete tools[parts.tool]
          else tools[parts.tool] = normalizeToolScope(draft)
          next = withEntry(next, MCP, parts.server, { ...member, tools })
        }
        return next
      }

      const loadBoard = useCallback(
        async (options) => {
          const silent = options && options.silent === true
          if (
            pendingRef.current.size > 0 ||
            configQueueRef.current.size > 0 ||
            toolQueueRef.current.size > 0
          ) {
            await flushPending()
          }
          if (loadingRef.current) return
          loadingRef.current = true
          const startedRevision = boardRevisionRef.current
          if (!silent) {
            setLoading(true)
            setError('')
          }
          try {
            const payload = await request(API, { method: 'GET' })
            if (!mounted.current) return
            const loaded = {
              state: normalizeState(payload.state),
              inventory: normalizeInventory(payload.inventory),
              mounts: normalizeMount(payload.mounts || payload.mount),
              meta: asObject(payload.meta),
            }
            const currentRevision = boardRevisionRef.current
            if (startedRevision === currentRevision) {
              // The authoritative document no longer has these rows. Never show
              // them again; surface their unsaved text instead of dropping it
              // silently.
              const orphans = orphanedDrafts(loaded.state, draftsRef.current)
              if (orphans.length > 0) {
                for (const orphan of orphans) {
                  draftsRef.current.delete(orphan.key)
                }
                setError(draftLossMessage(orphans))
              }
            }
            setBoard((current) => {
              const applied = applyLoadedBoard(current, loaded, {
                startedRevision,
                currentRevision,
                drafts: draftsRef.current,
              })
              return { ...applied, state: mergeMcpPendingDrafts(applied.state) }
            })
            if (!previewInitialized.current) {
              previewInitialized.current = true
              const mode =
                asString(loaded.inventory.defaultMode) ||
                (loaded.inventory.modes[0] && loaded.inventory.modes[0].id) ||
                ''
              const cwd = (loaded.inventory.workspaces[0] && loaded.inventory.workspaces[0].path) || ''
              setPreviewMode(mode)
              setPreviewCwd(cwd)
            }
          } catch (cause) {
            if (mounted.current && !silent) setError(messageOf(cause))
          } finally {
            loadingRef.current = false
            if (mounted.current && !silent) setLoading(false)
          }
        },
        [flushPending],
      )

      loadBoardRef.current = loadBoard

      useEffect(() => {
        void loadBoard()
      }, [loadBoard])

      const state = board ? board.state : EMPTY_STATE
      const inventory = board ? board.inventory : EMPTY_INVENTORY
      const mounts = board ? board.mounts : {}
      const meta = board ? board.meta : {}
      const settings = state.settings

      const skillMeta = useMemo(() => {
        const map = new Map()
        for (const row of inventory.skills) map.set(row.name, row)
        return map
      }, [inventory.skills])

      const mcpMeta = useMemo(() => {
        const map = new Map()
        for (const row of inventory.mcp) map.set(row.server, row)
        return map
      }, [inventory.mcp])

      const skillNames = useMemo(
        () => Object.keys(state.skills).sort((left, right) => left.localeCompare(right)),
        [state.skills],
      )
      const mcpNames = useMemo(
        () => Object.keys(state.mcp).sort((left, right) => left.localeCompare(right)),
        [state.mcp],
      )

      /** Load one server's tool catalog for the per-tool rows on demand. */
      const loadMcpTools = useCallback(async (server) => {
        const name = asString(server)
        if (name.length === 0) return
        setMcpToolCatalog((current) => ({
          ...current,
          [name]: { status: 'loading', error: '', tools: [] },
        }))
        try {
          const payload = await request(`${API}/mcp/tools?server=${encodeURIComponent(name)}`, { method: 'GET' })
          if (!mounted.current) return
          const tools = []
          for (const row of asArray(payload.tools)) {
            const item = asObject(row)
            const toolName = asString(item.name)
            if (!toolName.startsWith('mcp__')) continue
            tools.push({
              name: toolName,
              summary: asString(item.summary),
              registered: item.registered !== false,
              ambiguous: item.ambiguous === true,
            })
          }
          setMcpToolCatalog((current) => ({
            ...current,
            [name]: { status: 'ready', error: '', tools },
          }))
        } catch (cause) {
          // A catalog failure is shown in the card; there is no fake switch
          // without the Host's answer (the spec forbids guessing tool state).
          if (!mounted.current) return
          setMcpToolCatalog((current) => ({
            ...current,
            [name]: { status: 'error', error: messageOf(cause), tools: [] },
          }))
        }
      }, [])

      const toolOpenServers = useMemo(
        () => mcpNames.filter((server) => expanded[`mcp-tools:${server}`] !== false),
        [mcpNames, expanded],
      )

      useEffect(() => {
        if (!board) return
        for (const server of toolOpenServers) {
          if (!mcpToolCatalog[server]) void loadMcpTools(server)
        }
      }, [board, toolOpenServers, mcpToolCatalog, loadMcpTools])

      const toggleMcpTools = useCallback((server) => {
        const key = `mcp-tools:${server}`
        setExpanded((current) => ({ ...current, [key]: current[key] !== false ? false : true }))
      }, [])

      const toggleToolScope = useCallback((server, tool) => {
        const key = `mcp-tool-scope:${server}:${tool}`
        setExpanded((current) => ({ ...current, [key]: current[key] !== true }))
      }, [])
      const sourceList = useMemo(() => {
        const rows = Object.values(state.sources || {})
        rows.sort((left, right) => asString(right.createdAt).localeCompare(asString(left.createdAt)))
        return rows
      }, [state.sources])

      // Skills grouped by the repository (or import) their source names.
      const groupList = useMemo(() => {
        const groups = state.groups || {}
        const byKey = new Map()
        for (const name of skillNames) {
          const info = skillMeta.get(name)
          const key = info ? asString(info.groupKey) : ''
          if (key.length === 0) continue
          if (!byKey.has(key)) byKey.set(key, { key, name: asString(info.groupName) || key, names: [] })
          byKey.get(key).names.push(name)
        }
        return [...byKey.values()]
          .map((row) => ({ ...row, group: groups[row.key] || null }))
          .sort((left, right) => left.name.localeCompare(right.name))
      }, [skillNames, skillMeta, state.groups])

      const ungroupedSkills = useMemo(
        () =>
          skillNames.filter((name) => {
            const info = skillMeta.get(name)
            return info === undefined || asString(info.groupKey).length === 0
          }),
        [skillNames, skillMeta],
      )

      const sourceSections = useMemo(() => {
        const byKey = new Map()
        for (const source of sourceList) {
          const project = asString(source.project)
          const key = project.length > 0 ? 'repo:' + project : 'import:' + source.id
          if (!byKey.has(key)) {
            byKey.set(key, {
              key,
              name: project.length > 0 ? project : asString(source.label) || source.id,
              rows: [],
            })
          }
          byKey.get(key).rows.push(source)
        }
        return [...byKey.values()].sort((left, right) => left.name.localeCompare(right.name))
      }, [sourceList])

      // Re-resolve the preview whenever the selection or the pool changes.
      useEffect(() => {
        if (!board) return undefined
        const timer = setTimeout(() => {
          void runResolve(previewMode, previewCwd, {
            allModes: previewMode === '',
            allWorkspaces: previewCwd === '',
          })
        }, 180)
        return () => clearTimeout(timer)
      }, [board, previewMode, previewCwd, runResolve])

      // Poll `/mounts` every 1.6 s while any server is still mounting.
      const mountingCount = useMemo(() => {
        let count = 0
        for (const value of Object.values(mounts)) if (value && value.state === 'mounting') count += 1
        return count
      }, [mounts])

      useEffect(() => {
        if (mountingCount === 0) return undefined
        let cancelled = false
        const timer = setInterval(() => {
          void (async () => {
            try {
              const payload = await request(`${API}/mounts`, { method: 'GET' })
              if (cancelled || !mounted.current) return
              const next = normalizeMount(payload.mounts || payload.mount)
              setBoard((current) => (current ? { ...current, mounts: { ...current.mounts, ...next } } : current))
              const stillMounting = Object.values(next).some((value) => value && value.state === 'mounting')
              if (!stillMounting) void loadBoardRef.current({ silent: true })
            } catch {
              /* keep the current status and retry on the next tick */
            }
          })()
        }, MOUNT_POLL_MS)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [mountingCount])

      // ---------------------------------------------------------- mutations

      const toggleExpanded = useCallback((key) => {
        setExpanded((current) => ({ ...current, [key]: current[key] !== true }))
      }, [])

      // Groups start folded: the panel's first job is showing which repositories
      // are in the pool, and 25 rows of one repository would hide the others.
      const toggleGroupOpen = useCallback((key) => {
        setGroupOpen((current) => ({ ...current, [key]: current[key] !== true }))
      }, [])

      const updateEntry = useCallback(
        (kind, name, patch) => {
          const key = `${kind}:${name}`
          // Once removal owns this row, later edits must not schedule a save that
          // could recreate it; the row is disappearing.
          if (removingRef.current.has(key)) return
          // The local draft is newer than the last rendered document (a save may
          // be debounced or in flight), so an edit must build on it instead of
          // dropping unsaved conditions.
          const draft = draftsRef.current.get(key)
          const source =
            kind === MCP
              ? boardRef.current && boardRef.current.state.mcp[name]
              : boardRef.current && boardRef.current.state.skills[name]
          const base = rowDraftOf(draft || source || blankEntry())
          // Scope only. MCP display/tool fields are owned by their own queues and
          // must never be snapshotted into a scope draft (a reload would restore
          // them over values saved afterwards).
          const next = {
            ...base,
            enabled: typeof patch.enabled === 'boolean' ? patch.enabled : base.enabled,
            modes: patch.modes !== undefined ? asStringArray(patch.modes) : base.modes,
            workspaces:
              patch.workspaces !== undefined
                ? uniqueStrings(asArray(patch.workspaces).map(normalizePath))
                : base.workspaces,
            modesFrom: patch.modesFrom === 'self' || patch.modesFrom === 'group' ? patch.modesFrom : base.modesFrom,
            workspacesFrom:
              patch.workspacesFrom === 'self' || patch.workspacesFrom === 'group'
                ? patch.workspacesFrom
                : base.workspacesFrom,
          }
          draftsRef.current.set(key, next)
          setBoard((current) => {
            if (!current) return current
            const member = (kind === MCP ? current.state.mcp[name] : current.state.skills[name]) || {}
            return {
              ...current,
              state: withEntry(current.state, kind, name, { ...member, ...next }),
            }
          })
          clearRowError(key)
          queueItem(kind, name, next)
        },
        [clearRowError, queueItem],
      )

      /** Save the MCP purpose description and/or injection mode. */
      const updateMcpConfig = useCallback(
        (server, patch, options) => {
          const source = asObject(patch)
          const changes = {}
          if (source.description !== undefined) {
            changes.description = cleanPanelDescription(source.description)
          }
          if (source.disclosure !== undefined) {
            changes.disclosure = source.disclosure === 'progressive' ? 'progressive' : 'full'
          }
          if (Object.keys(changes).length === 0) return
          queueMcpConfig(server, changes, options)
        },
        [queueMcpConfig],
      )

      /**
       * Put an AI-generated description into the editable draft without saving
       * it: `/mcp/describe` is a suggestion, and the user confirms by editing /
       * leaving the field (the normal debounced save then commits it).
       */
      const applyMcpDescriptionDraft = useCallback(
        (server, text) => {
          const name = asString(server)
          const value = cleanPanelDescription(text)
          if (name.length === 0 || removingRef.current.has(`mcp:${name}`)) return
          // The generated text is a newer local edit than any request already in
          // flight; bumping the sequence stops that response from overwriting it.
          configSeqRef.current.set(name, (configSeqRef.current.get(name) ?? 0) + 1)
          configDraftsRef.current.set(name, {
            ...(configDraftsRef.current.get(name) || {}),
            description: value,
          })
          boardRevisionRef.current += 1
          setBoard((current) => {
            if (!current) return current
            const member = current.state.mcp[name]
            if (!member) return current
            return { ...current, state: withEntry(current.state, MCP, name, { ...member, description: value }) }
          })
          // Nothing is queued for the draft, so the row is not saving. Without
          // this a superseded in-flight save would leave the spinner on forever.
          if (!configQueueRef.current.has(name)) markSaving(`mcp-config:${name}`, false)
        },
        [markSaving],
      )

      /** Ask the default model for a short purpose description (never auto-saves). */
      const generateMcpDescription = useCallback(
        async (server) => {
          const name = asString(server)
          const busyKey = 'mcp-describe:' + name
          setBusyKey(busyKey, true)
          clearRowError(busyKey)
          try {
            const payload = await request(`${API}/mcp/describe`, {
              method: 'POST',
              body: { server: name, language: ZH ? 'zh' : 'en' },
            })
            if (!mounted.current) return
            const text = asString(payload.description).trim().slice(0, MCP_DESCRIPTION_LIMIT)
            if (text.length === 0) throw new Error(TEXT.mcpDescribeEmpty)
            applyMcpDescriptionDraft(name, text)
          } catch (cause) {
            if (mounted.current) {
              setRowError(busyKey, `${TEXT.mcpDescribeFailed}: ${messageOf(cause)}`)
            }
          } finally {
            if (mounted.current) setBusyKey(busyKey, false)
          }
        },
        [applyMcpDescriptionDraft, clearRowError, setBusyKey, setRowError],
      )

      /**
       * Edit one tool's enabled/scope draft. The full scope is sent every time so
       * changing one dimension cannot drop the other.
       */
      const updateMcpTool = useCallback(
        (server, tool, patch) => {
          const name = asString(server)
          const toolName = asString(tool)
          const current = boardRef.current
          const member = current ? current.state.mcp[name] : null
          if (!member || !toolName.startsWith('mcp__')) return
          const base = normalizeToolScope(member.tools[toolName])
          const next = {
            enabled: typeof patch.enabled === 'boolean' ? patch.enabled : base.enabled,
            modes: patch.modes !== undefined ? asStringArray(patch.modes) : base.modes,
            workspaces:
              patch.workspaces !== undefined
                ? uniqueStrings(asArray(patch.workspaces).map(normalizePath))
                : base.workspaces,
          }
          queueToolSave(name, toolName, next)
        },
        [queueToolSave],
      )

      /** Drop one tool's stored configuration (history entries stay visible). */
      const clearMcpTool = useCallback(
        (server, tool) => {
          queueToolSave(server, tool, { clear: true })
        },
        [queueToolSave],
      )

      const removeItem = useCallback(
        async (kind, name) => {
          const key = `${kind}:${name}`
          if (removingRef.current.has(key)) return
          removingRef.current.add(key)
          setBusyKey('remove:' + key, true)
          setError('')
          try {
            // Removal owns this row: discard its queued draft and ignore later
            // edits so no save can be scheduled once the delete is under way.
            editSeqRef.current.set(key, (editSeqRef.current.get(key) ?? 0) + 1)
            draftsRef.current.delete(key)
            const timer = timersRef.current.get(key)
            if (timer) {
              clearTimeout(timer)
              timersRef.current.delete(key)
            }
            pendingRef.current.delete(key)
            markSaving(key, false)
            // A per-tool or description save must not outlive the member it
            // belongs to (the Host would answer 404 and the draft could return).
            if (kind === MCP) dropMcpPending(name)

            // Settle the row's last in-flight write before removing it. Without
            // this, the older `/item` request can be processed after the delete
            // and (on an older server) recreate the member.
            const inFlight = writeChainsRef.current.get(key)
            if (inFlight) await inFlight.catch(() => {})
            if (pendingRef.current.size > 0) await flushPending()
            // Any GET already running must not restore the row from older data.
            boardRevisionRef.current += 1

            const payload = await request(`${API}/item/remove`, { method: 'POST', body: { kind, name } })
            if (!mounted.current) return
            surfaceWarning(payload)
            boardRevisionRef.current += 1
            if (payload.state) {
              setBoard((current) =>
                current
                  ? {
                      ...current,
                      state: preserveLocalMcpConfig(normalizeState(payload.state), current.state),
                    }
                  : current,
              )
            } else {
              setBoard((current) =>
                current ? { ...current, state: withoutEntry(current.state, kind, name) } : current,
              )
            }
            clearRowError(key)
            setConfirmItem('')
            const removedInfo = asObject(payload.removed)
            if (asString(removedInfo.warning).length > 0) setError(asString(removedInfo.warning))
            else flash(TEXT.itemRemoved)
            await loadBoard({ silent: true })
          } catch (cause) {
            // The member is still present; let a stale reload refresh views only.
            boardRevisionRef.current += 1
            if (mounted.current) setRowError(key, messageOf(cause))
          } finally {
            removingRef.current.delete(key)
            if (mounted.current) setBusyKey('remove:' + key, false)
          }
        },
        [clearRowError, flash, flushPending, loadBoard, markSaving, setBusyKey, setRowError, surfaceWarning],
      )

      const saveSettings = useCallback(
        async (patch) => {
          const base = boardRef.current ? boardRef.current.state.settings : DEFAULT_SETTINGS
          const nextSettings = normalizeSettings({ ...base, ...asObject(patch) })
          setBoard((current) =>
            current ? { ...current, state: { ...current.state, settings: nextSettings } } : current,
          )
          setBusyKey('settings', true)
          try {
            const payload = await request(`${API}/settings`, { method: 'POST', body: { patch: nextSettings } })
            if (!mounted.current) return
            const nextState = payload.state ? normalizeState(payload.state) : null
            if (nextState) {
              setBoard((current) =>
                current ? { ...current, state: { ...current.state, settings: nextState.settings } } : current,
              )
            }
            flash(TEXT.settingsSaved)
            surfaceWarning(payload)
          } catch (cause) {
            if (mounted.current) {
              setError(messageOf(cause))
              void loadBoard({ silent: true })
            }
          } finally {
            if (mounted.current) setBusyKey('settings', false)
          }
        },
        [flash, loadBoard, setBusyKey, surfaceWarning],
      )

      /** Persist the pending scope of one group (debounced by `updateGroup`). */
      const sendGroup = useCallback(
        async (key) => {
          const current = boardRef.current
          const group = current && current.state.groups ? current.state.groups[key] : null
          if (!group) return
          setBusyKey('group:' + key, true)
          setError('')
          try {
            const payload = await request(`${API}/group`, {
              method: 'POST',
              body: {
                key,
                enabled: group.enabled !== false,
                modes: asStringArray(group.modes),
                workspaces: uniqueStrings(asArray(group.workspaces).map(normalizePath)),
              },
            })
            if (!mounted.current) return
            if (payload.state) {
              setBoard((board) => (board ? { ...board, state: normalizeState(payload.state) } : board))
            }
            surfaceWarning(payload)
          } catch (cause) {
            if (mounted.current) {
              setError(messageOf(cause))
              if (loadBoardRef.current) void loadBoardRef.current({ silent: true })
            }
          } finally {
            if (mounted.current) setBusyKey('group:' + key, false)
          }
        },
        [setBusyKey, surfaceWarning],
      )

      /** Optimistically edit a group, then persist it once the user pauses. */
      const updateGroup = useCallback(
        (key, patch) => {
          setBoard((current) => {
            if (!current) return current
            const base =
              current.state.groups[key] || {
                key,
                kind: key.startsWith('import:') ? 'import' : 'repo',
                modes: [],
                workspaces: [],
              }
            const next = {
              ...base,
              key,
              enabled: patch.enabled !== undefined ? patch.enabled === true : base.enabled !== false,
              modes: patch.modes !== undefined ? asStringArray(patch.modes) : base.modes,
              workspaces:
                patch.workspaces !== undefined
                  ? uniqueStrings(asArray(patch.workspaces).map(normalizePath))
                  : base.workspaces,
            }
            return {
              ...current,
              state: { ...current.state, groups: { ...current.state.groups, [key]: next } },
            }
          })
          const timer = groupTimersRef.current.get(key)
          if (timer) clearTimeout(timer)
          groupTimersRef.current.set(
            key,
            setTimeout(() => {
              groupTimersRef.current.delete(key)
              void sendGroup(key)
            }, 350),
          )
        },
        [sendGroup],
      )

      // ------------------------------------------------------------ imports

      const submitImport = useCallback(
        async (seg, body) => {
          const route =
            seg === 'files'
              ? '/skill/upload'
              : seg === 'zip'
                ? '/skill/zip'
                : seg === 'git'
                  ? '/source/git'
                  : '/mcp/import'
          setBusyKey('import', true)
          try {
            const payload = await request(`${API}${route}`, { method: 'POST', body })
            if (mounted.current && payload.state) {
              const nextState = normalizeState(payload.state)
              const nextMounts = normalizeMount(payload.mounts || payload.mount)
              setBoard((current) =>
                current
                  ? { ...current, state: nextState, mounts: { ...current.mounts, ...nextMounts } }
                  : current,
              )
            }
            surfaceWarning(payload)
            if (seg === 'mcp') {
              if (mounted.current) void loadBoard({ silent: true })
            }
            return payload
          } finally {
            if (mounted.current) setBusyKey('import', false)
          }
        },
        [loadBoard, setBusyKey, surfaceWarning],
      )

      const pollMounts = useCallback(async () => {
        const payload = await request(`${API}/mounts`, { method: 'GET' })
        const next = normalizeMount(payload.mounts || payload.mount)
        if (mounted.current) {
          setBoard((current) => (current ? { ...current, mounts: { ...current.mounts, ...next } } : current))
        }
        return next
      }, [])

      const afterImport = useCallback(
        async (message) => {
          setDialog(false)
          if (message) flash(message)
          setTab('resources')
          await loadBoard({ silent: true })
        },
        [flash, loadBoard],
      )

      // ------------------------------------------------------------ sources

      const checkSources = useCallback(
        async (ids) => {
          const list = asStringArray(ids)
          const busyKey = 'sources:check:' + (list.length > 0 ? list.join(',') : 'all')
          setBusyKey(busyKey, true)
          setError('')
          try {
            const payload = await request(`${API}/source/check`, {
              method: 'POST',
              body: list.length > 0 ? { ids: list } : {},
            })
            if (!mounted.current) return
            if (payload.state) {
              setBoard((current) => (current ? { ...current, state: normalizeState(payload.state) } : current))
            }
            const results = asArray(payload.results)
            const updated = results.filter((row) => asString(row && row.status) === 'update-available').length
            const upToDate = results.filter((row) => asString(row && row.status) === 'up-to-date').length
            const failed = results.filter((row) => asString(row && row.status) === 'error').length
            flash(tf('checkResult', { updated, upToDate, failed }))
            surfaceWarning(payload)
            await loadBoard({ silent: true })
          } catch (cause) {
            if (mounted.current) setError(messageOf(cause))
          } finally {
            if (mounted.current) setBusyKey(busyKey, false)
          }
        },
        [flash, loadBoard, setBusyKey, surfaceWarning],
      )

      const updateSource = useCallback(
        async (id, options) => {
          const restore = options && options.restore === true
          const force = restore || (options && options.force === true)
          setBusyKey('source:update:' + id, true)
          setError('')
          try {
            const payload = await request(`${API}/source/update`, {
              method: 'POST',
              body: { id, ...(force ? { force: true } : {}), ...(restore ? { restore: true } : {}) },
            })
            if (!mounted.current) return
            if (payload.state) {
              setBoard((current) => (current ? { ...current, state: normalizeState(payload.state) } : current))
            }
            const failures = asArray(payload.failures)
            if (failures.length > 0) {
              setError(
                `${TEXT.importPartial}: ${failures
                  .map((row) => `${asString(row && row.name)}: ${asString(row && row.error)}`)
                  .join('; ')}`,
              )
            } else {
              flash(
                restore
                  ? TEXT.noticeSourceRestored
                  : payload.changed === false
                    ? TEXT.noticeSourceUpToDate
                    : TEXT.noticeSourceUpdated,
              )
            }
            surfaceWarning(payload)
            await loadBoard({ silent: true })
          } catch (cause) {
            if (mounted.current) setError(messageOf(cause))
          } finally {
            if (mounted.current) setBusyKey('source:update:' + id, false)
          }
        },
        [flash, loadBoard, setBusyKey, surfaceWarning],
      )

      /** Update every Git import of one repository group, one after another. */
      const updateGroupSources = useCallback(
        async (groupKey, ids) => {
          const list = asStringArray(ids)
          const busyKey = 'group:update:' + groupKey
          setBusyKey(busyKey, true)
          setError('')
          let installed = 0
          let failures = 0
          let changed = 0
          let warningPayload = null
          try {
            for (const id of list) {
              try {
                const payload = await request(`${API}/source/update`, { method: 'POST', body: { id } })
                if (!mounted.current) return
                if (payload.state) {
                  setBoard((current) => (current ? { ...current, state: normalizeState(payload.state) } : current))
                }
                if (payload.warning) warningPayload = payload
                if (payload.changed !== false) changed += 1
                installed += asArray(payload.installed).length
                failures += asArray(payload.failures).length
              } catch (cause) {
                failures += 1
                if (mounted.current) setError(messageOf(cause))
              }
            }
            if (!mounted.current) return
            if (failures === 0) {
              flash(changed === 0 ? TEXT.noticeSourceUpToDate : tf('noticeGroupUpdated', { count: installed }))
            }
            if (warningPayload) surfaceWarning(warningPayload)
            await loadBoard({ silent: true })
          } finally {
            if (mounted.current) setBusyKey(busyKey, false)
          }
        },
        [flash, loadBoard, setBusyKey, surfaceWarning],
      )

      const deleteSource = useCallback(
        async (id) => {
          setBusyKey('source:delete:' + id, true)
          setError('')
          try {
            const payload = await request(`${API}/source/delete`, { method: 'POST', body: { id } })
            if (!mounted.current) return
            if (payload.state) {
              setBoard((current) => (current ? { ...current, state: normalizeState(payload.state) } : current))
            }
            setConfirmSource('')
            const skipped = asArray(payload.skipped)
            flash(
              skipped.length > 0
                ? TEXT.noticeSourceDeleted + tf('sourceSkipped', { count: skipped.length })
                : TEXT.noticeSourceDeleted,
            )
            surfaceWarning(payload)
            await loadBoard({ silent: true })
          } catch (cause) {
            if (mounted.current) setError(messageOf(cause))
          } finally {
            if (mounted.current) setBusyKey('source:delete:' + id, false)
          }
        },
        [flash, loadBoard, setBusyKey, surfaceWarning],
      )

      // ----------------------------------------------------------- renderers

      function renderPreview() {
        const modeOptions = [{ id: '', name: TEXT.previewAllModes }, ...inventory.modes.slice()]
        if (previewMode && !modeOptions.some((mode) => mode.id === previewMode)) {
          modeOptions.push({ id: previewMode, name: previewMode })
        }
        const workspaceOptions = inventory.workspaces.slice()
        if (previewCwd && !workspaceOptions.some((row) => row.path === previewCwd)) {
          workspaceOptions.push({ id: '', name: baseName(previewCwd), path: previewCwd })
        }
        const total = pool ? asArray(pool.skills).length + asArray(pool.mcpServers).length : 0
        return h(
          'div',
          { style: SX.previewBox },
          h(
            'div',
            { style: SX.previewBar },
            h('span', { style: SX.sectionHint }, TEXT.previewMode),
            h(
              'select',
              {
                style: S.select,
                value: previewMode,
                'aria-label': TEXT.previewMode,
                onChange: (event) => setPreviewMode(asString(event.target.value)),
              },
              ...modeOptions.map((mode) => h('option', { key: mode.id, value: mode.id }, mode.name || mode.id)),
            ),
            h('span', { style: SX.sectionHint }, TEXT.previewWorkspace),
            h(
              'select',
              {
                style: S.select,
                value: previewCwd,
                'aria-label': TEXT.previewWorkspace,
                onChange: (event) => setPreviewCwd(asString(event.target.value)),
              },
              h('option', { value: '' }, TEXT.previewAllWorkspaces),
              ...workspaceOptions.map((row) =>
                h('option', { key: row.path, value: row.path }, row.name || baseName(row.path)),
              ),
            ),
            h(
              'span',
              { style: SX.previewCount },
              previewBusy
                ? TEXT.previewBusy
                : pool
                  ? tf('previewAvailable', { count: total })
                  : previewError
                    ? TEXT.previewFailed
                    : '—',
            ),
          ),
          previewError
            ? h('div', { style: SX.inlineError }, `${TEXT.previewFailed}: ${previewError}`)
            : pool
              ? h(
                  'div',
                  { style: SX.previewMeta },
                  h(
                    'span',
                    { style: SX.sectionHint },
                    `${TEXT.previewSkills}: ${
                      asArray(pool.skills).length > 0 ? asArray(pool.skills).join(', ') : TEXT.previewNone
                    }`,
                  ),
                  h(
                    'span',
                    { style: SX.sectionHint },
                    `${TEXT.previewMcp}: ${
                      asArray(pool.mcpServers).length > 0 ? asArray(pool.mcpServers).join(', ') : TEXT.previewNone
                    }`,
                  ),
                  h(
                    'span',
                    { style: S.badge },
                    `${TEXT.previewGateSkills}: ${pool.gateSkills ? TEXT.previewGated : TEXT.previewNotGated}`,
                  ),
                  h(
                    'span',
                    { style: S.badge },
                    `${TEXT.previewGateMcp}: ${pool.gateMcp ? TEXT.previewGated : TEXT.previewNotGated}`,
                  ),
                )
              : null,
        )
      }

      function renderEmptyState() {
        return h(
          'div',
          { style: SX.emptyBox },
          h('div', { style: SX.emptyTitle }, TEXT.emptyTitle),
          // No button here: importing is a page-level action in the header, so the
          // tab body stays a pure view of what the pool contains.
          h('div', { style: S.empty }, TEXT.emptyHint),
        )
      }

      function renderCondEditor(kind, name, entry) {
        const isMcp = kind === MCP
        const info = isMcp ? undefined : skillMeta.get(name)
        const groupKey = info ? asString(info.groupKey) : ''
        const group = groupKey.length > 0 ? state.groups[groupKey] || null : null
        const modeItems = inventory.modes.map((mode) => ({ value: mode.id, label: mode.name, hint: mode.id }))
        const workspaceItems = inventory.workspaces.map((row) => ({
          value: row.path,
          label: row.name || baseName(row.path),
          hint: row.path,
        }))
        const modeLabels = new Map(inventory.modes.map((mode) => [mode.id, mode.name]))
        const groupModeText = summarizeList(group ? asStringArray(group.modes) : [], TEXT.allModes, (value) => modeLabels.get(value) || value)
        const groupWorkspaceText = summarizeList(group ? asStringArray(group.workspaces) : [], TEXT.allWorkspaces, (value) => baseName(value))
        const inheritsModes = group !== null && entry.modesFrom === 'group'
        const inheritsWorkspaces = group !== null && entry.workspacesFrom === 'group'
        const selfModes = inheritsModes ? asStringArray(group.modes) : entry.modes
        const selfWorkspaces = inheritsWorkspaces ? asStringArray(group.workspaces) : entry.workspaces

        // A member of a group chooses per dimension: follow the group, or keep
        // its own list. The choice is stored, so "inherit" and "explicitly all"
        // never look the same.
        const inheritToggle = (inheriting, inheritLabel, onInherit, onSelf) =>
          h(
            'div',
            { style: S.row },
            h(
              'button',
              {
                type: 'button',
                style: { ...S.buttonSmall, ...(inheriting ? SX.inheritOn : null) },
                onClick: onInherit,
              },
              `${TEXT.groupInherit} · ${inheritLabel}`,
            ),
            h(
              'button',
              {
                type: 'button',
                style: { ...S.buttonSmall, ...(inheriting ? null : SX.inheritOn) },
                onClick: onSelf,
              },
              TEXT.groupSelf,
            ),
          )

        return h(
          'div',
          { style: S.condPanel },
          h(
            Field,
            { label: TEXT.rowModes, hint: group ? TEXT.groupInheritFrom : TEXT.allModes },
            group ? inheritToggle(inheritsModes, groupModeText, () => updateEntry(kind, name, { modesFrom: 'group' }), () => updateEntry(kind, name, { modesFrom: 'self', modes: selfModes })) : null,
            inheritsModes
              ? null
              : h(MultiSelect, {
                  items: modeItems,
                  selected: entry.modes,
                  onChange: (values) => updateEntry(kind, name, { modes: values, modesFrom: 'self' }),
                  searchPlaceholder: TEXT.previewAllModes,
                  emptyHint: TEXT.allModes,
                  emptyText: TEXT.noMatches,
                  selectAllLabel: TEXT.selectAll,
                  clearAllLabel: TEXT.clearAll,
                }),
          ),
          h(
            Field,
            { label: TEXT.rowWorkspaces, hint: group ? TEXT.groupInheritFrom : TEXT.allWorkspaces },
            group
              ? inheritToggle(
                  inheritsWorkspaces,
                  groupWorkspaceText,
                  () => updateEntry(kind, name, { workspacesFrom: 'group' }),
                  () => updateEntry(kind, name, { workspacesFrom: 'self', workspaces: selfWorkspaces }),
                )
              : null,
            inheritsWorkspaces
              ? null
              : h(MultiSelect, {
                  items: workspaceItems,
                  selected: entry.workspaces,
                  onChange: (values) => updateEntry(kind, name, { workspaces: values, workspacesFrom: 'self' }),
                  searchPlaceholder: TEXT.previewAllWorkspaces,
                  emptyHint: TEXT.allWorkspaces,
                  emptyText: TEXT.noMatches,
                  selectAllLabel: TEXT.selectAll,
                  clearAllLabel: TEXT.clearAll,
                }),
            inheritsWorkspaces
              ? null
              : h(AddPathRow, {
                  placeholder: TEXT.addPathPlaceholder,
                  label: TEXT.addPath,
                  onAdd: (path) =>
                    updateEntry(kind, name, {
                      workspaces: uniqueStrings([...entry.workspaces, path]),
                      workspacesFrom: 'self',
                    }),
                }),
          ),
        )
      }

      /** One per-tool row: name, summary, enabled switch, scope and history marks. */
      function renderMcpToolRow(server, entry, tool) {
        const name = asString(tool.name)
        const configs = asObject(entry.tools)
        const configured = Object.hasOwn(configs, name)
        const config = normalizeToolScope(configs[name])
        const unavailable = tool.registered === false
        const ambiguous = tool.ambiguous === true
        const jobKey = mcpToolJobKey(server, name)
        const savingRow = saving[`mcp-tool:${jobKey}`] === true
        const toolError = rowErrors[`mcp-tool:${jobKey}`]
        const scopeOpen = expanded[`mcp-tool-scope:${server}:${name}`] === true
        const modeLabels = new Map(inventory.modes.map((mode) => [mode.id, mode.name]))
        const modeText = summarizeList(config.modes, TEXT.allModes, (value) => modeLabels.get(value) || value)
        const workspaceText = summarizeList(config.workspaces, TEXT.allWorkspaces, (value) => baseName(value))
        const modeItems = inventory.modes.map((mode) => ({ value: mode.id, label: mode.name, hint: mode.id }))
        const workspaceItems = inventory.workspaces.map((row) => ({
          value: row.path,
          label: row.name || baseName(row.path),
          hint: row.path,
        }))
        return h(
          'div',
          { key: name, style: { ...SX.mcpToolRow, ...(unavailable ? SX.mcpToolHistory : null) } },
          h(
            'div',
            { style: S.rowMain },
            h(
              'div',
              { style: SX.mcpToolMain },
              h(
                'div',
                { style: S.rowName },
                h('span', { style: S.mono }, name),
                unavailable ? h('span', { style: S.badgeWarn }, TEXT.mcpToolUnavailable) : null,
                ambiguous ? h('span', { style: S.badgeError }, TEXT.mcpToolAmbiguous) : null,
                savingRow ? h('span', { style: S.savingDot }, TEXT.savingItem) : null,
              ),
              asString(tool.summary).length > 0 ? h('div', { style: S.rowDesc }, asString(tool.summary)) : null,
            ),
            h(
              'div',
              { style: S.rowActions },
              ambiguous
                ? [
                    // The Host refuses to save this name (checkbox stays dead),
                    // but clearing a stored config has no attribution check and
                    // must remain possible or the entry becomes uncleanable.
                    h(Toggle, {
                      key: 'enabled',
                      checked: config.enabled === true,
                      disabled: true,
                      label: name,
                      title: TEXT.mcpToolAmbiguous,
                    }),
                    configured
                      ? h(
                          'button',
                          {
                            key: 'clear',
                            type: 'button',
                            style: S.ghostDanger,
                            onClick: () => clearMcpTool(server, name),
                          },
                          TEXT.mcpToolClear,
                        )
                      : null,
                  ]
                : [
                    h(
                      'span',
                      {
                        key: 'modes',
                        role: 'button',
                        tabIndex: 0,
                        style: {
                          ...S.condChip,
                          cursor: 'pointer',
                          ...(config.modes.length > 0 ? SX.condChipOn : null),
                        },
                        title: TEXT.editConditions,
                        onClick: () => toggleToolScope(server, name),
                      },
                      `${TEXT.rowModes}: ${modeText}`,
                    ),
                    h(
                      'span',
                      {
                        key: 'workspaces',
                        role: 'button',
                        tabIndex: 0,
                        style: {
                          ...S.condChip,
                          cursor: 'pointer',
                          ...(config.workspaces.length > 0 ? SX.condChipOn : null),
                        },
                        title: TEXT.editConditions,
                        onClick: () => toggleToolScope(server, name),
                      },
                      `${TEXT.rowWorkspaces}: ${workspaceText}`,
                    ),
                    h(Toggle, {
                      key: 'enabled',
                      checked: config.enabled === true,
                      label: name,
                      title: config.enabled === true ? TEXT.enabled : TEXT.disabled,
                      onChange: (value) => updateMcpTool(server, name, { enabled: value }),
                    }),
                    configured
                      ? h(
                          'button',
                          {
                            key: 'clear',
                            type: 'button',
                            style: S.ghostDanger,
                            onClick: () => clearMcpTool(server, name),
                          },
                          TEXT.mcpToolClear,
                        )
                      : null,
                  ],
            ),
          ),
          ambiguous
            ? h('div', { style: SX.inlineError }, TEXT.mcpToolAmbiguous)
            : scopeOpen
              ? h(
                  'div',
                  { style: SX.mcpToolEditor },
                  h(
                    Field,
                    { label: TEXT.rowModes, hint: TEXT.mcpScopeHint },
                    h(MultiSelect, {
                      items: modeItems,
                      selected: config.modes,
                      onChange: (values) => updateMcpTool(server, name, { modes: values }),
                      searchPlaceholder: TEXT.previewAllModes,
                      emptyHint: TEXT.allModes,
                      emptyText: TEXT.noMatches,
                      selectAllLabel: TEXT.selectAll,
                      clearAllLabel: TEXT.clearAll,
                    }),
                  ),
                  h(
                    Field,
                    { label: TEXT.rowWorkspaces, hint: TEXT.mcpScopeHint },
                    h(MultiSelect, {
                      items: workspaceItems,
                      selected: config.workspaces,
                      onChange: (values) => updateMcpTool(server, name, { workspaces: values }),
                      searchPlaceholder: TEXT.previewAllWorkspaces,
                      emptyHint: TEXT.allWorkspaces,
                      emptyText: TEXT.noMatches,
                      selectAllLabel: TEXT.selectAll,
                      clearAllLabel: TEXT.clearAll,
                    }),
                    h(AddPathRow, {
                      placeholder: TEXT.addPathPlaceholder,
                      label: TEXT.addPath,
                      onAdd: (path) =>
                        updateMcpTool(server, name, {
                          workspaces: uniqueStrings([...config.workspaces, normalizePath(path)]),
                        }),
                    }),
                  ),
                )
              : null,
          toolError ? h('div', { style: SX.rowError, role: 'alert' }, toolError) : null,
        )
      }

      /** The collapsible per-tool block of one MCP member. */
      function renderMcpToolRows(server, entry) {
        const catalog = mcpToolCatalog[server] || { status: 'idle', error: '', tools: [] }
        const configs = asObject(entry.tools)
        const listed = new Map()
        for (const row of asArray(catalog.tools)) {
          const item = asObject(row)
          const name = asString(item.name)
          if (name.length === 0) continue
          listed.set(name, {
            name,
            summary: asString(item.summary),
            registered: item.registered !== false,
            ambiguous: item.ambiguous === true,
          })
        }
        // A configured tool that the catalog has not answered for yet (or no
        // longer lists) still gets a row: its configuration must stay visible
        // and clearable, and a failed catalog read must not hide it.
        for (const name of Object.keys(configs)) {
          if (listed.has(name)) continue
          listed.set(name, {
            name,
            summary: '',
            registered: catalog.status === 'ready' ? false : true,
            ambiguous: false,
          })
        }
        const rows = [...listed.values()]
        const open = expanded[`mcp-tools:${server}`] !== false
        const failed = catalog.status === 'error'
        const loading = catalog.status === 'loading'
        return h(
          'div',
          { style: SX.mcpToolBlock },
          h(
            'div',
            {
              style: SX.mcpToolHead,
              role: 'button',
              tabIndex: 0,
              'aria-label': open ? TEXT.groupCollapse : TEXT.groupExpand,
              title: open ? TEXT.groupCollapse : TEXT.groupExpand,
              onClick: () => toggleMcpTools(server),
            },
            h(
              'span',
              { style: { ...SX.groupCaret, transform: open ? 'rotate(90deg)' : 'none' } },
              '▸',
            ),
            h('span', { style: SX.groupName }, TEXT.mcpToolsTitle),
            h('span', { style: S.countBadge }, `${rows.length} ${TEXT.toolsUnit}`),
            loading ? h('span', { style: S.savingDot }, TEXT.mcpToolsLoading) : null,
          ),
          open
            ? failed
              ? h(
                  'div',
                  { style: S.stack },
                  h('div', { style: SX.inlineError, role: 'alert' }, `${TEXT.mcpToolsFailed}: ${catalog.error}`),
                  h(
                    'button',
                    { type: 'button', style: S.buttonSmall, onClick: () => void loadMcpTools(server) },
                    TEXT.retry,
                  ),
                )
              : rows.length === 0
                ? h('div', { style: S.empty }, loading ? TEXT.mcpToolsLoading : TEXT.mcpToolsEmpty)
                : rows.map((row) => renderMcpToolRow(server, entry, row))
            : null,
        )
      }

      /** Purpose description, injection mode and per-tool rows of one MCP member. */
      function renderMcpConfig(server, entry) {
        const description = cleanPanelDescription(entry.description)
        const progressive = entry.disclosure === 'progressive'
        const describeBusy = isBusy('mcp-describe:' + server)
        const describeError = rowErrors[`mcp-describe:${server}`]
        const configError = rowErrors[`mcp-config:${server}`]
        const configSaving = saving[`mcp-config:${server}`] === true
        const modeLabel = progressive ? TEXT.mcpInjectProgressive : TEXT.mcpInjectFull
        return h(
          'div',
          { style: SX.mcpConfig },
          h(
            Field,
            { label: TEXT.mcpDescription, hint: tf('mcpDescriptionHint', { count: MCP_DESCRIPTION_LIMIT }) },
            h(
              'div',
              { style: S.row },
              h('textarea', {
                style: { ...S.textarea, flex: 1, minHeight: '58px' },
                value: description,
                maxLength: MCP_DESCRIPTION_LIMIT,
                placeholder: TEXT.mcpDescriptionPlaceholder,
                'aria-label': TEXT.mcpDescription,
                onChange: (event) => updateMcpConfig(server, { description: event.target.value }),
              }),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px' } },
                h(
                  'button',
                  {
                    type: 'button',
                    style: S.buttonSmall,
                    disabled: describeBusy,
                    onClick: () => void generateMcpDescription(server),
                  },
                  describeBusy ? TEXT.mcpDescribing : TEXT.mcpDescribe,
                ),
                h('span', { style: S.fieldHint }, `${description.length}/${MCP_DESCRIPTION_LIMIT}`),
              ),
            ),
          ),
          // Generation and saving have separate failures; one must not hide the
          // other when they happen close together.
          describeError ? h('div', { style: SX.inlineError, role: 'alert' }, describeError) : null,
          configError ? h('div', { style: SX.inlineError, role: 'alert' }, configError) : null,
          h(
            'div',
            { style: SX.mcpConfigActions },
            h('span', { style: S.switchLabel }, `${TEXT.mcpInjectMode}: ${modeLabel}`),
            h(Toggle, {
              checked: progressive,
              label: TEXT.mcpInjectMode,
              title: progressive ? TEXT.mcpInjectProgressiveHint : TEXT.mcpInjectFullHint,
              onChange: (value) =>
                updateMcpConfig(server, { disclosure: value ? 'progressive' : 'full' }, { immediate: true }),
            }),
            h(
              'span',
              { style: S.fieldHint },
              progressive ? TEXT.mcpInjectProgressiveHint : TEXT.mcpInjectFullHint,
            ),
            // Progressive injection only exists while the MCP gate is active;
            // saying so next to the switch avoids a silently inert toggle.
            settings.mcpGate === false ? h('span', { style: S.badgeWarn }, TEXT.mcpGateOff) : null,
            configSaving ? h('span', { style: S.savingDot }, TEXT.savingItem) : null,
          ),
          renderMcpToolRows(server, entry),
          h('div', { style: SX.mcpHint }, TEXT.mcpHint),
        )
      }

      function renderItemRow(kind, name, isLast) {
        const isMcp = kind === MCP
        const entry = (isMcp ? state.mcp[name] : state.skills[name]) || blankEntry()
        const info = isMcp ? mcpMeta.get(name) : skillMeta.get(name)
        const key = `${kind}:${name}`
        const open = expanded[key] === true
        const confirming = confirmItem === key
        const removeBusy = isBusy('remove:' + key)
        const mountState = isMcp ? mounts[name] : null
        const modeLabels = new Map(inventory.modes.map((mode) => [mode.id, mode.name]))
        const groupInfo = !isMcp && info && asString(info.groupKey).length > 0 ? state.groups[asString(info.groupKey)] || null : null
        const inheritsModes = groupInfo !== null && entry.modesFrom === 'group'
        const inheritsWorkspaces = groupInfo !== null && entry.workspacesFrom === 'group'
        const effectiveModes = inheritsModes ? asStringArray(groupInfo.modes) : entry.modes
        const effectiveWorkspaces = inheritsWorkspaces ? asStringArray(groupInfo.workspaces) : entry.workspaces
        const modeText = summarizeList(effectiveModes, TEXT.allModes, (value) => modeLabels.get(value) || value)
        const workspaceText = summarizeList(effectiveWorkspaces, TEXT.allWorkspaces, (value) => baseName(value))
        const sourceLabel = info ? info.sourceLabel || info.sourceId : ''
        const groupOff = groupInfo !== null && groupInfo.enabled === false
        return h(
          'div',
          { style: { ...S.rowItem, ...(isLast ? S.rowItemLast : null) } },
          h(
            'div',
            {
              style: S.rowMain,
              // The whole left block answers "what does this do?" on hover.
              title: info && info.description ? asString(info.description) : undefined,
            },
            h(
              'div',
              { style: S.rowText },
              h(
                'div',
                { style: S.rowName },
                h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, name),
                isMcp && info
                  ? h(
                      'span',
                      {
                        style: {
                          ...S.badge,
                          color: 'var(--rp-mcp)',
                          background: 'var(--rp-mcp-weak)',
                          borderColor: 'var(--rp-mcp-line)',
                        },
                      },
                      `${asNumber(info.toolCount, 0)} ${TEXT.toolsUnit}`,
                    )
                  : null,
                isMcp && mountState ? h('span', { style: S.badge }, mountLabel(mountState.state)) : null,
                !isMcp && sourceLabel ? h('span', { style: S.badge }, `${TEXT.sourceFrom}: ${sourceLabel}`) : null,
                !isMcp && info && info.missing
                  ? h('span', { style: { ...S.badge, ...S.badgeError } }, TEXT.missingFile)
                  : null,
                !isMcp && info && info.modelInvocable === false
                  ? h('span', { style: S.badge }, TEXT.modelInvocableOff)
                  : null,
                saving[key] === true ? h('span', { style: S.savingDot }, TEXT.savingItem) : null,
              ),
              // The description is intentionally not printed in the list: real skill
              // descriptions run for paragraphs, and a list of them stops being a
              // list. It is reachable on hover (the row carries it as its title).
              !info ? h('div', { style: S.rowDesc }, TEXT.skillMissing) : null,
              isMcp && mountState && mountState.state === 'failed' && mountState.error
                ? h('div', { style: SX.inlineError }, mountState.error)
                : null,
              !isMcp && info && info.missing ? h('div', { style: SX.inlineError }, TEXT.missingFileHint) : null,
            ),
            h(
              'div',
              { style: S.rowActions },
              h(
                'span',
                {
                  role: 'button',
                  tabIndex: 0,
                  style: {
                    ...S.condChip,
                    cursor: 'pointer',
                    ...(effectiveModes.length > 0 ? SX.condChipOn : null),
                  },
                  title: TEXT.editConditions,
                  onClick: () => toggleExpanded(key),
                },
                `${TEXT.rowModes}: ${modeText}${inheritsModes ? TEXT.groupInheritTag : ''}`,
              ),
              groupOff ? h('span', { style: S.badgeWarn }, TEXT.groupDisabledTag) : null,
              h(
                'span',
                {
                  role: 'button',
                  tabIndex: 0,
                  style: {
                    ...S.condChip,
                    cursor: 'pointer',
                    ...(effectiveWorkspaces.length > 0 ? SX.condChipOn : null),
                  },
                  title: TEXT.editConditions,
                  onClick: () => toggleExpanded(key),
                },
                `${TEXT.rowWorkspaces}: ${workspaceText}${inheritsWorkspaces ? TEXT.groupInheritTag : ''}`,
              ),
              h(Toggle, {
                checked: entry.enabled === true,
                label: name,
                title: entry.enabled === true ? TEXT.enabled : TEXT.disabled,
                onChange: (value) => updateEntry(kind, name, { enabled: value }),
              }),
              h(
                'button',
                {
                  type: 'button',
                  style: S.ghostDanger,
                  disabled: removeBusy,
                  onClick: () => setConfirmItem(confirming ? '' : key),
                },
                removeBusy ? TEXT.removing : TEXT.removeItem,
              ),
            ),
          ),
          confirming
            ? h(
                'div',
                { style: SX.confirmRow },
                h('span', { style: SX.confirmText }, isMcp ? TEXT.deleteMcpConfirm : TEXT.deleteSkillConfirm),
                h(
                  'button',
                  {
                    type: 'button',
                    style: S.buttonDanger,
                    disabled: removeBusy,
                    onClick: () => void removeItem(kind, name),
                  },
                  removeBusy ? TEXT.removing : TEXT.sourceDeleteYes,
                ),
                h(
                  'button',
                  { type: 'button', style: S.buttonSmall, onClick: () => setConfirmItem('') },
                  TEXT.sourceDeleteCancel,
                ),
              )
            : null,
          open ? renderCondEditor(kind, name, entry) : null,
          // The new MCP block goes after the existing row actions and condition
          // editor so clicking 删除 / Modes still changes something adjacent.
          isMcp ? renderMcpConfig(name, entry) : null,
          rowErrors[key] ? h('div', { style: SX.rowError, role: 'alert' }, rowErrors[key]) : null,
        )
      }

      function groupScopeText(group, dimension) {
        const modeLabels = new Map(inventory.modes.map((mode) => [mode.id, mode.name]))
        if (dimension === 'modes') {
          return summarizeList(group ? asStringArray(group.modes) : [], TEXT.allModes, (value) => modeLabels.get(value) || value)
        }
        return summarizeList(group ? asStringArray(group.workspaces) : [], TEXT.allWorkspaces, (value) => baseName(value))
      }

      function renderGroupHead(key, name, count) {
        const group = state.groups[key] || null
        const open = expanded['group:' + key] === true
        const folded = groupOpen[key] !== true
        return h(
          'div',
          { style: SX.groupHead },
          h(
            'span',
            {
              role: 'button',
              tabIndex: 0,
              'aria-label': folded ? TEXT.groupExpand : TEXT.groupCollapse,
              title: folded ? TEXT.groupExpand : TEXT.groupCollapse,
              style: { ...SX.groupCaret, transform: folded ? 'none' : 'rotate(90deg)' },
              onClick: () => toggleGroupOpen(key),
            },
            '▸',
          ),
          h(
            'span',
            { style: SX.groupName, title: name, onClick: () => toggleGroupOpen(key) },
            name,
          ),
          group !== null && group.enabled === false
            ? h('span', { style: S.badgeWarn }, TEXT.groupDisabledTag)
            : null,
          h('span', { style: S.countBadge }, `${count} ${TEXT.countUnit}`),
          h(
            'span',
            {
              role: 'button',
              tabIndex: 0,
              style: {
                ...S.condChip,
                cursor: 'pointer',
                ...(groupScopeText(group, 'modes').length > 0 && group && asStringArray(group.modes).length > 0 ? SX.condChipOn : null),
              },
              title: TEXT.editConditions,
              onClick: () => toggleExpanded('group:' + key),
            },
            `${TEXT.rowModes}: ${groupScopeText(group, 'modes')}`,
          ),
          h(
            'span',
            {
              role: 'button',
              tabIndex: 0,
              style: {
                ...S.condChip,
                cursor: 'pointer',
                ...(group && asStringArray(group.workspaces).length > 0 ? SX.condChipOn : null),
              },
              title: TEXT.editConditions,
              onClick: () => toggleExpanded('group:' + key),
            },
            `${TEXT.rowWorkspaces}: ${groupScopeText(group, 'workspaces')}`,
          ),
          h(Toggle, {
            checked: group === null || group.enabled !== false,
            label: `${TEXT.settingsGroups} ${name}`,
            title: group !== null && group.enabled === false ? TEXT.disabled : TEXT.enabled,
            onChange: (value) => updateGroup(key, { enabled: value }),
          }),
        )
      }

      function renderGroupEditor(key, group) {
        const modeItems = inventory.modes.map((mode) => ({ value: mode.id, label: mode.name, hint: mode.id }))
        const workspaceItems = inventory.workspaces.map((row) => ({
          value: row.path,
          label: row.name || baseName(row.path),
          hint: row.path,
        }))
        return h(
          'div',
          { style: { ...S.condPanel, marginBottom: '6px' } },
          h(
            Field,
            { label: TEXT.rowModes, hint: TEXT.groupHint },
            h(MultiSelect, {
              items: modeItems,
              selected: group ? asStringArray(group.modes) : [],
              onChange: (values) => updateGroup(key, { modes: values }),
              searchPlaceholder: TEXT.previewAllModes,
              emptyHint: TEXT.allModes,
              emptyText: TEXT.noMatches,
              selectAllLabel: TEXT.selectAll,
              clearAllLabel: TEXT.clearAll,
            }),
          ),
          h(
            Field,
            { label: TEXT.rowWorkspaces, hint: TEXT.groupHint },
            h(MultiSelect, {
              items: workspaceItems,
              selected: group ? asStringArray(group.workspaces) : [],
              onChange: (values) => updateGroup(key, { workspaces: values }),
              searchPlaceholder: TEXT.previewAllWorkspaces,
              emptyHint: TEXT.allWorkspaces,
              emptyText: TEXT.noMatches,
              selectAllLabel: TEXT.selectAll,
              clearAllLabel: TEXT.clearAll,
            }),
            h(AddPathRow, {
              placeholder: TEXT.addPathPlaceholder,
              label: TEXT.addPath,
              onAdd: (path) =>
                updateGroup(key, {
                  workspaces: uniqueStrings([...(group ? asStringArray(group.workspaces) : []), path]),
                }),
            }),
          ),
        )
      }

      function renderSkillSection(row) {
        const editorOpen = expanded['group:' + row.key] === true
        const folded = groupOpen[row.key] !== true
        return h(
          'div',
          { key: row.key, style: SX.groupBox },
          renderGroupHead(row.key, row.name, row.names.length),
          editorOpen ? renderGroupEditor(row.key, row.group) : null,
          folded
            ? null
            : row.names.map((name, index) =>
                safeNode(`skill:${name}`, () => renderItemRow(SKILL, name, index === row.names.length - 1)),
              ),
        )
      }

      function renderUngroupedSection() {
        const folded = groupOpen.ungrouped !== true
        return h(
          'div',
          { key: 'ungrouped', style: SX.groupBox },
          h(
            'div',
            { style: SX.groupHead },
            h(
              'span',
              {
                role: 'button',
                tabIndex: 0,
                'aria-label': folded ? TEXT.groupExpand : TEXT.groupCollapse,
                title: folded ? TEXT.groupExpand : TEXT.groupCollapse,
                style: { ...SX.groupCaret, transform: folded ? 'none' : 'rotate(90deg)' },
                onClick: () => toggleGroupOpen('ungrouped'),
              },
              '▸',
            ),
            h(
              'span',
              { style: SX.groupName, title: TEXT.groupUngrouped, onClick: () => toggleGroupOpen('ungrouped') },
              TEXT.groupUngrouped,
            ),
            h('span', { style: S.countBadge }, `${ungroupedSkills.length} ${TEXT.countUnit}`),
          ),
          folded
            ? null
            : ungroupedSkills.map((name, index) =>
                safeNode(`skill:${name}`, () => renderItemRow(SKILL, name, index === ungroupedSkills.length - 1)),
              ),
        )
      }

      function renderSkillSections() {
        return h(
          'div',
          null,
          ...groupList.map((row) => renderSkillSection(row)),
          ungroupedSkills.length > 0 ? renderUngroupedSection() : null,
        )
      }

      function renderGroup(kind) {
        const isMcp = kind === MCP
        const names = isMcp ? mcpNames : skillNames
        return h(
          'div',
          { style: { ...S.card, ...(isMcp ? S.cardMcp : S.cardSkill) } },
          h(
            'div',
            { style: S.cardHead },
            h(
              'div',
              { style: S.cardTitleRow },
              h('span', { style: S.cardTitle }, isMcp ? TEXT.cardMcp : TEXT.cardSkills),
              h('span', { style: S.countBadge }, String(names.length)),
            ),
          ),
          !isMcp && names.length > 0 ? h('div', { style: S.cardDesc }, TEXT.groupHint) : null,
          names.length === 0
            ? h('div', { style: SX.groupEmpty }, isMcp ? TEXT.groupEmptyMcp : TEXT.groupEmptySkills)
            : isMcp
              ? names.map((name, index) =>
                  safeNode(`${kind}:${name}`, () => renderItemRow(kind, name, index === names.length - 1)),
                )
              : renderSkillSections(),
        )
      }

      function renderNativeSkills() {
        const rows = inventory.nativeSkills
        return h(
          'div',
          { style: { ...S.card, ...S.cardSystem } },
          h(
            'div',
            { style: S.cardHead },
            h(
              'div',
              { style: S.cardTitleRow },
              h('span', { style: S.cardTitle }, TEXT.systemSkillsTitle),
              h('span', { style: S.countBadge }, String(rows.length)),
            ),
          ),
          h('div', { style: S.cardDesc }, TEXT.systemSkillsHint),
          rows.length === 0
            ? h('div', { style: SX.groupEmpty }, TEXT.systemSkillsEmpty)
            : rows.map((row, index) =>
                h(
                  'div',
                  {
                    key: row.name,
                    style: { ...SX.nativeRow, ...(index === rows.length - 1 ? SX.nativeRowLast : null) },
                    // Same rule as pool rows: the description is a hover detail.
                    title: row.description ? asString(row.description) : undefined,
                  },
                  h(
                    'div',
                    { style: S.rowName },
                    h('span', { style: S.mono }, row.name),
                    row.provider ? h('span', { style: S.badge }, row.provider) : null,
                    row.source ? h('span', { style: S.badge }, row.source) : null,
                  ),
                ),
              ),
        )
      }

      function renderResources() {
        const total = skillNames.length + mcpNames.length
        return h(
          'div',
          { style: S.stack },
          renderPreview(),
          total === 0 ? renderEmptyState() : null,
          renderGroup(SKILL),
          renderGroup(MCP),
          renderNativeSkills(),
        )
      }

      function renderSourceRow(source, isLast) {
        const check = source.lastCheck || { at: '', status: '', remote: '', error: '' }
        const status = asString(check.status)
        const isGit = source.kind === 'git'
        const checkKey = 'sources:check:' + source.id
        const updateKey = 'source:update:' + source.id
        const deleteKey = 'source:delete:' + source.id
        const checkBusy = isBusy(checkKey)
        const updateBusy = isBusy(updateKey)
        const deleteBusy = isBusy(deleteKey)
        const confirming = confirmSource === source.id
        return h(
          'div',
          { style: { ...S.sourceRow, ...(isLast ? { borderBottom: 'none' } : null) } },
          h(
            'div',
            { style: S.sourceMain },
            h(
              'div',
              { style: S.sourceName },
              h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, source.label || source.id),
              h('span', { style: S.badge }, kindLabel(source.kind)),
              h('span', { style: statusBadgeStyle(status) }, statusLabel(status)),
              check.at ? h('span', { style: S.savingDot }, `${TEXT.lastCheck} ${formatTime(check.at)}`) : null,
            ),
            h(
              'div',
              { style: S.sourceMeta },
              h(
                'span',
                { style: S.fieldHint },
                `${source.skills.length} ${source.skills.length === 1 ? TEXT.sourceSkillsUnitOne : TEXT.sourceSkillsUnit}`,
              ),
              isGit && asStringArray(source.excluded).length > 0
                ? h(
                    'span',
                    { style: S.badgeWarn, title: TEXT.sourceRestoreHint },
                    tf('sourceExcluded', { count: asStringArray(source.excluded).length }),
                  )
                : null,
              isGit && source.project
                ? h(
                    'span',
                    { style: S.fieldHint },
                    `${source.project}${source.branch ? '@' + source.branch : ''}`,
                  )
                : null,
              isGit && source.sha ? h('span', { style: S.mono }, `${TEXT.sourceSha} ${asString(source.sha).slice(0, 8)}`) : null,
              source.digest ? h('span', { style: S.mono }, `${TEXT.sourceDigest} ${shortDigest(source.digest)}`) : null,
              source.createdAt
                ? h('span', { style: S.fieldHint }, `${TEXT.sourceCreatedAt} ${formatTime(source.createdAt)}`)
                : null,
            ),
            status === 'error' && check.error ? h('div', { style: SX.inlineError }, check.error) : null,
            confirming
              ? h(
                  'div',
                  { style: SX.confirmRow },
                  h('span', { style: SX.confirmText }, TEXT.sourceDeleteConfirm),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: S.buttonDanger,
                      disabled: deleteBusy,
                      onClick: () => void deleteSource(source.id),
                    },
                    deleteBusy ? TEXT.sourceDeleting : TEXT.sourceDeleteYes,
                  ),
                  h(
                    'button',
                    { type: 'button', style: S.buttonSmall, onClick: () => setConfirmSource('') },
                    TEXT.sourceDeleteCancel,
                  ),
                )
              : null,
          ),
          h(
            'div',
            { style: S.rowActions },
            isGit
              ? h(
                  'button',
                  {
                    type: 'button',
                    style: S.buttonSmall,
                    disabled: checkBusy || updateBusy,
                    onClick: () => void checkSources([source.id]),
                    title: TEXT.sourceCheck,
                  },
                  checkBusy ? TEXT.sourceChecking : TEXT.sourceCheck,
                )
              : h('span', { style: S.badge, title: TEXT.sourceNotGit }, TEXT.sourceReadOnly),
            isGit && asStringArray(source.excluded).length > 0
              ? h(
                  'button',
                  {
                    type: 'button',
                    style: S.buttonSmall,
                    disabled: updateBusy || checkBusy,
                    title: TEXT.sourceRestoreHint,
                    onClick: () => void updateSource(source.id, { restore: true }),
                  },
                  updateBusy ? TEXT.sourceRestoring : TEXT.sourceRestore,
                )
              : null,
            isGit
              ? h(
                  'button',
                  {
                    type: 'button',
                    style: status === 'update-available' ? S.buttonPrimary : S.buttonSmall,
                    disabled: updateBusy || checkBusy,
                    onClick: () => void updateSource(source.id),
                  },
                  updateBusy ? TEXT.sourceUpdating : TEXT.sourceUpdate,
                )
              : null,
            h(
              'button',
              { type: 'button', style: S.ghostDanger, onClick: () => setConfirmSource(confirming ? '' : source.id) },
              TEXT.sourceDelete,
            ),
          ),
        )
      }

      function renderSources() {
        const checkAllBusy = isBusy('sources:check:all')
        return h(
          'div',
          { style: S.stack },
          h(
            'div',
            { style: S.card },
            h(
              'div',
              { style: S.cardHead },
              h(
                'div',
                { style: S.cardTitleRow },
                h('span', { style: S.cardTitle }, TEXT.tabSources),
                h('span', { style: S.countBadge }, String(sourceList.length)),
              ),
              h(
                'div',
                { style: S.row },
                h(
                  'button',
                  {
                    type: 'button',
                    style: S.buttonSmall,
                    disabled: checkAllBusy || sourceList.length === 0,
                    onClick: () => void checkSources([]),
                  },
                  checkAllBusy ? TEXT.checkingAll : TEXT.checkAll,
                ),
                h('button', { type: 'button', style: S.buttonSmall, onClick: () => void loadBoard() }, TEXT.refresh),
              ),
            ),
            h('div', { style: S.cardDesc }, TEXT.sourcesHint),
            sourceList.length === 0
              ? h('div', { style: S.empty }, TEXT.sourcesEmpty)
              : sourceSections.map((section) => {
                  const openKey = 'src:' + section.key
                  const folded = groupOpen[openKey] !== true
                  const gitIds = section.rows.filter((row) => row.kind === 'git').map((row) => row.id)
                  const groupCheckBusy = gitIds.length > 0 && isBusy('sources:check:' + gitIds.join(','))
                  const groupUpdateBusy = isBusy('group:update:' + section.key)
                  const groupStatus = sourceGroupStatus(section.rows)
                  return h(
                    'div',
                    { key: section.key, style: SX.groupBox },
                    h(
                      'div',
                      { style: SX.groupHead },
                      h(
                        'span',
                        {
                          role: 'button',
                          tabIndex: 0,
                          'aria-label': folded ? TEXT.groupExpand : TEXT.groupCollapse,
                          title: folded ? TEXT.groupExpand : TEXT.groupCollapse,
                          style: { ...SX.groupCaret, transform: folded ? 'none' : 'rotate(90deg)' },
                          onClick: () => toggleGroupOpen(openKey),
                        },
                        '▸',
                      ),
                      h(
                        'span',
                        { style: SX.groupName, title: section.name, onClick: () => toggleGroupOpen(openKey) },
                        section.name,
                      ),
                      h(
                        'span',
                        { style: S.countBadge },
                        tf(section.rows.length === 1 ? 'groupImportOne' : 'groupImports', { count: section.rows.length }),
                      ),
                      groupStatus.length > 0
                        ? h('span', { style: statusBadgeStyle(groupStatus) }, statusLabel(groupStatus))
                        : null,
                      gitIds.length > 0
                        ? h(
                            'button',
                            {
                              type: 'button',
                              style: S.buttonSmall,
                              disabled: groupCheckBusy || groupUpdateBusy,
                              onClick: () => void checkSources(gitIds),
                            },
                            groupCheckBusy ? TEXT.sourceChecking : TEXT.sourceCheck,
                          )
                        : null,
                      gitIds.length > 0
                        ? h(
                            'button',
                            {
                              type: 'button',
                              style: groupStatus === 'update-available' ? S.buttonPrimary : S.buttonSmall,
                              disabled: groupCheckBusy || groupUpdateBusy,
                              onClick: () => void updateGroupSources(section.key, gitIds),
                            },
                            groupUpdateBusy ? TEXT.sourceUpdating : TEXT.sourceUpdate,
                          )
                        : null,
                    ),
                    folded
                      ? null
                      : section.rows.map((source, index) =>
                          safeNode('source:' + source.id, () => renderSourceRow(source, index === section.rows.length - 1)),
                        ),
                  )
                }),
          ),
        )
      }

      function renderSettings() {
        const savingSettings = isBusy('settings')
        return h(
          'div',
          { style: S.stack },
          h(
            'div',
            { style: S.card },
            h(
              'div',
              { style: S.cardHead },
              h(
                'div',
                { style: S.cardTitleRow },
                h('span', { style: S.cardTitle }, TEXT.tabSettings),
                savingSettings ? h('span', { style: S.savingDot }, TEXT.settingsSaving) : null,
              ),
            ),
            h(SwitchRow, {
              label: TEXT.setEnabled,
              hint: TEXT.setEnabledHint,
              checked: settings.enabled === true,
              disabled: savingSettings,
              onChange: (value) => void saveSettings({ enabled: value }),
            }),
            h(SwitchRow, {
              label: TEXT.setMcpGate,
              hint: TEXT.setMcpGateHint,
              checked: settings.mcpGate === true,
              disabled: savingSettings,
              onChange: (value) => void saveSettings({ mcpGate: value }),
            }),
            h(SwitchRow, {
              label: `${TEXT.setGateDefaultSkills} · ${TEXT.notAvailable}`,
              hint: TEXT.setGateDefaultSkillsHint,
              checked: settings.gateDefaultSkills === true,
              disabled: true,
              onChange: () => {},
            }),
            h('div', { style: S.cardDesc }, TEXT.settingsHint),
          ),
          h(
            'div',
            { style: S.row },
            meta.file ? h('span', { style: S.fieldHint }, `${TEXT.stateFile}: ${asString(meta.file)}`) : null,
            meta.version !== undefined && asString(meta.version).length > 0
              ? h('span', { style: S.fieldHint }, `${TEXT.version}: ${asString(meta.version)}`)
              : null,
            h('button', { type: 'button', style: S.buttonSmall, onClick: () => void loadBoard() }, TEXT.refresh),
          ),
        )
      }

      function renderDialog() {
        if (!dialog) return null
        return h(ImportDialog, {
          modes: inventory.modes,
          workspaces: inventory.workspaces,
          onSubmit: submitImport,
          pollMounts,
          onRefresh: async () => {
            await loadBoard({ silent: true })
          },
          onDone: (message) => void afterImport(message),
          onClose: () => setDialog(false),
        })
      }

      return h(
        'div',
        { style: S.page, className: 'dsh-rp-root' },
        h('style', null, PAGE_CSS),
        h(
          'div',
          { style: S.headerRow },
          h(
            'div',
            { style: S.titleWrap },
            h('h2', { style: S.title }, TEXT.title),
            h('p', { style: S.subtitle }, TEXT.subtitle),
          ),
          h(
            'div',
            { style: S.toolbar },
            // Importing and scoping are two separate jobs: import lives with the
            // page actions, conditions are edited on each resource row.
            h('button', { type: 'button', style: S.buttonPrimary, onClick: () => setDialog(true) }, TEXT.importResource),
            h(
              'button',
              { type: 'button', style: S.button, onClick: () => void loadBoard(), disabled: loading },
              loading ? TEXT.loading : TEXT.refresh,
            ),
          ),
        ),
        error
          ? h(
              'div',
              { style: { ...S.error, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }, role: 'alert' },
              h('span', { style: { minWidth: 0 } }, error),
              h('button', { type: 'button', style: S.buttonSmall, onClick: () => setError('') }, TEXT.close),
            )
          : null,
        notice ? h('div', { style: S.notice, role: 'status' }, notice) : null,
        activationWarning
          ? h(
              'div',
              { style: S.activationWarning, role: 'alert' },
              h('span', { style: { minWidth: 0 } }, activationWarning.message),
              h(
                'button',
                { type: 'button', style: S.buttonSmall, onClick: () => setActivationWarning(dismissActivationWarning()) },
                TEXT.close,
              ),
            )
          : null,
        board
          ? h(
              React.Fragment,
              null,
              h(
                'div',
                { style: S.tabs },
                ...TABS.map(([key, textKey]) =>
                  h(
                    'button',
                    {
                      key,
                      type: 'button',
                      style: { ...S.tab, ...(tab === key ? S.tabActive : null) },
                      onClick: (event) => {
                        event.currentTarget.blur()
                        setTab(key)
                      },
                    },
                    t(textKey),
                  ),
                ),
              ),
              tab === 'resources' ? renderResources() : null,
              tab === 'sources' ? renderSources() : null,
              tab === 'settings' ? renderSettings() : null,
            )
          : h(
              'div',
              { style: S.stack },
              h('div', { style: S.empty }, loading ? TEXT.loading : TEXT.retryHint),
              loading
                ? null
                : h(
                    'div',
                    null,
                    h('button', { type: 'button', style: S.buttonPrimary, onClick: () => void loadBoard() }, TEXT.retry),
                  ),
            ),
        renderDialog(),
      )
    }

    // ---------------------------------------------------------------- dialog

    /** Single import dialog with four segments (files / ZIP / Git / MCP). */
    function ImportDialog(props) {
      const [seg, setSeg] = useState('files')
      const [pickedFiles, setPickedFiles] = useState([])
      const [pickedNames, setPickedNames] = useState([])
      const [name, setName] = useState('')
      const [description, setDescription] = useState('')
      const [body, setBody] = useState('')
      const [zipFile, setZipFile] = useState(null)
      const [zipLabel, setZipLabel] = useState('')
      const [gitUrl, setGitUrl] = useState('')
      const [gitProvider, setGitProvider] = useState('auto')
      const [gitBranch, setGitBranch] = useState('')
      const [gitSubdir, setGitSubdir] = useState('')
      const [gitToken, setGitToken] = useState('')
      const [gitLabel, setGitLabel] = useState('')
      const [json, setJson] = useState(
        '{\n  "mcpServers": {\n    "my-server": {\n      "url": "https://example.com/mcp"\n    }\n  }\n}',
      )
      const [overwrite, setOverwrite] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [result, setResult] = useState(null)
      const [mountRows, setMountRows] = useState(null)
      const mounted = useRef(true)
      const pollRef = useRef(null)

      useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
          if (pollRef.current) clearInterval(pollRef.current)
        }
      }, [])

      const modeItems = useMemo(
        () => asArray(props.modes).map((mode) => ({ value: mode.id, label: mode.name || mode.id, hint: mode.id })),
        [props.modes],
      )
      const workspaceItems = useMemo(
        () =>
          asArray(props.workspaces).map((row) => ({
            value: row.path,
            label: row.name || baseName(row.path),
            hint: row.path,
          })),
        [props.workspaces],
      )

      const mountSettled =
        mountRows === null ||
        Object.values(mountRows).every((value) => !value || value.state !== 'mounting')

      async function pickFiles(event, fromFolder) {
        const picked = [...(event.target.files || [])]
        // Drop focus so the wrapping label never shows a ring after the pick.
        event.target.blur()
        if (picked.length === 0) return
        setError('')
        setBusy(true)
        try {
          const out = []
          for (const file of picked) {
            if (Number(file.size) > MAX_UPLOAD_BYTES) {
              throw new Error(`${asString(file.name)}: ${TEXT.filesTooLarge}`)
            }
            out.push({
              path: asString(file.webkitRelativePath) || asString(file.name),
              contentBase64: await readFileBase64(file),
            })
          }
          setPickedFiles(out)
          setPickedNames(picked.map((file) => asString(file.name)))
          const primary = fromFolder
            ? picked.find((file) => asString(file.webkitRelativePath).endsWith('SKILL.md'))
            : picked.length === 1
              ? picked[0]
              : picked.find((file) => asString(file.name).toLowerCase().endsWith('.md'))
          if (primary && name.trim().length === 0) setName(asString(primary.name).replace(/\.md$/i, ''))
        } catch (cause) {
          if (mounted.current) setError(messageOf(cause))
        } finally {
          if (mounted.current) setBusy(false)
        }
      }

      function startMountPolling() {
        if (pollRef.current) clearInterval(pollRef.current)
        let elapsed = 0
        pollRef.current = setInterval(() => {
          elapsed += MOUNT_POLL_MS
          void (async () => {
            try {
              const next = await props.pollMounts()
              if (!mounted.current) return
              setMountRows((current) => ({ ...(current || {}), ...next }))
              const stillMounting = Object.values(next).some((value) => value && value.state === 'mounting')
              if (!stillMounting) {
                clearInterval(pollRef.current)
                pollRef.current = null
                void props.onRefresh()
              }
            } catch {
              /* keep polling */
            }
            if (elapsed >= 30000 && pollRef.current) {
              clearInterval(pollRef.current)
              pollRef.current = null
            }
          })()
        }, MOUNT_POLL_MS)
      }

      async function submit() {
        setError('')
        setResult(null)
        // Importing never asks for conditions: a new resource is admitted for every
        // mode and workspace, and its scope is edited on its row afterwards.
        const scopeBody = {}
        let payloadBody = null
        if (seg === 'files') {
          const files =
            pickedFiles.length > 0
              ? pickedFiles
              : body.trim().length > 0
                ? [{ path: 'SKILL.md', contentBase64: encodeTextBase64(body) }]
                : []
          if (files.length === 0) {
            setError(TEXT.filesNeed)
            return
          }
          payloadBody = { files, name: name.trim(), description: description.trim(), ...scopeBody, overwrite }
        } else if (seg === 'zip') {
          if (!zipFile) {
            setError(TEXT.zipNeed)
            return
          }
          setBusy(true)
          try {
            payloadBody = {
              archiveBase64: await readFileBase64(zipFile),
              label: zipLabel.trim(),
              ...scopeBody,
              overwrite,
            }
          } catch (cause) {
            if (mounted.current) {
              setError(`${TEXT.filesReadFailed}: ${messageOf(cause)}`)
              setBusy(false)
            }
            return
          }
        } else if (seg === 'git') {
          const url = gitUrl.trim()
          if (url.length === 0) {
            setError(TEXT.gitNeedUrl)
            return
          }
          payloadBody = {
            url,
            provider: gitProvider,
            branch: gitBranch.trim(),
            subdir: gitSubdir.trim(),
            token: gitToken.trim(),
            label: gitLabel.trim(),
            ...scopeBody,
            overwrite,
          }
        } else {
          const text = json.trim()
          if (text.length === 0) {
            setError(TEXT.mcpJsonInvalid)
            return
          }
          let parsed = null
          try {
            parsed = JSON.parse(text)
          } catch (cause) {
            setError(`${TEXT.mcpJsonBad}: ${messageOf(cause)}`)
            return
          }
          payloadBody = { payload: parsed, ...scopeBody }
        }

        setBusy(true)
        try {
          const payload = await props.onSubmit(seg, payloadBody)
          if (!mounted.current) return
          if (seg === 'mcp') {
            const initial = normalizeMount(payload.mounts || payload.mount)
            const rows = {}
            for (const row of asArray(payload.servers)) {
              const serverName = asString(row && (row.server || row.serverName))
              if (serverName.length === 0) continue
              rows[serverName] = initial[serverName] || {
                state: asString(row.state) === 'failed' ? 'failed' : 'mounting',
                error: '',
              }
            }
            for (const [serverName, value] of Object.entries(initial)) {
              if (!rows[serverName]) rows[serverName] = value
            }
            setMountRows(rows)
            setResult({ installed: Object.keys(rows), failures: [] })
            startMountPolling()
          } else {
            const installed = asStringArray(payload.installed)
            const failures = asArray(payload.failures).map((row) => ({
              name: asString(row && row.name),
              error: asString(row && row.error),
            }))
            if (failures.length === 0) {
              props.onDone(installed.length > 0 ? `${TEXT.importInstalled}: ${installed.join(', ')}` : TEXT.importInstalled)
              return
            }
            setResult({ installed, failures })
            void props.onRefresh()
          }
        } catch (cause) {
          if (mounted.current) setError(messageOf(cause))
        } finally {
          if (mounted.current) setBusy(false)
        }
      }

      function doneMessage() {
        const names = mountRows ? Object.keys(mountRows) : result ? result.installed : []
        return names.length > 0 ? `${TEXT.mcpNotice} ${names.join(', ')}` : TEXT.importInstalled
      }

      function renderFiles() {
        return h(
          React.Fragment,
          null,
          h(
            'div',
            { style: S.fileRow },
            h(
              'label',
              { style: S.buttonSmall },
              TEXT.filesPick,
              h('input', {
                type: 'file',
                accept: '.md,.markdown,text/markdown',
                multiple: true,
                style: { display: 'none' },
                onChange: (event) => void pickFiles(event, false),
              }),
            ),
            h(
              'label',
              { style: S.buttonSmall },
              TEXT.filesPickFolder,
              h('input', {
                type: 'file',
                multiple: true,
                webkitdirectory: '',
                style: { display: 'none' },
                onChange: (event) => void pickFiles(event, true),
              }),
            ),
            pickedNames.length > 0
              ? h('span', { style: S.fieldHint }, `${TEXT.filesChosen}: ${pickedNames.join(', ')}`)
              : null,
          ),
          h(
            Field,
            { label: TEXT.filesName },
            h('input', {
              style: S.input,
              value: name,
              placeholder: TEXT.filesNamePlaceholder,
              onChange: (event) => setName(asString(event.target.value)),
            }),
          ),
          h(
            Field,
            { label: TEXT.filesDesc },
            h('input', {
              style: S.input,
              value: description,
              placeholder: TEXT.filesDescPlaceholder,
              onChange: (event) => setDescription(asString(event.target.value)),
            }),
          ),
          pickedFiles.length > 0
            ? null
            : h(
                Field,
                { label: TEXT.filesBody },
                h('textarea', {
                  style: { ...S.textarea, ...S.uploadTextarea },
                  value: body,
                  placeholder: TEXT.filesBodyPlaceholder,
                  onChange: (event) => setBody(asString(event.target.value)),
                }),
              ),
        )
      }

      function renderZip() {
        return h(
          React.Fragment,
          null,
          h(
            'div',
            { style: S.fileRow },
            h(
              'label',
              { style: S.buttonSmall },
              TEXT.zipPick,
              h('input', {
                type: 'file',
                accept: '.zip,application/zip',
                style: { display: 'none' },
                onChange: (event) => {
                  const picked = (event.target.files || [])[0]
                  if (!picked) return
                  if (Number(picked.size) > MAX_ZIP_BYTES) {
                    setZipFile(null)
                    setError(TEXT.zipTooLarge)
                    return
                  }
                  setZipFile(picked)
                  setError('')
                  if (zipLabel.trim().length === 0) setZipLabel(asString(picked.name).replace(/\.zip$/i, ''))
                },
              }),
            ),
            zipFile
              ? h('span', { style: S.fieldHint }, `${TEXT.zipChosen}: ${asString(zipFile.name)}`)
              : null,
          ),
          h(
            Field,
            { label: TEXT.zipLabel },
            h('input', {
              style: S.input,
              value: zipLabel,
              onChange: (event) => setZipLabel(asString(event.target.value)),
            }),
          ),
        )
      }

      function renderGit() {
        return h(
          React.Fragment,
          null,
          h(
            Field,
            { label: TEXT.gitUrl },
            h('input', {
              style: S.input,
              value: gitUrl,
              placeholder: TEXT.gitUrlPlaceholder,
              onChange: (event) => {
                const next = asString(event.target.value)
                setGitUrl(next)
                // A pasted browser URL already carries the branch and folder, so
                // prefill them instead of making the user retype. Two shapes exist
                // and both must be recognised here, or the form looks empty while
                // the Host still parses the URL correctly:
                //   GitLab:  <host>/<group>/<repo>/-/tree/<branch>/<subdir>
                //   GitHub:  <host>/<owner>/<repo>/tree/<branch>/<subdir>
                // Keep in sync with `parseRepoUrl` in src/library.js.
                const hint = deepLinkHint(next)
                if (hint !== undefined) {
                  if (hint.branch.length > 0) setGitBranch(hint.branch)
                  if (hint.subdir.length > 0) setGitSubdir(hint.subdir)
                }
              },
            }),
          ),
          h(
            Field,
            { label: TEXT.gitType, hint: TEXT.gitTypeHint },
            h(
              'select',
              {
                style: S.select,
                value: gitProvider,
                onChange: (event) => setGitProvider(asString(event.target.value)),
              },
              h('option', { value: 'auto' }, TEXT.gitTypeAuto),
              h('option', { value: 'gitlab' }, TEXT.gitTypeGitlab),
              h('option', { value: 'github' }, TEXT.gitTypeGithub),
            ),
          ),
          h(
            'div',
            { style: S.row },
            h(
              Field,
              { label: TEXT.gitBranch },
              h('input', {
                style: { ...S.input, minWidth: '140px' },
                value: gitBranch,
                placeholder: 'main',
                onChange: (event) => setGitBranch(asString(event.target.value)),
              }),
            ),
            h(
              Field,
              { label: TEXT.gitSubdir },
              h('input', {
                style: { ...S.input, minWidth: '140px' },
                value: gitSubdir,
                onChange: (event) => setGitSubdir(asString(event.target.value)),
              }),
            ),
          ),
          h(
            Field,
            { label: TEXT.gitLabel },
            h('input', {
              style: S.input,
              value: gitLabel,
              onChange: (event) => setGitLabel(asString(event.target.value)),
            }),
          ),
          h(
            Field,
            { label: TEXT.gitToken, hint: TEXT.gitTokenHint },
            h('input', {
              style: S.input,
              type: 'password',
              autoComplete: 'new-password',
              value: gitToken,
              onChange: (event) => setGitToken(asString(event.target.value)),
            }),
          ),
        )
      }

      function renderMcp() {
        return h(
          Field,
          { label: TEXT.mcpJson, hint: TEXT.mcpJsonHint },
          h('textarea', {
            style: { ...S.textarea, ...S.uploadTextarea, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
            value: json,
            spellCheck: false,
            onChange: (event) => setJson(asString(event.target.value)),
          }),
        )
      }

      function renderResult() {
        if (!result) return null
        const failed = asArray(result.failures)
        return h(
          'div',
          { style: SX.resultBox },
          result.installed.length > 0
            ? h(
                'div',
                { style: SX.resultLine },
                `${seg === 'mcp' ? TEXT.mcpNotice : TEXT.importInstalled}: ${result.installed.join(', ')}`,
              )
            : null,
          mountRows && !mountSettled
            ? h('div', { style: S.fieldHint }, TEXT.mcpMountBackground)
            : null,
          mountRows
            ? h(
                'div',
                { style: SX.resultLine },
                ...Object.entries(mountRows).map(([serverName, value]) =>
                  h(
                    'div',
                    { key: serverName, style: SX.mountLine },
                    h('span', { style: { ...S.dot, ...mountDotStyle(value.state) } }),
                    h('span', { style: S.mono }, serverName),
                    h('span', { style: S.fieldHint }, mountLabel(value.state)),
                    value.state === 'failed' && value.error
                      ? h('span', { style: SX.inlineError }, value.error)
                      : null,
                  ),
                ),
              )
            : null,
          failed.length > 0
            ? h(
                'div',
                { style: SX.resultLine },
                `${TEXT.importFailures}: ${failed.map((row) => `${row.name}: ${row.error}`).join('; ')}`,
                h('div', { style: S.fieldHint }, TEXT.importRetryHint),
              )
            : null,
        )
      }

      const segments = [
        ['files', TEXT.segFiles],
        ['zip', TEXT.segZip],
        ['git', TEXT.segGit],
        ['mcp', TEXT.segMcp],
      ]
      const showDone = Boolean(result) && asArray(result.failures).length === 0

      return h(
        Modal,
        {
          title: TEXT.importTitle,
          subtitle: TEXT.importSubtitle,
          wide: true,
          error,
          busy,
          onClose: props.onClose,
          footer: [
            h(
              'button',
              { key: 'cancel', type: 'button', style: S.buttonSmall, onClick: props.onClose, disabled: busy },
              TEXT.cancel,
            ),
            showDone
              ? h(
                  'button',
                  { key: 'done', type: 'button', style: S.buttonPrimary, onClick: () => props.onDone(doneMessage()) },
                  TEXT.done,
                )
              : h(
                  'button',
                  { key: 'submit', type: 'button', style: S.buttonPrimary, onClick: () => void submit(), disabled: busy },
                  busy ? TEXT.importing : TEXT.importSubmit,
                ),
          ],
        },
        h(
          'div',
          { style: SX.seg, role: 'tablist' },
          ...segments.map(([key, label]) =>
            h(
              'button',
              {
                key,
                type: 'button',
                role: 'tab',
                'aria-selected': seg === key ? 'true' : 'false',
                style: { ...SX.segBtn, ...(seg === key ? SX.segActive : null) },
                disabled: busy,
                onClick: (event) => {
                  // Blur explicitly: a focused button keeps whatever ring the
                  // environment draws, and the user reads it as a stuck border.
                  event.currentTarget.blur()
                  setSeg(key)
                },
              },
              label,
            ),
          ),
        ),
        seg === 'files' ? renderFiles() : seg === 'zip' ? renderZip() : seg === 'git' ? renderGit() : renderMcp(),
        seg === 'mcp' ? null : h(
          'div',
          { style: S.row },
          h(Toggle, { checked: overwrite, label: TEXT.overwrite, onChange: (value) => setOverwrite(value === true) }),
          h('span', { style: S.fieldHint }, TEXT.overwrite),
        ),
        renderResult(),
      )
    }

    return {
      inject: ['slots'],
      // Pure reconciliation used by `loadBoard`; exposed so the Node test can
      // exercise the production function without a browser renderer.
      boardState: {
        applyLoadedBoard,
        applyItemSave,
        draftLossMessage,
        orphanedDrafts,
        buildItemSaveBody,
        normalizeEntry,
        normalizeMcpTools,
        buildToolSaveBody,
        rowDraftOf,
        configDraftAfterSave,
        failureTextOf,
        activationWarningOf,
        mergeActivationWarning,
        dismissActivationWarning,
      },
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'skill-pool',
              order: 26,
              label: () => t('navTitle'),
            },
            Panel,
          ),
        )
      },
    }
  },
})
