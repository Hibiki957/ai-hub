import AppKit
import SwiftUI

struct ProjectNavigatorView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var tabs: TabStore
    @ObservedObject var store: WorkbenchStore
    var onCollapse: () -> Void
    var onLegacyTools: () -> Void
    @State private var search = ""
    @State private var editing: WorkbenchProject?
    @State private var creatingProject = false
    @State private var newName = ""
    @State private var newWorkspace: UUID?
    @State private var showingPWALibrary = false
    @State private var collapsedWorkspaces: Set<UUID> = []
    @State private var hoveredRow: String?

    private var query: String { search.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var visibleWorkspaces: [WorkbenchWorkspace] {
        store.state.workspaces.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || !projects(in: $0).isEmpty }
    }
    private var directoryProjects: [Project] {
        model.projects.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }
    }
    private func projects(in workspace: WorkbenchWorkspace) -> [WorkbenchProject] {
        store.state.projects.filter {
            $0.workspaceID == workspace.id && (query.isEmpty || workspace.name.localizedCaseInsensitiveContains(query) || $0.name.localizedCaseInsensitiveContains(query))
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            brandHeader
            searchField
            overviewRow
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    Text("主题与项目")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(HubTheme.textTertiary)
                        .padding(.horizontal, 10).padding(.top, 8).padding(.bottom, 5)
                    ForEach(visibleWorkspaces) { workspace in workspaceSection(workspace) }
                    if visibleWorkspaces.isEmpty && directoryProjects.isEmpty {
                        Text("没有匹配的主题或项目")
                            .font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
                            .padding(.horizontal, 10).padding(.vertical, 12)
                    }
                    if !directoryProjects.isEmpty { directoryImport }
                }
                .padding(.bottom, 8)
            }
            createActions
            Divider().overlay(HubTheme.border)
            VStack(alignment: .leading, spacing: 2) {
                navLink(label: "网页应用", symbol: "globe", count: model.pwaSections.reduce(0) { $0 + $1.items.count }) { showingPWALibrary = true }
                navLink(label: "全部工具与个人设置", symbol: "slider.horizontal.3") { onLegacyTools() }
                navLink(label: "Skill / MCP", symbol: "puzzlepiece.extension") { store.page = .capabilities; tabs.showingOverview = true }
                navLink(label: "对话 / Gateway / API", symbol: "point.3.filled.connected.trianglepath.dotted") { store.page = .control; tabs.showingOverview = true }
            }
        }
        .padding(.horizontal, SidebarStyle.inset).padding(.top, 14).padding(.bottom, 12)
        .frame(maxHeight: .infinity).background(HubTheme.panel)
        .onChange(of: store.selectedProjectID) { id in
            if let workspaceID = store.state.projects.first(where: { $0.id == id })?.workspaceID {
                collapsedWorkspaces.remove(workspaceID)
            }
        }
        .sheet(item: $editing) { project in ProjectSettingsView(store: store, project: project) }
        .sheet(isPresented: $showingPWALibrary) { PWAWorkspaceLibraryView() }
        .sheet(isPresented: $creatingProject) { projectSheet }
    }

    private var brandHeader: some View {
        HStack(spacing: 9) {
            Image(systemName: "cloud.sun")
                .font(.system(size: 12, weight: .medium)).foregroundStyle(.white)
                .frame(width: 25, height: 25)
                .background(HubTheme.primaryGradient, in: RoundedRectangle(cornerRadius: 7))
            Text("AI Hub").font(.system(size: 16, weight: .semibold))
            Spacer()
            Button(action: onCollapse) {
                Image(systemName: "sidebar.left").font(.system(size: 13))
                    .foregroundStyle(HubTheme.textSecondary).frame(width: 26, height: 26)
            }.buttonStyle(.plain).accessibilityLabel("收起项目导航").help("收起项目导航")
        }.padding(.horizontal, 4).padding(.bottom, 2)
    }

    private var searchField: some View {
        HStack(spacing: 7) {
            Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(HubTheme.textTertiary)
            TextField("搜索项目", text: $search).textFieldStyle(.plain).font(.system(size: 12))
                .accessibilityLabel("搜索主题或项目")
            if !search.isEmpty {
                Button { search = "" } label: {
                    Image(systemName: "xmark.circle.fill").font(.system(size: 11)).foregroundStyle(HubTheme.textTertiary)
                }.buttonStyle(.plain).accessibilityLabel("清除项目搜索")
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(HubTheme.surface, in: RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(HubTheme.border, lineWidth: 1))
    }

    private var overviewRow: some View {
        let selected = store.selectedWorkspaceID == nil
        return Button { store.selectWorkspace(nil); tabs.showingOverview = true } label: {
            HStack(spacing: 10) {
                Image(systemName: "square.grid.2x2").font(.system(size: 14)).frame(width: 16)
                Text("全部项目").font(.system(size: 13, weight: selected ? .semibold : .medium))
                Spacer(minLength: 0)
                if !store.todayTasks.isEmpty {
                    Text("\(store.todayTasks.count)")
                        .font(.system(size: 11, weight: .medium)).monospacedDigit()
                        .foregroundStyle(HubTheme.warning)
                        .help("\(store.todayTasks.count) 项今日待办")
                }
            }
            .foregroundStyle(selected ? HubTheme.accent : HubTheme.text)
            .padding(.horizontal, 10).frame(height: SidebarStyle.rowHeight)
            .contentShape(RoundedRectangle(cornerRadius: 7))
        }
        .buttonStyle(.plain)
        .background(rowBackground(selected: selected, key: "overview"))
        .onHover { hoveredRow = $0 ? "overview" : nil }
        .accessibilityLabel("全部项目，查看工具栈")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .help("在全部项目范围浏览工具栈")
    }

    private func workspaceSection(_ workspace: WorkbenchWorkspace) -> some View {
        let children = projects(in: workspace)
        let expanded = !query.isEmpty || !collapsedWorkspaces.contains(workspace.id)
        let selected = store.selectedWorkspaceID == workspace.id && store.selectedProjectID == nil
        let key = workspace.id.uuidString
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 0) {
                if !children.isEmpty {
                    Button {
                        if expanded { collapsedWorkspaces.insert(workspace.id) }
                        else { collapsedWorkspaces.remove(workspace.id) }
                    } label: {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 9, weight: .medium))
                            .foregroundStyle(HubTheme.textTertiary).frame(width: 18, height: 32)
                    }
                    .buttonStyle(.plain)
                    .disabled(!query.isEmpty)
                    .accessibilityLabel((expanded ? "收起" : "展开") + workspace.name + "的项目")
                } else { Color.clear.frame(width: 18, height: 32).accessibilityHidden(true) }
                Button { store.selectWorkspace(workspace.id); tabs.showingOverview = true } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "square.stack").font(.system(size: 13)).frame(width: 16)
                            .foregroundStyle(selected ? HubTheme.accent : HubTheme.textSecondary)
                        Text(workspace.name).font(.system(size: 13, weight: selected ? .semibold : .medium))
                            .lineLimit(1).truncationMode(.tail)
                        Spacer(minLength: 2)
                    }
                    .foregroundStyle(selected ? HubTheme.accent : HubTheme.text)
                    .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
                .help(workspace.name)
                Menu { workspaceActions(workspace) } label: {
                    Image(systemName: "ellipsis").font(.system(size: 12, weight: .medium))
                        .foregroundStyle(HubTheme.textTertiary).frame(width: 24, height: 26)
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .accessibilityLabel(workspace.name + "选项").help(workspace.name + "选项")
            }
            .padding(.horizontal, 4)
            .background(rowBackground(selected: selected, key: key))
            .onHover { hoveredRow = $0 ? key : nil }
            if expanded { ForEach(children) { project in projectRow(project) } }
        }
    }

    private func projectRow(_ project: WorkbenchProject) -> some View {
        let selected = store.selectedProjectID == project.id
        let activeCount = store.state.tasks.filter { $0.projectID == project.id && ![.done, .archived, .cancelled].contains($0.status) }.count
        let key = project.id.uuidString
        return Button { store.selectProject(project.id); tabs.showingOverview = true } label: {
            HStack(spacing: 8) {
                Image(systemName: "folder").font(.system(size: 12)).frame(width: 16)
                    .foregroundStyle(selected ? HubTheme.accent : HubTheme.textTertiary)
                Text(project.name).font(.system(size: 13, weight: selected ? .medium : .regular))
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 2)
                if activeCount > 0 {
                    Text("\(activeCount)").font(.system(size: 11)).monospacedDigit()
                        .foregroundStyle(selected ? HubTheme.accent : HubTheme.textTertiary)
                }
            }
            .foregroundStyle(selected ? HubTheme.accent : HubTheme.textSecondary)
            .padding(.leading, 30).padding(.trailing, 10).padding(.vertical, 7)
            .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
            .contentShape(RoundedRectangle(cornerRadius: 7))
        }
        .buttonStyle(.plain)
        .background(rowBackground(selected: selected, key: key))
        .onHover { hoveredRow = $0 ? key : nil }
        .accessibilityAddTraits(selected ? .isSelected : [])
        .help(project.name)
        .contextMenu { Button("项目设置与目录") { editing = project } }
    }

    private func rowBackground(selected: Bool, key: String) -> some View {
        SidebarStyle.RowBackground(selected: selected, hovered: hoveredRow == key)
    }

    @ViewBuilder private func workspaceActions(_ workspace: WorkbenchWorkspace) -> some View {
        Button("添加项目") { newWorkspace = workspace.id; newName = ""; creatingProject = true }
        Button("重命名大主题") {
            if let name = Prompt.text(title: "重命名大主题", message: "项目将继续保留在这个主题下", initial: workspace.name) {
                act { try store.renameWorkspace(workspace.id, name: name) }
            }
        }
    }

    private var directoryImport: some View {
        VStack(alignment: .leading, spacing: 9) {
            Divider().overlay(HubTheme.border).padding(.top, 12)
            DisclosureGroup("导入已有目录项目") {
                ForEach(directoryProjects) { project in
                    Button("纳入：" + project.name) { act {
                        guard let workspace = store.selectedWorkspaceID ?? store.state.workspaces.first?.id else { return }
                        if let existing = store.state.projects.first(where: { $0.setup?.directory == project.path }) { store.selectProject(existing.id) }
                        else {
                            let id = try store.createProject(workspaceID: workspace, name: project.name)
                            var value = store.state.projects.first { $0.id == id }!
                            var setup = WorkbenchProjectSetup(); setup.directory = project.path; value.setup = setup
                            try store.updateProject(value)
                        }
                        tabs.showingOverview = true
                    } }.font(.system(size: 12)).buttonStyle(.plain).padding(.vertical, 6)
                }
            }.font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
                .padding(.horizontal, 10)
        }
    }

    private var createActions: some View {
        HStack(spacing: 6) {
            Button { newWorkspace = store.selectedWorkspaceID ?? store.state.workspaces.first?.id; newName = ""; creatingProject = true } label: {
                Label("新建项目", systemImage: "plus")
                    .font(.system(size: 12, weight: .medium))
                    .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
                    .padding(.horizontal, 10).contentShape(Rectangle())
            }.buttonStyle(.plain).foregroundStyle(HubTheme.textSecondary)
            Button {
                if let name = Prompt.text(title: "新建大主题", message: "例如：学业、创作、工作", initial: "") {
                    act { try store.createWorkspace(name: name) }
                }
            } label: {
                Image(systemName: "folder.badge.plus").font(.system(size: 13))
                    .foregroundStyle(HubTheme.textSecondary).frame(width: 28, height: 30)
            }.buttonStyle(.plain).accessibilityLabel("新建大主题").help("新建大主题")
        }
    }

    private var projectSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("新建项目").font(.title2)
            Picker("所属大主题", selection: $newWorkspace) { ForEach(store.state.workspaces) { Text($0.name).tag(Optional($0.id)) } }
            TextField("项目名称", text: $newName).textFieldStyle(.roundedBorder)
            HStack { Button("取消") { creatingProject = false }; Spacer(); Button("创建") { act {
                guard let id = newWorkspace else { return }; try store.createProject(workspaceID: id, name: newName); creatingProject = false; tabs.showingOverview = true
            } }.disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty) }
        }.padding(24).frame(width: 430)
    }

    private func navLink(label: String, symbol: String, count: Int? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol).font(.system(size: 12)).foregroundStyle(HubTheme.textTertiary).frame(width: 16)
                Text(label).font(.system(size: 12)).lineLimit(1)
                Spacer(minLength: 0)
                if let count { Text("\(count)").font(.system(size: 11)).monospacedDigit().foregroundStyle(HubTheme.textTertiary) }
            }
            .padding(.horizontal, 10).frame(height: 30)
            .contentShape(RoundedRectangle(cornerRadius: 7))
        }.buttonStyle(.plain).foregroundStyle(HubTheme.textSecondary).help(label)
    }

    private func act(_ action: () throws -> Void) { do { try action() } catch { store.errorMessage = error.localizedDescription } }
}

struct ProjectSettingsView: View {
    @ObservedObject var store: WorkbenchStore
    @Environment(\.dismiss) private var dismiss
    @State private var draft: WorkbenchProject
    @State private var setup: WorkbenchProjectSetup
    init(store: WorkbenchStore, project: WorkbenchProject) {
        self.store = store; _draft = State(initialValue: project); _setup = State(initialValue: project.setup ?? .init())
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            Text("项目设置").font(.title2)
            TextField("项目名称", text: $draft.name).textFieldStyle(.roundedBorder)
            Picker("大主题", selection: $draft.workspaceID) { ForEach(store.state.workspaces) { Text($0.name).tag($0.id) } }
            Picker("项目类型", selection: $setup.kind) { ForEach(WorkbenchProjectKind.allCases, id: \.self) { Text($0.label).tag($0) } }
            TextField("项目说明", text: $draft.detail, axis: .vertical).lineLimit(2...4).textFieldStyle(.roundedBorder)
            HStack {
                TextField("项目目录", text: $setup.directory).textFieldStyle(.roundedBorder)
                Button("选择") {
                    let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false
                    if panel.runModal() == .OK, let url = panel.url { setup.directory = url.path }
                }
            }
            TextField("项目上下文文件（仅保存路径）", text: Binding(get: { setup.contextFilePath ?? "" }, set: { setup.contextFilePath = $0.isEmpty ? nil : $0 })).textFieldStyle(.roundedBorder)
            Text("关联目录用于文件浏览和手动终端；受控任务权限仍需独立确认。").font(.caption).foregroundStyle(.secondary)
            if let error = store.errorMessage { Text(error).font(.caption).foregroundStyle(HubTheme.danger) }
            HStack { Button("取消") { dismiss() }; Spacer(); Button("保存") {
                do { draft.setup = setup; try store.updateProject(draft); store.selectedWorkspaceID = draft.workspaceID; dismiss() }
                catch { store.errorMessage = error.localizedDescription }
            }.keyboardShortcut(.defaultAction) }
        }.padding(24).frame(width: 490)
    }
}
