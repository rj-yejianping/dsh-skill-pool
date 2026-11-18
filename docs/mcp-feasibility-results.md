# MCP Disclosure Feasibility Results (Task 3)

Date: 2026-11-18 (Asia/Shanghai)
Status: experiments complete — **do not implement Tasks 4/5 as described**

This document records only what the installed DSH runtime actually did. It does
not describe a proposed design as if it existed. The automated evidence is
`test/mcp-feasibility.test.mjs` (15 tests, all passing, including tests that
pin observed failures).

## Environment and isolation

| Item | Value |
| --- | --- |
| Node | `v24.22.3` |
| Installed DSH | `/opt/dsh/lib/node_modules/@deepseek-ai/dsh` (`0.2.2-rc.3`) |
| Test MCP services | two stdio child processes, each spawned from a temp-dir fixture; no listening ports |
| State | one fresh `mkdtemp()` directory per harness, deleted on teardown |
| Profile / credentials / knowledge base | none loaded or modified |
| OpenViking | not contacted |
| Executor | real `dsh-tool-executor-native` (PTC not exercised) |
| Agent identity | real `dsh-scope` scope keys, the same object identity `agent.ctx` tags |

The agent-loop, session store and real AgentRegistry were **not** mounted. The
tests therefore prove the scoping and execution-pipeline behaviour, not real
model-step assembly, token cost, or a live user session. That limitation is
listed again below.

The two MCP fixtures implement the legacy MCP handshake. The installed client
first probes `server/discover`; the fixture answers with a JSON-RPC error and the
SDK falls back to legacy `initialize`. The 2026-07-28 wire revision itself is
unverified, but naming, registry, execution and resource behaviour all use the
same installed client code.

Interfaces were confirmed from the live Inspect providers before testing:

* host Service `tools`: `restrict`, `guard`, `resolve`, `get`, `definitions`,
  `schemas`, `execute` signatures; “Restrictions intersect; scoped
  registrations remain visible.”
* host Service `mcpManager`: `list`, `restart`, `probe`; status types expose
  only `toolCount`/`connectedAt`, never tool names.
* host Event `tools/change`: unfiltered `emit` with no payload.
* source read: `dsh-tools/src/pipeline.ts`, `dsh-mcp-client/src/tools.ts`,
  `connection.ts`, `dsh-mcp-resources/src/index.ts`,
  `dsh-system-prompt/src/index.ts`.

## Verdict table

| # | Requirement | Result | Test |
| --- | --- | --- | --- |
| 1 | Current-generation `(server, raw)` → public name is deterministic for normal, delimiter, normalized and long names | **PROVEN (forward only)** | `identity: live registration yields deterministic public names...` |
| 2 | Public name → `(server, raw)` origin is uniquely recoverable from a supported current-generation API | **OBSERVED FAIL** | same test + `identity: delimiter-bearing server names...` |
| 3 | Normalization preserves distinct identities via the 12-hex hash; 64-char truncation keeps them distinct | **PROVEN** | identity test |
| 4 | Registration collision is all-or-none; an invalid duplicate list preserves the previous generation | **PROVEN** | `collision: a foreign registration rolls back...` |
| 5 | Restrictions intersect across two scope layers; one agent’s restrictions do not affect another | **PROVEN** | `scoping: agent restrictions intersect...` |
| 6 | Per-agent expansion cannot expand another agent or a second service, and cannot release other restrictions | **PARTIAL / OBSERVED FAIL** | `scoping: per-agent expansion canaries...` (passes for restrictions/canaries), `scoping: a same-name agent shadow...` (fails for shadow bypass) |
| 7 | MCP business tools can be progressively disclosed through confirmed interfaces | **UNTESTED / NOT SAFELY FEASIBLE** | no official API; shadow workaround is unsafe (see #6) |
| 8 | Synchronous `tools/change` re-entry, addition and replacement | **PROVEN with a caller guard; naive re-entry is hazardous** | `dynamic registration: a synchronous tools/change listener...` |
| 9 | Tools added after a step starts appear only in the next step | **PROVEN, with a full-generation caveat** | `dynamic sync: a tool added between steps...` |
| 10 | Guard denies before dispatch for all agents and for agent-less calls; a scoped guard only covers its scope | **PROVEN (pre-dispatch only)** | `shutdown: guard runs before dispatch...` |
| 11 | A close committed after the guard but before body dispatch prevents the body | **OBSERVED FAIL** | `shutdown: guard runs before dispatch...` |
| 12 | Old step snapshots and removed registrations cannot execute | **PROVEN** | `shutdown: old step snapshots...` |
| 13 | Already-dispatched work is not forcibly interrupted; it drains and reports abort | **PROVEN** | `shutdown: old step snapshots...` |
| 14 | Hiding business tools hides the same server’s resources and server instructions | **OBSERVED FAIL** | `resources/instructions: hiding business tools...` |
| 15 | Offline status and registered schema stay consistent | **OBSERVED FAIL** | `offline: failed connection leaves stale schemas...` |
| 16 | `mcpManager.probe` can establish live-generation identity | **OBSERVED FAIL / not evidence** | `manager/probe: status and probe...` |

## Evidence by area

### 1. Identity and naming

**Forward mapping is reproducible.** For two live servers the registry contained
exactly the names predicted by the published formula
`mcp__<serverName>__<rawName>` with lossy normalization and a 12-hex SHA-256
suffix:

* `search` → `mcp__alpha__search`, `mcp__beta__search`
* `a__x` → `mcp__alpha__a__x`
* `a.b` and `a/b` → distinct `mcp__alpha__a_b_<hash>` names (different hashes)
* `工具 名` → underscores plus hash
* two 71-character raw names sharing a long prefix → two distinct 64-character names,
  each ending in its own hash

Calling each observed public name reached the controlled server with the correct
raw name, so dispatch never re-parses the public name. This part is proven.

**Reverse mapping is absent and ambiguous.** The live registry exposes only
`name`, `description`, `parameters`, `output`, `execute` and `projectContent`;
it exposes no server, raw-name or source metadata. The client package does not
export its `publicToolName` helper. `connectionStatusOf()` status has only
`state`, `toolCount`, `connectedAt` (or failure fields). The manager status type
from live Inspect is the same shape.

Server names may themselves contain `__`, so the public name is not even
parseable into a prefix:

* `(alpha, a__x)` and `(alpha__a, x)` both produce `mcp__alpha__a__x`.
* Only one can occupy a scope at a time, but the historical/permission identity
  is ambiguous.

**Conclusion:** the live generation supports a one-way, deterministic
`(server, raw) → public` mapping when the caller already knows both values. It
does **not** provide a supported `public → (server, raw)` identity, and public
names alone cannot recover origin. A manager `probe` does return raw names, but
it opens an independent connection; the test proves it does not touch the live
registry or the live `connectedAt`, so it cannot prove what the live generation
is running.

### 2. Collisions and generation swaps

* A foreign global tool occupying `mcp__alpha__search` made the initial
  `mcp-client` activation reject; no partial alpha generation was published.
* A server that listed `dup.raw` twice caused the client to reject the entire
  fetched list; the previous generation stayed registered and executable.
* Generation swaps are atomic at the API boundary: there is no observed
  half-registered generation after a rejected sync.

### 3. Scoping and per-agent disclosure

**Proven primitives** (real `tools.restrict`, `tools.resolve`, real
`dsh-scope` keys):

* An ancestor deny and a child allow intersect; the child allow cannot release
  the ancestor deny.
* Disposing the child mask leaves the ancestor deny.
* A restriction on agent A does not affect agent B.
* Agent-scoped conditional registrations evaluated by `resolve()` are isolated:
  expanding canary service 1 in A does not admit canary service 2, does not
  affect B, and does not make a separately denied MCP tool visible.
* `ResolvedToolSet.view(scope)` only admits its exact requesting agent; an A set
  never returns B’s tools.

**Observed failure for the actual disclosure goal:** the only path found that
can expose a real MCP business tool per agent is a same-name registration in the
agent scope whose body delegates to the captured global definition. That shadow:

* is exempt from `tools.restrict` (“scoped registrations remain visible”), so
  it executed a tool that A’s own restriction denied;
* is visible to `definitions()`/`schemas()` even when its `when` is false
  (only `resolve()` is condition-aware), so non-step inspection surfaces can
  disclose a not-yet-expanded tool;
* relies on capturing the global definition by public name before the step, not
  on any server/raw identity API;
* would need refresh handling when the MCP generation replaces the definition.

The plan explicitly forbids using scoped shadow to bypass restrictions. This test
pins that the bypass works and is therefore **not a safe implementation path**.

### 4. Dynamic registration, steps and `tools/change`

* A server `notifications/tools/list_changed` triggered a real re-sync: a removed
  tool and a newly added tool were visible in the registry after the sync.
* The step that triggered the change keeps its snapshot: the removed tool is
  unreachable and the new tool was not admitted to the running step. The next
  `resolve()` admits the new tool; another agent’s next `resolve()` also sees it.
* **Caveat:** the re-sync replaces the whole generation. The old step snapshot
  lost *every* previous MCP definition, including an unchanged tool. An unstarted
  call to that unchanged tool with the old `toolSet` failed as unknown. This is
  conservative but means a list change invalidates sibling calls already
  prepared for that step.
* A synchronous `tools/change` listener can register a tool, but `register()`
  emits the change from inside the insertion before returning the disposer.
  A naive unconditional listener therefore sees a nested change and a duplicate
  registration error. A caller must set a re-entry guard before registering.
  Replacement of a same-name tool after disposal works as one definition.

### 5. Guard / close timing

* With a global guard active, agent-less calls and calls from agents A and B were
  all denied before the body ran.
* A guard registered through A’s scope denied A only; B and agent-less calls
  were allowed.
* The guard is evaluated in the pipeline’s `prepare()` stage. When it was
  allowed, the pipeline `prepare()` returned a dispatch, the guard state was
  then flipped to “closed”, and `dispatch()` ran the body successfully. The
  guard is not checked again between prepare and body dispatch.
* If prepare happened after the close, it returned a denial and the body did not
  run.
* A removed registration cannot execute from an old step snapshot.
* A body that had already started finished after `AbortController.abort()`; the
  result was an error containing “aborted”. Already-dispatched work is not
  forcibly stopped.

**Consequence:** a close that is only implemented as a guard cannot satisfy
“a prepared but not yet dispatched request must be rejected”. Any Task 4 switch
policy would need a dispatch-stage re-check that was not proven here.

### 6. MCP resources and server instructions (independent channels)

With server `alpha` business tools denied for agent A:

* A’s schemas still contained `list_mcp_resources`,
  `list_mcp_resource_templates`, `read_mcp_resource`.
* `read_mcp_resource({server: "alpha", uri: "alpha://secret"})` succeeded and
  returned `ALPHA_RESOURCE_PAYLOAD`.
* `list_mcp_resources` and the assembled system prompt still listed `alpha` and
  `beta`.
* A’s system prompt still contained `ALPHA_INSTRUCTIONS_MARKER`.

Hiding the three shared resource tools for A hid all servers’ resource tools
from A (all-or-nothing), but **the server instruction section remained**; B
still had resource access. Hiding business tools is therefore not resource
isolation, and tool restrictions do not touch the prompt channel.

DSH documentation says MCP prompt templates are unsupported; no prompt surface
was observed. The server-instructions prompt path was exercised directly.

### 7. Offline state versus registered schema

After the server process exited with reconnect disabled:

* status became `failed` / `reconnect-disabled`;
* all last-known MCP schemas remained in `tools.definitions()`/`schemas()`;
* the assembled prompt still contained the stale server instructions;
* business calls failed with a connection error;
* resource list/read failed with “server is disconnected”;
* status had no `toolCount`, while the registry still had the tool names.

So “registered schema” is not a reliable proxy for “service online”. A
disclosure surface must read connection status, and cannot claim that absent
schemas mean an unavailable server.

### 8. Reconnect and remount

With reconnect enabled (50–100 ms backoff), a crash produced a visible
`reconnecting` state, then a new `connected` generation with a different
`connectedAt`. Public names were identical across generations and calls worked.
Unmount removed the tools; remount with the same raw list reproduced the same
public names. Stable names are proven; stable *identity disclosure* is not,
because no generation identity or raw mapping is exposed.

## Why Tasks 4/5 are blocked

* **Task 4 (global per-tool switch):** the guard path covers all agents and
  agent-less calls before dispatch, but the guard-to-body race means a request
  prepared before the commit can still execute after it. The plan requires such
  a request to be rejected. No confirmed dispatch-stage re-check exists in the
  tested interfaces. The switch must not be advertised as reliable.
* **Task 5 (service-level progressive disclosure):** there is no supported
  current-generation `public → server/raw` mapping; the shadow workaround
  bypasses restrictions and leaks through inspection surfaces; resources and
  server instructions are independent channels that remain visible; offline
  schemas and instructions are stale. Initial hiding, next-step original-name
  calls, dynamic updates and per-agent isolation cannot all be proven together,
  so the progressive mode must not be enabled.

Per the plan, preserve full injection and implement no misleading switch or
progressive mode. Tasks 1/2 (description/metadata) remain independent.

## Untested / limitations

* Real AgentRegistry / agent-loop step preparation, model request assembly,
  system-prompt `toolSet` handoff, KV cache and token cost: not exercised.
  Scope keys stand in for live agents.
* PTC executor (`run_code`) and program subcalls: not exercised.
* Streamable HTTP transport, OAuth, credential templates/rotation, startup
  failure and cleanup-timeout paths: not exercised.
* Modern 2026-07-28 MCP wire revision and task-based execution: not exercised;
  fixtures negotiated legacy.
* MCP prompt templates: documented unsupported by DSH, not exercised.
* Live manager `watch`/`restart`, Settings API and Web GUI: not exercised; the
  manager was used through `list()` and `probe()` only.
* The live user profile, OpenViking and real MCP services were deliberately not
  touched. No credentials or user state appear in this document or the test.

## Reproduction

From the repository root (`pkg/dsh-skill-pool` in the plan; this worktree root):

```sh
node --test test/mcp-feasibility.test.mjs   # 15/15 pass
npm test                                    # 79/79 pass
npm run lint                                # exit 0
node test-persisted-mcp.mjs                 # all persisted-MCP checks passed
```

The feasibility file locates the installed runtime at
`/opt/dsh/lib/node_modules/@deepseek-ai/dsh` by default and accepts
`DSH_FEASIBILITY_ROOT` to point at another installed DSH tree. If the runtime or
the expected `0.2.2-rc.3` version is absent, every check is reported as skipped
with the reason “unverified”, never as a passing capability claim.
