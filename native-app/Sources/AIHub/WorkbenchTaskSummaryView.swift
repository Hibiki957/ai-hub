import SwiftUI

/// A reading surface for saved task requirements. Editing and execution remain
/// in the existing task views; the callbacks below only navigate to those views.
struct WorkbenchTaskSummaryView: View {
    let task: WorkbenchTask
    let projectName: String
    let onEdit: () -> Void
    let onOpenPlan: () -> Void
    let onOpenResults: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            contextSummary
            statusSummary

            if let conclusion = task.archiveConclusion, !conclusion.isEmpty {
                readingSection("归档结论", text: conclusion, empty: "")
            }

            VStack(alignment: .leading, spacing: 22) {
                readingSection("目标", text: task.goal, empty: "尚未说明任务目标。")
                readingSection("交付物", text: task.deliverables, empty: "尚未说明需要交付什么。")
                readingSection("验收条件", text: task.acceptance, empty: "尚未说明如何判断完成。")
            }

            Divider().overlay(HubTheme.border)
            references
            supplementaryDetails
        }
        .frame(maxWidth: 820, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .foregroundStyle(HubTheme.text)
    }

    private var contextSummary: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(projectName.isEmpty ? "项目任务" : projectName)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(HubTheme.textSecondary)
                Spacer(minLength: 0)
                Button("编辑要求", action: onEdit)
                    .font(.system(size: 12, weight: .medium))
                    .buttonStyle(.plain)
                    .foregroundStyle(HubTheme.accent)
            }
            Text("负责人：" + ownerLabel + "  ·  " + priorityLabel + "  ·  " + deadlineLabel)
                .font(.system(size: 12))
                .foregroundStyle(HubTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var statusSummary: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(task.status == .archived ? "已结束的工作" : "下一步").font(.system(size: 13, weight: .semibold))
                Spacer(minLength: 0)
                Text(task.effectiveLifecycle.label)
                    .font(.system(size: 12))
                    .foregroundStyle(HubTheme.textSecondary)
            }
            Text(nextStep)
                .font(.system(size: 14))
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)
            if let destination = nextDestination {
                Button(action: destination == .plan ? onOpenPlan : onOpenResults) {
                    HStack(spacing: 5) {
                        Text(nextActionLabel)
                        Image(systemName: "arrow.right").font(.system(size: 11, weight: .medium))
                    }.font(.system(size: 12, weight: .medium))
                }
                .buttonStyle(.plain)
                .foregroundStyle(HubTheme.accent)
                .padding(.top, 2)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HubTheme.panel, in: RoundedRectangle(cornerRadius: 10))
    }

    private func readingSection(_ title: String, text: String, empty: String) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title).font(.system(size: 13, weight: .semibold))
            Text(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? empty : text)
                .font(.system(size: 14))
                .foregroundStyle(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? HubTheme.textSecondary : HubTheme.text)
                .lineSpacing(5)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private var references: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("相关资料").font(.system(size: 13, weight: .semibold))
            ForEach(task.references) { reference in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(reference.title.isEmpty ? "未命名引用" : reference.title)
                            .font(.system(size: 14, weight: .medium))
                            .textSelection(.enabled)
                        Spacer(minLength: 0)
                        Text(reference.effectiveDepth.rawValue)
                            .font(.system(size: 12))
                            .foregroundStyle(HubTheme.textSecondary)
                    }
                    if !reference.source.isEmpty {
                        Text(reference.source).font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
                    }
                    if !reference.note.isEmpty {
                        Text(reference.note).font(.system(size: 13)).lineSpacing(4).textSelection(.enabled)
                    }
                    WorkbenchReferenceButton(location: reference.location)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 2)
            }
            if let source = task.source {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text("任务来源").font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
                    WorkbenchReferenceButton(location: source.canonicalLocation)
                }
            }
            if task.references.isEmpty && task.source == nil {
                Text("尚未关联资料。可在编辑要求中添加文件或链接。")
                    .font(.system(size: 13)).foregroundStyle(HubTheme.textSecondary)
            }
        }
    }

    private var supplementaryDetails: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 20) {
                readingSection("输入资料与范围", text: task.inputs, empty: "尚未补充输入资料与范围。")
                readingSection("约束", text: task.constraints, empty: "尚未补充约束。")
                readingSection("讨论与决策", text: task.decisionSummary, empty: "尚未记录补充决策。")
                if !task.tags.isEmpty {
                    Text("标签：" + task.tags.joined(separator: " · "))
                        .font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
                }
            }
            .padding(.top, 14)
            .padding(.leading, 2)
        } label: {
            Text("输入、约束与补充说明").font(.system(size: 13, weight: .medium))
        }
        .tint(HubTheme.textSecondary)
    }

    private var ownerLabel: String {
        if task.effectiveOwnerType == .human { return "本人" }
        let assignee = task.assigneeID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return assignee.isEmpty ? "Agent（待指定）" : assignee
    }

    private var priorityLabel: String {
        switch task.priority {
        case 0: return "今天优先"
        case 1: return "高优先级"
        case 2: return "普通优先级"
        case 3: return "低优先级"
        default: return "优先级未说明"
        }
    }

    private var deadlineLabel: String {
        task.deadline.map { "期限 " + $0.formatted(date: .abbreviated, time: .omitted) } ?? "未设期限"
    }

    private enum Destination { case plan, results }

    private var nextDestination: Destination? {
        switch task.status {
        case .draft, .ready: return .plan
        case .awaitingApproval: return nil
        case .running, .cancelling, .blocked, .failed, .interrupted, .awaitingAcceptance, .done, .cancelled, .archived:
            return .results
        }
    }

    private var nextActionLabel: String {
        switch task.status {
        case .draft, .ready: return "查看执行计划"
        case .awaitingAcceptance: return "查看结果并验收"
        default: return "查看运行与产物"
        }
    }

    private var nextStep: String {
        switch task.status {
        case .draft:
            return task.currentPlan.nodes.isEmpty
                ? "先明确目标、交付物和验收条件，再整理执行步骤。"
                : "检查目标和执行步骤，再确认计划与权限。"
        case .ready:
            return task.confirmedRevision == task.currentPlan.revision && task.policy.confirmed
                ? "计划与权限已确认，可在任务工具栏开始执行。"
                : "执行前先检查计划与权限，确认后再开始。"
        case .running:
            return "任务正在执行。可查看本次运行记录与已返回的产物。"
        case .awaitingApproval:
            return "有动作需要你确认。请在任务上方查看本次审批内容，再决定是否允许。"
        case .cancelling:
            return "正在请求停止本次运行，等待运行记录更新。"
        case .blocked:
            return "先查看运行记录中的阻塞原因，再决定如何调整要求或计划。"
        case .failed:
            return "本次运行未完成。先检查失败原因，再决定是否修改计划。"
        case .interrupted:
            return "上次运行已中断，保留记录可供检查。再次执行会建立新运行。"
        case .awaitingAcceptance:
            return "对照下方验收条件检查交付物，再到产物页记录通过或退回。"
        case .done:
            return "结果已验收。可查看验收依据，或记录结论后归档。"
        case .cancelled:
            return "本次运行已取消，原记录已保留。继续工作前请先检查结果与计划。"
        case .archived:
            return "任务已归档，可查看保存的结论、历史产物与验收记录。"
        }
    }
}
