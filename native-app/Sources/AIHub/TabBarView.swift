import GhosttyTerminal
import SwiftUI
import UniformTypeIdentifiers

struct TabBarView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var tabStore: TabStore
    @EnvironmentObject private var relay: RelayRuntimeStore
    @State private var draggingTabID: UUID? = nil   // 正在拖拽的标签
    @State private var dropTargetID: UUID? = nil    // 当前插入锚点（nil = 拖到最尾）

    var body: some View {
        HStack(spacing: 0) {
            Button {
                tabStore.showingOverview = true
            } label: {
                Image(systemName: "cloud.sun")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(tabStore.showingOverview || tabStore.orderedTabs.isEmpty ? HubTheme.accent : HubTheme.textSecondary)
                    .frame(width: 38, height: 30)
                    .background(tabStore.showingOverview || tabStore.orderedTabs.isEmpty ? HubTheme.surface : .clear,
                                in: RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain).padding(.leading, 7)
            .overlay(alignment: .topTrailing) {
                if !relay.permissions.isEmpty {
                    Text("\(relay.permissions.count)").font(.system(size: 8, weight: .bold)).foregroundStyle(.white)
                        .frame(width: 14, height: 14).background(HubTheme.warning, in: Circle())
                        .allowsHitTesting(false)
                }
            }
            .help(relay.permissions.isEmpty ? "云间工作台" : "有待确认的工具操作，点击返回任务")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(tabStore.orderedTabs) { item in
                        tabView(for: item)
                            .opacity(draggingTabID == item.id ? 0.35 : 1)
                            .overlay(alignment: .bottom) {
                                if dropTargetID == item.id {
                                    RoundedRectangle(cornerRadius: 1)
                                        .fill(HubTheme.accent)
                                        .frame(height: 2)
                                }
                            }
                            .onDrag {
                                draggingTabID = item.id
                                return NSItemProvider(object: ("tab:" + item.id.uuidString) as NSString)
                            }
                            .onDrop(of: [.text], delegate: TabDropDelegate(
                                targetID: item.id,
                                draggingID: $draggingTabID,
                                dropTargetID: $dropTargetID,
                                perform: { tabStore.moveTab($0, before: item.id) }
                            ))
                    }
                    // 拖到最尾的落点
                    Color.clear
                        .frame(width: 20, height: 24)
                        .contentShape(Rectangle())
                        .onDrop(of: [.text], delegate: TabDropDelegate(
                            targetID: nil,
                            draggingID: $draggingTabID,
                            dropTargetID: $dropTargetID,
                            perform: { tabStore.moveTab($0, before: nil) }
                        ))
                    if dropTargetID == nil && draggingTabID != nil {
                        RoundedRectangle(cornerRadius: 1)
                            .fill(HubTheme.accent)
                            .frame(width: 2, height: 22)
                    }
                }
                .padding(.leading, 8)
            }
            // 全局分屏控制 + 文件浏览器（固定在标签栏右端，不随标签滚动）
            HStack(spacing: 2) {
                tabSplitButton(icon: "rectangle.split.1x2", help: "左右分屏（⌘D）") {
                    splitCurrent(.right)
                }
                tabSplitButton(icon: "rectangle.split.2x1", help: "上下分屏（⇧⌘D）") {
                    splitCurrent(.down)
                }
                // 文件浏览器切换
                Button {
                    if model.showFileBrowser {
                        model.showFileBrowser = false
                    } else {
                        model.browseCurrentDirectory()
                    }
                } label: {
                    Image(systemName: "folder")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(model.showFileBrowser ? HubTheme.accent : HubTheme.textSecondary)
                }
                .buttonStyle(.plain)
                .help("文件浏览器 ⌘⇧F")
            }
            .padding(.trailing, 6)
            .opacity(canSplit ? 1 : 0.3)
            .disabled(!canSplit)
            // 分隔线
            Rectangle()
                .fill(HubTheme.border)
                .frame(width: 1)
                .opacity(canSplit ? 1 : 0)
        }
        .frame(height: 42)
        .background(HubTheme.panel)
        .contextMenu {
            Toggle("标签栏放底部", isOn: $model.tabBarAtBottom)
        }
    }

    private var canSplit: Bool {
        guard !tabStore.showingOverview, let id = tabStore.selectedTabID,
              let tab = tabStore.tabs.first(where: { $0.id == id }) else { return false }
        return tab.panes.contains { !tabStore.exitedPaneIDs.contains($0.id) }
    }

    private func splitCurrent(_ direction: TabStore.SplitDirection) {
        guard let id = tabStore.selectedTabID,
              let tab = tabStore.tabs.first(where: { $0.id == id }) else { return }
        let target = tab.panes.last(where: { !tabStore.exitedPaneIDs.contains($0.id) }) ?? tab.panes.first
        guard let target else { return }
        tabStore.splitPane(tab: tab, paneID: target.id, direction: direction)
    }

    private func tabSplitButton(icon: String, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(HubTheme.textSecondary)
                .frame(width: 24, height: 24)
        }
        .buttonStyle(.plain)
        .help(help)
    }

    @ViewBuilder
    private func tabView(for item: TabStore.TabItem) -> some View {
        switch item.kind {
        case .terminal:
            if let tab = tabStore.tabs.first(where: { $0.id == item.id }) {
                TabItemView(tab: tab)
            } else {
                Color.clear.frame(width: 0, height: 0)
            }
        case .web:
            if let wtab = tabStore.webTabs.first(where: { $0.id == item.id }) {
                WebTabItemView(tab: wtab)
            } else {
                Color.clear.frame(width: 0, height: 0)
            }
        case .native:
            if let tab = tabStore.nativeTabs.first(where: { $0.id == item.id }) {
                NativeAppTabItemView(tab: tab)
            }
        }
    }
}

private struct TabDropDelegate: DropDelegate {
    let targetID: UUID?   // nil = 拖到最尾
    @Binding var draggingID: UUID?
    @Binding var dropTargetID: UUID?
    let perform: (UUID) -> Void

    func validateDrop(info: DropInfo) -> Bool {
        guard let draggingID, draggingID != targetID else { return false }
        return info.hasItemsConforming(to: [.text])
    }
    func dropEntered(info: DropInfo) {
        dropTargetID = targetID
    }
    func dropExited(info: DropInfo) {
        if dropTargetID == targetID { dropTargetID = nil }
    }
    func dropUpdated(info: DropInfo) -> DropProposal? {
        DropProposal(operation: .move)
    }
    func performDrop(info: DropInfo) -> Bool {
        guard let id = draggingID else { return false }
        draggingID = nil
        dropTargetID = nil
        perform(id)
        return true
    }
}

private struct TabItemView: View {
    @EnvironmentObject private var tabStore: TabStore
    @ObservedObject var tab: TerminalTab
    @ObservedObject private var primaryState: TerminalViewState
    @State private var hovering = false

    init(tab: TerminalTab) {
        self.tab = tab
        _primaryState = ObservedObject(wrappedValue: tab.panes.first?.state ?? TerminalViewState(controller: AppDelegate.model!.terminalController))
    }

    private var isSelected: Bool { !tabStore.showingOverview && tabStore.selectedTabID == tab.id }

    private var allExited: Bool { tab.panes.allSatisfy { tabStore.exitedPaneIDs.contains($0.id) } }

    /// Hook 状态 + bell 兜底（未接 hook 的 CLI 靠 bell 判等待）
    private var status: TabStatus? { tabStore.tabStatuses[tab.id] }
    private var waiting: Bool {
        tabStore.unseenBellTabIDs.contains(tab.id) || status == .waiting
    }

    var body: some View {
        HStack(spacing: 6) {
            // 状态点：退出=灰√ / 等审批=橙呼吸 / 运行中=品牌呼吸 / 完成=绿 / 空闲=品牌色；多面板加数字
            if allExited {
                Image(systemName: "checkmark.circle")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(HubTheme.textTertiary)
            } else if waiting {
                Circle()
                    .fill(Color(hex: 0xF59E0B))
                    .frame(width: 7, height: 7)
                    .breathing()
            } else if status == .running {
                Circle()
                    .fill(HubTheme.brandColor(for: tab.cli.name))
                    .frame(width: 7, height: 7)
                    .breathing()
            } else if status == .done {
                Circle()
                    .fill(Color(hex: 0x22A55E))
                    .frame(width: 7, height: 7)
            } else {
                Circle()
                    .fill(HubTheme.brandColor(for: tab.cli.name))
                    .frame(width: 7, height: 7)
            }
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 3) {
                    Text(primaryState.title.isEmpty ? tab.cli.title : primaryState.title)
                        .font(.system(size: 12))
                        .lineLimit(1)
                        .frame(maxWidth: 160)
                    if tab.panes.count > 1 {
                        Text("\(tab.panes.count)")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(HubTheme.textTertiary)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(HubTheme.hover))
                    }
                }
                if !allExited,
                   let nanos = primaryState.lastCommandDurationNanos, nanos > 0 {
                    Text(Self.durationText(nanos))
                        .font(.system(size: 10))
                        .foregroundStyle(HubTheme.textTertiary)
                }
            }
            if hovering || isSelected {
                Button {
                    tabStore.closeTab(id: tab.id)
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(HubTheme.textSecondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(isSelected ? Color(hex: 0xFFFFFF) : (hovering ? HubTheme.hover : .clear))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(isSelected ? HubTheme.border : .clear, lineWidth: 1)
        )
        .foregroundStyle(isSelected ? HubTheme.text : HubTheme.textSecondary)
        .contentShape(Rectangle())
        .onTapGesture {
            tabStore.showingOverview = false
            tabStore.selectedTabID = tab.id
            tabStore.selectedWebTabID = nil
            tabStore.unseenBellTabIDs.remove(tab.id)
        }
        .contextMenu {
            Button("关闭标签") { tabStore.closeTab(id: tab.id) }
        }
        .onHover { hovering = $0 }
    }

    private static func durationText(_ nanos: UInt64) -> String {
        let s = Double(nanos) / 1_000_000_000
        if s < 60 { return String(format: "%.0fs", s) }
        if s < 3600 { return String(format: "%.0fm%.0fs", s / 60, s.truncatingRemainder(dividingBy: 60)) }
        return String(format: "%.1fh", s / 3600)
    }
}

// MARK: - 呼吸动画

private struct BreathingModifier: ViewModifier {
    @Environment(\.scenePhase) private var scenePhase
    @State private var on = false

    func body(content: Content) -> some View {
        content
            .opacity(on ? 1.0 : 0.35)
            .animation(scenePhase == .active ? .easeInOut(duration: 0.9).repeatForever(autoreverses: true) : .default, value: on)
            .onAppear { on = true }
            .onChange(of: scenePhase) { phase in
                on = (phase == .active)
            }
    }
}

private extension View {
    func breathing() -> some View {
        modifier(BreathingModifier())
    }
}

private struct WebTabItemView: View {
    @EnvironmentObject private var tabStore: TabStore
    @ObservedObject var tab: WebTab
    @State private var hovering = false

    private var isSelected: Bool { !tabStore.showingOverview && tabStore.selectedWebTabID == tab.id && tabStore.selectedTabID == nil }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "globe")
                .font(.system(size: 9))
                .foregroundStyle(tab.accent)
            Text(tab.title)
                .font(.system(size: 12))
                .lineLimit(1)
                .frame(maxWidth: 160)
            if hovering || isSelected {
                Button {
                    tabStore.closeWebTab(id: tab.id)
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(HubTheme.textSecondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(isSelected ? Color(hex: 0xFFFFFF) : (hovering ? HubTheme.hover : .clear))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(isSelected ? HubTheme.border : .clear, lineWidth: 1)
        )
        .foregroundStyle(isSelected ? HubTheme.text : HubTheme.textSecondary)
        .contentShape(Rectangle())
        .onTapGesture {
            tabStore.showingOverview = false
            tabStore.selectedWebTabID = tab.id
            tabStore.selectedTabID = nil   // 切到网页 → 清终端选中
        }
        .contextMenu {
            Button("关闭标签") { tabStore.closeWebTab(id: tab.id) }
        }
        .onHover { hovering = $0 }
    }
}

// MARK: - 分屏树渲染

/// 递归渲染分屏树：叶子=终端面板，分叉=HStack/VStack + 可拖分隔条
