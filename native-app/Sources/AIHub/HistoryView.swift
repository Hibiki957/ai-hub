import SwiftUI

// MARK: - 历史会话窗口

struct HistoryView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var store = HistoryStoreHolder.store
    @State private var query = ""
    @State private var sourceFilter: HistorySource? = nil
    @State private var onlyFavorites = false
    @State private var selected: HistorySession?

    var body: some View {
        HSplitView {
            listPane
                .frame(minWidth: 300, maxWidth: 420)
            detailPane
                .frame(minWidth: 480, maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 900, minHeight: 560)
        .background(HubTheme.panel)
        .onAppear {
            Task { await store.refresh() }
            if selected == nil { selected = filtered.first }
        }
    }

    // MARK: 左侧列表

    private var filtered: [HistorySession] {
        store.sessions.filter { s in
            if let sourceFilter, s.source != sourceFilter { return false }
            if onlyFavorites, !store.isFavorite(s) { return false }
            if query.isEmpty { return true }
            let q = query.lowercased()
            let title = (s.displayTitle ?? s.title).lowercased()
            return title.contains(q) || s.cwd.lowercased().contains(q)
                || s.sessionID.lowercased().contains(q)
        }
    }

    private var listPane: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            list
        }
    }

    private var toolbar: some View {
        VStack(spacing: 8) {
            HStack(spacing: 6) {
                HStack(spacing: 4) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 11))
                        .foregroundStyle(HubTheme.textTertiary)
                    TextField("搜索标题 / 目录 / 会话 ID", text: $query)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12))
                    if !query.isEmpty {
                        Button { query = "" } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 11))
                                .foregroundStyle(HubTheme.textTertiary)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 7).fill(HubTheme.hover))

                Button { Task { await store.refresh() } } label: {
                    Image(systemName: store.isScanning ? "arrow.clockwise" : "arrow.clockwise")
                        .font(.system(size: 12))
                        .foregroundStyle(HubTheme.textSecondary)
                        .rotationEffect(.degrees(store.isScanning ? 360 : 0))
                        .animation(store.isScanning ? .linear(duration: 1).repeatForever(autoreverses: false) : .default, value: store.isScanning)
                }
                .buttonStyle(.plain)
                .help("重新扫描")
            }
            HStack(spacing: 6) {
                sourceChip(.claude)
                sourceChip(.codex)
                Spacer()
                Button {
                    onlyFavorites.toggle()
                } label: {
                    Image(systemName: onlyFavorites ? "star.fill" : "star")
                        .font(.system(size: 11))
                        .foregroundStyle(onlyFavorites ? Color(hex: 0xF59E0B) : HubTheme.textTertiary)
                }
                .buttonStyle(.plain)
                .help("只看收藏")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }

    private func sourceChip(_ s: HistorySource) -> some View {
        let active = sourceFilter == s
        return Button {
            sourceFilter = active ? nil : s
        } label: {
            Text(s.label)
                .font(.system(size: 11))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Capsule().fill(active ? model.brandColorResolved(s.rawValue).opacity(0.15) : HubTheme.hover))
                .foregroundStyle(active ? model.brandColorResolved(s.rawValue) : HubTheme.textSecondary)
        }
        .buttonStyle(.plain)
    }

    private var list: some View {
        ScrollViewReader { proxy in
            List(selection: $selected) {
                ForEach(filtered) { s in
                    SessionRow(s: s, isFav: store.isFavorite(s))
                        .tag(s)
                        .id(s.id)
                        .contextMenu {
                            Button(store.isFavorite(s) ? "取消收藏" : "收藏") { store.toggleFavorite(s) }
                            Button("在 Finder 中显示") { model.revealHistoryFile(s) }
                        }
                }
            }
            .listStyle(.plain)
            .background(HubTheme.panel)
            .onChange(of: selected) { s in
                if let s { Task { _ = await store.messages(for: s) } }
            }
        }
    }

    // MARK: 右侧详情

    private var detailPane: some View {
        Group {
            if let s = selected {
                SessionDetail(s: s)
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 30))
                        .foregroundStyle(HubTheme.textTertiary)
                    Text("选择一个历史会话")
                        .font(.system(size: 13))
                        .foregroundStyle(HubTheme.textTertiary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

private struct SessionRow: View {
    @EnvironmentObject private var model: AppModel
    let s: HistorySession
    let isFav: Bool

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(model.brandColorResolved(s.source.rawValue))
                .frame(width: 7, height: 7)
            VStack(alignment: .leading, spacing: 2) {
                Text(s.displayTitle ?? s.title)
                    .font(.system(size: 12))
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 4) {
                    Text(cwdName)
                        .font(.system(size: 10))
                        .foregroundStyle(HubTheme.textTertiary)
                        .lineLimit(1)
                    Spacer()
                    Text(Self.timeText(s.updatedAt))
                        .font(.system(size: 10))
                        .foregroundStyle(HubTheme.textTertiary)
                }
            }
            if isFav {
                Image(systemName: "star.fill")
                    .font(.system(size: 9))
                    .foregroundStyle(Color(hex: 0xF59E0B))
            }
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
    }

    private var cwdName: String {
        s.cwd.isEmpty ? "—" : (s.cwd as NSString).lastPathComponent
    }

    private static func timeText(_ d: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = d.timeIntervalSinceNow > -86400 ? "HH:mm" : "MM-dd HH:mm"
        return f.string(from: d)
    }
}

private struct SessionDetail: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var store = HistoryStoreHolder.store
    let s: HistorySession

    var body: some View {
        let msgs = store.messageCache[s.filePath] ?? []
        VStack(spacing: 0) {
            header
            Divider()
            if msgs.isEmpty {
                VStack { ProgressView().scaleEffect(0.8); Text("加载中…").font(.system(size: 11)).foregroundStyle(HubTheme.textTertiary) }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(msgs) { m in
                            MessageBubble(m: m, source: s.source)
                        }
                    }
                    .padding(16)
                }
            }
        }
        .background(HubTheme.background)
        .task { _ = await store.messages(for: s) }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(s.displayTitle ?? s.title)
                .font(.system(size: 14, weight: .semibold))
                .lineLimit(2)
            HStack(spacing: 10) {
                Label(s.cwd, systemImage: "folder")
                    .font(.system(size: 10))
                    .foregroundStyle(HubTheme.textTertiary)
                    .lineLimit(1)
                Text(s.source.label)
                    .font(.system(size: 10, weight: .medium))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(model.brandColorResolved(s.source.rawValue).opacity(0.12)))
                    .foregroundStyle(model.brandColorResolved(s.source.rawValue))
                Spacer()
                Button("恢复会话") { model.openHistorySession(s) }
                    .controlSize(.small)
                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: s.filePath)])
                } label: {
                    Image(systemName: "folder.badge.gearshape")
                }
                .controlSize(.small)
                .help("在 Finder 中显示源 JSONL")
                Button {
                    store.toggleFavorite(s)
                } label: {
                    Image(systemName: store.isFavorite(s) ? "star.fill" : "star")
                        .foregroundStyle(store.isFavorite(s) ? Color(hex: 0xF59E0B) : HubTheme.textSecondary)
                }
                .controlSize(.small)
                .help("收藏（本地只读快照标记）")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}

private struct MessageBubble: View {
    @EnvironmentObject private var model: AppModel
    let m: HistoryMessage
    let source: HistorySource

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if m.role == "user" { Spacer(minLength: 60) }
            VStack(alignment: .leading, spacing: 3) {
                if m.isToolCall {
                    Text("工具调用")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(HubTheme.textTertiary)
                    Text(m.text)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(HubTheme.textSecondary)
                        .textSelection(.enabled)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 6).fill(HubTheme.hover))
                } else {
                    Text(m.role == "user" ? "你" : (m.role == "reasoning" ? "思考" : "AI"))
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(m.role == "user" ? model.brandColorResolved(source.rawValue) : HubTheme.textTertiary)
                    Text(m.text)
                        .font(.system(size: 12))
                        .foregroundStyle(m.role == "reasoning" ? HubTheme.textTertiary : HubTheme.text)
                        .textSelection(.enabled)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 8).fill(m.role == "user" ? model.brandColorResolved(source.rawValue).opacity(0.08) : Color(hex: 0xFFFFFF)))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(HubTheme.border, lineWidth: 1))
                }
            }
            if m.role != "user" { Spacer(minLength: 60) }
        }
    }
}

/// 历史窗口是独立 Window scene，store 需要 AppModel 外的稳定单例引用
@MainActor
enum HistoryStoreHolder {
    static let store = HistoryStore()
}
