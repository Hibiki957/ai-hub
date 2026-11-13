import Foundation

/// 最小核心 profile（隔离启动）。
///
/// 本机 `~/.dsh/profiles/node_modules` 下挂着 249 个第三方包。其中任何一个
/// 在启动或前端渲染阶段失败，整个 Harness 就进不去，而当前没有退路。
///
/// 做法与 DSH Desktop 的 Safe Mode 相同：另建一个只声明官方核心 bundle 的
/// profile，第三方 bundle 与其 patch 层都不加载，但 Agent、会话、模型配置和
/// 工作区仍可用（它们由 DSH_HOME 而非 profile 决定）。这样即使正常 profile
/// 被插件搞坏，也还有一条能启动的路径去逐个排查。
///
/// 这里是**非破坏性**的：只创建新 profile 目录，绝不改写 `web` profile 的
/// 任何文件，也不启停正在运行的 Harness。启动动作交给用户确认后执行。
enum MinimalCoreProfile {
    /// 官方核心 bundle，取自本机 `~/.dsh/profiles/desktop/package.json`
    /// 的既有组合（官方桌面壳用的就是这两层）。
    static let coreBundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]

    /// 默认 profile 名。带 `aihub-` 前缀，避免与官方 `rescue`、桌面壳的
    /// `desktop-safe-mode` 撞名。
    static let defaultName = "aihub-minimal"

    struct Plan {
        let name: String
        let directory: URL
        /// true 表示目录已存在且内容符合最小核心定义，无需写入。
        let exists: Bool
        var summary: String {
            exists
                ? "最小核心 profile「\(name)」已存在：\(directory.path)"
                : "将创建最小核心 profile「\(name)」：\(directory.path)"
        }
    }

    enum SetupError: LocalizedError {
        case invalidName(String)
        case alreadyExists(String)
        case writeFailed(String)
        var errorDescription: String? {
            switch self {
            case .invalidName(let name): return "profile 名不合法：\(name)。只允许字母、数字、连字符和下划线。"
            case .alreadyExists(let name): return "profile「\(name)」已存在且不是最小核心组合；不会覆盖，请换名或先手工核对。"
            case .writeFailed(let message): return "写入最小核心 profile 失败：\(message)"
            }
        }
    }

    /// 只计算计划，不落盘。UI 先给用户看这一步。
    static func plan(name: String = defaultName, home: URL? = nil) throws -> Plan {
        guard !name.isEmpty,
              name.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil else {
            throw SetupError.invalidName(name)
        }
        let root = (home ?? StaleLockCleanup.defaultHome).appendingPathComponent("profiles").appendingPathComponent(name)
        let manifest = root.appendingPathComponent("package.json")
        if let data = try? Data(contentsOf: manifest),
           let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let dsh = object["dsh"] as? [String: Any],
           let profile = dsh["profile"] as? [String: Any],
           let bundles = profile["bundles"] as? [String] {
            guard Set(bundles) == Set(coreBundles) else { throw SetupError.alreadyExists(name) }
            return Plan(name: name, directory: root, exists: true)
        }
        // 目录存在但没有可识别的 package.json：不擅自覆盖。
        if FileManager.default.fileExists(atPath: root.path),
           FileManager.default.fileExists(atPath: manifest.path) == false {
            throw SetupError.alreadyExists(name)
        }
        return Plan(name: name, directory: root, exists: false)
    }

    /// 执行创建。幂等：已符合最小核心定义时直接返回，不重写文件。
    /// - Returns: 实际创建（或已存在）的目录。
    @discardableResult
    static func create(name: String = defaultName, home: URL? = nil) throws -> Plan {
        let plan = try plan(name: name, home: home)
        guard !plan.exists else { return plan }
        let fileManager = FileManager.default
        do {
            try fileManager.createDirectory(at: plan.directory, withIntermediateDirectories: true,
                                            attributes: [.posixPermissions: 0o700])
            // package.json：只声明核心 bundle，不复制 web profile 的依赖。
            let manifest: [String: Any] = [
                "name": "dsh-profile-\(name)",
                "private": true,
                "dependencies": [:],
                "dsh": ["profile": ["bundles": coreBundles]],
            ]
            let data = try JSONSerialization.data(withJSONObject: manifest,
                                                  options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
            try data.write(to: plan.directory.appendingPathComponent("package.json"), options: .atomic)
            // cordis.yml 与 patch 层都留空：第三方 patch 层正是要排除的东西。
            try emptyRootYAML.write(to: plan.directory.appendingPathComponent("cordis.yml"),
                                    atomically: true, encoding: .utf8)
            try emptyPatchYAML.write(to: plan.directory.appendingPathComponent("cordis.patch.yml"),
                                     atomically: true, encoding: .utf8)
            try pnpmWorkspace.write(to: plan.directory.appendingPathComponent("pnpm-workspace.yaml"),
                                    atomically: true, encoding: .utf8)
        } catch {
            throw SetupError.writeFailed(error.localizedDescription)
        }
        return Plan(name: name, directory: plan.directory, exists: false)
    }

    /// 启动命令。`--profile` 是 dsh 启动器的官方参数，`web` 是其别名；
    /// 这里用完整形式以便名字可换。不自动执行。
    static func launchCommand(name: String = defaultName) -> [String] {
        ["dsh", "--profile", name]
    }

    /// 需要用户知道的影响与边界。
    static let caveats = """
    该 profile 只加载官方核心 bundle；第三方插件、Skill 与 MCP 在此 profile 下不可用。
    Agent、会话、模型配置和工作区来自 DSH_HOME，因此仍然可用。
    创建过程不改写 web profile 的任何文件，也不启停正在运行的 Harness。
    """

    private static let emptyRootYAML = """
    # dsh profile root — an empty entry list. The tree is composed as patches:
    # each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml.
    # AI Hub 最小核心 profile：不加载任何第三方 patch 层。
    []
    """

    private static let emptyPatchYAML = """
    # AI Hub 最小核心 profile 的 patch 层：刻意为空。
    # 正常 profile 的插件在这里被整体排除，用于隔离启动。
    []
    """

    private static let pnpmWorkspace = """
    packages:
      - .

    nodeLinker: hoisted
    autoInstallPeers: false
    """
}
