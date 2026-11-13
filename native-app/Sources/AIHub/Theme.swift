import SwiftUI

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0
        )
    }
}

enum HubTheme {
    // 色板：暖中性灰 + 深青主色。
    static let background = Color(hex: 0xFFFFFF)   // paper
    static let panel = Color(hex: 0xF5F6F4)        // subtle 内嵌区
    static let surface = Color(hex: 0xFFFFFF)
    static let border = Color(hex: 0xE3E5E4)
    static let hover = Color(hex: 0xE8F1ED)        // accentSoft，选中态
    static let text = Color(hex: 0x242830)
    static let textSecondary = Color(hex: 0x555D65)
    static let textTertiary = Color(hex: 0x697178) // 对白底对比度 ≥ 4.9:1
    static let accent = Color(hex: 0x226D60)
    static let accentHover = Color(hex: 0x17564C)
    static let accentSoft = Color(hex: 0xE8F1ED)
    static let warning = Color(hex: 0x8A5B19)      // amber
    static let warningSoft = Color(hex: 0xFAF2DF)
    static let success = Color(hex: 0x2E7D5B)
    static let danger = Color(hex: 0xB25161)
    // 装饰色（首页 hero / 警示卡底色等），仅用于大面积低透明铺色
    static let tile = Color(hex: 0xEDF1EE)
    static let sky = Color(hex: 0xD8E8E2)
    static let dusk = Color(hex: 0xE6E2D8)
    static let sunlight = Color(hex: 0xF4E3C8)
    static let sidebarBackground = Color(hex: 0xF1F3F1)
    static let primaryGradient = LinearGradient(
        colors: [Color(hex: 0x226D60), Color(hex: 0x1C5D52)],
        startPoint: .top, endPoint: .bottom)
    static let cardRadius: CGFloat = 12

    /// 分区标题：图标 + 小号半粗体，内页卡片通用
    struct SectionHeader: View {
        let title: String
        let symbol: String
        var tint: Color = HubTheme.accent
        var body: some View {
            HStack(spacing: 6) {
                Image(systemName: symbol).font(.system(size: 10, weight: .semibold)).foregroundStyle(tint)
                Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(HubTheme.textSecondary)
            }
        }
    }

    /// 状态色胶囊标签
    struct StatusChip: View {
        let text: String
        let tint: Color
        var body: some View {
            Text(text)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(tint)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(tint.opacity(0.10), in: Capsule())
        }
    }

    /// 各工具品牌色（按 name 小写匹配）
    static func brandColor(for name: String) -> Color {
        switch name.lowercased() {
        case "claude", "claude code":        return Color(hex: 0xD97757)
        case "codex", "chatgpt":            return Color(hex: 0x10A37F)
        case "grok", "grok build":          return Color(hex: 0x8B5CF6)
        case "aider":                       return Color(hex: 0xF59E0B)
        case "pi":                          return Color(hex: 0xE11D48)
        case "opencode":                    return Color(hex: 0x0E9FBA)
        case "dsh", "dsh-tui":               return Color(hex: 0x4D6BFE)   // DeepSeek 蓝
        case "hermes":                       return Color(hex: 0x9C6ADE)  // Hermes 紫
        case "zsh":                         return Color(hex: 0x64748B)
        case "kimi":                        return Color(hex: 0x4D7CFF)
        case "chatbox":                     return Color(hex: 0x22C55E)
        case "gemini":                      return Color(hex: 0x7C8CFF)
        case "qoder":                       return Color(hex: 0x6C5CE7)
        case "zcode":                       return Color(hex: 0x3B5EFF)
        case "devin":                       return Color(hex: 0x6B4FBB)
        case "workbuddy":                   return Color(hex: 0x0052D9)
        case "cc switch":                   return Color(hex: 0xD97757)
        case "perplexity":                  return Color(hex: 0x20808D)
        case "grok bot":                    return Color(hex: 0x8B5CF6)
        case "ollama":                      return Color(hex: 0x475569)
        case "odysseus":                    return Color(hex: 0x2E6F6F)
        case "coingecko":                   return Color(hex: 0x8DC63F)
        case "coinglass":                   return Color(hex: 0xF7931A)
        case "defillama":                   return Color(hex: 0x3B82F6)
        case "gate":                        return Color(hex: 0x2354E5)
        case "hyperliquid":                 return Color(hex: 0x97FCE4)
        case "okx":                         return Color(hex: 0x94A3B8)
        case "x":                          return Color(hex: 0x0D0D0D)
        case "reddit":                      return Color(hex: 0xFF4500)
        case "youtube":                     return Color(hex: 0xFF0000)
        // PWA / 其他
        case "openclaw":                     return Color(hex: 0x22A55E)
        case "paperclip":                    return Color(hex: 0x0EA5E9)
        case "new api":                      return Color(hex: 0x10A37F)
        case "hugging face", "kaggle":       return Color(hex: 0xFFD21E)
        case "github":                       return Color(hex: 0x181717)
        case "figma", "recents – figma":     return Color(hex: 0xF24E1E)
        case "dribbble":                     return Color(hex: 0xEA4C89)
        case "miro":                         return Color(hex: 0xFFD02F)
        case "linux do":                     return Color(hex: 0xF0B152)
        case "polymarket":                   return Color(hex: 0x1652F0)
        case "openrouter":                   return Color(hex: 0x818CF8)
        case "魔搭", "modelscope":           return Color(hex: 0x7C3AED)
        case "arena":                        return Color(hex: 0x10B981)
        case "autodl":                       return Color(hex: 0x2B99FF)
        case "artificialanalysis":           return Color(hex: 0x64748B)
        case "cliproxy":                     return Color(hex: 0x64748B)
        case "deepseek harness":             return Color(hex: 0x4D6BFE)
        case "opencreator":                  return Color(hex: 0xF97316)
        case "wiki", "notebook":             return Color(hex: 0x94A3B8)
        case "讯飞录音笔":                    return Color(hex: 0x0EA5E9)
        case "instagram":                    return Color(hex: 0xE1306C)
        case "pinterest":                    return Color(hex: 0xE60023)
        case "skills-manager":               return Color(hex: 0x0EA5E9)
        case "freellmapi":                    return Color(hex: 0x14B8A6)   // FreeLLMAPI 青绿
        default:                            return textSecondary
        }
    }
}

/// 内页通用分区卡片：白底、圆角、细描边、轻投影
private struct HubPanelModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(HubTheme.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(HubTheme.border, lineWidth: 1))
            .shadow(color: Color.black.opacity(0.03), radius: 5, x: 0, y: 2)
    }
}
extension View {
    func hubPanel() -> some View { modifier(HubPanelModifier()) }
}
