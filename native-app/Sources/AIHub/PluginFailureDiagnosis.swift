import Foundation

/// Harness 启动/渲染失败的插件归因。
///
/// 现状：`TabStore.startLocalServer` 只做 `nohup ... >> logPath 2>&1 &`，
/// 日志落盘后没人读。于是“client.js loaded without registering”这类失败
/// 只能靠人肉 grep 判断是哪个插件。
///
/// 这里把证据收成一条可执行结论：读日志尾部 → 匹配已知失败签名 → 用
/// profile 的 bundle/依赖清单把包名归属到具体插件 → 给出定向操作建议。
/// 只读日志与清单，不加载插件代码，不执行任何修复动作。
enum PluginFailureDiagnosis {
    /// 一条已识别的失败。
    struct Finding: Identifiable, Equatable {
        enum Kind: String {
            case unregisteredBundle = "客户端 bundle 加载后未注册"
            case missingModule = "缺少依赖模块"
            case applyFailed = "插件应用失败"
            case lockTimeout = "写锁超时"
            var label: String { rawValue }
        }
        let id = UUID()
        let kind: Kind
        /// 失败直接涉及的包名（可能为空：签名里没带包名时）。
        let packageName: String?
        /// 原始日志行，保留以便核对。
        let evidence: String
        /// 归属到的插件及其版本/目录；未归属到时为空。
        let owner: Owner?

        struct Owner: Equatable {
            let packageName: String
            let version: String?
            let directory: String?
        }
        static func == (lhs: Finding, rhs: Finding) -> Bool {
            lhs.kind == rhs.kind && lhs.packageName == rhs.packageName && lhs.evidence == rhs.evidence
        }
    }

    struct Report {
        var scannedPaths: [String] = []
        var findings: [Finding] = []
        var note: String = ""
        var isEmpty: Bool { findings.isEmpty }

        var summary: String {
            guard !findings.isEmpty else {
                return scannedPaths.isEmpty
                    ? "未找到可读的 Harness 日志；无法归因。"
                    : "已读 \(scannedPaths.count) 个日志，未匹配到已知插件失败签名。"
            }
            var lines = ["匹配到 \(findings.count) 条失败："]
            for finding in findings {
                let owner = finding.owner.map { " → \($0.packageName)" + ($0.version.map { " \($0)" } ?? "") } ?? " → 未能归属到已安装插件"
                lines.append("· [\(finding.kind.label)] \(finding.packageName ?? "(未知包)")\(owner)")
            }
            if !note.isEmpty { lines.append(note) }
            return lines.joined(separator: "\n")
        }
    }

    /// 已知失败签名。每条：正则 + 类型 + 捕获包名的分组序号。
    /// 全部来自本机已安装的 DSH / cordis 源码，不凭印象编造。
    private static let signatures: [(pattern: String, kind: Finding.Kind, group: Int?)] = [
        // @deepseek-ai/dsh-client-modules/lib/client.js
        (#"client-modules: bundle (\S+) loaded without registering "([^"]+)""#, .unregisteredBundle, 2),
        // Node ESM / pnpm 解析失败
        (#"Cannot find package '([^']+)'"#, .missingModule, 1),
        (#"ERR_MODULE_NOT_FOUND[^\n]*?'([^']+)'"#, .missingModule, 1),
        // cordis-plugin-loader
        (#"loader entries failed to apply"#, .applyFailed, nil),
        (#"failed to apply"#, .applyFailed, nil),
        // @deepseek-ai/dsh-atomic-write
        (#"atomic-write: timed out waiting for the writer lock at (\S+)"#, .lockTimeout, 1),
    ]

    /// 默认日志位置：DSH 自己的 logs 目录、launch-dsh.sh 的两处输出、
    /// 以及 Desktop 壳的 harness.log。
    static var defaultLogPaths: [String] {
        let home = NSHomeDirectory()
        return [
            home + "/.dsh/logs/web.log",
            "/tmp/dsh-web.log",
            home + "/workspace/logs/dsh-launch.log",
            home + "/workspace/logs/dsh-launch.err.log",
            home + "/Library/Logs/DeepSeek Harness/harness.log",
        ]
    }

    /// 扫描并归因。日志只读尾部，避免把 40 MB 的历史日志整个读进内存。
    static func run(logPaths: [String]? = nil, dshHome: URL? = nil, tailBytes: Int = 512 * 1024) -> Report {
        var report = Report()
        let paths = logPaths ?? defaultLogPaths
        let installed = InstalledPlugins.load(home: dshHome ?? StaleLockCleanup.defaultHome)

        for path in paths {
            guard let data = readTail(URL(fileURLWithPath: path), limit: tailBytes) else { continue }
            report.scannedPaths.append(path)
            let text = String(decoding: data, as: UTF8.self)
            for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
                let lineText = String(line)
                for signature in signatures {
                    guard let expression = try? NSRegularExpression(pattern: signature.pattern),
                          let match = expression.firstMatch(in: lineText, range: NSRange(lineText.startIndex..., in: lineText)) else { continue }
                    var name: String?
                    if let group = signature.group, group < match.numberOfRanges,
                       let range = Range(match.range(at: group), in: lineText) {
                        name = String(lineText[range])
                    }
                    let owner = name.flatMap { installed.owner(of: $0) }
                    let finding = Finding(kind: signature.kind, packageName: name, evidence: lineText, owner: owner)
                    if !report.findings.contains(where: { $0.kind == finding.kind && $0.evidence == finding.evidence }) {
                        report.findings.append(finding)
                    }
                }
            }
        }
        report.findings = Array(report.findings.prefix(50))
        report.note = guidance(for: report.findings)
        return report
    }

    /// 归因结论对应的最小动作建议。只描述可选操作，不代替用户决定。
    static func guidance(for findings: [Finding]) -> String {
        guard !findings.isEmpty else { return "" }
        var steps: [String] = []
        if findings.contains(where: { $0.kind == .unregisteredBundle }) {
            steps.append("未注册的 bundle 通常是包名与自身 exports.name 不一致，或目录被就地替换；先核对归属插件的 package.json 与 client.js 的 exports.name，再考虑升级或停用该插件。")
        }
        if findings.contains(where: { $0.kind == .missingModule }) {
            steps.append("缺少依赖模块说明 profile 的 pnpm 树不完整；可在该 profile 目录重装依赖后重试。")
        }
        if findings.contains(where: { $0.kind == .lockTimeout }) {
            steps.append("写锁超时可用「清理无主写锁」处理：判定只看锁内 pid 是否仍存在。")
        }
        steps.append("确认是某个第三方插件导致后，可用「最小核心 profile」隔离启动，再逐个启用以定位。")
        return steps.joined(separator: "\n")
    }

    private static func readTail(_ url: URL, limit: Int) -> Data? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        guard let end = try? handle.seekToEnd() else { return nil }
        let start = end > UInt64(limit) ? end - UInt64(limit) : 0
        try? handle.seek(toOffset: start)
        return try? handle.read(upToCount: limit)
    }

    /// 已安装插件清单：包名 → 版本 + 目录。
    /// 只读 `profiles/node_modules` 与各 profile 的依赖声明，不执行插件代码。
    struct InstalledPlugins {
        private var entries: [String: Finding.Owner] = [:]

        func owner(of packageName: String) -> Finding.Owner? { entries[packageName] }

        static func load(home: URL) -> InstalledPlugins {
            var result = InstalledPlugins()
            let fileManager = FileManager.default
            let profiles = home.appendingPathComponent("profiles")
            let modules = profiles.appendingPathComponent("node_modules")
            // 顶层别名与 @scope/name 两种布局都要覆盖。
            for base in [modules, modules.appendingPathComponent("@deepseek-ai")] {
                let names = (try? fileManager.contentsOfDirectory(atPath: base.path)) ?? []
                for name in names {
                    let directory = base.appendingPathComponent(name)
                    let manifest = directory.appendingPathComponent("package.json")
                    guard let data = try? Data(contentsOf: manifest),
                          let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                          let declared = object["name"] as? String else { continue }
                    // 顶层别名目录名可能与包名不同；两个键都登记。
                    let owner = Finding.Owner(packageName: declared,
                                              version: object["version"] as? String,
                                              directory: directory.path)
                    result.entries[declared] = owner
                    if name != declared, !name.hasPrefix("@") { result.entries[name] = owner }
                }
            }
            return result
        }
    }
}
