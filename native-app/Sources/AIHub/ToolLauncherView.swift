import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// The app library shares the inventory and launch routes of the original sidebar.
struct ToolLauncherView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @FocusState private var searchFocused: Bool
    @State private var query = ""
    @State private var selectedKind: ToolLauncherCatalog.Kind?
    let webOnly: Bool
    var onReturnToSessions: (() -> Void)?

    init(webOnly: Bool = false, onReturnToSessions: (() -> Void)? = nil) {
        self.webOnly = webOnly
        self.onReturnToSessions = onReturnToSessions
        _selectedKind = State(initialValue: webOnly ? .web : nil)
    }

    private var catalog: ToolLauncherCatalog { ToolLauncherCatalog(model: model) }
    private var sections: [ToolLauncherCatalog.Section] {
        let filtered = catalog.filtered(query: query, kind: selectedKind)
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return filtered }
        let items = filtered.flatMap(\.items)
        return items.isEmpty ? [] : [.init(id: "search-results", title: "搜索结果", items: items)]
    }
    private var resultCount: Int { sections.reduce(0) { $0 + $1.items.count } }
    private var sheetSize: CGSize {
        let screen = NSScreen.main?.visibleFrame.size ?? CGSize(width: 1200, height: 900)
        return CGSize(width: min(1040, screen.width - 100), height: min(760, screen.height - 140))
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            searchField.padding(.horizontal, 28).padding(.bottom, 18)
            if !webOnly { filters.padding(.horizontal, 28).padding(.bottom, 18) }
            if let error = model.launcherError {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(.system(size: 13)).foregroundStyle(HubTheme.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 28).padding(.bottom, 14)
            }
            Divider().overlay(HubTheme.border)
            ScrollView {
                if sections.isEmpty {
                    emptyState
                } else {
                    LazyVStack(alignment: .leading, spacing: 28) {
                        ForEach(sections) { section in
                            VStack(alignment: .leading, spacing: 14) {
                                HStack(alignment: .firstTextBaseline, spacing: 8) {
                                    Text(section.title).font(.system(size: 16, weight: .semibold))
                                    Text("\(section.items.count)").font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
                                }
                                .accessibilityAddTraits(.isHeader)
                                LazyVGrid(columns: [GridItem(.adaptive(minimum: 116, maximum: 156), spacing: 14)], alignment: .leading, spacing: 14) {
                                    ForEach(section.items) { item in tile(item) }
                                }
                            }
                        }
                    }
                    .padding(28)
                }
            }
            .background(HubTheme.panel)
            footer
        }
        .frame(width: sheetSize.width, height: sheetSize.height)
        .foregroundStyle(HubTheme.text)
        .background(HubTheme.surface)
        .onAppear { model.refreshToolInventory(); searchFocused = true }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(webOnly ? "网页应用" : "工具与应用").font(.system(size: 24, weight: .semibold))
                Text(webOnly ? "你的 PWA，在 Hub 中继续使用" : "你的本机工具、桌面应用与 PWA")
                    .font(.system(size: 13)).foregroundStyle(HubTheme.textSecondary)
            }
            Spacer()
            if !webOnly {
                Button("打开原生应用…") { chooseNativeApplication() }.controlSize(.large)
                    .help("选择一个 Mac 应用，在 Hub 标签内显示和操作")
            }
            if let onReturnToSessions {
                Button("返回已有会话", action: onReturnToSessions).controlSize(.large)
                    .disabled(model.tabStore.tabs.isEmpty && model.tabStore.webTabs.isEmpty && model.tabStore.nativeTabs.isEmpty)
            }
            Button { model.refreshToolInventory() } label: {
                Image(systemName: "arrow.clockwise").frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("重新扫描工具与 PWA")
            .help("重新检查本机入口，收起已卸载工具并发现新增 PWA")
            managementMenu
            Button("完成") { dismiss() }.controlSize(.large).keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 28).padding(.top, 24).padding(.bottom, 22)
    }

    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").font(.system(size: 17)).foregroundStyle(HubTheme.textSecondary)
            TextField("搜索工具、应用或分组", text: $query)
                .textFieldStyle(.plain).font(.system(size: 16))
                .focused($searchFocused)
                .accessibilityLabel("搜索工具、应用或分组")
                .onChange(of: query) { value in
                    // The broad launcher labels this as a global search. Clear a
                    // surface filter when a search starts so it cannot silently
                    // hide the very tool the user typed.
                    if !webOnly, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        selectedKind = nil
                    }
                }
                .onSubmit {
                    guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                    if let first = sections.first?.items.first { open(first) }
                }
            if !query.isEmpty {
                Button { query = ""; searchFocused = true } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.plain).foregroundStyle(HubTheme.textSecondary)
                    .accessibilityLabel("清除搜索").help("清除搜索")
            }
            Button { searchFocused = true } label: { Text("⌘ F").font(.system(size: 12, design: .monospaced)) }
                .buttonStyle(.plain).foregroundStyle(HubTheme.textSecondary)
                .keyboardShortcut("f", modifiers: .command).help("聚焦搜索")
        }
        .padding(.horizontal, 16).frame(height: 48)
        .background(HubTheme.panel, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(searchFocused ? HubTheme.accent : HubTheme.border, lineWidth: searchFocused ? 2 : 1))
    }

    private var filters: some View {
        HStack(spacing: 8) {
            filter("全部", symbol: "square.grid.2x2", kind: nil)
            ForEach(ToolLauncherCatalog.Kind.allCases) { kind in filter(kind.title, symbol: kind.symbol, kind: kind) }
            Spacer(minLength: 0)
        }
    }

    private func filter(_ title: String, symbol: String, kind: ToolLauncherCatalog.Kind?) -> some View {
        let active = selectedKind == kind
        return Button { selectedKind = kind } label: {
            Label(title, systemImage: symbol)
                .font(.system(size: 13, weight: active ? .semibold : .regular))
                .padding(.horizontal, 14).frame(height: 34)
                .foregroundStyle(active ? HubTheme.accent : HubTheme.textSecondary)
                .background(active ? HubTheme.accentSoft : HubTheme.surface, in: Capsule())
                .overlay(Capsule().stroke(active ? HubTheme.accent.opacity(0.35) : HubTheme.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }

    private func tile(_ item: ToolLauncherCatalog.Item) -> some View {
        Button { open(item) } label: {
            VStack(spacing: 8) {
                LauncherIcon(item: item, color: model.brandColorResolved(item.rawName))
                VStack(spacing: 2) {
                    Text(item.title).font(.system(size: 13, weight: .medium))
                        .multilineTextAlignment(.center).lineLimit(2).frame(height: 32, alignment: .top)
                    Text(item.kind.title).font(.system(size: 11)).foregroundStyle(HubTheme.textSecondary)
                }
            }
            .frame(maxWidth: .infinity).padding(.horizontal, 6).padding(.vertical, 8)
            .contentShape(RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(LauncherButtonStyle())
        .accessibilityLabel("\(item.title)，\(item.kind.title)")
        .help(item.title == item.rawName ? "打开 \(item.title) · \(item.kind.title)" : "打开 \(item.title)（\(item.rawName)）· \(item.kind.title)")
        .contextMenu { itemMenu(item) }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "magnifyingglass").font(.system(size: 32, weight: .light))
            Text(query.isEmpty ? "这里还没有应用" : "没有找到“\(query)”").font(.system(size: 17, weight: .medium))
            Text("可以搜索原名、个人名称或分组名称。")
                .font(.system(size: 13)).foregroundStyle(HubTheme.textSecondary)
            if !query.isEmpty { Button("清除搜索") { query = ""; searchFocused = true } }
        }
        .frame(maxWidth: .infinity).padding(.vertical, 80).padding(.horizontal, 28)
    }

    private var footer: some View {
        HStack {
            Text("\(resultCount) 个\(query.isEmpty ? "入口" : "搜索结果")").monospacedDigit()
            if !webOnly, !model.unavailableToolEntries.isEmpty {
                Text("已收起 \(model.unavailableToolEntries.count) 个失效入口")
            }
            Spacer()
            Text("点击打开 · 右键管理\(query.isEmpty ? "" : " · 回车打开首项")")
        }
        .font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
        .padding(.horizontal, 28).padding(.vertical, 14)
        .background(HubTheme.surface)
    }

    private var managementMenu: some View {
        Menu {
            Button("添加工具…") { model.addCustom() }
            Button("重新扫描工具与 PWA") { model.refreshToolInventory() }
            if !webOnly, !model.unavailableToolEntries.isEmpty {
                Menu("失效入口（\(model.unavailableToolEntries.count)）") {
                    ForEach(model.unavailableToolEntries) { entry in
                        Text("\(model.displayName(entry.name)) · \(entry.path)")
                    }
                }
            }
            Button("添加 PWA 分组…") {
                if let name = Prompt.text(title: "新建分组", message: "输入新分组名称", initial: "") { model.addPWAGroup(title: name) }
            }
            if !model.overrides.hidden.isEmpty {
                Menu("恢复隐藏项") {
                    ForEach(model.overrides.hidden, id: \.self) { name in Button(model.displayName(name)) { model.unhide(name) } }
                }
            }
        } label: { Image(systemName: "ellipsis.circle").font(.system(size: 18)).frame(width: 28, height: 28) }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .accessibilityLabel("管理工具与应用").help("管理工具与应用")
    }

    @ViewBuilder
    private func itemMenu(_ item: ToolLauncherCatalog.Item) -> some View {
        Button("打开") { open(item) }
        switch item.destination {
        case .terminal(let cli):
            Button("选择工作目录并打开…") {
                let panel = NSOpenPanel()
                panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
                panel.message = "选择 \(item.title) 的工作目录"
                if panel.runModal() == .OK, let url = panel.url { model.openCLI(cli, workingDirectory: url.path) }
            }
        case .desktop(let app), .web(let app):
            Button("在外部打开") { model.openApp(app) }
            Button("在 Finder 中显示") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: app.appPath)]) }
        case .project(let project):
            Button("在 Finder 中显示") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: project.path)]) }
        }
        Divider()
        if item.kind != .project {
            Button("重命名…") { model.rename(item.rawName) }
            if item.kind == .web {
                Menu("移至分组") {
                    ForEach(model.pwaSections) { group in
                        Button(model.sectionDisplayName(group.title)) { model.movePWA(item.rawName, to: group.title, before: nil) }
                    }
                }
            }
            Button("隐藏") { model.hide(item.rawName) }
        }
    }

    private func open(_ item: ToolLauncherCatalog.Item) {
        model.launcherError = nil
        switch item.destination {
        case .terminal(let entry): model.openCLI(entry)
        case .desktop(let entry): model.openPreferredApp(entry)
        case .web(let entry): model.openPWA(entry)
        case .project(let project): model.openProject(project)
        }
        if model.launcherError == nil { dismiss() }
    }

    private func chooseNativeApplication() {
        let panel = NSOpenPanel()
        panel.title = "在 AI Hub 内打开应用"
        panel.message = "选择一个 Mac 应用。应用会独立运行，窗口显示在 Hub 的标签中。"
        panel.prompt = "在 Hub 中打开"
        panel.allowedContentTypes = [.application]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.directoryURL = URL(fileURLWithPath: "/Applications", isDirectory: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let name = FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
        dismiss()
        model.openNativeAppInHub(AppEntry(name: name, appPath: url.path))
    }
}

private struct LauncherIcon: View {
    let item: ToolLauncherCatalog.Item
    let color: Color
    var body: some View {
        Group {
            if let image = SidebarIconCache.shared.image(for: item.icon, pixelSize: 192) {
                Image(nsImage: image).resizable().interpolation(.high).scaledToFit()
            } else {
                RoundedRectangle(cornerRadius: 20)
                    .fill(color.opacity(0.12))
                    .overlay {
                        if item.kind == .project {
                            Image(systemName: "folder.fill").font(.system(size: 36)).foregroundStyle(color)
                        } else {
                            Text(String(item.title.prefix(1)).uppercased()).font(.system(size: 32, weight: .semibold)).foregroundStyle(color)
                        }
                    }
            }
        }
        .frame(width: 76, height: 76)
        .accessibilityHidden(true)
    }
}

private struct LauncherButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { LauncherButtonBody(configuration: configuration) }
    private struct LauncherButtonBody: View {
        let configuration: Configuration
        @State private var hovering = false
        var body: some View {
            configuration.label
                .background(configuration.isPressed ? HubTheme.accentSoft : (hovering ? HubTheme.surface : Color.clear), in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(hovering ? HubTheme.border : .clear, lineWidth: 1))
                .onHover { hovering = $0 }
        }
    }
}
