import Foundation

// 四个新增能力的离线回归：不启动 Harness、不读写用户 ~/.dsh、不加载插件代码。
// 全部在临时目录里构造 fixture，用真实格式验证判定逻辑。

@main
struct HarnessHygieneRegression {
    struct Failure: Error, CustomStringConvertible { let description: String }

    static func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        guard condition() else { throw Failure(description: message) }
        print("PASS: \(message)")
    }

    static func main() {
        do {
            let root = URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("aihub-hygiene-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }

            try testShellEnvironmentParsing()
            try testShellPathMerge()
            try testStaleLockSweep(root: root)
            try testPluginDiagnosis(root: root)
            try testMinimalCoreProfile(root: root)
            print("ALL HARNESS HYGIENE REGRESSIONS PASSED")
        } catch {
            fputs("FAIL: \(error)\n", stderr)
            exit(1)
        }
    }

    // MARK: - 1. 登录 shell 环境

    static func testShellEnvironmentParsing() throws {
        // 值里含 `=`、含空格、含中文都必须原样保留。
        let text = """
        PATH=/a:/b
        HOME=/Users/runner
        LANG=zh_CN.UTF-8
        WEIRD=a=b=c
        SPACED=hello world
        CJK=中文值

        BADLINE
        =noName
        """
        let parsed = ShellEnvironment.parse(text)
        try check(parsed["PATH"] == "/a:/b", "shell env: PATH 按第一个 = 切分")
        try check(parsed["WEIRD"] == "a=b=c", "shell env: 值内的 = 保留")
        try check(parsed["SPACED"] == "hello world", "shell env: 值内空格保留")
        try check(parsed["CJK"] == "中文值", "shell env: UTF-8 值保留")
        try check(parsed["BADLINE"] == nil && parsed[""] == nil, "shell env: 无 = 的行与空名被丢弃")

        // 解码失败的值不可信，必须丢弃而不是传下去。
        let broken = ShellEnvironment.parse("PATH=/a\u{FFFD}/b\nOK=/c")
        try check(broken["PATH"] == nil, "shell env: 含替换字符的值被丢弃")
        try check(broken["OK"] == "/c", "shell env: 同批次其他正常值仍保留")
        try check(!ShellEnvironment.isResolved || ShellEnvironment.baseEnvironment["HOME"] != nil,
                  "shell env: 未抓取时 baseEnvironment 仍可用")
    }

    static func testShellPathMerge() throws {
        let merged = ShellEnvironment.mergePath(catalog: "/a:/b", captured: "/b:/c:/a:/d")
        try check(merged == "/a:/b:/c:/d", "shell PATH: 顺序保留且去重")
        let onlyCatalog = ShellEnvironment.mergePath(catalog: "/a:/b", captured: nil)
        try check(onlyCatalog == "/a:/b", "shell PATH: 无抓取结果时等价于原行为")
        let empty = ShellEnvironment.mergePath(catalog: "", captured: "")
        try check(empty.isEmpty, "shell PATH: 全空时不产生空条目")
    }

    // MARK: - 2. 陈旧写锁

    static func testStaleLockSweep(root: URL) throws {
        let home = root.appendingPathComponent("dsh-home")
        let nested = home.appendingPathComponent("task-board")
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)

        // 活的持有者：用本进程 pid，绝不能被删。
        let liveLock = home.appendingPathComponent("live.json.lock")
        try "\(ProcessInfo.processInfo.processIdentifier)\n".write(to: liveLock, atomically: true, encoding: .utf8)

        // 死的 pid：格式正确，应删。
        let deadLock = home.appendingPathComponent("dead.json.lock")
        try "999999\n".write(to: deadLock, atomically: true, encoding: .utf8)

        // 深层目录里的死锁：DSH Desktop 只扫两层会漏，这里必须覆盖。
        let deepLock = nested.appendingPathComponent("ledger-v2.lock")
        try "999998".write(to: deepLock, atomically: true, encoding: .utf8)

        // 非 pid 内容（真实 ledger-v2.lock 是 JSON）：必须原样保留。
        let jsonLock = nested.appendingPathComponent("json-format.lock")
        try #"{"pid":6375,"token":"x"}"#.write(to: jsonLock, atomically: true, encoding: .utf8)

        // 超大文件：超出 32 字节上限，不认。
        let bigLock = home.appendingPathComponent("big.lock")
        try String(repeating: "9", count: 64).write(to: bigLock, atomically: true, encoding: .utf8)

        // 非 .lock 后缀：不碰。
        let otherFile = home.appendingPathComponent("notes.txt")
        try "999999\n".write(to: otherFile, atomically: true, encoding: .utf8)

        let removals = StaleLockCleanup.run(home: home)
        let removed = Set(removals.map { URL(fileURLWithPath: $0.path).lastPathComponent })
        try check(removed == ["dead.json.lock", "ledger-v2.lock"], "lock: 仅删除无主且格式正确的锁，含深层目录")
        try check(!FileManager.default.fileExists(atPath: deadLock.path), "lock: 无主锁文件已消失")
        try check(FileManager.default.fileExists(atPath: liveLock.path), "lock: 活着的持有者不被删除")
        try check(FileManager.default.fileExists(atPath: jsonLock.path), "lock: 非 pid 格式（JSON）不被删除")
        try check(FileManager.default.fileExists(atPath: bigLock.path), "lock: 超出 32 字节上限的不被删除")
        try check(FileManager.default.fileExists(atPath: otherFile.path), "lock: 非 .lock 后缀不被删除")
        try check(StaleLockCleanup.summary(removals).contains("已清理 2 个"), "lock: 摘要给出数量")

        // 幂等：再跑一次不应再有删除。
        try check(StaleLockCleanup.run(home: home).isEmpty, "lock: 第二次扫描无新增删除")
        // 不存在的 home 不应崩溃。
        try check(StaleLockCleanup.run(home: root.appendingPathComponent("absent")).isEmpty,
                  "lock: 不存在的 DSH_HOME 返回空而不是报错")
    }

    // MARK: - 3. 插件失败归因

    static func testPluginDiagnosis(root: URL) throws {
        // 造一个最小 profile 树：一个真插件 + 一个别名目录。
        let home = root.appendingPathComponent("diag-home")
        let scoped = home.appendingPathComponent("profiles/node_modules/@deepseek-ai/dsh-broken")
        try FileManager.default.createDirectory(at: scoped, withIntermediateDirectories: true)
        let manifest: [String: Any] = ["name": "@deepseek-ai/dsh-broken", "version": "1.2.3"]
        try JSONSerialization.data(withJSONObject: manifest)
            .write(to: scoped.appendingPathComponent("package.json"))

        let log = root.appendingPathComponent("web.log")
        let content = """
        info: starting
        client-modules: bundle http://127.0.0.1/x/bundle.js loaded without registering "@deepseek-ai/dsh-broken" via __ModuleLoader__.load
        Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-absent' imported from /x
        atomic-write: timed out waiting for the writer lock at /Users/runner/.dsh/profiles/web/package.json.lock
        unrelated line about something else
        """
        try content.write(to: log, atomically: true, encoding: .utf8)

        let report = PluginFailureDiagnosis.run(logPaths: [log.path], dshHome: home)
        try check(report.scannedPaths == [log.path], "diag: 记录已扫描的日志")
        let kinds = Set(report.findings.map(\.kind))
        try check(kinds.contains(.unregisteredBundle), "diag: 识别 bundle 未注册")
        try check(kinds.contains(.missingModule), "diag: 识别缺少依赖模块")
        try check(kinds.contains(.lockTimeout), "diag: 识别写锁超时")

        let unregistered = report.findings.first { $0.kind == .unregisteredBundle }
        try check(unregistered?.packageName == "@deepseek-ai/dsh-broken", "diag: 从未注册签名里取出包名")
        try check(unregistered?.owner?.version == "1.2.3", "diag: 归因到已安装插件的版本")

        let missing = report.findings.first { $0.kind == .missingModule }
        try check(missing?.packageName == "@deepseek-ai/dsh-absent", "diag: 从 ERR_MODULE_NOT_FOUND 取出包名")
        try check(missing?.owner == nil, "diag: 未安装的包不虚构归属")
        try check(!report.summary.isEmpty && report.summary.contains("匹配到"), "diag: 摘要包含匹配数量")
        try check(PluginFailureDiagnosis.guidance(for: report.findings).contains("最小核心 profile"),
                  "diag: 建议里指向最小核心 profile")

        // 无日志路径时不崩溃、结论诚实。
        let empty = PluginFailureDiagnosis.run(logPaths: [root.appendingPathComponent("nope.log").path], dshHome: home)
        try check(empty.findings.isEmpty && empty.summary.contains("无法归因"), "diag: 无日志时明确说明无法归因")
    }

    // MARK: - 4. 最小核心 profile

    static func testMinimalCoreProfile(root: URL) throws {
        let home = root.appendingPathComponent("min-home")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)

        let plan = try MinimalCoreProfile.plan(home: home)
        try check(plan.exists == false, "minimal: 初始状态标记为待创建")

        let created = try MinimalCoreProfile.create(home: home)
        try check(FileManager.default.fileExists(atPath: created.directory.appendingPathComponent("package.json").path),
                  "minimal: package.json 已写入")
        let data = try Data(contentsOf: created.directory.appendingPathComponent("package.json"))
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let bundles = ((object?["dsh"] as? [String: Any])?["profile"] as? [String: Any])?["bundles"] as? [String]
        try check(bundles == MinimalCoreProfile.coreBundles, "minimal: bundle 只含官方核心两层")
        try check((object?["dependencies"] as? [String: Any])?.isEmpty == true, "minimal: 不复制第三方依赖")

        let patch = try String(contentsOf: created.directory.appendingPathComponent("cordis.patch.yml"), encoding: .utf8)
        try check(patch.contains("[]"), "minimal: patch 层刻意留空")
        try check(FileManager.default.fileExists(atPath: created.directory.appendingPathComponent("pnpm-workspace.yaml").path),
                  "minimal: pnpm-workspace.yaml 已写入")

        // 幂等：第二次不再报告创建，也不抛错。
        let again = try MinimalCoreProfile.create(home: home)
        try check(again.exists, "minimal: 第二次调用识别为已存在")

        // 同名但内容不同：拒绝覆盖。
        let other = root.appendingPathComponent("other-home/profiles/custom")
        try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)
        try #"{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","third-party-x"]}}}"#
            .write(to: other.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
        do {
            _ = try MinimalCoreProfile.plan(name: "custom", home: root.appendingPathComponent("other-home"))
            throw Failure(description: "minimal: 同名非最小核心 profile 必须拒绝")
        } catch is MinimalCoreProfile.SetupError {
            print("PASS: minimal: 同名非最小核心 profile 被拒绝而不是覆盖")
        }

        // 非法名字。
        do {
            _ = try MinimalCoreProfile.plan(name: "../escape", home: home)
            throw Failure(description: "minimal: 非法 profile 名必须拒绝")
        } catch is MinimalCoreProfile.SetupError {
            print("PASS: minimal: 含路径分隔符的名字被拒绝")
        }

        try check(MinimalCoreProfile.launchCommand().starts(with: ["dsh", "--profile"]), "minimal: 启动命令使用 --profile")
        try check(MinimalCoreProfile.caveats.contains("第三方插件"), "minimal: 说明里写明第三方插件不可用")
    }
}
