# Rebuild contract — 2026-10-21

The user's `需求定版-2026-10-20.md` supersedes the old local-only phase gates and fixed six-page layout. Paperclip owns business tasks. The Hub service adapts it; LangGraph stores decision checkpoints. All three run on Mac. On 2026-10-27 the user replaced the VPS New API/CPA and client-wide CC Switch duties with local Magpie at `http://127.0.0.1:3425/v1`; VPS gateway services and units are retired while historical data remains archived. Native tools/PWAs and their credentials remain independent. Subscription-native clients keep their own login route unless separately configured. No demo tasks, balances or model replies ship in production.

## Wire API

`GET /api/state` returns `{ revision, projects, tasks, inbox, approvals, memories, resources, pool, events, settings, global }`. `GET /api/events` is an authenticated SSE invalidation stream; clients fetch the current snapshot on change. `GET /api/tasks/:id` returns the task plus scoped events and artifacts. Task IDs and timestamps are strings. All model/harness choices refer to the pool by ID.

`POST /api/commands` body `{ command, expectedRevision?, idempotencyKey }` returns the new snapshot. Command fields live directly on `command`, e.g. `{ type: 'project.create', name }`. Conflicts return HTTP 409 and the latest revision. User HTTP requests cannot impersonate internal orchestrator commands.

User commands: `project.create` (name), `goal.create` (projectId, goal, mode), `inbox.add` (text), `inbox.convert` (id, projectId), `task.move` (id, status), `task.assign` (id, modelId, harnessId), `task.cancel` (id), `task.resume` (id), `task.accept` (id, note), `task.reject` (id, note), `approval.decide` (id, allow, note), `memory.create` (text, projectId?, important?), `memory.update` (id, text), `memory.delete` (id), `resource.add` (title, location, projectId?, source?), `resource.remove` (id), `pool.model.upsert` (model), `pool.harness.upsert` (harness).

`memory.create` is now a retired compatibility name returning 409: new memory must use the scoped shared-memory endpoint. `memory.update/delete` act only on explicitly identified legacy local rows; they do not update Claude-Mem. The client defaults to the same shared-memory manager in both board and conversation views, with a separate clearly labelled legacy tab.

Tasks: `{ id, projectId, title, goal, mode, kind, status, assignment: { modelId, harnessId }, steps, artifacts, briefing, progress: { completed, total }, spent: number|null, currency: 'USD', manualOverrides, recoveryUsed, revision, createdAt, updatedAt }`. Board statuses are `queued`, `running`, `blocked`, `review`, `done`, `cancelled`, `archived`; the five visible columns are queued/running/blocked/review/done. Cancelled and archived remain available via filters. Modes: `managed`, `delegate`. Step statuses: queued/running/blocked/done/failed/cancelled. A missing connection blocks honestly; it never creates a simulated reply.

Approvals: `{ id, taskId, stepId?, kind, title, detail, digest, taskRevision, expiresAt, status: 'pending'|'approved'|'denied'|'expired', createdAt }`. Kinds include `spend`, `publish`, `send`, `delete`, `overwrite`, `direction`, `uncertain`. Decisions bind to the exact action digest/revision and are one-use. Pending approval overlays intercept the board. Approval is not permission to accept a deliverable.

Pool: `{ models: [{id,name,providerId,tier,enabled}], harnesses: [{id,name,kind,capabilities,enabled,verified,endpoint?}] }`. Model and harness are independent. Unconfigured harnesses are visible but not schedulable. The built-in API harness produces text artifacts; it cannot execute code or claim to browse external research. CLI/subscription logins are never imported.

Global counters are computed across all projects, regardless of client filter. `{ approvals, acceptance, runningTasks, runningAgents, todaySpend, unknownCostCalls, providerBalances }`. Unknown spend/balances are null, not zero. Balance entries include source and syncedAt.

## Internal orchestration boundary

There is no parallel Hub task database or HTTP endpoint for internal step completion. `orchestrator.mjs` builds the durable LangGraph; `brain.mjs` supplies the Paperclip gateway, exact-action policy and real configured provider calls. `paperclip.mjs` checks company scope and maps native issues. Tasks use Paperclip IDs; workflow step specifications map to actual child issue IDs. Parent goals alone appear in the global board.

Sidecar SQLite owns only inbox, memories, resource pointers, model preferences, manual locks, archive indexes, exact-action gates, dispatch/model intents, receipts, durable job outbox and audit. Archive projects an actually done/cancelled Paperclip task; it never changes a queued task into done. Unknown provider cost remains null. Credentials are encrypted separately from returned metadata.

It also owns discussion conversations, messages, versioned proposals, model-run receipts and links to Paperclip task IDs. These are not a second task-status database. Task snapshots and progress are fetched from Paperclip on every conversation read.

Model × harness remain independent. The first executable adapter is `api-text`, which produces real text documents/work products in Paperclip after approvals. It cannot browse, execute code or alter project files. Main CLI/gateway harnesses are registered but unverified and cannot silently wake. `api-text` reassignment uses Hub combination metadata rather than a nonexistent Paperclip agent.

Managed Hermes is now registered separately with a private profile, bounded provider proxy and file-only tools. Transport/file isolation checks do not verify model-driven delivery. Manual MCP configurations are explicitly not automatically eligible for workers; a new HOME is not an OS sandbox.

Manual locks are written before remote actions. Resume clears pause only, preserving the chosen combination. Rejection uses a real model to locate minimal affected steps, then resets only those and descendants. Recovery has one persisted allowance. Handoffs require workDone, decisions, pitfalls, unfinished and artifact SHA-256. Every model call stores its original input/response under the scoped task, not the global snapshot. One-use action gates bind task/version/prompt/model/provider fingerprints, expire and cannot be granted by a raw graph resume value.

Checkpoint replay is at-least-once. External calls use persisted operation receipts; ambiguous writes or billed calls are not replayed. Startup reconciliation blocks orphan in-progress Hub calls without touching tasks taken over by another actor. Current-process active calls are excluded. User intervention makes stale replies auditable without advancing current work.

## Continuous conversation API

All conversation routes require the same Hub session and same-origin mutations. `GET /api/conversations` lists discussions; `POST /api/conversations` creates one with `{requestId,title?,projectId?}`. `GET /api/conversations/:id` returns `{conversation,messages,proposal,pendingReply,tasks,taskSync,runs}`. `taskSync` marks backend disconnection/cache and missing linked IDs instead of silently removing associations.

All mutations below require `requestId` and use durable idempotency receipts:

- `POST /:id/messages {requestId,text}` saves user text and prepares a model authorization. It does not call a provider.
- `POST /:id/reply {requestId,digest}` authorizes exactly one current-context/model/provider request. The HTTP response waits for the result, with a 120-second provider timeout; polling and cancellation remain concurrent. Provider configuration, discussion/proposal or linked-task context changes invalidate the earlier digest.
- `POST /:id/cancel {requestId}` cancels local waiting/transport for this conversation only. Unknown upstream outcomes and cost remain unknown. Late responses stay audit-only.
- `POST /:id/proposal {requestId,title,goal,acceptance,constraints,projectId?,mode?}` saves an editable version. Model-produced proposals are drafts as well.
- `POST /:id/promote {requestId,digest}` confirms that version and creates one Paperclip goal, including acceptance/constraints. A valid existing project is required. Same-version and same-content confirmations reuse the linked task. Ambiguous remote writes are not retried with fresh identities. `goal-spec` records source conversation/digest and the durable job scheduler advances that Paperclip task.

Promotion may additionally include `contextDigest` to explicitly transfer the current prepared/consumed source selection to this task. It is not inferred from prior discussion. Source/project changes reject the transfer before task creation. Task source records are committed alongside the confirmed task link and job outbox. Conversation run detail derives metering only from a unique exact `usage.runId + conversationId` match; requested/response models, tokens, finish reason when provided and matched native-quota billing remain separate from user acceptance.

## Task references and capabilities

`GET /api/tasks/:id/context` returns metadata without source bodies. `POST /context/prepare {requestId,projectId,resourceIds,memoryIds,expectedDigest?,confirmed:true}` explicitly selects 1–8 sources, reads a bounded snapshot and versions it. `POST /context/clear {requestId,expectedDigest?,confirmed:true}` affects future use only. `POST /context/verify {confirmed:true}` re-reads selected sources without a model call. Prepare/clear never resume a task. Active or uncertain runs prevent replacing their source context. Plan, text dispatch and Hermes inputs carry selected bodies and provenance; every actual model use rechecks source/project/task state. Context revisions participate in task/approval bindings. Old artifacts and prior snapshots remain audit records.

`GET /api/capabilities` lists Hub-owned Skill/MCP metadata and call receipts. `GET /effective?projectId=...&taskId=...` resolves task > project > global scope overrides. Explicit scope changes use `POST /(skills|mcp)/:id/scope {requestId,scope:{kind,id?},enabled}`. No other client's config or credentials are implicitly imported.

- Skill: `POST /skills {requestId,path,origin?,confirmed:true}` registers one actual SKILL.md with canonical identity/hash/version; `POST /skills/:id/load {requestId,expectedHash,projectId?,taskId?,confirmed:true}` revalidates and returns bounded reference text with a load receipt and no permission grant. All routes are prefixed `/api/capabilities`.
- MCP: `POST /mcp` saves an explicit HTTP loopback endpoint or stdio command/args/env with encrypted secrets. `POST /mcp/:id/probe {requestId,expectedConfigHash,confirmed:true,...context}` performs only initialize/list-tools. Health describes the last completed probe; connections are not held after it.
- `POST /mcp/:id/calls/prepare {requestId,tool,arguments,...context}` validates current schema and creates a single-action digest. Pending calls project into the normal blocking board approvals. `approval.decide` validates that digest/scope fingerprint; approval launches `executeCall` asynchronously without holding the global command lock. Direct `/calls/:id/decision` and `/execute` expose the same underlying checks.
- `/calls/:id`, `/calls/:id/cancel`, `/mcp/:id/stop` report/control only owned operations. Fresh schema/config/scope/task changes reject old positive grants. A matching pending action can still be explicitly rejected when its scope expires. Forwarded but unconfirmed calls remain unknown across restart and are not replayed. Tool output is reference data, not authority or proof of task completion.

Conversation states include awaiting_confirmation, unavailable, calling, cancel_requested, completed, cancelled, stale and uncertain. Restarting an in-flight paid request marks it uncertain without replaying it. Raw messages and responses remain scoped to their conversation. A user confirmation to create a goal does not authorize subsequent model spending or tool actions.

## Connection API owned by the server

`GET /api/connections` returns redacted provider/adapter metadata. `POST /api/connections/provider` accepts `{ name, baseURL, apiKey?, dailyModel, strongModel? }`; blank apiKey preserves the old key. `POST /api/connections/test` performs an explicitly requested real model list check. No automatic borrowing of existing client tokens. `POST /api/session` exchanges the configured Hub access token for an HttpOnly session; `DELETE /api/session` signs out. On unconfigured builds the UI shows setup, never fabricated live status.

## Client layout

Constant top command bar + global counters + full-width board. Board / aligned project×status matrix / list are projections of one task array. Agent/model filters decorate cards. Task, resources, memory, combination pool, connections and inbox open as movable, resizable, minimizable windows; no fixed sidebars or mandatory page sequence. Default task detail is briefing + artifacts; raw events/steps are secondary. Dragging, reassignment and stopping are real audited commands with manual precedence. The root server serves the built client and API on one origin.

## Native client

A validated private `service-connection.json` selects the new view. Native reads only this service’s fixed 0600 access token, uses a redirect-free ephemeral HTTP login, and transfers the HttpOnly cookie into a private WKWebView store. It installs no native command script bridge and injects no token into JavaScript. Existing TerminalArea/TabStore and SidebarView preserve local tools/PWAs in the same app window; old workspace remains a fallback.

## Task limits, prepared workflows and actual artifacts

`GET /api/tasks/:id/budget` returns a versioned limit digest, call/output reservations and remaining allowances. `POST` to the same route requires `{requestId,expectedDigest,confirmed:true,limits}`; limits are `maxModelCalls`, `workerMaxModelCalls`, `maxOutputTokensPerCall`, `maxTotalOutputTokens`. This config never grants spend authorization. Planning, each worker request, rework and recovery share the task ledger. Unknown forwarded outcomes retain their reservations across restart. Reported provider output above its requested ceiling freezes further reservations until explicitly acknowledged and covered; previously reported use never resets. Monetary ceilings are not implemented; `currencyCap:null` is explicit.

`GET /api/tasks/:id/plan` returns `{preparedPlan,taskRevision,modelCalls:0}`. `POST /api/tasks/:id/plan/prepare` accepts `{requestId,expectedTaskRevision,expectedPlanDigest?,confirmed:true,plan}`. A plan has `{title,kind,briefing,steps}`; each of 1–12 DAG steps has `{id,title,prompt,dependencies,assignment:{modelId,harnessId},requiredCapabilities?}`. Only a real project task without existing steps or active/uncertain execution can prepare one. Enabled models, currently verified tools, capabilities and manual assignment locks are checked. Saving writes versioned sidecar metadata and expires unused old approvals; it never schedules or calls a model. Goal/project/source/budget/assignment changes invalidate the binding; status pause/resume alone does not. Existing stale plans fail closed without a fallback paid planning call. The orchestrator revalidates before direction and apply, then requires direction and exact dispatch spend approvals as usual.

Confirmed empty model replies retain actual tokens, finish reason and billing as `invalid_response`, never a usable plan or artifact. Owned pre-plan job failures may block only untouched/unassigned Hub planning parents. The failure receipt preserves uncertainty; Paperclip has no CAS, so this guard does not claim atomicity against other writers.

`GET /api/tasks/:taskId/artifacts/:artifactId/preview` returns bounded verified text and hash; `/download` returns verified bytes with `Content-Disposition: attachment`. No caller supplies a filesystem path. Access requires the current task artifact, finalized successful matching worker/run/step receipt and Hub-managed workspace identity; symlinks, hardlinks, replacement, size/hash drift and read races are rejected. Hosted task acceptance rechecks actual files or text hashes before marking the upstream task complete. Native only accepts user-initiated same-origin exact artifact GET links and asks for a new destination; it never overwrites or auto-opens a file. These routes do not prove a model produced the file until a real worker receipt exists.

## Shared correction and quality evidence

Shared memory correction has two separate confirmations: write and read/hash-verify the replacement while preserving the old record, then explicitly confirm deletion of the exact Hub-owned old record and verify absence. It reuses the worker’s save/read/delete interfaces; it is not a single-record update API. Unknown writes/deletes are reconciled without automatic replay. Source checks reject records confirmed removed or superseded.

`GET /api/routing-quality` exposes evidence; `POST /api/routing-quality/recommend {taskId}` returns recommendations. Recording execution/feedback is host-only. Current permissions, capabilities, manual locks, route versions and a specific unconsumed spend grant filter candidates before quality comparison. At least five independent same-type/difficulty tasks are required to rank; development/fixture/model self-scores do not count as production success. Unknown currency and incomplete task costs remain unknown. Compact planning advice is bounded and advisory only; it cannot increase authority or start execution.


## Paperclip execution responsibility and explicit failed-step revision

`GET /api/connections` also returns `executionOwner`. An unregistered identity is never created by reads. `POST /api/connections/execution-owner {requestId,confirmed:true}` explicitly registers and verifies a dedicated paused native Paperclip responsibility Agent, with no command/API key and both periodic and on-demand wake disabled. This operation schedules no job/model. A registered identity is freshly checked for exact company/config/ownership and live-run absence; TTL expiry requires recheck. The responsibility Agent is excluded from selectable execution tools. Hosted dispatch assigns its genuine ID; foreign/user owners, cleared ownership and externally changed terminal/blocked states reject stale dispatch/model calls. This preserves Paperclip's requirement that in-progress issues have an assignee; it is not a second Agent execution backend or a conditional remote PATCH guarantee.

`POST /api/commands` accepts `{command:{type:'task.rework.prepare',id,stepId,note,expectedTaskRevision,confirmed:true},idempotencyKey}`. This is metadata preparation for a currently failed mapped step, not retry execution. Exact finalized native receipts (or confirmed API-text failure), no active/uncertain calls/workers/jobs, fresh version and preserved manual locks are required. Only an explicit blocked pause is released. The request, unused-gate expiry, receipt, audit and job outbox commit atomically; the job stops at a new `direction/apply_revision` gate without a locating/recovery model call. That gate binds root IDs, downstream dependency closure and independent completed artifact hashes. Before applying, the orchestrator rechecks request/version/locks and unchanged scope. Applying increments affected workflow versions; subsequent dispatch still requires its own spend authorization and the existing task ledger. Recovery allowance is not reset.

After exact native worker finalization, `ManagedHermesHarness.release(runId)` may revoke the run lease and close only its current in-memory owned child, with matching prepared worker/version/harness identity and freshly confirmed native terminal status. Unknown/active/stopping/no-handle states remain `cleanup_pending`. Cleanup failure never changes delivery status or resubmits execution. Persistent PID metadata alone never grants ownership after restart.
