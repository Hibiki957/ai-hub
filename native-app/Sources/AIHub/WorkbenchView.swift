import AppKit
import SwiftUI

private func nodeKindTint(_ kind: WorkbenchNodeKind) -> Color {
    switch kind {
    case .input: return HubTheme.textTertiary
    case .agent: return HubTheme.accent
    case .tool: return HubTheme.warning
    case .approval: return HubTheme.danger
    case .condition: return Color(hex: 0x7C6BD9)
    case .parallel, .join: return Color(hex: 0x2E8C8C)
    case .output: return HubTheme.success
    }
}
private func nodeKindSymbol(_ kind: WorkbenchNodeKind) -> String {
    switch kind {
    case .input: return "tray.and.arrow.down"
    case .agent: return "cpu"
    case .tool: return "wrench"
    case .approval: return "hand.raised"
    case .condition: return "arrow.triangle.branch"
    case .parallel: return "square.split.2x1"
    case .join: return "arrow.triangle.merge"
    case .output: return "tray.and.arrow.up"
    }
}

struct WorkbenchTaskDetailView: View {
    @ObservedObject var store: WorkbenchStore
    let task: WorkbenchTask
    @State private var draft: WorkbenchTask
    @State private var tab = "目标"
    @State private var acceptanceNote = ""
    @State private var templateName = ""
    @State private var editingRequirements = false
    init(store: WorkbenchStore, task: WorkbenchTask, initialTab: String = "目标") { self.store = store; self.task = task; _draft = State(initialValue: task); _tab = State(initialValue: initialTab) }
    private func act(_ action: () throws -> Void) { do { try action() } catch { store.errorMessage = error.localizedDescription } }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(task.title).font(.system(size: 19, weight: .semibold))
                    HStack(spacing: 6) {
                        HubTheme.StatusChip(text: task.status.label, tint: task.status.tint)
                        HubTheme.StatusChip(text: "计划 v\(task.currentPlan.revision)", tint: HubTheme.accent)
                    }
                }
                Spacer()
                if task.status.active {
                    Button(role: .destructive) { act { try store.cancel(taskID: task.id) } } label: {
                        Label("取消运行", systemImage: "stop.circle").font(.system(size: 11, weight: .medium))
                    }.buttonStyle(.bordered)
                } else {
                    Button { act { try store.requestRun(taskID: task.id) } } label: {
                        Label("执行已确认计划", systemImage: "play.fill")
                            .font(.system(size: 11, weight: .semibold))
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .foregroundStyle(.white)
                            .background(HubTheme.primaryGradient, in: RoundedRectangle(cornerRadius: 9))
                    }
                    .buttonStyle(.plain)
                    .disabled(task.status == .archived || task.confirmedRevision != task.currentPlan.revision || !task.policy.confirmed)
                    .opacity(task.status != .archived && task.confirmedRevision == task.currentPlan.revision && task.policy.confirmed ? 1 : 0.45)
                }
                Menu { Button("归档") {
                    if let conclusion = Prompt.text(title: "归档结论", message: "记录已采用的结果或结束原因，产物保留原位置", initial: task.acceptanceNote.isEmpty ? task.decisionSummary : task.acceptanceNote) {
                        act { try store.archive(taskID: task.id, conclusion: conclusion) }
                    }
                }; Button("导出任务记录") { export() } } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(HubTheme.textSecondary)
                        .frame(width: 28, height: 28)
                        .background(HubTheme.surface, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(HubTheme.border, lineWidth: 1))
                }.menuStyle(.borderlessButton).frame(width: 28)
            }
            if task.status.active {
                Text("本次运行保持原计划；修改要求用于后续运行。需要停止时可取消运行。")
                    .font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
            }
            Picker("任务视图", selection: $tab) { ForEach(["目标", "计划", "权限", "产物", "时间线"], id: \.self) { Text($0).tag($0) } }.pickerStyle(.segmented).labelsHidden()
            if task.status == .awaitingApproval { approvals }
            ScrollViewReader { proxy in
                ScrollView {
                    Group {
                        switch tab {
                        case "计划": WorkbenchPlanEditor(store: store, task: task)
                        case "权限": WorkbenchPolicyEditor(store: store, task: task)
                        case "产物": results
                        case "时间线": timeline
                        default: details
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
                        .id("task-detail-top")
                }
                .onChange(of: editingRequirements) { _ in proxy.scrollTo("task-detail-top", anchor: .top) }
                .onChange(of: tab) { _ in proxy.scrollTo("task-detail-top", anchor: .top) }
            }
        }.padding(20).frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
        .background(HubTheme.background)
    }

    private func card<Content: View>(title: String, symbol: String, tint: Color = HubTheme.accent, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HubTheme.SectionHeader(title: title, symbol: symbol, tint: tint)
            content()
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading).hubPanel()
    }

    @ViewBuilder private var details: some View {
        if editingRequirements {
            requirementsForm
        } else {
            WorkbenchTaskSummaryView(
                task: task,
                projectName: store.state.projects.first { $0.id == task.projectID }?.name ?? "",
                onEdit: { draft = task; editingRequirements = true },
                onOpenPlan: { tab = "计划" },
                onOpenResults: { tab = "产物" }
            )
        }
    }

    private var requirementsForm: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("编辑任务要求").font(.system(size: 15, weight: .semibold))
                Spacer()
                Button("取消编辑") { editingRequirements = false }.font(.system(size: 12))
            }
            card(title: "基本信息", symbol: "info.circle") {
                TextField("任务名称", text: $draft.title).textFieldStyle(.roundedBorder)
                Picker("主项目", selection: $draft.projectID) { ForEach(store.state.projects) { Text($0.name).tag($0.id) } }
                HStack {
                    Picker("优先级", selection: $draft.priority) { Text("今天优先").tag(0); Text("高").tag(1); Text("普通").tag(2); Text("低").tag(3) }
                    Toggle("期限", isOn: Binding(get: { draft.deadline != nil }, set: { draft.deadline = $0 ? Date() : nil }))
                    if draft.deadline != nil { DatePicker("", selection: Binding(get: { draft.deadline ?? Date() }, set: { draft.deadline = $0 }), displayedComponents: .date).labelsHidden() }
                }
                HStack {
                    Picker("负责人", selection: Binding(get: { draft.effectiveOwnerType }, set: { draft.ownerType = $0 })) {
                        ForEach(WorkbenchOwnerType.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                    Picker("介入档位", selection: Binding(get: { draft.effectiveTier }, set: { draft.tier = $0 })) {
                        ForEach(WorkbenchInterventionTier.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                }
                if draft.effectiveOwnerType == .agent {
                    Picker("任务负责人入口", selection: $draft.assigneeID) {
                        Text("待选择").tag(Optional<String>.none)
                        ForEach(ToolCatalog.shared.agents) { Text($0.name).tag(Optional($0.id)) }
                    }
                }
                Text("生命周期：" + task.effectiveLifecycle.label + " · 档位不更改现有执行授权")
                    .font(.caption).foregroundStyle(.secondary)
                TextField("标签，用逗号分隔", text: Binding(get: { draft.tags.joined(separator: ", ") }, set: { draft.tags = $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) } })).textFieldStyle(.roundedBorder)
            }
            card(title: "目标与验收", symbol: "target") {
                field("目标", text: $draft.goal)
                field("输入资料与范围", text: $draft.inputs)
                field("交付物", text: $draft.deliverables)
                field("验收条件", text: $draft.acceptance)
                field("约束", text: $draft.constraints)
                field("讨论与决策摘要", text: $draft.decisionSummary)
            }
            card(title: "资料引用", symbol: "link") {
                HStack {
                    Text("保留原应用为资料主存放处；这里只保存链接与说明，不会读取整库。").font(.caption).foregroundStyle(HubTheme.textTertiary)
                    Spacer()
                    Button("添加引用") { draft.references.append(WorkbenchReference(title: "", source: "", location: "")) }.font(.caption)
                }
                ForEach($draft.references) { $reference in
                    VStack(spacing: 5) {
                        HStack { TextField("标题", text: $reference.title); TextField("来源，例如 Zotero", text: $reference.source); Button { draft.references.removeAll { $0.id == reference.id } } label: { Image(systemName: "minus.circle").foregroundStyle(HubTheme.textTertiary) }.buttonStyle(.plain) }
                        TextField("文件路径或应用链接", text: $reference.location)
                        TextField("引用说明", text: $reference.note)
                        HStack {
                            Text(reference.effectiveDepth.rawValue + " · " + reference.effectiveDepth.label).font(.caption2).foregroundStyle(.secondary)
                            WorkbenchReferenceButton(location: reference.location)
                        }
                    }.textFieldStyle(.roundedBorder)
                    .padding(10).background(HubTheme.background, in: RoundedRectangle(cornerRadius: 9))
                }
            }
            Button { act { try store.updateDetails(draft); editingRequirements = false } } label: {
                Text("保存要求与关联").font(.system(size: 12, weight: .semibold))
                    .padding(.horizontal, 16).padding(.vertical, 8)
                    .foregroundStyle(.white)
                    .background(HubTheme.primaryGradient, in: RoundedRectangle(cornerRadius: 9))
            }.buttonStyle(.plain)
        }
    }
    private func field(_ title: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 5) { Text(title).font(.caption.weight(.medium)).foregroundStyle(HubTheme.textSecondary); TextField(title, text: text, axis: .vertical).lineLimit(2...6).textFieldStyle(.roundedBorder) }
    }
    private var approvals: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(store.state.approvals.filter { approval in approval.resolvedAt == nil && task.runs.contains { $0.id == approval.runID } }) { approval in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "hand.raised.fill")
                        .font(.system(size: 13))
                        .foregroundStyle(HubTheme.warning)
                        .frame(width: 30, height: 30)
                        .background(HubTheme.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: 9))
                    VStack(alignment: .leading, spacing: 6) {
                        Text(approval.summary).font(.system(size: 13, weight: .semibold))
                        Text(approval.details).font(.caption).textSelection(.enabled)
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            VStack(alignment: .leading, spacing: 5) {
                                Text(context.date >= approval.expiresAt ? "审批已过期，不能再提交决定" : "仅本次动作 · 到期 \(approval.expiresAt.formatted(date: .omitted, time: .shortened))").font(.caption2).foregroundStyle(HubTheme.textTertiary)
                                HStack(spacing: 10) {
                                    Button("拒绝") { act { try store.resolveApproval(approval.id, allowed: false) } }
                                    Button("批准这一次") { act { try store.resolveApproval(approval.id, allowed: true) } }.buttonStyle(.borderedProminent).tint(HubTheme.accent)
                                }.disabled(context.date >= approval.expiresAt)
                            }
                        }
                    }
                }
            }
        }
        .padding(13).frame(maxWidth: .infinity, alignment: .leading)
        .background(HubTheme.sunlight.opacity(0.25), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(HubTheme.warning.opacity(0.35), lineWidth: 1))
    }
    private var results: some View {
        VStack(alignment: .leading, spacing: 14) {
            if task.runs.isEmpty { Text("尚无执行产物。").foregroundStyle(HubTheme.textTertiary) }
            ForEach(task.runs.reversed()) { run in
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("计划 v\(run.plan.revision)").font(.system(size: 13, weight: .semibold))
                        HubTheme.StatusChip(text: run.status.rawValue, tint: run.status == .completed ? HubTheme.success : (run.status.terminal ? HubTheme.danger : HubTheme.accent))
                        Spacer()
                        Text(run.startedAt.formatted(date: .abbreviated, time: .shortened)).font(.caption2).foregroundStyle(HubTheme.textTertiary)
                    }
                    Text("运行时：\(run.runtime ?? "历史未知") · 形态：\(run.form?.label ?? "历史未知")").font(.caption2).foregroundStyle(HubTheme.textTertiary)
                    Text(run.summary.isEmpty ? "尚无结果摘要" : run.summary).font(.callout).textSelection(.enabled)
                    Text("用量与成本：执行桥未提供时为未知；不推测订阅余额。").font(.caption2).foregroundStyle(HubTheme.textTertiary)
                    ForEach(run.artifacts) { artifact in
                        VStack(alignment: .leading, spacing: 3) {
                            Text("\(artifact.title) · v\(artifact.version)").font(.caption.weight(.medium))
                            Text(artifact.location).font(.caption2).textSelection(.enabled)
                            Text(artifact.verification).font(.caption2).foregroundStyle(HubTheme.textTertiary)
                            WorkbenchReferenceButton(location: artifact.location)
                        }
                        .padding(9).frame(maxWidth: .infinity, alignment: .leading)
                        .background(HubTheme.background, in: RoundedRectangle(cornerRadius: 8))
                    }
                }.padding(13).frame(maxWidth: .infinity, alignment: .leading).hubPanel()
            }
            if [.failed, .interrupted, .blocked, .cancelled].contains(task.status), let last = task.runs.last {
                Text("重试创建新运行并保留旧记录；含写入或外部动作的运行不会自动重放，请核对后另建后续任务。不声称恢复旧进程。").font(.caption).foregroundStyle(HubTheme.textTertiary)
                Button("按当前已确认计划重试") { act { try store.requestRun(taskID: task.id, resumeFromRunID: last.id) } }
            }
            if task.status == .awaitingAcceptance {
                card(title: "验收", symbol: "checkmark.seal", tint: HubTheme.warning) {
                    field("验收依据或退回原因", text: $acceptanceNote)
                    HStack(spacing: 10) {
                        Button("退回修改") { act { try store.verify(taskID: task.id, accepted: false, note: acceptanceNote) } }
                        Button("验收通过") { act { try store.verify(taskID: task.id, accepted: true, note: acceptanceNote) } }.buttonStyle(.borderedProminent).tint(HubTheme.success)
                    }
                }
            }
            if task.status == .done {
                card(title: "模板", symbol: "doc.on.doc", tint: HubTheme.success) {
                    Text("验收记录：\(task.acceptanceNote)").font(.caption)
                    TextField("模板名称", text: $templateName).textFieldStyle(.roundedBorder)
                    HStack {
                        Button("保存成功流程模板") { act { try store.saveTemplate(taskID: task.id, name: templateName) } }
                        Menu("追加模板版本") { ForEach(store.state.templates) { template in Button(template.name) { act { try store.saveTemplate(taskID: task.id, name: template.name, updating: template.id) } } } }
                    }
                }
            }
        }
    }
    private var timeline: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(task.events.reversed().enumerated()), id: \.element.id) { index, event in
                HStack(alignment: .top, spacing: 10) {
                    VStack(spacing: 0) {
                        Circle().fill(event.evidence == .userConfirmed ? HubTheme.success : HubTheme.accent).frame(width: 8, height: 8).padding(.top, 5)
                        if index < task.events.count - 1 {
                            Rectangle().fill(HubTheme.border).frame(width: 1.5).frame(maxHeight: .infinity)
                        }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(event.summary).font(.callout).textSelection(.enabled)
                        Text("\(event.createdAt.formatted(date: .abbreviated, time: .shortened)) · \(event.evidence.label) · \(event.kind)").font(.caption2).foregroundStyle(HubTheme.textTertiary)
                    }.padding(.bottom, 14)
                }
            }
        }
    }
    private func export() {
        let panel = NSSavePanel(); panel.nameFieldStringValue = "task-\(task.id.uuidString).json"
        if panel.runModal() == .OK, let url = panel.url { act { try store.exportTask(task.id, to: url) } }
    }
}

struct WorkbenchPlanEditor: View {
    @ObservedObject var store: WorkbenchStore
    let task: WorkbenchTask
    @State private var nodes: [WorkbenchNode]
    @State private var summary: String
    init(store: WorkbenchStore, task: WorkbenchTask) { self.store = store; self.task = task; _nodes = State(initialValue: task.currentPlan.nodes); _summary = State(initialValue: task.currentPlan.summary) }
    private func act(_ action: () throws -> Void) { do { try action() } catch { store.errorMessage = error.localizedDescription } }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                HStack(spacing: 8) {
                    Text("工作流").font(.system(size: 15, weight: .semibold))
                    HubTheme.StatusChip(text: "v\(task.currentPlan.revision)", tint: HubTheme.accent)
                    if task.confirmedRevision == task.currentPlan.revision { HubTheme.StatusChip(text: "已确认", tint: HubTheme.success) }
                }
                Spacer()
                Menu {
                    ForEach(WorkbenchNodeKind.allCases, id: \.self) { kind in
                        Button { nodes.append(WorkbenchNode(title: kind.label, kind: kind)) } label: { Label(kind.label, systemImage: nodeKindSymbol(kind)) }
                    }
                } label: {
                    Label("添加步骤", systemImage: "plus").font(.system(size: 11, weight: .medium))
                }.menuStyle(.borderlessButton)
            }
            TextField("计划摘要", text: $summary, axis: .vertical).textFieldStyle(.roundedBorder)
            if store.onProposePlan != nil { Button("请求 Agent 提出计划") { store.onProposePlan?(task.id) } }
            else { Text("当前可手动搭建计划；自动规划尚未接入。计划建议不会直接执行。").font(.caption).foregroundStyle(HubTheme.textTertiary) }
            Text("受控命令已验证；主力 Agent 的新沙箱模型调用仍待逐个联调。ZCode 桌面与终端入口、Hub 适配代码及离线 fixture 已就绪，真实模型任务尚未验收；原有交互终端可用，但不属于任务沙箱。")
                .font(.caption).foregroundStyle(HubTheme.textTertiary)
            if nodes.isEmpty { Button("插入只读并行验证示例") { nodes = Self.readOnlyExample(); summary = "示例：两个只读工具并行，再汇合输出。需另行确认命令权限。" } }
            ForEach($nodes) { $node in
                WorkbenchNodeEditor(node: $node, nodes: nodes) { nodes.removeAll { $0.id == node.id } }
            }
            if !nodes.isEmpty {
                HubTheme.SectionHeader(title: "依赖视图", symbol: "point.3.connected.trianglepath.dotted")
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(nodes) { node in
                        HStack(alignment: .center, spacing: 8) {
                            Image(systemName: nodeKindSymbol(node.kind))
                                .font(.system(size: 9))
                                .foregroundStyle(nodeKindTint(node.kind))
                                .frame(width: 18, height: 18)
                                .background(nodeKindTint(node.kind).opacity(0.10), in: RoundedRectangle(cornerRadius: 5))
                            Text(node.dependsOn.isEmpty ? "起点" : node.dependsOn.map { id in nodes.first { $0.id == id }?.title ?? "失效依赖" }.joined(separator: " + "))
                                .foregroundStyle(HubTheme.textSecondary)
                            Image(systemName: "arrow.right").font(.system(size: 8, weight: .bold)).foregroundStyle(HubTheme.textTertiary)
                            Text(node.title).fontWeight(.medium)
                        }.font(.caption)
                        .padding(.horizontal, 10).padding(.vertical, 7)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(HubTheme.panel.opacity(0.7), in: RoundedRectangle(cornerRadius: 8))
                    }
                }
            }
            HStack(spacing: 10) {
                Button { act { try store.revisePlan(taskID: task.id, nodes: nodes, summary: summary) } } label: {
                    Text("保存为新版本").font(.system(size: 12, weight: .semibold))
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .foregroundStyle(.white)
                        .background(HubTheme.primaryGradient, in: RoundedRectangle(cornerRadius: 9))
                }.buttonStyle(.plain)
                Button(task.confirmedRevision == task.currentPlan.revision ? "已确认 v\(task.currentPlan.revision)" : "确认已保存的 v\(task.currentPlan.revision)") { act { try store.confirmPlan(taskID: task.id) } }
            }
            Text("编辑执行者即改派后续步骤；已有运行不可变。未保存的编辑不会执行，修改后需要重新确认。").font(.caption).foregroundStyle(HubTheme.textTertiary)
            if task.plans.count > 1 { Text("保留计划版本：" + task.plans.map { "v\($0.revision)" }.joined(separator: " · ")).font(.caption2).foregroundStyle(HubTheme.textTertiary) }
        }.onChange(of: task.currentPlan.revision) { revision in
            // The observed store can publish before the parent refreshes its
            // value-type task. Read the committed version rather than a stale
            // captured task, which otherwise clears the editor after Save.
            guard let saved = store.state.tasks.first(where: { $0.id == task.id })?.currentPlan,
                  saved.revision == revision else { return }
            nodes = saved.nodes; summary = saved.summary
        }
    }
    static func readOnlyExample() -> [WorkbenchNode] {
        let input = WorkbenchNode(title: "任务输入", kind: .input, prompt: "使用任务目标与输入")
        let a = WorkbenchNode(title: "并行检查 A", kind: .tool, dependsOn: [input.id], command: "/usr/bin/printf", arguments: ["AIHub read-only A\\n"])
        let b = WorkbenchNode(title: "并行检查 B", kind: .tool, dependsOn: [input.id], command: "/usr/bin/printf", arguments: ["AIHub read-only B\\n"])
        let join = WorkbenchNode(title: "汇合结果", kind: .join, dependsOn: [a.id, b.id])
        return [input, a, b, join, WorkbenchNode(title: "交付输出", kind: .output, dependsOn: [join.id])]
    }
}

private struct WorkbenchNodeEditor: View {
    @Binding var node: WorkbenchNode
    let nodes: [WorkbenchNode]
    let remove: () -> Void
    private func optional(_ key: WritableKeyPath<WorkbenchNode, String?>) -> Binding<String> { Binding(get: { node[keyPath: key] ?? "" }, set: { node[keyPath: key] = $0.isEmpty ? nil : $0 }) }
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 9) {
                Image(systemName: nodeKindSymbol(node.kind))
                    .font(.system(size: 10))
                    .foregroundStyle(nodeKindTint(node.kind))
                    .frame(width: 24, height: 24)
                    .background(nodeKindTint(node.kind).opacity(0.10), in: RoundedRectangle(cornerRadius: 7))
                TextField("步骤标题", text: $node.title)
                Picker("类型", selection: $node.kind) { ForEach(WorkbenchNodeKind.allCases, id: \.self) { Text($0.label).tag($0) } }.labelsHidden().frame(width: 110)
                Button(action: remove) { Image(systemName: "minus.circle").foregroundStyle(HubTheme.textTertiary) }.buttonStyle(.plain)
            }
            if node.kind == .agent {
                HStack {
                    Picker("执行者", selection: optional(\.agentID)) {
                        Text("请选择").tag("")
                        ForEach(ToolCatalog.shared.agents) { Text($0.name).tag($0.id) }
                    }
                    TextField("角色", text: $node.role)
                }
                TextField("指定模型（可选）", text: optional(\.model))
            }
            TextField("步骤说明 / 交接要求", text: $node.prompt, axis: .vertical).lineLimit(2...5)
            if node.kind == .tool {
                TextField("命令的绝对路径", text: optional(\.command))
                TextField("参数，每行一个；不通过 shell 拼接", text: Binding(get: { node.arguments.joined(separator: "\n") }, set: { node.arguments = $0.components(separatedBy: "\n") }), axis: .vertical).lineLimit(2...6)
            }
            if node.kind == .condition {
                TextField("步骤 ID contains 文本 / 步骤 ID equals 文本", text: optional(\.condition))
                Text("条件只比较已完成步骤输出；不执行代码。未命中的后继分支跳过。").font(.caption2).foregroundStyle(HubTheme.textTertiary)
                ForEach(nodes.filter { $0.id != node.id }) { source in Text("\(source.title)：\(source.id)").font(.caption2).textSelection(.enabled) }
            }
            TextField("此步骤验收规则", text: $node.acceptance)
            HStack {
                Picker("副作用", selection: $node.sideEffect) { ForEach(WorkbenchSideEffect.allCases, id: \.self) { Text($0.label).tag($0) } }
                Stepper("超时 \(node.timeoutMs / 1000)s", value: $node.timeoutMs, in: 1000...1_800_000, step: 1000)
                Stepper("重试 \(node.retries)", value: $node.retries, in: 0...2).disabled(node.sideEffect != .none)
            }.font(.caption)
            if nodes.count > 1 {
                Text("依赖步骤（多选即可并行 / 汇合）").font(.caption).foregroundStyle(HubTheme.textSecondary)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 130), alignment: .leading)]) {
                    ForEach(nodes.filter { $0.id != node.id }) { candidate in
                        Toggle(candidate.title, isOn: Binding(get: { node.dependsOn.contains(candidate.id) }, set: { value in if value { if !node.dependsOn.contains(candidate.id) { node.dependsOn.append(candidate.id) } } else { node.dependsOn.removeAll { $0 == candidate.id } } })).font(.caption)
                    }
                }
            }
        }.textFieldStyle(.roundedBorder)
        .padding(12).frame(maxWidth: .infinity, alignment: .leading).hubPanel()
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 2)
                .fill(nodeKindTint(node.kind).opacity(0.6))
                .frame(width: 3)
                .padding(.vertical, 10)
        }
        .onChange(of: node.sideEffect) { value in if value != .none { node.retries = 0 } }
    }
}

struct WorkbenchReferenceButton: View {
    @EnvironmentObject private var workbench: WorkbenchStore
    @EnvironmentObject private var model: AppModel
    let location: String
    var body: some View {
        switch WorkbenchReferenceDestination.parse(location) {
        case let .revealFile(url):
            Button("在 Finder 中显示", systemImage: "folder") { NSWorkspace.shared.activateFileViewerSelecting([url]) }.font(.caption)
        case let .openHTTPS(url):
            Button("在 Hub 打开引用", systemImage: "globe") { model.tabStore.openWeb(title: url.host ?? "资料", url: url) }.font(.caption)
        case let .sourceConversation(kind, threadID, messageID):
            Button("查看来源对话", systemImage: "bubble.left.and.bubble.right") { openSource(kind: kind, threadID: threadID, messageID: messageID) }.font(.caption)
        case let .hubConversation(threadID, messageID):
            Button("查看来源对话", systemImage: "bubble.left.and.bubble.right") { openSource(kind: nil, threadID: threadID, messageID: messageID) }.font(.caption)
        case nil:
            Text("仅保存引用；此类型不提供直接打开。支持本地文件定位或 HTTPS 链接。").font(.caption2).foregroundStyle(HubTheme.textTertiary)
        }
    }
    private func openSource(kind: WorkbenchSource.Kind?, threadID: UUID, messageID: UUID) {
        let hub = HubControlStore.shared.state.threads.first { $0.id == threadID && $0.messages.contains { $0.id == messageID } }
        let legacy = workbench.state.conversations.first { $0.id == threadID && $0.messages.contains { $0.id == messageID } }
        if kind == nil && hub != nil && legacy != nil { workbench.errorMessage = "历史引用身份冲突，请使用带来源类型的链接"; return }
        if kind != .legacyConversation, let hub {
            workbench.selectProject(hub.projectID); workbench.selectedTaskID = hub.taskID
            workbench.selectedLegacyConversationID = nil; workbench.selectedControlThreadID = hub.id
        } else if kind != .hubConversation, let legacy {
            workbench.selectProject(legacy.projectID); workbench.selectedControlThreadID = nil
            workbench.selectedLegacyConversationID = legacy.id
        } else { workbench.errorMessage = "来源消息未找到；未替换为其他会话"; return }
        workbench.page = .discussion; model.tabStore.showingOverview = true
    }

}

private struct WorkbenchPolicyEditor: View {
    @ObservedObject var store: WorkbenchStore
    let task: WorkbenchTask
    @State private var policy: WorkbenchPolicy
    @State private var budget: String
    init(store: WorkbenchStore, task: WorkbenchTask) { self.store = store; self.task = task; _policy = State(initialValue: task.policy); _budget = State(initialValue: task.policy.budgetUSD.map { String($0) } ?? "") }
    private func lines(_ key: WritableKeyPath<WorkbenchPolicy, [String]>) -> Binding<String> { Binding(get: { policy[keyPath: key].joined(separator: "\n") }, set: { policy[keyPath: key] = $0.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }) }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: task.policy.confirmed ? "checkmark.shield.fill" : "lock.shield")
                    .font(.system(size: 14))
                    .foregroundStyle(task.policy.confirmed ? HubTheme.success : HubTheme.warning)
                    .frame(width: 34, height: 34)
                    .background((task.policy.confirmed ? HubTheme.success : HubTheme.warning).opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 3) {
                    Text(task.policy.confirmed ? "当前权限已确认" : "默认未授权").font(.system(size: 14, weight: .semibold))
                    Text("执行层必须实际施加 macOS Seatbelt 限制；授权不会继承其他客户端的权限。").font(.caption).foregroundStyle(HubTheme.textTertiary)
                }
            }
            section(title: "位置与文件", symbol: "folder") {
                TextField("工作目录（绝对路径）", text: $policy.workingDirectory)
                lineField("可读取目录，每行一个", text: lines(\.readRoots))
                lineField("可写入目录，每行一个", text: lines(\.writeRoots))
                Text("每步只写自己的隔离目录；不直接覆盖项目原文件，产物需人工检查后采用。").font(.caption).foregroundStyle(HubTheme.textTertiary)
            }
            section(title: "命令与工具", symbol: "terminal") {
                lineField("允许的命令，每行一个绝对路径", text: lines(\.allowedCommands))
                lineField("允许的工具名称", text: lines(\.allowedTools))
            }
            section(title: "网络与数据", symbol: "network") {
                lineField("网络目标，留空禁止网络；初版仅支持精确 loopback IP:port", text: lines(\.networkHosts))
                Picker("数据范围", selection: $policy.privacy) { Text("仅本地").tag("local"); Text("已批准云端").tag("approved-cloud") }
                Text("云端域名若无法精确限制会被执行桥拒绝，不会静默切换网络出口。").font(.caption).foregroundStyle(HubTheme.textTertiary)
            }
            section(title: "预算与到期", symbol: "clock") {
                HStack { TextField("预算 USD（可选）", text: $budget); Stepper("最多并行 \(policy.maxParallel)", value: $policy.maxParallel, in: 1...8) }
                Toggle("设置授权到期时间", isOn: Binding(get: { policy.expiresAt != nil }, set: { policy.expiresAt = $0 ? Date().addingTimeInterval(3600) : nil }))
                if policy.expiresAt != nil { DatePicker("到期", selection: Binding(get: { policy.expiresAt ?? Date() }, set: { policy.expiresAt = $0 })) }
            }
            HStack(spacing: 10) {
                Button("保存权限草稿") { save(confirm: false) }
                Button { save(confirm: true) } label: {
                    Text("确认此任务的权限范围").font(.system(size: 12, weight: .semibold))
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .foregroundStyle(.white)
                        .background(HubTheme.primaryGradient, in: RoundedRectangle(cornerRadius: 9))
                }.buttonStyle(.plain)
            }
            Text("修改权限仅影响后续运行。邮件、上传、删除、付费等动作仍需要具体动作审批；外部内容不能扩大权限。").font(.caption).foregroundStyle(HubTheme.textTertiary)
        }.textFieldStyle(.roundedBorder)
    }
    private func section<Content: View>(title: String, symbol: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HubTheme.SectionHeader(title: title, symbol: symbol)
            content()
        }.padding(13).frame(maxWidth: .infinity, alignment: .leading).hubPanel()
    }
    private func lineField(_ title: String, text: Binding<String>) -> some View { VStack(alignment: .leading, spacing: 4) { Text(title).font(.caption).foregroundStyle(HubTheme.textSecondary); TextField(title, text: text, axis: .vertical).lineLimit(2...5) } }
    private func save(confirm: Bool) {
        do {
            if !budget.isEmpty && Double(budget) == nil { throw WorkbenchStore.StoreError(message: "预算请输入数字") }
            policy.budgetUSD = budget.isEmpty ? nil : Double(budget)
            try store.updatePolicy(taskID: task.id, policy: policy, confirm: confirm)
        } catch { store.errorMessage = error.localizedDescription }
    }
}

struct WorkbenchDiscussionView: View {
    @ObservedObject var store: WorkbenchStore
    let onConvert: () -> Void
    @State private var selected: UUID?
    @State private var text = ""
    @State private var evidence: WorkbenchEvidence = .unverified
    private var conversations: [WorkbenchConversation] { store.scopedConversations }
    private func act(_ action: () throws -> Void) { do { try action() } catch { store.errorMessage = error.localizedDescription } }
    private func evidenceTint(_ value: WorkbenchEvidence) -> Color {
        switch value { case .userConfirmed: return HubTheme.success; case .suggestion: return HubTheme.warning; case .unverified: return HubTheme.textTertiary }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("讨论记录").font(.system(size: 19, weight: .semibold))
                Spacer()
                Button { act { guard let project = store.selectedProjectID ?? store.scopedProjects.first?.id else { throw WorkbenchStore.StoreError(message: "请先创建项目") }; selected = try store.createConversation(projectID: project, title: "讨论 · " + Date().formatted(date: .abbreviated, time: .shortened)) } } label: {
                    Label("新建讨论", systemImage: "plus").font(.system(size: 11, weight: .semibold))
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .foregroundStyle(.white)
                        .background(HubTheme.primaryGradient, in: RoundedRectangle(cornerRadius: 9))
                }.buttonStyle(.plain)
            }
            Text("用于澄清与决策，不自动调用模型或执行工具。Chatbox 保留独立聊天入口；选中的内容可转换为有计划、有权限的任务。").font(.caption).foregroundStyle(HubTheme.textTertiary)
            Picker("讨论", selection: $selected) { Text("请选择").tag(Optional<UUID>.none); ForEach(conversations) { Text($0.title).tag(Optional($0.id)) } }
            if let conversation = conversations.first(where: { $0.id == selected }) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(conversation.messages) { message in
                            VStack(alignment: .leading, spacing: 8) {
                                HStack {
                                    HubTheme.StatusChip(text: message.evidence.label, tint: evidenceTint(message.evidence))
                                    Spacer()
                                    Button("将这条内容转为任务") { act { try store.convertMessage(conversationID: conversation.id, messageID: message.id); onConvert() } }
                                        .font(.caption2).buttonStyle(.link)
                                }
                                Text(message.text).font(.callout).textSelection(.enabled)
                                ForEach(message.taskIDs, id: \.self) { id in
                                    if let task = store.state.tasks.first(where: { $0.id == id }) { Button("关联任务：" + task.title) { store.selectedTaskID = id; store.selectedProjectID = task.projectID; onConvert() }.font(.caption) }
                                }
                            }.padding(13).frame(maxWidth: .infinity, alignment: .leading).hubPanel()
                        }
                    }
                }
                TextField("记录问题、建议或已确认结论", text: $text, axis: .vertical).lineLimit(3...7).textFieldStyle(.roundedBorder)
                HStack {
                    Picker("信息性质", selection: $evidence) { ForEach(WorkbenchEvidence.allCases, id: \.self) { Text($0.label).tag($0) } }
                    Spacer()
                    Button { act { try store.appendMessage(conversationID: conversation.id, text: text, evidence: evidence); text = "" } } label: {
                        Text("保存讨论").font(.system(size: 12, weight: .semibold))
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .foregroundStyle(.white)
                            .background(HubTheme.primaryGradient, in: RoundedRectangle(cornerRadius: 9))
                    }.buttonStyle(.plain)
                }
            } else { Spacer(); Text("选择或新建讨论。").foregroundStyle(HubTheme.textTertiary); Spacer() }
        }.padding(24)
        .onAppear { selectRequestedConversation() }
        .onChange(of: store.selectedLegacyConversationID) { _ in selectRequestedConversation() }
        .onChange(of: store.selectedProjectID) { _ in selected = nil }
        .onChange(of: store.selectedWorkspaceID) { _ in selected = nil }
    }
    private func selectRequestedConversation() {
        if let id = store.selectedLegacyConversationID, conversations.contains(where: { $0.id == id }) { selected = id; store.selectedLegacyConversationID = nil }
    }
}
