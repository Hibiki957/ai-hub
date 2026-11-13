import SwiftUI

/// Read-only projection of Hub-owned API receipts; this view never probes a
/// service, imports another client's token, or promotes a fixture to live.
struct HubConnectionEvidenceView: View {
    @ObservedObject var control: HubControlStore
    var endpointID: UUID? = nil
    @State private var expanded = false
    private var receipts: [HubAPIReceipt] {
        (control.state.receipts ?? []).filter { endpointID == nil || $0.endpointID == endpointID }.reversed()
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            let gate = control.phase15EvidenceGate
            Label(gate.label, systemImage: gate.passed ? "checkmark.shield" : "circle.dashed")
                .font(.caption.weight(.semibold))
                .foregroundStyle(gate.passed ? Color.green : Color.secondary)
            Text(gate.detail).font(.caption2).foregroundStyle(.secondary)
            DisclosureGroup("调用证据台账（\(receipts.count) 条）", isExpanded: $expanded) {
                if receipts.isEmpty {
                    Text("尚无调用记录。配置 API 不等于已真实联通。").font(.caption).foregroundStyle(.secondary).padding(.vertical, 8)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            ForEach(Array(receipts.prefix(30).enumerated()), id: \.offset) { _, receipt in
                                receiptRow(receipt)
                            }
                        }.padding(.vertical, 6)
                    }.frame(maxHeight: 300)
                    if receipts.count > 30 { Text("显示最近 30 条；完整台账保留在 Hub 会话存储中。").font(.caption2).foregroundStyle(.secondary) }
                }
            }.font(.caption)
            Text("台账验收仅指文本响应与来源校验；工作任务的交付验收另行记录。跨工具 Provider 由 Magpie 管理；这里仅展示 Hub 自己的连接与调用。").font(.caption2).foregroundStyle(.secondary)
        }
    }
    private func receiptRow(_ receipt: HubAPIReceipt) -> some View {
        let evidence = control.receiptValidation(receipt)
        return VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text((receipt.provider ?? "未知服务") + " · " + (receipt.model ?? "未知模型")).font(.caption.weight(.medium)).lineLimit(2)
                Spacer()
                Text(evidence.isLiveVerified ? "真实回复" : "未真实联通").font(.caption2).foregroundStyle(evidence.isLiveVerified ? HubTheme.success : Color.secondary)
            }
            Text("运行：" + (receipt.runID?.uuidString ?? "缺失") + " · " + transportLabel(receipt.transport)).font(.caption2).textSelection(.enabled)
            Text("开始：" + timestamp(receipt.startedAt) + " → 结束：" + timestamp(receipt.endedAt)).font(.caption2).foregroundStyle(.secondary)
            Text("响应验收：" + acceptanceLabel(receipt.acceptanceResult)).font(.caption2)
            if let pointer = receipt.artifactPointer { Text("产物：" + pointer).font(.caption2).textSelection(.enabled) }
            if let group = receipt.requestGroupID { Text("提问组：" + group.uuidString).font(.caption2).foregroundStyle(.secondary).textSelection(.enabled) }
            if !evidence.isLiveVerified { Text(evidence.reasons.joined(separator: "；")).font(.caption2).foregroundStyle(.secondary) }
        }.padding(10).frame(maxWidth: .infinity, alignment: .leading).background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }
    private func timestamp(_ date: Date?) -> String {
        guard let date else { return "缺失 / 未结束" }
        return date.formatted(date: .numeric, time: .standard)
    }
    private func transportLabel(_ value: HubAPITransport?) -> String {
        switch value { case .liveNetwork: return "真实网络"; case .fixture: return "离线 fixture"; default: return "来源未知" }
    }
    private func acceptanceLabel(_ value: String?) -> String {
        switch value { case "passed": return "文本响应校验通过"; case "pending": return "等待响应"; case "failed": return "失败"; case "cancelled": return "已取消"; case "interrupted": return "重启中断"; default: return "缺失 / 未核实" }
    }
}
