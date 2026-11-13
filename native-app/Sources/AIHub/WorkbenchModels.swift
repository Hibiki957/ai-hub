import Foundation
import SwiftUI

struct WorkbenchWorkspace: Codable, Identifiable, Equatable {
    var id = UUID()
    var name: String
    var detail: String = ""
    static let suggestions = ["学业与研究", "求职与职业发展", "创作与产品", "兼职与交付", "学习与探索"]
}

enum WorkbenchOwnerType: String, Codable, CaseIterable {
    case human, agent
    var label: String { self == .human ? "本人" : "Agent" }
}
enum WorkbenchInterventionTier: String, Codable, CaseIterable {
    case interactive, checkpoint, automatic
    var label: String {
        switch self { case .interactive: return "全程交互"; case .checkpoint: return "关键节点确认"; case .automatic: return "全自动回收" }
    }
}
enum WorkbenchToolForm: String, Codable, CaseIterable {
    case tui, cli, desktop, api, web
    var label: String { rawValue == "desktop" ? "Desktop" : rawValue.uppercased() }
}
enum WorkbenchTaskLifecycle: String, Codable, CaseIterable {
    case inbox, decomposed, assigned, review, archived
    var label: String {
        switch self {
        case .inbox: return "收集箱"; case .decomposed: return "已拆解"; case .assigned: return "已派活"
        case .review: return "交付验收"; case .archived: return "已归档"
        }
    }
}
enum WorkbenchResourceDepth: String, Codable, CaseIterable {
    case registered = "D1", deepLink = "D2", readOnlyAPI = "D3", writeBack = "D4"
    var label: String {
        switch self { case .registered: return "仅登记"; case .deepLink: return "可定位"; case .readOnlyAPI: return "只读 API"; case .writeBack: return "双向写回" }
    }
}

struct WorkbenchProject: Codable, Identifiable, Equatable {
    var id = UUID()
    var workspaceID: UUID
    var name: String
    var detail = ""
    var setup: WorkbenchProjectSetup? = nil
}

enum WorkbenchProjectKind: String, Codable, CaseIterable {
    case general, research, development, design, career, delivery
    var label: String {
        switch self {
        case .general: return "通用"; case .research: return "学业与研究"; case .development: return "开发与构建"
        case .design: return "游戏与设计"; case .career: return "求职与职业"; case .delivery: return "兼职与交付"
        }
    }
}

/// Presentation preferences are never execution permissions or API credentials.
struct WorkbenchProjectSetup: Codable, Equatable {
    var kind: WorkbenchProjectKind = .general
    var directory = ""
    var familyIDs: [String]? = nil
    var tiers: [String: String] = [:]
    var preferredVariants: [String: String] = [:]
    var discussionFamilyIDs: [String] = []
    var summary = ""
    var references: [WorkbenchReference] = []
    var coordinatorEndpointID: UUID? = nil
    var defaultExecutorID: String? = nil
    var contextFilePath: String? = nil
}

/// A typed, persisted source. Suggestions never gain user-confirmed evidence by fallback.
struct WorkbenchSource: Codable, Equatable {
    enum Kind: String, Codable { case legacyConversation, hubConversation }
    var kind: Kind
    var threadID: UUID
    var messageID: UUID
    var evidence: WorkbenchEvidence = .unverified
    var canonicalLocation: String { "aihub://source/" + kind.rawValue + "/" + threadID.uuidString + "/" + messageID.uuidString }
}

struct WorkbenchProposal: Codable, Identifiable, Equatable {
    var id = UUID()
    var projectID: UUID
    var source: WorkbenchSource
    var title: String
    var goal: String
    var deliverables = ""
    var acceptance = ""
    var constraints = ""
    var contextSnapshot = ""
    var summary = ""
    var nodes: [WorkbenchNode] = []
    var coordinatorEndpointID: UUID? = nil
    var generationMessageID: UUID? = nil
    var previousProposalID: UUID? = nil
    var revision = 1
    var createdAt = Date()
    var updatedAt = Date()
    var acceptedTaskID: UUID? = nil
    var acceptedAt: Date? = nil

    var validationErrors: [String] {
        var errors = WorkbenchPlan(revision: revision, nodes: nodes).validationErrors()
        if title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { errors.append("方案标题不能为空") }
        if goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { errors.append("方案目标不能为空") }
        if deliverables.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { errors.append("请明确交付物") }
        if acceptance.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { errors.append("请明确验收标准") }
        if nodes.count > 24 { errors.append("方案最多 24 个步骤") }
        if contextSnapshot.utf8.count > 32_768 { errors.append("任务上下文上限 32 KiB") }
        for (label, value) in [("目标", goal), ("交付物", deliverables), ("验收标准", acceptance), ("限制", constraints), ("方案说明", summary)] {
            if value.utf8.count > 32_768 { errors.append(label + "上限 32 KiB") }
        }
        for node in nodes {
            if node.prompt.utf8.count > 32_768 { errors.append(node.title + "：步骤要求上限 32 KiB") }
        }
        return errors
    }
}

struct WorkbenchAcceptanceRecord: Codable, Identifiable, Equatable {
    var id = UUID()
    var runID: UUID
    var artifacts: [WorkbenchArtifact]
    var criteria: String
    var accepted: Bool
    var note: String
    var createdAt = Date()
}

enum WorkbenchPage: String, CaseIterable {
    case stack, discussion, tasks, workflow, board, archive, resources, capabilities, network, control
    /// v2.1/v2.2 decision: six global destinations; no artificial progress numbers.
    static let primaryPages: [WorkbenchPage] = [.stack, .discussion, .tasks, .workflow, .board, .archive]
    var primaryPage: WorkbenchPage? { Self.primaryPages.contains(self) ? self : nil }
    /// 支撑页：资源库接入、Skill/MCP、服务调度、网络环境
    static let utilityPages: [WorkbenchPage] = [.resources, .capabilities, .control, .network]
    var label: String {
        switch self {
        case .stack: return "工具栈"; case .discussion: return "统一对话"; case .tasks: return "拆解任务"
        case .workflow: return "工作流"; case .board: return "待办与进度"; case .archive: return "总结归档"
        case .control: return "服务与调度"; case .resources: return "资料库接入"; case .capabilities: return "Skill / MCP"; case .network: return "网络与环境"
        }
    }
    var symbol: String {
        switch self {
        case .stack: return "square.stack.3d.up"; case .discussion: return "bubble.left.and.bubble.right"
        case .tasks: return "list.bullet.rectangle"; case .workflow: return "point.3.connected.trianglepath.dotted"
        case .board: return "rectangle.split.3x1"; case .archive: return "archivebox"
        case .control: return "bubble.left.and.text.bubble.right"; case .resources: return "books.vertical"; case .capabilities: return "puzzlepiece.extension"; case .network: return "network"
        }
    }
}

enum WorkbenchEvidence: String, Codable, CaseIterable {
    case userConfirmed, suggestion, unverified
    var label: String { switch self { case .userConfirmed: return "用户确认"; case .suggestion: return "建议"; case .unverified: return "未验证" } }
}

struct WorkbenchMessage: Codable, Identifiable, Equatable {
    var id = UUID()
    var text: String
    var evidence: WorkbenchEvidence = .unverified
    var createdAt = Date()
    var taskIDs: [UUID] = []
}

struct WorkbenchConversation: Codable, Identifiable, Equatable {
    var id = UUID()
    var projectID: UUID
    var title: String
    var messages: [WorkbenchMessage] = []
    var createdAt = Date()
}

struct WorkbenchReference: Codable, Identifiable, Equatable {
    var id = UUID()
    var title: String
    var source: String
    var location: String
    var note = ""
    var depth: WorkbenchResourceDepth? = nil
    var recordedAt: Date? = nil
    var effectiveDepth: WorkbenchResourceDepth { depth ?? (WorkbenchReferenceDestination.parse(location) == nil ? .registered : .deepLink) }
}

/// These are user-initiated presentation actions, never task execution.
enum WorkbenchReferenceDestination: Equatable {
    case revealFile(URL)
    case openHTTPS(URL)
    case hubConversation(UUID, UUID)
    case sourceConversation(WorkbenchSource.Kind, UUID, UUID)

    static func parse(_ location: String) -> WorkbenchReferenceDestination? {
        let value = location.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        if value.hasPrefix("/") || value.hasPrefix("~/") {
            return .revealFile(URL(fileURLWithPath: (value as NSString).expandingTildeInPath).standardizedFileURL)
        }
        guard let components = URLComponents(string: value), let url = components.url else { return nil }
        if components.scheme == "aihub", components.host == "source", components.user == nil, components.password == nil,
           components.query == nil, components.fragment == nil, components.port == nil {
            let segments = url.pathComponents.filter { $0 != "/" }
            if segments.count == 3, let kind = WorkbenchSource.Kind(rawValue: segments[0]),
               let thread = UUID(uuidString: segments[1]), let message = UUID(uuidString: segments[2]) {
                return .sourceConversation(kind, thread, message)
            }
            return nil
        }
        if components.scheme == "aihub", components.host == "conversation", components.user == nil, components.password == nil,
           components.query == nil, components.fragment == nil, components.port == nil {
            let segments = url.pathComponents.filter { $0 != "/" }
            if segments.count == 3, segments[1] == "message", let thread = UUID(uuidString: segments[0]), let message = UUID(uuidString: segments[2]) { return .hubConversation(thread, message) }
            return nil
        }
        if components.scheme?.lowercased() == "file", (components.host ?? "").isEmpty || components.host == "localhost",
           components.user == nil, components.password == nil, components.query == nil, components.fragment == nil,
           url.isFileURL, url.path.hasPrefix("/") { return .revealFile(url.standardizedFileURL) }
        if components.scheme?.lowercased() == "https", let host = components.host, !host.isEmpty,
           components.user == nil, components.password == nil { return .openHTTPS(url) }
        return nil
    }
}

enum WorkbenchTaskStatus: String, Codable, CaseIterable {
    case draft, ready, running, awaitingApproval, cancelling, blocked, failed, interrupted, awaitingAcceptance, done, cancelled, archived
    var label: String {
        switch self {
        case .draft: return "草稿"; case .ready: return "待执行"; case .running: return "执行中"
        case .awaitingApproval: return "等待确认"; case .cancelling: return "取消中"; case .blocked: return "阻塞"
        case .failed: return "失败"; case .interrupted: return "待恢复"; case .awaitingAcceptance: return "待验收"
        case .done: return "已验收"; case .cancelled: return "已取消"; case .archived: return "已归档"
        }
    }
    var active: Bool { [.running, .awaitingApproval, .cancelling].contains(self) }
    // 注意：本文件会被数据层检查脚本独立编译，颜色必须与 HubTheme 同步但用字面量，不能引用 HubTheme。
    var tint: Color {
        switch self {
        case .draft, .ready, .archived: return Color(red: 105/255, green: 113/255, blue: 120/255) // textTertiary
        case .running, .cancelling: return Color(red: 34/255, green: 109/255, blue: 96/255) // accent
        case .awaitingApproval, .awaitingAcceptance: return Color(red: 138/255, green: 91/255, blue: 25/255) // warning
        case .blocked, .failed, .interrupted, .cancelled: return Color(red: 178/255, green: 81/255, blue: 97/255) // danger
        case .done: return Color(red: 46/255, green: 125/255, blue: 91/255) // success
        }
    }
}

enum WorkbenchNodeKind: String, Codable, CaseIterable {
    case input, agent, tool, approval, condition, parallel, join, output
    var label: String {
        switch self {
        case .input: return "输入"; case .agent: return "Agent"; case .tool: return "工具"; case .approval: return "人工审批"
        case .condition: return "条件"; case .parallel: return "并行"; case .join: return "汇合"; case .output: return "输出"
        }
    }
}

enum WorkbenchSideEffect: String, Codable, CaseIterable {
    case none, local, external
    var label: String { switch self { case .none: return "无副作用"; case .local: return "本地写入"; case .external: return "外部动作" } }
}

struct WorkbenchNode: Codable, Identifiable, Equatable {
    var id: String = UUID().uuidString
    var title: String = "新步骤"
    var kind: WorkbenchNodeKind = .agent
    var dependsOn: [String] = []
    var agentID: String? = nil
    var model: String? = nil
    var prompt: String = ""
    var command: String? = nil
    var arguments: [String] = []
    var timeoutMs = 120_000
    var retries = 0
    var sideEffect: WorkbenchSideEffect = .none
    var condition: String? = nil
    var acceptance = ""
    var role = "执行者"
}

struct WorkbenchPlan: Codable, Identifiable, Equatable {
    var id = UUID()
    var revision: Int
    var summary: String = ""
    var nodes: [WorkbenchNode] = []
    var createdAt = Date()
    var templateID: UUID? = nil
    var templateVersion: Int? = nil

    func validationErrors() -> [String] {
        var errors: [String] = []
        let ids = Set(nodes.map(\.id))
        if nodes.isEmpty { errors.append("计划至少需要一个步骤") }
        if ids.count != nodes.count || nodes.contains(where: { $0.id.isEmpty }) { errors.append("步骤标识重复或为空") }
        for node in nodes {
            if node.id.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$", options: .regularExpression) == nil { errors.append("步骤 ID 仅支持 1–80 位字母、数字、下划线与连字符") }
            if Set(node.dependsOn).count != node.dependsOn.count { errors.append(node.title + "：依赖不能重复") }
            if node.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { errors.append("步骤名称不能为空") }
            if node.dependsOn.contains(node.id) || !Set(node.dependsOn).isSubset(of: ids) { errors.append("\(node.title)：依赖不存在或依赖自身") }
            if node.kind == .agent && (node.agentID ?? "").isEmpty { errors.append("\(node.title)：尚未指定 Agent") }
            if node.kind == .tool && (node.command ?? "").isEmpty { errors.append("\(node.title)：尚未指定工具命令") }
            if !(1000...1_800_000).contains(node.timeoutMs) || !(0...2).contains(node.retries) { errors.append("\(node.title)：超时须为 1–1800 秒，重试须为 0–2 次") }
            if node.sideEffect != .none && node.retries > 0 { errors.append("\(node.title)：有副作用的动作不能自动重试") }
        }
        var remaining = nodes
        var resolved = Set<String>()
        while !remaining.isEmpty {
            let ready = remaining.filter { Set($0.dependsOn).isSubset(of: resolved) }
            if ready.isEmpty { errors.append("依赖图存在循环或缺失依赖"); break }
            resolved.formUnion(ready.map(\.id))
            remaining.removeAll { resolved.contains($0.id) }
        }
        return errors
    }
}

struct WorkbenchPolicy: Codable, Equatable {
    var workingDirectory = ""
    var readRoots: [String] = []
    var writeRoots: [String] = []
    var allowedCommands: [String] = []
    var allowedTools: [String] = []
    var networkHosts: [String] = []
    var privacy = "local"
    var budgetUSD: Double? = nil
    var maxParallel = 1
    var executionIsolation = "macos-seatbelt"
    var confirmed = false
    var confirmedAt: Date? = nil
    var expiresAt: Date? = nil

    func validationErrors(at date: Date = Date()) -> [String] {
        var errors: [String] = []
        if !workingDirectory.hasPrefix("/") { errors.append("请指定绝对工作目录") }
        if (readRoots + writeRoots).contains(where: { !$0.hasPrefix("/") || $0 == "/" }) { errors.append("目录授权需使用具体绝对路径，不能授予整个根目录") }
        if !["local", "approved-cloud"].contains(privacy) { errors.append("隐私策略无效") }
        if executionIsolation != "macos-seatbelt" { errors.append("执行隔离方式未受支持") }
        if maxParallel < 1 || maxParallel > 8 { errors.append("并发数量范围为 1–8") }
        if let budgetUSD, !budgetUSD.isFinite || budgetUSD < 0 { errors.append("预算无效") }
        if let expiresAt, expiresAt <= date { errors.append("任务授权已过期") }
        return errors
    }
}

extension WorkbenchPolicy {
    private enum CodingKeys: String, CodingKey {
        case workingDirectory, readRoots, writeRoots, allowedCommands, allowedTools, networkHosts
        case privacy, budgetUSD, maxParallel, executionIsolation, confirmed, confirmedAt, expiresAt
    }
    static func expiryDate(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: text)
    }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(workingDirectory, forKey: .workingDirectory)
        try container.encode(readRoots, forKey: .readRoots)
        try container.encode(writeRoots, forKey: .writeRoots)
        try container.encode(allowedCommands, forKey: .allowedCommands)
        try container.encode(allowedTools, forKey: .allowedTools)
        try container.encode(networkHosts, forKey: .networkHosts)
        try container.encode(privacy, forKey: .privacy)
        try container.encodeIfPresent(budgetUSD, forKey: .budgetUSD)
        try container.encode(maxParallel, forKey: .maxParallel)
        try container.encode(executionIsolation, forKey: .executionIsolation)
        try container.encode(confirmed, forKey: .confirmed)
        try container.encodeIfPresent(confirmedAt, forKey: .confirmedAt)
        if let expiresAt {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            try container.encode(formatter.string(from: expiresAt), forKey: .expiresAt)
        }
    }
    init(from decoder: Decoder) throws {
        self.init()
        let container = try decoder.container(keyedBy: CodingKeys.self)
        workingDirectory = try container.decode(String.self, forKey: .workingDirectory)
        readRoots = try container.decode([String].self, forKey: .readRoots)
        writeRoots = try container.decode([String].self, forKey: .writeRoots)
        allowedCommands = try container.decode([String].self, forKey: .allowedCommands)
        allowedTools = try container.decode([String].self, forKey: .allowedTools)
        networkHosts = try container.decode([String].self, forKey: .networkHosts)
        privacy = try container.decode(String.self, forKey: .privacy)
        budgetUSD = try container.decodeIfPresent(Double.self, forKey: .budgetUSD)
        maxParallel = try container.decode(Int.self, forKey: .maxParallel)
        executionIsolation = try container.decode(String.self, forKey: .executionIsolation)
        confirmed = try container.decode(Bool.self, forKey: .confirmed)
        confirmedAt = try container.decodeIfPresent(Date.self, forKey: .confirmedAt)
        if let text = try? container.decode(String.self, forKey: .expiresAt) {
            guard let date = Self.expiryDate(text) else { throw DecodingError.dataCorruptedError(forKey: .expiresAt, in: container, debugDescription: "Invalid ISO expiry") }
            expiresAt = date
        } else {
            // Read v1 files saved before the wire protocol required ISO dates.
            expiresAt = try container.decodeIfPresent(Date.self, forKey: .expiresAt)
        }
    }
}

enum WorkbenchRunStatus: String, Codable {
    case running, awaitingApproval, cancelling, completed, failed, cancelled, interrupted, blocked
    var terminal: Bool { ![.running, .awaitingApproval, .cancelling].contains(self) }
}

struct WorkbenchArtifact: Codable, Identifiable, Equatable {
    var id = UUID()
    var title: String
    var location: String
    var version: String = "1"
    var verification = "未验证"
}

struct WorkbenchEvent: Codable, Identifiable, Equatable {
    var id = UUID()
    var createdAt = Date()
    var runID: UUID? = nil
    var nodeID: String? = nil
    var kind: String
    var summary: String
    var evidence: WorkbenchEvidence = .unverified
}

struct WorkbenchRun: Codable, Identifiable, Equatable {
    let id: UUID
    let plan: WorkbenchPlan
    let policy: WorkbenchPolicy
    let startedAt: Date
    let resumeFromRunID: UUID?
    let goal: String
    let inputs: String
    let acceptance: String
    var status: WorkbenchRunStatus = .running
    var finishedAt: Date? = nil
    var summary = ""
    var artifacts: [WorkbenchArtifact] = []
    var source: WorkbenchSource? = nil
    var runtime: String? = nil
    var form: WorkbenchToolForm? = nil
}

struct WorkbenchTask: Codable, Identifiable, Equatable {
    var id = UUID()
    var projectID: UUID
    var title: String
    var goal: String
    var inputs = ""
    var deliverables = ""
    var acceptance = ""
    var constraints = ""
    var decisionSummary = ""
    var priority = 2
    var deadline: Date? = nil
    var tags: [String] = []
    var references: [WorkbenchReference] = []
    var linkedTaskIDs: [UUID] = []
    var conversationID: UUID? = nil
    var sourceMessageID: UUID? = nil
    var createdAt = Date()
    var updatedAt = Date()
    var status: WorkbenchTaskStatus = .draft
    var plans: [WorkbenchPlan] = [WorkbenchPlan(revision: 1)]
    var confirmedRevision: Int? = nil
    var policy = WorkbenchPolicy()
    var runs: [WorkbenchRun] = []
    var events: [WorkbenchEvent] = []
    var acceptanceNote = ""
    var source: WorkbenchSource? = nil
    var proposalID: UUID? = nil
    var acceptanceRecords: [WorkbenchAcceptanceRecord]? = nil
    var archiveConclusion: String? = nil
    var archivedAt: Date? = nil
    var ownerType: WorkbenchOwnerType? = nil
    var assigneeID: String? = nil
    var tier: WorkbenchInterventionTier? = nil
    var lifecycle: WorkbenchTaskLifecycle? = nil
    var effectiveOwnerType: WorkbenchOwnerType { ownerType ?? (currentPlan.nodes.contains { $0.kind == .agent } ? .agent : .human) }
    var effectiveTier: WorkbenchInterventionTier { tier ?? .checkpoint }
    var derivedLifecycle: WorkbenchTaskLifecycle {
        if status == .archived { return .archived }
        if status == .awaitingAcceptance || status == .done { return .review }
        if !runs.isEmpty || status == .ready { return .assigned }
        return currentPlan.nodes.isEmpty ? .inbox : .decomposed
    }
    var effectiveLifecycle: WorkbenchTaskLifecycle { derivedLifecycle }
    var currentPlan: WorkbenchPlan { plans.last ?? WorkbenchPlan(revision: 1) }
}

struct WorkbenchApproval: Codable, Identifiable, Equatable {
    var id = UUID()
    var runID: UUID
    var nodeID: String?
    var summary: String
    var details: String
    var createdAt = Date()
    var expiresAt: Date
    var resolvedAt: Date? = nil
    var allowed: Bool? = nil
}

struct WorkbenchTemplate: Codable, Identifiable, Equatable {
    var id = UUID()
    var name: String
    var versions: [WorkbenchPlan]
    var createdAt = Date()
}

struct WorkbenchState: Codable, Equatable {
    var schemaVersion = 1
    var workspaces: [WorkbenchWorkspace] = WorkbenchWorkspace.suggestions.map { WorkbenchWorkspace(name: $0) }
    var projects: [WorkbenchProject] = []
    var conversations: [WorkbenchConversation] = []
    var tasks: [WorkbenchTask] = []
    var templates: [WorkbenchTemplate] = []
    var approvals: [WorkbenchApproval] = []
    var proposals: [WorkbenchProposal]? = nil
    var sourceIdentityVersion: Int? = 1
}

struct WorkbenchRunRequest: Codable {
    var schemaVersion = 1
    let taskID: UUID
    let runID: UUID
    let goal: String
    var inputs: String
    let acceptance: String
    let plan: WorkbenchPlan
    let policy: WorkbenchPolicy
    let resumeFromRunID: UUID?
    var constraints = ""
    var deliverables = ""
    var references: [WorkbenchReference] = []
    var evidence: WorkbenchEvidence = .unverified
    var sourceConversationID: UUID? = nil
    var sourceMessageID: UUID? = nil
    var decisionSummary = ""
    var source: WorkbenchSource? = nil
    var runtime: String? = nil
    var form: WorkbenchToolForm? = nil
}
