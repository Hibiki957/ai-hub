import Combine
import Foundation

@MainActor
final class WorkbenchStore: ObservableObject {
    struct StoreError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    @Published private(set) var state = WorkbenchState()
    @Published var selectedWorkspaceID: UUID?
    @Published var selectedProjectID: UUID?
    @Published var selectedTaskID: UUID?
    @Published var selectedAPIEndpointIDs: Set<UUID> = []
    @Published var selectedControlThreadID: UUID?
    @Published var selectedLegacyConversationID: UUID?
    @Published var selectedLibraryID = "eagle"
    /// 需求定版 #6：主视图为看板式大盘；工具栈降为组合池，仍在导航中可达。
    @Published var page: WorkbenchPage = .board
    @Published var errorMessage: String?
    var onRun: ((WorkbenchRunRequest) throws -> Void)?
    var onCancel: ((UUID) -> Void)?
    var onApproval: ((UUID, Bool) -> Void)?
    var onProposePlan: ((UUID) -> Void)?
    let preview: Bool
    let storageURL: URL
    private let now: () -> Date
    private var storageBlocked = false

    init(storageURL: URL? = nil, preview: Bool = false, now: @escaping () -> Date = Date.init) {
        self.preview = preview
        self.now = now
        self.storageURL = storageURL ?? URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Application Support/AIHub/workbench-v1.json")
        if !preview, FileManager.default.fileExists(atPath: self.storageURL.path) {
            do {
                let originalData = try Data(contentsOf: self.storageURL)
                var loaded = try JSONDecoder().decode(WorkbenchState.self, from: originalData)
                guard loaded.schemaVersion == 1 else { throw StoreError(message: "不支持的工作台数据版本") }
                guard loaded.sourceIdentityVersion == nil || loaded.sourceIdentityVersion == 1 else {
                    throw StoreError(message: "不支持的来源身份版本")
                }
                state = loaded
                let needsMigration = loaded.sourceIdentityVersion == nil
                if needsMigration {
                    try backupBeforeSourceMigration(originalData)
                    Self.normalizeSourceIdentity(&loaded)
                    loaded.sourceIdentityVersion = 1
                }
                var recovered = false
                for i in loaded.tasks.indices {
                    for j in loaded.tasks[i].runs.indices where !loaded.tasks[i].runs[j].status.terminal {
                        loaded.tasks[i].runs[j].status = .interrupted
                        loaded.tasks[i].runs[j].finishedAt = now()
                        loaded.tasks[i].runs[j].summary = "Hub 重启后尚未确认进程状态；不会自动重放"
                        loaded.tasks[i].status = .interrupted
                        recovered = true
                    }
                }
                if recovered || needsMigration {
                    try commit { state = loaded }
                }
            } catch {
                storageBlocked = true
                errorMessage = "工作台数据读取、迁移前备份或恢复失败，已停止写入以保留原文件：\(error.localizedDescription)"
            }
        }
        selectedWorkspaceID = state.workspaces.first?.id
    }

    /// Back up the exact bytes that were decoded, before any migration or
    /// restart recovery can overwrite them. An unusable backup location fails closed.
    private func backupBeforeSourceMigration(_ originalData: Data) throws {
        let manager = FileManager.default
        let directory = storageURL.deletingLastPathComponent().appendingPathComponent("Backups", isDirectory: true)
        try HubConfigurationOwnership.requireHubWrite(to: storageURL)
        try HubConfigurationOwnership.requireHubWrite(to: directory)
        if manager.fileExists(atPath: directory.path) {
            let attributes = try manager.attributesOfItem(atPath: directory.path)
            guard attributes[.type] as? FileAttributeType == .typeDirectory else {
                throw StoreError(message: "迁移备份位置必须是实际目录，不能是文件或软链接")
            }
        } else {
            try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd-HHmmss-SSS'Z'"
        let name = storageURL.deletingPathExtension().lastPathComponent + "-source-v1-"
            + formatter.string(from: now()) + "-" + UUID().uuidString + ".json"
        let destination = directory.appendingPathComponent(name)
        guard try Data(contentsOf: storageURL) == originalData else {
            throw StoreError(message: "工作台数据在备份前发生变化，请重新打开后迁移")
        }
        try manager.copyItem(at: storageURL, to: destination)
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
        guard try Data(contentsOf: destination) == originalData else {
            throw StoreError(message: "迁移备份内容校验失败，原文件未覆盖")
        }
    }

    private static func normalizeSourceIdentity(_ state: inout WorkbenchState) {
        for i in state.tasks.indices where state.tasks[i].source == nil {
            if let threadID = state.tasks[i].conversationID, let messageID = state.tasks[i].sourceMessageID {
                let evidence = state.conversations.first(where: { $0.id == threadID })?.messages.first(where: { $0.id == messageID })?.evidence ?? .unverified
                state.tasks[i].source = WorkbenchSource(kind: .legacyConversation, threadID: threadID, messageID: messageID, evidence: evidence)
            }
        }
        // Only identities known in this store are normalized. HubControl storage
        // is deliberately not opened, and ambiguous old links remain readable as-is.
        let known = state.tasks.compactMap(\.source)
            + state.tasks.flatMap { $0.runs.compactMap(\.source) }
            + (state.proposals ?? []).map(\.source)
            + state.conversations.flatMap { thread in
                thread.messages.map { WorkbenchSource(kind: .legacyConversation, threadID: thread.id, messageID: $0.id, evidence: $0.evidence) }
            }
        func normalized(_ references: [WorkbenchReference], preferred: WorkbenchSource? = nil) -> [WorkbenchReference] {
            references.map { reference in
                guard case let .hubConversation(threadID, messageID) = WorkbenchReferenceDestination.parse(reference.location) else { return reference }
                let matches = known.filter { $0.threadID == threadID && $0.messageID == messageID }
                let source: WorkbenchSource?
                if let preferred, preferred.threadID == threadID, preferred.messageID == messageID { source = preferred }
                else { source = Set(matches.map { $0.kind.rawValue }).count == 1 ? matches.first : nil }
                guard let source else { return reference }
                var result = reference
                result.location = source.canonicalLocation
                return result
            }
        }
        for i in state.tasks.indices {
            state.tasks[i].references = normalized(state.tasks[i].references, preferred: state.tasks[i].source)
        }
        for i in state.projects.indices {
            if let references = state.projects[i].setup?.references {
                state.projects[i].setup?.references = normalized(references)
            }
        }
    }

    var selectedTask: WorkbenchTask? { state.tasks.first { $0.id == selectedTaskID } }
    var selectedProject: WorkbenchProject? { state.projects.first { $0.id == selectedProjectID } }
    var scopedProjects: [WorkbenchProject] {
        state.projects.filter { selectedWorkspaceID == nil || $0.workspaceID == selectedWorkspaceID }
    }
    func isInScope(projectID: UUID) -> Bool {
        if let selectedProjectID { return projectID == selectedProjectID }
        return selectedWorkspaceID == nil || scopedProjects.contains { $0.id == projectID }
    }
    var scopedTasks: [WorkbenchTask] {
        state.tasks.filter { isInScope(projectID: $0.projectID) }
            .sorted { $0.priority == $1.priority ? $0.updatedAt > $1.updatedAt : $0.priority < $1.priority }
    }
    var visibleTasks: [WorkbenchTask] { scopedTasks.filter { $0.status != .archived } }
    var scopedConversations: [WorkbenchConversation] { state.conversations.filter { isInScope(projectID: $0.projectID) } }
    func selectProject(_ id: UUID?) {
        selectedTaskID = nil
        selectedProjectID = id
        if let project = state.projects.first(where: { $0.id == id }) { selectedWorkspaceID = project.workspaceID }
        page = id == nil ? .stack : .tasks
    }
    func selectWorkspace(_ id: UUID?) {
        selectedWorkspaceID = id; selectedProjectID = nil; selectedTaskID = nil; page = .stack
    }
    func selectTask(_ id: UUID, page: WorkbenchPage = .tasks) {
        guard let task = state.tasks.first(where: { $0.id == id }), let project = state.projects.first(where: { $0.id == task.projectID }) else { return }
        selectedWorkspaceID = project.workspaceID; selectedProjectID = project.id; selectedTaskID = id; self.page = page
    }
    @discardableResult func createWorkspace(name: String) throws -> UUID {
        let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { throw StoreError(message: "大主题名称不能为空") }
        let workspace = WorkbenchWorkspace(name: clean)
        try commit { state.workspaces.append(workspace) }
        selectWorkspace(workspace.id)
        return workspace.id
    }
    func updateProject(_ project: WorkbenchProject) throws {
        guard let i = state.projects.firstIndex(where: { $0.id == project.id }),
              state.workspaces.contains(where: { $0.id == project.workspaceID }),
              !project.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw StoreError(message: "项目名称或归属无效") }
        if let directory = project.setup?.directory, !directory.isEmpty {
            var isDirectory: ObjCBool = false
            guard directory.hasPrefix("/"), FileManager.default.fileExists(atPath: directory, isDirectory: &isDirectory), isDirectory.boolValue else {
                throw StoreError(message: "请选择已存在的项目目录；目录关联不会授予 Agent 权限")
            }
        }
        if let path = project.setup?.contextFilePath, !path.isEmpty {
            var isDirectory: ObjCBool = false
            guard path.hasPrefix("/"), FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), !isDirectory.boolValue else {
                throw StoreError(message: "项目上下文路径必须是已存在的文件；关联不会自动读取正文")
            }
        }
        var value = project
        if let references = value.setup?.references {
            let existing = Set((state.projects[i].setup?.references ?? []).map(\.id))
            value.setup?.references = references.map { existing.contains($0.id) ? $0 : recordedReference($0) }
        }
        try commit { state.projects[i] = value }
    }
    var todayTasks: [WorkbenchTask] {
        let end = Calendar.current.startOfDay(for: Date()).addingTimeInterval(86_400)
        return state.tasks.filter { ![.done, .archived, .cancelled].contains($0.status) && ($0.priority == 0 || ($0.deadline.map { $0 < end } ?? false)) }
    }
    var approvalTasks: [WorkbenchTask] { state.tasks.filter { [.awaitingApproval, .awaitingAcceptance].contains($0.status) || ($0.status == .draft && !$0.currentPlan.nodes.isEmpty) } }
    var runningTasks: [WorkbenchTask] { state.tasks.filter { $0.status.active } }
    var blockedTasks: [WorkbenchTask] { state.tasks.filter { [.blocked, .failed, .interrupted].contains($0.status) } }
    var dueTasks: [WorkbenchTask] { state.tasks.filter { ![.done, .archived, .cancelled].contains($0.status) && ($0.deadline.map { $0 < Date().addingTimeInterval(3 * 86_400) } ?? false) } }

    private func taskIndex(_ id: UUID) throws -> Int {
        guard let index = state.tasks.firstIndex(where: { $0.id == id }) else { throw StoreError(message: "任务不存在") }
        return index
    }
    private func persist() throws {
        guard !storageBlocked else { throw StoreError(message: "数据读取异常，禁止覆盖原工作台文件") }
        guard !preview else { return }
        try HubConfigurationOwnership.requireHubWrite(to: storageURL)
        try HubConfigurationOwnership.requireHubWrite(to: storageURL.deletingLastPathComponent())
        try FileManager.default.createDirectory(at: storageURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(state)
        try data.write(to: storageURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: storageURL.path)
    }
    private func commit(_ change: () throws -> Void) throws {
        let before = state
        do {
            try change()
            for i in state.tasks.indices { state.tasks[i].lifecycle = state.tasks[i].derivedLifecycle }
            try persist()
        } catch { state = before; throw error }
    }
    private func recordedReference(_ reference: WorkbenchReference) -> WorkbenchReference {
        var value = reference
        value.recordedAt = now()
        value.depth = WorkbenchReferenceDestination.parse(value.location) == nil ? .registered : .deepLink
        return value
    }
    private func applyOwnershipDefaults(_ task: inout WorkbenchTask) {
        let executor = task.currentPlan.nodes.first { $0.kind == .agent && !($0.agentID ?? "").isEmpty }?.agentID
        task.ownerType = executor == nil ? .human : .agent
        task.assigneeID = executor
        task.tier = executor == nil ? .interactive : .checkpoint
    }
    private func event(_ index: Int, _ kind: String, _ summary: String, runID: UUID? = nil, nodeID: String? = nil, evidence: WorkbenchEvidence = .userConfirmed) {
        state.tasks[index].events.append(WorkbenchEvent(runID: runID, nodeID: nodeID, kind: kind, summary: Self.redacted(summary), evidence: evidence))
        state.tasks[index].updatedAt = Date()
    }
    static func redacted(_ text: String) -> String {
        var result = text
        for pattern in ["(?i)(Bearer\\s+)[A-Za-z0-9._~+/-]+", "(?i)((?:api[_-]?key|access[_-]?token|secret|password)\\s*[:=]\\s*)[^\\s,;]+"] {
            if let expression = try? NSRegularExpression(pattern: pattern) {
                result = expression.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "$1[REDACTED]")
            }
        }
        return result
    }

    func renameWorkspace(_ id: UUID, name: String) throws {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, let i = state.workspaces.firstIndex(where: { $0.id == id }) else { throw StoreError(message: "工作区名称不能为空") }
        try commit { state.workspaces[i].name = value }
    }
    @discardableResult func createProject(workspaceID: UUID, name: String) throws -> UUID {
        guard state.workspaces.contains(where: { $0.id == workspaceID }), !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw StoreError(message: "请选择工作区并填写项目名称") }
        let project = WorkbenchProject(workspaceID: workspaceID, name: name)
        try commit { state.projects.append(project) }
        selectProject(project.id)
        return project.id
    }
    @discardableResult func createTask(projectID: UUID, goal: String, title: String? = nil) throws -> UUID {
        guard state.projects.contains(where: { $0.id == projectID }), !goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw StoreError(message: "任务需要主项目与明确目标") }
        var task = WorkbenchTask(projectID: projectID, title: title ?? String(goal.prefix(60)), goal: goal)
        applyOwnershipDefaults(&task)
        try commit { state.tasks.append(task) }
        selectedProjectID = projectID
        selectedTaskID = task.id
        return task.id
    }
    /// Drafts may be incomplete. Their source and identity remain immutable;
    /// accepting a proposal is the only operation that can bind it to a task.
    func saveProposal(_ proposal: WorkbenchProposal) throws {
        guard state.projects.contains(where: { $0.id == proposal.projectID }), proposal.revision > 0 else {
            throw StoreError(message: "方案所属项目或版本无效")
        }
        var proposals = state.proposals ?? []
        var value = proposal
        if let index = proposals.firstIndex(where: { $0.id == proposal.id }) {
            let existing = proposals[index]
            guard existing.acceptedTaskID == nil, existing.acceptedAt == nil else {
                throw StoreError(message: "已采纳方案不能修改，请建立新版本")
            }
            guard value.projectID == existing.projectID, value.source == existing.source,
                  value.previousProposalID == existing.previousProposalID, value.revision == existing.revision,
                  value.generationMessageID == existing.generationMessageID else {
                throw StoreError(message: "方案的来源、项目和版本身份不能通过编辑改变")
            }
            guard value.acceptedTaskID == nil, value.acceptedAt == nil else {
                throw StoreError(message: "请通过采纳方案建立任务关联")
            }
            value.createdAt = existing.createdAt
            value.updatedAt = now()
            proposals[index] = value
        } else {
            guard value.acceptedTaskID == nil, value.acceptedAt == nil else {
                throw StoreError(message: "新方案不能预先带有采纳记录")
            }
            if let previousID = value.previousProposalID {
                guard let previous = proposals.first(where: { $0.id == previousID }),
                      previous.projectID == value.projectID, previous.source == value.source,
                      value.revision == previous.revision + 1 else {
                    throw StoreError(message: "新版本须引用同项目、同来源的上一方案，且版本递增一次")
                }
            } else if value.revision != 1 {
                throw StoreError(message: "首版方案必须从版本 1 开始")
            }
            if value.previousProposalID == nil, let generationID = value.generationMessageID,
               proposals.contains(where: {
                   $0.previousProposalID == nil && $0.generationMessageID == generationID
                       && $0.source.threadID == value.source.threadID
               }) {
                throw StoreError(message: "这条生成回复已有原始方案，请打开现有方案或创建显式修订版本")
            }
            value.updatedAt = now()
            proposals.append(value)
        }
        try commit { state.proposals = proposals }
    }

    /// Task creation and the accepted proposal marker share one persisted commit.
    /// A repeated acceptance returns the original task without changing its state.
    @discardableResult func acceptProposal(_ id: UUID) throws -> UUID {
        guard let index = state.proposals?.firstIndex(where: { $0.id == id }),
              let proposal = state.proposals?[index] else { throw StoreError(message: "方案不存在") }
        if let taskID = proposal.acceptedTaskID {
            guard state.tasks.contains(where: { $0.id == taskID && $0.proposalID == id }) else {
                throw StoreError(message: "方案的任务关联不完整，请先恢复数据，不能重复创建")
            }
            return taskID
        }
        guard state.projects.contains(where: { $0.id == proposal.projectID }), proposal.acceptedAt == nil else {
            throw StoreError(message: "方案所属项目或采纳状态无效")
        }
        let errors = proposal.validationErrors
        guard errors.isEmpty else { throw StoreError(message: errors.joined(separator: "；")) }
        var task = WorkbenchTask(projectID: proposal.projectID, title: proposal.title, goal: proposal.goal)
        task.inputs = proposal.contextSnapshot
        task.deliverables = proposal.deliverables
        task.acceptance = proposal.acceptance
        task.constraints = proposal.constraints
        task.decisionSummary = proposal.summary
        task.plans = [WorkbenchPlan(revision: 1, summary: proposal.summary, nodes: proposal.nodes)]
        task.source = proposal.source
        task.proposalID = proposal.id
        if proposal.source.kind == .legacyConversation {
            task.conversationID = proposal.source.threadID
            task.sourceMessageID = proposal.source.messageID
        }
        applyOwnershipDefaults(&task)
        task.references.append(recordedReference(WorkbenchReference(title: "方案讨论来源", source: "AIHub",
            location: proposal.source.canonicalLocation)))
        try commit {
            state.tasks.append(task)
            state.proposals?[index].acceptedTaskID = task.id
            state.proposals?[index].acceptedAt = now()
            state.proposals?[index].updatedAt = now()
            event(state.tasks.count - 1, "proposal-accepted", "已采纳方案 v\(proposal.revision)；计划与执行权限仍待确认")
        }
        selectTask(task.id)
        return task.id
    }
    func attachReference(source: String, location: String) throws {
        let reference = recordedReference(WorkbenchReference(title: source + " 引用", source: source, location: location))
        if var task = selectedTask {
            guard !task.references.contains(where: { $0.source == source && $0.location == location }) else { throw StoreError(message: "该引用已关联") }
            task.references.append(reference); try updateDetails(task)
        } else if var project = selectedProject {
            var setup = project.setup ?? .init()
            guard !setup.references.contains(where: { $0.source == source && $0.location == location }) else { throw StoreError(message: "该引用已关联") }
            setup.references.append(reference); project.setup = setup; try updateProject(project)
        } else { throw StoreError(message: "请先选择项目或任务") }
    }
    func updateDetails(_ draft: WorkbenchTask) throws {
        let i = try taskIndex(draft.id)
        guard state.projects.contains(where: { $0.id == draft.projectID }), !draft.goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw StoreError(message: "任务目标和主项目不能为空") }
        try commit {
            let old = state.tasks[i]
            state.tasks[i].projectID = draft.projectID
            state.tasks[i].title = draft.title
            state.tasks[i].goal = draft.goal
            state.tasks[i].inputs = draft.inputs
            state.tasks[i].deliverables = draft.deliverables
            state.tasks[i].acceptance = draft.acceptance
            state.tasks[i].constraints = draft.constraints
            state.tasks[i].decisionSummary = draft.decisionSummary
            state.tasks[i].priority = draft.priority
            state.tasks[i].deadline = draft.deadline
            state.tasks[i].tags = draft.tags
            let existingReferences = Set(old.references.map(\.id))
            state.tasks[i].references = draft.references.map { existingReferences.contains($0.id) ? $0 : recordedReference($0) }
            state.tasks[i].linkedTaskIDs = draft.linkedTaskIDs.filter { $0 != draft.id }
            state.tasks[i].ownerType = draft.ownerType
            state.tasks[i].assigneeID = draft.assigneeID
            state.tasks[i].tier = draft.tier
            if old.goal != draft.goal || old.inputs != draft.inputs || old.acceptance != draft.acceptance || old.constraints != draft.constraints {
                state.tasks[i].confirmedRevision = nil
                state.tasks[i].policy.confirmed = false
            }
            event(i, "requirements", "任务要求已更新；已有运行快照保持不变")
        }
    }
    func revisePlan(taskID: UUID, nodes: [WorkbenchNode], summary: String = "") throws {
        let i = try taskIndex(taskID)
        try commit {
            let revision = state.tasks[i].currentPlan.revision + 1
            state.tasks[i].plans.append(WorkbenchPlan(revision: revision, summary: summary, nodes: nodes))
            state.tasks[i].confirmedRevision = nil
            if !state.tasks[i].status.active { state.tasks[i].status = .draft }
            event(i, "plan", "已创建计划 v\(revision)；新计划需要重新确认，运行中的版本不变")
        }
    }
    func confirmPlan(taskID: UUID) throws {
        let i = try taskIndex(taskID)
        let errors = state.tasks[i].currentPlan.validationErrors()
        guard errors.isEmpty else { throw StoreError(message: errors.joined(separator: "；")) }
        guard !state.tasks[i].acceptance.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw StoreError(message: "执行前需填写验收条件") }
        try commit {
            state.tasks[i].confirmedRevision = state.tasks[i].currentPlan.revision
            if !state.tasks[i].status.active { state.tasks[i].status = .ready }
            event(i, "plan-confirmed", "用户确认计划 v\(state.tasks[i].currentPlan.revision)")
        }
    }
    func updatePolicy(taskID: UUID, policy: WorkbenchPolicy, confirm: Bool = false) throws {
        let i = try taskIndex(taskID)
        if confirm {
            let errors = policy.validationErrors()
            guard errors.isEmpty else { throw StoreError(message: errors.joined(separator: "；")) }
        }
        try commit {
            var value = policy
            value.confirmed = confirm
            value.confirmedAt = confirm ? Date() : nil
            state.tasks[i].policy = value
            event(i, "policy", confirm ? "用户确认当前任务权限范围" : "权限草稿已更新，尚未授权")
        }
    }

    @discardableResult func requestRun(taskID: UUID, resumeFromRunID: UUID? = nil) throws -> UUID {
        guard !preview else { throw StoreError(message: "预览模式不会执行任务") }
        guard let onRun else { throw StoreError(message: "受控执行桥尚未连接，无法执行") }
        let i = try taskIndex(taskID)
        let task = state.tasks[i]
        guard !task.status.active, !task.runs.contains(where: { !$0.status.terminal }) else { throw StoreError(message: "该任务已有运行，不能重复提交") }
        guard task.status != .archived else { throw StoreError(message: "请先恢复归档任务") }
        guard task.confirmedRevision == task.currentPlan.revision, task.policy.confirmed else { throw StoreError(message: "请分别确认当前计划与权限") }
        let errors = task.currentPlan.validationErrors() + task.policy.validationErrors()
        guard errors.isEmpty else { throw StoreError(message: errors.joined(separator: "；")) }
        if let resumeFromRunID {
            guard let previous = task.runs.first(where: { $0.id == resumeFromRunID }), previous.status.terminal else { throw StoreError(message: "恢复来源无效或仍在运行") }
            guard !previous.plan.nodes.contains(where: { $0.sideEffect != .none }) else { throw StoreError(message: "此前计划含写入或外部动作，禁止自动重放；请核对实际结果后另建后续任务") }
        }
        let runID = UUID()
        var request = WorkbenchRunRequest(taskID: taskID, runID: runID, goal: task.goal, inputs: task.inputs,
                                          acceptance: task.acceptance, plan: task.currentPlan, policy: task.policy, resumeFromRunID: resumeFromRunID)
        request.constraints = task.constraints
        request.deliverables = task.deliverables
        request.references = task.references
        var source = task.source
        if source == nil, let conversationID = task.conversationID, let messageID = task.sourceMessageID {
            let evidence = state.conversations.first(where: { $0.id == conversationID })?.messages.first(where: { $0.id == messageID })?.evidence ?? .unverified
            source = WorkbenchSource(kind: .legacyConversation, threadID: conversationID, messageID: messageID, evidence: evidence)
        }
        request.source = source
        request.runtime = "acpx"
        request.form = .cli
        request.sourceConversationID = source?.threadID ?? task.conversationID
        request.sourceMessageID = source?.messageID ?? task.sourceMessageID
        request.decisionSummary = task.decisionSummary
        request.evidence = source?.evidence ?? .unverified
        var run = WorkbenchRun(id: runID, plan: request.plan, policy: request.policy, startedAt: Date(), resumeFromRunID: resumeFromRunID,
                               goal: request.goal, inputs: request.inputs, acceptance: request.acceptance)
        run.source = source
        run.runtime = request.runtime
        run.form = request.form
        try commit {
            state.tasks[i].runs.append(run)
            state.tasks[i].status = .running
            event(i, "run", "提交运行，固定计划 v\(request.plan.revision) 与授权快照", runID: runID)
        }
        do { try onRun(request) }
        catch {
            finishRun(runID: runID, status: .blocked, summary: error.localizedDescription)
            throw error
        }
        return runID
    }
    func cancel(taskID: UUID) throws {
        let i = try taskIndex(taskID)
        guard let run = state.tasks[i].runs.last(where: { !$0.status.terminal }), let onCancel else { throw StoreError(message: "没有可取消的 Hub 受控运行") }
        try commit {
            state.tasks[i].status = .cancelling
            if let j = state.tasks[i].runs.firstIndex(where: { $0.id == run.id }) { state.tasks[i].runs[j].status = .cancelling }
            event(i, "cancel-request", "已请求取消，等待执行桥确认进程退出", runID: run.id)
        }
        onCancel(run.id)
    }
    func reassign(taskID: UUID, nodeID: String, agentID: String) throws {
        let i = try taskIndex(taskID)
        var nodes = state.tasks[i].currentPlan.nodes
        guard let j = nodes.firstIndex(where: { $0.id == nodeID }) else { throw StoreError(message: "步骤不存在") }
        nodes[j].agentID = agentID
        try revisePlan(taskID: taskID, nodes: nodes, summary: "调整后续执行者")
    }
    func verify(taskID: UUID, accepted: Bool, note: String) throws {
        let i = try taskIndex(taskID)
        guard state.tasks[i].status == .awaitingAcceptance else { throw StoreError(message: "只有完成执行的任务才能验收") }
        guard let run = state.tasks[i].runs.last, run.status == .completed,
              !state.tasks[i].runs.contains(where: { !$0.status.terminal }) else {
            throw StoreError(message: "缺少可验收的最新已完成运行")
        }
        guard !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw StoreError(message: "请记录验收依据或退回原因") }
        try commit {
            state.tasks[i].status = accepted ? .done : .blocked
            state.tasks[i].acceptanceNote = note
            var records = state.tasks[i].acceptanceRecords ?? []
            records.append(WorkbenchAcceptanceRecord(runID: run.id, artifacts: run.artifacts, criteria: run.acceptance,
                                                     accepted: accepted, note: note, createdAt: now()))
            state.tasks[i].acceptanceRecords = records
            event(i, accepted ? "accepted" : "returned", note, runID: run.id)
        }
    }
    func archive(taskID: UUID, conclusion: String? = nil) throws {
        let i = try taskIndex(taskID)
        guard !state.tasks[i].status.active else { throw StoreError(message: "请先结束运行再归档") }
        let acceptedNote = state.tasks[i].acceptanceNote.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallback = acceptedNote.isEmpty ? state.tasks[i].decisionSummary : acceptedNote
        let finalConclusion = (conclusion ?? fallback).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !finalConclusion.isEmpty else { throw StoreError(message: "归档前请记录结论，说明已完成结果或停止原因") }
        try commit {
            state.tasks[i].status = .archived
            state.tasks[i].archiveConclusion = finalConclusion
            state.tasks[i].archivedAt = now()
            event(i, "archive", "任务已归档：" + finalConclusion)
        }
    }
    func restore(taskID: UUID) throws {
        let i = try taskIndex(taskID)
        guard state.tasks[i].status == .archived else { throw StoreError(message: "任务没有归档") }
        try commit {
            state.tasks[i].status = .draft
            state.tasks[i].confirmedRevision = nil
            state.tasks[i].policy.confirmed = false
            event(i, "restore", "从归档恢复；再次执行需重新确认计划与权限")
        }
        selectedTaskID = taskID
        selectedProjectID = state.tasks[i].projectID
    }
    func appendRunEvent(runID: UUID, kind: String, summary: String, nodeID: String? = nil) {
        guard let i = state.tasks.firstIndex(where: { $0.runs.contains { $0.id == runID } }) else { return }
        do { try commit { event(i, kind, summary, runID: runID, nodeID: nodeID, evidence: .unverified) } }
        catch { errorMessage = error.localizedDescription }
    }
    func finishRun(runID: UUID, status: WorkbenchRunStatus, summary: String, artifacts: [WorkbenchArtifact] = []) {
        guard status.terminal, let i = state.tasks.firstIndex(where: { $0.runs.contains { $0.id == runID } }),
              let j = state.tasks[i].runs.firstIndex(where: { $0.id == runID }), !state.tasks[i].runs[j].status.terminal else { return }
        do {
            try commit {
                state.tasks[i].runs[j].status = status
                state.tasks[i].runs[j].finishedAt = Date()
                state.tasks[i].runs[j].summary = Self.redacted(summary)
                state.tasks[i].runs[j].artifacts = artifacts
                for a in state.approvals.indices where state.approvals[a].runID == runID && state.approvals[a].resolvedAt == nil {
                    state.approvals[a].resolvedAt = Date()
                }
                switch status {
                case .completed: state.tasks[i].status = .awaitingAcceptance
                case .cancelled: state.tasks[i].status = .cancelled
                case .interrupted: state.tasks[i].status = .interrupted
                case .blocked: state.tasks[i].status = .blocked
                default: state.tasks[i].status = .failed
                }
                event(i, "run-\(status.rawValue)", summary, runID: runID, evidence: .unverified)
                if let conversationID = state.tasks[i].conversationID, let c = state.conversations.firstIndex(where: { $0.id == conversationID }) {
                    var message = WorkbenchMessage(text: "任务「\(state.tasks[i].title)」\(state.tasks[i].status.label)：\(Self.redacted(String(summary.prefix(500))))")
                    message.taskIDs = [state.tasks[i].id]
                    state.conversations[c].messages.append(message)
                }
            }
        } catch { errorMessage = error.localizedDescription }
    }
    @discardableResult func requestApproval(runID: UUID, nodeID: String? = nil, summary: String, details: String, expiresAt: Date? = nil) -> UUID? {
        let date = now()
        guard let expiresAt, expiresAt > date,
              let i = state.tasks.firstIndex(where: { $0.runs.contains { $0.id == runID && [.running, .awaitingApproval].contains($0.status) } }),
              let run = state.tasks[i].runs.first(where: { $0.id == runID }), run.policy.expiresAt.map({ $0 > date }) ?? true else { return nil }
        let deadline = min(expiresAt, run.policy.expiresAt ?? expiresAt)
        let approval = WorkbenchApproval(runID: runID, nodeID: nodeID, summary: Self.redacted(summary), details: Self.redacted(details), expiresAt: deadline)
        do {
            try commit {
                state.approvals.append(approval)
                state.tasks[i].status = .awaitingApproval
                if let j = state.tasks[i].runs.firstIndex(where: { $0.id == runID }) { state.tasks[i].runs[j].status = .awaitingApproval }
                event(i, "approval-request", summary, runID: runID, nodeID: nodeID, evidence: .unverified)
            }
            return approval.id
        } catch { errorMessage = error.localizedDescription; return nil }
    }
    func resolveApproval(_ id: UUID, allowed: Bool) throws {
        let date = now()
        guard let i = state.approvals.firstIndex(where: { $0.id == id }), state.approvals[i].resolvedAt == nil,
              state.approvals[i].expiresAt > date, let onApproval else { throw StoreError(message: "审批已失效或执行桥未连接") }
        let runID = state.approvals[i].runID
        guard let t = state.tasks.firstIndex(where: { $0.runs.contains { $0.id == runID && [.running, .awaitingApproval].contains($0.status) } }),
              let run = state.tasks[t].runs.first(where: { $0.id == runID }), run.policy.expiresAt.map({ $0 > date }) ?? true else { throw StoreError(message: "审批所属运行已结束、正在取消或授权已过期") }
        try commit {
            state.approvals[i].resolvedAt = Date()
            state.approvals[i].allowed = allowed
            let pending = state.approvals.contains { $0.runID == runID && $0.resolvedAt == nil }
            state.tasks[t].status = pending ? .awaitingApproval : .running
            if let j = state.tasks[t].runs.firstIndex(where: { $0.id == runID }) { state.tasks[t].runs[j].status = pending ? .awaitingApproval : .running }
            event(t, "approval", allowed ? "用户批准本次具体动作，向执行桥提交决定；执行结果仍待回执" : "用户拒绝本次具体动作，向执行桥提交决定", runID: runID)
        }
        onApproval(id, allowed)
    }

    @discardableResult func createConversation(projectID: UUID, title: String) throws -> UUID {
        guard state.projects.contains(where: { $0.id == projectID }) else { throw StoreError(message: "对话需关联项目") }
        let conversation = WorkbenchConversation(projectID: projectID, title: title)
        try commit { state.conversations.append(conversation) }
        return conversation.id
    }
    func appendMessage(conversationID: UUID, text: String, evidence: WorkbenchEvidence = .unverified) throws {
        guard let i = state.conversations.firstIndex(where: { $0.id == conversationID }), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw StoreError(message: "讨论内容不能为空") }
        try commit { state.conversations[i].messages.append(WorkbenchMessage(text: text, evidence: evidence)) }
    }
    @discardableResult func convertMessage(conversationID: UUID, messageID: UUID) throws -> UUID {
        guard let c = state.conversations.firstIndex(where: { $0.id == conversationID }),
              let m = state.conversations[c].messages.firstIndex(where: { $0.id == messageID }) else { throw StoreError(message: "讨论记录不存在") }
        let message = state.conversations[c].messages[m]
        var task = WorkbenchTask(projectID: state.conversations[c].projectID, title: String(message.text.prefix(60)), goal: message.text)
        task.conversationID = conversationID
        task.sourceMessageID = messageID
        task.source = WorkbenchSource(kind: .legacyConversation, threadID: conversationID, messageID: messageID, evidence: message.evidence)
        applyOwnershipDefaults(&task)
        task.decisionSummary = message.evidence == .userConfirmed ? message.text : "来自讨论，尚未确认执行方案"
        try commit { state.tasks.append(task); state.conversations[c].messages[m].taskIDs.append(task.id) }
        selectedTaskID = task.id
        selectedProjectID = task.projectID
        return task.id
    }
    func saveTemplate(taskID: UUID, name: String, updating templateID: UUID? = nil) throws {
        let i = try taskIndex(taskID)
        guard state.tasks[i].status == .done else { throw StoreError(message: "仅已验收流程可保存为成功模板") }
        guard !name.isEmpty else { throw StoreError(message: "模板名称不能为空") }
        try commit {
            guard let accepted = state.tasks[i].runs.last(where: { $0.status == .completed }) else { throw StoreError(message: "缺少已完成的运行版本") }
            var plan = accepted.plan
            plan.id = UUID()
            plan.createdAt = Date()
            if let templateID, let t = state.templates.firstIndex(where: { $0.id == templateID }) {
                plan.revision = state.templates[t].versions.count + 1
                state.templates[t].versions.append(plan)
            } else { plan.revision = 1; state.templates.append(WorkbenchTemplate(name: name, versions: [plan])) }
        }
    }
    func applyTemplate(taskID: UUID, templateID: UUID, version: Int) throws {
        guard let template = state.templates.first(where: { $0.id == templateID }), let plan = template.versions.first(where: { $0.revision == version }) else { throw StoreError(message: "模板版本不存在") }
        try revisePlan(taskID: taskID, nodes: plan.nodes, summary: "模板：\(template.name) v\(version)")
        let i = try taskIndex(taskID)
        try commit {
            let j = state.tasks[i].plans.count - 1
            state.tasks[i].plans[j].templateID = templateID
            state.tasks[i].plans[j].templateVersion = version
        }
    }
    func exportTask(_ id: UUID, to url: URL) throws {
        let i = try taskIndex(id)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(state.tasks[i]).write(to: url, options: .atomic)
    }
}
