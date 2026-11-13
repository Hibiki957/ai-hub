import CryptoKit
import Foundation

/// This binary is also the snapshot/verify implementation used by the shell
/// wrapper. Manifests contain only relative paths and SHA-256 digests.
@main
struct ConfigurationOwnershipRegression {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    struct Entry: Codable, Equatable { let path: String; let sha256: String }

    static func main() {
        do {
            var arguments = Array(CommandLine.arguments.dropFirst())
            var home = FileManager.default.homeDirectoryForCurrentUser
            if let index = arguments.firstIndex(of: "--root") {
                guard index + 1 < arguments.count else { throw Failure(message: "--root needs a home-directory fixture path") }
                home = URL(fileURLWithPath: arguments[index + 1], isDirectory: true).standardizedFileURL
                arguments.removeSubrange(index...(index + 1))
            }
            if arguments.isEmpty || arguments == ["self-test"] { try selfTest(); return }
            guard arguments.count == 2 else { throw Failure(message: "Expected snapshot MANIFEST or verify MANIFEST [--root HOME]") }
            let manifest = URL(fileURLWithPath: arguments[1]).standardizedFileURL
            switch arguments[0] {
            case "snapshot":
                try HubConfigurationOwnership.requireHubWrite(to: manifest, home: home)
                let entries = try snapshot(home: home)
                let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                try encoder.encode(entries).write(to: manifest, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: manifest.path)
                print("PASS: configuration snapshot contains \(entries.count) paths and SHA-256 digests only")
            case "verify":
                let previous = try JSONDecoder().decode([Entry].self, from: Data(contentsOf: manifest))
                try validate(previous)
                let current = try snapshot(home: home)
                let changes = differences(previous, current)
                guard changes.isEmpty else {
                    // A different process may have changed these files during
                    // the command. Detection does not attribute the writer.
                    for change in changes.prefix(100) { FileHandle.standardError.write(Data((change + "\n").utf8)) }
                    throw Failure(message: "Protected configuration changed (\(changes.count) paths). This detects external state changes; it does not establish that Hub wrote them.")
                }
                print("PASS: protected configuration SHA-256, additions and deletions are unchanged (\(current.count) paths)")
            default: throw Failure(message: "Unknown configuration ownership action")
            }
        } catch {
            FileHandle.standardError.write(Data(("FAIL: " + error.localizedDescription + "\n").utf8))
            exit(1)
        }
    }

    static func snapshot(home: URL) throws -> [Entry] {
        let fm = FileManager.default
        var entries: [String: String] = [:]
        var visited = Set<String>()
        func visit(_ url: URL, relative: String, ancestors: Set<String>) throws {
            guard !HubConfigurationOwnership.excludedFromSnapshot(relativePath: relative), visited.insert(relative).inserted else { return }
            let attributes: [FileAttributeKey: Any]
            do { attributes = try fm.attributesOfItem(atPath: url.path) }
            catch let error as NSError {
                if error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError { return }
                if error.domain == NSPOSIXErrorDomain && error.code == 2 { return }
                throw Failure(message: "Cannot inspect protected path: " + relative)
            }
            let type = attributes[.type] as? FileAttributeType
            if type == .typeSymbolicLink {
                let target = try fm.destinationOfSymbolicLink(atPath: url.path)
                var digest = SHA256(); digest.update(data: Data(("symlink\0" + target + "\0").utf8))
                var isDirectory: ObjCBool = false
                if fm.fileExists(atPath: url.path, isDirectory: &isDirectory) {
                    if !isDirectory.boolValue { try updateDigest(&digest, from: url, relative: relative) }
                }
                entries[relative] = hex(digest.finalize())
                if isDirectory.boolValue { try descend(url, relative: relative, ancestors: ancestors) }
            } else if type == .typeDirectory {
                try descend(url, relative: relative, ancestors: ancestors)
            } else if type == .typeRegular {
                var digest = SHA256(); try updateDigest(&digest, from: url, relative: relative)
                entries[relative] = hex(digest.finalize())
            }
        }
        func descend(_ url: URL, relative: String, ancestors: Set<String>) throws {
            let canonical = url.resolvingSymlinksInPath().standardizedFileURL.path
            guard !ancestors.contains(canonical) else { return }
            var next = ancestors; next.insert(canonical)
            let children: [URL]
            do { children = try fm.contentsOfDirectory(atPath: url.path).map { url.appendingPathComponent($0) } }
            catch let error as NSError { throw Failure(message: "Cannot enumerate protected path: " + relative + " (" + error.domain + ":" + String(error.code) + ")") }
            for child in children.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                try visit(child, relative: relative + "/" + child.lastPathComponent, ancestors: next)
            }
        }
        for relative in HubConfigurationOwnership.snapshotRelativeRoots {
            try visit(home.appendingPathComponent(relative), relative: relative, ancestors: [])
        }
        return entries.map { Entry(path: $0.key, sha256: $0.value) }.sorted { $0.path < $1.path }
    }

    static func updateDigest(_ digest: inout SHA256, from file: URL, relative: String) throws {
        do {
            let handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }
            while let bytes = try handle.read(upToCount: 65536), !bytes.isEmpty { digest.update(data: bytes) }
        } catch { throw Failure(message: "Cannot hash protected path: " + relative) }
    }
    static func hex<D: Sequence>(_ digest: D) -> String where D.Element == UInt8 {
        digest.map { String(format: "%02x", $0) }.joined()
    }
    static func validate(_ entries: [Entry]) throws {
        guard Set(entries.map(\.path)).count == entries.count,
              entries.allSatisfy({ !$0.path.isEmpty && !$0.path.hasPrefix("/") && !$0.path.split(separator: "/").contains("..")
                  && $0.sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }) else {
            throw Failure(message: "Invalid configuration hash manifest")
        }
    }
    static func differences(_ before: [Entry], _ after: [Entry]) -> [String] {
        let old = Dictionary(before.map { ($0.path, $0.sha256) }, uniquingKeysWith: { first, _ in first })
        let new = Dictionary(after.map { ($0.path, $0.sha256) }, uniquingKeysWith: { first, _ in first })
        return Set(old.keys).union(new.keys).sorted().compactMap { path in
            if old[path] == nil { return "ADDED: " + path }
            if new[path] == nil { return "DELETED: " + path }
            return old[path] == new[path] ? nil : "CHANGED: " + path
        }
    }

    static func selfTest() throws {
        var checks = 0
        func check(_ condition: @autoclosure () throws -> Bool, _ label: String) throws {
            guard try condition() else { throw Failure(message: label) }; checks += 1
        }
        func reject(_ label: String, _ operation: () throws -> Void) throws {
            var rejected = false; do { try operation() } catch { rejected = true }
            try check(rejected, label)
        }
        let fm = FileManager.default
        let fixture = fm.temporaryDirectory.appendingPathComponent("aihub-config-ownership-" + UUID().uuidString)
        let home = fixture.appendingPathComponent("fixture-home")
        try fm.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: fixture) }
        func write(_ relative: String, _ value: String) throws -> URL {
            let file = home.appendingPathComponent(relative)
            try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(value.utf8).write(to: file); return file
        }
        for relative in HubConfigurationOwnership.protectedRelativeRoots {
            try reject("Protected configuration accepted: " + relative) {
                try HubConfigurationOwnership.requireHubWrite(to: home.appendingPathComponent(relative).appendingPathComponent("new-config.json"), home: home)
            }
        }
        for relative in [".aihub/hooks/claude.sh", ".aihub/spool/event.json", "Library/Application Support/AIHub/Control/control-v1.json",
                         "Library/Application Support/AIHub/Control/mcp-v1.json", "Library/Application Support/AIHub/Management/scopes.json",
                         "Library/Application Support/AIHub/Workbench/workbench-v1.json", "Library/Application Support/AIHubPreview/Control/control-v1.json"] {
            let file = home.appendingPathComponent(relative)
            try HubConfigurationOwnership.requireHubWrite(to: file, home: home)
            try check(HubConfigurationOwnership.owner(of: file, home: home) == .hub, "Hub-owned destination misclassified")
        }
        try HubConfigurationOwnership.requireHubWrite(to: fixture.appendingPathComponent("private-test/scopes.json"), home: home)
        try check(HubConfigurationOwnership.owner(of: home.appendingPathComponent(".codex-other/settings.json"), home: home) == .external, "Path-prefix sibling falsely protected")
        try reject("Standardized traversal bypassed ownership") {
            try HubConfigurationOwnership.requireHubWrite(to: home.appendingPathComponent("Library/../.codex/config.toml"), home: home)
        }
        try reject("Case-insensitive macOS spelling bypassed ownership") {
            try HubConfigurationOwnership.requireHubWrite(to: home.appendingPathComponent(".CODEX/config.toml"), home: home)
        }
        try reject("Non-file destination accepted") { try HubConfigurationOwnership.requireHubWrite(to: URL(string: "https://example.invalid/config")!, home: home) }

        let config = try write(".codex/config.toml", "provider = 'FIXTURE_SECRET_NOT_PRINTED'\n")
        let magpieProviders = try write(".config/magpie/providers.json", "{\"provider\":\"FIXTURE_SECRET_NOT_PRINTED\"}")
        try check(HubConfigurationOwnership.owner(of: magpieProviders, home: home) == .magpie, "Magpie configuration owner misclassified")
        try reject("Magpie lexical traversal bypassed ownership") {
            try HubConfigurationOwnership.requireHubWrite(to: home.appendingPathComponent(".aihub/../.config/magpie/providers.json"), home: home)
        }
        try reject("Magpie case variation bypassed ownership") {
            try HubConfigurationOwnership.requireHubWrite(to: home.appendingPathComponent(".CONFIG/MAGPIE/providers.json"), home: home)
        }
        let ccDatabase = try write(".cc-switch/cc-switch.db", "fixture database bytes")
        let skill = try write(".agents/skills/example/SKILL.md", "# Fixture skill\n")
        _ = try write(".cc-switch/settings.json", "{}")
        _ = try write("Library/Application Support/com.ccswitch.desktop/settings.json", "{}")
        _ = try write(".cc-switch/cc-switch.db-wal", "fixture committed WAL data")
        _ = try write(".agents/skills/history/SKILL.md", "# Source named history is not session history")
        let bridge = home.appendingPathComponent("Library/Application Support/AIHub/Management")
        try fm.createDirectory(at: bridge.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fm.createSymbolicLink(at: bridge, withDestinationURL: config.deletingLastPathComponent())
        let externalBefore = try Data(contentsOf: config)
        try reject("Hub-directory symlink bypassed ownership") {
            let target = bridge.appendingPathComponent("config.toml")
            try HubConfigurationOwnership.requireHubWrite(to: target, home: home)
            try Data("must not write".utf8).write(to: target)
        }
        try check(try Data(contentsOf: config) == externalBefore, "Protected file changed after rejected write")
        let directAlias = home.appendingPathComponent("safe-alias.json")
        try fm.createSymbolicLink(at: directAlias, withDestinationURL: config)
        try reject("File symlink bypassed ownership") { try HubConfigurationOwnership.requireHubWrite(to: directAlias, home: home) }
        let externalSkill = fixture.appendingPathComponent("plugin-package")
        try fm.createDirectory(at: externalSkill, withIntermediateDirectories: true)
        try Data("# External skill fixture".utf8).write(to: externalSkill.appendingPathComponent("SKILL.md"))
        let skillAlias = home.appendingPathComponent(".agents/skills/plugin-alias")
        try fm.createSymbolicLink(at: skillAlias, withDestinationURL: externalSkill)
        try reject("Canonical external Skill source was writable") {
            try HubConfigurationOwnership.requireHubWrite(to: externalSkill.appendingPathComponent("SKILL.md"), home: home)
        }
        // A directory symlink loop must terminate without losing valid entries.
        try fm.createSymbolicLink(at: externalSkill.appendingPathComponent("loop"), withDestinationURL: externalSkill)
        let before = try snapshot(home: home)
        try validate(before)
        try check(before.contains { $0.path == ".codex/config.toml" }, "Provider configuration missing from manifest")
        try check(before.contains { $0.path == ".config/magpie/providers.json" }, "Magpie provider configuration missing from manifest")
        try check(before.contains { $0.path == ".cc-switch/cc-switch.db" }, "CC Switch database missing from manifest")
        try check(before.contains { $0.path == ".cc-switch/cc-switch.db-wal" }, "CC Switch WAL missing from manifest")
        try check(before.contains { $0.path == ".agents/skills/plugin-alias/SKILL.md" }, "Symlink Skill content missing from manifest")
        try check(before.contains { $0.path == ".agents/skills/history/SKILL.md" }, "Skill named history was incorrectly excluded")
        try check(String(decoding: try JSONEncoder().encode(before), as: UTF8.self).contains("FIXTURE_SECRET_NOT_PRINTED") == false, "Manifest exposed fixture content")
        for relative in [".config/magpie/usage.jsonl", ".config/magpie/quotas.json", ".config/magpie/backups/settings.json",
                         ".cc-switch/logs/trace.log", ".cc-switch/backups/settings.json", ".cc-switch/cc-switch.db.bak.20261020",
                         ".cc-switch/cc-switch.db-shm", ".cc-switch/live-state.json", ".codex/sessions/run.jsonl", ".zcode/v2/bot-state.v3.json",
                         ".zcode/v2/tasks-index.sqlite-wal", ".zcode/v2/bots-runtime-locks/lock.json",
                         "Library/Application Support/AIHub/Control/control-v1.json", ".aihub/spool/message.json"] {
            _ = try write(relative, "ignored runtime/backup fixture")
        }
        try check(try snapshot(home: home) == before, "Volatile, backup or Hub-owned state polluted protected snapshot")
        _ = try write(".claude/settings.json", "new fixture settings")
        let added = try snapshot(home: home)
        try check(differences(before, added) == ["ADDED: .claude/settings.json"], "New shared configuration not detected")
        try Data("changed provider bytes".utf8).write(to: config)
        try check(differences(added, try snapshot(home: home)) == ["CHANGED: .codex/config.toml"], "Modified shared configuration not detected")
        try fm.removeItem(at: skill)
        try check(differences(added, try snapshot(home: home)).contains("DELETED: .agents/skills/example/SKILL.md"), "Deleted shared Skill not detected")
        try Data("changed database bytes".utf8).write(to: ccDatabase)
        try check(differences(added, try snapshot(home: home)).contains("CHANGED: .cc-switch/cc-switch.db"), "Database content mutation not detected")
        try Data("changed Magpie provider bytes".utf8).write(to: magpieProviders)
        try check(differences(added, try snapshot(home: home)).contains("CHANGED: .config/magpie/providers.json"), "Magpie provider mutation not detected")
        try Data("changed alias source".utf8).write(to: externalSkill.appendingPathComponent("SKILL.md"))
        try check(differences(added, try snapshot(home: home)).contains("CHANGED: .agents/skills/plugin-alias/SKILL.md"), "Canonical Skill source mutation not detected")
        try reject("Manifest with duplicate paths accepted") { try validate([Entry(path: "a", sha256: String(repeating: "0", count: 64)), Entry(path: "a", sha256: String(repeating: "0", count: 64))]) }
        try reject("Manifest with path traversal accepted") { try validate([Entry(path: "../outside", sha256: String(repeating: "0", count: 64))]) }
        try reject("Manifest with invalid digest accepted") { try validate([Entry(path: "config.json", sha256: "invalid")]) }
        print("PASS: \(checks) configuration ownership checks using isolated files and actual SHA-256; no user configuration changed")
    }
}
