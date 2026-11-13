import AppKit
import CryptoKit
import Foundation
import SwiftUI

struct ManagedCapability: Identifiable, Codable {
    let id: String
    let kind: String
    let name: String
    let source: String
    let canonicalSource: String
    let description: String
    let version: String
    let state: String
    var aliases: Int = 1
}

struct CapabilityScope: Codable, Equatable {
    var enabledSkillIDs: [String] = []
    var enabledMCPIDs: [String] = []
}

struct ManagementRevision: Identifiable, Codable, Equatable {
    let id: UUID
    let date: Date
    let scope: String
    let before: CapabilityScope
    let after: CapabilityScope
}

/// Owns only AI Hub's capability selections. It never edits another client's
/// configs, copies environment/credentials, or starts every discovered MCP.
@MainActor final class WorkbenchManagementStore: ObservableObject {
    static let shared = WorkbenchManagementStore()
    @Published private(set) var inventory: [ManagedCapability] = []
    @Published private(set) var scopes: [String: CapabilityScope] = [:]
    @Published private(set) var revisions: [ManagementRevision] = []
    @Published var issue: String?
    @Published private(set) var scanning = false
    private let directory: URL
    struct State: Codable { var scopes: [String: CapabilityScope]; var revisions: [ManagementRevision] }

    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/AIHub/Management")
        if let data = try? Data(contentsOf: self.directory.appendingPathComponent("scopes.json")), let value = try? JSONDecoder().decode(State.self, from: data) {
            scopes = value.scopes; revisions = value.revisions
        }
        if let data = try? Data(contentsOf: self.directory.appendingPathComponent("inventory.json")), let value = try? JSONDecoder().decode([ManagedCapability].self, from: data) { inventory = value }
    }

    static func identity(_ path: String) -> String { SHA256.hash(data: Data(path.utf8)).map { String(format: "%02x", $0) }.joined() }

    nonisolated static func discover(home: URL) -> [ManagedCapability] {
        let fm = FileManager.default
        let roots = [".agents/skills", ".codex/skills", ".claude/skills"]
        var found: [String: ManagedCapability] = [:]
        for folder in roots {
            let root = home.appendingPathComponent(folder)
            for entry in ((try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []).prefix(3000) {
                let file = entry.appendingPathComponent("SKILL.md")
                guard fm.fileExists(atPath: file.path) else { continue }
                let canonical = file.resolvingSymlinksInPath().standardizedFileURL.path
                let key = SHA256.hash(data: Data(canonical.utf8)).map { String(format: "%02x", $0) }.joined()
                if var previous = found[key] { previous.aliases += 1; found[key] = previous; continue }
                // Read only the bounded metadata header, never inject skill bodies.
                guard let handle = try? FileHandle(forReadingFrom: file) else { continue }
                let data = (try? handle.read(upToCount: 8192)) ?? Data(); try? handle.close()
                let lines = Array(String(decoding: data, as: UTF8.self).components(separatedBy: "\n").prefix(45))
                // A body line named "description:" is not frontmatter. Require
                // a complete metadata block within the read/line budget.
                let closing = lines.indices.dropFirst().first { lines[$0].trimmingCharacters(in: .whitespacesAndNewlines) == "---" }
                let header: [String]
                if lines.first?.trimmingCharacters(in: .whitespacesAndNewlines) == "---", let closing {
                    header = Array(lines[1..<closing])
                } else { header = [] }
                func field(_ name: String) -> String? {
                    header.first(where: { $0.hasPrefix(name + ":") }).map { String($0.dropFirst(name.count + 1)).trimmingCharacters(in: CharacterSet(charactersIn: " \"'")) }
                }
                found[key] = ManagedCapability(id: key, kind: "skill", name: String((field("name") ?? entry.lastPathComponent).prefix(200)),
                    source: file.path, canonicalSource: canonical, description: String((field("description") ?? "未提供描述").prefix(500)),
                    version: String((field("version") ?? "未声明").prefix(100)), state: "已发现 · 尚未授予任务读取")
            }
        }
        // MCP discovery deliberately extracts only section names from Codex's
        // settings. No args, URLs, env values, tokens or command execution.
        let config = home.appendingPathComponent(".codex/config.toml")
        if let text = try? String(contentsOf: config, encoding: .utf8) {
            for name in mcpSectionNames(text) {
                let key = SHA256.hash(data: Data((config.path + "#" + name).utf8)).map { String(format: "%02x", $0) }.joined()
                found[key] = ManagedCapability(id: key, kind: "mcp", name: name, source: config.path, canonicalSource: config.path,
                    description: "外部客户端配置引用；工具列表、服务类型、连接和授权尚未由 Hub 验证。不会继承该客户端权限。",
                    version: "未知", state: "已发现 · Hub 未配置/未连接/未授权")
            }
        }
        return found.values.sorted { ($0.kind, $0.name) < ($1.kind, $1.name) }
    }

    /// Extract section names without retaining configuration values. Nested
    /// env tables, comments and apparent headers inside TOML strings are ignored.
    nonisolated private static func mcpSectionNames(_ text: String) -> [String] {
        let pattern = #"^\[mcp_servers\.(?:([A-Za-z0-9_-]+)|\"((?:[^\"\\]|\\.)*)\"|'([^']*)')\]\s*(?:#.*)?$"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        var multiline: Character?
        var names: [String] = []
        for line in text.components(separatedBy: "\n") {
            let clean = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if multiline == nil, let match = regex.firstMatch(in: clean, range: NSRange(clean.startIndex..., in: clean)) {
                for group in 1...3 where match.range(at: group).location != NSNotFound {
                    if let range = Range(match.range(at: group), in: clean) {
                        var name = String(clean[range])
                        if group == 2 {
                            // TOML basic strings share JSON's ordinary escapes;
                            // unsupported escapes fail closed instead of becoming IDs.
                            guard let data = ("\"" + name + "\"").data(using: .utf8),
                                  let decoded = try? JSONDecoder().decode(String.self, from: data) else { continue }
                            name = decoded
                        }
                        if !name.isEmpty, name.utf8.count <= 256,
                           !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) { names.append(name) }
                    }
                }
            }
            let chars = Array(line)
            var index = 0
            var inlineQuote: Character?
            while index < chars.count {
                let ch = chars[index]
                let triple = index + 2 < chars.count && chars[index + 1] == ch && chars[index + 2] == ch
                if let delimiter = multiline {
                    if delimiter == "\"", ch == "\\" { index += 2; continue }
                    if ch == delimiter && triple { multiline = nil; index += 3; continue }
                } else if let delimiter = inlineQuote {
                    if delimiter == "\"", ch == "\\" { index += 2; continue }
                    if ch == delimiter { inlineQuote = nil }
                } else {
                    if ch == "#" { break }
                    if ch == "\"" || ch == "'" {
                        if triple { multiline = ch; index += 3; continue }
                        inlineQuote = ch
                    }
                }
                index += 1
            }
        }
        return names
    }

    func scan() {
        guard !scanning else { return }; scanning = true
        let home = FileManager.default.homeDirectoryForCurrentUser
        Task { [weak self] in
            let entries = await Task.detached(priority: .utility) { Self.discover(home: home) }.value
            guard let self else { return }
            self.inventory = entries; self.scanning = false
            do {
                try HubConfigurationOwnership.requireHubWrite(to: self.directory)
                let file = self.directory.appendingPathComponent("inventory.json")
                try HubConfigurationOwnership.requireHubWrite(to: file)
                try FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                try JSONEncoder().encode(entries).write(to: file, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            } catch { self.issue = error.localizedDescription }
        }
    }

    func apply(scope: String, proposed: CapabilityScope) throws {
        guard scope == "global" || scope.range(of: #"^(project|task):[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"#, options: .regularExpression) != nil else { throw ManagementError.invalidScope }
        let knownSkills = Set(inventory.filter { $0.kind == "skill" }.map(\.id))
        let knownMCP = Set(inventory.filter { $0.kind == "mcp" }.map(\.id))
        guard proposed.enabledSkillIDs.allSatisfy(knownSkills.contains), proposed.enabledMCPIDs.allSatisfy(knownMCP.contains) else { throw ManagementError.unknownItem }
        let before = scopes[scope] ?? CapabilityScope()
        guard before != proposed else { return }
        let oldScopes = scopes, oldRevisions = revisions
        scopes[scope] = proposed
        revisions.append(ManagementRevision(id: UUID(), date: Date(), scope: scope, before: before, after: proposed))
        do { try save() } catch { scopes = oldScopes; revisions = oldRevisions; throw error }
    }
    func rollback(_ revision: ManagementRevision) throws {
        guard canRollback(revision) else { throw ManagementError.conflict }
        let oldScopes = scopes, oldRevisions = revisions
        scopes[revision.scope] = revision.before
        revisions.append(ManagementRevision(id: UUID(), date: Date(), scope: revision.scope, before: revision.after, after: revision.before))
        do { try save() } catch { scopes = oldScopes; revisions = oldRevisions; throw error }
    }
    func canRollback(_ revision: ManagementRevision) -> Bool {
        scopes[revision.scope] == revision.after && revisions.last(where: { $0.scope == revision.scope }) == revision
    }
    func effectiveSkills(projectID: String, taskID: String) -> [ManagedCapability] {
        let ids = Set(["global", "project:" + projectID, "task:" + taskID].flatMap { scopes[$0]?.enabledSkillIDs ?? [] })
        return inventory.filter { $0.kind == "skill" && ids.contains($0.id) }
    }
    private func save() throws {
        try HubConfigurationOwnership.requireHubWrite(to: directory)
        let url = directory.appendingPathComponent("scopes.json")
        try HubConfigurationOwnership.requireHubWrite(to: url)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if FileManager.default.fileExists(atPath: url.path) {
            let backup = directory.appendingPathComponent("scopes-before-\(UUID().uuidString).json")
            try HubConfigurationOwnership.requireHubWrite(to: backup)
            try FileManager.default.copyItem(at: url, to: backup)
        }
        try JSONEncoder().encode(State(scopes: scopes, revisions: revisions)).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    enum ManagementError: LocalizedError {
        case invalidScope, unknownItem, conflict
        var errorDescription: String? {
            switch self {
            case .invalidScope: return "范围必须是 global、project:项目ID 或 task:任务ID。"
            case .unknownItem: return "存在未发现的能力，请重新扫描。"
            case .conflict: return "该范围在此版本后已有变更，请先核对当前配置。"
            }
        }
    }
}

struct WorkbenchManagementView: View {
    struct ScopeChoice: Identifiable {
        var id: String
        var name: String
    }
    var scopeChoices: [ScopeChoice] = [ScopeChoice(id: "global", name: "全部项目")]
    @StateObject private var manager = WorkbenchManagementStore.shared
    @State private var scope = "global"
    @State private var staged = CapabilityScope()
    @State private var preview = false
    @State private var search = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Skill / MCP 管理").font(.title2)
            Text("只管理 Hub 自己的范围配置；外部客户端是配置来源引用，不会被覆盖。MCP 选入范围不代表已连接或授权。")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Picker("生效范围", selection: $scope) {
                    ForEach(scopeChoices) { choice in Text(choice.name).tag(choice.id) }
                }.onChange(of: scope) { _ in staged = manager.scopes[scope] ?? CapabilityScope() }
                Button(manager.scanning ? "扫描中…" : "发现本机能力") { manager.scan() }.disabled(manager.scanning)
                Button("载入范围") { staged = manager.scopes[scope] ?? CapabilityScope() }
                Button("预览变更") { preview = true }
            }
            TextField("搜索名称或描述", text: $search)
            // 本文件会被执行层检查脚本独立编译，颜色与 HubTheme.danger 同步但用字面量，不引用 HubTheme。
            if let issue = manager.issue { Text(issue).foregroundStyle(Color(red: 178/255, green: 81/255, blue: 97/255)).textSelection(.enabled) }
            List(manager.inventory.filter { search.isEmpty || ($0.name + $0.description).localizedCaseInsensitiveContains(search) }) { entry in
                HStack(alignment: .top) {
                    Toggle("", isOn: Binding(get: {
                        (entry.kind == "skill" ? staged.enabledSkillIDs : staged.enabledMCPIDs).contains(entry.id)
                    }, set: { enabled in
                        if entry.kind == "skill" {
                            staged.enabledSkillIDs.removeAll { $0 == entry.id }; if enabled { staged.enabledSkillIDs.append(entry.id) }
                        } else {
                            staged.enabledMCPIDs.removeAll { $0 == entry.id }; if enabled { staged.enabledMCPIDs.append(entry.id) }
                        }
                    })).labelsHidden()
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(entry.name) · \(entry.kind.uppercased()) · \(entry.version)").font(.headline)
                        Text(entry.description).font(.caption)
                        Text(entry.state + (entry.aliases > 1 ? " · 同源入口 \(entry.aliases) 个" : "")).font(.caption).foregroundStyle(.secondary)
                        Text(entry.source).font(.caption2).textSelection(.enabled)
                    }
                }
            }
            DisclosureGroup("配置版本与回退（仅 Hub 自有配置）") {
                ScrollView {
                    ForEach(manager.revisions.reversed()) { revision in
                        HStack {
                            Text(revision.date.formatted() + " · " + (scopeChoices.first { $0.id == revision.scope }?.name ?? "已移除的范围")).font(.caption)
                            Spacer()
                            Button("回退此变更") { do { try manager.rollback(revision); staged = manager.scopes[scope] ?? CapabilityScope() } catch { manager.issue = error.localizedDescription } }
                                .disabled(!manager.canRollback(revision))
                        }
                    }
                }.frame(maxHeight: 110)
            }
        }.padding(20)
        .sheet(isPresented: $preview) {
            VStack(alignment: .leading, spacing: 14) {
                Text("配置变更预览").font(.title2)
                Text("范围：" + (scopeChoices.first { $0.id == scope }?.name ?? "未知范围"))
                let before = manager.scopes[scope] ?? CapabilityScope()
                Text("Skill：\(before.enabledSkillIDs.count) → \(staged.enabledSkillIDs.count)\nMCP 引用：\(before.enabledMCPIDs.count) → \(staged.enabledMCPIDs.count)")
                Text("仅保存能力 ID 与范围，不复制凭据；Skill 正文仍需任务目录权限批准。MCP 运行适配尚未实现，当前只保存引用。")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("取消") { preview = false }
                    Button("保存 Hub 配置版本") {
                        do { try manager.apply(scope: scope, proposed: staged); preview = false } catch { manager.issue = error.localizedDescription; preview = false }
                    }
                }
            }.padding(24).frame(width: 520)
        }
    }
}
