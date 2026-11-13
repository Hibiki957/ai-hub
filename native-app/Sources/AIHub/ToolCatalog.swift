import Foundation

/// Versioned base inventory. Personal overrides and live PWA discovery remain
/// separate layers; reading this file never launches tools or rewrites them.
struct ToolCatalog: Codable {
    struct CLILauncher: Codable, Identifiable {
        let id: String
        let productID: String
        let name: String
        let title: String
        var command: String
        var pathPrepend: [String]?
    }
    struct AppLauncher: Codable, Identifiable {
        let id: String
        let productID: String
        let name: String
        var path: String
    }
    struct Agent: Codable, Identifiable {
        let id: String
        let name: String
        let subtitle: String
        let transport: String
        var command: String?
        let args: [String]
    }
    struct WebLauncher: Codable, Identifiable {
        let id: String
        let name: String
        let url: String
    }
    struct Service: Codable {
        let port: Int
        var command: String
        var args: [String]
        var logPath: String
    }

    let schemaVersion: Int
    var pathEntries: [String]
    let primaryAgentIDs: [String]
    var cli: [CLILauncher]
    var apps: [AppLauncher]
    var agents: [Agent]
    let web: [WebLauncher]
    var localServices: [Service]

    enum CatalogError: LocalizedError {
        case invalid(String)
        var errorDescription: String? {
            if case let .invalid(message) = self { return "工具目录无效：" + message }
            return nil
        }
    }

    static var sourceURL: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("config/tool-catalog.json")
    }

    private static let loaded: Result<ToolCatalog, Error> = Result {
        let resources = Bundle.main.resourceURL!
        let bundled = resources.appendingPathComponent("ToolCatalog.json")
        // Installed apps must use their own packaged catalog, even when the
        // source checkout happens to be available on the same computer.
        let isPackaged = FileManager.default.fileExists(atPath: resources.appendingPathComponent("RelayRuntime").path)
        return try load(from: FileManager.default.fileExists(atPath: bundled.path) || isPackaged ? bundled : sourceURL)
    }
    static var shared: ToolCatalog {
        (try? loaded.get()) ?? ToolCatalog(schemaVersion: 1, pathEntries: [], primaryAgentIDs: [], cli: [], apps: [], agents: [], web: [], localServices: [])
    }
    static var loadError: String? {
        if case let .failure(error) = loaded { return error.localizedDescription }
        return nil
    }

    static func expand(_ path: String) -> String {
        (path as NSString).expandingTildeInPath
    }

    static func load(from url: URL) throws -> ToolCatalog {
        var catalog = try JSONDecoder().decode(ToolCatalog.self, from: Data(contentsOf: url))
        guard catalog.schemaVersion == 1 else { throw CatalogError.invalid("不支持的 schemaVersion") }
        func unique(_ ids: [String], _ label: String) throws {
            guard ids.allSatisfy({ !$0.isEmpty }), Set(ids).count == ids.count else {
                throw CatalogError.invalid(label + " ID 为空或重复")
            }
        }
        try unique(catalog.cli.map(\.id) + catalog.apps.map(\.id), "入口")
        try unique(catalog.agents.map(\.id), "执行器")
        try unique(catalog.primaryAgentIDs, "主力")
        guard catalog.primaryAgentIDs.allSatisfy({ id in catalog.agents.contains { $0.id == id } }) else {
            throw CatalogError.invalid("主力执行器没有对应定义")
        }
        guard catalog.agents.allSatisfy({ ["acp", "zcode-tui-engine"].contains($0.transport) && ($0.transport != "acp" || !($0.command ?? "").isEmpty) }),
              catalog.cli.allSatisfy({ !$0.command.isEmpty && !$0.name.isEmpty }),
              catalog.apps.allSatisfy({ !$0.path.isEmpty && !$0.name.isEmpty }),
              catalog.localServices.allSatisfy({ (1...65535).contains($0.port) && !$0.command.isEmpty && !$0.logPath.isEmpty }),
              Set(catalog.localServices.map(\.port)).count == catalog.localServices.count else {
            throw CatalogError.invalid("启动入口或服务定义不完整")
        }
        catalog.pathEntries = catalog.pathEntries.map(expand)
        for i in catalog.cli.indices {
            catalog.cli[i].command = expand(catalog.cli[i].command)
            catalog.cli[i].pathPrepend = catalog.cli[i].pathPrepend?.map(expand)
        }
        for i in catalog.apps.indices { catalog.apps[i].path = expand(catalog.apps[i].path) }
        for i in catalog.agents.indices { catalog.agents[i].command = catalog.agents[i].command.map(expand) }
        for i in catalog.localServices.indices {
            catalog.localServices[i].command = expand(catalog.localServices[i].command)
            catalog.localServices[i].args = catalog.localServices[i].args.map(expand)
            catalog.localServices[i].logPath = expand(catalog.localServices[i].logPath)
        }
        return catalog
    }

    var primaryAgents: [Agent] { primaryAgentIDs.compactMap { id in agents.first { $0.id == id } } }
    func localService(port: Int) -> Service? { localServices.first { $0.port == port } }

    /// Read-only entry validation. A saved launcher is not evidence that its
    /// executable is still installed. Follow aliases, but never run a command
    /// (or interpret a user's command as shell code) while browsing the library.
    static func isAvailableCommand(_ path: String) -> Bool {
        let expanded = expand(path)
        guard expanded.hasPrefix("/"),
              let values = try? URL(fileURLWithPath: expanded).resolvingSymlinksInPath()
                .resourceValues(forKeys: [.isRegularFileKey]),
              values.isRegularFile == true else { return false }
        return FileManager.default.isExecutableFile(atPath: expanded)
    }

    static func isAvailableApp(_ path: String) -> Bool {
        let expanded = expand(path)
        guard expanded.hasPrefix("/"),
              let executable = Bundle(path: expanded)?.executableURL else { return false }
        // Bundle also supports apps whose executable uses the bundle's default
        // name, e.g. Muse; CFBundleExecutable is not always explicitly present.
        return isAvailableCommand(executable.path)
    }

    /// Keep the first preferred display entry; aliases of the same file do not
    /// become multiple sidebar rows. Distinct products/bundles stay distinct.
    static func deduplicated<T>(_ entries: [T], path: (T) -> String) -> [T] {
        var seen = Set<String>()
        return entries.filter { entry in
            let expanded = expand(path(entry))
            let url = URL(fileURLWithPath: expanded).standardizedFileURL
            let key = FileManager.default.fileExists(atPath: expanded) ? url.resolvingSymlinksInPath().path : url.path
            return seen.insert(key).inserted
        }
    }
}
