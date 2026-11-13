import Foundation
import SQLite3

// MARK: - 历史会话模型

enum HistorySource: String, CaseIterable {
    case claude
    case codex
    case grok
    case kimi
    case opencode

    var label: String {
        switch self {
        case .claude: return "Claude Code"
        case .codex: return "Codex"
        case .grok: return "Grok"
        case .kimi: return "Kimi"
        case .opencode: return "OpenCode"
        }
    }
}

struct HistoryMessage: Identifiable {
    let id: Int
    let role: String       // user / assistant / tool
    let text: String
    let timestamp: Date?
    let isToolCall: Bool
}

struct HistorySession: Identifiable, Hashable {
    let id: String              // filePath
    let source: HistorySource
    let sessionID: String
    let filePath: String
    let cwd: String
    let startedAt: Date
    let updatedAt: Date         // 文件 mtime
    let sizeBytes: Int
    let messageCount: Int
    var title: String           // 首条用户消息截断
    var displayTitle: String?   // Codex thread_name 覆盖
}

// MARK: - 扫描与解析（非隔离，后台调用）

enum HistoryParser {
    static let claudeDir = NSHomeDirectory() + "/.claude/projects"
    static let codexDir = NSHomeDirectory() + "/.codex/sessions"
    static let grokDir = NSHomeDirectory() + "/.grok/sessions"
    static let kimiDir = NSHomeDirectory() + "/.kimi/sessions"
    static let opencodeDB = NSHomeDirectory() + "/.local/share/opencode/opencode.db"
    static let maxParseBytes = 4 * 1024 * 1024   // 单文件解析上限，防超大文件卡扫描

    /// 全量扫描全部来源
    static func scanAll() -> [HistorySession] {
        var result: [HistorySession] = []
        result.append(contentsOf: scanClaude())
        result.append(contentsOf: scanCodex())
        result.append(contentsOf: scanGrok())
        result.append(contentsOf: scanKimi())
        result.append(contentsOf: scanOpencode())
        return result.sorted { $0.updatedAt > $1.updatedAt }
    }

    private static func scanClaude() -> [HistorySession] {
        let fm = FileManager.default
        guard let dirs = try? fm.contentsOfDirectory(atPath: claudeDir) else { return [] }
        var out: [HistorySession] = []
        for dir in dirs {
            let dirPath = claudeDir + "/" + dir
            guard let files = try? fm.contentsOfDirectory(atPath: dirPath) else { continue }
            for f in files where f.hasSuffix(".jsonl") {
                let path = dirPath + "/" + f
                if let s = parseClaude(path: path) { out.append(s) }
            }
        }
        return out
    }

    private static func parseClaude(path: String) -> HistorySession? {
        let fm = FileManager.default
        guard let attrs = try? fm.attributesOfItem(atPath: path),
              let size = attrs[.size] as? Int else { return nil }
        guard let data = readCapped(path, maxParseBytes) else { return nil }
        var sessionID = ""
        var cwd = ""
        var startedAt = Date()
        var title = ""
        var count = 0
        var sawUser = false
        for raw in String(decoding: data, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: true) {
            guard let d = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] else { continue }
            let type = d["type"] as? String ?? ""
            if type == "user", let msg = d["message"] as? [String: Any] {
                let text = messageText(msg["content"])
                count += 1
                if !sawUser, !text.isEmpty {
                    sawUser = true
                    title = String(text.prefix(100))
                }
            } else if type == "assistant", d["message"] != nil {
                count += 1
            }
            if sessionID.isEmpty, let sid = d["sessionId"] as? String { sessionID = sid }
            if cwd.isEmpty, let c = d["cwd"] as? String { cwd = c }
            if startedAt.timeIntervalSince1970 < 1 { startedAt = dateFrom(d["timestamp"]) }
        }
        guard !sessionID.isEmpty else { return nil }
        let mtime = (attrs[.modificationDate] as? Date) ?? Date()
        return HistorySession(id: path, source: .claude, sessionID: sessionID, filePath: path,
                              cwd: cwd, startedAt: startedAt, updatedAt: mtime, sizeBytes: size,
                              messageCount: count, title: title, displayTitle: nil)
    }

    private static func scanCodex() -> [HistorySession] {
        let fm = FileManager.default
        guard let en = fm.enumerator(atPath: codexDir) else { return [] }
        let names = sessionIndexNames()
        var out: [HistorySession] = []
        for case let path as String in en where path.hasSuffix(".jsonl") {
            let full = codexDir + "/" + path
            if let s = parseCodex(path: full, names: names) { out.append(s) }
        }
        return out
    }

    private static func parseCodex(path: String, names: [String: String]) -> HistorySession? {
        let fm = FileManager.default
        guard let attrs = try? fm.attributesOfItem(atPath: path),
              let size = attrs[.size] as? Int else { return nil }
        guard let data = readCapped(path, maxParseBytes) else { return nil }
        var sessionID = ""
        var cwd = ""
        var startedAt: Date?
        var title = ""
        var count = 0
        var sawUser = false
        for raw in String(decoding: data, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: true) {
            guard let d = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] else { continue }
            let type = d["type"] as? String ?? ""
            let payload = d["payload"] as? [String: Any] ?? [:]
            if type == "session_meta" {
                sessionID = (payload["session_id"] as? String) ?? (payload["id"] as? String) ?? ""
                cwd = payload["cwd"] as? String ?? ""
                startedAt = dateFrom(payload["timestamp"] as? String)
            } else if type == "response_item", payload["type"] as? String == "message" {
                count += 1
                let role = payload["role"] as? String ?? ""
                if !sawUser, role == "user" {
                    let text = contentText(payload["content"])
                    if !text.isEmpty, !text.hasPrefix("<"), !text.contains("environment_context") {
                        sawUser = true
                        title = String(text.prefix(100))
                    }
                }
            }
        }
        guard !sessionID.isEmpty else { return nil }
        let mtime = (attrs[.modificationDate] as? Date) ?? Date()
        return HistorySession(id: path, source: .codex, sessionID: sessionID, filePath: path,
                              cwd: cwd, startedAt: startedAt ?? mtime, updatedAt: mtime,
                              sizeBytes: size, messageCount: count,
                              title: title, displayTitle: names[sessionID])
    }

    /// ~/.codex/session_index.jsonl → sessionID → 最新 thread_name
    private static func sessionIndexNames() -> [String: String] {
        let path = NSHomeDirectory() + "/.codex/session_index.jsonl"
        guard let data = readCapped(path, 2 * 1024 * 1024) else { return [:] }
        var best: [String: (Date, String)] = [:]
        for raw in String(decoding: data, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: true) {
            guard let d = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any],
                  let id = d["id"] as? String else { continue }
            let name = d["thread_name"] as? String ?? ""
            guard !name.isEmpty else { continue }
            let ts = dateFrom(d["updated_at"] as? String) ?? Date()
            if let prev = best[id] {
                if ts > prev.0 { best[id] = (ts, name) }
            } else {
                best[id] = (ts, name)
            }
        }
        return best.mapValues { $0.1 }
    }

    // ── Grok: ~/.grok/sessions/<URL编码cwd>/<sessionID>/chat_history.jsonl ──

    private static func scanGrok() -> [HistorySession] {
        let fm = FileManager.default
        guard let projDirs = try? fm.contentsOfDirectory(atPath: grokDir) else { return [] }
        var out: [HistorySession] = []
        for pd in projDirs {
            let projPath = grokDir + "/" + pd
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: projPath, isDirectory: &isDir), isDir.boolValue else { continue }
            let cwd = pd.removingPercentEncoding ?? pd
            guard let sids = try? fm.contentsOfDirectory(atPath: projPath) else { continue }
            for sid in sids {
                let chatPath = projPath + "/" + sid + "/chat_history.jsonl"
                guard fm.fileExists(atPath: chatPath) else { continue }
                if let s = parseGrok(path: chatPath, sessionID: sid, cwd: cwd) { out.append(s) }
            }
        }
        return out
    }

    private static func parseGrok(path: String, sessionID: String, cwd: String) -> HistorySession? {
        let fm = FileManager.default
        guard let attrs = try? fm.attributesOfItem(atPath: path),
              let size = attrs[.size] as? Int else { return nil }
        guard let data = readCapped(path, maxParseBytes) else { return nil }
        var title = ""
        var count = 0
        var sawUser = false
        for raw in String(decoding: data, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: true) {
            guard let d = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] else { continue }
            let type = d["type"] as? String ?? ""
            guard type == "user" || type == "assistant" else { continue }
            count += 1
            if !sawUser, type == "user" {
                let text = messageText(d["content"])
                if !text.isEmpty, !text.hasPrefix("<user_info>"), !text.hasPrefix("<system") {
                    sawUser = true
                    title = String(text.prefix(100))
                }
            }
        }
        guard sawUser else { return nil }
        let mtime = (attrs[.modificationDate] as? Date) ?? Date()
        return HistorySession(id: path, source: .grok, sessionID: sessionID, filePath: path,
                              cwd: cwd, startedAt: (attrs[.creationDate] as? Date) ?? mtime, updatedAt: mtime,
                              sizeBytes: size, messageCount: count, title: title, displayTitle: nil)
    }

    // ── Kimi: ~/.kimi/sessions/<group>/<sessionID>/context.jsonl ──

    private static func scanKimi() -> [HistorySession] {
        let fm = FileManager.default
        guard let groups = try? fm.contentsOfDirectory(atPath: kimiDir) else { return [] }
        var out: [HistorySession] = []
        for g in groups {
            let gp = kimiDir + "/" + g
            guard let sids = try? fm.contentsOfDirectory(atPath: gp) else { continue }
            for sid in sids {
                let chatPath = gp + "/" + sid + "/context.jsonl"
                guard fm.fileExists(atPath: chatPath) else { continue }
                if let s = parseKimi(path: chatPath, sessionID: sid) { out.append(s) }
            }
        }
        return out
    }

    private static func parseKimi(path: String, sessionID: String) -> HistorySession? {
        let fm = FileManager.default
        guard let attrs = try? fm.attributesOfItem(atPath: path),
              let size = attrs[.size] as? Int else { return nil }
        guard let data = readCapped(path, maxParseBytes) else { return nil }
        var title = ""
        var count = 0
        var sawUser = false
        // state.json 若含工作目录则取用
        var cwd = ""
        let statePath = (path as NSString).deletingLastPathComponent + "/state.json"
        if let sd = fm.contents(atPath: statePath),
           let s = try? JSONSerialization.jsonObject(with: sd) as? [String: Any] {
            cwd = (s["cwd"] as? String) ?? (s["workingDirectory"] as? String) ?? ""
        }
        for raw in String(decoding: data, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: true) {
            guard let d = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] else { continue }
            let role = d["role"] as? String ?? ""
            guard role == "user" || role == "assistant" else { continue }   // 跳过 _system_prompt/_checkpoint/_usage
            count += 1
            if !sawUser, role == "user" {
                let text = messageText(d["content"])
                if !text.isEmpty {
                    sawUser = true
                    title = String(text.prefix(100))
                }
            }
        }
        guard sawUser else { return nil }   // 只有 system prompt 的空会话跳过
        let mtime = (attrs[.modificationDate] as? Date) ?? Date()
        return HistorySession(id: path, source: .kimi, sessionID: sessionID, filePath: path,
                              cwd: cwd, startedAt: (attrs[.creationDate] as? Date) ?? mtime, updatedAt: mtime,
                              sizeBytes: size, messageCount: count, title: title, displayTitle: nil)
    }

    // ── OpenCode: ~/.local/share/opencode/opencode.db (SQLite) ──

    private static func scanOpencode() -> [HistorySession] {
        guard FileManager.default.fileExists(atPath: opencodeDB) else { return [] }
        var out: [HistorySession] = []
        // V2：session_v2 + session_message（2026-10 起 V2 只写新表）
        var countsV2: [String: Int] = [:]
        opencodeQuery("SELECT session_id, COUNT(*) FROM session_message WHERE type IN ('user','assistant') GROUP BY session_id") { s in
            countsV2[colText(s, 0)] = Int(colInt(s, 1))
        }
        opencodeQuery("SELECT id, directory, title, time_created, time_updated FROM session_v2 WHERE time_archived IS NULL") { s in
            let id = colText(s, 0)
            let created = dateFromUnix(colInt(s, 3))
            let updated = dateFromUnix(colInt(s, 4))
            let title = colText(s, 2)
            out.append(HistorySession(id: "opencode2://\(id)", source: .opencode, sessionID: id,
                                      filePath: "opencode2://\(id)", cwd: colText(s, 1),
                                      startedAt: created, updatedAt: updated, sizeBytes: 0,
                                      messageCount: countsV2[id] ?? 0, title: title, displayTitle: title))
        }
        // V1 旧会话（旧 session/message/part 表仍留在库里）
        var counts: [String: Int] = [:]
        opencodeQuery("SELECT session_id, COUNT(*) FROM message GROUP BY session_id") { s in
            counts[colText(s, 0)] = Int(colInt(s, 1))
        }
        opencodeQuery("SELECT id, directory, title, time_created, time_updated FROM session WHERE time_archived IS NULL") { s in
            let id = colText(s, 0)
            let created = dateFromUnix(colInt(s, 3))
            let updated = dateFromUnix(colInt(s, 4))
            let title = colText(s, 2)
            out.append(HistorySession(id: "opencode://\(id)", source: .opencode, sessionID: id,
                                      filePath: "opencode://\(id)", cwd: colText(s, 1),
                                      startedAt: created, updatedAt: updated, sizeBytes: 0,
                                      messageCount: counts[id] ?? 0, title: title, displayTitle: title))
        }
        return out
    }

    /// OpenCode 只读查询（WAL 模式允许与运行中的 opencode 并发读）
    private static func opencodeQuery(_ sql: String, bind: [String] = [], row: (OpaquePointer) -> Void) {
        var db: OpaquePointer?
        guard sqlite3_open_v2(opencodeDB, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, db != nil else {
            if let db { sqlite3_close(db) }
            return
        }
        defer { sqlite3_close(db) }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, stmt != nil else { return }
        defer { sqlite3_finalize(stmt) }
        for (i, v) in bind.enumerated() {
            sqlite3_bind_text(stmt, Int32(i + 1), v, -1, nil)
        }
        while sqlite3_step(stmt) == SQLITE_ROW {
            row(stmt!)
        }
    }

    private static func colText(_ stmt: OpaquePointer, _ i: Int32) -> String {
        guard let c = sqlite3_column_text(stmt, i) else { return "" }
        return String(cString: c)
    }

    private static func colInt(_ stmt: OpaquePointer, _ i: Int32) -> Int64 {
        sqlite3_column_int64(stmt, i)
    }

    private static func dateFromUnix(_ v: Int64) -> Date {
        if v > 10_000_000_000 { return Date(timeIntervalSince1970: Double(v) / 1000) }   // ms
        return Date(timeIntervalSince1970: Double(v))                                    // s
    }

    /// 完整解析会话详情（消息气泡）
    static func loadMessages(_ session: HistorySession) -> [HistoryMessage] {
        if session.source == .opencode { return loadOpencodeMessages(session) }
        guard let data = readCapped(session.filePath, maxParseBytes) else { return [] }
        var out: [HistoryMessage] = []
        var idx = 0
        for raw in String(decoding: data, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: true) {
            defer { idx += 1 }
            guard let d = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] else { continue }
            let ts = dateFrom(d["timestamp"] as? String)
            switch session.source {
            case .claude:
                let type = d["type"] as? String ?? ""
                guard let msg = d["message"] as? [String: Any] else { continue }
                let role = (msg["role"] as? String) ?? type
                let text = messageText(msg["content"])
                if !text.isEmpty { out.append(HistoryMessage(id: idx, role: role, text: text, timestamp: ts, isToolCall: false)) }
            case .codex:
                guard d["type"] as? String == "response_item" else { continue }
                let payload = d["payload"] as? [String: Any] ?? [:]
                let ptype = payload["type"] as? String ?? ""
                if ptype == "message" {
                    let role = payload["role"] as? String ?? "assistant"
                    let text = contentText(payload["content"])
                    if !text.isEmpty { out.append(HistoryMessage(id: idx, role: role, text: text, timestamp: ts, isToolCall: false)) }
                } else if ptype == "reasoning" {
                    let text = contentText(payload["summary"])
                    if !text.isEmpty { out.append(HistoryMessage(id: idx, role: "reasoning", text: text, timestamp: ts, isToolCall: true)) }
                } else if ptype.hasSuffix("_tool_call") {
                    let text = String(describing: payload["input"] ?? payload["action"] ?? "").prefix(500)
                    out.append(HistoryMessage(id: idx, role: "tool", text: String(text), timestamp: ts, isToolCall: true))
                }
            case .grok:
                let type = d["type"] as? String ?? ""
                if type == "user" || type == "assistant" {
                    let text = messageText(d["content"])
                    if !text.isEmpty, !text.hasPrefix("<user_info>"), !text.hasPrefix("<system") {
                        out.append(HistoryMessage(id: idx, role: type, text: text, timestamp: ts, isToolCall: false))
                    }
                } else if type == "reasoning" {
                    let text = messageText(d["content"])
                    if !text.isEmpty { out.append(HistoryMessage(id: idx, role: "reasoning", text: text, timestamp: ts, isToolCall: true)) }
                } else if type == "backend_tool_call" || type == "tool_result" {
                    let text = messageText(d["content"])
                    out.append(HistoryMessage(id: idx, role: "tool", text: String(text.prefix(500)), timestamp: ts, isToolCall: true))
                }
            case .kimi:
                let role = d["role"] as? String ?? ""
                guard role == "user" || role == "assistant" else { continue }
                let text = messageText(d["content"])
                if !text.isEmpty { out.append(HistoryMessage(id: idx, role: role, text: text, timestamp: ts, isToolCall: false)) }
            case .opencode:
                break   // SQLite 源在 loadOpencodeMessages 处理
            }
        }
        return out
    }

    /// OpenCode 详情：V2 走 session_message（文本在 data.content[] / data.text），V1 走 message×part 两级 JSON
    private static func loadOpencodeMessages(_ session: HistorySession) -> [HistoryMessage] {
        guard FileManager.default.fileExists(atPath: opencodeDB) else { return [] }
        if session.id.hasPrefix("opencode2://") { return loadOpencodeV2Messages(session.sessionID) }
        var out: [HistoryMessage] = []
        var idx = 0
        opencodeQuery("SELECT m.data, p.data FROM part p JOIN message m ON p.message_id = m.id WHERE p.session_id = ? ORDER BY p.time_created",
                      bind: [session.sessionID]) { s in
            let role = ((try? JSONSerialization.jsonObject(with: Data(colText(s, 0).utf8)) as? [String: Any])? ["role"] as? String) ?? "assistant"
            guard let pd = try? JSONSerialization.jsonObject(with: Data(colText(s, 1).utf8)) as? [String: Any] else { return }
            appendOpencodePart(pd, role: role, out: &out, idx: &idx)
        }
        return out
    }

    /// V2：session_message 按 seq 排序，只取 user/assistant 两种气泡
    private static func loadOpencodeV2Messages(_ sid: String) -> [HistoryMessage] {
        var out: [HistoryMessage] = []
        var idx = 0
        opencodeQuery("SELECT type, data FROM session_message WHERE session_id = ? AND type IN ('user','assistant') ORDER BY seq",
                      bind: [sid]) { s in
            let type = colText(s, 0)
            guard let d = try? JSONSerialization.jsonObject(with: Data(colText(s, 1).utf8)) as? [String: Any] else { return }
            if type == "user" {
                // data.text 是 string 或 part[]
                if let t = d["text"] as? String, !t.isEmpty {
                    out.append(HistoryMessage(id: idx, role: "user", text: t, timestamp: nil, isToolCall: false))
                    idx += 1
                } else if let parts = d["text"] as? [[String: Any]] {
                    for pd in parts { appendOpencodePart(pd, role: "user", out: &out, idx: &idx) }
                }
            } else if let parts = d["content"] as? [[String: Any]] {
                for pd in parts { appendOpencodePart(pd, role: "assistant", out: &out, idx: &idx) }
            }
        }
        return out
    }

    /// part JSON → 气泡（V1 的 part.data 与 V2 的 content[] 同构：text/reasoning/tool）
    private static func appendOpencodePart(_ pd: [String: Any], role: String, out: inout [HistoryMessage], idx: inout Int) {
        let ptype = pd["type"] as? String ?? ""
        if ptype == "text", let text = pd["text"] as? String, !text.isEmpty {
            out.append(HistoryMessage(id: idx, role: role, text: text, timestamp: nil, isToolCall: false))
            idx += 1
        } else if ptype == "reasoning", let text = pd["text"] as? String, !text.isEmpty {
            out.append(HistoryMessage(id: idx, role: "reasoning", text: text, timestamp: nil, isToolCall: true))
            idx += 1
        } else if ptype == "tool" || ptype == "step-start" {
            let text = String(describing: pd["tool"] ?? pd["state"] ?? "").prefix(500)
            out.append(HistoryMessage(id: idx, role: "tool", text: String(text), timestamp: nil, isToolCall: true))
            idx += 1
        }
    }

    // ── helpers ──

    private static func readCapped(_ path: String, _ cap: Int) -> Data? {
        guard let fh = try? FileHandle(forReadingFrom: URL(fileURLWithPath: path)) else { return nil }
        defer { try? fh.close() }
        return try? fh.read(upToCount: cap)
    }

    /// Claude message.content：string 或 [{type:text,text}]
    private static func messageText(_ content: Any?) -> String {
        if let s = content as? String { return s }
        return contentText(content)
    }

    /// [{type: input_text/output_text/text, text}]
    private static func contentText(_ content: Any?) -> String {
        guard let arr = content as? [[String: Any]] else { return "" }
        return arr.compactMap { $0["text"] as? String }.joined(separator: "\n")
    }

    private static func dateFrom(_ s: Any?) -> Date {
        guard let s = s as? String else { return Date(timeIntervalSince1970: 0) }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s) ?? Date(timeIntervalSince1970: 0)
    }
}

// MARK: - Store（MainActor）

@MainActor
final class HistoryStore: ObservableObject {
    @Published var sessions: [HistorySession] = []
    @Published var isScanning = false
    @Published private(set) var favorites: Set<String> = []
    @Published var messageCache: [String: [HistoryMessage]] = [:]   // filePath → 详情

    private let favoritesPath = HookInstaller.baseDir + "/history-favorites.json"
    private var lastScanAt: Date = .distantPast
    private var cacheOrder: [String] = []

    init() {
        if let data = FileManager.default.contents(atPath: favoritesPath),
           let arr = try? JSONDecoder().decode([String].self, from: data) {
            favorites = Set(arr)
        }
        Task.detached(priority: .utility) { [weak self] in await self?.refresh() }
    }

    /// 刷新（8s 内的重复调用直接跳过）
    func refresh() async {
        guard !isScanning, Date().timeIntervalSince(lastScanAt) > 8 else { return }
        isScanning = true
        let found = await Task.detached(priority: .utility) { HistoryParser.scanAll() }.value
        sessions = found
        lastScanAt = Date()
        isScanning = false
    }

    func isFavorite(_ s: HistorySession) -> Bool { favorites.contains(s.id) }

    func toggleFavorite(_ s: HistorySession) {
        if favorites.contains(s.id) { favorites.remove(s.id) } else { favorites.insert(s.id) }
        let arr = Array(favorites)
        if let data = try? JSONEncoder().encode(arr) {
            try? data.write(to: URL(fileURLWithPath: favoritesPath))
        }
    }

    /// 详情加载（带缓存）
    func messages(for s: HistorySession) async -> [HistoryMessage] {
        if let cached = messageCache[s.id] {
            cacheOrder.removeAll { $0 == s.id }
            cacheOrder.append(s.id)
            return cached
        }
        let msgs = await Task.detached(priority: .userInitiated) { HistoryParser.loadMessages(s) }.value
        cacheOrder.removeAll { $0 == s.id }
        cacheOrder.append(s.id)
        while cacheOrder.count > 3 {
            messageCache.removeValue(forKey: cacheOrder.removeFirst())
        }
        messageCache[s.id] = msgs
        return msgs
    }
}
