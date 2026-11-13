import AppKit
import Combine
import Foundation
import GhosttyTerminal
import SwiftUI
import UserNotifications

struct CLIEntry: Identifiable, Hashable {
    var id: String { catalogID ?? name + "\0" + command }
    let name: String
    let command: String
    let title: String
    var catalogID: String? = nil
    var pathPrepend: [String] = []
    var environment: [String: String] {
        guard !pathPrepend.isEmpty else { return [:] }
        var seen = Set<String>()
        let paths = (pathPrepend + ToolCatalog.shared.pathEntries).filter { seen.insert($0).inserted }
        return ["PATH": paths.joined(separator: ":")]
    }
}

struct AppEntry: Identifiable, Hashable {
    var id: String { catalogID ?? name + "\0" + appPath }
    let name: String
    let appPath: String
    var catalogID: String? = nil
}

struct WebEntry: Identifiable, Hashable {
    let id = UUID()
    let name: String
    let url: URL
}

struct Project: Identifiable, Codable, Hashable {
    var id: String = UUID().uuidString
    var name: String
    var path: String
    var cli: String = "claude"   // 默认启动的 CLI
}

@MainActor
final class TerminalPane: Identifiable {
    let id = UUID()
    let cli: CLIEntry
    let state: TerminalViewState
    // Ghostty's state only weakly references the surface. The pane owns the
    // native view so SwiftUI can detach/reparent it without restarting the PTY.
    private(set) var platformView: TerminalView?
    init(cli: CLIEntry, controller: TerminalController) {
        self.cli = cli
        state = TerminalViewState(controller: controller)
        state.isSurfaceVisible = false
        state.makePlatformView = { [weak self] in
            guard let self else { return TerminalView(frame: .zero) }
            if let view = self.platformView { return view }
            let view = TerminalView(frame: .zero)
            view.isHidden = !self.state.isSurfaceVisible
            self.platformView = view
            return view
        }
    }

    func setVisible(_ visible: Bool) {
        if state.isSurfaceVisible != visible { state.isSurfaceVisible = visible }
        platformView?.isHidden = !visible
        platformView?.setSurfaceVisible(visible)
    }

    func dispose() {
        setVisible(false)
        state.onClose = nil
        state.makePlatformView = nil
        if let view = platformView, view.window?.firstResponder === view {
            view.window?.makeFirstResponder(nil)
        }
        platformView?.delegate = nil
        // Explicitly free the PTY/rendering surface even if SwiftUI retains an
        // old view briefly during a layout transaction.
        platformView?.controller = nil
        platformView?.removeFromSuperview()
        platformView = nil
    }
}

/// 分屏树节点：horizontal = nil 为叶子（挂 pane），否则左右(h)/上下(v)二分
@MainActor
final class PaneNode: ObservableObject, Identifiable {
    let id = UUID()
    @Published var horizontal: Bool? = nil
    @Published var a: PaneNode? = nil
    @Published var b: PaneNode? = nil
    @Published var fraction: Double = 0.5   // a 占比
    var pane: TerminalPane? = nil   // 叶子载荷（tab.panes 强持有）

    static func leaf(_ pane: TerminalPane) -> PaneNode {
        let n = PaneNode(); n.pane = pane; return n
    }
}

@MainActor
final class TerminalTab: ObservableObject, Identifiable {
    let id = UUID()
    let cli: CLIEntry
    @Published var panes: [TerminalPane] = []
    @Published var root: PaneNode
    var onRequestClose: (() -> Void)?

    init(cli: CLIEntry, root: PaneNode, panes: [TerminalPane]) {
        self.cli = cli
        self.root = root
        self.panes = panes
    }

    var primary: TerminalPane? { panes.first }
}

@MainActor
final class AppModel: ObservableObject {
    /// 目录条目来自 `tool-catalog.json`，其后拼接登录 shell 抓到的 PATH。
    /// 抓取未完成或失败时等价于改动前行为（只有目录条目）。
    static var augmentedPATH: String {
        ShellEnvironment.mergePath(
            catalog: ToolCatalog.shared.pathEntries.joined(separator: ":"),
            captured: ShellEnvironment.isResolved ? ShellEnvironment.baseEnvironment["PATH"] : nil
        )
    }

    let cliEntries: [CLIEntry] = ToolCatalog.shared.cli.map {
        CLIEntry(name: $0.name, command: $0.command, title: $0.title, catalogID: $0.id, pathPrepend: $0.pathPrepend ?? [])
    }
    let appEntries: [AppEntry] = ToolCatalog.shared.apps.map {
        AppEntry(name: $0.name, appPath: $0.path, catalogID: $0.id)
    }
    @Published var launcherError: String? = ToolCatalog.loadError

    /// Chrome PWA 路径辅助
    static func PWA(_ name: String) -> String {
        NSHomeDirectory() + "/Applications/Chrome Apps.localized/\(name).app"
    }

    // Chrome PWA：运行时扫描 + 按功能分组
    struct PWASection: Identifiable {
        let title: String
        var items: [AppEntry]
        var id: String { title }
    }

    @Published private(set) var pwaSections: [PWASection] = []

    private var pwaInventory: [(String, AppEntry)]?

    func refreshToolInventory() {
        // CLI/App projections read current filesystem state as well. Publishing
        // the rebuilt PWA collection refreshes every shared inventory consumer.
        pwaInventory = nil
        pwaSections = buildPWASections()
        launcherError = ToolCatalog.loadError
    }

    func buildPWASections() -> [PWASection] {
        let dir = NSHomeDirectory() + "/Applications/Chrome Apps.localized"
        let items = pwaInventory == nil ? ((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []) : []
        let entries: [(String, AppEntry)] = pwaInventory ?? items.sorted()
            .filter { $0.hasSuffix(".app") }
            .compactMap { name -> (String, AppEntry)? in
                let key = String(name.dropLast(4))
                guard ToolCatalog.isAvailableApp(dir + "/" + name),
                      let dict = NSDictionary(contentsOfFile: dir + "/" + name + "/Contents/Info.plist"),
                      let url = dict["CrAppModeShortcutURL"] as? String, !url.isEmpty else { return nil }
                return (key, AppEntry(name: key, appPath: AppModel.PWA(key)))
            }
        pwaInventory = entries
        let k = entries.map { ($0.0.lowercased(), $0.1) }

        // 关键词带 = 前缀 = 精确匹配（防 "x" 误抓 okx/proxy 等）
        func match(_ key: String, _ kw: String) -> Bool {
            kw.hasPrefix("=") ? key == String(kw.dropFirst()) : key.contains(kw)
        }
        var seen = Set<String>()   // 每个条目只归入首个命中的分组，杜绝跨组重复
        func pick(_ keywords: [String]) -> [AppEntry] {
            let matched = k.filter { e in
                guard !seen.contains(e.1.name) else { return false }
                return keywords.contains { match(e.0, $0) }
            }
            matched.forEach { seen.insert($0.1.name) }
            return matched.map { $0.1 }
        }
        let used = ["artificial analysis", "arena", "autodl", "cli proxy", "datalearner", "pricetag", "pinchbench", "图像编辑模型排行榜",
                                 "hugging face", "kaggle", "魔搭", "openrouter",
                                 "deepseek harness", "new api", "openclaw", "paperclip", "odysseus", "opencreator", "wiki", "notebook",
                                 "grok", "perplexity", "linux do",
                                 "coingecko", "coinglass", "defillama", "gate", "hyperliquid", "okx", "资产总览", "polymarket",
                                 "=x", "reddit", "youtube", "github", "dribbble", "miro", "figma"]

        let ov = overrides
        let apply = { (items: [AppEntry]) -> [AppEntry] in
            items.filter { !ov.hidden.contains($0.name) }
                 .map { AppEntry(name: $0.name, appPath: $0.appPath) }
        }
        let base: [(String, [AppEntry])] = [
            ("AI 评测", pick(["artificial analysis", "arena", "autodl", "cli proxy", "datalearner", "pricetag", "pinchbench", "图像编辑模型排行榜"])),
            ("模型社区", pick(["hugging face", "kaggle", "魔搭", "openrouter"])),
            ("自托管", pick(["deepseek harness", "new api", "openclaw", "paperclip", "odysseus", "opencreator", "wiki", "notebook"])),
            ("AI 助手", pick(["grok", "perplexity", "linux do"])),
            ("加密行情", pick(["coingecko", "coinglass", "defillama", "gate", "hyperliquid", "okx", "资产总览", "polymarket"])),
            ("社媒资讯", pick(["x", "reddit", "youtube", "github", "dribbble", "miro", "figma"])),
        ]
        var sections = base.map { PWASection(title: $0.0, items: apply($0.1)) }
        // 未命中任何关键词的才进「其他」（子串判断，修精确匹配漏洞）
        let others = k.filter { e in
            !seen.contains(e.1.name) && !used.contains { match(e.0, $0) }
        }.map { $0.1 }
        sections.append(PWASection(title: "其他", items: apply(others)))
        for title in ov.customPWAGroups where !sections.contains(where: { $0.title == title }) {
            sections.append(PWASection(title: title, items: []))
        }
        for (raw, target) in ov.moves {
            guard !ov.hidden.contains(raw),
                  let entry = k.first(where: { $0.1.name == raw })?.1,
                  let destination = sections.firstIndex(where: { $0.title == target }) else { continue }
            for i in sections.indices { sections[i].items.removeAll { $0.name == raw } }
            sections[destination].items.append(entry)
        }
        // 用户自定义组内顺序（缺失名保持原扫描相对顺序排尾）
        if !ov.orders.isEmpty {
            sections = sections.map { sec in
                guard let ord = ov.orders[sec.title] else { return sec }
                let rank = Dictionary(ord.enumerated().map { ($0.element, $0.offset) }, uniquingKeysWith: { first, _ in first })
                let sorted = sec.items.enumerated().sorted {
                    let r0 = rank[$0.element.name] ?? Int.max
                    let r1 = rank[$1.element.name] ?? Int.max
                    return r0 == r1 ? $0.offset < $1.offset : r0 < r1
                }.map { $0.element }
                return PWASection(title: sec.title, items: sorted)
            }
        }
        return sections.filter { !$0.items.isEmpty || ov.customPWAGroups.contains($0.title) }
    }

    /// 添加新 PWA 分组
    func addPWAGroup(title: String) {
        if title.isEmpty || pwaSections.contains { $0.title == title } { return } // 空名或重名跳过
        var o = overrides
        o.customPWAGroups.append(title)
        overrides = o
    }

    /// 重命名 PWA 分组
    func renamePWAGroup(old: String, new: String) {
        if old == new || new.isEmpty || pwaSections.contains { $0.title == new } { return }
        var o = overrides
        // 重命名 custom 里去掉老的，加上新的
        if let idx = o.customPWAGroups.firstIndex(of: old) {
            o.customPWAGroups[idx] = new
        }
        // 重命名 orders 里去掉，保留顺序
        if let oldOrder = o.orders.removeValue(forKey: old) {
            o.orders[new] = oldOrder
        }
        // 重命名 moves：items in old group → moves[raw] = new
        for (raw, group) in o.moves {
            if group == old {
                o.moves[raw] = new
            }
        }
        overrides = o
    }

    /// 删除 PWA 分组
    func deletePWAGroup(title: String) {
        var o = overrides
        // 从 custom 里删掉
        o.customPWAGroups.removeAll { $0 == title }
        // 删掉 orders
        o.orders.removeValue(forKey: title)
        // 将组内所有 item 移动到 "其他"
        for (raw, group) in o.moves {
            if group == title {
                o.moves[raw] = "其他"
            }
        }
        overrides = o
    }


    /// Shared controller: one ghostty app instance, Codex-style neutral light
    /// theme for both light and dark scheme lookups (the app forces light appearance).
    let terminalController: TerminalController = {
        let config = TerminalConfiguration { builder in
            builder.withFontSize(13)
            builder.withBackground("#F5F8FD")
            builder.withForeground("#24334E")
            builder.withCursorColor("#4A6FB8")
            builder.withSelectionBackground("#DBE7F8")
            builder.withWindowPaddingX(8)
            builder.withWindowPaddingY(6)
            // Ghostty scrollback-limit is measured in bytes, not lines.
            builder.withCustom("scrollback-limit", "20000")
        }
        return TerminalController(
            configuration: config,
            theme: TerminalTheme(light: config, dark: config)
        )
    }()

    /// 标签/终端域（高频变化状态独立发布，与侧栏隔离）
    let tabStore: TabStore

    // ── 监看状态（侧栏 App 运行指示用）──
    @Published var runningApps: Set<String> = []               // 正在运行的 App 路径

    let hookBridge = HookBridge()
    @Published var showFileBrowser: Bool = false
    @Published var browserPath: String = NSHomeDirectory()

    /// 文件浏览器：切到当前终端的工作目录并显示
    func browseCurrentDirectory() {
        if let cwd = tabStore.currentWorkingDirectory() {
            browserPath = cwd
        }
        showFileBrowser = true
    }

    /// 从历史面板恢复会话：新终端 tab，工作目录 = 原会话 cwd，resume 走 wrapper 脚本
    func openHistorySession(_ s: HistorySession) {
        guard let cli = cliEntries.first(where: { $0.name == s.source.rawValue })
                ?? customCLIEntries.first(where: { $0.name == s.source.rawValue }) else {
            revealHistoryFile(s)
            return
        }
        let cmd: String
        switch s.source {
        case .claude: cmd = "exec '\(cli.command)' --resume '\(s.sessionID)'"
        case .codex: cmd = "exec '\(cli.command)' resume '\(s.sessionID)'"
        case .opencode: cmd = "exec '\(cli.command)' --session '\(s.sessionID)'"
        case .kimi: cmd = "exec '\(cli.command)' --session '\(s.sessionID)'"
        case .grok: cmd = "exec '\(cli.command)'"   // grok 仅支持 -c(最近会话),按目录打开
        }
        openCLI(cli, workingDirectory: s.cwd, resumeCommand: cmd)
    }

    func revealHistoryFile(_ s: HistorySession) {
        guard !s.filePath.contains("://") else { return }   // opencode 虚拟路径无文件可显
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: s.filePath)])
    }
    // ── 侧栏分区折叠状态（UserDefaults 持久化）──
    @Published var cliCollapsed: Bool = UserDefaults.standard.bool(forKey: "section.cli.collapsed") {
        didSet { UserDefaults.standard.set(cliCollapsed, forKey: "section.cli.collapsed") }
    }
    @Published var appsCollapsed: Bool = UserDefaults.standard.bool(forKey: "section.apps.collapsed") {
        didSet { UserDefaults.standard.set(appsCollapsed, forKey: "section.apps.collapsed") }
    }
    @Published var projectsCollapsed: Bool = UserDefaults.standard.bool(forKey: "section.projects.collapsed") {
        didSet { UserDefaults.standard.set(projectsCollapsed, forKey: "section.projects.collapsed") }
    }
    // ── 布局状态（UserDefaults 持久化）──
    @Published var sidebarCollapsed: Bool = UserDefaults.standard.bool(forKey: "ui.sidebar.collapsed") {
        didSet { UserDefaults.standard.set(sidebarCollapsed, forKey: "ui.sidebar.collapsed") }
    }
    @Published var sidebarWidth: Double = UserDefaults.standard.object(forKey: "ui.sidebar.width") as? Double ?? 240 {
        didSet { UserDefaults.standard.set(sidebarWidth, forKey: "ui.sidebar.width") }
    }
    @Published var tabBarAtBottom: Bool = UserDefaults.standard.bool(forKey: "ui.tabbar.bottom") {
        didSet { UserDefaults.standard.set(tabBarAtBottom, forKey: "ui.tabbar.bottom") }
    }

    @Published var collapsedPWAGroups: Set<String> = Set(
        UserDefaults.standard.dictionaryRepresentation().keys.compactMap { key in
            guard key.hasPrefix("section.pwa."), key.hasSuffix(".collapsed"),
                  UserDefaults.standard.bool(forKey: key) else { return nil }
            return String(key.dropFirst("section.pwa.".count).dropLast(".collapsed".count))
        }
    )

    @Published var webCollapsed: Bool = UserDefaults.standard.bool(forKey: "section.web.collapsed") {
        didSet { UserDefaults.standard.set(webCollapsed, forKey: "section.web.collapsed") }
    }

    nonisolated static var isPreview: Bool { Bundle.main.object(forInfoDictionaryKey: "AIHubPreviewMode") as? Bool == true }

    init() {
        tabStore = TabStore(controller: terminalController)
        tabStore.appModel = self
        AppDelegate.model = self
        pwaSections = buildPWASections()
        if !Self.isPreview {
            setupAppMonitoring()
            setupNotificationCenter()
            hookBridge.handler = { [weak self] ev in
                Task { @MainActor in self?.tabStore.handleHookEvent(ev) }
            }
            hookBridge.start()
            // Shared client configuration is owned by Magpie; never install hooks on launch.
        }
        loadProjects()
        // 首次启动且无任何项目时，仅 seed 一个 ai-hub（后续全部手动添加，不自动扫描）
        if projects.isEmpty {
            let aiHub = NSHomeDirectory() + "/Projects/ai-hub"
            if FileManager.default.fileExists(atPath: aiHub) {
                projects.append(Project(name: "ai-hub", path: aiHub, cli: "claude"))
            }
        }
    }

    // MARK: - 标签/终端操作（转发到 tabStore）

    func openCLI(_ cli: CLIEntry, workingDirectory: String? = nil, resumeCommand: String? = nil) {
        guard !Self.isPreview else { return }
        if !ToolCatalog.isAvailableCommand(cli.command) {
            launcherError = "\(displayName(cli.name)) 的命令入口不存在或不可执行：\(cli.command)"
            return
        }
        launcherError = nil
        tabStore.openCLI(cli, workingDirectory: workingDirectory, resumeCommand: resumeCommand)
    }

    /// 在 pane 旁边分出一个新面板。direction: right / down
    func splitPane(tab: TerminalTab, paneID: TerminalPane.ID, direction: TabStore.SplitDirection, cli: CLIEntry? = nil) {
        tabStore.splitPane(tab: tab, paneID: paneID, direction: direction, cli: cli)
    }

    /// 关闭单个面板；最后一个面板关闭 → 关标签
    func closePane(tab: TerminalTab, paneID: TerminalPane.ID) {
        tabStore.closePane(tab: tab, paneID: paneID)
    }

    func closeTab(id: TerminalTab.ID) {
        tabStore.closeTab(id: id)
    }

    @Published private(set) var projects: [Project] = [] {
        didSet { saveProjects() }
    }

    // MARK: - 项目管理

    private func loadProjects() {
        if let data = UserDefaults.standard.data(forKey: "aihub.projects"),
           let arr = try? JSONDecoder().decode([Project].self, from: data) {
            projects = arr
        }
    }

    private func saveProjects() {
        if let data = try? JSONEncoder().encode(projects) {
            UserDefaults.standard.set(data, forKey: "aihub.projects")
        }
    }

    func addProject(name: String, path: String, cli: String = "claude") {
        let cleanName = name.trimmingCharacters(in: .whitespaces)
        guard !cleanName.isEmpty, !path.isEmpty else { return }
        guard !projects.contains(where: { $0.path == path }) else { return }
        projects.append(Project(name: cleanName, path: path, cli: cli))
    }

    func moveProject(_ id: String, before target: String?) {
        guard id != target, let source = projects.firstIndex(where: { $0.id == id }) else { return }
        var updated = projects
        let project = updated.remove(at: source)
        let destination = target.flatMap { id in updated.firstIndex { $0.id == id } } ?? updated.endIndex
        updated.insert(project, at: destination)
        projects = updated
    }

    func removeProject(id: String) {
        projects.removeAll { $0.id == id }
    }

    /// 设置项目默认 CLI
    func setProjectCLI(id: String, cli: String) {
        guard let idx = projects.firstIndex(where: { $0.id == id }) else { return }
        projects[idx].cli = cli
    }

    /// 打开项目：用项目默认 CLI 在项目路径启动新标签
    func openProject(_ project: Project) {
        let cli = cliEntries.first(where: { $0.name == project.cli })
            ?? customCLIEntries.first(where: { $0.name == project.cli })
            ?? cliEntries.first(where: { $0.name == "claude" })
            ?? cliEntries.first
        guard let cli else { return }
        openCLI(cli, workingDirectory: project.path)
    }

    // MARK: - 标签栏拖拽排序（转发到 tabStore）

    /// 标签/网页统一顺序（TabBarView 用）
    var orderedTabs: [TabStore.TabItem] { tabStore.orderedTabs }

    /// 拖拽换位：before = 插到目标标签前，nil = 排尾
    func moveTab(_ id: UUID, before targetID: UUID?) {
        tabStore.moveTab(id, before: targetID)
    }

    @Published var overrides: SidebarOverrides = SidebarOverrides.load() {
        didSet {
            overrides.save()
            if oldValue.hidden != overrides.hidden || oldValue.moves != overrides.moves
                || oldValue.customPWAGroups != overrides.customPWAGroups || pwaInventory == nil {
                pwaSections = buildPWASections()
            } else if oldValue.orders != overrides.orders {
                pwaSections = pwaSections.map { PWASection(title: $0.title, items: applyOrder($0.items, section: $0.title) { $0.name }) }
            }
        }
    }

    func displayName(_ raw: String) -> String { overrides.renames[raw] ?? raw }
    func isHidden(_ raw: String) -> Bool { overrides.hidden.contains(raw) }
    /// 品牌色：用户自定义优先，其次内置品牌色表
    func brandColorResolved(_ raw: String) -> Color {
        if let hex = overrides.colorOverrides[raw], let v = UInt32(hex, radix: 16) {
            return Color(hex: v)
        }
        return HubTheme.brandColor(for: raw)
    }
    static let colorPalette: [(String, UInt32)] = [
        ("红", 0xE5484D), ("橙", 0xF76B15), ("黄", 0xFFD21E), ("草绿", 0x46A758),
        ("绿", 0x22A55E), ("青", 0x00A2C7), ("蓝", 0x0E9FBA), ("深蓝", 0x3E63DD),
        ("紫", 0x8E4EC6), ("品红", 0xD6409F), ("粉", 0xFF6B9D), ("棕", 0xA18072),
        ("灰", 0x6E6E6E), ("黑", 0x0D0D0D),
    ]

    /// 右键颜色子菜单选项（标注当前色）
    func colorOptions(_ raw: String) -> [SidebarColorOption] {
        let current = overrides.colorOverrides[raw]
        return Self.colorPalette.map { label, hex in
            SidebarColorOption(label: label, hex: hex,
                                   isCurrent: current == String(format: "%06X", hex))
        }
    }

    func setColor(_ raw: String, hex: String?) {
        var o = overrides
        if let hex { o.colorOverrides[raw] = hex } else { o.colorOverrides.removeValue(forKey: raw) }
        overrides = o
    }

    /// 改名
    func rename(_ raw: String) {
        guard let newName = Prompt.text(title: "重命名", message: raw, initial: displayName(raw)) else { return }
        overrides.renames[raw] = newName
    }
    /// 隐藏（软删除）
    func hide(_ raw: String) {
        overrides.hidden.append(raw)
    }
    /// 恢复全部隐藏项
    func unhideAll() {
        overrides.hidden.removeAll()
    }
    /// 恢复单个隐藏项
    func unhide(_ raw: String) {
        overrides.hidden.removeAll { $0 == raw }
    }
    /// 添加自定义 CLI / App
    func addCustom() {
        guard let (name, path, isCLI) = Prompt.entryForm() else { return }
        let entry = CustomEntry(name: name, path: path)
        if isCLI {
            overrides.customCLI.append(entry)
        } else {
            overrides.customApps.append(entry)
        }
    }

    /// Finder 拖入 .app：Chrome PWA → 取消隐藏并归入拖到的分组；普通 App → Apps 自定义条目
    func acceptDroppedApp(path: String, toSection section: String?) {
        guard path.hasSuffix(".app") else { return }
        let key = String((path as NSString).lastPathComponent.dropLast(4))
        let pwaDir = NSHomeDirectory() + "/Applications/Chrome Apps.localized/"
        var o = overrides
        if path.hasPrefix(pwaDir) {
            pwaInventory = nil
            // PWA 已在扫描范围内：取消隐藏；拖到 PWA 分组才改归组
            o.hidden.removeAll { $0 == key }
            if let section, pwaSections.contains(where: { $0.title == section }) {
                o.moves[key] = section
            }
        } else {
            let known = appEntries.contains { $0.name == key } || o.customApps.contains { $0.name == key }
            if known {
                o.hidden.removeAll { $0 == key }
            } else {
                var display = key
                if let dict = NSDictionary(contentsOfFile: path + "/Contents/Info.plist") {
                    let n = (dict["CFBundleDisplayName"] as? String) ?? (dict["CFBundleName"] as? String)
                    if let n, !n.isEmpty { display = n }
                }
                o.customApps.append(CustomEntry(name: display, path: path))
            }
        }
        overrides = o
    }
    /// 移动到 PWA 分组（重算 pwaSections）
    /// 移动到 PWA 分组；before = 组内插入锚点（原名），nil = 排到组尾
    func movePWA(_ raw: String, to group: String, before beforeName: String? = nil) {
        guard raw != beforeName else { return }
        var sections = pwaSections
        var entry: AppEntry?
        var sourceTitle: String?
        for i in sections.indices {
            if let j = sections[i].items.firstIndex(where: { $0.name == raw }) {
                entry = sections[i].items.remove(at: j)
                sourceTitle = sections[i].title
            }
        }
        guard let entry, let t = sections.firstIndex(where: { $0.title == group }) else { return }
        if let beforeName, let anchor = sections[t].items.firstIndex(where: { $0.name == beforeName }) {
            sections[t].items.insert(entry, at: anchor)
        } else {
            sections[t].items.append(entry)
        }
        var o = overrides
        o.moves[raw] = group
        for sec in Set([group, sourceTitle].compactMap { $0 }) {
            if let s = sections.first(where: { $0.title == sec }) {
                o.orders[sec] = s.items.map { $0.name }
            }
        }
        overrides = o   // 一次性触发 didSet：save + rebuild
    }
    /// 删除自定义条目
    func removeCustom(_ name: String, path: String, isCLI: Bool) {
        if isCLI {
            overrides.customCLI.removeAll { $0.name == name && $0.path == path }
        } else {
            overrides.customApps.removeAll { $0.name == name && $0.path == path }
        }
    }
    /// 重置全部自定义
    func resetOverrides() {
        overrides = SidebarOverrides()
    }
    var customCLIEntries: [CLIEntry] {
        overrides.customCLI.filter { !isHidden($0.name) }.map { CLIEntry(name: $0.name, command: ToolCatalog.expand($0.path), title: $0.name) }
    }
    var customAppEntries: [AppEntry] {
        overrides.customApps.filter { !isHidden($0.name) }.map { AppEntry(name: $0.name, appPath: ToolCatalog.expand($0.path)) }
    }

    /// 应用持久化顺序（缺失名保持原相对顺序排尾）
    private func applyOrder<T>(_ items: [T], section: String, name: (T) -> String) -> [T] {
        guard let ord = overrides.orders[section], !ord.isEmpty else { return items }
        let rank = Dictionary(ord.enumerated().map { ($0.element, $0.offset) }, uniquingKeysWith: { first, _ in first })
        return items.enumerated().sorted {
            let r0 = rank[name($0.element)] ?? Int.max
            let r1 = rank[name($1.element)] ?? Int.max
            return r0 == r1 ? $0.offset < $1.offset : r0 < r1
        }.map { $0.element }
    }

    var visibleCLIEntries: [CLIEntry] {
        let candidates = (customCLIEntries + cliEntries.filter { !isHidden($0.name) })
            .filter { ToolCatalog.isAvailableCommand($0.command) }
        let entries = ToolCatalog.deduplicated(candidates, path: { $0.command })
        return applyOrder(entries, section: "CLI 工具") { $0.name }
    }
    var visibleAppEntries: [AppEntry] {
        let candidates = (customAppEntries + appEntries.filter { !isHidden($0.name) })
            .filter { ToolCatalog.isAvailableApp($0.appPath) }
        let entries = ToolCatalog.deduplicated(candidates, path: { $0.appPath })
        return applyOrder(entries, section: "Apps") { $0.name }
    }

    struct UnavailableToolEntry: Identifiable {
        let name: String
        let path: String
        let isCLI: Bool
        var id: String { (isCLI ? "cli:" : "app:") + path }
    }

    /// Keep unavailable configuration recoverable without offering dead launch
    /// tiles or rewriting the user's names, grouping, ordering or custom tools.
    var unavailableToolEntries: [UnavailableToolEntry] {
        let cli = (customCLIEntries + cliEntries.filter { !isHidden($0.name) })
            .filter { !ToolCatalog.isAvailableCommand($0.command) }
            .map { UnavailableToolEntry(name: $0.name, path: $0.command, isCLI: true) }
        let apps = (customAppEntries + appEntries.filter { !isHidden($0.name) })
            .filter { !ToolCatalog.isAvailableApp($0.appPath) }
            .map { UnavailableToolEntry(name: $0.name, path: $0.appPath, isCLI: false) }
        return ToolCatalog.deduplicated(cli + apps, path: { $0.path })
    }

    // MARK: - 大分区排序/改名

    enum SectionKind {
        case cli          // "CLI 工具"
        case projects     // "项目"
        case apps         // "Apps"
        case pwa(String)  // PWA 分组（标题）
    }

    struct SectionRef: Identifiable {
        let kind: SectionKind
        var id: String {
            switch kind {
            case .cli: return "CLI 工具"
            case .projects: return "项目"
            case .apps: return "Apps"
            case .pwa(let t): return t
            }
        }
        var rawTitle: String { id }
    }

    /// 大分区显示名
    func sectionDisplayName(_ raw: String) -> String { overrides.sectionRenames[raw] ?? raw }

    /// 全部分区（含 PWA 分组），按用户 sectionOrder 排列；未记录的按默认顺序补尾
    var visibleSections: [SectionRef] {
        let defaults: [SectionRef] = [.init(kind: .cli), .init(kind: .projects), .init(kind: .apps)]
            + pwaSections.map { .init(kind: .pwa($0.title)) }
        let order = overrides.sectionOrder
        guard !order.isEmpty else { return defaults }
        var pool = defaults
        var result: [SectionRef] = []
        for raw in order {
            if let idx = pool.firstIndex(where: { $0.rawTitle == raw }) {
                result.append(pool.remove(at: idx))
            }
        }
        result.append(contentsOf: pool)   // 新出现的分区补尾
        return result
    }

    /// 移动大分区（before = 目标分区原名，nil = 排尾）
    func moveSection(_ raw: String, before target: String?) {
        guard raw != target else { return }
        var names = visibleSections.map { $0.rawTitle }
        guard let from = names.firstIndex(of: raw) else { return }
        names.remove(at: from)
        if let target, let anchor = names.firstIndex(of: target) {
            names.insert(raw, at: anchor)
        } else {
            names.append(raw)
        }
        var o = overrides
        o.sectionOrder = names
        overrides = o
    }

    /// 大分区改名（内置分区只改显示名；PWA 分组同时迁移 orders/moves/customPWAGroups）
    func renameSection(old: String, new: String) {
        let trimmed = new.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, old != trimmed else { return }
        var o = overrides
        if case .pwa = visibleSections.first(where: { $0.rawTitle == old })?.kind, o.customPWAGroups.contains(old) {
            // 自定义 PWA 分组：真改名（数据迁移）
            if let idx = o.customPWAGroups.firstIndex(of: old) { o.customPWAGroups[idx] = trimmed }
            if let ord = o.orders.removeValue(forKey: old) { o.orders[trimmed] = ord }
            for (raw, g) in o.moves where g == old { o.moves[raw] = trimmed }
            o.sectionOrder = o.sectionOrder.map { $0 == old ? trimmed : $0 }
        } else {
            // 内置分区或内置 PWA 分组：仅显示名映射
            guard o.sectionRenames[old] == nil || o.sectionRenames[old] != trimmed else { return }
            let allTitles = visibleSections.map { $0.rawTitle }
            guard !allTitles.contains(trimmed), !o.sectionRenames.values.contains(trimmed) else { return }
            o.sectionRenames[old] = trimmed
        }
        overrides = o
    }

    /// CLI / Apps 组内重排（before = 插入锚点原名，nil = 排尾）
    func moveSidebarEntry(_ raw: String, in section: String, before beforeName: String?) {
        guard raw != beforeName, ["CLI 工具", "Apps"].contains(section) else { return }
        var names = section == "CLI 工具" ? visibleCLIEntries.map { $0.name } : visibleAppEntries.map { $0.name }
        guard let from = names.firstIndex(of: raw) else { return }
        names.remove(at: from)
        if let beforeName, let anchor = names.firstIndex(of: beforeName) {
            names.insert(raw, at: anchor)
        } else {
            names.append(raw)
        }
        var o = overrides
        o.orders[section] = names
        overrides = o
    }

    // MARK: - 标签域转发（视图已观察 tabStore，这里仅供非视图代码如 AppDelegate 使用）

    typealias TabItem = TabStore.TabItem
    typealias SplitDirection = TabStore.SplitDirection

    var tabs: [TerminalTab] { tabStore.tabs }
    var selectedTabID: TerminalTab.ID? { tabStore.selectedTabID }
    var exitedPaneIDs: Set<TerminalPane.ID> { tabStore.exitedPaneIDs }
    var unseenBellTabIDs: Set<TerminalTab.ID> { tabStore.unseenBellTabIDs }
    var tabStatuses: [TerminalTab.ID: TabStatus] { tabStore.tabStatuses }
    var webTabs: [WebTab] { tabStore.webTabs }
    var selectedWebTabID: WebTab.ID? { tabStore.selectedWebTabID }
    var nativeTabs: [NativeAppTab] { tabStore.nativeTabs }
    var selectedNativeTabID: NativeAppTab.ID? { tabStore.selectedNativeTabID }

    /// PWA 内嵌打开；本机服务未起时先拉起来再开标签
    func openPWA(_ entry: AppEntry) {
        tabStore.openPWA(entry)
    }

    func closeWebTab(id: WebTab.ID) {
        tabStore.closeWebTab(id: id)
    }

    func focusTab(id: TerminalTab.ID) {
        tabStore.focusTab(id: id)
    }

    /// Internal presentation is a manual user session, separate from sandboxed tasks.
    func openIntegration(_ route: AppIntegrations.WorkspaceRoute) {
        guard !Self.isPreview else { return }
        launcherError = nil
        switch route {
        case let .web(title, url): tabStore.openWeb(title: title, url: url)
        case let .terminal(title): openCLI(CLIEntry(name: "Ghostty", command: "/bin/zsh", title: title))
        }
    }

    func openPreferredApp(_ entry: AppEntry) {
        openNativeAppInHub(entry)
    }

    /// Open the real desktop window in the Hub's native mirror tab.
    func openNativeAppInHub(_ entry: AppEntry) {
        guard !Self.isPreview else { return }
        guard FileManager.default.fileExists(atPath: entry.appPath) else {
            launcherError = "\(displayName(entry.name)) 的应用入口不存在：\(entry.appPath)"
            return
        }
        launcherError = nil
        tabStore.openNativeApp(entry)
    }

    func openApp(_ entry: AppEntry) {
        guard !Self.isPreview else { return }
        let url = URL(fileURLWithPath: entry.appPath)
        guard FileManager.default.fileExists(atPath: entry.appPath) else {
            launcherError = "\(displayName(entry.name)) 的应用入口不存在：\(entry.appPath)"
            return
        }
        launcherError = nil
        NSWorkspace.shared.openApplication(at: url, configuration: .init()) { [weak self] _, error in
            if let error {
                Task { @MainActor in self?.launcherError = "无法打开 \(entry.name)：\(error.localizedDescription)" }
            }
        }
    }

    /// 退出正在运行的 App（侧栏右键）
    func quitApp(path: String) {
        guard !Self.isPreview else { return }
        if let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleURL?.path == path }) {
            app.terminate()
        }
    }


    // MARK: - App 运行状态监看

    private func setupAppMonitoring() {
        NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.refreshToolInventory() }
        }
        let ws = NSWorkspace.shared
        runningApps = Set(ws.runningApplications.compactMap { $0.bundleURL?.path })
        ws.notificationCenter.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] note in
            let path = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.bundleURL?.path
            Task { @MainActor in if let path { self?.runningApps.insert(path) } }
        }
        ws.notificationCenter.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            let path = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.bundleURL?.path
            Task { @MainActor in if let path { self?.runningApps.remove(path) } }
        }
    }

    // MARK: - 系统通知（bell → 审批提醒，点击跳回标签）

    private func setupNotificationCenter() {
        UNUserNotificationCenter.current().delegate = HubNotificationDelegate.shared
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    /// 标签域操作转发（hook 事件已在 init 里接入 tabStore）
}

/// 独立通知 delegate：点击通知跳回对应标签
final class HubNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    @MainActor static let shared = HubNotificationDelegate()

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        if let s = response.notification.request.content.userInfo["tabID"] as? String,
           let id = UUID(uuidString: s) {
            Task { @MainActor in
                AppDelegate.model?.focusTab(id: id)
            }
        }
        completionHandler()
    }
}
