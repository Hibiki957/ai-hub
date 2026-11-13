import AppKit
import Foundation
import GhosttyTerminal

// This test target deliberately excludes the application's entry point.
final class AppDelegate {
    @MainActor static weak var model: AppModel?
}

@main
struct AppModelCatalogRegression {
    struct Failure: Error, CustomStringConvertible { let description: String }

    @MainActor static func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        guard condition() else { throw Failure(description: message) }
        print("PASS: \(message)")
    }

    @MainActor static func main() {
        do {
            // Check both isolation barriers before constructing production state.
            try check(AppModel.isPreview, "preview bundle is active before AppModel initialization")
            guard let isolatedHome = ProcessInfo.processInfo.environment["AIHUB_TEST_HOME"] else {
                throw Failure(description: "Missing isolated test home")
            }
            try check(NSHomeDirectory() == isolatedHome, "Foundation home is isolated from real user data")
            guard CommandLine.arguments.count == 2 else { throw Failure(description: "Expected sidebar fixture path") }
            let original = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
            let preferences = try JSONDecoder().decode(SidebarOverrides.self, from: original)
            _ = NSApplication.shared
            let pwaDirectory = URL(fileURLWithPath: isolatedHome).appendingPathComponent("Applications/Chrome Apps.localized")
            try writePWA("AIHub Initial Fixture", in: pwaDirectory)
            let model = AppModel()
            try check(model.overrides.customCLI.isEmpty && model.overrides.renames.isEmpty,
                      "preview initialization skips persisted sidebar loading")
            model.overrides = preferences
            try testUserProjection(model, original: original)
            try testScopedEnvironment(model)
            try testEmbeddedTabs(model)
            try testRefresh(model, in: pwaDirectory)
            try testAvailabilityRefresh(model, in: URL(fileURLWithPath: isolatedHome))
            try testCustomAlias(model, in: URL(fileURLWithPath: isolatedHome))
            try testToolLauncher(model, in: pwaDirectory)
            model.overrides = preferences
            try sameJSON(model.overrides, original, "all original preferences survive the integrated checks")
            try check(!FileManager.default.fileExists(atPath: isolatedHome + "/Library/Application Support/AIHub/sidebar.json"),
                      "preview assignment and save never write a sidebar file")
            let after = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
            try check(after == original, "sidebar fixture remains byte-for-byte unchanged")
            print("ALL APPMODEL CATALOG REGRESSIONS PASSED")
        } catch {
            fputs("FAIL: \(error)\n", stderr)
            exit(1)
        }
    }

    @MainActor static func sameJSON(_ preferences: SidebarOverrides, _ raw: Data, _ label: String) throws {
        let expected = try JSONSerialization.jsonObject(with: raw) as! NSDictionary
        let actual = try JSONSerialization.jsonObject(with: JSONEncoder().encode(preferences)) as! NSDictionary
        try check(actual.isEqual(expected), label)
    }

    @MainActor static func testUserProjection(_ model: AppModel, original: Data) throws {
        let catalog = ToolCatalog.shared
        let preferences = try JSONDecoder().decode(SidebarOverrides.self, from: original)
        try check(model.cliEntries.map(\.id) == catalog.cli.map(\.id)
                  && model.appEntries.map(\.id) == catalog.apps.map(\.id),
                  "AppModel retains every base definition independently of local installation state")
        try sameJSON(model.overrides, original, "loading preferences preserves all supplied names and custom entries")
        func ordered<T>(_ entries: [T], section: String, name: (T) -> String) -> [T] {
            let ranks = Dictionary((preferences.orders[section] ?? []).enumerated().map { ($0.element, $0.offset) },
                                   uniquingKeysWith: { first, _ in first })
            return entries.enumerated().sorted {
                let lhs = ranks[name($0.element)] ?? Int.max
                let rhs = ranks[name($1.element)] ?? Int.max
                return lhs == rhs ? $0.offset < $1.offset : lhs < rhs
            }.map(\.element)
        }
        let customCLI = preferences.customCLI.filter { !preferences.hidden.contains($0.name) }
            .map { CLIEntry(name: $0.name, command: ToolCatalog.expand($0.path), title: $0.name) }
        let customApps = preferences.customApps.filter { !preferences.hidden.contains($0.name) }
            .map { AppEntry(name: $0.name, appPath: ToolCatalog.expand($0.path)) }
        let availableCLI = (customCLI + model.cliEntries.filter { !preferences.hidden.contains($0.name) })
            .filter { ToolCatalog.isAvailableCommand($0.command) }
        let availableApps = (customApps + model.appEntries.filter { !preferences.hidden.contains($0.name) })
            .filter { ToolCatalog.isAvailableApp($0.appPath) }
        let cli = ToolCatalog.deduplicated(availableCLI, path: { $0.command })
        let apps = ToolCatalog.deduplicated(availableApps, path: { $0.appPath })
        try check(model.visibleCLIEntries.map(\.id) == ordered(cli, section: "CLI 工具", name: { $0.name }).map(\.id)
                  && model.visibleAppEntries.map(\.id) == ordered(apps, section: "Apps", name: { $0.name }).map(\.id),
                  "visible collections contain available, unhidden, deduplicated entries in saved order")
        try check(model.customCLIEntries.map(\.id) == customCLI.map(\.id)
                  && model.customAppEntries.map(\.id) == customApps.map(\.id),
                  "custom entry projections retain missing definitions without deleting personal preferences")
        try check(model.overrides.renames.allSatisfy { model.displayName($0.key) == $0.value },
                  "displayName applies every saved user rename")
        let expectedSections = model.overrides.sectionOrder.filter { saved in model.visibleSections.contains { $0.rawTitle == saved } }
        try check(Array(model.visibleSections.map(\.rawTitle).prefix(expectedSections.count)) == expectedSections,
                  "saved top-level section order survives inventory integration")
        try assertLauncherConsistency(model)
        try sameJSON(model.overrides, original, "building visible collections preserves every preference field")
    }

    @MainActor static func assertLauncherConsistency(_ model: AppModel) throws {
        let items = ToolLauncherCatalog(model: model).items
        let cli = items.compactMap { item -> String? in
            if case .terminal(let entry) = item.destination { return entry.id }
            return nil
        }
        let apps = items.compactMap { item -> String? in
            if case .desktop(let entry) = item.destination { return entry.id }
            return nil
        }
        let web = items.compactMap { item -> String? in
            if case .web(let entry) = item.destination { return entry.id }
            return nil
        }
        try check(cli == model.visibleCLIEntries.map(\.id) && apps == model.visibleAppEntries.map(\.id)
                  && Set(web) == Set(model.pwaSections.flatMap(\.items).map(\.id)),
                  "launcher and sidebar projections share the same available CLI, App and PWA inventory")
    }

    @MainActor static func testScopedEnvironment(_ model: AppModel) throws {
        guard let dsh = model.cliEntries.first(where: { $0.name == "dsh" }) else { throw Failure(description: "Missing DSH") }
        let nvm = NSHomeDirectory() + "/.nvm/versions/node/v24.18.0/bin"
        let path = dsh.environment["PATH"]?.components(separatedBy: ":") ?? []
        try check(path.first == nvm && path.filter { $0 == nvm }.count == 1
                  && path.contains(NSHomeDirectory() + "/.local/bin"),
                  "DSH environment selects its nvm installation without dropping or duplicating local PATH")
        try check(model.cliEntries.filter { $0.name != "dsh" }.allSatisfy { $0.environment.isEmpty }
                  && AppModel.augmentedPATH.components(separatedBy: ":").first == NSHomeDirectory() + "/.local/bin",
                  "DSH-specific PATH does not change other CLI defaults")
        let tabID = UUID(), paneID = UUID()
        let scoped = TabStore.baseEnvVars(tabID: tabID, paneID: paneID, cliName: dsh.name, environment: dsh.environment)
        try check(scoped["PATH"] == dsh.environment["PATH"] && scoped["AIHUB_TAB_ID"] == tabID.uuidString
                  && scoped["AIHUB_PANE_ID"] == paneID.uuidString && scoped["TERM_PROGRAM"] == "AIHub",
                  "baseEnvVars merges scoped PATH while preserving terminal identity")
        let before = model.tabs.count
        model.openCLI(dsh)
        try check(model.tabs.count == before, "preview prevents a real DSH launch")

        // A safe command captures production open/split configuration. No native
        // terminal view is mounted, so no PTY or process is created.
        let fixture = CLIEntry(name: "offline-env-fixture", command: "/usr/bin/true", title: "Offline", pathPrepend: dsh.pathPrepend)
        let store = model.tabStore
        store.openCLI(fixture)
        guard let tab = store.tabs.last, let first = tab.primary else { throw Failure(description: "Missing fixture tab") }
        defer { store.closeTab(id: tab.id) }
        try check(first.state.configuration.envVars["PATH"] == dsh.environment["PATH"]
                  && first.state.configuration.envVars["AIHUB_PANE_ID"] == first.id.uuidString,
                  "openCLI forwards scoped environment to the primary pane")
        model.splitPane(tab: tab, paneID: first.id, direction: .right)
        guard tab.panes.count == 2 else { throw Failure(description: "Missing inherited split") }
        let inherited = tab.panes[1]
        try check(inherited.state.configuration.envVars["PATH"] == dsh.environment["PATH"]
                  && inherited.state.configuration.envVars["AIHUB_PANE_ID"] == inherited.id.uuidString,
                  "splitPane inherits scoped environment and assigns a distinct pane identity")
        let plain = CLIEntry(name: "offline-plain", command: "/usr/bin/true", title: "Plain")
        model.splitPane(tab: tab, paneID: first.id, direction: .down, cli: plain)
        try check(tab.panes.last?.state.configuration.envVars["PATH"] == AppModel.augmentedPATH,
                  "an explicit non-DSH split receives the default PATH")
        try check(tab.panes.allSatisfy { $0.platformView == nil && $0.state.surface == nil },
                  "configuration checks create no terminal surface or agent process")
    }

    @MainActor static func testEmbeddedTabs(_ model: AppModel) throws {
        let catalog = try AppIntegrations.loadDefault()
        guard let notion = catalog.workspaceRoute(forAppPath: "/Applications/Notion.app"),
              case let .web(title, url) = notion else { throw Failure(description: "Missing internal Notion route") }
        let store = model.tabStore
        let initialCount = store.webTabs.count
        let terminalCount = store.tabs.count
        store.showingOverview = true
        store.openWeb(title: title, url: url)
        guard let selected = store.webTabs.last else { throw Failure(description: "Missing internal tab") }
        defer { store.closeWebTab(id: selected.id) }
        try check(store.webTabs.count == initialCount + 1 && store.selectedWebTabID == selected.id
                  && store.selectedTabID == nil && !store.showingOverview,
                  "workbench route selects an internal tab and leaves the overview")
        store.openWeb(title: title, url: url)
        try check(store.webTabs.count == initialCount + 1 && store.webTabs.last === selected,
                  "repeated internal launches reuse the same WebTab and holder")
        try check(selected.holder.webView == nil && store.tabs.count == terminalCount,
                  "route checks start no browser network request, shell, or external application")
        store.showingOverview = true
        model.openIntegration(notion)
        model.openPreferredApp(AppEntry(name: "Custom renamed Notion", appPath: "/Applications/Notion.app"))
        try check(store.webTabs.count == initialCount + 1 && store.showingOverview,
                  "preview guards prevent real application launch from both entry points")
    }

    static func writeExecutable(at url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Metadata fixture only: no test executes this file.
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    }

    @discardableResult
    static func writeApp(at url: URL) throws -> URL {
        let contents = url.appendingPathComponent("Contents")
        let executable = contents.appendingPathComponent("MacOS/Fixture")
        try writeExecutable(at: executable)
        let plist = ["CFBundleIdentifier": "com.example.aihub.catalog-fixture",
                     "CFBundleName": url.deletingPathExtension().lastPathComponent,
                     "CFBundleExecutable": "Fixture", "CFBundlePackageType": "APPL",
                     "CFBundleVersion": "1", "CFBundleShortVersionString": "1.0"]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            .write(to: contents.appendingPathComponent("Info.plist"))
        return executable
    }

    static func writePWA(_ name: String, in directory: URL) throws {
        let app = directory.appendingPathComponent(name + ".app")
        try writeApp(at: app)
        let plistURL = app.appendingPathComponent("Contents/Info.plist")
        guard var plist = try PropertyListSerialization.propertyList(from: Data(contentsOf: plistURL), options: [], format: nil)
            as? [String: Any] else { throw Failure(description: "Missing PWA fixture application metadata") }
        plist["CrAppModeShortcutURL"] = "https://example.invalid/offline-fixture"
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            .write(to: plistURL)
    }

    @MainActor static func testRefresh(_ model: AppModel, in directory: URL) throws {
        let raw = try JSONEncoder().encode(model.overrides)
        let initial = "AIHub Initial Fixture", added = "AIHub Added Fixture"
        try check(model.pwaSections.flatMap(\.items).contains { $0.name == initial }, "AppModel scans the initial isolated PWA")
        try writePWA(added, in: directory)
        try FileManager.default.removeItem(at: directory.appendingPathComponent(initial + ".app"))
        let cached = model.buildPWASections().flatMap(\.items).map(\.name)
        try check(cached.contains(initial) && !cached.contains(added), "ordinary PWA rebuild uses the existing inventory cache")
        model.refreshToolInventory()
        let refreshed = model.pwaSections.flatMap(\.items).map(\.name)
        try check(!refreshed.contains(initial) && refreshed.contains(added), "refresh invalidates PWA cache and detects both addition and removal")
        try assertLauncherConsistency(model)
        try sameJSON(model.overrides, raw, "refresh preserves all user preferences")
    }

    @MainActor static func testAvailabilityRefresh(_ model: AppModel, in directory: URL) throws {
        let original = model.overrides
        let root = directory.appendingPathComponent("availability-fixture-\(UUID().uuidString)")
        defer {
            model.overrides = original
            try? FileManager.default.removeItem(at: root)
            model.refreshToolInventory()
        }
        let command = root.appendingPathComponent("command")
        let commandAlias = root.appendingPathComponent("command-alias")
        let app = root.appendingPathComponent("Fixture.app")
        let appAlias = root.appendingPathComponent("Fixture Alias.app")
        try writeExecutable(at: command)
        let appExecutable = try writeApp(at: app)
        try FileManager.default.createSymbolicLink(at: commandAlias, withDestinationURL: command)
        try FileManager.default.createSymbolicLink(at: appAlias, withDestinationURL: app)
        let cliName = "AIHub availability CLI alias", appName = "AIHub availability App alias"
        var preferences = original
        preferences.customCLI += [CustomEntry(name: cliName, path: commandAlias.path),
                                  CustomEntry(name: "AIHub availability CLI duplicate", path: command.path)]
        preferences.customApps += [CustomEntry(name: appName, path: appAlias.path),
                                   CustomEntry(name: "AIHub availability App duplicate", path: app.path)]
        preferences.renames[cliName] = "Retained CLI label"
        preferences.renames[appName] = "Retained App label"
        preferences.orders["CLI 工具"] = [cliName] + (preferences.orders["CLI 工具"] ?? [])
        preferences.orders["Apps"] = [appName] + (preferences.orders["Apps"] ?? [])
        model.overrides = preferences
        let saved = try JSONEncoder().encode(model.overrides)
        let fixtureURL = URL(fileURLWithPath: CommandLine.arguments[1])
        let savedBytes = try Data(contentsOf: fixtureURL)
        func verify(_ available: Bool, phase: String) throws {
            model.refreshToolInventory()
            let visibleCLI = model.visibleCLIEntries.filter { $0.name.hasPrefix("AIHub availability CLI") }
            let visibleApps = model.visibleAppEntries.filter { $0.name.hasPrefix("AIHub availability App") }
            try check(visibleCLI.map(\.name) == (available ? [cliName] : [])
                      && visibleApps.map(\.name) == (available ? [appName] : []),
                      "\(phase): refresh filters unavailable entries and keeps the preferred real-path aliases")
            try check(model.customCLIEntries.contains { $0.name == cliName }
                      && model.customAppEntries.contains { $0.name == appName }
                      && model.displayName(cliName) == "Retained CLI label"
                      && model.displayName(appName) == "Retained App label",
                      "\(phase): missing tools retain their custom definitions and labels")
            try assertLauncherConsistency(model)
            try sameJSON(model.overrides, saved, "\(phase): refresh preserves preference JSON")
            let afterBytes = try Data(contentsOf: fixtureURL)
            try check(afterBytes == savedBytes, "\(phase): refresh leaves the supplied preference file byte-for-byte unchanged")
        }
        try verify(true, phase: "installed fixture")
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: command.path)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: appExecutable.path)
        try verify(false, phase: "non-executable CLI and App executable")
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: command.path)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: appExecutable.path)
        try verify(true, phase: "executable permissions restored")
        try FileManager.default.removeItem(at: command)
        try FileManager.default.removeItem(at: app)
        try check(!ToolCatalog.isAvailableCommand(commandAlias.path) && !ToolCatalog.isAvailableApp(appAlias.path),
                  "broken CLI and App aliases do not count as installed tools")
        try verify(false, phase: "deleted tools and broken aliases")
        try writeExecutable(at: command)
        try writeApp(at: app)
        try verify(true, phase: "recreated tools repair the existing aliases")
    }

    @MainActor static func testCustomAlias(_ model: AppModel, in directory: URL) throws {
        let original = model.overrides
        let root = directory.appendingPathComponent("custom-alias-fixture-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer {
            model.overrides = original
            try? FileManager.default.removeItem(at: root)
            model.refreshToolInventory()
        }
        let alias = root.appendingPathComponent("offline-zsh-alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: URL(fileURLWithPath: "/bin/zsh"))
        let app = root.appendingPathComponent("Offline Editor.app")
        try writeApp(at: app)
        let appAlias = root.appendingPathComponent("Offline Editor Alias.app")
        try FileManager.default.createSymbolicLink(at: appAlias, withDestinationURL: app)
        var custom = original
        custom.customCLI.insert(CustomEntry(name: "My custom shell", path: alias.path), at: 0)
        custom.renames["My custom shell"] = "My visible shell label"
        custom.orders["CLI 工具"] = ["My custom shell"] + (custom.orders["CLI 工具"] ?? [])
        custom.customApps += [CustomEntry(name: "My custom editor", path: appAlias.path),
                              CustomEntry(name: "Duplicate custom editor", path: app.path)]
        custom.renames["My custom editor"] = "My visible editor label"
        model.overrides = custom
        model.refreshToolInventory()
        let shellPath = URL(fileURLWithPath: "/bin/zsh").resolvingSymlinksInPath().path
        let shellEntries = model.visibleCLIEntries.filter {
            URL(fileURLWithPath: ToolCatalog.expand($0.command)).resolvingSymlinksInPath().path == shellPath
        }
        try check(model.visibleCLIEntries.contains { $0.name == "My custom shell" }
                  && shellEntries.count == 1 && shellEntries.first?.name == "My custom shell"
                  && model.visibleCLIEntries.first?.name == "My custom shell"
                  && model.displayName("My custom shell") == "My visible shell label",
                  "actual CLI projection prefers a custom alias, display label and saved order")
        try check(model.visibleAppEntries.contains { $0.name == "My custom editor" }
                  && !model.visibleAppEntries.contains { $0.name == "Duplicate custom editor" }
                  && model.displayName("My custom editor") == "My visible editor label",
                  "actual App projection keeps a custom duplicate's identity and display label")
        try assertLauncherConsistency(model)
    }

    @MainActor static func testToolLauncher(_ model: AppModel, in directory: URL) throws {
        let original = model.overrides
        let family = "AIHub Launcher Family", first = "AIHub Launcher First"
        let hidden = "AIHub Launcher Hidden", web = "AIHub Launcher Web"
        let hiddenWeb = "AIHub Launcher Hidden Web", group = "AIHub Launcher Group"
        let commands = ["launcher-family-command", "launcher-first-command", "launcher-hidden-command"]
            .map { directory.appendingPathComponent($0) }
        let apps = ["Launcher Family Desktop.app", "Launcher Hidden Desktop.app"]
            .map { directory.appendingPathComponent($0) }
        defer {
            model.overrides = original
            for url in commands + apps + [directory.appendingPathComponent(web + ".app"),
                                           directory.appendingPathComponent(hiddenWeb + ".app")] {
                try? FileManager.default.removeItem(at: url)
            }
            model.refreshToolInventory()
        }
        for command in commands { try writeExecutable(at: command) }
        for app in apps { try writeApp(at: app) }
        try writePWA(web, in: directory)
        try writePWA(hiddenWeb, in: directory)
        var preferences = original
        preferences.customCLI += [
            CustomEntry(name: family, path: directory.appendingPathComponent("launcher-family-command").path),
            CustomEntry(name: first, path: directory.appendingPathComponent("launcher-first-command").path),
            CustomEntry(name: hidden, path: directory.appendingPathComponent("launcher-hidden-command").path),
        ]
        preferences.customApps += [
            CustomEntry(name: family, path: directory.appendingPathComponent("Launcher Family Desktop.app").path),
            CustomEntry(name: hidden, path: directory.appendingPathComponent("Launcher Hidden Desktop.app").path),
        ]
        preferences.renames[family] = "AIHub Fixture Family Assistant"
        preferences.hidden += [hidden, hiddenWeb]
        preferences.orders["CLI 工具"] = [first, family] + (preferences.orders["CLI 工具"] ?? [])
        preferences.orders["Apps"] = [family] + (preferences.orders["Apps"] ?? [])
        preferences.customPWAGroups.append(group)
        preferences.moves[web] = group
        preferences.sectionRenames[group] = "AIHub Fixture Pinned Web"
        preferences.sectionOrder = [group, "Apps", "CLI 工具"] + original.sectionOrder.filter {
            ![group, "Apps", "CLI 工具"].contains($0)
        }
        model.overrides = preferences
        model.refreshToolInventory()
        let saved = try JSONEncoder().encode(model.overrides)
        let catalog = ToolLauncherCatalog(model: model)
        let familyItems = catalog.items.filter { $0.rawName == family }
        try check(familyItems.count == 2 && Set(familyItems.map(\.kind)) == [.terminal, .desktop]
                  && Set(familyItems.map(\.id)).count == 2,
                  "launcher keeps a tool family's terminal and desktop forms as independent identities")
        try check(familyItems.allSatisfy { $0.title == "AIHub Fixture Family Assistant" },
                  "launcher uses the saved display alias for both tool forms")
        try check(catalog.filtered(query: "AIHUB LAUNCHER FAMILY").flatMap(\.items).map(\.id) == familyItems.map(\.id),
                  "launcher search finds the original name after a personal rename")
        try check(catalog.filtered(query: "  aIHuB\nFiXtUrE\tAsSiStAnT ").flatMap(\.items).map(\.id) == familyItems.map(\.id),
                  "launcher search accepts whitespace-separated terms and mixed case in a display alias")
        try check(catalog.filtered(query: " \n\t").flatMap(\.items).map(\.id) == catalog.items.map(\.id),
                  "whitespace-only search preserves the complete visible inventory and its order")
        try check(!catalog.items.contains { $0.rawName == hidden || $0.rawName == hiddenWeb }
                  && catalog.filtered(query: hidden).isEmpty,
                  "hidden terminal, desktop and PWA entries stay absent from launcher and search")
        try check(Array(catalog.sections.map(\.id).prefix(3)) == [group, "Apps", "CLI 工具"]
                  && catalog.sections.first?.title == "AIHub Fixture Pinned Web",
                  "launcher preserves personal section order and renamed PWA group titles")
        try check(Array(catalog.items.filter { $0.kind == .terminal }.map(\.rawName).prefix(2)) == [first, family]
                  && catalog.items.first(where: { $0.kind == .desktop })?.rawName == family,
                  "launcher preserves saved terminal and desktop item order")
        let terminal = catalog.filtered(query: "AIHub Fixture Family Assistant", kind: .terminal).flatMap(\.items)
        let desktop = catalog.filtered(query: "AIHub Fixture Family Assistant", kind: .desktop).flatMap(\.items)
        try check(terminal.count == 1 && terminal.first?.rawName == family
                  && desktop.count == 1 && desktop.first?.rawName == family,
                  "surface filters disambiguate the same family's terminal and desktop search results")
        let webItems = catalog.filtered(query: "AIHub Fixture Pinned PWA", kind: .web).flatMap(\.items)
        try check(webItems.count == 1 && webItems.first?.rawName == web && webItems.first?.sectionID == group,
                  "PWA search combines the saved group label with the web surface vocabulary")
        try check(catalog.filtered(query: "AIHub Fixture Pinned", kind: .terminal).isEmpty,
                  "kind and text filters are combined without cross-surface results")
        guard let terminalItem = terminal.first, case .terminal(let cli) = terminalItem.destination,
              let desktopItem = desktop.first, case .desktop(let app) = desktopItem.destination,
              let webItem = webItems.first, case .web(let pwa) = webItem.destination else {
            throw Failure(description: "Launcher destinations did not retain their typed entries")
        }
        try check(cli.command.hasSuffix("launcher-family-command")
                  && app.appPath.hasSuffix("Launcher Family Desktop.app")
                  && pwa.appPath == directory.appendingPathComponent(web + ".app").path,
                  "launcher retains original launch destinations while presenting renamed labels")
        try assertLauncherConsistency(model)
        try sameJSON(model.overrides, saved, "building and searching launcher never rewrites personal preferences")
    }
}
