import SwiftUI

/// Shared geometry and interaction states for project navigation and resources.
enum SidebarStyle {
    static let inset: CGFloat = 12
    static let rowHeight: CGFloat = 32
    static let radius: CGFloat = 7

    struct RowBackground: View {
        var selected = false
        var hovered = false

        var body: some View {
            RoundedRectangle(cornerRadius: SidebarStyle.radius)
                .fill(selected ? HubTheme.accentSoft : (hovered ? HubTheme.border.opacity(0.35) : Color.clear))
                .overlay(alignment: .leading) {
                    if selected {
                        RoundedRectangle(cornerRadius: 1).fill(HubTheme.accent)
                            .frame(width: 2, height: 16)
                    }
                }
        }
    }
}
