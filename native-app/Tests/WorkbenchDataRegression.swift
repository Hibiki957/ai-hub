import Foundation

@main
struct WorkbenchDataRegression {
    struct Failure: Error, CustomStringConvertible { var description: String }
    @MainActor static func check(_ value: @autoclosure () -> Bool, _ label: String) throws {
        guard value() else { throw Failure(description: label) }
        print("PASS: \(label)")
    }
    @MainActor static func rejected(_ label: String, _ work: () throws -> Void) throws {
        do { try work() } catch { print("PASS: \(label)"); return }
        throw Failure(description: label)
    }
    @MainActor static func main() {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("aihub-workbench-data-\(UUID())")
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            try testModel()
            try testStore(root)
            try testProjectPresentation(root)
            try testFailures(root)
            try testApprovalBoundaries(root)
            try testProposals(root)
            try testProposalReplyIdentity(root)
            try testProposalAtomicity(root)
            try testSourceCompatibility(root)
            try testAcceptanceSnapshots(root)
            try testSourceIdentityMigration(root)
            try testSourceMigrationFailure(root)
            try testPhaseOneMetadata(root)
            print("ALL WORKBENCH DATA REGRESSIONS PASSED (offline callback fixtures; no agent process)")
        } catch { fputs("FAIL: \(error)\n", stderr); exit(1) }
    }

    @MainActor static func testProjectPresentation(_ root: URL) throws {
        let file = root.appendingPathComponent("project-layout.json")
        let store = WorkbenchStore(storageURL: file)
        let firstTopic = store.state.workspaces[0].id
        let secondTopic = try store.createWorkspace(name: "Second topic")
        let first = try store.createProject(workspaceID: firstTopic, name: "First")
        let taskA = try store.createTask(projectID: first, goal: "First task")
        let conversationA = try store.createConversation(projectID: first, title: "First discussion")
        let second = try store.createProject(workspaceID: secondTopic, name: "Second")
        let taskB = try store.createTask(projectID: second, goal: "Second task")
        _ = try store.createConversation(projectID: second, title: "Second discussion")
        store.selectProject(first)
        try check(store.selectedTaskID == nil && store.page == .tasks && store.selectedWorkspaceID == firstTopic,
                  "project selection clears stale task and enters task context under the correct topic")
        try check(store.visibleTasks.map(\.id) == [taskA] && store.scopedConversations.map(\.id) == [conversationA],
                  "task board and discussion use the same project scope")
        try store.attachReference(source: "zotero", location: "zotero://select/library/items/ABCD2345")
        try check(store.selectedProject?.setup?.references.count == 1 && store.state.tasks.first { $0.id == taskA }?.references.isEmpty == true,
                  "project references remain separate from task references")
        store.selectTask(taskB, page: .workflow)
        try check(store.selectedProjectID == second && store.selectedWorkspaceID == secondTopic && store.page == .workflow,
                  "opening task from a board restores its topic and project context")
        try store.attachReference(source: "eagle", location: "https://example.com/ref")
        try check(store.selectedTask?.references.count == 1 && store.selectedProject?.setup?.references.isEmpty != false,
                  "task association does not leak to another project")
        var project = store.selectedProject!
        var setup = WorkbenchProjectSetup(); setup.kind = .development; setup.directory = root.path
        setup.familyIDs = ["hermes", "codex"]; setup.preferredVariants = ["hermes": "cli.hermes"]
        setup.discussionFamilyIDs = ["hermes"]; setup.tiers = ["kimi": "execution"]; setup.summary = "Confirmed summary"
        project.setup = setup; try store.updateProject(project)
        try check(store.selectedTask?.policy.workingDirectory.isEmpty == true && store.selectedTask?.policy.confirmed == false,
                  "project directory and tool preferences confer no task permissions")
        let loaded = WorkbenchStore(storageURL: file)
        try check(loaded.state.projects.first { $0.id == second }?.setup == setup, "project role, variants, members, directory and summary persist")
        project.setup?.directory = root.appendingPathComponent("missing").path
        try rejected("invalid project directory rolls back") { try store.updateProject(project) }
        try check(store.state.projects.first { $0.id == second }?.setup == setup, "failed preference update preserves prior values")
        var object = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        var projects = object["projects"] as! [[String: Any]]
        for i in projects.indices { projects[i].removeValue(forKey: "setup") }
        object["projects"] = projects
        let legacy = try JSONDecoder().decode(WorkbenchState.self, from: JSONSerialization.data(withJSONObject: object))
        try check(legacy.tasks.map(\.id) == store.state.tasks.map(\.id) && legacy.projects.allSatisfy { $0.setup == nil },
                  "legacy schema without presentation setup decodes without dropping tasks or project identities")
    }

    @MainActor static func testModel() throws {
        try check(WorkbenchPage.primaryPages == [.stack, .discussion, .tasks, .workflow, .board, .archive],
                  "six primary destinations match the revised UI decision; lifecycle is not navigation progress")
        let a = WorkbenchNode(id: "a", title: "A", kind: .agent, agentID: "hermes")
        let b = WorkbenchNode(id: "b", title: "B", kind: .agent, dependsOn: ["a"], agentID: "openclaw")
        let c = WorkbenchNode(id: "c", title: "C", kind: .agent, dependsOn: ["a"], agentID: "kimi")
        let d = WorkbenchNode(id: "d", title: "Join", kind: .join, dependsOn: ["b", "c"])
        try check(WorkbenchPlan(revision: 1, nodes: [a, b, c, d]).validationErrors().isEmpty, "three independent Agent instances support serial, parallel and join dependencies")
        var cycle = a; cycle.dependsOn = ["b"]
        try check(!WorkbenchPlan(revision: 1, nodes: [cycle, b]).validationErrors().isEmpty, "cyclic dependency graph is rejected")
        var dangling = b; dangling.dependsOn = ["missing"]
        try check(!WorkbenchPlan(revision: 1, nodes: [a, dangling]).validationErrors().isEmpty, "missing dependencies are rejected")
        try check(!WorkbenchPlan(revision: 1, nodes: [a, a]).validationErrors().isEmpty, "duplicate node identity is rejected")
        var effect = a; effect.sideEffect = .local; effect.retries = 1
        try check(!WorkbenchPlan(revision: 1, nodes: [effect]).validationErrors().isEmpty, "local side effects cannot be automatically retried")
        effect.sideEffect = .external
        try check(!WorkbenchPlan(revision: 1, nodes: [effect]).validationErrors().isEmpty, "external side effects cannot be automatically retried")
        for timeout in [999, 1_800_001] {
            var node = a; node.timeoutMs = timeout
            try check(!WorkbenchPlan(revision: 1, nodes: [node]).validationErrors().isEmpty, "timeout outside runtime bounds is rejected: \(timeout)")
        }
        for timeout in [1000, 1_800_000] {
            var node = a; node.timeoutMs = timeout; node.retries = 2
            try check(WorkbenchPlan(revision: 1, nodes: [node]).validationErrors().isEmpty, "runtime boundary timeout with two retries is accepted: \(timeout)")
        }
        var excessive = a; excessive.retries = 3
        try check(!WorkbenchPlan(revision: 1, nodes: [excessive]).validationErrors().isEmpty, "third automatic retry is rejected")
        var policy = WorkbenchPolicy()
        policy.expiresAt = Date(timeIntervalSince1970: 1_900_000_000)
        let encoded = try JSONEncoder().encode(policy)
        var json = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
        try check(json["budgetUSD"] == nil && json["expiresAt"] is String
                  && WorkbenchPolicy.expiryDate(json["expiresAt"] as! String) == policy.expiresAt,
                  "wire policy omits nil budget and emits a valid ISO expiry")
        json["expiresAt"] = policy.expiresAt!.timeIntervalSinceReferenceDate
        let legacy = try JSONDecoder().decode(WorkbenchPolicy.self, from: JSONSerialization.data(withJSONObject: json))
        try check(legacy.expiresAt == policy.expiresAt, "legacy numeric expiry remains readable without weakening expiry validation")
        for location in ["javascript:alert(1)", "data:text/html,hello", "ssh://server", "http://example.com", "file://remote-server/share/script.sh", "https://user:secret@example.com", "file:///tmp/test.sh?execute=true"] {
            try check(WorkbenchReferenceDestination.parse(location) == nil, "unsafe or unsupported reference has no action: \(location.components(separatedBy: ":")[0])")
        }
        try check(WorkbenchReferenceDestination.parse("/tmp/test.command") == .revealFile(URL(fileURLWithPath: "/tmp/test.command"))
                  && WorkbenchReferenceDestination.parse("file:///tmp/script.sh") == .revealFile(URL(fileURLWithPath: "/tmp/script.sh")),
                  "local scripts are classified only as Finder reveal, never execution")
        try check(WorkbenchReferenceDestination.parse("https://example.com/reference") == .openHTTPS(URL(string: "https://example.com/reference")!),
                  "HTTPS reference is explicitly classified for user-initiated opening")
    }
    @MainActor static func ready(_ store: WorkbenchStore, root: URL, goal: String = "Offline task") throws -> UUID {
        let project = try store.createProject(workspaceID: store.state.workspaces[0].id, name: "Fixture")
        let id = try store.createTask(projectID: project, goal: goal)
        var task = store.state.tasks.first { $0.id == id }!
        task.acceptance = "Fixture callback receives the expected version"
        task.constraints = "No network"
        task.deliverables = "Fixture evidence"
        task.tags = ["research", "offline"]
        task.references = [WorkbenchReference(title: "Fixture reference", source: "Obsidian", location: root.appendingPathComponent("reference.md").path, note: "Reference only, never imported")]
        try store.updateDetails(task)
        try store.revisePlan(taskID: id, nodes: [WorkbenchNode(id: "only", title: "Plan", kind: .agent, agentID: "hermes")])
        try store.confirmPlan(taskID: id)
        var policy = WorkbenchPolicy()
        policy.workingDirectory = root.path; policy.readRoots = [root.path]
        try store.updatePolicy(taskID: id, policy: policy, confirm: true)
        return id
    }
    @MainActor static func testStore(_ root: URL) throws {
        let url = root.appendingPathComponent("state.json")
        let store = WorkbenchStore(storageURL: url)
        try check(store.state.workspaces.count == 5 && store.state.tasks.isEmpty && store.state.projects.isEmpty,
                  "initial state contains only five renameable workspace suggestions, without fake tasks")
        try store.renameWorkspace(store.state.workspaces[0].id, name: "Personal research")
        let project = try store.createProject(workspaceID: store.state.workspaces[0].id, name: "Research")
        var callbacks = 0
        store.onRun = { _ in callbacks += 1 }
        let conversation = try store.createConversation(projectID: project, title: "Decision")
        try store.appendMessage(conversationID: conversation, text: "Investigate flight control", evidence: .suggestion)
        let message = store.state.conversations[0].messages[0]
        let fromChat = try store.convertMessage(conversationID: conversation, messageID: message.id)
        let converted = store.state.tasks.first { $0.id == fromChat }!
        try check(callbacks == 0 && converted.projectID == project && converted.sourceMessageID == message.id
                  && converted.conversationID == conversation && store.state.conversations[0].messages[0].taskIDs == [fromChat],
                  "selected discussion converts to one traceable task without executing anything")
        try check(converted.source == WorkbenchSource(kind: .legacyConversation, threadID: conversation, messageID: message.id, evidence: .suggestion),
                  "legacy discussion conversion retains typed provenance and suggestion evidence")
        try rejected("unconfirmed plan and policy cannot invoke the bridge") { _ = try store.requestRun(taskID: fromChat) }
        try check(callbacks == 0 && converted.runs.isEmpty, "rejected submission creates no run or execution")

        let id = try ready(store, root: root)
        var delivered: WorkbenchRunRequest?
        store.onRun = { request in
            let saved = try JSONDecoder().decode(WorkbenchState.self, from: Data(contentsOf: url))
            guard saved.tasks.contains(where: { $0.runs.contains { $0.id == request.runID } }) else { throw Failure(description: "request was not persisted before dispatch") }
            delivered = request
        }
        let runID = try store.requestRun(taskID: id)
        try check(delivered?.runID == runID, "unique run and immutable plan/policy snapshot persist before dispatch")
        try check(delivered?.constraints == "No network" && delivered?.deliverables == "Fixture evidence" && delivered?.references.count == 1 && delivered?.evidence == .unverified,
                  "execution request carries requirements without upgrading missing source evidence")
        try rejected("duplicate submission while running is rejected") { _ = try store.requestRun(taskID: id) }
        var revised = store.state.tasks.first { $0.id == id }!.currentPlan.nodes
        revised[0].agentID = "kimi"
        try store.revisePlan(taskID: id, nodes: revised, summary: "Future plan")
        var changed = store.state.tasks.first { $0.id == id }!
        changed.goal = "Changed goal"
        try store.updateDetails(changed)
        let running = store.state.tasks.first { $0.id == id }!
        try check(running.currentPlan.nodes[0].agentID == "kimi" && running.runs[0].plan.nodes[0].agentID == "hermes"
                  && running.runs[0].goal == "Offline task" && running.confirmedRevision == nil && !running.policy.confirmed,
                  "editing future work preserves prior run goal and plan while invalidating confirmation")
        let replayed = WorkbenchStore(storageURL: url)
        let interrupted = replayed.state.tasks.first { $0.id == id }!
        try check(interrupted.status == .interrupted && interrupted.runs[0].status == .interrupted && replayed.onRun == nil,
                  "restart marks unfinished work interrupted and never automatically replays it")

        var approvalCalls = 0
        store.onApproval = { _, _ in approvalCalls += 1 }
        let approval = store.requestApproval(runID: runID, summary: "Read fixture", details: "Object: offline file; scope: this action", expiresAt: Date().addingTimeInterval(300))!
        let secondApproval = store.requestApproval(runID: runID, summary: "Another fixture", details: "Independent pending action", expiresAt: Date().addingTimeInterval(300))!
        try store.resolveApproval(approval, allowed: false)
        try rejected("approval cannot be replayed after a decision") { try store.resolveApproval(approval, allowed: true) }
        try check(approvalCalls == 1, "one scoped approval yields exactly one bridge response")
        try check(store.state.tasks.first { $0.id == id }!.status == .awaitingApproval, "resolving one parallel approval keeps the remaining approval visible")
        try store.resolveApproval(secondApproval, allowed: true)
        store.appendRunEvent(runID: runID, kind: "fixture", summary: "Authorization: Bearer fixture-secret api_key=fixture-key")
        let log = store.state.tasks.first { $0.id == id }!.events.last!.summary
        try check(!log.contains("fixture-secret") && !log.contains("fixture-key"), "run evidence is redacted before persistence")
        store.finishRun(runID: runID, status: .completed, summary: "Offline result", artifacts: [WorkbenchArtifact(title: "Evidence", location: root.appendingPathComponent("artifact").path)])
        try check(store.state.tasks.first { $0.id == id }!.status == .awaitingAcceptance, "executor completion requires separate user acceptance")
        try rejected("empty acceptance claim is rejected") { try store.verify(taskID: id, accepted: true, note: "") }
        try store.verify(taskID: id, accepted: true, note: "Compared against fixture requirement")
        try store.saveTemplate(taskID: id, name: "Verified pattern")
        try check(store.state.templates[0].versions[0].nodes[0].agentID == "hermes", "successful template uses the executed version rather than a newer unexecuted plan")
        try store.saveTemplate(taskID: id, name: "Verified pattern", updating: store.state.templates[0].id)
        try check(store.state.templates[0].versions.map(\.revision) == [1, 2] && Set(store.state.templates[0].versions.map(\.id)).count == 2,
                  "template updates preserve separately identifiable versions")
        try store.applyTemplate(taskID: fromChat, templateID: store.state.templates[0].id, version: 1)
        let templateTask = store.state.tasks.first { $0.id == fromChat }!
        try check(templateTask.currentPlan.templateVersion == 1 && templateTask.confirmedRevision == nil && !templateTask.policy.confirmed,
                  "applying a template records its version and confers no execution authorization")
        try store.archive(taskID: id)
        try check(!store.visibleTasks.contains { $0.id == id }, "archive removes task from active projection while preserving history")
        try store.restore(taskID: id)
        let restored = store.state.tasks.first { $0.id == id }!
        try check(restored.status == .draft && restored.confirmedRevision == nil && !restored.policy.confirmed && !restored.runs.isEmpty,
                  "archive restore retains history but requires renewed confirmation")
        let loaded = WorkbenchStore(storageURL: url)
        try check(loaded.state == store.state, "task, references, discussion, approvals, versions and artifacts round-trip through atomic persistence")
        let mode = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int
        try check(mode == 0o600, "workbench storage is private to the current user")
    }
    @MainActor static func testFailures(_ root: URL) throws {
        let previewURL = root.appendingPathComponent("preview.json")
        let preview = WorkbenchStore(storageURL: previewURL, preview: true)
        let previewTask = try ready(preview, root: root)
        preview.onRun = { _ in throw Failure(description: "preview dispatched") }
        try rejected("preview refuses execution even with a configured bridge") { _ = try preview.requestRun(taskID: previewTask) }
        try check(!FileManager.default.fileExists(atPath: previewURL.path), "preview never writes workbench storage")
        let url = root.appendingPathComponent("failed.json")
        let store = WorkbenchStore(storageURL: url)
        let id = try ready(store, root: root)
        try rejected("missing execution bridge fails closed") { _ = try store.requestRun(taskID: id) }
        store.onRun = { _ in throw Failure(description: "sandbox unavailable") }
        try rejected("bridge rejection is propagated") { _ = try store.requestRun(taskID: id) }
        try check(store.state.tasks.first { $0.id == id }!.status == .blocked && store.state.tasks.first { $0.id == id }!.runs.count == 1,
                  "failed dispatch remains a persisted blocked run with evidence")
        store.onRun = { _ in }
        let retry = try store.requestRun(taskID: id, resumeFromRunID: store.state.tasks.first { $0.id == id }!.runs.last!.id)
        var cancelled: UUID?
        store.onCancel = { cancelled = $0 }
        try store.cancel(taskID: id)
        try check(cancelled == retry && store.state.tasks.first { $0.id == id }!.status == .cancelling,
                  "cancel addresses only the owned run and waits for executor confirmation")
        store.finishRun(runID: retry, status: .cancelled, summary: "Fixture terminated")
        try check(store.state.tasks.first { $0.id == id }!.status == .cancelled, "executor confirms terminal cancellation")
        var expired = store.state.tasks.first { $0.id == id }!.policy
        expired.expiresAt = Date().addingTimeInterval(-1)
        try rejected("expired task authorization cannot be confirmed") { try store.updatePolicy(taskID: id, policy: expired, confirm: true) }
        let badURL = root.appendingPathComponent("corrupt.json")
        let corrupt = Data("original invalid content".utf8); try corrupt.write(to: badURL)
        let bad = WorkbenchStore(storageURL: badURL)
        try rejected("corrupt storage cannot be silently overwritten") { _ = try bad.createProject(workspaceID: bad.state.workspaces[0].id, name: "Wrong") }
        let after = try Data(contentsOf: badURL)
        try check(after == corrupt && bad.state.projects.isEmpty, "failed mutation rolls back and preserves corrupt original bytes")
    }
    @MainActor static func testApprovalBoundaries(_ root: URL) throws {
        var clock = Date()
        let store = WorkbenchStore(storageURL: root.appendingPathComponent("approvals.json"), now: { clock })
        let id = try ready(store, root: root)
        store.onRun = { _ in }
        store.onCancel = { _ in }
        var responses = 0
        store.onApproval = { _, _ in responses += 1 }
        let run = try store.requestRun(taskID: id)
        try check(store.requestApproval(runID: run, summary: "No deadline", details: "") == nil
                  && store.requestApproval(runID: run, summary: "Expired", details: "", expiresAt: clock.addingTimeInterval(-1)) == nil,
                  "missing and expired runtime deadlines cannot create approvable UI requests")
        let expires = clock.addingTimeInterval(10)
        let approval = store.requestApproval(runID: run, summary: "Scoped", details: "", expiresAt: expires)!
        clock = expires
        try rejected("an approval at its runtime deadline cannot be accepted") { try store.resolveApproval(approval, allowed: true) }
        let unchanged = store.state.approvals.first { $0.id == approval }!
        try check(responses == 0 && unchanged.allowed == nil && unchanged.resolvedAt == nil,
                  "expired approval causes no callback or successful decision record")
        clock = Date()
        let pending = store.requestApproval(runID: run, summary: "Before cancellation", details: "", expiresAt: clock.addingTimeInterval(300))!
        try store.cancel(taskID: id)
        try rejected("cancelling run cannot accept a pending approval") { try store.resolveApproval(pending, allowed: true) }
        try check(store.requestApproval(runID: run, summary: "Late request", details: "", expiresAt: clock.addingTimeInterval(300)) == nil,
                  "cancelling run cannot acquire new approval requests")
        store.finishRun(runID: run, status: .cancelled, summary: "Cancelled fixture")
        try rejected("terminal run cannot accept a stale approval") { try store.resolveApproval(pending, allowed: false) }
        try check(responses == 0, "cancelled and terminal approvals never reach the execution bridge")
        let second = try ready(store, root: root)
        var policy = store.state.tasks.first { $0.id == second }!.policy
        policy.expiresAt = Date().addingTimeInterval(30)
        try store.updatePolicy(taskID: second, policy: policy, confirm: true)
        let secondRun = try store.requestRun(taskID: second)
        let bounded = store.requestApproval(runID: secondRun, summary: "Bound by policy", details: "", expiresAt: clock.addingTimeInterval(300))!
        try check(store.state.approvals.first { $0.id == bounded }!.expiresAt == policy.expiresAt,
                  "approval expiry never exceeds the immutable run policy expiry")
        clock = policy.expiresAt!
        try rejected("expired run authorization rejects a still-present approval") { try store.resolveApproval(bounded, allowed: true) }
    }

    @MainActor static func proposal(projectID: UUID) -> WorkbenchProposal {
        var value = WorkbenchProposal(projectID: projectID,
            source: WorkbenchSource(kind: .hubConversation, threadID: UUID(), messageID: UUID(), evidence: .suggestion),
            title: "Documented offline work", goal: "Produce an inspectable fixture")
        value.deliverables = "A report and its evidence"
        value.acceptance = "The fixture contains the expected evidence"
        value.constraints = "No remote service or agent process"
        value.contextSnapshot = "Chosen project context"
        value.summary = "Plan suggested in the source conversation"
        value.nodes = [WorkbenchNode(id: "produce", title: "Produce fixture", kind: .agent, agentID: "hermes")]
        return value
    }

    @MainActor static func prepare(_ store: WorkbenchStore, taskID: UUID, root: URL) throws {
        var task = store.state.tasks.first { $0.id == taskID }!
        if task.acceptance.isEmpty { task.acceptance = "Check fixture output"; try store.updateDetails(task) }
        if task.currentPlan.nodes.isEmpty {
            try store.revisePlan(taskID: taskID, nodes: [WorkbenchNode(id: "work", title: "Fixture", kind: .agent, agentID: "hermes")])
        }
        try store.confirmPlan(taskID: taskID)
        var policy = WorkbenchPolicy()
        policy.workingDirectory = root.path; policy.readRoots = [root.path]
        try store.updatePolicy(taskID: taskID, policy: policy, confirm: true)
    }

    @MainActor static func testProposals(_ root: URL) throws {
        let file = root.appendingPathComponent("proposals.json")
        let store = WorkbenchStore(storageURL: file)
        let project = try store.createProject(workspaceID: store.state.workspaces[0].id, name: "Proposal project")
        var proposed = proposal(projectID: project)
        var draft = proposed
        draft.title = ""; draft.goal = ""; draft.deliverables = ""; draft.acceptance = ""; draft.nodes = []
        try store.saveProposal(draft)
        try check(store.state.proposals?.count == 1 && store.state.tasks.isEmpty,
                  "an incomplete proposal is a persisted draft, not an executable task")
        let beforeInvalidAcceptance = store.state
        try rejected("incomplete proposals cannot be accepted") { _ = try store.acceptProposal(draft.id) }
        try check(store.state == beforeInvalidAcceptance, "failed proposal validation leaves proposals and tasks unchanged")
        var otherProject = proposed; otherProject.projectID = UUID()
        try rejected("proposal requires an existing main project") { try store.saveProposal(otherProject) }
        let secondProject = try store.createProject(workspaceID: store.state.workspaces[0].id, name: "Other project")
        otherProject.projectID = secondProject
        try rejected("draft edits cannot silently move source work to another project") { try store.saveProposal(otherProject) }
        var promoted = proposed; promoted.source.evidence = .userConfirmed
        try rejected("editing proposal content cannot promote suggestion provenance") { try store.saveProposal(promoted) }
        var rebound = proposed; rebound.source.messageID = UUID()
        try rejected("draft edits cannot replace the source message") { try store.saveProposal(rebound) }
        var forged = proposed; forged.acceptedTaskID = UUID(); forged.acceptedAt = Date()
        try rejected("saving a draft cannot forge an acceptance marker") { try store.saveProposal(forged) }
        try store.saveProposal(proposed)
        var callbacks = 0
        store.onRun = { _ in callbacks += 1 }
        let taskID = try store.acceptProposal(proposed.id)
        let accepted = store.state.proposals!.first { $0.id == proposed.id }!
        let task = store.state.tasks.first { $0.id == taskID }!
        try check(accepted.acceptedTaskID == taskID && accepted.acceptedAt != nil
                  && task.proposalID == proposed.id && task.source == proposed.source,
                  "proposal acceptance atomically binds the exact proposal, task and typed source")
        try check(task.goal == proposed.goal && task.inputs == proposed.contextSnapshot
                  && task.deliverables == proposed.deliverables && task.acceptance == proposed.acceptance
                  && task.constraints == proposed.constraints && task.decisionSummary == proposed.summary,
                  "acceptance carries the proposal requirements and selected context into the task")
        try check(task.currentPlan.revision == 1 && task.currentPlan.nodes == proposed.nodes && task.plans.count == 1
                  && task.status == .draft && task.confirmedRevision == nil && !task.policy.confirmed && callbacks == 0,
                  "accepted proposal creates plan version one while retaining separate plan and permission confirmation")
        try check(task.references.count == 1 && task.references[0].location == proposed.source.canonicalLocation,
                  "accepted work retains a direct link to the exact source message")
        let beforeRepeat = store.state
        let duplicate = try store.acceptProposal(proposed.id)
        try check(duplicate == taskID && store.state == beforeRepeat && callbacks == 0,
                  "repeated acceptance returns the same task without another event, mutation or dispatch")
        proposed.title = "Attempted overwrite"
        try rejected("an accepted proposal cannot be edited in place") { try store.saveProposal(proposed) }
        let loaded = WorkbenchStore(storageURL: file)
        let reopenedTask = try loaded.acceptProposal(proposed.id)
        try check(reopenedTask == taskID && loaded.state == store.state,
                  "proposal-to-task identity remains idempotent after reloading storage")
        var next = accepted
        next.id = UUID(); next.acceptedTaskID = nil; next.acceptedAt = nil
        next.previousProposalID = accepted.id; next.revision = accepted.revision + 1
        next.title = "Revised proposal"
        var promotedVersion = next; promotedVersion.source.evidence = .userConfirmed
        try rejected("a new proposal revision cannot wash suggestion evidence into user confirmation") { try store.saveProposal(promotedVersion) }
        try store.saveProposal(next)
        try check(store.state.proposals?.last?.source == accepted.source && store.state.proposals?.last?.previousProposalID == accepted.id,
                  "a revised proposal preserves its origin and explicit predecessor")
        var editedTask = task
        editedTask.source?.evidence = .userConfirmed
        editedTask.goal = "User-refined task requirements"
        try store.updateDetails(editedTask)
        try store.revisePlan(taskID: taskID, nodes: task.currentPlan.nodes, summary: "Refined implementation plan")
        try check(store.state.tasks.first { $0.id == taskID }?.source == task.source,
                  "requirement and plan edits preserve the original typed source rather than replacing its evidence")
        try prepare(store, taskID: taskID, root: root)
        var request: WorkbenchRunRequest?
        store.onRun = { request = $0 }
        let runID = try store.requestRun(taskID: taskID)
        try check(request?.source == task.source && request?.evidence == .suggestion
                  && store.state.tasks.first { $0.id == taskID }?.runs.last?.source == task.source,
                  "confirmation authorizes execution without changing source evidence in request and run snapshots")
        store.finishRun(runID: runID, status: .completed, summary: "Offline callback result")
        try check(WorkbenchStore(storageURL: file).state == store.state,
                  "typed source, proposal versions and terminal run snapshots survive a reload")
    }

    @MainActor static func testProposalAtomicity(_ root: URL) throws {
        let parent = root.appendingPathComponent("atomic-proposals")
        let file = parent.appendingPathComponent("state.json")
        let savedParent = root.appendingPathComponent("atomic-proposals-original")
        let store = WorkbenchStore(storageURL: file)
        let project = try store.createProject(workspaceID: store.state.workspaces[0].id, name: "Atomic fixture")
        let proposed = proposal(projectID: project)
        try store.saveProposal(proposed)
        let before = store.state
        let originalBytes = try Data(contentsOf: file)
        let selection = store.selectedTaskID
        try FileManager.default.moveItem(at: parent, to: savedParent)
        try Data("blocks directory creation".utf8).write(to: parent)
        try rejected("proposal acceptance propagates a real persistence failure") { _ = try store.acceptProposal(proposed.id) }
        try check(store.state == before && store.selectedTaskID == selection,
                  "failed persistence rolls back both task creation and proposal acceptance")
        var modified = proposed; modified.goal = "This edit must not persist"
        try rejected("proposal draft save also propagates persistence failure") { try store.saveProposal(modified) }
        try check(store.state == before, "a failed proposal save does not alter the in-memory draft")
        try FileManager.default.removeItem(at: parent)
        try FileManager.default.moveItem(at: savedParent, to: parent)
        let after = try Data(contentsOf: file)
        try check(after == originalBytes && WorkbenchStore(storageURL: file).state == before,
                  "storage failure preserves the last complete persisted proposal and task state")
        let taskID = try store.acceptProposal(proposed.id)
        let reloaded = WorkbenchStore(storageURL: file)
        try check(reloaded.state.tasks.map(\.id) == [taskID] && reloaded.state.proposals?.first?.acceptedTaskID == taskID,
                  "retry after storage repair commits one task and its proposal marker together")
    }

    @MainActor static func testProposalReplyIdentity(_ root: URL) throws {
        let file = root.appendingPathComponent("proposal-reply-identity.json")
        let store = WorkbenchStore(storageURL: file)
        let project = try store.createProject(workspaceID: store.state.workspaces[0].id, name: "Generated proposal identity")
        var generated = proposal(projectID: project)
        generated.generationMessageID = UUID()
        try store.saveProposal(generated)
        let before = store.state
        var cleared = generated; cleared.generationMessageID = nil
        try rejected("editing a generated draft cannot clear its reply identity") { try store.saveProposal(cleared) }
        var replaced = generated; replaced.generationMessageID = UUID()
        try rejected("editing a generated draft cannot replace its reply identity") { try store.saveProposal(replaced) }
        var duplicate = generated; duplicate.id = UUID()
        try rejected("the same reply cannot create a second original proposal") { try store.saveProposal(duplicate) }
        duplicate.source.messageID = UUID()
        try rejected("changing the source message cannot bypass same-thread reply import uniqueness") { try store.saveProposal(duplicate) }
        try check(store.state == before, "rejected reply-identity changes leave the original proposal intact")
        generated.summary = "Edited explanation with the same generation provenance"
        try store.saveProposal(generated)
        let taskID = try store.acceptProposal(generated.id)
        var revision = generated
        revision.id = UUID(); revision.previousProposalID = generated.id; revision.revision = 2
        revision.summary = "Explicit follow-up revision"
        try store.saveProposal(revision)
        try check(store.state.proposals?.count == 2
                  && store.state.proposals?.last?.previousProposalID == generated.id
                  && store.state.proposals?.last?.generationMessageID == generated.generationMessageID,
                  "an explicit revision may retain the original reply identity and predecessor")
        let loaded = WorkbenchStore(storageURL: file)
        let existingTask = try loaded.acceptProposal(generated.id)
        try check(loaded.state == store.state && existingTask == taskID,
                  "reply identity and explicit revisions survive reload without duplicate task acceptance")
        var repeated = generated; repeated.id = UUID()
        try rejected("reply import uniqueness remains enforced after reloading accepted proposals and revisions") {
            try loaded.saveProposal(repeated)
        }
    }

    @MainActor static func testSourceCompatibility(_ root: URL) throws {
        let file = root.appendingPathComponent("legacy-source.json")
        let store = WorkbenchStore(storageURL: file)
        let project = try store.createProject(workspaceID: store.state.workspaces[0].id, name: "Legacy provenance")
        let conversation = try store.createConversation(projectID: project, title: "Existing conversation")
        try store.appendMessage(conversationID: conversation, text: "Existing unconfirmed advice", evidence: .suggestion)
        let message = store.state.conversations[0].messages[0]
        let id = try store.convertMessage(conversationID: conversation, messageID: message.id)
        try prepare(store, taskID: id, root: root)
        var object = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        object.removeValue(forKey: "proposals")
        var tasks = object["tasks"] as! [[String: Any]]
        for i in tasks.indices {
            tasks[i].removeValue(forKey: "source")
            tasks[i].removeValue(forKey: "proposalID")
            tasks[i].removeValue(forKey: "acceptanceRecords")
        }
        object["tasks"] = tasks
        try JSONSerialization.data(withJSONObject: object).write(to: file, options: .atomic)
        let legacy = WorkbenchStore(storageURL: file)
        try check(legacy.errorMessage == nil && legacy.state.proposals == nil
                  && legacy.state.tasks.first?.source == nil && legacy.state.tasks.first?.acceptanceRecords == nil,
                  "schema-one records without all new business fields remain readable")
        var request: WorkbenchRunRequest?
        legacy.onRun = { request = $0 }
        let runID = try legacy.requestRun(taskID: id)
        try check(request?.source == WorkbenchSource(kind: .legacyConversation, threadID: conversation, messageID: message.id, evidence: .suggestion)
                  && request?.evidence == .suggestion && legacy.state.tasks.first?.runs.last?.source == request?.source,
                  "legacy IDs resolve conservatively into a fixed typed source when the run is created")
        legacy.finishRun(runID: runID, status: .completed, summary: "Legacy callback finished")
        var missing = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        missing["conversations"] = []
        let missingFile = root.appendingPathComponent("missing-source.json")
        try JSONSerialization.data(withJSONObject: missing).write(to: missingFile)
        let brokenSource = WorkbenchStore(storageURL: missingFile)
        var missingRequest: WorkbenchRunRequest?
        brokenSource.onRun = { missingRequest = $0 }
        let missingRun = try brokenSource.requestRun(taskID: id)
        try check(missingRequest?.evidence == .unverified && missingRequest?.source?.evidence == .unverified,
                  "a missing legacy message never defaults to user-confirmed evidence")
        brokenSource.finishRun(runID: missingRun, status: .completed, summary: "Missing-source callback")
        var completedObject = try JSONSerialization.jsonObject(with: Data(contentsOf: missingFile)) as! [String: Any]
        var completedTasks = completedObject["tasks"] as! [[String: Any]]
        for i in completedTasks.indices {
            var runs = completedTasks[i]["runs"] as! [[String: Any]]
            for j in runs.indices { runs[j].removeValue(forKey: "source") }
            completedTasks[i]["runs"] = runs
        }
        completedObject["tasks"] = completedTasks
        let oldRuns = try JSONDecoder().decode(WorkbenchState.self, from: JSONSerialization.data(withJSONObject: completedObject))
        try check(oldRuns.tasks[0].runs.count == 2 && oldRuns.tasks[0].runs.allSatisfy { $0.source == nil },
                  "legacy completed runs without typed source snapshots remain readable")
    }

    @MainActor static func testAcceptanceSnapshots(_ root: URL) throws {
        let file = root.appendingPathComponent("acceptance-snapshots.json")
        let store = WorkbenchStore(storageURL: file)
        let id = try ready(store, root: root)
        store.onRun = { _ in }
        let firstRun = try store.requestRun(taskID: id)
        let firstCriteria = store.state.tasks.first { $0.id == id }!.runs.last!.acceptance
        try rejected("running work cannot be accepted") { try store.verify(taskID: id, accepted: true, note: "Too early") }
        let firstArtifacts = [WorkbenchArtifact(title: "First report", location: root.appendingPathComponent("first.md").path, version: "first")]
        store.finishRun(runID: firstRun, status: .completed, summary: "First report", artifacts: firstArtifacts)
        var updated = store.state.tasks.first { $0.id == id }!
        updated.acceptance = "New criteria for a future revision"
        try store.updateDetails(updated)
        try store.verify(taskID: id, accepted: false, note: "First report needs supporting evidence")
        let returned = store.state.tasks.first { $0.id == id }!
        let firstRecord = returned.acceptanceRecords![0]
        try check(firstRecord.runID == firstRun && firstRecord.criteria == firstCriteria && firstRecord.artifacts == firstArtifacts
                  && !firstRecord.accepted && returned.events.last?.runID == firstRun,
                  "rejection records the actual run's criteria and full artifact snapshot, not edited future requirements")
        try prepare(store, taskID: id, root: root)
        let secondRun = try store.requestRun(taskID: id)
        let secondArtifacts = [
            WorkbenchArtifact(title: "Revised report", location: root.appendingPathComponent("second.md").path, version: "second"),
            WorkbenchArtifact(title: "Evidence", location: root.appendingPathComponent("evidence.json").path, version: "second")
        ]
        store.finishRun(runID: secondRun, status: .completed, summary: "Revised report with evidence", artifacts: secondArtifacts)
        try store.verify(taskID: id, accepted: true, note: "Matched revised criteria with both artifacts")
        let accepted = store.state.tasks.first { $0.id == id }!
        try check(accepted.acceptanceRecords?.count == 2 && accepted.acceptanceRecords?[0] == firstRecord
                  && accepted.acceptanceRecords?.last?.runID == secondRun
                  && accepted.acceptanceRecords?.last?.criteria == updated.acceptance
                  && accepted.acceptanceRecords?.last?.artifacts == secondArtifacts && accepted.acceptanceRecords?.last?.accepted == true
                  && accepted.events.last?.runID == secondRun,
                  "later acceptance binds the latest completed run while preserving the earlier rejection")
        try check(WorkbenchStore(storageURL: file).state == store.state,
                  "run-bound acceptance evidence survives persistence and reload")
        var object = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        var tasks = object["tasks"] as! [[String: Any]]
        tasks[0]["status"] = "awaitingAcceptance"; tasks[0]["runs"] = []
        object["tasks"] = tasks
        let noRunFile = root.appendingPathComponent("acceptance-no-run.json")
        try JSONSerialization.data(withJSONObject: object).write(to: noRunFile)
        let noRun = WorkbenchStore(storageURL: noRunFile)
        try rejected("a stale awaiting-acceptance flag cannot validate a task without a completed run") {
            try noRun.verify(taskID: id, accepted: true, note: "No execution evidence")
        }
        var failedLatest = accepted
        failedLatest.status = .awaitingAcceptance
        failedLatest.runs[failedLatest.runs.count - 1].status = .failed
        var malformed = store.state
        malformed.tasks = [failedLatest]
        let failedLatestFile = root.appendingPathComponent("acceptance-failed-latest.json")
        try JSONEncoder().encode(malformed).write(to: failedLatestFile)
        let failedStore = WorkbenchStore(storageURL: failedLatestFile)
        try rejected("an older completed run cannot mask the newest failed execution during acceptance") {
            try failedStore.verify(taskID: id, accepted: true, note: "Do not accept obsolete output")
        }
    }

    @MainActor static func migrationFixture() -> WorkbenchState {
        var state = WorkbenchState()
        state.sourceIdentityVersion = nil
        let projectID = UUID()
        let message = WorkbenchMessage(text: "Legacy model advice", evidence: .suggestion)
        let conversation = WorkbenchConversation(projectID: projectID, title: "Existing discussion", messages: [message])
        let typedSource = WorkbenchSource(kind: .hubConversation, threadID: UUID(), messageID: UUID(), evidence: .suggestion)
        let legacyLocation = "aihub://conversation/" + conversation.id.uuidString + "/message/" + message.id.uuidString
        let hubLocation = "aihub://conversation/" + typedSource.threadID.uuidString + "/message/" + typedSource.messageID.uuidString
        let unknownLocation = "aihub://conversation/" + UUID().uuidString + "/message/" + UUID().uuidString
        var setup = WorkbenchProjectSetup()
        setup.references = [
            WorkbenchReference(title: "Known Hub source", source: "AIHub", location: hubLocation),
            WorkbenchReference(title: "Unresolved Hub source", source: "AIHub", location: unknownLocation)
        ]
        state.projects = [WorkbenchProject(id: projectID, workspaceID: state.workspaces[0].id, name: "Existing project", setup: setup)]
        state.conversations = [conversation]
        var legacy = WorkbenchTask(projectID: projectID, title: "Legacy task", goal: "Existing goal")
        legacy.conversationID = conversation.id; legacy.sourceMessageID = message.id
        legacy.references = [WorkbenchReference(title: "Old source link", source: "AIHub", location: legacyLocation)]
        let plan = WorkbenchPlan(revision: 1, nodes: [WorkbenchNode(id: "legacy", title: "Old work", kind: .agent, agentID: "hermes")])
        legacy.plans = [plan]
        var completed = WorkbenchRun(id: UUID(), plan: plan, policy: WorkbenchPolicy(), startedAt: Date(timeIntervalSince1970: 1000),
            resumeFromRunID: nil, goal: legacy.goal, inputs: "", acceptance: "Old standard")
        completed.status = .completed; completed.finishedAt = Date(timeIntervalSince1970: 1010)
        legacy.runs = [completed]; legacy.status = .awaitingAcceptance
        var active = WorkbenchTask(projectID: projectID, title: "Interrupted Hub task", goal: "Existing typed goal")
        active.source = typedSource
        active.references = [WorkbenchReference(title: "Hub source", source: "AIHub", location: hubLocation)]
        var running = WorkbenchRun(id: UUID(), plan: plan, policy: WorkbenchPolicy(), startedAt: Date(timeIntervalSince1970: 1020),
            resumeFromRunID: nil, goal: active.goal, inputs: "", acceptance: "Pending standard")
        running.source = typedSource
        active.runs = [running]; active.status = .running
        var missing = WorkbenchTask(projectID: projectID, title: "Missing source message", goal: "Preserve identity")
        missing.conversationID = conversation.id; missing.sourceMessageID = UUID()
        state.tasks = [legacy, active, missing]
        return state
    }

    @MainActor static func testSourceIdentityMigration(_ root: URL) throws {
        let parent = root.appendingPathComponent("source-migration")
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        let file = parent.appendingPathComponent("workbench-v1.json")
        let original = migrationFixture()
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let originalBytes = try encoder.encode(original)
        try originalBytes.write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
        let migrationTime = Date(timeIntervalSince1970: 1_800_000_000)
        let migrated = WorkbenchStore(storageURL: file, now: { migrationTime })
        try check(migrated.errorMessage == nil && migrated.state.schemaVersion == 1 && migrated.state.sourceIdentityVersion == 1,
                  "legacy schema one migrates source identity without changing the schema version")
        let backups = parent.appendingPathComponent("Backups")
        let backupFiles = try FileManager.default.contentsOfDirectory(at: backups, includingPropertiesForKeys: nil)
        try check(backupFiles.count == 1 && backupFiles[0].lastPathComponent.range(
            of: #"^workbench-v1-source-v1-[0-9]{8}-[0-9]{6}-[0-9]{3}Z-[A-Fa-f0-9-]{36}\.json$"#, options: .regularExpression) != nil,
                  "migration creates a timestamped UUID backup before changing the source file")
        let savedBytes = try Data(contentsOf: backupFiles[0])
        let directoryMode = try FileManager.default.attributesOfItem(atPath: backups.path)[.posixPermissions] as? Int
        let backupMode = try FileManager.default.attributesOfItem(atPath: backupFiles[0].path)[.posixPermissions] as? Int
        let activeMode = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int
        try check(savedBytes == originalBytes && directoryMode == 0o700 && backupMode == 0o600 && activeMode == 0o600,
                  "backup preserves exact original bytes with private directory and file permissions")
        try check(migrated.state.workspaces.map(\.id) == original.workspaces.map(\.id)
                  && migrated.state.projects.map(\.id) == original.projects.map(\.id)
                  && migrated.state.conversations == original.conversations
                  && migrated.state.tasks.map(\.id) == original.tasks.map(\.id)
                  && migrated.state.tasks.flatMap { $0.runs.map(\.id) } == original.tasks.flatMap { $0.runs.map(\.id) }
                  && migrated.state.tasks.flatMap { $0.plans.map(\.id) } == original.tasks.flatMap { $0.plans.map(\.id) }
                  && migrated.state.tasks.flatMap { $0.references.map(\.id) } == original.tasks.flatMap { $0.references.map(\.id) },
                  "source migration retains workspace, project, conversation, message, task, plan, run and reference identities")
        let first = migrated.state.tasks[0]
        try check(first.source == WorkbenchSource(kind: .legacyConversation,
            threadID: original.conversations[0].id, messageID: original.conversations[0].messages[0].id, evidence: .suggestion)
            && migrated.state.tasks[2].source?.evidence == .unverified,
                  "known legacy evidence is preserved while missing-message evidence remains unverified")
        try check(first.references[0].location == first.source?.canonicalLocation
                  && migrated.state.tasks[1].source == original.tasks[1].source
                  && migrated.state.tasks[1].references[0].location == original.tasks[1].source?.canonicalLocation
                  && migrated.state.projects[0].setup?.references[0].location == original.tasks[1].source?.canonicalLocation
                  && migrated.state.projects[0].setup?.references[1].location == original.projects[0].setup?.references[1].location,
                  "only resolvable old links become typed canonical source links, including project references")
        try check(migrated.state.tasks[1].status == .interrupted && migrated.state.tasks[1].runs[0].status == .interrupted
                  && migrated.state.tasks[1].runs[0].finishedAt == migrationTime && migrated.onRun == nil
                  && migrated.state.tasks.allSatisfy { $0.lifecycle == $0.derivedLifecycle },
                  "migration and restart recovery commit together without replay and derive lifecycle from actual state")
        try check(migrated.state.tasks.flatMap(\.runs).allSatisfy { $0.runtime == nil && $0.form == nil }
                  && migrated.state.tasks.flatMap(\.references).allSatisfy { $0.recordedAt == nil },
                  "migration does not invent historical runtime, form or resource-recording evidence")
        let again = WorkbenchStore(storageURL: file)
        let afterReloadBackups = try FileManager.default.contentsOfDirectory(at: backups, includingPropertiesForKeys: nil)
        try check(again.state == migrated.state && afterReloadBackups == backupFiles,
                  "a successful source migration is idempotent and does not create another backup on reload")
        try check(!FileManager.default.fileExists(atPath: parent.appendingPathComponent("Control").path),
                  "source migration does not open or create the separate HubControl storage")
        let freshParent = root.appendingPathComponent("fresh-source-version")
        let fresh = WorkbenchStore(storageURL: freshParent.appendingPathComponent("state.json"))
        _ = try fresh.createProject(workspaceID: fresh.state.workspaces[0].id, name: "New data")
        try check(fresh.state.sourceIdentityVersion == 1
                  && !FileManager.default.fileExists(atPath: freshParent.appendingPathComponent("Backups").path),
                  "new storage starts at source identity version one without a migration backup")
    }

    @MainActor static func testSourceMigrationFailure(_ root: URL) throws {
        let parent = root.appendingPathComponent("blocked-source-migration")
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        let file = parent.appendingPathComponent("workbench-v1.json")
        let original = migrationFixture()
        let bytes = try JSONEncoder().encode(original)
        try bytes.write(to: file)
        let backupBlocker = parent.appendingPathComponent("Backups")
        let blockerBytes = Data("This is not a backup directory".utf8)
        try blockerBytes.write(to: backupBlocker)
        let blocked = WorkbenchStore(storageURL: file)
        try check(blocked.errorMessage != nil && blocked.state == original && blocked.state.tasks[1].status == .running,
                  "backup failure prevents both migration and restart-recovery mutation of the loaded records")
        try rejected("backup failure blocks all subsequent writes") {
            _ = try blocked.createTask(projectID: original.projects[0].id, goal: "Must not persist")
        }
        let after = try Data(contentsOf: file)
        let blockerAfter = try Data(contentsOf: backupBlocker)
        try check(after == bytes && blockerAfter == blockerBytes && blocked.state == original,
                  "a failed migration preserves source bytes, backup blocker and all loaded identities")
        try FileManager.default.removeItem(at: backupBlocker)
        let repaired = WorkbenchStore(storageURL: file)
        try check(repaired.errorMessage == nil && repaired.state.sourceIdentityVersion == 1
                  && repaired.state.tasks[1].status == .interrupted,
                  "migration is retried safely only after the backup location is repaired and storage is reopened")
    }

    @MainActor static func testPhaseOneMetadata(_ root: URL) throws {
        let file = root.appendingPathComponent("phase-one-metadata.json")
        let recordedAt = Date(timeIntervalSince1970: 1_800_000_001)
        let store = WorkbenchStore(storageURL: file, now: { recordedAt })
        let projectID = try store.createProject(workspaceID: store.state.workspaces[0].id, name: "Five-stage lifecycle fixture")
        let contextFile = root.appendingPathComponent("context-only-pointer.bin")
        try Data([0xFF, 0x00, 0x81]).write(to: contextFile)
        var project = store.selectedProject!
        var setup = WorkbenchProjectSetup()
        setup.contextFilePath = contextFile.path
        project.setup = setup
        try store.updateProject(project)
        let validProject = store.selectedProject!
        for path in [root.path, root.appendingPathComponent("missing-context.md").path, "relative-context.md"] {
            project.setup?.contextFilePath = path
            try rejected("context metadata rejects a directory, missing file or relative path") { try store.updateProject(project) }
        }
        try check(store.selectedProject == validProject, "invalid context pointers preserve the previous project metadata")
        try store.attachReference(source: "Web reference", location: "https://example.com/project")
        try store.attachReference(source: "Registered library", location: "zotero://select/library/items/ABCD2345")
        let projectReferences = store.selectedProject!.setup!.references
        try check(projectReferences.map(\.depth) == [.deepLink, .registered]
                  && projectReferences.allSatisfy { $0.recordedAt == recordedAt },
                  "new resources record the time and actual D1 or D2 capability without claiming API access")
        let taskID = try store.createTask(projectID: projectID, goal: "Offline lifecycle callback fixture")
        var task = store.selectedTask!
        try check(task.ownerType == .human && task.assigneeID == nil && task.tier == .interactive
                  && task.lifecycle == .inbox && task.inputs.isEmpty && task.policy.readRoots.isEmpty,
                  "a new task starts in inbox with human defaults and does not read or authorize the project context file")
        try rejected("a draft without a conclusion cannot be archived") { try store.archive(taskID: taskID) }
        task.lifecycle = .archived; task.status = .done
        task.ownerType = .agent; task.assigneeID = "hermes"; task.tier = .automatic
        task.acceptance = "The callback captures one fixed run and its final receipt"
        task.references = [WorkbenchReference(title: "Unverified API claim", source: "Manual input",
            location: "https://example.com/task", depth: .writeBack)]
        try store.updateDetails(task)
        try check(store.selectedTask?.status == .draft && store.selectedTask?.lifecycle == .inbox
                  && store.selectedTask?.ownerType == .agent && store.selectedTask?.assigneeID == "hermes"
                  && store.selectedTask?.tier == .automatic && store.selectedTask?.policy.confirmed == false
                  && store.selectedTask?.references.first?.depth == .deepLink && store.selectedTask?.references.first?.recordedAt == recordedAt,
                  "metadata edits persist ownership and intervention preference but cannot drag lifecycle, execute or fabricate API depth")
        let nodes = [WorkbenchNode(id: "deliver", title: "Offline callback", kind: .agent, agentID: "hermes")]
        try store.revisePlan(taskID: taskID, nodes: nodes)
        try check(store.selectedTask?.lifecycle == .decomposed, "adding a workflow derives decomposed lifecycle")
        try store.confirmPlan(taskID: taskID)
        try check(store.selectedTask?.lifecycle == .assigned && store.selectedTask?.runs.isEmpty == true,
                  "confirmed work is assigned without pretending a run already exists")
        var policy = WorkbenchPolicy(); policy.workingDirectory = root.path; policy.readRoots = [root.path]
        try store.updatePolicy(taskID: taskID, policy: policy, confirm: true)
        var request: WorkbenchRunRequest?
        store.onRun = { request = $0 }
        let runID = try store.requestRun(taskID: taskID)
        try check(request?.runtime == "acpx" && request?.form == .cli
                  && store.selectedTask?.runs.last?.runtime == "acpx" && store.selectedTask?.runs.last?.form == .cli
                  && store.selectedTask?.lifecycle == .assigned,
                  "new controlled run snapshots identify acpx CLI transport without claiming real model verification")
        store.finishRun(runID: runID, status: .completed, summary: "Offline callback receipt; no agent process",
            artifacts: [WorkbenchArtifact(title: "Callback evidence", location: root.appendingPathComponent("fixture-receipt.json").path)])
        try check(store.selectedTask?.lifecycle == .review, "completed execution moves to review and still requires acceptance")
        try store.verify(taskID: taskID, accepted: true, note: "Offline callback fields checked; not a real model result")
        try check(store.selectedTask?.lifecycle == .review, "acceptance retains review until an explicit archive operation")
        try store.archive(taskID: taskID)
        try check(store.selectedTask?.lifecycle == .archived
                  && store.selectedTask?.archiveConclusion == "Offline callback fields checked; not a real model result"
                  && store.selectedTask?.archivedAt == recordedAt,
                  "archive reaches the final lifecycle stage and persists its accepted conclusion and timestamp")
        let loaded = WorkbenchStore(storageURL: file)
        try check(loaded.state == store.state && loaded.state.projects.first?.setup?.contextFilePath == contextFile.path,
                  "context pointer, owner, assignee, tier, lifecycle, reference depth/time and run transport all persist")
        let proposed = proposal(projectID: projectID)
        try store.saveProposal(proposed)
        let acceptedID = try store.acceptProposal(proposed.id)
        let accepted = store.state.tasks.first { $0.id == acceptedID }!
        try check(accepted.ownerType == .agent && accepted.assigneeID == "hermes" && accepted.tier == .checkpoint
                  && accepted.lifecycle == .decomposed && !accepted.policy.confirmed
                  && accepted.references[0].location == proposed.source.canonicalLocation
                  && accepted.references[0].depth == .deepLink && accepted.references[0].recordedAt == recordedAt,
                  "accepted agent plans receive planning-based ownership defaults and typed D2 source references without authorization")
        var manual = proposal(projectID: projectID)
        manual.nodes = [WorkbenchNode(id: "manual", title: "Manual artifact", kind: .input)]
        try store.saveProposal(manual)
        let manualID = try store.acceptProposal(manual.id)
        try check(store.state.tasks.first { $0.id == manualID }?.ownerType == .human
                  && store.state.tasks.first { $0.id == manualID }?.assigneeID == nil
                  && store.state.tasks.first { $0.id == manualID }?.tier == .interactive,
                  "a proposal without an agent uses human defaults")
        try rejected("an explicitly empty archive conclusion is rejected instead of silently using fallback text") {
            try store.archive(taskID: manualID, conclusion: " \n")
        }
        try store.archive(taskID: manualID, conclusion: "Synthetic manual plan closed without execution")
        let archivedManual = WorkbenchStore(storageURL: file).state.tasks.first { $0.id == manualID }!
        try check(archivedManual.status == .archived && archivedManual.lifecycle == .archived
                  && archivedManual.archiveConclusion == "Synthetic manual plan closed without execution"
                  && archivedManual.archivedAt == recordedAt && archivedManual.runs.isEmpty && archivedManual.acceptanceRecords == nil,
                  "manual archive persists an explicit conclusion without inventing a run or acceptance record")
    }
}
