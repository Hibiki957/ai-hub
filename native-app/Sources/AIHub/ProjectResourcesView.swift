import AppKit
import SwiftUI

/// 项目资料、任务摘要与目录的常驻侧栏。安装入口不代表资料库 API 已连接。
struct ProjectResourcesView: View {
    @ObservedObject var store: WorkbenchStore
    @EnvironmentObject private var model: AppModel
    @State private var page = "资源库"
    @State private var catalog: AppIntegrations?
    @State private var installCounts: [String: Int] = [:]
    @State private var settings: WorkbenchProject?
    @State private var showingConnections = false
    @State private var hoveredRow: String?
    private var tasks: [WorkbenchTask] { store.visibleTasks }
    private var finished: Int { tasks.filter { $0.status == .done }.count }
    private var taskReferences: [WorkbenchReference] { store.selectedTask?.references ?? [] }
    private var projectReferences: [WorkbenchReference] {
        let taskReferenceIDs = Set(taskReferences.map(\.id))
        return (store.selectedProject?.setup?.references ?? []).filter { !taskReferenceIDs.contains($0.id) }
    }
    private let boardGroups: [(String, [WorkbenchTaskStatus])] = [
        ("待办", [.draft, .ready]), ("进行中", [.running, .cancelling]),
        ("待确认 / 验收", [.awaitingApproval, .awaitingAcceptance]),
        ("阻塞 / 需处理", [.blocked, .failed, .interrupted, .cancelled]), ("已完成", [.done])
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("当前工作").font(.system(size: 16, weight: .semibold))
                Spacer()
                if let project = store.selectedProject {
                    Button { settings = project } label: {
                        Image(systemName: "slider.horizontal.3").font(.system(size: 13))
                            .foregroundStyle(HubTheme.textSecondary).frame(width: 26, height: 26)
                    }.buttonStyle(.plain).accessibilityLabel("项目设置与目录").help("项目设置与目录")
                }
            }.padding(.horizontal, SidebarStyle.inset).padding(.top, 14)
            pageTabs
            if page == "目录" {
                directoryPage
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        if page == "看板" { boardPage } else { libraryPage }
                    }.padding(.horizontal, SidebarStyle.inset).padding(.top, 2).padding(.bottom, 14)
                }
            }
        }
        .background(HubTheme.panel).onAppear { reloadCatalog() }
        .sheet(item: $settings) { ProjectSettingsView(store: store, project: $0) }
    }

    private var pageTabs: some View {
        HStack(spacing: 0) {
            pageTab("资料", value: "资源库")
            pageTab("待办", value: "看板")
            pageTab("目录", value: "目录")
        }.padding(.horizontal, SidebarStyle.inset)
            .overlay(alignment: .bottom) { Rectangle().fill(HubTheme.border).frame(height: 1) }
    }

    private func pageTab(_ title: String, value: String) -> some View {
        let selected = page == value
        return Button { page = value } label: {
            VStack(spacing: 8) {
                Text(title).font(.system(size: 13, weight: selected ? .medium : .regular))
                    .foregroundStyle(selected ? HubTheme.text : HubTheme.textSecondary).frame(maxWidth: .infinity)
                Rectangle().fill(selected ? HubTheme.accent : Color.clear).frame(height: 2)
            }.padding(.top, 4).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityLabel("右侧栏视图，" + title)
            .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func reloadCatalog() {
        catalog = try? AppIntegrations.loadDefault()
        var counts: [String: Int] = [:]
        for entry in catalog?.integrations ?? [] { counts[entry.id] = entry.metadata().count }
        installCounts = counts
    }

    private func sectionHeader(_ title: String, count: Int? = nil) -> some View {
        HStack(spacing: 6) {
            Text(title).font(.system(size: 11, weight: .medium))
            Spacer(minLength: 0)
            if let count { Text("\(count)").font(.system(size: 11)).monospacedDigit() }
        }.foregroundStyle(HubTheme.textSecondary)
    }

    private var contextSummary: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let project = store.selectedProject {
                Text(project.name).font(.system(size: 13, weight: .medium)).fixedSize(horizontal: false, vertical: true)
                if let task = store.selectedTask {
                    HStack(alignment: .top, spacing: 8) {
                        Text(task.title).font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary).lineLimit(2).help(task.title)
                        Spacer(minLength: 0)
                        HubTheme.StatusChip(text: task.status.label, tint: task.status.tint)
                    }
                }
            } else if let workspace = store.state.workspaces.first(where: { $0.id == store.selectedWorkspaceID }) {
                Text(workspace.name).font(.system(size: 13, weight: .medium))
            } else {
                Text("全部项目").font(.system(size: 13, weight: .medium))
            }
        }
    }

    /// 交付标准：验收条件是自由文本，按行展示；不渲染完成状态，验收结果以产物页记录为准。
    private var acceptanceSection: some View {
        let lines = (store.selectedTask?.acceptance ?? "")
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        return Group {
            if store.selectedTask != nil && !lines.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    sectionHeader("交付标准", count: lines.count)
                    ForEach(lines, id: \.self) { line in
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "circle").font(.system(size: 9))
                                .foregroundStyle(HubTheme.textTertiary).padding(.top, 3)
                            Text(line).font(.system(size: 12)).foregroundStyle(HubTheme.text)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
    }

    // MARK: - 目录

    private var directoryPage: some View {
        Group {
            if let path = store.selectedProject?.setup?.directory, !path.isEmpty {
                FileBrowserView(showsCloseButton: false)
                    .onAppear { model.browserPath = path }
                    .onChange(of: store.selectedProjectID) { _ in model.browserPath = store.selectedProject?.setup?.directory ?? path }
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    Text(store.selectedProject == nil ? "选择项目以浏览目录。" : "尚未关联项目目录。")
                        .font(.system(size: 13)).foregroundStyle(HubTheme.textSecondary)
                    if let project = store.selectedProject {
                        Button("关联项目目录") { settings = project }.font(.system(size: 13)).buttonStyle(.link)
                    }
                }.padding(.horizontal, SidebarStyle.inset).padding(.top, 2)
                Spacer()
            }
        }
    }

    // MARK: - 资料

    private var libraryPage: some View {
        VStack(alignment: .leading, spacing: 20) {
            contextSummary
            acceptanceSection
            if store.selectedTask != nil {
                referenceSection("任务资料", references: taskReferences,
                                 empty: projectReferences.isEmpty ? "尚未关联资料，可从下方资料库添加引用。" : "暂无任务资料。")
                if !projectReferences.isEmpty { referenceSection("项目资料", references: projectReferences, empty: "") }
            } else if store.selectedProject != nil {
                referenceSection("项目资料", references: projectReferences, empty: "尚未关联资料，可从下方资料库添加引用。")
            } else {
                Text("选择左侧项目，查看关联资料。").font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
            }
            if store.selectedProject != nil { projectDirectory }
            connectionList
        }
    }

    private var connectionList: some View {
        DisclosureGroup(isExpanded: $showingConnections) {
            VStack(alignment: .leading, spacing: 4) {
                Text("资料库 API 尚未接通；已安装入口可用于打开应用、关联引用。")
                    .font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true).padding(.bottom, 6)
                ForEach(catalog?.integrations ?? []) { entry in libraryButton(entry) }
                if catalog == nil {
                    Text("应用目录暂不可用。").font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
                }
            }.padding(.top, 10)
        } label: {
            Text("资料库连接").font(.system(size: 12, weight: .medium)).foregroundStyle(HubTheme.textSecondary)
        }
    }

    private func referenceSection(_ title: String, references: [WorkbenchReference], empty: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(title, count: references.isEmpty ? nil : references.count)
            ForEach(references) { reference in
                VStack(alignment: .leading, spacing: 4) {
                    Text(reference.title).font(.system(size: 13, weight: .medium)).fixedSize(horizontal: false, vertical: true)
                    if !reference.source.isEmpty {
                        Text(reference.source).font(.system(size: 11)).foregroundStyle(HubTheme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    WorkbenchReferenceButton(location: reference.location).font(.system(size: 12))
                }
            }
            if references.isEmpty {
                Text(empty).font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var projectDirectory: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionHeader("项目目录")
            if let path = store.selectedProject?.setup?.directory, !path.isEmpty {
                Button { model.browserPath = path; page = "目录" } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "folder").font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
                        Text((path as NSString).lastPathComponent).font(.system(size: 13)).lineLimit(1)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.system(size: 10)).foregroundStyle(HubTheme.textTertiary)
                    }.padding(.horizontal, 6).frame(minHeight: SidebarStyle.rowHeight)
                        .contentShape(RoundedRectangle(cornerRadius: SidebarStyle.radius))
                }.buttonStyle(.plain).foregroundStyle(HubTheme.text)
                    .background(SidebarStyle.RowBackground(hovered: hoveredRow == "directory"))
                    .onHover { hoveredRow = $0 ? "directory" : nil }.help(path)
            } else {
                Button("关联项目目录") { settings = store.selectedProject }.font(.system(size: 13)).buttonStyle(.link)
            }
        }
    }

    private func libraryButton(_ entry: AppIntegrations.Entry) -> some View {
        let key = "library-" + entry.id
        let selected = store.page == .resources && store.selectedLibraryID == entry.id
        let summary = entry.role + " · " + statusLine(entry)
        return Button {
            showingConnections = false
            store.selectedLibraryID = entry.id; store.page = .resources; model.tabStore.showingOverview = true
        } label: {
            HStack(spacing: 8) {
                Image(systemName: entry.id == "ghostty" || entry.id == "finalshell" ? "terminal" : "books.vertical")
                    .font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary).frame(width: 16)
                VStack(alignment: .leading, spacing: 3) {
                    Text(entry.name).font(.system(size: 13)).foregroundStyle(HubTheme.text).lineLimit(1)
                    Text(summary).font(.system(size: 11)).foregroundStyle(HubTheme.textSecondary).lineLimit(1)
                }
                Spacer(minLength: 0)
            }.padding(.horizontal, 6).padding(.vertical, 6)
                .frame(maxWidth: .infinity, minHeight: SidebarStyle.rowHeight, alignment: .leading)
                .contentShape(RoundedRectangle(cornerRadius: SidebarStyle.radius))
        }.buttonStyle(.plain).background(SidebarStyle.RowBackground(selected: selected, hovered: hoveredRow == key))
            .onHover { hoveredRow = $0 ? key : nil }
            .accessibilityLabel(entry.name + "，" + summary).accessibilityAddTraits(selected ? .isSelected : [])
            .help(entry.name + "\n" + summary)
    }

    private func statusLine(_ entry: AppIntegrations.Entry) -> String {
        let installed = installCounts[entry.id] ?? 0
        let base = installed > 0 ? "已安装 \(installed) 个入口" : "未发现已安装入口"
        let route = entry.workspace?.isEmpty == false ? " · Hub 内入口" : " · 引用关联"
        return base + route
    }

    // MARK: - 待办

    private var boardPage: some View {
        VStack(alignment: .leading, spacing: 20) {
            contextSummary
            if tasks.isEmpty {
                Text("当前范围暂无待办任务。").font(.system(size: 13)).foregroundStyle(HubTheme.textSecondary)
            } else {
                progressSummary
                let today = store.todayTasks.filter { store.isInScope(projectID: $0.projectID) }
                if !today.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        sectionHeader("今日待办", count: today.count)
                        ForEach(today.prefix(5)) { task in taskRow(task) }
                    }
                }
                ForEach(boardGroups, id: \.0) { title, statuses in
                    let grouped = tasks.filter { statuses.contains($0.status) }
                    if !grouped.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            sectionHeader(title, count: grouped.count)
                            ForEach(grouped.prefix(5)) { task in taskRow(task) }
                            if grouped.count > 5 {
                                Text("另 \(grouped.count - 5) 项，见完整看板").font(.system(size: 11))
                                    .foregroundStyle(HubTheme.textSecondary).padding(.horizontal, 6)
                            }
                        }
                    }
                }
            }
            Button { store.page = .board; model.tabStore.showingOverview = true } label: {
                HStack(spacing: 8) {
                    Text("打开完整看板").font(.system(size: 13))
                    Spacer(minLength: 0)
                    Image(systemName: "arrow.up.right").font(.system(size: 11))
                }.foregroundStyle(HubTheme.textSecondary).padding(.horizontal, 6)
                    .frame(minHeight: SidebarStyle.rowHeight).contentShape(Rectangle())
            }.buttonStyle(.plain).background(SidebarStyle.RowBackground(hovered: hoveredRow == "board"))
                .onHover { hoveredRow = $0 ? "board" : nil }
        }
    }

    private var progressSummary: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text("任务进度").font(.system(size: 11, weight: .medium))
                Spacer()
                Text("\(finished) / \(tasks.count) 已验收").font(.system(size: 11)).monospacedDigit()
            }.foregroundStyle(HubTheme.textSecondary)
            GeometryReader { geometry in
                Capsule().fill(HubTheme.border).overlay(alignment: .leading) {
                    Capsule().fill(HubTheme.accent)
                        .frame(width: geometry.size.width * CGFloat(finished) / CGFloat(max(tasks.count, 1)))
                }
            }.frame(height: 3)
                .accessibilityLabel("任务进度，\(tasks.count) 项中 \(finished) 项已验收")
        }
    }

    private func taskRow(_ task: WorkbenchTask) -> some View {
        let selected = store.selectedTaskID == task.id
        let key = "task-" + task.id.uuidString
        return Button { store.selectTask(task.id); model.tabStore.showingOverview = true } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(task.title).font(.system(size: 13)).lineLimit(2)
                    .foregroundStyle(selected ? HubTheme.accent : HubTheme.text)
                Text(task.status.label).font(.system(size: 11)).foregroundStyle(HubTheme.textSecondary)
            }.padding(.horizontal, 6).padding(.vertical, 6)
                .frame(maxWidth: .infinity, minHeight: SidebarStyle.rowHeight, alignment: .leading)
                .contentShape(RoundedRectangle(cornerRadius: SidebarStyle.radius))
        }.buttonStyle(.plain).background(SidebarStyle.RowBackground(selected: selected, hovered: hoveredRow == key))
            .onHover { hoveredRow = $0 ? key : nil }
            .accessibilityAddTraits(selected ? .isSelected : []).help(task.title)
    }
}
