# MCP Disclosure Feasibility Results (Task 3)

Date: 2026-11-18 (Asia/Shanghai)
Status: experiments complete — **Tasks 4/5 are not implemented; the tested
alternatives are not yet sufficient to enable them**

This document records only what the installed DSH runtime actually did. It does
not describe a proposed design as if it existed. The automated evidence is
`test/mcp-feasibility.probe.mjs` (21 host-bound checks, all passing here,
including checks that pin observed failures and gaps).

The probe file is deliberately **not** named `*.test.mjs` and is **not** part of
the default `npm test` suite: a green default suite must never imply that host
capability was verified. See “Host-bound probe and release gate” below.

## Host-bound probe and release gate

| Command | Purpose | Installed runtime present | Runtime absent or wrong version |
| --- | --- | --- | --- |
| `npm test` | ordinary portable suite; excludes the probe | 145/145 pass | 145/145 pass (no capability claim) |
| `npm run test:feasibility` | optional focused probe; reports skips | 21/21 pass | 21 skipped; prints `[unverified] ...`; exit 0 |
| `npm run verify:feasibility` | **strict capability gate** | 21/21 pass | fails nonzero |

`npm run verify:feasibility` is **mandatory for any feature release or capability
claim**. The ordinary suite passing without it proves only the portable code, not
MCP feasibility. The skip path is explicit (`unverified — ...` per test), never a
hidden pass.

The strict command is a dependency-free Node wrapper (`test/verify-feasibility.mjs`)
that sets `DSH_FEASIBILITY_REQUIRED=1`, spawns `node --test` on the probe and
forwards its exit code, so it works on POSIX shells and Windows `cmd` alike. A
runtime at a different DSH version counts as unavailable: the optional command
skips with `unverified`, the strict command fails nonzero.

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
* host Event `tools/change`: unfiltered `emit` with no payload; host Event
  contracts also define `tools/pre-execute`, `tools/execute`, `tools/post-execute`
  and `tools/result`.
* source read: `dsh-tools/src/pipeline.ts`, `dsh-mcp-client/src/tools.ts`,
  `connection.ts`, `dsh-mcp-resources/src/index.ts`,
  `dsh-system-prompt/src/index.ts`.

## Verdict table

| # | Requirement | Result | Test |
| --- | --- | --- | --- |
| 1 | Current-generation `(server, raw)` → public name is deterministic for normal, delimiter, normalized and long names | **PROVEN (forward only)** | `identity: live registration yields deterministic public names...` |
| 2 | Public name → `(server, raw)` origin is uniquely recoverable from the tested public current-generation surfaces | **OBSERVED FAIL** | same test + `identity: delimiter-bearing server names...` |
| 3 | Normalization preserves distinct identities via the 12-hex hash; 64-char truncation keeps them distinct | **PROVEN** | identity test |
| 4 | Rejected registration collision is all-or-none; an invalid duplicate list preserves the previous generation | **PROVEN after rejection** | `collision: a foreign registration rolls back...` |
| 5 | Restrictions intersect across two scope layers; one agent’s restrictions do not affect another | **PROVEN** | `scoping: agent restrictions intersect...` |
| 6 | Per-agent disclosure can expand one original MCP service without affecting B, a second service, an independent ancestor deny, or an independent global switch | **PROVEN for the static restrict-dispose layer; not for dynamic additions** | `scoping: per-agent restrict disclosure layer...`; `scoping: deny-list disclosure layer...` |
| 7 | A scoped shadow is a safe way to bypass a restriction | **OBSERVED FAIL (unsafe)** | `scoping: a same-name agent shadow...` |
| 8 | A post-prepare switch closes prepared calls at the dispatch stage | **PROVEN in the native pipeline via `tools/execute` denial; guard-only still fails** | `shutdown: tools/execute denial...`; `shutdown: guard runs before dispatch...` |
| 9 | Post-prepare agent restriction is re-checked with and without a step set | **PROVEN in the tested pipeline (both deny)** | `shutdown: post-prepare agent restriction...` |
| 10 | Approval and cancellation continue to work with a dispatch-stage wrapper | **PROVEN with a stub answerer and pipeline-level cancellation; real approval service/UI unverified** | `shutdown: dispatch-stage path preserves approval...` |
| 11 | Synchronous `tools/change` re-entry, addition and replacement | **PROVEN with a caller guard; naive re-entry is hazardous** | `dynamic registration: a synchronous tools/change listener...` |
| 12 | Tools added after a step starts appear only in the next step | **PROVEN, with a full-generation caveat** | `dynamic sync: a tool added between steps...` |
| 13 | A generation swap is atomic to every observer | **OBSERVED FAIL for synchronous `tools/change` observers** | `dynamic sync: tools/change observers see a partial generation...` |
| 14 | Old step snapshots and removed registrations cannot execute | **PROVEN** | `shutdown: old step snapshots...` |
| 15 | Already-dispatched work is not forcibly interrupted; it drains and reports abort | **PROVEN** | `shutdown: old step snapshots...` |
| 16 | Hiding business tools hides the same server’s resources and server instructions | **OBSERVED FAIL** | `resources/instructions: hiding business tools...` |
| 17 | Offline status and registered schema stay consistent | **OBSERVED FAIL** | `offline: failed connection leaves stale schemas...` |
| 18 | `mcpManager.probe` can establish live-generation identity | **OBSERVED FAIL / not evidence** | `manager/probe: status and probe...` |

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
* two 71-character raw names sharing a long prefix → two distinct 64-character
  names, each ending in its own hash

Calling each observed public name reached the controlled server with the correct
raw name, so dispatch never re-parses the public name. This part is proven.

**No supported reverse mapping was found in the tested surfaces.** The live
registry exposes only `name`, `description`, `parameters`, `output`, `execute`
and `projectContent`; it exposes no server, raw-name or source metadata. The
client package **root** does not export its `publicToolName` helper; the helper
is internal in the compiled module, while the package’s `./src/*` export points
at TypeScript source. This probe did not import that subpath and does not treat
it as a supported runtime identity API. `connectionStatusOf()`
status has only `state`, `toolCount`, `connectedAt` (or failure fields). The
manager status type from live Inspect is the same shape.

Server names may themselves contain `__`, so the public name is not even
parseable into a prefix:

* `(alpha, a__x)` and `(alpha__a, x)` both produce `mcp__alpha__a__x`.
* Only one can occupy a scope at a time, but the historical/permission identity
  is ambiguous.

**Conclusion:** the live generation supports a one-way, deterministic
`(server, raw) → public` mapping when the caller already knows both values. The
tested public surfaces do not provide a `public → (server, raw)` identity, and
public names alone cannot recover origin. This is an observed absence in the
tested surfaces, not a proof that no unsupported/private mapping could be
constructed. A manager `probe` returns raw names, but it opens an independent
connection; the test proves it does not touch the live registry or the live
`connectedAt`, so it cannot prove what the live generation is running.

### 2. Collisions and generation swaps

* A foreign global tool occupying `mcp__alpha__search` made the initial
  `mcp-client` activation reject; no partial alpha generation was observed after
  the rejection.
* A server that listed `dup.raw` twice caused the client to reject the fetched
  list; the previous generation stayed registered and executable after the
  notification plus a 300 ms observation window. No timing guarantee is claimed.
* A **successful** swap is not atomic to synchronous `tools/change` observers:
  a listener recorded a fully disposed count (`0`) and partial counts between
  `0` and the final count while the new generation was being registered. This
  does not prove an async model request can interleave on one thread, but
  reentrant listeners and other synchronous observers can see a partial set.
  Rejected syncs left no partial set in the tests.

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

**Restrict-dispose disclosure layer (no scoped shadow).** A separate
agent-scoped `tools.restrict({ deny })` layer for one service can be disposed to
reveal the **original global MCP tool**, with no local re-registration:

* disposing A’s alpha deny layer revealed alpha’s original MCP names in A;
  calling the revealed name executed the real MCP body and reached the controlled
  server with `raw=search`;
* an independent ancestor deny specifically for beta search remained in force
  for A and B; it did not hide beta echo;
* a second A-only deny layer hid beta echo in A;
* an independent global guard (a “switch” on beta echo) still denied B’s visible
  beta-echo call before its body after A’s alpha layer was disposed; opening the
  guard let it execute;
* B’s alpha and beta-echo visibility was unaffected (the ancestor beta-search deny applied to B as well);
* a step set resolved before the disposal stayed closed; the next step admitted
  the revealed tool;
* two concurrent `resolve()` calls (A and B) after disposal observed their own
  agent-specific sets.

**Dynamic gap in the deny-list layer:** a tool registered by a later
`tools/change`/re-sync was visible to A **before** any disclosure expansion,
because the existing deny list did not contain the new name. The new tool was
also callable before expansion. After unmount/remount with the layer active, the
same names were hidden again for A and visible for B. An allow-list design might
avoid the new-name window but was not tested. The plugin's state-fail-closed
mitigation does not close this gap: it denies ambiguous `mcp__*` names and, while
the state is unreadable, refreshes a deny-all-visible-MCP fallback only on each
explicit re-apply. A tool registered between re-applies can still be visible, and
the static deny cannot prove a complete loader/service list.

**Scoped shadow (unsafe alternative).** A same-name registration in the agent
scope whose body delegates to the captured global definition executed a tool
that A’s own restriction denied. It is exempt from `tools.restrict` (“scoped
registrations remain visible”), and it is visible to `definitions()`/`schemas()`
even when its `when` is false. The plan explicitly forbids using scoped shadow to
bypass restrictions; this path is not acceptable.

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

### 5. Guard / close timing and dispatch-stage policy

* With a global guard active, agent-less calls and calls from agents A and B were
  all denied before the body ran.
* A guard registered through A’s scope denied A only; B and agent-less calls
  were allowed.
* Guard-only close **fails the race**: after `prepare()` returned a dispatch
  while allowed, flipping the guard state and calling `dispatch()` still ran the
  body successfully. The guard is checked in `prepare()`, not between prepare
  and body dispatch.
* A global `tools/execute` waterfall denial **does close the tested window**:
  after prepare, a global listener returned a denial without calling `next()` for
  A, B and agent-less prepared calls; none reached the MCP body (server call log
  unchanged). An allowed call through `next()` executed normally.
* Approval and cancellation remained intact with the dispatch-stage wrapper:
  a real `tools/pre-execute` ask against a provided approval seam allowed the
  body on `allowed-once`, denied it on `rejected` and `cancelled` before
  dispatch, and an abort after prepare produced “aborted before dispatch”
  without reaching the body. The approval *answerer* was a test stub; the real
  approval service, session audit and UI were not exercised.
* Adding an agent-scoped `tools.restrict({deny})` after prepare caused dispatch
  to fail as unknown tool **both** with and without a step set: the no-set path
  re-resolves current visibility; the step-set path also re-checks its admitted
  definitions against current visibility. The changed restriction was visible in
  `schemas()` immediately, and the MCP body was not called.
* A removed registration cannot execute from an old step snapshot.
* A body that had already started finished after `AbortController.abort()`; the
  result was an error containing “aborted”. Already-dispatched work is not
  forcibly stopped.

**Consequence:** a close implemented only as a guard is insufficient. A
dispatch-stage `tools/execute` denial and restriction re-check both close the
tested native-pipeline window. They are promising components, not a complete
Task 4 proof: executors other than native, PTC/subcall paths, listener ordering
(`prepend`/other plugins), schema hiding, identity and real model-step
integration were not tested. The plan’s “prepared but not dispatched must be
rejected” property was tested here, but Task 4 remains unimplemented.

### 6. MCP resources and server instructions (independent channels)

With server `alpha` business tools denied for agent A:

* A’s schemas still contained `list_mcp_resources`,
  `list_mcp_resource_templates`, `read_mcp_resource`.
* `list_mcp_resources` was called separately for alpha and beta; each returned
  its own server-scoped resource (`alpha://secret` / `beta://secret`), not an
  aggregate list. `list_mcp_resource_templates` and
  `read_mcp_resource({server: "alpha", uri: "alpha://secret"})` were called for
  alpha; read returned `ALPHA_RESOURCE_PAYLOAD`.
* the assembled system prompt listed both `alpha` and `beta`;
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
* `list_mcp_resources`, `list_mcp_resource_templates` and `read_mcp_resource`
  each failed with “server is disconnected”;
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

## Task 4/5 status (not implemented)

* **Task 4 (global per-tool switch): not implemented.** Guard-only close fails
  the prepared-call race. A dispatch-stage `tools/execute` denial and a
  post-prepare restriction re-check both prevented the body in the tested native
  pipeline, and approval/cancellation remained intact with a stub answerer. They
  are candidate mechanisms, not a complete proof: real agent/model-step flow,
  PTC and custom executors, `tools/execute` listener ordering, schema hiding,
  and live identity are untested.
* **Task 5 (service-level progressive disclosure): not implemented.** A
  per-agent `tools.restrict` layer can be disposed to reveal the original MCP
  tool without shadowing and without releasing an independent ancestor deny for
  a static name set. Dynamic additions are visible before expansion (observed
  gap), the shadow path is unsafe, no trusted live identity was proven, and
  resources/server instructions remain independent; offline schema/instruction
  staleness is unchanged. An allow-list design or other registration strategy
  may avoid the dynamic gap but was not tested.
* Do not claim that no implementation is possible; the tested alternatives are
  insufficient. Preserve full injection. Tasks 1/2 (description/metadata)
  remain independent.

## Corrections to earlier overstatements

This revision corrects the prior report:

* “Each resource tool was called” is now true: all three shared resource tools
  are called online, and list/list-templates/read are called offline.
* Generation-swap atomicity is qualified: rejected syncs left no partial set,
  but successful swaps expose partial sets to synchronous `tools/change`
  observers.
* Duplicate-list stability is an observation after a 300 ms window, not a timing
  guarantee.
* Reverse identity is an observed absence in the tested public surfaces, not a
  proof that no mapping could exist.
* The guard race is an observed failure; a dispatch-stage denial is an observed
  working alternative in the native pipeline, not proof that Task 4 is safe.
* The scoped shadow is unsafe; the restrict-dispose layer is a tested static
  alternative with a dynamic gap, not a blanket impossibility claim.

## Untested / limitations

* Real AgentRegistry / agent-loop step preparation, model request assembly,
  system-prompt `toolSet` handoff, KV cache and token cost: not exercised.
  Scope keys stand in for live agents.
* Real `dsh-user-approval` service, session audit, approval UI and policy
  switching: the tools-side ask → `ctx.get('approval').request` path was tested
  with a stub answerer; audit/UI behaviour is unverified.
* PTC executor (`run_code`) and program subcalls: not exercised. A custom
  executor that does not use the shared pipeline could bypass the tested
  `tools/execute` policy.
* `tools/execute` listener ordering with other plugins, `prepend` listeners, and
  event-order races beyond the tested single listener: not proven.
* Disposal of a `tools.restrict` layer racing an already-running `resolve()` was
  not tested; the concurrency check covers two resolves after disposal.
* Streamable HTTP transport, OAuth, credential templates/rotation, startup
  failure and cleanup-timeout paths: not exercised.
* Modern 2026-07-28 MCP wire revision and task-based execution: not exercised;
  fixtures negotiated legacy.
* MCP prompt templates: documented unsupported by DSH, not exercised.
* Live manager `watch`/`restart`, Settings API and Web GUI: not exercised; the
  manager was used through `list()` and `probe()` only.
* The approval tests use a stub `approval` value; no real approval service was
  mounted.
* The live user profile, OpenViking and real MCP services were deliberately not
  touched. No credentials or user state appear in this document or the test.

## Reproduction and skip policy

From the repository root (`pkg/dsh-skill-pool` in the plan; this worktree root):

```sh
node --test test/mcp-feasibility.probe.mjs   # real root: 21/21 pass
npm run test:feasibility                     # real root: 21/21; absent: 21 skipped + [unverified], exit 0
npm run verify:feasibility                   # real root: 21/21; absent/wrong version: nonzero
DSH_FEASIBILITY_ROOT=/nonexistent node --test test/mcp-feasibility.probe.mjs
# 21 skipped, exit 0 (optional probe, clearly unverified)
DSH_FEASIBILITY_ROOT=/nonexistent npm run verify:feasibility
# exit nonzero (strict gate; the wrapper sets DSH_FEASIBILITY_REQUIRED=1)
npm test                                     # 145/145 pass; probe is excluded
npm run test:lifecycle                       # index.js lifecycle/recovery/fallback probe (needs DSH)
npm run test:naming                          # real publicToolName ambiguity probe (needs DSH)
npm run test:restrict                        # real tools.restrict lifecycle probe (needs DSH)
npm run test:activation                      # real ToolsService+activation probe (needs DSH)
npm run lint                                 # exit 0
node test-persisted-mcp.mjs                  # all persisted-MCP checks passed
```

The probe locates the installed runtime at
`/opt/dsh/lib/node_modules/@deepseek-ai/dsh` by default and accepts
`DSH_FEASIBILITY_ROOT` to point at another installed DSH tree. It requires the
expected host version (`0.2.2-rc.3`) exactly; another installed version is
reported as an unverified/failed runtime, never silently accepted. The default
`npm test` script’s `test/*.test.mjs` glob does not match
`mcp-feasibility.probe.mjs`, so the ordinary suite can pass without the host and
makes no capability claim. The optional focused command prints the skip reason;
the strict command (`DSH_FEASIBILITY_REQUIRED=1`, set by the cross-platform Node
wrapper) fails nonzero instead of skipping.
