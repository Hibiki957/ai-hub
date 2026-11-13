import GhosttyTerminal
import SwiftUI
import UniformTypeIdentifiers

private struct PaneTreeView: View {
    @EnvironmentObject private var tabStore: TabStore
    let tab: TerminalTab
    @ObservedObject var node: PaneNode

    var body: some View {
        if let pane = node.pane {
            PaneLeafView(tab: tab, pane: pane)
        } else if let a = node.a, let b = node.b {
            if node.horizontal == true {
                HSplit(a: a, b: b)
            } else {
                VSplit(a: a, b: b)
            }
        }
    }

    @ViewBuilder
    private func HSplit(a: PaneNode, b: PaneNode) -> some View {
        GeometryReader { geo in
            HStack(spacing: 0) {
                PaneTreeView(tab: tab, node: a)
                    .frame(width: max(80, geo.size.width * node.fraction - 1.5))
                PaneDivider(horizontal: true) { delta in
                    node.fraction = min(max(node.fraction + delta / max(geo.size.width, 1), 0.1), 0.9)
                }
                PaneTreeView(tab: tab, node: b)
            }
        }
    }

    @ViewBuilder
    private func VSplit(a: PaneNode, b: PaneNode) -> some View {
        GeometryReader { geo in
            VStack(spacing: 0) {
                PaneTreeView(tab: tab, node: a)
                    .frame(height: max(60, geo.size.height * node.fraction - 1.5))
                PaneDivider(horizontal: false) { delta in
                    node.fraction = min(max(node.fraction + delta / max(geo.size.height, 1), 0.1), 0.9)
                }
                PaneTreeView(tab: tab, node: b)
            }
        }
    }
}

/// 叶子：单个终端 surface + hover 分屏/关闭按钮
private struct PaneLeafView: View {
    @EnvironmentObject private var tabStore: TabStore
    let tab: TerminalTab
    let pane: TerminalPane

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            TerminalSurfaceView(context: pane.state)
            // 进程退出角标
            if tabStore.exitedPaneIDs.contains(pane.id) {
                Text("已退出")
                    .font(.system(size: 10))
                    .foregroundStyle(HubTheme.textTertiary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(HubTheme.panel.opacity(0.9)))
                    .padding(8)
                    .allowsHitTesting(false)
            }
        }
    }
}

/// 分隔条：hover 高亮（拖拽调比例待后续版本）
private struct PaneDivider: View {
    let horizontal: Bool   // true = 垂直条（分隔左右）
    var onDrag: ((CGFloat) -> Void)? = nil
    @State private var hovering = false

    var body: some View {
        Rectangle()
            .fill(hovering ? HubTheme.accent.opacity(0.5) : HubTheme.border)
            .frame(width: horizontal ? 3 : nil, height: horizontal ? nil : 3)
            .contentShape(Rectangle())
            .onHover { hovering in
                if hovering {
                    if horizontal { NSCursor.resizeLeftRight.push() } else { NSCursor.resizeUpDown.push() }
                } else {
                    NSCursor.pop()
                }
            }
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        onDrag?(horizontal ? value.translation.width : value.translation.height)
                    }
            )
    }
}

// MARK: - Terminal Area

struct TerminalAreaView: View {
    @EnvironmentObject private var tabStore: TabStore

    var body: some View {
        ZStack {
            HubTheme.background
            // 网页容器：只要还有网页标签就常驻，切换只切 isHidden 不重载；切到 CLI 时整层隐藏
            if !tabStore.webTabs.isEmpty {
                let webActive = (tabStore.selectedTabID == nil && tabStore.selectedNativeTabID == nil && !tabStore.showingOverview)
                let activeWebID = webActive ? tabStore.selectedWebTabID : nil
                VStack(spacing: 0) {
                    if webActive,
                       let wtab = tabStore.webTabs.first(where: { $0.id == activeWebID }) {
                        WebDockHeader(
                            holder: wtab.holder,
                            title: wtab.title,
                            accent: wtab.accent,
                            url: wtab.url,
                            onClose: { tabStore.closeWebTab(id: wtab.id) }
                        )
                    }
                    WebDockView(webTabs: tabStore.webTabs, selectedID: activeWebID,
                                isWindowVisible: tabStore.isWindowVisible)
                }
                .opacity(webActive ? 1 : 0)
                .allowsHitTesting(webActive)   // CLI 标签激活时放行鼠标/键盘到下层终端（dock 内 NSView 也已 isHidden）
            }
            // Keep PTYs attached so background output/hooks keep draining.
            // Hidden panes stop drawing and release their display links.
            ForEach(tabStore.tabs) { tab in
                PaneTreeView(tab: tab, node: tab.root)
                    .id(tab.id)
                    .opacity(tab.id == tabStore.selectedTabID && !tabStore.showingOverview ? 1 : 0)
                    .allowsHitTesting(tab.id == tabStore.selectedTabID && !tabStore.showingOverview)
                    .accessibilityHidden(tab.id != tabStore.selectedTabID || tabStore.showingOverview)
            }
            if let tab = tabStore.nativeTabs.first(where: { $0.id == tabStore.selectedNativeTabID }), !tabStore.showingOverview {
                AIHubNativeWindowView(tab: tab).id(tab.id)
            }
            // 欢迎页：无任何标签时
            if tabStore.tabs.isEmpty && tabStore.webTabs.isEmpty && tabStore.nativeTabs.isEmpty {
                VStack(spacing: 8) {
                    Text("AI Hub")
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(HubTheme.text)
                    Text("选择原生应用、网页或终端工具开始")
                        .font(.system(size: 13))
                        .foregroundStyle(HubTheme.textSecondary)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(WindowVisibilityObserver { tabStore.setWindowVisible($0) })
        .onChange(of: tabStore.selectedTabID) { newID in
            if !tabStore.showingOverview { tabStore.tabs.first(where: { $0.id == newID })?.panes.first?.state.requestFocus() }
        }
        .onChange(of: tabStore.showingOverview) { overview in
            if overview {
                NSApp.keyWindow?.makeFirstResponder(nil)
            } else if let id = tabStore.selectedTabID {
                tabStore.tabs.first(where: { $0.id == id })?.panes.first?.state.requestFocus()
            }
        }
    }
}

// MARK: - 网页标签头（后退/前进/在浏览器打开/关闭）

private struct WebDockHeader: View {
    @ObservedObject var holder: WebViewHolder
    let title: String
    let accent: Color
    let url: URL
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Circle().fill(accent).frame(width: 7, height: 7)
                Text(title).font(.system(size: 12))
                Spacer()
                Button {
                    holder.goBack()
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 11))
                        .foregroundStyle(holder.canGoBack ? HubTheme.text : HubTheme.textTertiary)
                }
                .buttonStyle(.plain)
                .disabled(!holder.canGoBack)
                .help("后退（或触控板双指横扫）")
                Button {
                    holder.goForward()
                } label: {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11))
                        .foregroundStyle(holder.canGoForward ? HubTheme.text : HubTheme.textTertiary)
                }
                .buttonStyle(.plain)
                .disabled(!holder.canGoForward)
                .help("前进")
                Button {
                    NSWorkspace.shared.open(url)
                } label: {
                    Image(systemName: "arrow.up.forward.app")
                        .font(.system(size: 11))
                        .foregroundStyle(HubTheme.textSecondary)
                }
                .buttonStyle(.plain)
                .help("在浏览器打开")
                Button {
                    onClose()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(HubTheme.textSecondary)
                }
                .buttonStyle(.plain)
                .help("关闭")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            Rectangle().fill(HubTheme.border).frame(height: 1)
        }
        .background(HubTheme.background)
    }
}
