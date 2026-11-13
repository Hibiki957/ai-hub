import Foundation
import UserNotifications

// MARK: - 事件与状态模型

/// Hook 事件（从 spool 文件解析而来）
struct HookEvent {
    let paneID: UUID
    let event: String          // hook_event_name：UserPromptSubmit / Notification / Stop / ...
    let payload: [String: Any] // 原始 stdin JSON（session_id / cwd / message ...）
}

/// spool 解析不访问文件或应用状态，便于独立验证 dispatcher 的文件名契约。
enum HookEventParser {
    static func paneID(from filename: String) -> UUID? {
        guard filename.hasSuffix(".json") else { return nil }
        let stem = filename.dropLast(5)
        // UUID 本身有四个连字符，不能用 split("-").first 截取。
        guard stem.count > 37,
              let paneID = UUID(uuidString: String(stem.prefix(36))),
              stem.dropFirst(36).first == "-" else { return nil }
        let suffix = stem.dropFirst(37).split(separator: "-", omittingEmptySubsequences: false)
        // 兼容旧 dispatcher 的 secs-rand，以及当前的 secs-rand-pid。
        guard (2...3).contains(suffix.count), suffix.allSatisfy({ part in
            !part.isEmpty && part.allSatisfy { $0 >= "0" && $0 <= "9" } && UInt64(part) != nil
        }) else { return nil }
        return paneID
    }

    static func parse(filename: String, data: Data) -> HookEvent? {
        guard let paneID = paneID(from: filename),
              let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let event = payload["hook_event_name"] as? String,
              !event.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return HookEvent(paneID: paneID, event: event, payload: payload)
    }
}

/// Tab 级 agent 状态
enum TabStatus: Equatable {
    case idle      // 就绪/无会话
    case running   // agent 执行中
    case waiting   // 等待审批/输入
    case done      // 回合完成
}

// MARK: - Hook 安装器（非隔离，纯文件操作）

enum HookInstaller {
    static let baseDir = NSHomeDirectory() + "/.aihub"
    static let scriptPath = baseDir + "/hook-dispatch.sh"
    static let resumeScriptPath = baseDir + "/resume.sh"
    static let spoolDir = baseDir + "/spool"
    static let scriptMarker = "/.aihub/hook-dispatch.sh"

    /// 兼容旧 CLI 入口；共享配置受归属守卫保护，不再由 Hub 自动安装。
    static func installAll() {
        do {
            try installClaudeHooks()
            NSLog("[AIHub] claude hooks installed")
        } catch {
            NSLog("[AIHub] claude hook install failed: %@", error.localizedDescription)
        }
        do {
            try installCodexHooks()
            NSLog("[AIHub] codex hooks installed")
        } catch {
            NSLog("[AIHub] codex hook install failed: %@", error.localizedDescription)
        }
    }

    /// dispatcher 脚本：stdin JSON → spool 文件；env 提供 paneID + spool 目录
    static func ensureScript() {
        guard (try? HubConfigurationOwnership.requireHubWrite(to: URL(fileURLWithPath: baseDir))) != nil,
              (try? HubConfigurationOwnership.requireHubWrite(to: URL(fileURLWithPath: scriptPath))) != nil,
              (try? HubConfigurationOwnership.requireHubWrite(to: URL(fileURLWithPath: resumeScriptPath))) != nil else { return }
        try? FileManager.default.createDirectory(atPath: baseDir, withIntermediateDirectories: true)
        let dispatch = """
        #!/bin/bash
        # AI Hub Hook Bridge — hook 事件 JSON → spool 目录（env: AIHUB_PANE_ID / AIHUB_SPOOL）
        [ -n "$AIHUB_PANE_ID" ] && [ -n "$AIHUB_SPOOL" ] && [ -d "$AIHUB_SPOOL" ] || exit 0
        tmp=$(mktemp "$AIHUB_SPOOL/.tmp.XXXXXX") || exit 0
        cat > "$tmp"
        mv -f "$tmp" "$AIHUB_SPOOL/${AIHUB_PANE_ID}-$(date +%s)-$RANDOM-$$.json" 2>/dev/null || rm -f "$tmp"
        exit 0
        """
        try? dispatch.write(toFile: scriptPath, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scriptPath)
        // 历史恢复 wrapper：ghostty command 语义不赌 shell 解析，用 env 传命令（AIHUB_RESUME_CMD）
        let resume = """
        #!/bin/bash
        # AI Hub 恢复历史会话
        [ -n "$AIHUB_RESUME_CMD" ] || exec /bin/zsh -l
        eval "exec $AIHUB_RESUME_CMD"
        """
        try? resume.write(toFile: resumeScriptPath, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: resumeScriptPath)
    }

    // ── Claude Code 安装：settings.json 合并写入 ──

    static func installClaudeHooks() throws {
        let path = NSHomeDirectory() + "/.claude/settings.json"
        try HubConfigurationOwnership.requireHubWrite(to: URL(fileURLWithPath: path))
        let fm = FileManager.default
        var root: [String: Any]
        if fm.fileExists(atPath: path),
           let data = fm.contents(atPath: path),
           let obj = try? JSONSerialization.jsonObject(with: data),
           let dict = obj as? [String: Any] {
            root = dict
        } else {
            root = [:]
        }
        let events = ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "SessionEnd"]
        var hooks = (root["hooks"] as? [String: Any]) ?? [:]
        var changed = root["hooks"] == nil
        for event in events {
            var entries = (hooks[event] as? [[String: Any]]) ?? []
            let before = entries.count
            // 清掉旧版本 AIHub 注册项（幂等），保留用户自定义
            entries.removeAll { entry in
                let inner = entry["hooks"] as? [[String: Any]] ?? []
                return inner.contains { ($0["command"] as? String)?.contains(scriptMarker) == true }
            }
            entries.append(["hooks": [["type": "command", "command": scriptPath]]])
            hooks[event] = entries
            if before != entries.count - 1 { changed = true }
        }
        guard changed else { return }   // 已是最新 → 不动文件
        if fm.fileExists(atPath: path) {
            try? fm.copyItem(atPath: path, toPath: path + ".bak.aihub-" + timestamp())
        }
        root["hooks"] = hooks
        let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted])
        try data.write(to: URL(fileURLWithPath: path))
    }

    // ── Codex 安装：hooks.json + config.toml [features].hooks ──

    static func installCodexHooks() throws {
        let codexDir = NSHomeDirectory() + "/.codex"
        try HubConfigurationOwnership.requireHubWrite(to: URL(fileURLWithPath: codexDir + "/hooks.json"))
        let fm = FileManager.default
        guard fm.fileExists(atPath: codexDir) else { return }   // 无 codex 不装
        let hooksPath = codexDir + "/hooks.json"
        // 事件集（本机 codex 二进制确认）：PreToolUse / PermissionRequest / PostToolUse /
        // PreCompact / PostCompact / SessionStart / SessionEnd / SubagentStart / SubagentStop / Interrupt
        let events = ["SessionStart", "PermissionRequest", "SessionEnd", "SubagentStop"]
        var root: [String: Any] = [:]
        var existing = false
        if fm.fileExists(atPath: hooksPath),
           let data = fm.contents(atPath: hooksPath),
           let obj = try? JSONSerialization.jsonObject(with: data),
           let dict = obj as? [String: Any] {
            root = dict
            existing = true
        }
        var hooks = (root["hooks"] as? [String: Any]) ?? [:]
        var changed = !existing
        for event in events {
            var entries = (hooks[event] as? [[String: Any]]) ?? []
            let before = entries.count
            // 清旧注册项（嵌套形态：entry.hooks[].command 含 marker）
            entries.removeAll { entry in
                let inner = entry["hooks"] as? [[String: Any]] ?? []
                return inner.contains { ($0["command"] as? String)?.contains(scriptMarker) == true }
                    || ((entry["command"] as? String)?.contains(scriptMarker) == true)   // 旧扁平形态一并清
            }
            entries.append(["hooks": [["type": "command", "command": scriptPath]]])
            hooks[event] = entries
            if before != entries.count - 1 { changed = true }
        }
        if changed {
            if existing {
                try? fm.copyItem(atPath: hooksPath, toPath: hooksPath + ".bak.aihub-" + timestamp())
            }
            root["hooks"] = hooks
            let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted])
            try data.write(to: URL(fileURLWithPath: hooksPath))
        }
        try ensureCodexFeatureHooks(dir: codexDir)
    }

    /// config.toml 确保 [features] hooks = true（codex_hooks 已弃用，勿写；先备份）
    static func ensureCodexFeatureHooks(dir: String) throws {
        let path = dir + "/config.toml"
        try HubConfigurationOwnership.requireHubWrite(to: URL(fileURLWithPath: path))
        let fm = FileManager.default
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return }
        var lines = text.components(separatedBy: "\n")
        guard let secIdx = lines.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "[features]" }) else {
            // 无 [features] 节：追加新节
            try? fm.copyItem(atPath: path, toPath: path + ".bak.aihub-" + timestamp())
            lines.append("[features]")
            lines.append("hooks = true")
            try lines.joined(separator: "\n").write(toFile: path, atomically: true, encoding: .utf8)
            return
        }
        // 节边界：下一个 [ 开头行之前
        var endIdx = secIdx + 1
        while endIdx < lines.count, !lines[endIdx].trimmingCharacters(in: .whitespaces).hasPrefix("[") { endIdx += 1 }
        var hooksOK = false
        var deprecated = false
        for i in secIdx + 1..<endIdx {
            let t = lines[i].trimmingCharacters(in: .whitespaces)
            guard let eq = t.firstIndex(of: "=") else { continue }
            let key = String(t[..<eq].trimmingCharacters(in: .whitespaces))
            let val = String(t[t.index(after: eq)...].trimmingCharacters(in: .whitespaces))
            if key == "hooks" { hooksOK = val == "true" }
            if key == "codex_hooks" { deprecated = true; lines[i] = "" }
        }
        guard hooksOK || deprecated else {   // 无 hooks 键：插到节首
            try? fm.copyItem(atPath: path, toPath: path + ".bak.aihub-" + timestamp())
            lines.insert("hooks = true", at: secIdx + 1)
            try lines.joined(separator: "\n").write(toFile: path, atomically: true, encoding: .utf8)
            return
        }
        guard deprecated else { return }   // 已正确 → 不动文件
        try? fm.copyItem(atPath: path, toPath: path + ".bak.aihub-" + timestamp())
        if !hooksOK { lines.insert("hooks = true", at: secIdx + 1) }
        try lines.joined(separator: "\n").write(toFile: path, atomically: true, encoding: .utf8)
    }

    private static func timestamp() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd-HHmmss"
        return f.string(from: Date())
    }
}

// MARK: - Hook Bridge（spool 消费 + 状态衰减，MainActor）

@MainActor
final class HookBridge {
    /// 事件回调（AppModel 注入）
    var handler: ((HookEvent) -> Void)?

    private var dirSource: DispatchSourceFileSystemObject?
    private var sweepTimer: Timer?
    private var decayTimer: Timer?
    private var drainScheduled = false
    private let spoolDirectory: String

    init(spoolDirectory: String = HookInstaller.spoolDir) {
        self.spoolDirectory = spoolDirectory
    }

    func start() {
        try? FileManager.default.createDirectory(atPath: spoolDirectory, withIntermediateDirectories: true)
        HookInstaller.ensureScript()
        startSpoolWatch()
        startDecay()
        // 立即消费一次（承接 App 关闭期间积压的事件）
        Task { @MainActor in self.drainSpool() }
    }

    // ── spool 消费（事件驱动， vnode 监听目录变更）──

    private func startSpoolWatch() {
        let fd = open(spoolDirectory, O_EVTONLY)
        guard fd >= 0 else { return }
        let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: .write, queue: .main)
        src.setEventHandler { [weak self] in
            self?.scheduleDrain()
        }
        src.setCancelHandler { close(fd) }
        src.resume()
        dirSource = src
        // 低频兑底扫接：处理漏掉的事件 + tmp 清理，不再每秒轮询
        sweepTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.drainSpool() }
        }
    }

    /// 合并短时间内的多次目录变更事件（写端 tmp→rename 会连发）
    private func scheduleDrain() {
        guard !drainScheduled else { return }
        drainScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            self?.drainScheduled = false
            self?.drainSpool()
        }
    }

    func drainSpool() {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(atPath: spoolDirectory) else { return }
        let now = Date()
        for name in files.sorted() {
            let path = spoolDirectory + "/" + name
            if name.hasPrefix(".tmp.") {
                // 清理 >1h 的残留 .tmp（与事件同遍处理，不再二次枚举）
                if let attr = try? fm.attributesOfItem(atPath: path),
                   let date = attr[.modificationDate] as? Date,
                   now.timeIntervalSince(date) > 3600 {
                    try? fm.removeItem(atPath: path)
                }
                continue
            }
            guard name.hasSuffix(".json") else { continue }
            guard HookEventParser.paneID(from: name) != nil else {
                try? fm.removeItem(atPath: path)
                continue
            }
            guard let data = fm.contents(atPath: path) else { continue }
            let event = HookEventParser.parse(filename: name, data: data)
            try? fm.removeItem(atPath: path)
            guard let event else { continue }
            handler?(event)
        }
    }

    // ── 状态衰减：running 超 45 分钟无事件 → idle ──

    private func startDecay() {
        decayTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.decayStale() }
        }
    }

    private func decayStale() {
        guard let model = AppDelegate.model else { return }
        let now = Date()
        let store = model.tabStore
        for (tabID, status) in store.tabStatuses where status == .running {
            if let at = store.statusUpdatedAt[tabID], now.timeIntervalSince(at) > 45 * 60 {
                store.tabStatuses[tabID] = .idle
            }
        }
    }
}
