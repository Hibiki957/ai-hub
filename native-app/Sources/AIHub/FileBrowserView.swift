import SwiftUI

// MARK: - 文件管理器模型

struct FileItem: Identifiable, Hashable {
    let name: String
    let path: String
    let isDirectory: Bool
    let size: Int64?
    let modifiedAt: Date?
    let isHidden: Bool

    var id: String { path }

    var displaySize: String {
        guard !isDirectory, let size else { return "--" }
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: size)
    }

    var displayDate: String {
        guard let modifiedAt else { return "--" }
        let f = DateFormatter()
        f.dateFormat = "MM-dd HH:mm"
        return f.string(from: modifiedAt)
    }

    var icon: String {
        if isDirectory { return "folder" }
        let ext = (name as NSString).pathExtension.lowercased()
        switch ext {
        case "swift": return "swift"
        case "py": return "doc.text"
        case "js", "ts": return "doc.text"
        case "json", "yaml", "yml", "toml", "md": return "doc.text"
        case "jpg", "jpeg", "png", "gif", "heic": return "photo"
        case "pdf": return "doc.richtext"
        case "zip", "tar", "gz": return "doc.zipper"
        case "app": return "app"
        default: return "doc"
        }
    }
}

enum FileBrowserSort: String, CaseIterable {
    case name, date, size
    var label: String {
        switch self {
        case .name: return "名称"
        case .date: return "日期"
        case .size: return "大小"
        }
    }
}

// MARK: - 文件管理器视图

struct FileBrowserView: View {
    @EnvironmentObject private var model: AppModel
    var showsCloseButton = true

    @State private var items: [FileItem] = []
    @State private var isLoading = false
    @State private var sort: FileBrowserSort = .name
    @State private var ascending = true

    private var path: String { model.browserPath }

    var body: some View {
        VStack(spacing: 0) {
            pathBar
            Divider()
            if isLoading {
                VStack { ProgressView().scaleEffect(0.7); Text("加载中…").font(.system(size: 11)).foregroundStyle(HubTheme.textTertiary) }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                fileList
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(HubTheme.panel)
        .onChange(of: path) { _ in reload() }
        .onAppear { reload() }
    }

    // ── 路径栏 ──

    private var pathBar: some View {
        HStack(spacing: 4) {
            Button {
                goUp()
            } label: {
                Image(systemName: "chevron.up")
                    .font(.system(size: 11))
                    .foregroundStyle(canGoUp ? HubTheme.textSecondary : HubTheme.textTertiary)
            }
            .buttonStyle(.plain)
            .disabled(!canGoUp)
            .accessibilityLabel("上一级目录")
            .help("上一级")

            if showsCloseButton {
                Button {
                    model.showFileBrowser = false
                } label: {
                    Image(systemName: "sidebar.right")
                        .font(.system(size: 12))
                        .foregroundStyle(HubTheme.textSecondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("关闭文件浏览器")
                .help("关闭文件浏览器")
            }

            Text((path as NSString).lastPathComponent.isEmpty ? path : (path as NSString).lastPathComponent)
                .font(.system(size: 12, weight: .medium))
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)

            Menu {
                ForEach(FileBrowserSort.allCases, id: \.self) { s in
                    Button {
                        if sort == s { ascending.toggle() } else { sort = s; ascending = true }
                    } label: {
                        Label(s.label, systemImage: sort == s ? (ascending ? "arrow.up" : "arrow.down") : "")
                    }
                }
            } label: {
                Image(systemName: "arrow.up.arrow.down")
                    .font(.system(size: 10))
                    .foregroundStyle(HubTheme.textTertiary)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .frame(width: 20, height: 20)
            .accessibilityLabel("文件排序方式")

            Button {
                reload()
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 10))
                    .foregroundStyle(HubTheme.textTertiary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("刷新目录")
            .help("刷新")
        }
        .padding(.horizontal, SidebarStyle.inset)
        .padding(.vertical, 8)
    }

    private var canGoUp: Bool {
        let p = path.hasSuffix("/") ? String(path.dropLast()) : path
        let parent = (p as NSString).deletingLastPathComponent; return parent != p && !parent.isEmpty && p != "/"
    }

    private var sortedItems: [FileItem] {
        let sorted: [FileItem]
        switch sort {
        case .name:
            sorted = items.sorted { $0.isDirectory != $1.isDirectory ? $0.isDirectory : $0.name.localizedCaseInsensitiveCompare($1.name) == (ascending ? .orderedAscending : .orderedDescending) }
        case .date:
            sorted = items.sorted { ($0.modifiedAt ?? .distantPast) < ($1.modifiedAt ?? .distantPast) }
        case .size:
            sorted = items.sorted { ($0.size ?? 0) < ($1.size ?? 0) }
        }
        return ascending ? sorted : sorted.reversed()
    }

    // ── 文件列表 ──

    private var fileList: some View {
        List {
            if !canGoUp {
                Button {
                    model.browserPath = NSHomeDirectory()
                } label: {
                    Label("主目录", systemImage: "house")
                        .font(.system(size: 12))
                }
                .buttonStyle(.plain)
            }
            ForEach(sortedItems) { item in
                FileRow(item: item) {
                    if item.isDirectory {
                        model.browserPath = item.path
                    } else {
                        NSWorkspace.shared.open(URL(fileURLWithPath: item.path))
                    }
                }
                .listRowInsets(EdgeInsets(top: 0, leading: 6, bottom: 0, trailing: 6))
                .listRowSeparator(.hidden)
                .contextMenu {
                    Button("打开") { NSWorkspace.shared.open(URL(fileURLWithPath: item.path)) }
                    Button("在 Finder 中显示") {
                        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: item.path)])
                    }
                    Button("在终端中打开") {
                        openInTerminal(item)
                    }
                    Divider()
                    Button("复制路径") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(item.path, forType: .string)
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(HubTheme.panel)
    }

    // ── 操作 ──

    private func goUp() {
        let p = path.hasSuffix("/") ? String(path.dropLast()) : path
        let parent = (p as NSString).deletingLastPathComponent; if parent != path && !parent.isEmpty {
            model.browserPath = parent
        }
    }

    private func openInTerminal(_ item: FileItem) {
        let cli = model.cliEntries.first ?? CLIEntry(name: "zsh", command: "/bin/zsh", title: "zsh")
        model.openCLI(cli, workingDirectory: item.isDirectory ? item.path : (item.path as NSString).deletingLastPathComponent)
    }

    private func reload() {
        isLoading = true
        let currentPath = path
        Task.detached(priority: .utility) {
            let result = Self.loadDirectory(currentPath)
            await MainActor.run {
                if model.browserPath == currentPath {
                    items = result
                    isLoading = false
                }
            }
        }
    }

    nonisolated static func loadDirectory(_ path: String) -> [FileItem] {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: path) else { return [] }
        var result: [FileItem] = []
        for name in names {
            let itemPath = path + "/" + name
            guard let attrs = try? fm.attributesOfItem(atPath: itemPath) else { continue }
            let isDir = (attrs[.type] as? FileAttributeType) == .typeDirectory
            // 默认隐藏点开头的文件（和 macOS Finder 一致）
            if name.hasPrefix(".") { continue }
            result.append(FileItem(
                name: name,
                path: itemPath,
                isDirectory: isDir,
                size: isDir ? nil : (attrs[.size] as? Int64),
                modifiedAt: attrs[.modificationDate] as? Date,
                isHidden: name.hasPrefix(".")
            ))
        }
        return result
    }
}

// MARK: - 单行

private struct FileRow: View {
    let item: FileItem
    let action: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: item.icon)
                    .font(.system(size: 13))
                    .foregroundStyle(HubTheme.textSecondary)
                    .frame(width: 16)
                Text(item.name)
                    .font(.system(size: 13))
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !item.isDirectory {
                    Text(item.displaySize)
                        .font(.system(size: 11))
                        .foregroundStyle(HubTheme.textTertiary)
                }
            }
            .padding(.horizontal, 6)
            .frame(minHeight: SidebarStyle.rowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(SidebarStyle.RowBackground(hovered: hovered))
        .onHover { hovered = $0 }
        .help(item.path)
    }
}
