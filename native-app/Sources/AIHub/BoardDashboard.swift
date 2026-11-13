import SwiftUI

/// 看板大盘卡片：标题、状态、负责组合、阶段进度、台账最新动态。
/// 花费/余额没有真实来源，一律不展示；最新动态只取台账事件原文。
struct BoardCardView: View {
    @ObservedObject var store: WorkbenchStore
    let task: WorkbenchTask
    let tint: Color
    private var selected: Bool { store.selectedTaskID == task.id }

    var body: some View {
        Button { store.selectTask(task.id) } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top, spacing: 6) {
                    Text(task.title).font(.system(size: 13, weight: .medium)).lineLimit(3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let priorityTint { Circle().fill(priorityTint).frame(width: 7, height: 7).padding(.top, 4).help(priorityLabel) }
                }
                HStack(spacing: 6) {
                    Text(task.status.label)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(tint)
                        .padding(.horizontal, 7).padding(.vertical, 2.5)
                        .background(tint.opacity(0.10), in: Capsule())
                    Text(comboLabel).font(.system(size: 11)).foregroundStyle(HubTheme.textSecondary).lineLimit(1)
                }
                stageRow
                Text(latestUpdate).font(.system(size: 11)).foregroundStyle(HubTheme.textSecondary)
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    Text("计划 v\(task.currentPlan.revision) · \(task.currentPlan.nodes.count) 步骤")
                    if let due = task.deadline {
                        Text("· ") + Text(due, style: .date)
                        if Calendar.current.isDateInToday(due) {
                            Text("今天到期").font(.system(size: 10, weight: .medium))
                                .foregroundStyle(HubTheme.warning)
                                .padding(.horizontal, 6).padding(.vertical, 1.5)
                                .background(HubTheme.warningSoft, in: Capsule())
                        }
                    }
                }.font(.system(size: 11)).foregroundStyle(HubTheme.textTertiary)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HubTheme.surface, in: RoundedRectangle(cornerRadius: 11))
            .overlay(RoundedRectangle(cornerRadius: 11).stroke(selected ? tint.opacity(0.5) : HubTheme.border, lineWidth: 1))
            .shadow(color: Color.black.opacity(0.03), radius: 4, x: 0, y: 2)
        }.buttonStyle(.plain)
        .contextMenu { quickActions }
    }

    @ViewBuilder private var quickActions: some View {
        Button("查看详情") { store.selectTask(task.id) }
        if task.status == .awaitingAcceptance {
            Button("验收通过…") { verify(accepted: true) }
            Button("一句话打回…") { verify(accepted: false) }
        }
        if task.status.active { Button("取消运行", role: .destructive) { act { try store.cancel(taskID: task.id) } } }
    }

    private func verify(accepted: Bool) {
        let title = accepted ? "验收依据" : "打回意见"
        let message = accepted ? "记录本次验收通过的依据" : "只写一句话，编排者自定位问题、局部重做"
        if let note = Prompt.text(title: title, message: message, initial: "") {
            act { try store.verify(taskID: task.id, accepted: accepted, note: note) }
        }
    }

    private func act(_ action: () throws -> Void) { do { try action() } catch { store.errorMessage = error.localizedDescription } }

    // MARK: - 派生展示

    private var comboLabel: String {
        let assignee = task.assigneeID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let owner = assignee.isEmpty ? task.effectiveOwnerType.label : assignee
        return owner + " · " + task.effectiveTier.label
    }

    /// 阶段进度：由状态机确定，不推测执行百分比。
    private var stage: (index: Int, name: String) {
        switch task.status {
        case .draft, .ready: return (1, "准备")
        case .running, .cancelling, .awaitingApproval: return (2, "执行")
        case .blocked, .failed, .interrupted: return (2, "执行 · 需处理")
        case .awaitingAcceptance: return (3, "验收")
        case .done: return (4, "完成")
        case .cancelled: return (1, "已取消")
        case .archived: return (4, "已归档")
        }
    }

    private var stageRow: some View {
        HStack(spacing: 6) {
            GeometryReader { geometry in
                Capsule().fill(HubTheme.border).overlay(alignment: .leading) {
                    Capsule().fill(tint).frame(width: geometry.size.width * CGFloat(stage.index) / 4)
                }
            }.frame(height: 3)
            Text("阶段 \(stage.index)/4 · " + stage.name).font(.system(size: 10)).foregroundStyle(HubTheme.textTertiary)
                .fixedSize()
        }
    }

    private var latestUpdate: String {
        if let event = task.events.last { return "最新：" + event.summary }
        return "暂无动态 · 更新于 " + task.updatedAt.formatted(date: .abbreviated, time: .shortened)
    }

    private var priorityTint: Color? {
        switch task.priority {
        case 0: return HubTheme.danger
        case 1: return HubTheme.warning
        default: return nil
        }
    }

    private var priorityLabel: String {
        switch task.priority {
        case 0: return "今天优先"
        case 1: return "高优先级"
        default: return ""
        }
    }
}

/// 盘内拦截卡：有待拍板事项时置顶展示，不可关闭；处理完自动消失。
struct BoardApprovalIntercept: View {
    @ObservedObject var store: WorkbenchStore
    private var pending: [WorkbenchApproval] { store.state.approvals.filter { $0.resolvedAt == nil } }

    var body: some View {
        if let first = pending.first {
            HStack(alignment: .center, spacing: 14) {
                Image(systemName: "hand.raised.fill").font(.system(size: 16)).foregroundStyle(HubTheme.warning)
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(pending.count) 项等你拍板 · 关键节点必须先处理")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(HubTheme.text)
                    Text(first.summary).font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary).lineLimit(2)
                }
                Spacer(minLength: 8)
                Button("去处理") { openTask(for: first) }
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(.white)
                    .padding(.horizontal, 14).padding(.vertical, 7)
                    .background(HubTheme.warning, in: RoundedRectangle(cornerRadius: 8)).buttonStyle(.plain)
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(HubTheme.warningSoft, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(HubTheme.warning.opacity(0.45), lineWidth: 1))
            .padding(.horizontal, 20).padding(.top, 12)
        }
    }

    private func openTask(for approval: WorkbenchApproval) {
        guard let task = store.state.tasks.first(where: { $0.runs.contains { $0.id == approval.runID } }) else { return }
        store.selectTask(task.id, page: .tasks)
    }
}
