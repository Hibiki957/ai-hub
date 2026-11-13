import SwiftUI

/// A proposal is editable planning data. Saving or adopting it never starts a run.
struct WorkbenchProposalView: View {
    @ObservedObject var workbench: WorkbenchStore
    @ObservedObject var control: HubControlStore
    @Environment(\.dismiss) private var dismiss
    @State private var proposal: WorkbenchProposal
    @State private var issue: String?
    let onAccepted: (UUID) -> Void
    private var agents: [ToolCatalog.Agent] { ToolCatalog.shared.agents }
    private var business: WorkbenchBusinessService {
        WorkbenchBusinessService(workbench: workbench, control: control, executorIDs: agents.map(\.id))
    }

    init(workbench: WorkbenchStore, control: HubControlStore, proposal: WorkbenchProposal, onAccepted: @escaping (UUID) -> Void) {
        self.workbench = workbench
        self.control = control
        _proposal = State(initialValue: proposal)
        self.onAccepted = onAccepted
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("审阅方案").font(.title2.weight(.semibold))
                    Text("确认目标、交付物和步骤后采纳。执行前仍需确认计划与权限。").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("关闭") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    TextField("方案标题", text: $proposal.title).font(.headline).textFieldStyle(.roundedBorder)
                    proposalField("目标", text: $proposal.goal)
                    proposalField("交付物", text: $proposal.deliverables)
                    proposalField("验收标准", text: $proposal.acceptance)
                    DisclosureGroup("限制与方案说明") {
                        VStack(spacing: 12) {
                            proposalField("限制", text: $proposal.constraints)
                            proposalField("方案说明", text: $proposal.summary)
                        }.padding(.vertical, 8)
                    }
                    Divider()
                    HStack {
                        Text("执行步骤").font(.headline)
                        Spacer()
                        Button("添加步骤", systemImage: "plus") { addNode() }.disabled(proposal.nodes.count >= 24)
                    }
                    if proposal.nodes.isEmpty { Text("先添加一个执行步骤，并选择实际执行者。").font(.caption).foregroundStyle(.secondary) }
                    ForEach($proposal.nodes) { $node in
                        let nodeID = node.id
                        ProposalNodeEditor(node: $node, peers: proposal.nodes.filter { $0.id != nodeID }, agents: agents) {
                            proposal.nodes.removeAll { $0.id == nodeID }
                            for i in proposal.nodes.indices { proposal.nodes[i].dependsOn.removeAll { $0 == nodeID } }
                        }
                    }
                    DisclosureGroup("来源与共享上下文") {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("来源消息：" + proposal.source.messageID.uuidString).font(.caption2).textSelection(.enabled)
                            Text("版本 \(proposal.revision) · " + (proposal.source.evidence == .userConfirmed ? "用户确认的来源" : "建议内容，待审阅")).font(.caption).foregroundStyle(.secondary)
                            Text(proposal.contextSnapshot.isEmpty ? "没有额外共享上下文" : proposal.contextSnapshot).font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                        }.padding(.vertical, 8)
                    }
                    if !proposal.validationErrors.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("采纳前还需补充").font(.caption.weight(.semibold))
                            ForEach(Array(proposal.validationErrors.enumerated()), id: \.offset) { _, message in Text("• " + message).font(.caption) }
                        }.foregroundStyle(.secondary)
                    }
                }.padding(.vertical, 4)
            }
            if let issue { Text(issue).font(.caption).foregroundStyle(HubTheme.danger).textSelection(.enabled) }
            HStack {
                Button("保存草稿") { perform { try business.saveProposal(proposal); dismiss() } }
                Spacer()
                Button("采纳为任务") {
                    perform {
                        try business.saveProposal(proposal)
                        let id = try business.acceptProposal(proposal.id)
                        dismiss()
                        onAccepted(id)
                    }
                }.buttonStyle(.borderedProminent).disabled(!proposal.validationErrors.isEmpty || proposal.acceptedTaskID != nil)
            }
        }.padding(22).frame(width: 650, height: 650)
    }

    private func proposalField(_ title: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.caption.weight(.semibold))
            TextField(title, text: text, axis: .vertical).lineLimit(2...5).textFieldStyle(.roundedBorder)
        }
    }
    private func addNode() {
        var node = WorkbenchNode(title: "新步骤", kind: .agent)
        node.agentID = workbench.state.projects.first(where: { $0.id == proposal.projectID })?.setup?.defaultExecutorID
        if let previous = proposal.nodes.last { node.dependsOn = [previous.id] }
        proposal.nodes.append(node)
    }
    private func perform(_ action: () throws -> Void) {
        do { try action() } catch { issue = error.localizedDescription }
    }
}

private struct ProposalNodeEditor: View {
    @Binding var node: WorkbenchNode
    let peers: [WorkbenchNode]
    let agents: [ToolCatalog.Agent]
    let onDelete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                TextField("步骤名称", text: $node.title).textFieldStyle(.roundedBorder)
                Button(role: .destructive, action: onDelete) { Image(systemName: "trash") }.help("删除步骤")
            }
            HStack {
                Picker("类型", selection: $node.kind) {
                    ForEach(WorkbenchNodeKind.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                if node.kind == .agent {
                    Picker("执行者", selection: $node.agentID) {
                        Text("待选择").tag(Optional<String>.none)
                        ForEach(agents) { Text($0.name).tag(Optional($0.id)) }
                        if let id = node.agentID, !agents.contains(where: { $0.id == id }) { Text(id + "（不在目录）").tag(Optional(id)) }
                    }
                }
            }.font(.caption)
            TextField("此步骤要完成的工作", text: $node.prompt, axis: .vertical).lineLimit(2...5).textFieldStyle(.roundedBorder)
            if node.kind == .tool {
                TextField("工具命令（执行前需授权）", text: Binding(get: { node.command ?? "" }, set: { node.command = $0.isEmpty ? nil : $0 })).textFieldStyle(.roundedBorder)
                TextField("参数：每行一个", text: Binding(get: { node.arguments.joined(separator: "\n") }, set: { node.arguments = $0.split(separator: "\n").map(String.init) }), axis: .vertical).lineLimit(1...4).textFieldStyle(.roundedBorder)
            }
            if node.kind == .condition {
                TextField("判断条件", text: Binding(get: { node.condition ?? "" }, set: { node.condition = $0.isEmpty ? nil : $0 })).textFieldStyle(.roundedBorder)
            }
            DisclosureGroup("依赖与执行边界") {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(peers) { peer in
                        Toggle("等待「" + peer.title + "」完成", isOn: Binding(get: { node.dependsOn.contains(peer.id) }, set: { selected in
                            if selected { if !node.dependsOn.contains(peer.id) { node.dependsOn.append(peer.id) } }
                            else { node.dependsOn.removeAll { $0 == peer.id } }
                        }))
                    }
                    Picker("影响范围", selection: $node.sideEffect) { ForEach(WorkbenchSideEffect.allCases, id: \.self) { Text($0.label).tag($0) } }
                    TextField("步骤验收标准（可选）", text: $node.acceptance, axis: .vertical).lineLimit(1...3).textFieldStyle(.roundedBorder)
                    Text("目录中的执行者仍需联通验证；方案中的选择不会授予文件、命令或网络权限。").font(.caption2).foregroundStyle(.secondary)
                }.padding(.vertical, 6).font(.caption)
            }.font(.caption)
        }.padding(12).background(HubTheme.surface, in: RoundedRectangle(cornerRadius: 10))
    }
}
