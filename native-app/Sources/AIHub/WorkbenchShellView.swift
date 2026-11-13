import AppKit
import SwiftUI

/// Project chrome survives switching between Hub views and manual tool tabs.
/// The single conversation instance stays mounted so unfinished input is retained.
struct WorkbenchShellView: View {
    @ObservedObject var store: WorkbenchStore
    @ObservedObject var execution: WorkbenchExecutionBridge
    @ObservedObject var relay: RelayRuntimeStore
    var onOpenInHub: ((AppIntegrations.WorkspaceRoute) -> Void)? = nil
    var toolContent: AnyView? = nil
    var showingOverview = true
    var onShowOverview: () -> Void = {}
    var onToggleResources: () -> Void = {}
    @StateObject private var control = HubControlStore.shared
    @StateObject private var mcp = HubMCPStore.shared
    @State private var newTask = false
    @State private var taskGoal = ""
    @State private var taskProject: UUID?
    @State private var editingProject: WorkbenchProject?
    @State private var conversationOpen = false
    @State private var activityOpen = false
    @State private var inboxOpen = false
    @State private var inboxText = ""
    @State private var lifecycleFilter: WorkbenchTaskLifecycle?
    private var homeVisible: Bool { showingOverview && store.page == .discussion }
    private var needsAttention: [WorkbenchTask] {
        store.visibleTasks.filter { [.awaitingApproval, .awaitingAcceptance, .blocked, .failed, .interrupted].contains($0.status) }
    }
    private var activeTasks: [WorkbenchTask] { store.visibleTasks.filter { $0.status.active } }

    var body: some View {
        VStack(spacing: 0) {
            header
            navigation
            if let issue = store.errorMessage {
                HStack { Text(issue).font(.caption).textSelection(.enabled); Spacer(); Button("关闭") { store.errorMessage = nil } }
                    .padding(10).foregroundStyle(HubTheme.danger)
            }
            GeometryReader { geometry in
                let height = max(geometry.size.height, 0)
                let chatHeight = homeVisible ? height
                    : ((conversationOpen && store.page != .stack) ? min(340, height * 0.52) : 0)
                VStack(spacing: 0) {
                    ZStack {
                        if let toolContent {
                            toolContent.opacity(showingOverview ? 0 : 1)
                                .allowsHitTesting(!showingOverview).accessibilityHidden(showingOverview)
                        }
                        content.opacity(showingOverview ? 1 : 0)
                            .allowsHitTesting(showingOverview).accessibilityHidden(!showingOverview)
                    }
                    .frame(height: max(0, height - chatHeight)).clipped()
                    HubControlView(workbench: store, execution: execution, embedded: true)
                        .frame(height: chatHeight).clipped()
                        .opacity(chatHeight > 0 ? 1 : 0)
                        .allowsHitTesting(chatHeight > 0).accessibilityHidden(chatHeight == 0)
                        .background(HubTheme.background)
                }
            }
            Divider().overlay(HubTheme.border)
            activityBar
        }.background(HubTheme.background).foregroundStyle(HubTheme.text)
            .sheet(isPresented: $newTask) { taskSheet }
            .sheet(item: $editingProject) { ProjectSettingsView(store: store, project: $0) }
    }

    private func navigate(_ page: WorkbenchPage) { store.page = page; onShowOverview() }
    private var navigation: some View {
        HStack(spacing: 12) {
            ViewThatFits(in: .horizontal) {
                primaryNavigation.fixedSize(horizontal: true, vertical: false)
                Menu {
                    ForEach(WorkbenchPage.primaryPages, id: \.self) { page in
                        Button { navigate(page) } label: { Label(page.label, systemImage: page.symbol) }
                    }
                } label: {
                    Label(showingOverview ? (store.page.primaryPage?.label ?? "工作视图") : "工作视图",
                          systemImage: "square.grid.2x2")
                        .font(.system(size: 13, weight: .medium))
                        .padding(.vertical, 9)
                }.menuStyle(.borderlessButton).fixedSize()
            }
            if showingOverview && store.page.primaryPage == nil {
                Text(store.page.label).font(.caption).foregroundStyle(HubTheme.accent)
            }
            Spacer(minLength: 4)
            if !homeVisible && store.page != .stack {
                Button { conversationOpen.toggle() } label: {
                    Label(conversationOpen ? "收起对话" : "对话与调度", systemImage: "bubble.left.and.bubble.right")
                        .font(.caption)
                }.buttonStyle(.plain).foregroundStyle(conversationOpen ? HubTheme.accent : HubTheme.textSecondary)
                .help("在当前任务或工具旁展开统一对话")
            }
            Menu {
                Button("Gateway / API") { navigate(.control) }
                Button("Skill / MCP 管理") { navigate(.capabilities) }
                Button("资料库连接") { navigate(.resources) }
                Button("网络与环境") { navigate(.network) }
            } label: { Image(systemName: "gearshape").font(.system(size: 13)) }
                .menuStyle(.borderlessButton).frame(width: 24).help("连接与能力设置")
            Button(action: onToggleResources) { Image(systemName: "sidebar.right") }
                .buttonStyle(.plain).help("显示或收起项目资源")
        }
        .padding(.horizontal, 20).padding(.top, 8)
        .overlay(alignment: .bottom) { Divider().overlay(HubTheme.border) }
    }

    private var primaryNavigation: some View {
        HStack(spacing: 12) {
            ForEach(WorkbenchPage.primaryPages, id: \.self) { page in
                let active = showingOverview && store.page.primaryPage == page
                Button { navigate(page) } label: {
                    VStack(spacing: 9) {
                        Label(page.label, systemImage: page.symbol)
                            .font(.system(size: 13, weight: active ? .semibold : .regular))
                        Rectangle().fill(active ? HubTheme.accent : Color.clear).frame(height: 2)
                    }
                    .foregroundStyle(active ? HubTheme.accent : HubTheme.textSecondary)
                    .fixedSize(horizontal: true, vertical: false)
                }.buttonStyle(.plain)
            }
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(store.state.workspaces.first { $0.id == store.selectedWorkspaceID }?.name ?? "全部主题")
                    .font(.system(size: 11)).foregroundStyle(HubTheme.textTertiary)
                Text(store.selectedProject?.name ?? "个人工作台").font(.system(size: 19, weight: .semibold)).lineLimit(1)
            }
            if let task = store.selectedTask, !showingOverview || (store.page != .tasks && store.page != .workflow) {
                Button { navigate(.tasks) } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("当前任务 · " + task.status.label).font(.system(size: 10)).foregroundStyle(HubTheme.textTertiary)
                        Text(task.title).font(.system(size: 12)).lineLimit(1)
                    }
                }.buttonStyle(.plain).padding(.leading, 6).help("回到当前任务")
            }
            Spacer(minLength: 0)
            globalStatusStrip
            inboxCapture
            if let project = store.selectedProject {
                Button { editingProject = project } label: { Image(systemName: "slider.horizontal.3") }
                    .buttonStyle(.plain).help("项目设置与目录")
            }
            Button {
                taskProject = store.selectedProjectID ?? store.scopedProjects.first?.id
                taskGoal = ""; newTask = true
            } label: { Label("新建任务", systemImage: "plus") }
                .controlSize(.small).disabled(store.scopedProjects.isEmpty)
        }.padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 8)
    }

    /// 全局状态条：只展示真实计数（台账派生），花费与余额无真实来源不展示。
    private var globalStatusStrip: some View {
        let approvalCount = store.state.approvals.filter { $0.resolvedAt == nil }.count
        let acceptanceCount = store.visibleTasks.filter { $0.status == .awaitingAcceptance }.count
        let runningCount = activeTasks.count
        return HStack(spacing: 10) {
            statusChip(count: approvalCount, label: "等我拍板", tint: HubTheme.warning)
            statusChip(count: acceptanceCount, label: "等我验收", tint: HubTheme.accent)
            statusChip(count: runningCount, label: "在跑", tint: HubTheme.success)
        }
    }

    private func statusChip(count: Int, label: String, tint: Color) -> some View {
        Button { navigate(.board) } label: {
            HStack(spacing: 5) {
                Text("\(count)").font(.system(size: 12, weight: .semibold)).monospacedDigit()
                Text(label).font(.system(size: 11))
            }
            .foregroundStyle(count > 0 ? tint : HubTheme.textTertiary)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background((count > 0 ? tint : HubTheme.textTertiary).opacity(0.10), in: Capsule())
        }.buttonStyle(.plain).help(label + "，点击查看任务看板")
    }

    /// 收集箱：碎片一句话进箱，立项走"新建任务"对话框。
    private var inboxCapture: some View {
        Button { inboxOpen.toggle() } label: {
            Image(systemName: "tray.and.arrow.down").font(.system(size: 13))
        }.buttonStyle(.plain).foregroundStyle(HubTheme.textSecondary).help("收集箱：丢进碎片，稍后整理成任务")
        .popover(isPresented: $inboxOpen, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 10) {
                Text("收集箱").font(.system(size: 13, weight: .semibold))
                TextField("一句话记下，稍后整理成任务", text: $inboxText, axis: .vertical)
                    .lineLimit(2...4).textFieldStyle(.roundedBorder)
                HStack {
                    Text("进箱为草稿，不会自动执行").font(.system(size: 11)).foregroundStyle(HubTheme.textTertiary)
                    Spacer()
                    Button("丢进收集箱") { submitInbox() }
                        .disabled(inboxText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }.padding(14).frame(width: 320)
        }
    }

    private func submitInbox() {
        guard let project = store.selectedProjectID ?? store.scopedProjects.first?.id else {
            store.errorMessage = "没有可用项目，先在左侧建立项目。"; return
        }
        act {
            _ = try store.createTask(projectID: project, goal: inboxText.trimmingCharacters(in: .whitespacesAndNewlines))
            inboxText = ""; inboxOpen = false
        }
    }

    @ViewBuilder private var content: some View {
        switch store.page {
        case .stack: ProjectToolStackView(store: store)
        case .discussion: Color.clear
        case .tasks, .workflow, .board:
            VStack(spacing: 0) {
                HStack {
                    Text("项目任务").font(.system(size: 12, weight: .semibold)).foregroundStyle(HubTheme.textSecondary)
                    if store.page != .board {
                        Picker("生命周期", selection: $lifecycleFilter) {
                            Text("全部阶段").tag(Optional<WorkbenchTaskLifecycle>.none)
                            ForEach(WorkbenchTaskLifecycle.allCases, id: \.self) { Text($0.label).tag(Optional($0)) }
                        }.labelsHidden().frame(maxWidth: 140)
                    }
                    Spacer()
                    Picker("任务显示方式", selection: Binding(get: { store.page == .board ? "看板" : "列表" }, set: { store.page = $0 == "看板" ? .board : .tasks })) {
                        Text("列表").tag("列表"); Text("看板").tag("看板")
                    }.pickerStyle(.segmented).labelsHidden().frame(width: 130)
                }.padding(.horizontal, 16).padding(.vertical, 10)
                if store.page == .board { WorkbenchBoardView(store: store) }
                else { taskArea(workflow: store.page == .workflow) }
            }
        case .archive: ProjectArchiveView(store: store)
        case .resources:
            IntegrationsView(initialSelection: store.selectedLibraryID, onAttachURL: store.selectedProjectID == nil ? nil : { source, location in
                act { try store.attachReference(source: source, location: location) }
            }, onOpenInHub: onOpenInHub).id(store.selectedLibraryID)
        case .capabilities:
            WorkbenchManagementView(scopeChoices: [.init(id: "global", name: "全局")]
                + store.state.projects.map { .init(id: "project:" + $0.id.uuidString, name: "项目：" + $0.name) }
                + store.state.tasks.filter { $0.status != .archived }.map { .init(id: "task:" + $0.id.uuidString, name: "任务：" + $0.title) })
        case .network: WorkbenchNetworkView()
        case .control: HubControlView(workbench: store, execution: execution, initialPanel: "Gateway / API")
        }
    }

    private var focusStrip: some View {
        HStack(spacing: 10) {
            if let task = needsAttention.first ?? activeTasks.first ?? store.selectedTask ?? store.visibleTasks.first(where: { $0.status != .done }) {
                Image(systemName: needsAttention.contains(where: { $0.id == task.id }) ? "exclamationmark.circle" : "circle.dotted")
                    .foregroundStyle(needsAttention.isEmpty ? HubTheme.accent : HubTheme.warning)
                VStack(alignment: .leading, spacing: 3) {
                    Text(needsAttention.contains(where: { $0.id == task.id }) ? "需要你处理" : "继续工作")
                        .font(.system(size: 9)).foregroundStyle(HubTheme.textTertiary)
                    Text(task.title).font(.caption).lineLimit(1)
                }
                Spacer(minLength: 2)
                Text(task.status.label).font(.caption2).foregroundStyle(HubTheme.textSecondary)
                Button("查看") { store.selectTask(task.id); onShowOverview() }.controlSize(.small)
            } else {
                Image(systemName: "text.bubble").foregroundStyle(HubTheme.accent)
                Text(store.selectedProject == nil ? "选择左侧项目，或在这里记录全局想法。" : "从下面交代目标，讨论后创建任务。")
                    .font(.caption).foregroundStyle(HubTheme.textSecondary)
                Spacer()
            }
        }.padding(.horizontal, 20).padding(.vertical, 10)
        .background(HubTheme.surface.opacity(0.5))
    }

    private var activityBar: some View {
        HStack(spacing: 12) {
            Button { activityOpen.toggle() } label: {
                HStack(spacing: 6) {
                    Circle().fill(needsAttention.isEmpty ? HubTheme.success : HubTheme.warning).frame(width: 5, height: 5)
                    Text(needsAttention.isEmpty ? "当前项目无待处理事项" : "\(needsAttention.count) 项需要处理")
                    Text("· 后台 \(execution.activeCount + control.activeRequestIDs.count + (mcp.running ? 1 : 0))")
                }
            }.buttonStyle(.plain)
            .popover(isPresented: $activityOpen, arrowEdge: .top) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("运行与待处理").font(.headline)
                    Text("当前范围 \(activeTasks.count) 项运行 · 全局 API \(control.activeRequestIDs.count) · MCP \(mcp.running ? 1 : 0)")
                        .font(.caption).foregroundStyle(.secondary)
                    if needsAttention.isEmpty && activeTasks.isEmpty { Text("当前项目没有待处理或运行中的任务。").font(.callout) }
                    ScrollView {
                        ForEach(needsAttention + activeTasks) { task in
                            Button { activityOpen = false; store.selectTask(task.id); onShowOverview() } label: {
                                HStack { Text(task.title).lineLimit(2); Spacer(); Text(task.status.label).font(.caption) }
                            }.buttonStyle(.plain).padding(.vertical, 6)
                        }
                    }.frame(maxHeight: 220)
                    HStack {
                        Text("后台任务并发").font(.caption)
                        Stepper("\(execution.maxActiveTasks)", value: $execution.maxActiveTasks, in: 1...4)
                    }
                    if execution.activeCount > 0 || !control.activeRequestIDs.isEmpty || mcp.running {
                        Button("停止 Hub 全部后台操作", role: .destructive) {
                            control.cancelRequests(); mcp.cancel(); Task { await execution.cancelAllAndWait() }
                        }
                    }
                }.padding(18).frame(width: 360)
            }
            Spacer()
            Button("查看任务看板") { navigate(.board) }.buttonStyle(.plain)
        }.font(.system(size: 11)).foregroundStyle(HubTheme.textSecondary)
            .padding(.horizontal, 16).padding(.vertical, 8).background(HubTheme.panel)
    }

    private func taskArea(workflow: Bool) -> some View {
        HSplitView {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(store.visibleTasks.filter { lifecycleFilter == nil || $0.effectiveLifecycle == lifecycleFilter }) { task in
                        Button { store.selectTask(task.id, page: .tasks) } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(task.title).font(.system(size: 12.5, weight: .medium)).lineLimit(2)
                                Text(task.status.label).font(.system(size: 11)).foregroundStyle(.secondary)
                            }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                                .background(store.selectedTaskID == task.id ? HubTheme.hover : HubTheme.surface).cornerRadius(8)
                        }.buttonStyle(.plain)
                    }
                    if store.visibleTasks.isEmpty { Text("在工作台交代目标，或新建任务。").font(.caption).foregroundStyle(.secondary) }
                }.padding(12)
            }.frame(minWidth: 130, idealWidth: 150, maxWidth: 190)
            if let task = store.selectedTask, store.isInScope(projectID: task.projectID) {
                WorkbenchTaskDetailView(store: store, task: task, initialTab: workflow ? "计划" : "目标").id(task.id.uuidString + (workflow ? "workflow" : "task"))
            } else {
                VStack(spacing: 12) { Image(systemName: "list.bullet.rectangle").font(.largeTitle); Text("选择任务，查看目标、工作流与结果") }
                    .font(.callout).foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
    private var taskSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("新建工作任务").font(.title2)
            Picker("所属项目", selection: $taskProject) { ForEach(store.scopedProjects) { Text($0.name).tag(Optional($0.id)) } }
            TextField("任务目标", text: $taskGoal, axis: .vertical).lineLimit(3...6).textFieldStyle(.roundedBorder)
            Text("创建后可讨论要求、编排工作流并确认执行。").font(.caption).foregroundStyle(.secondary)
            HStack { Button("取消") { newTask = false }; Spacer(); Button("创建任务") { act {
                guard let project = taskProject else { return }; let id = try store.createTask(projectID: project, goal: taskGoal); store.selectTask(id); onShowOverview(); newTask = false
            } }.disabled(taskGoal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
        }.padding(24).frame(width: 460)
    }
    private func act(_ action: () throws -> Void) { do { try action() } catch { store.errorMessage = error.localizedDescription } }
}

struct WorkbenchBoardView: View {
    @ObservedObject var store: WorkbenchStore
    @State private var groupByProject = false
    @State private var assigneeFilter: String? = nil
    private let columns: [(String, Color, [WorkbenchTaskStatus])] = [
        ("待办", HubTheme.textTertiary, [.draft, .ready]),
        ("进行中", HubTheme.accent, [.running, .cancelling]),
        ("待确认 / 验收", HubTheme.warning, [.awaitingApproval, .awaitingAcceptance]),
        ("阻塞 / 需处理", HubTheme.danger, [.blocked, .failed, .interrupted, .cancelled]),
        ("已完成", HubTheme.success, [.done])
    ]
    /// 组合筛选的可选项：来自当前范围任务的真实负责人，不预编清单。
    private var assigneeOptions: [String] {
        var seen = Set<String>()
        return store.visibleTasks.compactMap { task in
            let raw = task.assigneeID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let name = raw.isEmpty ? task.effectiveOwnerType.label : raw
            return seen.insert(name).inserted ? name : nil
        }
    }
    private func filtered(_ tasks: [WorkbenchTask]) -> [WorkbenchTask] {
        guard let filter = assigneeFilter else { return tasks }
        return tasks.filter { task in
            let raw = task.assigneeID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return (raw.isEmpty ? task.effectiveOwnerType.label : raw) == filter
        }
    }
    /// 列内排序：优先级先行，同优先级按最近更新。
    private func ordered(_ tasks: [WorkbenchTask]) -> [WorkbenchTask] {
        tasks.sorted { a, b in
            if a.priority != b.priority { return a.priority < b.priority }
            return a.updatedAt > b.updatedAt
        }
    }
    private func projectName(_ id: UUID) -> String {
        store.state.projects.first { $0.id == id }?.name ?? "未分组项目"
    }

    var body: some View {
        VStack(spacing: 0) {
            BoardApprovalIntercept(store: store)
            toolbar
            ScrollView([.horizontal, .vertical]) {
                HStack(alignment: .top, spacing: 14) {
                    ForEach(columns, id: \.0) { title, tint, statuses in
                        let tasks = filtered(store.visibleTasks.filter { statuses.contains($0.status) })
                        VStack(alignment: .leading, spacing: 10) {
                            HStack(spacing: 7) {
                                Circle().fill(tint).frame(width: 7, height: 7)
                                Text(title).font(.system(size: 13, weight: .semibold))
                                Spacer()
                                Text("\(tasks.count)")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(tint)
                                    .padding(.horizontal, 7).padding(.vertical, 2)
                                    .background(tint.opacity(0.12), in: Capsule())
                            }
                            if groupByProject { groupedCards(tasks, tint: tint) }
                            else { ForEach(ordered(tasks)) { BoardCardView(store: store, task: $0, tint: tint) } }
                            if tasks.isEmpty {
                                Text("暂无任务").font(.caption).foregroundStyle(HubTheme.textTertiary)
                                    .frame(maxWidth: .infinity).padding(.vertical, 14)
                                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(HubTheme.border.opacity(0.7), style: StrokeStyle(lineWidth: 1, dash: [4])))
                            }
                        }
                        .padding(12)
                        .frame(width: 232, alignment: .topLeading)
                        .background(tint.opacity(0.045), in: RoundedRectangle(cornerRadius: 14))
                    }
                }.padding(20)
            }
        }.background(HubTheme.background)
    }

    private var toolbar: some View {
        HStack(spacing: 10) {
            Button { groupByProject.toggle() } label: {
                Label("按项目分组", systemImage: groupByProject ? "rectangle.grid.1x2.fill" : "rectangle.grid.1x2")
                    .font(.system(size: 12, weight: groupByProject ? .semibold : .regular))
            }.buttonStyle(.plain).foregroundStyle(groupByProject ? HubTheme.accent : HubTheme.textSecondary)
            Menu {
                Button("全部组合") { assigneeFilter = nil }
                ForEach(assigneeOptions, id: \.self) { name in Button(name) { assigneeFilter = name } }
            } label: {
                Label(assigneeFilter ?? "全部组合", systemImage: "person.2")
                    .font(.system(size: 12, weight: assigneeFilter == nil ? .regular : .semibold))
            }.menuStyle(.borderlessButton).foregroundStyle(assigneeFilter == nil ? HubTheme.textSecondary : HubTheme.accent)
            Spacer()
        }
        .padding(.horizontal, 20).padding(.vertical, 8)
        .overlay(alignment: .bottom) { Divider().overlay(HubTheme.border) }
    }

    /// 状态列 × 项目泳道：同一列内按项目分段。
    private func groupedCards(_ tasks: [WorkbenchTask], tint: Color) -> some View {
        let groups = Dictionary(grouping: ordered(tasks), by: \.projectID)
        let order = groups.keys.sorted { projectName($0) < projectName($1) }
        return ForEach(order, id: \.self) { projectID in
            Text(projectName(projectID)).font(.system(size: 11, weight: .medium))
                .foregroundStyle(HubTheme.textSecondary).padding(.top, 4)
            ForEach(groups[projectID] ?? []) { BoardCardView(store: store, task: $0, tint: tint) }
        }
    }
}

struct ProjectArchiveView: View {
    @ObservedObject var store: WorkbenchStore
    @State private var summary = ""
    @State private var query = ""
    private var archiveTasks: [WorkbenchTask] {
        store.scopedTasks.filter { task in
            guard [.done, .archived].contains(task.status) else { return false }
            let text = [task.title, task.goal, task.archiveConclusion ?? "", task.acceptanceNote, task.decisionSummary,
                        task.runs.flatMap(\.artifacts).map(\.title).joined(separator: " ")].joined(separator: " ")
            return query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.localizedCaseInsensitiveContains(query.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let project = store.selectedProject {
                    TextField("项目复盘、已确认结论与下一步", text: $summary, axis: .vertical).lineLimit(5...12).textFieldStyle(.roundedBorder)
                    Button("保存项目总结") {
                        var value = project; var setup = value.setup ?? .init(); setup.summary = summary; value.setup = setup
                        do { try store.updateProject(value) } catch { store.errorMessage = error.localizedDescription }
                    }
                }
                TextField("搜索任务、结论与产物关键词", text: $query).textFieldStyle(.roundedBorder)
                ForEach(archiveTasks) { task in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack { Text(task.title).font(.system(size: 14, weight: .semibold)); Spacer(); Text(task.status.label).font(.system(size: 11)).foregroundStyle(HubTheme.textSecondary) }
                        if let conclusion = task.archiveConclusion, !conclusion.isEmpty { Text(conclusion).font(.system(size: 13)).textSelection(.enabled) }
                        else if !task.acceptanceNote.isEmpty { Text(task.acceptanceNote).font(.system(size: 13)).textSelection(.enabled) }
                        if let date = task.archivedAt { Text("归档于 " + date.formatted(date: .abbreviated, time: .shortened)).font(.system(size: 11)).foregroundStyle(.secondary) }
                        Text("\(task.runs.count) 次运行 · \(task.plans.count) 个计划版本").font(.system(size: 11)).foregroundStyle(.secondary)
                        ForEach(task.runs.flatMap(\.artifacts)) { artifact in
                            HStack { Text(artifact.title).font(.system(size: 12)); WorkbenchReferenceButton(location: artifact.location) }
                        }
                        HStack {
                            if task.status == .archived { Button("恢复任务") { act { try store.restore(taskID: task.id); store.selectTask(task.id) } } }
                            else { Button("归档") { act { try store.archive(taskID: task.id) } }; Button("查看验收与保存模板") { store.selectTask(task.id); store.page = .tasks } }
                        }
                    }.padding(14).frame(maxWidth: .infinity, alignment: .leading).hubPanel()
                }
                if archiveTasks.isEmpty { Text(query.isEmpty ? "尚无已验收或归档任务。" : "没有匹配的结论或产物。").font(.system(size: 13)).foregroundStyle(.secondary) }
                Text("工作流模板").font(.system(size: 13, weight: .semibold))
                ForEach(store.state.templates) { template in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(template.name)
                        ForEach(template.versions) { version in
                            Menu("v\(version.revision) · 应用到任务") {
                                ForEach(store.visibleTasks.filter { !$0.status.active }) { task in
                                    Button(task.title) { act { try store.applyTemplate(taskID: task.id, templateID: template.id, version: version.revision); store.selectTask(task.id, page: .workflow) } }
                                }
                            }
                        }
                    }
                }
            }.padding(22).frame(maxWidth: .infinity, alignment: .leading)
        }.onAppear { summary = store.selectedProject?.setup?.summary ?? "" }
            .onChange(of: store.selectedProjectID) { _ in summary = store.selectedProject?.setup?.summary ?? "" }
    }
    private func act(_ action: () throws -> Void) { do { try action() } catch { store.errorMessage = error.localizedDescription } }
}
