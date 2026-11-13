import Foundation

// SidebarStore's UI helpers only need this preview flag. Decode the real
// preference model without constructing AppModel, opening windows or saving it.
enum AppModel { static let isPreview = true }

@main
struct ToolCatalogRegression {
    struct Failure: Error, CustomStringConvertible { let description: String }
    struct Entry {
        let name: String
        let path: String
    }

    static func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        guard condition() else { throw Failure(description: message) }
        print("PASS: \(message)")
    }

    static func main() {
        do {
            guard CommandLine.arguments.count >= 2 else { throw Failure(description: "Expected catalog path") }
            let catalog = try ToolCatalog.load(from: URL(fileURLWithPath: CommandLine.arguments[1]))
            try testManifest(catalog)
            try testFixtures()
            try testAvailability()
            try testPreferences(catalog, file: CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : nil)
            print("ALL TOOL CATALOG REGRESSIONS PASSED")
        } catch {
            fputs("FAIL: \(error)\n", stderr)
            exit(1)
        }
    }

    static func testManifest(_ catalog: ToolCatalog) throws {
        let expectedPrimary = ["openclaw", "hermes", "zcode", "kimi", "opencode"]
        try check(catalog.primaryAgentIDs == expectedPrimary && catalog.primaryAgents.map(\.id) == expectedPrimary,
                  "manifest preserves the five primary agents and their order")
        try check(Set(catalog.cli.map(\.id)).count == catalog.cli.count
                  && Set(catalog.apps.map(\.id)).count == catalog.apps.count
                  && Set(catalog.agents.map(\.id)).count == catalog.agents.count,
                  "manifest has unique IDs within each launcher type")
        try check(catalog.cli.contains { $0.name == "openclaw" }
                  && catalog.cli.contains { $0.name == "claude" }
                  && catalog.cli.contains { $0.name == "codex" },
                  "OpenClaw CLI is available alongside existing Claude and Codex entries")
        try check(catalog.cli.first { $0.name == "pi" }?.command == NSHomeDirectory() + "/.local/bin/pi",
                  "Pi resolves to the current local entry instead of the removed nvm path")
        try check(catalog.apps.first { $0.name == "Qoder" }?.path == "/Applications/Qoder.app",
                  "Qoder keeps its preference key while using the installed application path")
        let addedApps = ["/Applications/DoubaoWork.app", "/Applications/Open Design.app", "/Applications/massCode.app"]
        try check(addedApps.allSatisfy { path in catalog.apps.contains { $0.path == path } },
                  "Doubao Work, Open Design and massCode are included with exact installed paths")
        try check(catalog.cli.allSatisfy { $0.command.hasPrefix("/") }
                  && catalog.apps.allSatisfy { $0.path.hasPrefix("/") },
                  "launcher paths are absolute after manifest loading")
        let dshBin = NSHomeDirectory() + "/.nvm/versions/node/v24.18.0/bin"
        try check(catalog.cli.first { $0.name == "dsh" }?.pathPrepend == [dshBin]
                  && catalog.cli.filter { !($0.pathPrepend ?? []).isEmpty }.map(\.name) == ["dsh"],
                  "only DSH TUI prepends its matching nvm installation")
        try check(catalog.pathEntries.first == NSHomeDirectory() + "/.local/bin"
                  && catalog.pathEntries.allSatisfy { $0.hasPrefix("/") },
                  "shared PATH preserves local-first priority with expanded absolute entries")
    }

    static func testFixtures() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("aihub-catalog-regression-\(UUID())")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        let command = root.appendingPathComponent("agent")
        let alias = root.appendingPathComponent("agent-alias")
        let app = root.appendingPathComponent("Agent.app")
        try Data("offline fixture".utf8).write(to: command)
        try fm.createSymbolicLink(at: alias, withDestinationURL: command)
        try fm.createDirectory(at: app, withIntermediateDirectories: true)
        let entries = [Entry(name: "My custom name", path: alias.path), Entry(name: "Built-in name", path: command.path)]
        let distinct = ToolCatalog.deduplicated(entries, path: { $0.path })
        try check(distinct.count == 1 && distinct.first?.name == "My custom name",
                  "real-path aliases collapse and the first custom name wins")
        try check(ToolCatalog.deduplicated([Entry(name: "Agent CLI", path: command.path), Entry(name: "Agent App", path: app.path)], path: { $0.path }).count == 2,
                  "different App and CLI surfaces are retained")
        let missing = [Entry(name: "First missing", path: root.appendingPathComponent("missing-one").path),
                       Entry(name: "Second missing", path: root.appendingPathComponent("missing-two").path)]
        try check(ToolCatalog.deduplicated(missing, path: { $0.path }).count == 2,
                  "unrelated missing paths are not merged")
        let secondInstallation = root.appendingPathComponent("second-installation")
        try Data("same package, independent installation".utf8).write(to: secondInstallation)
        try check(ToolCatalog.deduplicated([Entry(name: "DSH local", path: command.path), Entry(name: "DSH nvm", path: secondInstallation.path)], path: { $0.path }).count == 2,
                  "independent installations are retained even when they belong to the same product")

        var fixture: [String: Any] = [
            "schemaVersion": 1, "primaryAgentIDs": ["fixture"],
            "pathEntries": ["~/.local/bin"],
            "cli": [["id": "fixture-cli", "productID": "fixture", "name": "fixture", "title": "Fixture", "command": "~/.local/bin/fixture-agent", "pathPrepend": ["~/fixture-bin"]]],
            "apps": [["id": "fixture-app", "productID": "fixture", "name": "Fixture", "path": "~/Applications/Fixture.app"]],
            "agents": [["id": "fixture", "name": "Fixture", "subtitle": "Offline", "transport": "acp", "command": "~/.local/bin/fixture-agent", "args": []]],
            "web": [], "localServices": [],
        ]
        let fixtureURL = root.appendingPathComponent("catalog.json")
        try JSONSerialization.data(withJSONObject: fixture).write(to: fixtureURL)
        let loaded = try ToolCatalog.load(from: fixtureURL)
        try check(loaded.cli.first?.command == NSHomeDirectory() + "/.local/bin/fixture-agent"
                  && loaded.apps.first?.path == NSHomeDirectory() + "/Applications/Fixture.app"
                  && loaded.agents.first?.command == NSHomeDirectory() + "/.local/bin/fixture-agent"
                  && loaded.cli.first?.pathPrepend == [NSHomeDirectory() + "/fixture-bin"]
                  && loaded.pathEntries == [NSHomeDirectory() + "/.local/bin"],
                  "fixture tilde paths expand without executing or modifying launchers")
        fixture["schemaVersion"] = 2
        try assertRejected(fixture, at: fixtureURL, label: "unsupported schema is rejected instead of silently migrated")
        fixture["schemaVersion"] = 1
        fixture["primaryAgentIDs"] = ["missing"]
        try assertRejected(fixture, at: fixtureURL, label: "missing primary agent definition is rejected")
        fixture["primaryAgentIDs"] = ["fixture"]
        fixture["apps"] = [["id": "fixture-cli", "productID": "fixture", "name": "Fixture", "path": "~/Applications/Fixture.app"]]
        try assertRejected(fixture, at: fixtureURL, label: "duplicate launcher IDs across App and CLI are rejected")
    }

    static func assertRejected(_ object: [String: Any], at url: URL, label: String) throws {
        try JSONSerialization.data(withJSONObject: object).write(to: url)
        do {
            _ = try ToolCatalog.load(from: url)
        } catch {
            print("PASS: \(label)")
            return
        }
        throw Failure(description: label)
    }

    static func testAvailability() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("aihub-availability-\(UUID())")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        let command = root.appendingPathComponent("fixture")
        let alias = root.appendingPathComponent("alias")
        try Data("offline fixture only".utf8).write(to: command)
        try fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: command.path)
        try check(!ToolCatalog.isAvailableCommand(command.path), "non-executable residue is unavailable")
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: command.path)
        try fm.createSymbolicLink(at: alias, withDestinationURL: command)
        try check(ToolCatalog.isAvailableCommand(command.path) && ToolCatalog.isAvailableCommand(alias.path),
                  "regular executable and its symlink are available without being run")
        try check(!ToolCatalog.isAvailableCommand(root.path) && !ToolCatalog.isAvailableCommand("fixture --flag"),
                  "directories and shell expressions are not command launchers")
        try fm.removeItem(at: command)
        try check(!ToolCatalog.isAvailableCommand(command.path) && !ToolCatalog.isAvailableCommand(alias.path),
                  "deleted executables and dangling aliases disappear")
        let app = root.appendingPathComponent("Fixture.app")
        let contents = app.appendingPathComponent("Contents")
        try fm.createDirectory(at: contents.appendingPathComponent("MacOS"), withIntermediateDirectories: true)
        let plist = ["CFBundlePackageType": "APPL", "CFBundleExecutable": "Fixture", "CFBundleIdentifier": "com.example.aihub.availability"]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            .write(to: contents.appendingPathComponent("Info.plist"))
        try check(!ToolCatalog.isAvailableApp(app.path), "an app bundle with missing executable is unavailable")
        let executable = contents.appendingPathComponent("MacOS/Fixture")
        try Data("offline fixture only".utf8).write(to: executable)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        try check(ToolCatalog.isAvailableApp(app.path), "an installed app executable is available")
        try fm.removeItem(at: executable)
        try check(!ToolCatalog.isAvailableApp(app.path), "an uninstalled app executable is no longer available")
    }

    static func testPreferences(_ catalog: ToolCatalog, file: String?) throws {
        let fixture: [String: Any] = [
            "renames": ["pi": "My Pi", "Qoder": "My editor", "ZCode TUI": "My ZCode"],
            "hidden": ["Open Design"], "moves": ["OpenClaw": "Self hosted"],
            "orders": ["CLI 工具": ["ZCode TUI", "pi", "hermes"], "Apps": ["Qoder", "Hermes"]],
            "customCLI": [["name": "ZCode TUI", "path": "~/.local/bin/zcode-tui"]],
            "customApps": [["name": "My duplicate editor", "path": "/Applications/Qoder.app"]],
            "customPWAGroups": ["Self hosted"], "sectionOrder": ["CLI 工具", "Apps"],
            "sectionRenames": ["Apps": "My applications"], "colorOverrides": ["pi": "112233"],
        ]
        let fixtureData = try JSONSerialization.data(withJSONObject: fixture, options: [.sortedKeys])
        try assertPreferenceProjectionPreserved(fixtureData, catalog: catalog, label: "complete synthetic preferences")
        if let file, FileManager.default.fileExists(atPath: file) {
            let url = URL(fileURLWithPath: file)
            let original = try Data(contentsOf: url)
            try assertPreferenceProjectionPreserved(original, catalog: catalog, label: "existing user preferences")
            let after = try Data(contentsOf: url)
            try check(after == original, "existing sidebar JSON remains byte-for-byte unchanged")
        }
    }

    static func assertPreferenceProjectionPreserved(_ raw: Data, catalog: ToolCatalog, label: String) throws {
        let preferences = try JSONDecoder().decode(SidebarOverrides.self, from: raw)
        let original = try JSONSerialization.jsonObject(with: raw) as! NSDictionary
        let customCLI = preferences.customCLI.map { Entry(name: $0.name, path: $0.path) }
        let customApps = preferences.customApps.map { Entry(name: $0.name, path: $0.path) }
        _ = ToolCatalog.deduplicated(customCLI + catalog.cli.map { Entry(name: $0.name, path: $0.command) }, path: { $0.path })
        let projectedApps = ToolCatalog.deduplicated(customApps + catalog.apps.map { Entry(name: $0.name, path: $0.path) }, path: { $0.path })
        let after = try JSONSerialization.jsonObject(with: JSONEncoder().encode(preferences)) as! NSDictionary
        try check(after.isEqual(to: original as! [AnyHashable: Any]), "\(label): names, hidden items, order, groups and custom entries are preserved")
        if preferences.customApps.contains(where: { $0.name == "My duplicate editor" }) {
            try check(projectedApps.contains { $0.name == "My duplicate editor" }
                      && !projectedApps.contains { $0.name == "Qoder" },
                      "new built-in app does not replace an existing custom label")
        }
    }
}
