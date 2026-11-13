import Foundation

@main
struct IntegrationReferencesRegression {
    static func main() throws {
        let source = URL(fileURLWithPath: CommandLine.arguments[1])
        let catalog = try AppIntegrations.load(from: source)
        var checks = 0
        func accept(_ raw: String, _ app: String) throws {
            _ = try catalog.validateReference(raw, integrationID: app)
            checks += 1
        }
        func reject(_ raw: String, _ app: String) {
            do {
                _ = try catalog.validateReference(raw, integrationID: app)
                fatalError("Unsafe reference accepted: \(raw)")
            } catch { checks += 1 }
        }
        precondition(catalog.integrations.count == 10)
        precondition(catalog.integrations.allSatisfy { $0.capabilities.filter { $0.key != "embed" }.values.allSatisfy { !$0.available } })
        precondition(catalog.integrations.filter { $0.capabilities["embed"]?.available == true }.map(\.id).sorted() == ["chatbox", "ghostty", "miro", "notion", "outlook"])
        checks += 2
        try accept("https://miro.com/app/board/example/", "miro")
        try accept("https://www.notion.so/example?v=view-id#heading", "notion")
        try accept("zotero://select/library/items/ABCD2345", "zotero")
        try accept("zotero://select/groups/1234/collections/ABCD2345", "zotero")
        try accept("obsidian://open?vault=Notes&file=Research%2FTopic", "obsidian")
        try accept("obsidian://open?path=%2Ftmp%2Fnote.md", "obsidian")
        for value in ["javascript:alert(1)", "data:text/html,hello", "ssh://host", "sftp://host/file", "mailto:test@example.com", "http://example.com", "https://u:p@example.com", "https://example.com?access_token=secret", "https://example.com?accessToken=secret", "https://example.com#bootstrapSecret=secret", "https://example.com#/route?token=secret", "https://example.com#route%3Fclient_secret%3Dsecret", "https://example.com?API-Key=secret", "file://remote-host/tmp/note", "https://example.com\n/other", "https://example.com/%00bad"] {
            reject(value, "outlook")
        }
        for value in ["obsidian://new?vault=Notes&name=New", "obsidian://daily?vault=Notes", "obsidian://open?vault=Notes&append=1", "obsidian://open?vault=Notes&content=hello", "obsidian://open?vault=Notes&x-success=ssh%3A%2F%2Fhost", "obsidian://open?vault=Notes&vault=Other", "obsidian://open?vault=Notes&file=%0Aunsafe"] {
            reject(value, "obsidian")
        }
        reject("zotero://select/library/items/ABCD2345?execute=1", "zotero")
        reject("zotero://open-pdf/library/items/ABCD2345", "zotero")
        reject("zotero://select/library/items/ABCD2345", "chatbox")
        reject("https://example.com", "unknown")

        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("aihub-reference-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let file = temporary.appendingPathComponent("文献 and script.sh")
        try Data("This file is never executed or read by the validator.".utf8).write(to: file)
        try accept(file.path, "masscode")
        try accept(file.absoluteString, "masscode")
        try accept(temporary.path, "ghostty")
        reject(temporary.appendingPathComponent("missing").path, "masscode")
        reject(file.absoluteString + "?run=1", "masscode")
        let before = try Data(contentsOf: file)
        _ = try catalog.validateReference(file.path, integrationID: "masscode")
        let after = try Data(contentsOf: file)
        precondition(after == before)

        var object = try JSONSerialization.jsonObject(with: Data(contentsOf: source)) as! [String: Any]
        var entries = object["integrations"] as! [[String: Any]]
        var capabilities = entries[0]["capabilities"] as! [String: [String: Any]]
        capabilities["read"]!["available"] = true
        entries[0]["capabilities"] = capabilities
        object["integrations"] = entries
        let invalid = temporary.appendingPathComponent("invalid.json")
        try JSONSerialization.data(withJSONObject: object).write(to: invalid)
        do { _ = try AppIntegrations.load(from: invalid); fatalError("Unimplemented capability accepted") }
        catch { checks += 1 }
        // Internal presentation is independent of installation and API access.
        for (id, count) in [("miro", 1), ("notion", 1), ("chatbox", 1), ("outlook", 2), ("ghostty", 1)] {
            let entry = catalog.integrations.first { $0.id == id }!
            precondition(catalog.workspaceRoutes(for: entry).count == count)
            checks += 1
        }
        precondition(catalog.workspaceRoute(forAppPath: "/Applications/Notion.app") == .web(title: "Notion", url: URL(string: "https://www.notion.so/")!))
        precondition(catalog.workspaceRoute(forAppPath: "/Applications/Ghostty.app") == .terminal(title: "内置终端"))
        precondition(catalog.workspaceRoute(forAppPath: "/Applications/Eagle.app") == nil)
        precondition(catalog.workspaceRoute(forAppPath: "/Applications/FinalShell.app") == nil)
        precondition(catalog.workspaceRoute(forAppPath: "/Applications/Unknown.app") == nil)
        checks += 5
        let alias = temporary.appendingPathComponent("Renamed shell.app")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: URL(fileURLWithPath: "/Applications/Ghostty.app"))
        precondition(catalog.workspaceRoute(forAppPath: alias.path) == .terminal(title: "内置终端"))
        checks += 1

        let originalObject = try JSONSerialization.jsonObject(with: Data(contentsOf: source)) as! [String: Any]
        func rejectWorkspace(_ destination: [String: Any], for id: String) throws {
            var object = originalObject
            var entries = object["integrations"] as! [[String: Any]]
            let index = entries.firstIndex { $0["id"] as? String == id }!
            entries[index]["workspace"] = [destination]
            var capabilities = entries[index]["capabilities"] as! [String: [String: Any]]
            capabilities["embed"]!["available"] = true
            entries[index]["capabilities"] = capabilities
            object["integrations"] = entries
            let invalid = temporary.appendingPathComponent("invalid-workspace.json")
            try JSONSerialization.data(withJSONObject: object).write(to: invalid)
            do { _ = try AppIntegrations.load(from: invalid); fatalError("Unsafe workspace accepted") }
            catch { checks += 1 }
        }
        for raw in ["file:///bin/sh", "javascript:alert(1)", "http://127.0.0.1:41595", "ssh://host", "https://user:password@example.com", "https://example.com/?token=secret"] {
            try rejectWorkspace(["kind": "web", "title": "unsafe", "url": raw], for: "miro")
        }
        try rejectWorkspace(["kind": "terminal", "title": "unsafe"], for: "miro")
        try rejectWorkspace(["kind": "terminal", "title": "unsafe", "url": "file:///bin/sh"], for: "ghostty")
        try rejectWorkspace(["kind": "unknown", "title": "unsafe"], for: "miro")
        try rejectWorkspace(["kind": "web", "title": "", "url": "https://miro.com/"], for: "miro")

        // Only same-host HTTPS PWA shortcuts may override the declared default.
        let pwa = temporary.appendingPathComponent("Miro.app")
        let info = pwa.appendingPathComponent("Contents/Info.plist")
        try FileManager.default.createDirectory(at: info.deletingLastPathComponent(), withIntermediateDirectories: true)
        let sample = catalog.integrations.first { $0.id == "miro" }!
        let fixture = AppIntegrations.Entry(id: sample.id, name: sample.name, role: sample.role,
            appPaths: [], pwaPaths: [pwa.path], capabilities: sample.capabilities, limitations: sample.limitations,
            officialSources: sample.officialSources, referenceRules: sample.referenceRules, authorization: sample.authorization,
            workspace: [.init(kind: .web, title: "Miro", url: "https://miro.com/app/dashboard/")])
        for (shortcut, expected) in [
            ("https://miro.com/app/board/offline-fixture/", "https://miro.com/app/board/offline-fixture/"),
            ("https://miro.com.evil.invalid/", "https://miro.com/app/dashboard/"),
            ("https://miro.com/app/?token=secret", "https://miro.com/app/dashboard/"),
            ("file:///bin/sh", "https://miro.com/app/dashboard/")
        ] {
            let plist = ["CFBundleIdentifier": "aihub.offline-pwa-fixture", "CrAppModeShortcutURL": shortcut]
            try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: info)
            precondition(catalog.workspaceRoutes(for: fixture) == [.web(title: "Miro", url: URL(string: expected)!)])
            checks += 1
        }
        let missing = AppIntegrations.Entry(id: "missing", name: "Missing", role: "test", appPaths: [temporary.appendingPathComponent("Missing.app").path], pwaPaths: [], capabilities: [:], limitations: [], officialSources: [], referenceRules: .init(allowHTTPS: true, allowFiles: true, deepLinks: [], examples: []), authorization: "")
        precondition(missing.metadata().isEmpty)
        checks += 1
        print("PASS: \(checks) integration reference/metadata/workspace boundary checks; no applications, services, or API requests started")
    }
}
