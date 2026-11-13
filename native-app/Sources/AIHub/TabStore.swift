import AppKit
import Combine
import Foundation
import GhosttyTerminal
import SwiftUI
import UserNotifications

/// 标签/终端域（高频变化状态）：
/// hook 事件、bell、退出标记、标签选择/排序都在这里发布，
/// 与侧栏（SidebarStore/AppModel）隔离，避免状态点更新时整个侧栏重算。
@MainActor
final class TabStore: ObservableObject {
    // 依赖注入（由 AppModel 在 init 时装配）
    let controller: TerminalController
    weak var appModel: AppModel?

    @Published var showingOverview = false {
        didSet { if oldValue != showingOverview { updateTerminalVisibility() } }
    }
    @Published var tabs: [TerminalTab] = []
    @Published var selectedTabID: TerminalTab.ID? {
        didSet {
            if selectedTabID != nil {
                if selectedWebTabID != nil { selectedWebTabID = nil }
                if selectedNativeTabID != nil { selectedNativeTabID = nil }
                showingOverview = false
            }
            guard oldValue != selectedTabID else { return }
            updateTerminalVisibility()
        }
    }
    @Published var exitedPaneIDs: Set<TerminalPane.ID> = []    // 进程已退出的面板
    @Published var unseenBellTabIDs: Set<TerminalTab.ID> = []  // bell 响过但未被看到（等待审批）
    @Published var tabStatuses: [TerminalTab.ID: TabStatus] = [:]
    @Published var webTabs: [WebTab] = []
    @Published var selectedWebTabID: WebTab.ID? {
        didSet {
            if selectedWebTabID != nil {
                if selectedTabID != nil { selectedTabID = nil }
                if selectedNativeTabID != nil { selectedNativeTabID = nil }
                showingOverview = false
            }
            if oldValue != selectedWebTabID { updateTerminalVisibility() }
        }
    }
    @Published var nativeTabs: [NativeAppTab] = []
    @Published var selectedNativeTabID: NativeAppTab.ID? {
        didSet {
            if selectedNativeTabID != nil {
                if selectedTabID != nil { selectedTabID = nil }
                if selectedWebTabID != nil { selectedWebTabID = nil }
                showingOverview = false
            }
            if oldValue != selectedNativeTabID { updateTerminalVisibility() }
        }
    }
    @Published private(set) var isWindowVisible = true
    @Published private(set) var tabOrder: [UUID] = []
    var statusUpdatedAt: [TerminalTab.ID: Date] = [:]

    private var bellCancellables: [TerminalPane.ID: AnyCancellable] = [:]
    private var lastNotifiedAt: [TerminalTab.ID: Date] = [:]
    private var selectionCancellable: AnyCancellable?
    private var serverTasks: [UUID: Task<Void, Never>] = [:]

    func setWindowVisible(_ visible: Bool) {
        guard isWindowVisible != visible else { return }
        isWindowVisible = visible
        updateTerminalVisibility()
    }

    private func updateTerminalVisibility() {
        for tab in tabs {
            for pane in tab.panes { pane.setVisible(isWindowVisible && !showingOverview && tab.id == selectedTabID) }
        }
        for tab in nativeTabs {
            tab.setVisible(isWindowVisible && !showingOverview && tab.id == selectedNativeTabID)
        }
    }

    init(controller: TerminalController) {
        self.controller = controller
        // 切到某个标签时，清除它的未读 bell
        selectionCancellable = $selectedTabID.receive(on: RunLoop.main).sink { [weak self] id in
            guard let self, let id else { return }
            self.unseenBellTabIDs.remove(id)
        }
    }

    // MARK: - 打开终端标签

    func openCLI(_ cli: CLIEntry, workingDirectory: String? = nil, resumeCommand: String? = nil) {
        NSLog("[AIHub] openCLI \(cli.name) cwd=\(workingDirectory ?? "~") resume=\(resumeCommand != nil)")
        let pane = TerminalPane(cli: cli, controller: controller)
        let tab = TerminalTab(cli: cli, root: .leaf(pane), panes: [pane])
        var env = Self.baseEnvVars(tabID: tab.id, paneID: pane.id, cliName: cli.name, environment: cli.environment)
        if let resumeCommand { env["AIHUB_RESUME_CMD"] = resumeCommand }
        pane.state.configuration = TerminalSurfaceOptions(
            backend: .exec,
            workingDirectory: workingDirectory ?? NSHomeDirectory(),
            envVars: env,
            command: resumeCommand != nil ? HookInstaller.resumeScriptPath : cli.command
        )
        tab.onRequestClose = { [weak self, weak tab] in
            guard let tab else { return }
            self?.closeTab(id: tab.id)
        }
        attach(pane: pane, to: tab)
        tabOrder = orderedTabs.map(\.id) + [tab.id]
        tabs.append(tab)
        selectedTabID = tab.id
        selectedWebTabID = nil   // CLI 标签优先于网页标签
    }

    /// 终端环境变量（含 Hook 桥接注入：paneID → hook 脚本 → spool → 精确映射回标签）
    ///
    /// 基底是登录 shell 抓到的环境（`ShellEnvironment.terminalInjection`），
    /// 这样 nvm / mise / bun / cargo 等装在 `~/.zshrc` 里的可执行文件在 PTY 里
    /// 可见。Ghostty 的 envVars 叠加在继承环境之上，因此这里只补充增量。
    /// 抓取未完成时退化为改动前的行为。
    static func baseEnvVars(tabID: UUID, paneID: UUID, cliName: String, environment: [String: String] = [:]) -> [String: String] {
        ShellEnvironment.terminalInjection.merging([
            "PATH": AppModel.augmentedPATH,
            "TERM_PROGRAM": "AIHub",
            "TERM_PROGRAM_VERSION": "2.0",
            "AIHUB_TAB_ID": tabID.uuidString,
            "AIHUB_PANE_ID": paneID.uuidString,
            "AIHUB_SPOOL": HookInstaller.spoolDir,
        ]) { _, explicit in explicit }
            .merging(environment) { _, scopedValue in scopedValue }
    }

    /// pane 的退出/bell 监听（新 pane 与分屏拆分共用）
    private func attach(pane: TerminalPane, to tab: TerminalTab) {
        // 进程退出：标记而非自动关闭，保留输出可查
        let paneID = pane.id
        let tabID = tab.id
        pane.state.onClose = { [weak self] _ in
            Task { @MainActor in
                guard let self, self.tabs.contains(where: { $0.id == tabID && $0.panes.contains(where: { $0.id == paneID }) }) else { return }
                self.exitedPaneIDs.insert(paneID)
                self.unseenBellTabIDs.remove(tabID)
            }
        }
        // bell 监听：agent 在等操作（审批）
        bellCancellables[pane.id] = pane.state.$lastBellAt.receive(on: RunLoop.main).sink { [weak self, weak tab] date in
            guard date != nil else { return }
            Task { @MainActor in
                guard let self, let tab, self.tabs.contains(where: { $0.id == tabID }), !self.exitedPaneIDs.contains(paneID) else { return }
                if self.showingOverview || self.selectedTabID != tabID {
                    self.unseenBellTabIDs.insert(tabID)
                    self.postNotification(for: tab, body: "终端在等待你的操作（bell 响铃）")
                }
            }
        }
    }

    // MARK: - 分屏操作

    enum SplitDirection {
        case right   // 左右
        case down    // 上下
    }

    /// 在 pane 旁边分出一个新面板。direction: right / down
    func splitPane(tab: TerminalTab, paneID: TerminalPane.ID, direction: SplitDirection, cli: CLIEntry? = nil) {
        guard let idx = tab.panes.firstIndex(where: { $0.id == paneID }) else { return }
        let selectedCLI = cli ?? tab.panes[idx].cli
        let newPane = TerminalPane(cli: selectedCLI, controller: controller)
        newPane.state.configuration = TerminalSurfaceOptions(
            backend: .exec,
            workingDirectory: NSHomeDirectory(),
            envVars: Self.baseEnvVars(
                tabID: tab.id, paneID: newPane.id, cliName: selectedCLI.name, environment: selectedCLI.environment),
            command: selectedCLI.command
        )
        tab.panes.append(newPane)
        newPane.setVisible(isWindowVisible && selectedTabID == tab.id)
        attach(pane: newPane, to: tab)

        // 在树中找到 paneID 的叶子节点，替换为分叉
        func splitNode(_ node: PaneNode) -> Bool {
            if node.pane?.id == paneID {
                let horizontal = direction == .right   // right=左右排 → HStack
                node.horizontal = horizontal
                node.a = PaneNode.leaf(node.pane!)
                node.b = PaneNode.leaf(newPane)
                node.pane = nil
                return true
            }
            if let a = node.a, splitNode(a) { return true }
            if let b = node.b, splitNode(b) { return true }
            return false
        }
        _ = splitNode(tab.root)
    }

    /// 关闭单个面板；最后一个面板关闭 → 关标签
    func closePane(tab: TerminalTab, paneID: TerminalPane.ID) {
        guard tab.panes.count > 1 else { closeTab(id: tab.id); return }
        tab.panes.first(where: { $0.id == paneID })?.dispose()
        tab.panes.removeAll { $0.id == paneID }
        exitedPaneIDs.remove(paneID)
        bellCancellables[paneID] = nil

        // 树中摘除叶子：分叉塌缩为另一枝
        func collapse(_ node: PaneNode) -> Bool {
            if node.a?.pane?.id == paneID || node.b?.pane?.id == paneID {
                let keep = node.a?.pane?.id == paneID ? node.b! : node.a!
                node.horizontal = keep.horizontal
                node.a = keep.a
                node.b = keep.b
                node.pane = keep.pane
                return true
            }
            if let a = node.a, collapse(a) { return true }
            if let b = node.b, collapse(b) { return true }
            return false
        }
        _ = collapse(tab.root)
    }

    func closeTab(id: TerminalTab.ID) {
        guard let index = tabs.firstIndex(where: { $0.id == id }) else { return }
        let previousOrder = orderedTabs.map(\.id)
        let wasSelected = selectedTabID == id
        let tab = tabs.remove(at: index)
        for pane in tab.panes {
            pane.dispose()
            bellCancellables[pane.id] = nil
            exitedPaneIDs.remove(pane.id)
        }
        tab.onRequestClose = nil
        lastNotifiedAt[id] = nil
        tabOrder.removeAll { $0 == id }
        unseenBellTabIDs.remove(id)
        tabStatuses.removeValue(forKey: id)
        statusUpdatedAt.removeValue(forKey: id)
        if wasSelected {
            selectedTabID = nil
            selectAfterClosing(id, previousOrder: previousOrder)
        }
    }

    // MARK: - 网页标签

    func openPWA(_ entry: AppEntry) {
        guard !AppModel.isPreview else { return }
        guard let url = pwaURL(for: entry) else {
            appModel?.openNativeAppInHub(entry)
            return
        }
        openWeb(title: entry.name, url: url, ensureLocalService: true)
    }

    /// Share the same tab lifecycle across PWA and workbench application pages.
    /// Only the existing PWA launcher can request its registered local service.
    func openWeb(title: String, url: URL, ensureLocalService: Bool = false) {
        // Repeated entry clicks activate the existing page and retain drafts.
        showingOverview = false
        if let existing = webTabs.first(where: { $0.url == url }) {
            selectedWebTabID = existing.id
            selectedTabID = nil
            return
        }
        let tab = WebTab(title: title, url: url, accent: HubTheme.brandColor(for: title.lowercased()))
        tabOrder = orderedTabs.map(\.id) + [tab.id]
        webTabs.append(tab)
        selectedWebTabID = tab.id
        selectedTabID = nil
        if ensureLocalService { ensureLocalServer(for: url, tab: tab) }
    }

    func closeWebTab(id: WebTab.ID) {
        let previousOrder = orderedTabs.map(\.id)
        let wasSelected = selectedWebTabID == id
        serverTasks.removeValue(forKey: id)?.cancel()
        webTabs.first(where: { $0.id == id })?.holder.dispose()
        webTabs.removeAll { $0.id == id }
        tabOrder.removeAll { $0 == id }
        if wasSelected {
            selectedWebTabID = nil
            selectAfterClosing(id, previousOrder: previousOrder)
        }
    }

    // MARK: - 原生应用窗口

    /// A tab owns the mirror session only. The application owns its process/windows.
    func openNativeApp(_ entry: AppEntry) {
        guard !AppModel.isPreview else { return }
        let canonical = URL(fileURLWithPath: entry.appPath).resolvingSymlinksInPath().standardizedFileURL.path
        if let existing = nativeTabs.first(where: {
            URL(fileURLWithPath: $0.appPath).resolvingSymlinksInPath().standardizedFileURL.path == canonical
        }) {
            focusNativeTab(id: existing.id)
            return
        }
        let tab = NativeAppTab(appPath: entry.appPath, appName: appModel?.displayName(entry.name) ?? entry.name)
        tabOrder = orderedTabs.map(\.id) + [tab.id]
        nativeTabs.append(tab)
        selectedNativeTabID = tab.id
        tab.open()
    }

    func focusNativeTab(id: NativeAppTab.ID) {
        guard nativeTabs.contains(where: { $0.id == id }) else { return }
        selectedNativeTabID = id
        NSApp.activate(ignoringOtherApps: true)
        NSApp.windows.first { $0.title == "AI Hub" }?.makeKeyAndOrderFront(nil)
    }

    func closeNativeTab(id: NativeAppTab.ID) {
        guard let index = nativeTabs.firstIndex(where: { $0.id == id }) else { return }
        let previousOrder = orderedTabs.map(\.id)
        let wasSelected = selectedNativeTabID == id
        let tab = nativeTabs.remove(at: index)
        tab.close()
        tabOrder.removeAll { $0 == id }
        if wasSelected {
            selectedNativeTabID = nil
            selectAfterClosing(id, previousOrder: previousOrder)
        }
    }

    /// Keep the neighboring tab selected even when its presentation type differs.
    private func selectAfterClosing(_ id: UUID, previousOrder: [UUID]) {
        let remaining = orderedTabs
        guard !remaining.isEmpty else {
            showingOverview = true
            return
        }
        let index = min(previousOrder.firstIndex(of: id) ?? 0, remaining.count - 1)
        let next = remaining[index]
        switch next.kind {
        case .terminal: selectedTabID = next.id
        case .web: selectedWebTabID = next.id
        case .native: selectedNativeTabID = next.id
        }
    }

    private func pwaURL(for entry: AppEntry) -> URL? {
        let plist = entry.appPath + "/Contents/Info.plist"
        guard let dict = NSDictionary(contentsOfFile: plist),
              let u = dict["CrAppModeShortcutURL"] as? String else { return nil }
        return URL(string: u)
    }

    /// 打开 127.0.0.1 的 PWA 时，端口没起来就后台拉对应服务，起来后再 reload
    private func ensureLocalServer(for url: URL, tab: WebTab) {
        guard url.host == "127.0.0.1" || url.host == "localhost" else { return }
        let port = url.port ?? (url.scheme == "https" ? 443 : 80)
        let tabID = tab.id
        serverTasks[tabID] = Task { @MainActor [weak self, weak tab] in
            guard let self else { return }
            defer { self.serverTasks[tabID] = nil }
            if await self.httpAlive(url) { return }
            guard !Task.isCancelled else { return }
            self.startLocalServer(port: port)
            for _ in 0..<30 {
                do { try await Task.sleep(nanoseconds: 500_000_000) } catch { return }
                if await self.httpAlive(url) {
                    guard !Task.isCancelled else { return }
                    // The initial connection failure can leave WKWebView.url nil.
                    tab?.holder.load(url)
                    return
                }
            }
            NSLog("[AIHub] local server :%d did not come up", port)
        }
    }

    private func httpAlive(_ url: URL) async -> Bool {
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.timeoutInterval = 1.5
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse else { return false }
            return (200..<500).contains(http.statusCode)
        } catch {
            return false
        }
    }

    private func startLocalServer(port: Int) {
        guard let service = ToolCatalog.shared.localService(port: port) else {
            NSLog("[AIHub] local server port %d has no auto-start mapping", port)
            return
        }
        let argv = ([service.command] + service.args).map(shellQuote).joined(separator: " ")
        launchDetached(shell: "nohup \(argv) >> \(shellQuote(service.logPath)) 2>&1 &")
    }

    /// Quote one shell argument without evaluating whitespace or shell metacharacters.
    private func shellQuote(_ argument: String) -> String {
        "'" + argument.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    private func launchDetached(shell: String) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/zsh")
        task.arguments = ["-lc", shell]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = AppModel.augmentedPATH
        task.environment = env
        do {
            try task.run()
            NSLog("[AIHub] launched shell: %@", shell)
        } catch {
            NSLog("[AIHub] launch failed: %@", error.localizedDescription)
        }
    }

    // MARK: - 标签栏拖拽排序（终端/网页/原生窗口统一顺序）

    struct TabItem: Identifiable {
        enum Kind { case terminal, web, native }
        let kind: Kind
        let id: UUID
    }

    private func terminalTab(_ id: UUID) -> TerminalTab? { tabs.first { $0.id == id } }
    private func webTab(_ id: UUID) -> WebTab? { webTabs.first { $0.id == id } }
    private func nativeTab(_ id: UUID) -> NativeAppTab? { nativeTabs.first { $0.id == id } }

    var orderedTabs: [TabItem] {
        var seen = Set<UUID>()
        var items: [TabItem] = []
        for id in tabOrder {
            if terminalTab(id) != nil { items.append(.init(kind: .terminal, id: id)); seen.insert(id) }
            else if webTab(id) != nil { items.append(.init(kind: .web, id: id)); seen.insert(id) }
            else if nativeTab(id) != nil { items.append(.init(kind: .native, id: id)); seen.insert(id) }
        }
        for t in tabs where !seen.contains(t.id) { items.append(.init(kind: .terminal, id: t.id)) }
        for w in webTabs where !seen.contains(w.id) { items.append(.init(kind: .web, id: w.id)) }
        for n in nativeTabs where !seen.contains(n.id) { items.append(.init(kind: .native, id: n.id)) }
        return items
    }

    /// 拖拽换位：before = 插到目标标签前，nil = 排尾
    func moveTab(_ id: UUID, before targetID: UUID?) {
        guard id != targetID else { return }
        var order = orderedTabs.map { $0.id }
        order.removeAll { $0 == id }
        if let targetID, let idx = order.firstIndex(of: targetID) {
            order.insert(id, at: idx)
        } else {
            order.append(id)
        }
        tabOrder = order
    }

    // MARK: - Hook 事件处理

    /// Hook 事件 → tab 状态 + 通知（paneID 精确绑定，跨 pane 取所属 tab）
    func handleHookEvent(_ ev: HookEvent) {
        guard let tab = tabs.first(where: { $0.panes.contains { $0.id == ev.paneID } }) else { return } // 旧会话残留丢弃
        statusUpdatedAt[tab.id] = Date()
        switch ev.event {
        case "UserPromptSubmit":
            tabStatuses[tab.id] = .running
        case "SessionStart":
            tabStatuses[tab.id] = .idle
        case "Notification":
            tabStatuses[tab.id] = .waiting
            unseenBellTabIDs.insert(tab.id)
            let msg = ev.payload["message"] as? String ?? "等待审批/输入"
            if showingOverview || selectedTabID != tab.id { postNotification(for: tab, body: msg) }
        case "PermissionRequest":
            tabStatuses[tab.id] = .waiting
            unseenBellTabIDs.insert(tab.id)
            if showingOverview || selectedTabID != tab.id { postNotification(for: tab, body: "Codex 请求权限") }
        case "Stop":
            tabStatuses[tab.id] = .done
            if showingOverview || selectedTabID != tab.id { postNotification(for: tab, body: "任务完成") }
        case "SessionEnd", "Interrupt":
            tabStatuses[tab.id] = .idle
        default:
            break   // SubagentStop 等不影响回合状态
        }
    }

    private func postNotification(for tab: TerminalTab, body: String) {
        if let last = lastNotifiedAt[tab.id], Date().timeIntervalSince(last) < 10 { return }
        lastNotifiedAt[tab.id] = Date()
        let content = UNMutableNotificationContent()
        content.title = tab.cli.title
        content.body = String(body.prefix(180))
        content.userInfo = ["tabID": tab.id.uuidString]
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: tab.id.uuidString, content: content, trigger: nil)
        )
    }

    func focusTab(id: TerminalTab.ID) {
        guard tabs.contains(where: { $0.id == id }) else { return }
        selectedTabID = id
        selectedWebTabID = nil
        NSApp.activate(ignoringOtherApps: true)
        NSApp.windows.first { $0.title == "AI Hub" }?.makeKeyAndOrderFront(nil)
    }

    /// 文件浏览器：切到当前终端的工作目录并显示（browser 状态在 AppModel）
    func currentWorkingDirectory() -> String? {
        if let tabID = selectedTabID, let tab = tabs.first(where: { $0.id == tabID }), let cwd = tab.primary?.state.workingDirectory, !cwd.isEmpty {
            return cwd
        }
        return nil
    }
}
