import Foundation

@main
struct WorkbenchManagementRegression {
    struct Failure: Error, CustomStringConvertible { let description: String }

    @MainActor static func main() async throws {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ label: String) throws {
            guard condition() else { throw Failure(description: label) }
            checks += 1
        }
        func reject(_ label: String, _ action: () throws -> Void) throws {
            var rejected = false
            do { try action() } catch { rejected = true }
            try check(rejected, label)
        }
        let fm = FileManager.default
        let fixture = fm.temporaryDirectory.appendingPathComponent("aihub-management-" + UUID().uuidString)
        let home = fixture.appendingPathComponent("fixture-home")
        try fm.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: fixture) }
        var sourceFiles: [URL: Data] = [:]
        func write(_ relative: String, _ text: String) throws -> URL {
            let file = home.appendingPathComponent(relative)
            try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = Data(text.utf8)
            try data.write(to: file)
            sourceFiles[file] = data
            return file
        }
        let shared = try write(".agents/skills/shared/SKILL.md", "---\nname: Shared Fixture\ndescription: Safe description\nversion: '1.2.3'\n---\nBODY_SENTINEL_DO_NOT_COPY\n")
        for relative in [".codex/skills/shared-alias", ".claude/skills/shared-alias"] {
            let link = home.appendingPathComponent(relative)
            try fm.createDirectory(at: link.deletingLastPathComponent(), withIntermediateDirectories: true)
            try fm.createSymbolicLink(at: link, withDestinationURL: shared.deletingLastPathComponent())
        }
        _ = try write(".agents/skills/body-only/SKILL.md", "# Body only\nname: BODY_SENTINEL_DO_NOT_COPY\ndescription: BODY_SENTINEL_DO_NOT_COPY\n")
        _ = try write(".agents/skills/closed/SKILL.md", "---\nname: Header Only\n---\nversion: BODY_SENTINEL_DO_NOT_COPY\ndescription: BODY_SENTINEL_DO_NOT_COPY\n")
        _ = try write(".agents/skills/truncated/SKILL.md", "---\nname: UNFINISHED_METADATA\n" + String(repeating: "x", count: 9000) + "\n---\n")
        _ = try write(".agents/skills/bounded/SKILL.md", "---\nname: Bounded\ndescription: " + String(repeating: "d", count: 700) + "\n---\n")
        let config = try write(".codex/config.toml", #"""
        # [mcp_servers.comment_is_not_a_server]
        prompt = """
        [mcp_servers.inside_multiline_string]
        """
        other_prompt = '''
        [mcp_servers.inside_literal_string]
        '''
        [mcp_servers.safe]
        command = "/private/COMMAND_SENTINEL_DO_NOT_COPY"
        args = ["--token", "TOKEN_SENTINEL_DO_NOT_COPY"]
        url = "https://private.invalid/?token=TOKEN_SENTINEL_DO_NOT_COPY"
        [mcp_servers.safe.env]
        API_KEY = "TOKEN_SENTINEL_DO_NOT_COPY"
        [mcp_servers."quoted.with.dot"]
        bearer_token = "TOKEN_SENTINEL_DO_NOT_COPY"
        [mcp_servers.'literal-name']
        [mcp_servers.with_comment] # harmless comment
        [[mcp_servers.array_is_not_supported]]
        """#)

        let inventory = await Task.detached { WorkbenchManagementStore.discover(home: home) }.value
        try check(inventory.filter { $0.kind == "skill" }.count == 5, "Skill alias discovery must retain five unique canonical sources")
        let sharedEntry = try unwrap(inventory.first { $0.name == "Shared Fixture" }, "shared fixture missing")
        try check(sharedEntry.aliases == 3, "Three symlink aliases must deduplicate")
        try check(sharedEntry.canonicalSource == shared.path, "Canonical source must be the real skill")
        try check(sharedEntry.version == "1.2.3", "Metadata scalar version must parse")
        try check(inventory.first { $0.name == "body-only" }?.description == "未提供描述", "Body-only fields cannot become metadata")
        try check(inventory.first { $0.name == "Header Only" }?.version == "未声明", "Closed frontmatter must not read body version")
        try check(inventory.first { $0.name == "truncated" } != nil, "Truncated metadata must fall back to folder identity")
        try check(inventory.first { $0.name == "Bounded" }?.description.count == 500, "Metadata description must be bounded")
        let mcp = inventory.filter { $0.kind == "mcp" }
        try check(Set(mcp.map(\.name)) == Set(["safe", "quoted.with.dot", "literal-name", "with_comment"]), "Only real top-level MCP server names may be discovered")
        try check(mcp.allSatisfy { $0.source == config.path && $0.canonicalSource == config.path }, "MCP metadata must retain only the source file reference")
        let serialized = String(decoding: try JSONEncoder().encode(inventory), as: UTF8.self)
        for marker in ["BODY_SENTINEL_DO_NOT_COPY", "TOKEN_SENTINEL_DO_NOT_COPY", "COMMAND_SENTINEL_DO_NOT_COPY", "private.invalid"] {
            try check(!serialized.contains(marker), "Sensitive/body fixture must not enter inventory: " + marker)
        }
        let emptyHome = fixture.appendingPathComponent("empty-home")
        try fm.createDirectory(at: emptyHome, withIntermediateDirectories: true)
        let emptyInventory = WorkbenchManagementStore.discover(home: emptyHome)
        try check(emptyInventory.isEmpty, "Missing metadata must not fabricate capabilities")

        let storage = fixture.appendingPathComponent("hub-management")
        try fm.createDirectory(at: storage, withIntermediateDirectories: true)
        try JSONEncoder().encode(inventory).write(to: storage.appendingPathComponent("inventory.json"))
        let store = WorkbenchManagementStore(directory: storage)
        let secondSkill = try unwrap(inventory.first { $0.name == "Header Only" }, "second skill missing")
        let server = try unwrap(mcp.first { $0.name == "safe" }, "MCP fixture missing")
        let projectID = UUID().uuidString, taskID = UUID().uuidString
        let initial = CapabilityScope(enabledSkillIDs: [sharedEntry.id], enabledMCPIDs: [server.id])
        try store.apply(scope: "global", proposed: initial)
        try check(store.scopes["global"] == initial && store.revisions.count == 1, "Apply must persist own selection and revision")
        let firstRevision = store.revisions[0]
        try store.apply(scope: "global", proposed: initial)
        try check(store.revisions.count == 1, "No-op apply must not create a revision")
        try store.apply(scope: "project:" + projectID, proposed: CapabilityScope(enabledSkillIDs: [secondSkill.id]))
        try store.apply(scope: "task:" + taskID, proposed: CapabilityScope(enabledSkillIDs: [sharedEntry.id]))
        try check(Set(store.effectiveSkills(projectID: projectID, taskID: taskID).map(\.id)) == Set([sharedEntry.id, secondSkill.id]), "Effective scopes must union and deduplicate explicit skill grants")
        try check(store.effectiveSkills(projectID: "different", taskID: "different").map(\.id) == [sharedEntry.id], "Unrelated project/task grants must not leak")
        let beforeInvalid = store.scopes
        for bad in ["", "global ", "project:", "task:", "workspace:abc", "task:with space", "task:../other", "project:a:b", "task:x\ny", "project:" + String(repeating: "a", count: 129)] {
            try reject("Invalid scope accepted: " + bad) { try store.apply(scope: bad, proposed: initial) }
        }
        try reject("Unknown Skill ID must be rejected") { try store.apply(scope: "global", proposed: CapabilityScope(enabledSkillIDs: ["unknown"])) }
        try reject("Known Skill ID cannot masquerade as MCP") { try store.apply(scope: "global", proposed: CapabilityScope(enabledMCPIDs: [sharedEntry.id])) }
        try reject("Known MCP ID cannot masquerade as Skill") { try store.apply(scope: "global", proposed: CapabilityScope(enabledSkillIDs: [server.id])) }
        try check(store.scopes == beforeInvalid, "Failed apply must leave scope state unchanged")

        let alternative = CapabilityScope(enabledSkillIDs: [secondSkill.id])
        try store.apply(scope: "global", proposed: alternative)
        try reject("Stale rollback must conflict") { try store.rollback(firstRevision) }
        try store.apply(scope: "global", proposed: initial)
        try reject("ABA state must not revive stale revision") { try store.rollback(firstRevision) }
        let latest = try unwrap(store.revisions.last, "Latest revision missing")
        try check(store.canRollback(latest), "Latest revision must be eligible")
        let forged = ManagementRevision(id: UUID(), date: Date(), scope: "global", before: CapabilityScope(enabledSkillIDs: ["unknown"]), after: initial)
        try reject("Untrusted revision must not insert unknown grants") { try store.rollback(forged) }
        try store.rollback(latest)
        try check(store.scopes["global"] == alternative, "Rollback must restore prior own scope")
        try check(!store.canRollback(latest), "Already rolled-back revision must not replay")
        let reloaded = WorkbenchManagementStore(directory: storage)
        try check(reloaded.scopes == store.scopes && reloaded.revisions == store.revisions, "Persisted scopes/revisions must reload")
        let permissions = try fm.attributesOfItem(atPath: storage.appendingPathComponent("scopes.json").path)[.posixPermissions] as? NSNumber
        try check(permissions?.intValue == 0o600, "Scope selections must use private file mode")
        let backups = try fm.contentsOfDirectory(atPath: storage.path).filter { $0.hasPrefix("scopes-before-") }
        try check(!backups.isEmpty, "Revisions must preserve own prior file snapshots")
        for (file, data) in sourceFiles { let after = try Data(contentsOf: file); try check(after == data, "External fixture source changed") }

        for (input, expected) in [
            ("https://example.com/private/path", "https://example.com/"),
            ("HTTPS://EXAMPLE.COM/private", "https://EXAMPLE.COM/"),
            ("http://127.0.0.1:8765/private", "http://127.0.0.1:8765/"),
            ("http://localhost:3080/", "http://localhost:3080/"),
            ("http://[::1]:8765/private", "http://[::1]:8765/")
        ] {
            let output = try WorkbenchNetworkStore.sanitizedOrigin(input)
            try check(output.absoluteString == expected, "Allowed origin was not normalized: " + input)
        }
        for input in ["https://user:pass@example.com", "https://user@example.com", "https://example.com?token=fixture", "https://example.com#fixture", "javascript:alert(1)", "file:///tmp", "http://example.com", "http://192.168.1.2", "https://example.com:0", "https://example.com:65536", "https://example.com\n/private", "https://"] {
            try reject("Unsafe diagnostic target accepted: " + input) { _ = try WorkbenchNetworkStore.sanitizedOrigin(input) }
        }
        let request = try WorkbenchNetworkStore.diagnosticRequest("https://example.com/private/path")
        try check(request.httpMethod == "HEAD" && request.url?.path == "/", "Diagnostic must be a path-stripped HEAD")
        try check(request.httpBody == nil && request.httpBodyStream == nil, "Diagnostic must not include a body")
        try check((request.allHTTPHeaderFields ?? [:]).isEmpty, "Diagnostic must not include inherited credentials/headers")
        try check(!request.httpShouldHandleCookies, "Diagnostic must not attach cookies")
        let configuration = WorkbenchNetworkStore.diagnosticConfiguration()
        try check(configuration.httpCookieStorage == nil && configuration.urlCredentialStorage == nil, "Diagnostic must not use stored cookies or credentials")
        try check(!configuration.httpShouldSetCookies && configuration.httpAdditionalHeaders == nil, "Diagnostic configuration must not inject state/headers")
        let network = WorkbenchNetworkStore()
        network.forbidden = true
        network.target = "https://user:pass@example.com?token=fixture"
        network.check()
        try check(!network.checking && network.report.contains("未创建请求"), "Forbidden diagnostic must return without constructing a request")
        try check(!network.report.contains("pass") && !network.report.contains("token"), "Forbidden diagnostic must not echo credentials")
        print("PASS: \(checks) management/network fixture checks; no real user configuration, service, model, or network request used")
    }

    static func unwrap<T>(_ value: T?, _ label: String) throws -> T {
        guard let value else { throw Failure(description: label) }
        return value
    }
}
