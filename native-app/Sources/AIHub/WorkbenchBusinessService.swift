import Foundation

/// Coordinates business commands; durable proposal/task mutations belong to the
/// Workbench store. Conversation results are projections of those same records,
/// so a crash cannot leave an independently copied result card out of sync.
@MainActor
struct WorkbenchBusinessService {
    let workbench: WorkbenchStore
    let control: HubControlStore
    let executorIDs: [String]

    private func source(threadID: UUID, messageID: UUID) throws -> (HubChatThread, HubChatMessage, WorkbenchSource) {
        guard let thread = control.state.threads.first(where: { $0.id == threadID }),
              let projectID = thread.projectID,
              workbench.state.projects.contains(where: { $0.id == projectID }),
              let message = thread.messages.first(where: { $0.id == messageID && $0.status == "completed" }),
              !message.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw HubGatewayError(message: "请选择项目中已保存的有效来源消息")
        }
        if let taskID = thread.taskID {
            guard workbench.state.tasks.contains(where: { $0.id == taskID && $0.projectID == projectID }) else {
                throw HubGatewayError(message: "来源会话的任务与项目不一致")
            }
        }
        return (thread, message, WorkbenchSource(kind: .hubConversation, threadID: threadID, messageID: messageID,
                                               evidence: message.role == "user" ? .userConfirmed : .suggestion))
    }

    func draftProposal(threadID: UUID, messageID: UUID, context: String) throws -> WorkbenchProposal {
        let (thread, message, origin) = try source(threadID: threadID, messageID: messageID)
        guard context.utf8.count <= 32_768 else { throw HubGatewayError(message: "任务上下文上限 32 KiB，请减少共享内容") }
        if let existing = workbench.state.proposals?.last(where: { $0.source == origin && $0.generationMessageID == nil && $0.acceptedTaskID == nil }) { return existing }
        var proposal = WorkbenchProposal(projectID: thread.projectID!, source: origin,
                                        title: String(message.content.prefix(60)), goal: message.content)
        proposal.contextSnapshot = context
        if let project = workbench.state.projects.first(where: { $0.id == thread.projectID }),
           let executor = project.setup?.defaultExecutorID, executorIDs.contains(executor) {
            proposal.nodes = [WorkbenchNode(title: "完成目标并提供验收证据", agentID: executor, prompt: message.content)]
        }
        return proposal
    }

    func saveProposal(_ proposal: WorkbenchProposal) throws {
        let (thread, _, actual) = try source(threadID: proposal.source.threadID, messageID: proposal.source.messageID)
        guard proposal.source.kind == .hubConversation, actual == proposal.source, thread.projectID == proposal.projectID else {
            throw HubGatewayError(message: "方案来源或项目发生变化，请重新整理")
        }
        if let generation = proposal.generationMessageID {
            guard let reply = thread.messages.first(where: { $0.id == generation && $0.purpose == "proposal" && $0.role == "assistant" && $0.status == "completed" }),
                  reply.sourceMessageID == proposal.source.messageID,
                  reply.endpointID == proposal.coordinatorEndpointID,
                  reply.contextSnapshot == proposal.contextSnapshot else {
                throw HubGatewayError(message: "生成方案的回复或上下文无法核实")
            }
        }
        for node in proposal.nodes where node.kind == .agent {
            if let id = node.agentID, !id.isEmpty, !executorIDs.contains(id) {
                throw HubGatewayError(message: "方案包含未登记的执行入口")
            }
        }
        try workbench.saveProposal(proposal)
    }

    func acceptProposal(_ id: UUID) throws -> UUID {
        guard let proposal = workbench.state.proposals?.first(where: { $0.id == id }) else { throw HubGatewayError(message: "方案不存在") }
        // Accepted proposals are idempotent even if an endpoint later disappears.
        if let task = proposal.acceptedTaskID, workbench.state.tasks.contains(where: { $0.id == task }) { return task }
        let (thread, _, actual) = try source(threadID: proposal.source.threadID, messageID: proposal.source.messageID)
        guard actual == proposal.source, thread.projectID == proposal.projectID else { throw HubGatewayError(message: "方案来源无法核实") }
        try validateExecutors(proposal.nodes)
        return try workbench.acceptProposal(id)
    }

    private func validateExecutors(_ nodes: [WorkbenchNode]) throws {
        for node in nodes where node.kind == .agent {
            guard let id = node.agentID, executorIDs.contains(id) else { throw HubGatewayError(message: "步骤“" + node.title + "”尚未绑定已登记的执行入口") }
        }
    }

    func requestProposal(threadID: UUID, messageID: UUID, endpointID: UUID, context: String) throws {
        let (_, message, _) = try source(threadID: threadID, messageID: messageID)
        guard context.utf8.count <= 32_768 else { throw HubGatewayError(message: "任务上下文上限 32 KiB") }
        let instructions = """
        将下面请求整理为待用户审阅的工作方案，不执行操作。只返回 JSON 对象，字段必须为：
        {"title":"标题","goal":"明确目标","deliverables":"具体交付物","acceptance":"可检查的验收标准","constraints":"限制","summary":"分工理由与未确定项","nodes":[{"id":"step_1","title":"步骤","kind":"agent","agentID":"已登记执行入口","dependsOn":[],"prompt":"包含本步骤交付要求","role":"执行者"}]}
        最多24步骤，不得生成命令、参数、权限、凭据或网络设置。agentID只能从这些已登记入口选择：\(executorIDs.joined(separator: ", "))。登记不代表已验证可运行；缺失的能力需在summary写明。必要条件不明时在summary列出，不伪造验收结果。此输出是提案，不是用户授权。
        """
        try control.send(threadID: threadID, text: "请为这个目标整理工作方案：\n" + message.content,
                         endpointIDs: [endpointID], context: context, purpose: "proposal", sourceMessageID: messageID,
                         additionalInstructions: instructions)
    }

    func importProposalReply(threadID: UUID, messageID: UUID) throws -> WorkbenchProposal {
        guard let thread = control.state.threads.first(where: { $0.id == threadID }),
              let reply = thread.messages.first(where: { $0.id == messageID && $0.role == "assistant" && $0.purpose == "proposal" && $0.status == "completed" }),
              let sourceID = reply.sourceMessageID else { throw HubGatewayError(message: "这条消息不是已完成的方案回复") }
        if let existing = workbench.state.proposals?.first(where: { $0.generationMessageID == reply.id && $0.source.threadID == threadID }) { return existing }
        var base = try draftProposal(threadID: threadID, messageID: sourceID, context: reply.contextSnapshot ?? "")
        base.id = UUID(); base.nodes = []; base.generationMessageID = reply.id
        base.contextSnapshot = reply.contextSnapshot ?? ""
        base.coordinatorEndpointID = reply.endpointID
        let parsed = try WorkbenchProposalParser.parse(reply.content, base: base, executorIDs: executorIDs)
        try saveProposal(parsed)
        return parsed
    }

    func conversationTasks(threadID: UUID) -> [WorkbenchTask] {
        workbench.state.tasks.filter { $0.source?.kind == .hubConversation && $0.source?.threadID == threadID }
            .sorted { $0.createdAt < $1.createdAt }
    }

    func saveAcceptedMemory(taskID: UUID) throws {
        guard let task = workbench.state.tasks.first(where: { $0.id == taskID }),
              let record = task.acceptanceRecords?.last, record.accepted,
              let run = task.runs.first(where: { $0.id == record.runID && $0.status == .completed }),
              task.status == .done || task.status == .archived else { throw HubGatewayError(message: "请先验收具体运行的成果") }
        let text = "项目已验收结论：" + task.title + "\n依据：" + record.note
            + "\n验收标准：" + record.criteria + "\n运行摘要：" + String(run.summary.prefix(2000))
            + "\n采用产物：\n" + record.artifacts.map { $0.title + " · " + $0.location + " · v" + $0.version }.joined(separator: "\n")
        try control.addMemory(scope: "project:" + task.projectID.uuidString, text: text,
                              sourceTaskID: task.id, sourceRunID: record.runID, sourceAcceptanceID: record.id)
    }
}

enum WorkbenchProposalParser {
    private struct Wire: Decodable {
        var title: String
        var goal: String
        var deliverables: String
        var acceptance: String
        var constraints: String?
        var summary: String?
        var nodes: [Node]
        struct Node: Decodable {
            var id: String
            var title: String
            var kind: String?
            var agentID: String?
            var dependsOn: [String]?
            var prompt: String?
            var role: String?
            var command: String?
            var arguments: [String]?
        }
    }
    static func parse(_ content: String, base: WorkbenchProposal, executorIDs: [String]) throws -> WorkbenchProposal {
        var text = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("```json\n"), text.hasSuffix("```") { text = String(text.dropFirst(8).dropLast(3)) }
        guard text.utf8.count <= 131_072, let bytes = text.data(using: .utf8),
              let wire = try? JSONDecoder().decode(Wire.self, from: bytes), (1...24).contains(wire.nodes.count) else {
            throw HubGatewayError(message: "回复不是有效的结构化方案；可保留原文并手工整理")
        }
        var result = base
        result.title = wire.title; result.goal = wire.goal; result.deliverables = wire.deliverables
        result.acceptance = wire.acceptance; result.constraints = wire.constraints ?? ""; result.summary = wire.summary ?? ""
        result.nodes = try wire.nodes.map { node in
            guard node.kind == nil || node.kind == "agent", node.command == nil, node.arguments == nil,
                  let executor = node.agentID, executorIDs.contains(executor), (node.prompt ?? wire.goal).utf8.count <= 16_384 else {
                throw HubGatewayError(message: "方案包含未登记执行者、命令或不支持的步骤，请手工核实")
            }
            return WorkbenchNode(id: node.id, title: node.title, kind: .agent, dependsOn: node.dependsOn ?? [],
                                 agentID: executor, prompt: node.prompt ?? wire.goal, role: node.role ?? "执行者")
        }
        guard result.validationErrors.isEmpty else { throw HubGatewayError(message: result.validationErrors.joined(separator: "；")) }
        return result
    }
}
