import GhosttyTerminal
import SwiftUI
import UniformTypeIdentifiers

private struct SidebarMenuItem {
    let title: String
    let handler: () -> Void
}

struct SidebarColorOption: Identifiable {
    let label: String
    let hex: UInt32
    let isCurrent: Bool
    var id: String { label }
}

struct SidebarCLIOption: Identifiable {
    let label: String
    let name: String
    let isCurrent: Bool
    var id: String { name }
}

private struct DropLocation: Equatable {
    let section: String
    let before: String?   // nil = 组尾
}

private enum SidebarDrag {
    static let section = UTType(exportedAs: "com.example.aihub.sidebar-section")
    static func rowType(_ section: String) -> UTType {
        let kind = ["CLI 工具": "cli", "Apps": "app", "项目": "project"][section] ?? "pwa"
        return UTType(exportedAs: "com.example.aihub.sidebar-" + kind)
    }
    static func load(_ provider: NSItemProvider, type: UTType, perform: @escaping (String) -> Void) {
        provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in
            guard let data, let value = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { perform(value) }
        }
    }
    static func loadApps(_ providers: [NSItemProvider], perform: @escaping ([URL]) -> Void) {
        // Deliver each result on the main queue; provider callbacks may run concurrently.
        for provider in providers {
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                guard let url, url.pathExtension == "app" else { return }
                DispatchQueue.main.async { perform([url]) }
            }
        }
    }
}

private struct SidebarDropDelegate: DropDelegate {
    let section: String
    let beforeName: String?
    @Binding var dropTarget: DropLocation?
    let perform: (String) -> Void
    var fileHandler: (([URL]) -> Void)? = nil

    private var location: DropLocation { DropLocation(section: section, before: beforeName) }
    private var type: UTType { SidebarDrag.rowType(section) }
    func validateDrop(info: DropInfo) -> Bool {
        return info.hasItemsConforming(to: [type]) || (fileHandler != nil && info.hasItemsConforming(to: [.fileURL]))
    }
    func dropEntered(info: DropInfo) { dropTarget = location }
    func dropExited(info: DropInfo) {
        if dropTarget == location { dropTarget = nil }
    }
    func dropUpdated(info: DropInfo) -> DropProposal? {
        DropProposal(operation: info.hasItemsConforming(to: [.fileURL]) ? .copy : .move)
    }
    func performDrop(info: DropInfo) -> Bool {
        dropTarget = nil
        if let provider = info.itemProviders(for: [type]).first {
            SidebarDrag.load(provider, type: type, perform: perform)
            return true
        }
        if let fileHandler, info.hasItemsConforming(to: [.fileURL]) {
            SidebarDrag.loadApps(info.itemProviders(for: [.fileURL]), perform: fileHandler)
            return true
        }
        return false
    }
}

// MARK: - Sidebar

struct SidebarView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openWindow) private var openWindow
    var onCollapse: (() -> Void)? = nil
    @State private var dropTarget: DropLocation? = nil  // 当前悬停落点

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Button {
                        onCollapse?()
                    } label: {
                        Image(systemName: "sidebar.left")
                            .font(.system(size: 12))
                            .foregroundStyle(HubTheme.textTertiary)
                    }
                    .buttonStyle(.plain)
                    .help("收起侧栏")
                    VStack(alignment: .leading, spacing: 2) {
                        Text("AI Hub")
                            .font(.system(size: 17, weight: .semibold, design: .rounded))
                            .foregroundStyle(HubTheme.text)
                        Text("你的个人 AI 工作台")
                            .font(.system(size: 10))
                            .foregroundStyle(HubTheme.textSecondary)
                    }
                    Spacer()
                    Button {
                        openWindow(id: "history")
                    } label: {
                        Image(systemName: "clock.arrow.circlepath")
                            .font(.system(size: 13))
                            .foregroundStyle(HubTheme.textTertiary)
                    }
                    .buttonStyle(.plain)
                    .help("历史会话")
                    Menu {
                        Button("添加工具…") { model.addCustom() }
                        Button("重新扫描工具目录") { model.refreshToolInventory() }
                        Button("添加 PWA 分组…") {
                            if let title = Prompt.text(title: "新建分组", message: "输入新分组名称", initial: "") {
                                model.addPWAGroup(title: title)
                            }
                        }
                        Divider()
                        if !model.overrides.hidden.isEmpty {
                            Menu("恢复隐藏项") {
                                ForEach(model.overrides.hidden, id: \.self) { name in
                                    Button(model.displayName(name)) { model.unhide(name) }
                                }
                                Divider()
                                Button("全部恢复") { model.unhideAll() }
                            }
                        }
                        Button("重置全部自定义") { model.resetOverrides() }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.system(size: 14))
                            .foregroundStyle(HubTheme.textTertiary)
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .frame(width: 24, height: 24)
                }
                .padding(.horizontal, 12)
                .padding(.top, 14)
                .padding(.bottom, 8)

                Button {
                    model.tabStore.showingOverview = true
                } label: {
                    HStack(spacing: 9) {
                        Image(systemName: "cloud.sun")
                            .font(.system(size: 15, weight: .light))
                        Text("云间工作台").font(.system(size: 12, weight: .medium))
                        Spacer()
                        Image(systemName: "arrow.up.right").font(.system(size: 10))
                    }
                    .foregroundStyle(HubTheme.accent)
                    .padding(.horizontal, 12).padding(.vertical, 11)
                    .background(HubTheme.surface, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(HubTheme.border, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 10).padding(.top, 8).padding(.bottom, 14)
                ForEach(model.visibleSections) { sec in
                    sidebarSection(sec)
                }
            }
            .padding(.bottom, 16)
        }
        .background(HubTheme.sidebarBackground)
    }

    private func nextID(after id: String, in ids: [String]) -> String? {
        guard let index = ids.firstIndex(of: id), index + 1 < ids.count else { return nil }
        return ids[index + 1]
    }

    private func reorderMenu(_ id: String, in ids: [String], move: @escaping (String?) -> Void) -> [SidebarMenuItem] {
        guard let index = ids.firstIndex(of: id) else { return [] }
        var items: [SidebarMenuItem] = []
        if index > 0 {
            items.append(SidebarMenuItem(title: "上移") { move(ids[index - 1]) })
            items.append(SidebarMenuItem(title: "移到最前") { move(ids.first) })
        }
        if index + 1 < ids.count {
            items.append(SidebarMenuItem(title: "下移") { move(index + 2 < ids.count ? ids[index + 2] : nil) })
            items.append(SidebarMenuItem(title: "移到最后") { move(nil) })
        }
        return items
    }

    private func sectionMenu(_ sec: AppModel.SectionRef) -> [SidebarMenuItem] {
        let rawTitle = sec.rawTitle
        var menu: [SidebarMenuItem] = [
            SidebarMenuItem(title: "重命名分区") {
                if let new = Prompt.text(title: "重命名分区", message: rawTitle, initial: model.sectionDisplayName(rawTitle)) {
                    model.renameSection(old: rawTitle, new: new)
                }
            },
        ]
        if case .pwa(let t) = sec.kind, model.overrides.customPWAGroups.contains(t) {
            menu.append(SidebarMenuItem(title: "删除分组") {
                model.deletePWAGroup(title: t)
            })
        }
        return reorderMenu(rawTitle, in: model.visibleSections.map(\.rawTitle)) {
            model.moveSection(rawTitle, before: $0)
        } + menu
    }

    private func sectionCollapsedBinding(_ sec: AppModel.SectionRef) -> Binding<Bool> {
        switch sec.kind {
        case .cli: return $model.cliCollapsed
        case .projects: return $model.projectsCollapsed
        case .apps: return $model.appsCollapsed
        case .pwa(let t): return pwaCollapseBinding(t)
        }
    }

    @ViewBuilder
    private func sidebarSection(_ sec: AppModel.SectionRef) -> some View {
        let rawTitle = sec.rawTitle
        CollapsibleSection(
            title: model.sectionDisplayName(rawTitle),
            isCollapsed: sectionCollapsedBinding(sec),
            dropHandler: { dragged in
                switch sec.kind {
                case .cli, .apps: model.moveSidebarEntry(dragged, in: rawTitle, before: nil)
                case .projects: model.moveProject(dragged, before: nil)
                case .pwa(let t): model.movePWA(dragged, to: t, before: nil)
                }
            },
            fileDropHandler: { urls in
                for url in urls {
                    let target: String? = (rawTitle == "CLI 工具" || rawTitle == "Apps") ? nil : rawTitle
                    model.acceptDroppedApp(path: url.path, toSection: target)
                }
            },
            sectionDragPayload: rawTitle,
            sectionDropHandler: { model.moveSection($0, before: rawTitle) },
            sectionAfterDropHandler: { model.moveSection($0, before: nextID(after: rawTitle, in: model.visibleSections.map(\.rawTitle))) },
            contextMenuItems: sectionMenu(sec)
        ) {
            switch sec.kind {
            case .cli: cliRows
            case .projects: projectsRows
            case .apps: appsRows
            case .pwa(let t):
                if let section = model.pwaSections.first(where: { $0.title == t }) {
                    pwaRows(section)
                }
            }
        }
    }

    @ViewBuilder
    private var cliRows: some View {
        ForEach(model.visibleCLIEntries) { entry in
            let isCustom = model.overrides.customCLI.contains { $0.name == entry.name }
            VStack(spacing: 0) {
                SidebarRow(
                    name: model.displayName(entry.name),
                    subtitle: entry.name,
                    color: model.brandColorResolved(entry.name),
                    iconSource: .cli(entry.name),
                    folderAction: { pickFolderAndOpen(cli: entry) },
                    contextMenuItems: isCustom
                        ? [
                            SidebarMenuItem(title: "重命名") { model.rename(entry.name) },
                            SidebarMenuItem(title: "删除") { model.removeCustom(entry.name, path: entry.command, isCLI: true) },
                        ]
                        : [
                            SidebarMenuItem(title: "重命名") { model.rename(entry.name) },
                            SidebarMenuItem(title: "从侧栏隐藏") { model.hide(entry.name) },
                        ],
                    colorMenu: model.colorOptions(entry.name),
                    colorMenuHandler: { hex in
                        model.setColor(entry.name, hex: hex.map { String(format: "%06X", $0) })
                    },
                    orderMenu: reorderMenu(entry.name, in: model.visibleCLIEntries.map(\.name)) {
                        model.moveSidebarEntry(entry.name, in: "CLI 工具", before: $0)
                    },
                    dragSection: "CLI 工具",
                    draggablePayload: entry.name,
                    moveBefore: { model.moveSidebarEntry($0, in: "CLI 工具", before: entry.name) },
                    moveAfter: { model.moveSidebarEntry($0, in: "CLI 工具", before: nextID(after: entry.name, in: model.visibleCLIEntries.map(\.name))) }
                ) {
                    model.openCLI(entry)
                }
                .overlay(alignment: .top) {
                    if dropTarget == DropLocation(section: "CLI 工具", before: entry.name) { dropLine }
                }
                .onDrop(of: [SidebarDrag.rowType("CLI 工具"), .fileURL], delegate: SidebarDropDelegate(
                    section: "CLI 工具",
                    beforeName: entry.name,
                    dropTarget: $dropTarget,
                    perform: { model.moveSidebarEntry($0, in: "CLI 工具", before: entry.name) }
                ))
            }
        }
        Color.clear
            .frame(height: 10)
            .contentShape(Rectangle())
            .onDrop(of: [SidebarDrag.rowType("CLI 工具"), .fileURL], delegate: SidebarDropDelegate(
                section: "CLI 工具",
                beforeName: nil,
                dropTarget: $dropTarget,
                perform: { model.moveSidebarEntry($0, in: "CLI 工具", before: nil) }
            ))
        if dropTarget == DropLocation(section: "CLI 工具", before: nil) {
            dropLine
        }
    }

    @ViewBuilder
    private var projectsRows: some View {
        if model.projects.isEmpty {
            Button {
                pickFolderAndAddProject()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "plus.circle")
                        .font(.system(size: 12))
                        .foregroundStyle(HubTheme.textTertiary)
                    Text("添加项目")
                        .font(.system(size: 12))
                        .foregroundStyle(HubTheme.textTertiary)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }
            .buttonStyle(.plain)
        } else {
            ForEach(model.projects) { project in
                SidebarRow(
                    name: project.name,
                    subtitle: (project.path as NSString).lastPathComponent,
                    color: model.brandColorResolved(project.cli),
                    iconSource: .path(project.path),
                    contextMenuItems: [
                        SidebarMenuItem(title: "在 Finder 中显示") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: project.path)]) },
                        SidebarMenuItem(title: "从侧栏移除") { model.removeProject(id: project.id) },
                    ],
                    cliMenu: model.cliEntries.map { SidebarCLIOption(label: $0.title, name: $0.name, isCurrent: $0.name == project.cli) },
                    cliMenuHandler: { cliName in model.setProjectCLI(id: project.id, cli: cliName) },
                    orderMenu: reorderMenu(project.id, in: model.projects.map(\.id)) {
                        model.moveProject(project.id, before: $0)
                    },
                    dragSection: "项目",
                    draggablePayload: project.id,
                    moveBefore: { model.moveProject($0, before: project.id) },
                    moveAfter: { model.moveProject($0, before: nextID(after: project.id, in: model.projects.map(\.id))) }
                ) {
                    model.openProject(project)
                }
                .overlay(alignment: .top) {
                    if dropTarget == DropLocation(section: "项目", before: project.id) { dropLine }
                }
                .onDrop(of: [SidebarDrag.rowType("项目")], delegate: SidebarDropDelegate(
                    section: "项目", beforeName: project.id,
                    dropTarget: $dropTarget,
                    perform: { model.moveProject($0, before: project.id) }
                ))
            }
            Color.clear.frame(height: 10).contentShape(Rectangle())
                .overlay { if dropTarget == DropLocation(section: "项目", before: nil) { dropLine } }
                .onDrop(of: [SidebarDrag.rowType("项目")], delegate: SidebarDropDelegate(
                    section: "项目", beforeName: nil,
                    dropTarget: $dropTarget,
                    perform: { model.moveProject($0, before: nil) }
                ))
            Button {
                pickFolderAndAddProject()
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "plus")
                        .font(.system(size: 10))
                        .foregroundStyle(HubTheme.textTertiary)
                    Text("添加项目")
                        .font(.system(size: 11))
                        .foregroundStyle(HubTheme.textTertiary)
                }
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
        }
    }

    private func pickFolderAndAddProject() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.message = "选择项目文件夹"
        if panel.runModal() == .OK, let url = panel.url {
            let name = (url.path as NSString).lastPathComponent
            model.addProject(name: name, path: url.path)
        }
    }

    @ViewBuilder
    private var appsRows: some View {
        ForEach(model.visibleAppEntries) { entry in
            let isCustom = model.overrides.customApps.contains { $0.name == entry.name }
            VStack(spacing: 0) {
                SidebarRow(
                    name: model.displayName(entry.name),
                    subtitle: nil,
                    color: model.brandColorResolved(entry.name),
                    iconSource: .path(entry.appPath),
                    isRunning: model.runningApps.contains(entry.appPath),
                    contextMenuItems: [SidebarMenuItem(title: "在外部打开") { model.openApp(entry) }] + (isCustom
                        ? [
                            SidebarMenuItem(title: "重命名") { model.rename(entry.name) },
                            SidebarMenuItem(title: "删除") { model.removeCustom(entry.name, path: entry.appPath, isCLI: false) },
                        ]
                        : [
                            SidebarMenuItem(title: "重命名") { model.rename(entry.name) },
                            SidebarMenuItem(title: "从侧栏隐藏") { model.hide(entry.name) },
                        ]
                        + (model.runningApps.contains(entry.appPath)
                            ? [SidebarMenuItem(title: "退出") { model.quitApp(path: entry.appPath) }]
                            : [])),
                    colorMenu: model.colorOptions(entry.name),
                    colorMenuHandler: { hex in
                        model.setColor(entry.name, hex: hex.map { String(format: "%06X", $0) })
                    },
                    orderMenu: reorderMenu(entry.name, in: model.visibleAppEntries.map(\.name)) {
                        model.moveSidebarEntry(entry.name, in: "Apps", before: $0)
                    },
                    dragSection: "Apps",
                    draggablePayload: entry.name,
                    moveBefore: { model.moveSidebarEntry($0, in: "Apps", before: entry.name) },
                    moveAfter: { model.moveSidebarEntry($0, in: "Apps", before: nextID(after: entry.name, in: model.visibleAppEntries.map(\.name))) }
                ) {
                    model.openPreferredApp(entry)
                }
                .overlay(alignment: .top) {
                    if dropTarget == DropLocation(section: "Apps", before: entry.name) { dropLine }
                }
                .onDrop(of: [SidebarDrag.rowType("Apps"), .fileURL], delegate: SidebarDropDelegate(
                    section: "Apps",
                    beforeName: entry.name,
                    dropTarget: $dropTarget,
                    perform: { model.moveSidebarEntry($0, in: "Apps", before: entry.name) },
                    fileHandler: { urls in
                        for url in urls { model.acceptDroppedApp(path: url.path, toSection: nil) }
                    }
                ))
            }
        }
        Color.clear
            .frame(height: 10)
            .contentShape(Rectangle())
            .onDrop(of: [SidebarDrag.rowType("Apps"), .fileURL], delegate: SidebarDropDelegate(
                section: "Apps",
                beforeName: nil,
                dropTarget: $dropTarget,
                perform: { model.moveSidebarEntry($0, in: "Apps", before: nil) },
                fileHandler: { urls in
                    for url in urls { model.acceptDroppedApp(path: url.path, toSection: nil) }
                }
            ))
        if dropTarget == DropLocation(section: "Apps", before: nil) {
            dropLine
        }
    }

    @ViewBuilder
    private func pwaRows(_ section: AppModel.PWASection) -> some View {
        ForEach(section.items) { entry in
            VStack(spacing: 0) {
                SidebarRow(
                    name: model.displayName(entry.name),
                    subtitle: nil,
                    color: model.brandColorResolved(entry.name),
                    iconSource: .path(entry.appPath),
                    isRunning: model.runningApps.contains(entry.appPath),
                    contextMenuItems: [
                        SidebarMenuItem(title: "重命名") { model.rename(entry.name) },
                        SidebarMenuItem(title: "从侧栏隐藏") { model.hide(entry.name) },
                        SidebarMenuItem(title: "在外部打开") { model.openApp(entry) },
                    ]
                    + (model.runningApps.contains(entry.appPath)
                        ? [SidebarMenuItem(title: "退出") { model.quitApp(path: entry.appPath) }]
                        : []),
                    colorMenu: model.colorOptions(entry.name),
                    colorMenuHandler: { hex in
                        model.setColor(entry.name, hex: hex.map { String(format: "%06X", $0) })
                    },
                    orderMenu: reorderMenu(entry.name, in: section.items.map(\.name)) {
                        model.movePWA(entry.name, to: section.title, before: $0)
                    },
                    dragSection: section.title,
                    draggablePayload: entry.name,
                    moveBefore: { model.movePWA($0, to: section.title, before: entry.name) },
                    moveAfter: { model.movePWA($0, to: section.title, before: nextID(after: entry.name, in: section.items.map(\.name))) }
                ) {
                    model.openPWA(entry)
                }
                .overlay(alignment: .top) {
                    if dropTarget == DropLocation(section: section.title, before: entry.name) { dropLine }
                }
                .onDrop(of: [SidebarDrag.rowType(section.title), .fileURL], delegate: SidebarDropDelegate(
                    section: section.title,
                    beforeName: entry.name,
                    dropTarget: $dropTarget,
                    perform: { model.movePWA($0, to: section.title, before: entry.name) }
                ))
            }
        }
        Color.clear
            .frame(height: 10)
            .contentShape(Rectangle())
            .onDrop(of: [SidebarDrag.rowType(section.title), .fileURL], delegate: SidebarDropDelegate(
                section: section.title,
                beforeName: nil,
                dropTarget: $dropTarget,
                perform: { model.movePWA($0, to: section.title, before: nil) }
            ))
        if dropTarget == DropLocation(section: section.title, before: nil) {
            dropLine
        }
    }

    private func pwaCollapseBinding(_ title: String) -> Binding<Bool> {
        Binding(
            get: { model.collapsedPWAGroups.contains(title) },
            set: { collapsed in
                if collapsed { model.collapsedPWAGroups.insert(title) }
                else { model.collapsedPWAGroups.remove(title) }
                UserDefaults.standard.set(collapsed, forKey: "section.pwa.\(title).collapsed")
            }
        )
    }

    /// 插入位置指示线
    private var dropLine: some View {
        RoundedRectangle(cornerRadius: 1)
            .fill(HubTheme.accent)
            .frame(height: 2)
            .padding(.horizontal, 14)
    }

    private func pickFolderAndOpen(cli: CLIEntry) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.message = "选择 \(cli.title) 的工作目录"
        if panel.runModal() == .OK, let url = panel.url {
            model.openCLI(cli, workingDirectory: url.path)
        }
    }
}

private struct CollapsibleSection<Content: View>: View {
    let title: String
    @Binding var isCollapsed: Bool
    var dropHandler: ((String) -> Void)? = nil
    var fileDropHandler: (([URL]) -> Void)? = nil   // Finder 拖入 .app
    var sectionDragPayload: String? = nil
    var sectionDropHandler: ((String) -> Void)? = nil
    var sectionAfterDropHandler: ((String) -> Void)? = nil
    var contextMenuItems: [SidebarMenuItem] = []
    @ViewBuilder let content: () -> Content
    @State private var hovering = false
    @State private var dropTargeted = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
                Button { isCollapsed.toggle() } label: {
                  HStack(spacing: 4) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(HubTheme.textTertiary)
                        .rotationEffect(.degrees(isCollapsed ? 0 : 90))
                    Text(title)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(HubTheme.textSecondary)
                    Spacer()
                    Text("\(countLabel)")
                        .font(.system(size: 10))
                        .foregroundStyle(HubTheme.textTertiary)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .contentShape(Rectangle())
                }.buttonStyle(.plain)
            }
            .overlay {
                SidebarDragSurface(value: sectionDragPayload ?? title, type: SidebarDrag.section, label: title,
                    dropActions: [SidebarDrag.section.identifier: { sectionDropHandler?($0) }, rowType.identifier: { dropHandler?($0) }],
                    afterDropActions: [SidebarDrag.section.identifier: { sectionAfterDropHandler?($0) }],
                    targeted: { dropTargeted = $0 }) {
                    isCollapsed.toggle()
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { isCollapsed.toggle() }
            .onHover { hovering = $0 }
            .onDrop(of: [SidebarDrag.section, rowType, .fileURL], isTargeted: $dropTargeted, perform: acceptDrop)
            .help("拖动调整分区顺序；将条目拖到此处可排到组尾")
            .contextMenu {
                ForEach(contextMenuItems, id: \.title) { item in
                    Button(item.title) { item.handler() }
                }
            }

            if !isCollapsed {
                VStack(alignment: .leading, spacing: 0) { content() }
            }
        }
        .padding(.top, 8)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(dropTargeted ? HubTheme.accent.opacity(0.06) : .clear)
        )
        .overlay {
            if dropTargeted {
                RoundedRectangle(cornerRadius: 8)
                    .stroke(HubTheme.accent.opacity(0.5), style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
            }
        }
    }

    private var rowType: UTType { SidebarDrag.rowType(sectionDragPayload ?? title) }
    private func acceptDrop(_ providers: [NSItemProvider]) -> Bool {
        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(SidebarDrag.section.identifier) }), let sectionDropHandler {
            SidebarDrag.load(provider, type: SidebarDrag.section, perform: sectionDropHandler)
            return true
        }
        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(rowType.identifier) }), let dropHandler {
            SidebarDrag.load(provider, type: rowType, perform: dropHandler)
            return true
        }
        if let fileDropHandler {
            SidebarDrag.loadApps(providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) }, perform: fileDropHandler)
            return true
        }
        return false
    }

    private var countLabel: String {
        isCollapsed ? "展开" : ""
    }
}

private struct SectionHeader: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(HubTheme.textSecondary)
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 4)
    }
}

private struct SidebarRow: View {
    let name: String
    let subtitle: String?
    let color: Color
    var iconSource: SidebarIconSource? = nil
    var isRunning: Bool = false
    var folderAction: (() -> Void)? = nil
    var externalAction: (() -> Void)? = nil
    var contextMenuItems: [SidebarMenuItem] = []
    var colorMenu: [SidebarColorOption] = []  // 非空时显示「颜色」子菜单
    var colorMenuHandler: ((UInt32?) -> Void)? = nil   // nil hex = 恢复默认
    var cliMenu: [SidebarCLIOption] = []   // 非空时显示「打开方式」子菜单
    var cliMenuHandler: ((String) -> Void)? = nil
    var orderMenu: [SidebarMenuItem] = []
    var dragSection: String = ""
    var draggablePayload: String? = nil
    var moveBefore: (String) -> Void = { _ in }
    var moveAfter: (String) -> Void = { _ in }
    let action: () -> Void
    @State private var hovering = false

    @State private var insertionTargeted = false
    @State private var insertionAfter = false

    var body: some View {
        HStack(spacing: 0) {
            Button(action: action) {
              HStack(spacing: 8) {
                SidebarIcon(name: name, color: color, source: iconSource,
                            isRunning: isRunning, badgeBackground: HubTheme.panel)
                VStack(alignment: .leading, spacing: 1) {
                    Text(name)
                        .font(.system(size: 13))
                        .foregroundStyle(HubTheme.text)
                    if let subtitle {
                        Text(subtitle)
                            .font(.system(size: 10))
                            .foregroundStyle(HubTheme.textSecondary)
                    }
                }
                Spacer()
                if let folderAction, hovering {
                    Button(action: folderAction) {
                        Image(systemName: "folder")
                            .font(.system(size: 11))
                            .foregroundStyle(HubTheme.textTertiary)
                    }
                    .buttonStyle(.plain)
                    .help("选择工作目录启动")
                }
                if let externalAction, hovering {
                    Button(action: externalAction) {
                        Image(systemName: "arrow.up.forward.app")
                            .font(.system(size: 11))
                            .foregroundStyle(HubTheme.textTertiary)
                    }
                    .buttonStyle(.plain)
                    .help("外部窗口打开")
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(hovering ? HubTheme.hover : .clear)
                    .padding(.horizontal, 6)
            )
            .contentShape(Rectangle())
            }.buttonStyle(.plain)
        }
        .overlay {
            SidebarDragSurface(
                value: draggablePayload ?? name, type: SidebarDrag.rowType(dragSection), label: name,
                trailingControlsWidth: hovering ? CGFloat((folderAction == nil ? 0 : 28) + (externalAction == nil ? 0 : 28)) : 0,
                dropActions: [SidebarDrag.rowType(dragSection).identifier: moveBefore],
                afterDropActions: [SidebarDrag.rowType(dragSection).identifier: moveAfter],
                targetedAfter: { insertionAfter = $0 }, targeted: { insertionTargeted = $0 }, activate: action
            )
        }
        .overlay(alignment: insertionAfter ? .bottom : .top) {
            if insertionTargeted { Rectangle().fill(HubTheme.accent).frame(height: 2).allowsHitTesting(false) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { action() }
        .onHover { hovering = $0 }
        .contextMenu {
            ForEach(orderMenu, id: \.title) { item in
                Button(item.title) { item.handler() }
            }
            if !orderMenu.isEmpty { Divider() }
            ForEach(Array(contextMenuItems.enumerated()), id: \.offset) { _, item in
                Button(item.title) { item.handler() }
            }
            if !colorMenu.isEmpty {
                Menu("颜色") {
                    ForEach(colorMenu) { opt in
                        Button {
                            colorMenuHandler?(opt.hex)
                        } label: {
                            if opt.isCurrent {
                                Label(opt.label, systemImage: "checkmark")
                            } else {
                                Text(opt.label)
                            }
                        }
                    }
                    Divider()
                    Button("恢复默认") { colorMenuHandler?(nil) }
                }
            }
            if !cliMenu.isEmpty {
                Menu("打开方式") {
                    ForEach(cliMenu) { opt in
                        Button {
                            cliMenuHandler?(opt.name)
                        } label: {
                            if opt.isCurrent {
                                Label(opt.label, systemImage: "checkmark")
                            } else {
                                Text(opt.label)
                            }
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Tab Bar
