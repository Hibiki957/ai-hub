import SwiftUI

struct HubControlView: View {
    @ObservedObject var workbench: WorkbenchStore
    @ObservedObject var execution: WorkbenchExecutionBridge
    let embedded: Bool
    @StateObject private var control = HubControlStore.shared
    @StateObject private var manager = WorkbenchManagementStore.shared
    @State private var panel: String
    @State private var selected: UUID?
    @State private var text = ""
    @State private var endpointIDs: Set<UUID> = []
    @State private var includeMemory = true
    @State private var includeSkills = false
    @State private var inputMode: InputMode = .discussion
    @State private var outgoing: PendingDiscussion?
    @State private var editingProposal: WorkbenchProposal?
    @State private var coordinatorEndpointID: UUID?
    @State private var presentedPanel: Supplement?
    @State private var loadedScope: ConversationScope?
    @State private var drafts: [ConversationScope: ScopeDraft] = [:]
    @State private var memory = ""
    @State private var memoryScope = "global"

    private struct ConversationScope: Hashable {
        let projectID: UUID?
        let taskID: UUID?
    }
    private struct ScopeDraft {
        var text: String
        var selected: UUID?
        var mode: InputMode
        var includeMemory: Bool
        var includeSkills: Bool
    }
    private struct PendingDiscussion {
        let scope: ConversationScope
        let threadID: UUID?
        let text: String
        let endpointIDs: Set<UUID>
        let context: String
        var proposalSourceMessageID: UUID? = nil
    }
    private enum InputMode: String, CaseIterable {
        case discussion = "讨论", proposal = "整理方案", record = "仅记录"
        var action: String {
            switch self { case .discussion: return "预览并发送"; case .proposal: return "整理方案"; case .record: return "保存记录" }
        }
    }
    private enum Supplement: String, Identifiable {
        case participants = "参与者与上下文", memory = "共享记忆", api = "Gateway / API", mcp = "MCP 服务", history = "历史讨论"
        var id: String { rawValue }
    }

    init(workbench: WorkbenchStore, execution: WorkbenchExecutionBridge, embedded: Bool = false, initialPanel: String = "对话与调度") {
        self.workbench = workbench
        self.execution = execution
        self.embedded = embedded
        _panel = State(initialValue: initialPanel)
    }

    private var scope: ConversationScope { .init(projectID: workbench.selectedProjectID, taskID: workbench.selectedTaskID) }
    private var threads: [HubChatThread] { control.state.threads.filter { $0.projectID == scope.projectID && $0.taskID == scope.taskID } }
    private var thread: HubChatThread? { threads.first { $0.id == selected } }
    private var enabledEndpoints: [HubAPIEndpoint] { control.state.endpoints.filter(\.enabled) }
    private var selectedEndpoints: [HubAPIEndpoint] { enabledEndpoints.filter { endpointIDs.contains($0.id) } }
    private var business: WorkbenchBusinessService { WorkbenchBusinessService(workbench: workbench, control: control, executorIDs: ToolCatalog.shared.agents.map(\.id)) }
    private var proposals: [WorkbenchProposal] { (workbench.state.proposals ?? []).filter { $0.source.threadID == selected && $0.projectID == scope.projectID } }
    private var relatedTasks: [WorkbenchTask] { selected.map { business.conversationTasks(threadID: $0) } ?? [] }
    // Attach saved work to its exact source message. Missing/legacy sources stay
    // visible below the transcript instead of being guessed from titles or text.
    private func proposalAnchor(_ proposal: WorkbenchProposal) -> UUID? {
        guard proposal.source.kind == .hubConversation, proposal.source.threadID == selected else { return nil }
        let messages = thread?.messages ?? []
        if let generated = proposal.generationMessageID, messages.contains(where: { $0.id == generated }) { return generated }
        guard messages.contains(where: { $0.id == proposal.source.messageID }) else { return nil }
        return proposal.source.messageID
    }
    private func taskAnchor(_ task: WorkbenchTask) -> UUID? {
        if let proposal = proposals.first(where: { $0.id == task.proposalID }), let anchor = proposalAnchor(proposal) { return anchor }
        guard let source = task.source, source.kind == .hubConversation, source.threadID == selected,
              thread?.messages.contains(where: { $0.id == source.messageID }) == true else { return nil }
        return source.messageID
    }
    private var coordinator: HubAPIEndpoint? { enabledEndpoints.first { $0.id == coordinatorEndpointID } }
    private var cleanText: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var primaryDisabled: Bool {
        if cleanText.isEmpty { return true }
        switch inputMode {
        case .discussion: return endpointIDs.isEmpty || endpointIDs.count > 4 || !control.activeRequestIDs.isEmpty
        case .proposal: return workbench.selectedProjectID == nil || (coordinatorEndpointID != nil && !control.activeRequestIDs.isEmpty)
        case .record: return false
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: embedded ? 8 : 12) {
            if !embedded {
                Picker("调度页", selection: $panel) {
                    ForEach(["对话与调度", "共享记忆", "Gateway / API", "MCP 服务", "历史讨论"], id: \.self) { Text($0).tag($0) }
                }.pickerStyle(.segmented)
            }
            if let issue = control.issue { Text(issue).font(.caption).foregroundStyle(HubTheme.danger).textSelection(.enabled).lineLimit(3) }
            if embedded { chatPanel }
            else {
                switch panel {
                case "历史讨论": WorkbenchDiscussionView(store: workbench) { workbench.page = .tasks }
                case "共享记忆": memoryPanel
                case "Gateway / API": HubAPISettingsView(control: control)
                case "MCP 服务": HubMCPView(workbench: workbench)
                default: chatPanel
                }
            }
        }
        .padding(embedded ? 12 : 18)
        .onAppear { synchronizeScope() }
        .onDisappear { saveDraft() }
        .onChange(of: scope) { _ in synchronizeScope() }
        .onChange(of: workbench.selectedControlThreadID) { _ in synchronizeScope() }
        .onChange(of: workbench.selectedLegacyConversationID) { _ in synchronizeScope() }
        .onChange(of: workbench.selectedAPIEndpointIDs) { _ in synchronizeScope() }
        .onChange(of: control.state.endpoints) { _ in
            endpointIDs.formIntersection(Set(enabledEndpoints.map(\.id)))
            if !enabledEndpoints.contains(where: { $0.id == coordinatorEndpointID }) { coordinatorEndpointID = nil }
        }
        .sheet(item: $editingProposal) { proposal in
            WorkbenchProposalView(workbench: workbench, control: control, proposal: proposal) { id in workbench.selectTask(id) }
        }
        .sheet(item: $presentedPanel) { supplement in
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text(supplement.rawValue).font(.title2.weight(.semibold))
                    Spacer()
                    Button("完成") { presentedPanel = nil }.keyboardShortcut(.cancelAction)
                }
                switch supplement {
                case .participants: participantsPanel
                case .memory: memoryPanel
                case .api: HubAPISettingsView(control: control)
                case .mcp: HubMCPView(workbench: workbench)
                case .history: WorkbenchDiscussionView(store: workbench) { presentedPanel = nil; workbench.page = .tasks }
                }
            }.padding(22).frame(minWidth: 560, idealWidth: 650, minHeight: 370, idealHeight: 520)
        }
        .sheet(isPresented: Binding(get: { outgoing != nil }, set: { if !$0 { outgoing = nil } })) {
            VStack(alignment: .leading, spacing: 14) {
                Text(outgoing?.proposalSourceMessageID == nil ? "发送上下文预览" : "方案请求预览").font(.title2)
                Text("发送到：" + control.state.endpoints.filter { outgoing?.endpointIDs.contains($0.id) == true }.map { $0.name + " / " + $0.model }.joined(separator: " · ")).font(.caption)
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        Text("本次输入").font(.headline)
                        Text(outgoing?.text ?? "").textSelection(.enabled)
                        Divider()
                        Text("共享上下文").font(.headline)
                        Text(outgoing?.context ?? "").font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.frame(height: 300)
                Text("还会发送此会话最近 40 条已完成消息。文件引用仅发送路径/链接；不会自动读取正文。回复不会自动执行工具。").font(.caption).foregroundStyle(.secondary)
                HStack { Button("返回修改") { outgoing = nil }; Spacer(); Button(outgoing?.proposalSourceMessageID == nil ? "发送并在后台等待" : "请协调者生成方案") { send() }.buttonStyle(.borderedProminent) }
            }.padding(22).frame(width: 630)
        }
    }

    private var chatPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: "bubble.left.and.bubble.right").foregroundStyle(.secondary)
                Menu {
                    Button("新建会话") { selected = nil }
                    if !threads.isEmpty { Divider() }
                    ForEach(threads) { item in
                        Button { selected = item.id } label: {
                            if selected == item.id { Label(item.title, systemImage: "checkmark") }
                            else { Text(item.title) }
                        }
                    }
                } label: { Text(thread?.title ?? "新对话").lineLimit(1) }
                .menuStyle(.borderlessButton)
                .frame(maxWidth: 230, alignment: .leading)
                Spacer(minLength: 2)
                Button { presentedPanel = .participants } label: {
                    Label(selectedEndpoints.isEmpty ? "选择参与者" : "参与者 \(selectedEndpoints.count)", systemImage: "person.2")
                }.font(.caption)
                Menu {
                    Button("共享记忆") { open(.memory) }
                    Button("API 连接") { open(.api) }
                    Button("MCP 服务") { open(.mcp) }
                    Button("历史讨论") { open(.history) }
                    if !control.activeRequestIDs.isEmpty {
                        Divider()
                        Button("停止 Hub API 请求") { control.cancelRequests() }
                    }
                } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).frame(width: 24)
                .help("对话设置")
            }
            HStack(spacing: 6) {
                if let task = workbench.selectedTask {
                    Text("任务：" + task.title).lineLimit(1)
                    Spacer(minLength: 2)
                    Button("返回项目讨论") { workbench.selectedTaskID = nil }.buttonStyle(.plain).foregroundStyle(.tint)
                } else {
                    Text((workbench.selectedProject?.name ?? "全局") + " · 项目讨论").lineLimit(1)
                    Spacer(minLength: 2)
                }
                if !control.activeRequestIDs.isEmpty { ProgressView().controlSize(.mini); Text("等待回复").fixedSize() }
            }.font(.caption).foregroundStyle(.secondary)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 24) {
                        if thread?.messages.isEmpty != false {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(workbench.selectedTask == nil ? "从目标、想法或问题开始" : "围绕这个任务继续讨论").font(.callout.weight(.medium))
                                Text("讨论形成方案，审阅后派成任务，结果会回到这段对话。").font(.caption).foregroundStyle(.secondary)
                            }.padding(.vertical, 10)
                        }
                        ForEach(thread?.messages ?? []) { message in
                            VStack(alignment: .leading, spacing: 12) {
                                messageRow(message)
                                ForEach(proposals.filter { proposalAnchor($0) == message.id }) { proposal in proposalCard(proposal) }
                                ForEach(relatedTasks.filter { taskAnchor($0) == message.id }) { task in taskCard(task) }
                            }.id(message.id)
                        }
                        let unplacedProposals = proposals.filter { proposalAnchor($0) == nil }
                        let unplacedTasks = relatedTasks.filter { taskAnchor($0) == nil }
                        if !unplacedProposals.isEmpty || !unplacedTasks.isEmpty {
                            VStack(alignment: .leading, spacing: 12) {
                                Divider()
                                Text("此对话的其他工作记录").font(.system(size: 12, weight: .medium)).foregroundStyle(HubTheme.textSecondary)
                                ForEach(unplacedProposals) { proposal in proposalCard(proposal) }
                                ForEach(unplacedTasks) { task in taskCard(task) }
                            }
                        }
                        Color.clear.frame(height: 1).id("conversation-end")
                    }
                    .frame(maxWidth: 800, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.horizontal, 8).padding(.vertical, 16)
                }
                .onChange(of: selected) { _ in proxy.scrollTo("conversation-end", anchor: .bottom) }
                .onChange(of: thread?.messages.count) { _ in proxy.scrollTo("conversation-end", anchor: .bottom) }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            composer
        }
    }

    private func messageRow(_ message: HubChatMessage) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(message.role == "user" ? "你" : (control.state.endpoints.first { $0.id == message.endpointID }?.name ?? "模型")).font(.system(size: 12, weight: .semibold))
                Spacer()
                Text(message.createdAt.formatted(date: .omitted, time: .shortened)).font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
                if message.status != "completed" { Text(statusLabel(message.status)).font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary) }
                if message.status == "running" { ProgressView().controlSize(.mini) }
                if message.status == "completed" {
                    Menu {
                        Button("保存为共享记忆") {
                            memory = message.content
                            memoryScope = workbench.selectedTaskID.map { "task:" + $0.uuidString } ?? workbench.selectedProjectID.map { "project:" + $0.uuidString } ?? "global"
                            open(.memory)
                        }
                        Button("手动整理方案") { draftProposal(from: message) }.disabled(workbench.selectedProjectID == nil)
                        Button("请协调者整理方案") { prepareProposal(from: message) }.disabled(workbench.selectedProjectID == nil || coordinator == nil || !control.activeRequestIDs.isEmpty)
                    } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).frame(width: 20)
                }
            }
            if message.purpose == "proposal" {
                if message.status == "completed" {
                    Text("协调者已返回方案建议。审阅目标、交付物和步骤后再采纳。").font(.system(size: 14)).lineSpacing(5)
                    Button("审阅生成方案") { importProposal(message) }.font(.caption)
                    DisclosureGroup("查看原始回复") { Text(message.content).font(.system(size: 11, design: .monospaced)).textSelection(.enabled) }.font(.caption)
                } else { Text(message.content.isEmpty ? "协调者正在整理方案…" : message.content).font(.system(size: 14)).lineSpacing(5).textSelection(.enabled) }
            } else { Text(message.content.isEmpty ? "等待回复…" : message.content).font(.system(size: 14)).lineSpacing(5).textSelection(.enabled) }
        }
        .padding(message.role == "user" ? 14 : 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(message.role == "user" ? HubTheme.surface : Color.clear, in: RoundedRectangle(cornerRadius: 10))
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 7) {
            if inputMode == .discussion && endpointIDs.isEmpty {
                HStack(spacing: 7) {
                    Text(enabledEndpoints.isEmpty ? "连接一个 API 后即可开始讨论" : "选择参与者后发送").font(.caption).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    Button(enabledEndpoints.isEmpty ? "配置连接" : "选择参与者") {
                        presentedPanel = enabledEndpoints.isEmpty ? .api : .participants
                    }.font(.caption)
                }
            } else if inputMode == .discussion && endpointIDs.count > 4 {
                Text("一次最多选择 4 位参与者，请调整选择。").font(.caption).foregroundStyle(HubTheme.warning)
            } else if inputMode == .proposal && workbench.selectedProjectID == nil {
                Text("先选择一个项目，再整理执行方案。").font(.caption).foregroundStyle(.secondary)
            }
            if inputMode == .proposal {
                Text(coordinator.map { "方案协调者：" + $0.name } ?? "手工方案 · 可在参与者设置中选择协调者").font(.caption2).foregroundStyle(.secondary)
            }
            TextField(inputMode == .proposal ? "描述目标，整理交付物、验收与执行步骤…" : "输入问题、想法或任务目标…", text: $text, axis: .vertical)
                .lineLimit(2...4).textFieldStyle(.roundedBorder)
            HStack(spacing: 8) {
                Picker("输入用途", selection: $inputMode) {
                    ForEach(InputMode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }.pickerStyle(.menu).labelsHidden().frame(width: 112)
                if let task = workbench.selectedTask {
                    Menu {
                        Button("把当前共享上下文更新到任务输入") { updateTaskContext(task) }
                    } label: { Image(systemName: "paperclip") }.menuStyle(.borderlessButton).frame(width: 20).help("任务上下文")
                }
                Spacer(minLength: 0)
                Button(inputMode == .proposal && coordinator != nil ? "预览方案请求" : inputMode.action) { performPrimaryAction() }.buttonStyle(.borderedProminent).disabled(primaryDisabled)
            }.font(.caption)
        }
    }

    private var participantsPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("选择实际接收这次消息的服务，最多 4 个并行回复。").font(.caption).foregroundStyle(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(enabledEndpoints) { endpoint in
                        Toggle(isOn: Binding(get: { endpointIDs.contains(endpoint.id) }, set: { if $0 { endpointIDs.insert(endpoint.id) } else { endpointIDs.remove(endpoint.id) } })) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(endpoint.name).font(.callout)
                                Text(endpoint.model).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    if enabledEndpoints.isEmpty { Text("尚未配置可用的 API 连接。").foregroundStyle(.secondary) }
                }.padding(.vertical, 5)
            }.frame(minHeight: 100)
            Picker("方案协调者", selection: Binding(get: { coordinatorEndpointID }, set: { id in setCoordinator(id) })) {
                Text("手工整理方案").tag(Optional<UUID>.none)
                ForEach(enabledEndpoints) { endpoint in Text(endpoint.name + " · " + endpoint.model).tag(Optional(endpoint.id)) }
            }
            Text("整理方案只发给这里明确选择的一位协调者，讨论参与者不自动变成执行者。").font(.caption2).foregroundStyle(.secondary)
            Button("管理 API 连接") { presentedPanel = .api }
            Divider()
            Toggle("使用当前范围的共享记忆（\(control.memories(projectID: workbench.selectedProjectID, taskID: workbench.selectedTaskID).count) 条）", isOn: $includeMemory)
            Toggle("加载当前范围已选 Skill 正文", isOn: $includeSkills)
            Text("发送前可以检查具体内容。回复不会自动调用工具，服务失败也不会自动改用其他连接。").font(.caption).foregroundStyle(.secondary)
        }
    }

    private var memoryPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("共享记忆").font(.title2)
            Text("保存你主动确认的事实、偏好或结论。全局记忆可供所有项目选用，项目与任务记忆只在对应范围内出现。").font(.caption).foregroundStyle(.secondary)
            Picker("保存范围", selection: $memoryScope) {
                Text("全局").tag("global")
                if let id = workbench.selectedProjectID { Text("当前项目").tag("project:" + id.uuidString) }
                if let id = workbench.selectedTaskID { Text("当前任务").tag("task:" + id.uuidString) }
            }
            TextField("已确认内容", text: $memory, axis: .vertical).lineLimit(3...6).textFieldStyle(.roundedBorder)
            Button("保存到共享记忆") { act { try control.addMemory(scope: memoryScope, text: memory); memory = "" } }.disabled(memory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            List(control.memories(projectID: workbench.selectedProjectID, taskID: workbench.selectedTaskID)) { note in
                VStack(alignment: .leading, spacing: 6) {
                    Text(note.text).textSelection(.enabled)
                    HStack { Text(note.scope == "global" ? "全局" : (note.scope.hasPrefix("task:") ? "任务" : "项目")).font(.caption).foregroundStyle(.secondary); Spacer(); Button("删除") { act { try control.removeMemory(note.id) } } }
                }.padding(.vertical, 6)
            }
        }
    }

    private func open(_ supplement: Supplement) {
        if embedded || supplement == .participants { presentedPanel = supplement }
        else { panel = supplement.rawValue }
    }
    private func saveDraft() {
        guard let loadedScope else { return }
        drafts[loadedScope] = ScopeDraft(text: text, selected: selected, mode: inputMode, includeMemory: includeMemory, includeSkills: includeSkills)
    }
    private func synchronizeScope() {
        if loadedScope != scope {
            saveDraft()
            loadedScope = scope
            let restored = drafts[scope]
            text = restored?.text ?? ""
            selected = restored.flatMap { draft in threads.first(where: { $0.id == draft.selected })?.id } ?? (restored == nil ? threads.last?.id : nil)
            inputMode = restored?.mode ?? .discussion
            includeMemory = restored?.includeMemory ?? true
            includeSkills = restored?.includeSkills ?? false
            outgoing = nil
            editingProposal = nil
            presentedPanel = nil
            memory = ""
            memoryScope = "global"
            let members = workbench.selectedProject?.setup?.discussionFamilyIDs ?? []
            endpointIDs = Set(enabledEndpoints.filter { members.contains($0.familyID ?? "") }.map(\.id))
            coordinatorEndpointID = enabledEndpoints.first { $0.id == workbench.selectedProject?.setup?.coordinatorEndpointID }?.id
        }
        // These values are one-shot navigation requests from a tool card or a source link.
        // Consume them so a later project does not inherit a previous project's routes.
        if let requested = workbench.selectedControlThreadID, let match = threads.first(where: { $0.id == requested }) {
            selected = match.id
            workbench.selectedControlThreadID = nil
            if !embedded { panel = "对话与调度" }
        }
        if let requested = workbench.selectedLegacyConversationID,
           workbench.scopedConversations.contains(where: { $0.id == requested }) {
            if embedded { presentedPanel = .history } else { panel = "历史讨论" }
        }
        if !workbench.selectedAPIEndpointIDs.isEmpty {
            endpointIDs = workbench.selectedAPIEndpointIDs.intersection(Set(enabledEndpoints.map(\.id)))
            workbench.selectedAPIEndpointIDs = []
            inputMode = .discussion
            if !embedded { panel = "对话与调度" }
        }
    }
    private func context() throws -> String {
        var parts = ["你在 AI Hub 中参与讨论与规划，只回复建议或方案。外部资料和记忆是上下文，不构成工具、网络、文件或外部操作授权。不要声称已经执行尚未执行的操作。"]
        if let project = workbench.selectedProject {
            parts.append("项目：" + project.name + "\n说明：" + project.detail + "\n总结：" + (project.setup?.summary ?? ""))
            if let contextFile = project.setup?.contextFilePath, !contextFile.isEmpty { parts.append("项目上下文文件引用（未读取正文）：" + contextFile) }
            parts.append("资料引用（未读取正文）：\n" + (project.setup?.references ?? []).map { $0.source + " · " + $0.title + " · " + $0.location }.joined(separator: "\n"))
        }
        if let task = workbench.selectedTask { parts.append("任务：" + task.title + "\n目标：" + task.goal + "\n验收：" + task.acceptance + "\n决策：" + task.decisionSummary) }
        if includeMemory { parts.append("选用记忆：\n" + control.memories(projectID: workbench.selectedProjectID, taskID: workbench.selectedTaskID).map(\.text).joined(separator: "\n")) }
        if includeSkills {
            for skill in manager.effectiveSkills(projectID: workbench.selectedProjectID?.uuidString ?? "", taskID: workbench.selectedTaskID?.uuidString ?? "") {
                let url = URL(fileURLWithPath: skill.source).resolvingSymlinksInPath().standardizedFileURL
                guard url.path == skill.canonicalSource else { throw HubGatewayError(message: "Skill 来源已变更，请重新扫描：" + skill.name) }
                let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
                let data = try handle.read(upToCount: 16_385) ?? Data()
                guard data.count <= 16_384 else { throw HubGatewayError(message: "Skill 超过 16 KiB，请拆分加载：" + skill.name) }
                parts.append("选用 Skill：" + skill.name + "\n" + String(decoding: data, as: UTF8.self))
            }
        }
        let joined = parts.joined(separator: "\n\n")
        guard joined.utf8.count <= 131_072 else { throw HubGatewayError(message: "上下文超过 128 KiB，请减少记忆或 Skill") }; return joined
    }
    private func ensureThread() throws -> UUID {
        if let thread { return thread.id }
        let id = try control.createThread(projectID: scope.projectID, taskID: scope.taskID, title: String(text.prefix(40)))
        selected = id; return id
    }
    private func performPrimaryAction() {
        act {
            guard !cleanText.isEmpty, text.utf8.count <= 65_536 else { throw HubGatewayError(message: "输入需为 1–64 KiB 的文本") }
            switch inputMode {
            case .discussion:
                outgoing = PendingDiscussion(scope: scope, threadID: selected, text: text, endpointIDs: endpointIDs, context: try context())
            case .record:
                let id = try ensureThread()
                try control.append(threadID: id, role: "user", content: text)
                text = ""
            case .proposal:
                let snapshot = try taskContext()
                let id = try ensureThread()
                let sourceID = try control.append(threadID: id, role: "user", content: text)
                let sourceText = text
                text = ""
                if let coordinator {
                    outgoing = PendingDiscussion(scope: scope, threadID: id, text: sourceText, endpointIDs: [coordinator.id], context: snapshot, proposalSourceMessageID: sourceID)
                } else {
                    editingProposal = try business.draftProposal(threadID: id, messageID: sourceID, context: snapshot)
                }
            }
        }
    }
    private func send() {
        act {
            guard let pending = outgoing, pending.scope == scope, pending.threadID == selected else { outgoing = nil; throw HubGatewayError(message: "讨论范围已变更，请重新预览后发送") }
            if let source = pending.proposalSourceMessageID {
                guard let threadID = pending.threadID, pending.endpointIDs.count == 1, let endpointID = pending.endpointIDs.first else { throw HubGatewayError(message: "请选择一位方案协调者") }
                try business.requestProposal(threadID: threadID, messageID: source, endpointID: endpointID, context: pending.context)
            } else {
                let id = try ensureThread()
                try control.send(threadID: id, text: pending.text, endpointIDs: Array(pending.endpointIDs), context: pending.context)
                if text == pending.text { text = "" }
            }
            outgoing = nil
        }
    }
    private func taskContext() throws -> String {
        let snapshot = try context()
        guard snapshot.utf8.count <= 32_768 else { throw HubGatewayError(message: "任务输入上限 32 KiB，请减少共享内容") }
        return snapshot
    }
    private func updateTaskContext(_ task: WorkbenchTask) {
        act { var value = task; value.inputs = try taskContext(); try workbench.updateDetails(value) }
    }
    private func draftProposal(from message: HubChatMessage) {
        act {
            guard let source = thread, source.messages.contains(where: { $0.id == message.id }) else { throw HubGatewayError(message: "来源消息未保存，未创建方案") }
            editingProposal = try business.draftProposal(threadID: source.id, messageID: message.id, context: taskContext())
        }
    }
    private func prepareProposal(from message: HubChatMessage) {
        act {
            guard let source = thread, source.messages.contains(where: { $0.id == message.id }), let coordinator else { throw HubGatewayError(message: "请先选择方案协调者并保存来源消息") }
            outgoing = PendingDiscussion(scope: scope, threadID: source.id, text: message.content, endpointIDs: [coordinator.id], context: try taskContext(), proposalSourceMessageID: message.id)
        }
    }
    private func importProposal(_ message: HubChatMessage) {
        act {
            guard let threadID = selected else { throw HubGatewayError(message: "来源会话未找到") }
            let proposal = try business.importProposalReply(threadID: threadID, messageID: message.id)
            if let taskID = proposal.acceptedTaskID { workbench.selectTask(taskID) }
            else { editingProposal = proposal }
        }
    }
    private func setCoordinator(_ id: UUID?) {
        act {
            if var project = workbench.selectedProject {
                var setup = project.setup ?? .init()
                setup.coordinatorEndpointID = id
                project.setup = setup
                try workbench.updateProject(project)
            }
            coordinatorEndpointID = id
        }
    }
    private func proposalCard(_ proposal: WorkbenchProposal) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(proposal.title, systemImage: "doc.text.magnifyingglass").font(.callout.weight(.semibold))
                Spacer()
                Text("方案 v\(proposal.revision)").font(.caption2).foregroundStyle(.secondary)
            }
            Text(proposal.goal).font(.caption).lineLimit(3)
            Text("\(proposal.nodes.count) 个步骤 · " + (proposal.acceptedTaskID == nil ? "待审阅" : "已采纳")).font(.caption2).foregroundStyle(.secondary)
            if let taskID = proposal.acceptedTaskID {
                Button("查看关联任务") { workbench.selectTask(taskID) }.font(.caption)
            } else { Button("审阅方案") { editingProposal = proposal }.font(.caption) }
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(HubTheme.accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
    }
    private func taskCard(_ task: WorkbenchTask) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(task.title, systemImage: "checklist").font(.callout.weight(.semibold))
                Spacer()
                Text(task.status.label).font(.caption2).foregroundStyle(task.status.tint)
            }
            if let run = task.runs.last {
                Text(run.summary.isEmpty ? "运行记录已建立，等待执行结果。" : run.summary).font(.caption).lineLimit(5).textSelection(.enabled)
                ForEach(run.artifacts) { artifact in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(artifact.title).font(.caption.weight(.medium))
                        WorkbenchReferenceButton(location: artifact.location)
                    }
                }
            } else { Text("方案已采纳；核对权限与计划后才能执行。").font(.caption).foregroundStyle(.secondary) }
            if let accepted = task.acceptanceRecords?.last {
                Text((accepted.accepted ? "验收通过：" : "验收退回：") + accepted.note).font(.caption).textSelection(.enabled)
            }
            HStack {
                Button(task.status == .awaitingAcceptance ? "查看结果并验收" : "查看任务与执行") { workbench.selectTask(task.id) }
                Spacer()
                if task.acceptanceRecords?.last?.accepted == true && (task.status == .done || task.status == .archived) {
                    Button("保存验收结论到记忆") { act { try business.saveAcceptedMemory(taskID: task.id) } }
                }
            }.font(.caption)
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(HubTheme.surface, in: RoundedRectangle(cornerRadius: 10))
    }
    private func act(_ action: () throws -> Void) { do { try action() } catch { control.issue = error.localizedDescription } }
    private func statusLabel(_ value: String) -> String {
        switch value { case "running": return "等待回复"; case "completed": return "已记录"; case "failed": return "失败"; case "cancelled": return "已停止"; default: return "待恢复" }
    }
}

struct HubAPISettingsView: View {
    @ObservedObject var control: HubControlStore
    @State private var editing: HubAPIEndpoint?
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Gateway / API 路由").font(.system(size: 19, weight: .semibold))
                Spacer()
                Button { editing = HubAPIEndpoint() } label: {
                    Label("添加 API", systemImage: "plus").font(.system(size: 11, weight: .semibold))
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .foregroundStyle(.white)
                        .background(HubTheme.primaryGradient, in: RoundedRectangle(cornerRadius: 9))
                }.buttonStyle(.plain)
            }
            Text("连接 OpenAI 兼容服务或本地 Gateway。Hub 统一前端，后端保留原服务；本页不会部署或启动服务。").font(.caption).foregroundStyle(HubTheme.textTertiary)
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(control.state.endpoints) { endpoint in
                        HStack(spacing: 11) {
                            Image(systemName: "server.rack")
                                .font(.system(size: 11))
                                .foregroundStyle(endpoint.enabled ? HubTheme.accent : HubTheme.textTertiary)
                                .frame(width: 30, height: 30)
                                .background((endpoint.enabled ? HubTheme.accent : HubTheme.textTertiary).opacity(0.10), in: RoundedRectangle(cornerRadius: 9))
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 7) {
                                    Text(endpoint.name + " · " + endpoint.model).font(.system(size: 13, weight: .semibold))
                                    HubTheme.StatusChip(text: control.endpointConnectionLabel(for: endpoint), tint: control.endpointConnectionStatus(for: endpoint).isLiveVerified ? HubTheme.success : HubTheme.textTertiary)
                                }
                                Text(endpoint.baseURL).font(.caption).foregroundStyle(HubTheme.textSecondary).textSelection(.enabled)
                                Text(control.endpointConnectionStatus(for: endpoint).detail).font(.caption2).foregroundStyle(HubTheme.textTertiary)
                            }
                            Spacer()
                            Button("配置") { editing = endpoint }.font(.caption)
                        }
                        .padding(12).frame(maxWidth: .infinity, alignment: .leading).hubPanel()
                    }
                    if control.state.endpoints.isEmpty {
                        Text("尚未配置路由。添加后可在统一对话中选择。").font(.caption).foregroundStyle(HubTheme.textTertiary)
                    }
                }
            }
            HubConnectionEvidenceView(control: control)
            Text("协议：POST {baseURL}/chat/completions，文本回复。暂不支持流式、语音、OAuth 或自动工具调用。多路由由你明确选择，失败不擅自切换出口。").font(.caption).foregroundStyle(HubTheme.textTertiary)
        }.sheet(item: $editing) { HubAPIEndpointEditor(control: control, endpoint: $0) }
    }
}
private struct HubAPIEndpointEditor: View {
    @ObservedObject var control: HubControlStore
    @Environment(\.dismiss) private var dismiss
    @State private var endpoint: HubAPIEndpoint
    @State private var token = ""
    @State private var replaceToken = false
    init(control: HubControlStore, endpoint: HubAPIEndpoint) { self.control = control; _endpoint = State(initialValue: endpoint) }
    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            Text("配置 Hub API").font(.title2)
            TextField("名称", text: $endpoint.name).textFieldStyle(.roundedBorder)
            TextField("Base URL，例如 http://127.0.0.1:8000/v1", text: $endpoint.baseURL).textFieldStyle(.roundedBorder)
            TextField("实际模型 ID", text: $endpoint.model).textFieldStyle(.roundedBorder)
            Picker("对应工具 / 后端", selection: $endpoint.familyID) {
                Text("通用模型 / 自定义服务").tag(Optional<String>.none)
                ForEach(ToolStackFamily.definitions) { Text($0.name).tag(Optional($0.id)) }
            }
            Toggle("启用", isOn: $endpoint.enabled)
            Toggle("设置 / 替换 Hub 自己的 API Key", isOn: $replaceToken)
            if replaceToken { SecureField("Key（留空则移除旧凭据）", text: $token).textFieldStyle(.roundedBorder) }
            Text("仅保存到 Hub 自己的 macOS 钥匙串项；回环服务可不设 Key。保存不发送请求。").font(.caption).foregroundStyle(.secondary)
            if let issue = control.issue { Text(issue).font(.caption).foregroundStyle(HubTheme.danger) }
            HStack { Button("取消") { dismiss() }; Spacer(); Button("保存") {
                do { try control.saveEndpoint(endpoint, newToken: replaceToken ? token : nil); dismiss() } catch { control.issue = error.localizedDescription }
            } }
        }.padding(24).frame(width: 520)
    }
}
