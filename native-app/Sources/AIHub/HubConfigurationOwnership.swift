import Foundation

/// Configuration ownership is separate from task permissions. These guards
/// protect shared client configuration; they do not grant an Agent file access.
enum HubConfigurationOwnership {
    enum Owner: String { case hub, magpie, external }

    /// Hub's private state and its existing hook scripts/spool are writable.
    static let hubOwnedRelativeRoots = [
        ".aihub", "Library/Application Support/AIHub", "Library/Application Support/AIHubPreview"
    ]

    /// Magpie owns cross-client Provider/MCP/Prompt/Skill configuration.
    /// Legacy CC Switch roots remain protected for archived compatibility.
    /// Entire client roots are protected against Hub writes, including paths
    /// that do not yet exist. Snapshot coverage below omits session/runtime data.
    static let protectedRelativeRoots = [
        ".config/magpie",
        ".cc-switch", ".config/cc-switch", "Library/Application Support/com.ccswitch.desktop",
        "Library/Application Support/CC Switch", "Library/Application Support/CCSwitch",
        ".agents/skills", ".agents/prompts", ".agents/mcp.json", ".agents/providers.json",
        ".claude", ".claude.json", ".codex", ".kimi", ".config/kimi",
        ".opencode", ".config/opencode", ".config/claude", ".config/codex",
        ".openclaw", ".hermes", ".gemini", ".qoder", ".zcode", ".config/zcode", ".pi"
    ]

    static let sharedSkillRelativeRoots = [
        ".config/magpie/library/skills",
        ".agents/skills", ".codex/skills", ".claude/skills", ".kimi/skills",
        ".config/opencode/skills", ".config/opencode/skill", ".opencode/skills",
        ".openclaw/skills", ".hermes/skills", ".gemini/skills", ".qoder/skills",
        ".zcode/skills", ".pi/agent/skills"
    ]

    /// File content is hashed, never printed or copied into Hub state. Magpie
    /// settings and legacy CC Switch database WAL contain committed configuration;
    /// shared-memory, logs, backups and ephemeral runtime state are excluded.
    static let snapshotRelativeRoots = [
        ".config/magpie/providers.json", ".config/magpie/settings.json", ".config/magpie/logins.json",
        ".config/magpie/plugin-auth.json", ".config/magpie/plugins.json", ".config/magpie/plugins.yml",
        ".config/magpie/library.json", ".config/magpie/library/skills", ".config/magpie/library/prompts",
        ".cc-switch", ".config/cc-switch", "Library/Application Support/com.ccswitch.desktop",
        "Library/Application Support/CC Switch", "Library/Application Support/CCSwitch",
        ".agents/skills", ".agents/prompts", ".agents/mcp.json", ".agents/providers.json",
        ".codex/config.toml", ".codex/auth.json", ".codex/hooks.json", ".codex/settings.json",
        ".codex/mcp.json", ".codex/AGENTS.md", ".codex/skills", ".codex/prompts", ".codex/rules",
        ".claude.json", ".claude/settings.json", ".claude/settings.local.json", ".claude/mcp.json",
        ".claude/CLAUDE.md", ".claude/skills", ".claude/prompts", ".claude/commands", ".claude/agents",
        ".claude/rules", ".claude/plugins/installed_plugins.json", ".claude/plugins/known_marketplaces.json",
        ".kimi/config.toml", ".kimi/config.json", ".kimi/settings.json", ".kimi/mcp.json",
        ".kimi/AGENTS.md", ".kimi/skills", ".kimi/prompts", ".config/kimi",
        ".config/opencode", ".opencode", ".config/claude", ".config/codex",
        ".hermes/config.yaml", ".hermes/config.yml", ".hermes/auth.json", ".hermes/.env",
        ".hermes/skills", ".hermes/profiles",
        ".openclaw/openclaw.json", ".openclaw/config.json", ".openclaw/.env", ".openclaw/agents", ".openclaw/skills",
        ".gemini/settings.json", ".gemini/oauth_creds.json", ".gemini/.env", ".gemini/GEMINI.md", ".gemini/skills",
        ".qoder/settings.json", ".qoder/mcp.json", ".qoder/skills", ".qoder/rules", ".qoder/prompts",
        ".qoder/commands", ".qoder/agents", ".qoder/plugins/installed_plugins.json", ".qoder/plugins/installed_plugins_v2.json",
        ".zcode/AGENTS.md", ".zcode/skills", ".zcode/prompts", ".zcode/rules", ".zcode/cli/config.json", ".zcode/cli/agents",
        ".zcode/v2", ".config/zcode", ".pi/agent/settings.json", ".pi/agent/auth.json",
        ".pi/agent/models.json", ".pi/agent/skills", ".pi/agent/prompts"
    ]

    static func owner(of url: URL, home: URL = FileManager.default.homeDirectoryForCurrentUser) -> Owner {
        let keys = pathKeys(url)
        if protectedRoots(home: home).contains(where: { root in keys.contains(where: { contains(root, $0) }) }) {
            return .magpie
        }
        let ownRoots = hubOwnedRelativeRoots.flatMap { pathKeys(home.appendingPathComponent($0)) }
        if ownRoots.contains(where: { root in keys.contains(where: { contains(root, $0) }) }) { return .hub }
        return .external
    }

    /// Guards all protected lexical paths and their resolved destinations.
    /// Unrelated temporary fixture directories remain usable by regression tests.
    static func requireHubWrite(to url: URL, home: URL = FileManager.default.homeDirectoryForCurrentUser) throws {
        guard url.isFileURL else { throw OwnershipError.invalidDestination }
        guard owner(of: url, home: home) != .magpie else { throw OwnershipError.sharedConfigurationReadOnly }
    }

    static func excludedFromSnapshot(relativePath: String) -> Bool {
        let components = relativePath.split(separator: "/").map { $0.lowercased() }
        var directories: Set<String> = [
            "log", "logs", "backup", "backups", ".backups", "cache", "caches", ".cache", "tmp", "temp", ".tmp",
            "sessions", "session", "history", "histories", "debug", "telemetry", "statsig", "node_modules",
            "projects", "shell-snapshots", "file-history", "paste-cache", "browser", "webcache", "code cache",
            "gpucache", "dawncache", "shadercache", "local storage", "session storage", "indexeddb",
            "runtime", "bots-runtime-locks", "checkpoints", "crash", "visualizations"
        ]
        if components.contains("skills") || components.contains("skill") {
            // A skill itself can be named history/projects/runtime. Only omit
            // its build/cache/log/backup artifacts, not its source directory.
            directories.subtract(["sessions", "session", "history", "histories", "projects", "runtime", "checkpoints", "crash", "visualizations"])
        }
        if components.dropLast().contains(where: directories.contains) { return true }
        guard let name = components.last else { return false }
        if directories.contains(name) { return true }
        if ["live-state.json", "codex-login-history.json", "codex-catalog-history.json", "stats-cache.json", ".ds_store"].contains(name) { return true }
        if relativePath.lowercased().hasPrefix(".zcode/v2/") && (name.hasPrefix("bot-state.") || name.hasPrefix("bots-model-cache.")
            || name.hasPrefix("tasks-index.sqlite") || name == "telemetry-state.json" || name == "coding-plan-cache.json" || name == "onboarding-record.json") { return true }
        if name == "lock" || name.hasPrefix("singleton") || name.hasPrefix("._") { return true }
        return name.hasSuffix(".log") || name.hasSuffix(".lock") || name.hasSuffix(".pid")
            || name.hasSuffix("-shm") || name.hasSuffix(".tmp") || name.hasSuffix(".bak")
            || name.contains(".bak.") || name.contains(".backup.") || name.hasSuffix("~")
    }

    private static func protectedRoots(home: URL) -> [String] {
        var roots = protectedRelativeRoots.flatMap { pathKeys(home.appendingPathComponent($0)) }
        // Shared skills often alias plugin/package directories outside the
        // client root. Protect those actual sources as well as their aliases.
        for relative in sharedSkillRelativeRoots {
            let directory = home.appendingPathComponent(relative)
            for entry in (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isSymbolicLinkKey])) ?? [] {
                if (try? entry.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true {
                    roots.append(contentsOf: pathKeys(entry))
                }
            }
        }
        return Array(Set(roots))
    }

    private static func pathKeys(_ url: URL) -> [String] {
        [url.standardizedFileURL.path, url.resolvingSymlinksInPath().standardizedFileURL.path]
    }
    private static func contains(_ root: String, _ candidate: String) -> Bool {
        // Conservative case folding also covers the default case-insensitive
        // macOS volume when a caller uses a different spelling of a directory.
        let root = root.lowercased(), candidate = candidate.lowercased()
        return candidate == root || candidate.hasPrefix(root.hasSuffix("/") ? root : root + "/")
    }

    enum OwnershipError: LocalizedError {
        case invalidDestination, sharedConfigurationReadOnly
        var errorDescription: String? {
            switch self {
            case .invalidDestination: return "Hub 配置只能写入本地文件。"
            case .sharedConfigurationReadOnly: return "这是 Magpie 管辖的共享配置或 Skill 来源，Hub 仅可读取；请通过 Magpie 管理。"
            }
        }
    }
}
