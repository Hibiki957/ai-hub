import Foundation

/// Application references are separate from API authorization and task execution.
/// Loading this catalog only reads bundle metadata; it never probes a service or library.
struct AppIntegrations: Codable {
    struct Capability: Codable {
        let available: Bool
        let officialSupport: String
        let interface: String
        let authorization: String
        let detail: String
    }
    struct Source: Codable, Identifiable {
        let title: String
        let url: String
        var id: String { url }
    }
    struct ReferenceRules: Codable {
        let allowHTTPS: Bool
        let allowFiles: Bool
        let deepLinks: [String]
        let examples: [String]
    }
    /// Manual presentation is independent of Agent read/write/execute permissions.
    struct WorkspaceDestination: Codable {
        enum Kind: String, Codable { case web, terminal }
        let kind: Kind
        let title: String
        let url: String?
    }
    enum WorkspaceRoute: Equatable {
        case web(title: String, url: URL)
        case terminal(title: String)

        var title: String {
            switch self {
            case let .web(title, _), let .terminal(title): return title
            }
        }
        var buttonTitle: String {
            switch self {
            case .web: return "Hub 内打开网页版"
            case .terminal: return "打开内置终端"
            }
        }
    }
    struct Entry: Codable, Identifiable {
        let id: String
        let name: String
        let role: String
        let appPaths: [String]
        let pwaPaths: [String]
        let capabilities: [String: Capability]
        let limitations: [String]
        let officialSources: [Source]
        let referenceRules: ReferenceRules
        let authorization: String
        var workspace: [WorkspaceDestination]? = nil

        func metadata() -> [Installation] {
            (appPaths.map { ($0, false) } + pwaPaths.map { ($0, true) }).compactMap { path, pwa in
                let expanded = (path as NSString).expandingTildeInPath
                let url = URL(fileURLWithPath: expanded).standardizedFileURL
                guard FileManager.default.fileExists(atPath: url.path),
                      let data = try? Data(contentsOf: url.appendingPathComponent("Contents/Info.plist")),
                      let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
                      let bundleID = plist["CFBundleIdentifier"] as? String else { return nil }
                return Installation(path: url.path, isPWA: pwa, bundleID: bundleID,
                    version: (plist["CFBundleShortVersionString"] ?? plist["CFBundleVersion"]) as? String)
            }
        }
    }
    struct Installation: Identifiable {
        let path: String
        let isPWA: Bool
        let bundleID: String
        let version: String?
        var id: String { path }
    }
    enum ValidationError: LocalizedError {
        case invalid(String)
        var errorDescription: String? {
            if case let .invalid(message) = self { return message }
            return nil
        }
    }

    let schemaVersion: Int
    let auditedAt: String
    let authorizationPolicy: String
    let integrations: [Entry]

    static var sourceURL: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("config/integrations.json")
    }
    static func loadDefault() throws -> AppIntegrations {
        if let resources = Bundle.main.resourceURL {
            let bundled = resources.appendingPathComponent("Integrations.json")
            let packaged = FileManager.default.fileExists(atPath: resources.appendingPathComponent("RelayRuntime").path)
            if packaged || FileManager.default.fileExists(atPath: bundled.path) { return try load(from: bundled) }
        }
        return try load(from: sourceURL)
    }
    static func load(from url: URL) throws -> AppIntegrations {
        let catalog = try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
        guard catalog.schemaVersion == 1,
              !catalog.integrations.isEmpty,
              Set(catalog.integrations.map(\.id)).count == catalog.integrations.count else {
            throw ValidationError.invalid("应用目录版本不支持或 ID 重复。")
        }
        for entry in catalog.integrations {
            guard !entry.id.isEmpty, !entry.name.isEmpty, !entry.role.isEmpty,
                  !entry.officialSources.isEmpty,
                  Set(entry.capabilities.keys) == Set(["read", "write", "execute", "embed"]),
                  entry.capabilities.filter({ $0.key != "embed" }).values.allSatisfy({ !$0.available }),
                  entry.capabilities["embed"]?.available == !(entry.workspace ?? []).isEmpty,
                  entry.referenceRules.deepLinks.allSatisfy({ ["zotero-select", "obsidian-open"].contains($0) }) else {
                throw ValidationError.invalid("应用定义不完整，或声明了尚未实现的能力：\(entry.id)")
            }
            for destination in entry.workspace ?? [] {
                guard !destination.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw ValidationError.invalid("Hub 内入口缺少名称：\(entry.id)")
                }
                switch destination.kind {
                case .web:
                    guard let raw = destination.url else { throw ValidationError.invalid("Hub 内网页缺少地址：\(entry.id)") }
                    _ = try checkedHTTPS(raw)
                case .terminal:
                    guard entry.id == "ghostty", destination.url == nil else {
                        throw ValidationError.invalid("内置终端只允许 Hub 自建的本机交互 shell。")
                    }
                }
            }
            for path in entry.appPaths + entry.pwaPaths {
                guard (path.hasPrefix("/") || path.hasPrefix("~/")), path.hasSuffix(".app"),
                      !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
                    throw ValidationError.invalid("应用路径无效：\(entry.id)")
                }
            }
            for source in entry.officialSources { _ = try checkedHTTPS(source.url) }
        }
        return catalog
    }

    /// Routes create manual tabs only. They do not open local databases or copy
    /// another client's session, credentials, or task permissions.
    func workspaceRoutes(for entry: Entry) -> [WorkspaceRoute] {
        (entry.workspace ?? []).compactMap { destination in
            switch destination.kind {
            case .terminal:
                guard entry.id == "ghostty", destination.url == nil else { return nil }
                return .terminal(title: destination.title)
            case .web:
                guard let raw = destination.url, let fallback = try? Self.checkedHTTPS(raw) else { return nil }
                // Reuse the user's installed PWA shortcut when it belongs to the
                // same official host. Reading its plist never copies Chrome data.
                for installation in entry.metadata() where installation.isPWA {
                    let info = URL(fileURLWithPath: installation.path).appendingPathComponent("Contents/Info.plist")
                    if let plist = NSDictionary(contentsOf: info),
                       let shortcut = plist["CrAppModeShortcutURL"] as? String,
                       let url = try? Self.checkedHTTPS(shortcut), url.host == fallback.host {
                        return .web(title: destination.title, url: url)
                    }
                }
                return .web(title: destination.title, url: fallback)
            }
        }
    }

    func workspaceRoute(forAppPath path: String) -> WorkspaceRoute? {
        let canonical = URL(fileURLWithPath: (path as NSString).expandingTildeInPath).standardizedFileURL.resolvingSymlinksInPath()
        guard let entry = integrations.first(where: { entry in
            (entry.appPaths + entry.pwaPaths).contains { candidate in
                URL(fileURLWithPath: (candidate as NSString).expandingTildeInPath).standardizedFileURL.resolvingSymlinksInPath().path == canonical.path
            }
        }) else { return nil }
        return workspaceRoutes(for: entry).first
    }

    /// This validates a reference, not authorization to read, write, or execute it.
    /// Consumers should reveal file references in Finder instead of executing/opening scripts.
    func validateReference(_ raw: String, integrationID: String) throws -> String {
        guard let entry = integrations.first(where: { $0.id == integrationID }) else {
            throw ValidationError.invalid("未找到对应应用。")
        }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.utf8.count <= 8192,
              !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              !(value.removingPercentEncoding ?? value).unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw ValidationError.invalid("请填写不含控制字符的引用，长度不超过 8 KiB。")
        }
        if value.hasPrefix("/") || value.hasPrefix("~/") {
            guard entry.referenceRules.allowFiles else { throw ValidationError.invalid("此应用未启用文件引用。") }
            return try checkedFile(URL(fileURLWithPath: (value as NSString).expandingTildeInPath))
        }
        guard let components = URLComponents(string: value), let scheme = components.scheme?.lowercased(),
              components.user == nil, components.password == nil,
              !hasSensitiveParameters(components) else {
            throw ValidationError.invalid("引用格式无效，或包含账户凭据/令牌参数。")
        }
        if scheme == "https", entry.referenceRules.allowHTTPS { return try Self.checkedHTTPS(value).absoluteString }
        if scheme == "file", entry.referenceRules.allowFiles, let url = components.url { return try checkedFile(url) }
        if scheme == "zotero", entry.referenceRules.deepLinks.contains("zotero-select") {
            let pattern = #"^/(library|groups/[0-9]+)/(items|collections)/[A-Z0-9]{8}$"#
            guard components.host == "select", components.port == nil,
                  components.query == nil, components.fragment == nil,
                  components.path.range(of: pattern, options: .regularExpression) != nil,
                  let url = components.url else { throw ValidationError.invalid("只接受 Zotero 的 select 文献或集合定位链接。") }
            return url.absoluteString
        }
        if scheme == "obsidian", entry.referenceRules.deepLinks.contains("obsidian-open") {
            let items = components.queryItems ?? []
            let names = items.map(\.name)
            guard components.host == "open", components.port == nil,
                  components.path.isEmpty || components.path == "/",
                  components.fragment == nil, !items.isEmpty,
                  Set(names).count == names.count,
                  names.allSatisfy({ ["vault", "file", "path"].contains($0) }),
                  items.allSatisfy({ !($0.value ?? "").isEmpty }),
                  names.contains("vault") || names.contains("path"),
                  !items.contains(where: { $0.value?.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) == true }),
                  let url = components.url else { throw ValidationError.invalid("只接受 Obsidian open 定位链接；不允许写入、回调或剪贴板参数。") }
            return url.absoluteString
        }
        throw ValidationError.invalid("支持 HTTPS、现有本地文件，以及本应用明确允许的只读定位链接；不接受执行、远程连接或发信协议。")
    }
    static func validateReference(_ raw: String, integrationID: String) throws -> String {
        try loadDefault().validateReference(raw, integrationID: integrationID)
    }
    private func checkedFile(_ url: URL) throws -> String {
        guard url.isFileURL, url.host == nil || url.host == "" || url.host == "localhost",
              url.query == nil, url.fragment == nil else {
            throw ValidationError.invalid("文件引用必须是本机路径，不能包含远程主机或 URL 参数。")
        }
        let normalized = url.standardizedFileURL.resolvingSymlinksInPath()
        guard FileManager.default.fileExists(atPath: normalized.path) else {
            throw ValidationError.invalid("文件或目录不存在；不会自动创建。")
        }
        return normalized.absoluteString
    }
    private static func checkedHTTPS(_ raw: String) throws -> URL {
        guard let c = URLComponents(string: raw), c.scheme?.lowercased() == "https",
              let host = c.host, !host.isEmpty, !host.contains(where: { $0.isWhitespace }),
              c.user == nil, c.password == nil, !hasSensitiveParameters(c),
              let url = c.url else { throw ValidationError.invalid("需要不含凭据的有效 HTTPS 链接。") }
        return url
    }
    private static func hasSensitiveParameters(_ c: URLComponents) -> Bool {
        let protected = ["token", "accesstoken", "refreshtoken", "idtoken", "apikey", "key", "password", "passwd", "secret", "bootstrapsecret", "authorization", "code", "clientsecret"]
        func sensitive(_ key: String) -> Bool {
            let name = key.lowercased().filter { $0.isLetter || $0.isNumber }
            return protected.contains(name) || name.hasSuffix("token") || name.hasSuffix("secret")
        }
        if (c.queryItems ?? []).contains(where: { sensitive($0.name) }) { return true }
        // Hash-router fragments can contain their own query, e.g. #/route?token=….
        let fragment = (c.fragment ?? "").removingPercentEncoding ?? (c.fragment ?? "")
        return fragment.components(separatedBy: CharacterSet(charactersIn: "?&#")).contains { part in
            guard let separator = part.firstIndex(of: "=") else { return false }
            return sensitive(String(part[..<separator]))
        }
    }
    private func hasSensitiveParameters(_ c: URLComponents) -> Bool { Self.hasSensitiveParameters(c) }
}
