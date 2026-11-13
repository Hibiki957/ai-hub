import Foundation
import SwiftUI

/// Role recommendations only. Availability and launch targets come from the
/// shared catalog and the user's existing inventory, never from this table.
struct ToolStackFamily: Identifiable {
    enum Tier: String, CaseIterable {
        case brain, execution, specialist, support
        var label: String {
            switch self { case .brain: return "个人大脑与讨论组"; case .execution: return "执行主力"; case .specialist: return "专项辅助"; case .support: return "环境与其他工具" }
        }
        var detail: String {
            switch self {
            case .brain: return "管理目标、讨论方案、协调与复盘"
            case .execution: return "承担实现、修改、验证与交付"
            case .specialist: return "按项目选用研究、设计与其他专项能力"
            case .support: return "配置、运行环境与个人补充入口"
            }
        }
        var symbol: String {
            switch self {
            case .brain: return "brain.head.profile"
            case .execution: return "hammer"
            case .specialist: return "wand.and.stars"
            case .support: return "gearshape"
            }
        }
        var tint: Color {
            switch self {
            case .brain: return Color(hex: 0x7C6BD9)
            case .execution: return HubTheme.accent
            case .specialist: return Color(hex: 0x2E8C8C)
            case .support: return HubTheme.textTertiary
            }
        }
    }

    /// How much human involvement an entry form expects. This is a selection
    /// aid for picking a form per task, never a permission grant.
    enum Involvement: String, CaseIterable {
        case interactive, checkpoint, delegated
        var label: String {
            switch self {
            case .interactive: return "全程交互"
            case .checkpoint: return "关键节点确认"
            case .delegated: return "托管执行"
            }
        }
        var detail: String {
            switch self {
            case .interactive: return "人全程在场，适合讨论、探索与手动操作"
            case .checkpoint: return "人只在计划与关键动作处确认，适合有边界的任务"
            case .delegated: return "交给后台或受控流程，人看结果与回执"
            }
        }
        var tint: Color {
            switch self {
            case .interactive: return HubTheme.accent
            case .checkpoint: return HubTheme.warning
            case .delegated: return HubTheme.success
            }
        }
    }
    let id: String
    let name: String
    let tier: Tier
    let capabilities: String
    let kinds: [WorkbenchProjectKind]
    let products: [String]
    var pwaNames: [String] = []
    var agentID: String? = nil

    func recommended(for kind: WorkbenchProjectKind) -> Bool {
        tier == .brain || kind == .general || kinds.contains(kind)
    }
    static let definitions: [ToolStackFamily] = [
        .init(id: "grok", name: "Grok Bot", tier: .brain, capabilities: "个人管理 · 讨论", kinds: [], products: ["grok-build", "grok"], pwaNames: ["Grok"]),
        .init(id: "muse", name: "Muse AI", tier: .brain, capabilities: "个人管理 · 讨论", kinds: [], products: ["muse"]),
        .init(id: "openclaw", name: "OpenClaw", tier: .brain, capabilities: "规划 · 协调 · 行动", kinds: [], products: ["openclaw"], pwaNames: ["OpenClaw"], agentID: "openclaw"),
        .init(id: "hermes", name: "Hermes", tier: .brain, capabilities: "记忆 · 讨论 · 协调", kinds: [], products: ["hermes"], agentID: "hermes"),
        .init(id: "gpt-dot", name: "GPT / dot", tier: .brain, capabilities: "个人管理 · 综合讨论", kinds: [], products: ["codex-desktop"]),
        .init(id: "opencode", name: "OpenCode", tier: .execution, capabilities: "开发 · 实现 · 验证", kinds: [.development, .design, .delivery], products: ["opencode"], agentID: "opencode"),
        .init(id: "claude", name: "Claude Code / Claude", tier: .execution, capabilities: "编码 · 分析 · 审查", kinds: [.development, .research, .career, .delivery], products: ["claude"], agentID: "claude"),
        .init(id: "codex", name: "Codex", tier: .execution, capabilities: "编码 · 修改 · 测试", kinds: [.development, .design, .delivery], products: ["codex"], agentID: "codex"),
        .init(id: "kimi", name: "Kimi Code", tier: .specialist, capabilities: "代码 · 长资料辅助", kinds: [.research, .development, .career, .delivery], products: ["kimi"], agentID: "kimi"),
        .init(id: "open-design", name: "Open Design", tier: .specialist, capabilities: "界面 · 设计辅助", kinds: [.design, .development], products: ["open-design"]),
        .init(id: "zcode", name: "ZCode", tier: .specialist, capabilities: "项目构建 · 代码辅助", kinds: [.development, .design, .delivery], products: ["zcode"]),
        .init(id: "chatbox", name: "Chatbox", tier: .specialist, capabilities: "独立聊天 · 模型手动入口", kinds: [.research, .career], products: ["chatbox"]),
        .init(id: "dsh", name: "DeepSeek Harness", tier: .specialist, capabilities: "综合任务辅助", kinds: [.development, .research], products: ["dsh"], pwaNames: ["DeepSeek Harness"]),
    ]
    static let resourceProducts: Set<String> = ["eagle", "zotero", "masscode", "obsidian", "notion", "outlook", "finalshell", "ghostty"]
    static func families(catalog: ToolCatalog) -> [ToolStackFamily] {
        let covered = Set(definitions.flatMap(\.products)).union(resourceProducts)
        var seen = Set<String>()
        let others = (catalog.apps.map { ($0.productID, $0.name) } + catalog.cli.map { ($0.productID, $0.title) })
            .filter { !covered.contains($0.0) && seen.insert($0.0).inserted }
            .map { ToolStackFamily(id: $0.0, name: $0.1, tier: .support, capabilities: "可按项目选用", kinds: [], products: [$0.0]) }
        return definitions + others
    }
}
