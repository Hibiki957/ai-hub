import Foundation

/// 登录 shell 环境捕获。
///
/// App 从 Finder / Dock / 登录项启动时，继承的是 launchd 的最小环境，
/// 从不 source `~/.zshenv`、`~/.zprofile`、`~/.zshrc`。结果是 nvm、mise、
/// bun、cargo、brew 装出来的可执行文件对 App 及其子进程（终端 PTY、
/// 执行器、relay、MCP 客户端）全部不可见，只能靠 `tool-catalog.json` 的
/// `pathEntries` 手工补。这里改为启动时跑一次登录+交互 shell 抓完整环境。
///
/// 抓取只在 `prewarm()` 里异步发生，主线程只读结果；抓取未完成或失败时
/// `baseEnvironment` 回落到进程自身环境，行为与改动前一致。
enum ShellEnvironment {
    /// 抓取到的完整环境；nil 表示尚未完成或已失败。
    private static let box = Box()

    private final class Box: @unchecked Sendable {
        private let lock = NSLock()
        private var value: [String: String]?
        private var inFlight = false
        func resolved() -> [String: String]? { lock.lock(); defer { lock.unlock() }; return value }
        func store(_ environment: [String: String]) { lock.lock(); value = environment; lock.unlock() }
        func begin() -> Bool {
            lock.lock(); defer { lock.unlock() }
            if inFlight || value != nil { return false }
            inFlight = true
            return true
        }
    }

    /// 登录 + 交互 shell 会 source `~/.zprofile`（Homebrew、OrbStack）与
    /// `~/.zshrc`（mise shims、~/.local/bin、cargo、go）。`-i` 让 rc 生效，
    /// stderr 丢弃以压掉提示符噪声。
    private static var capture: (file: String, args: [String], timeout: TimeInterval) {
        (file: ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh",
         args: ["-l", "-i", "-c", "env"],
         timeout: 10)
    }

    /// 启动时调用一次，与 App 启动并行；重复调用无副作用。
    static func prewarm() {
        // 诊断/回归测试可显式关闭，避免在无用户 shell 的环境里挂住。
        guard ProcessInfo.processInfo.environment["AIHUB_NO_SHELL_CAPTURE"] != "1" else { return }
        guard box.begin() else { return }
        let spec = capture
        DispatchQueue.global(qos: .utility).async {
            box.store(run(spec) ?? [:])
        }
    }

    private static func run(_ spec: (file: String, args: [String], timeout: TimeInterval)) -> [String: String]? {
        let process = Process(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: spec.file)
        process.arguments = spec.args
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        do { try process.run() } catch { return nil }

        // 与 DSH Desktop 同款超时：读满即返回，超时终止且不采用半截输出。
        let deadline = Date().addingTimeInterval(spec.timeout)
        var data = Data()
        let handle = output.fileHandleForReading
        while true {
            let chunk = handle.availableData
            if chunk.isEmpty { break }
            data.append(chunk)
            if data.count > 4 * 1024 * 1024 { break }
            if Date() > deadline { process.terminate(); return nil }
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }
        let parsed = parse(String(decoding: data, as: UTF8.self))
        return parsed.isEmpty ? nil : parsed
    }

    /// `env` 输出：每行 `NAME=VALUE`，值里可以含 `=`，按第一个 `=` 切。
    static func parse(_ text: String) -> [String: String] {
        var result: [String: String] = [:]
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let separator = line.firstIndex(of: "=") else { continue }
            let name = String(line[line.startIndex..<separator])
            let value = String(line[line.index(after: separator)...])
            guard !name.isEmpty, !name.contains(where: { $0 == " " || $0 == "\t" }) else { continue }
            // 抓取过程若在某个字符上解码失败，该值不可信；宁可不采用。
            guard !value.unicodeScalars.contains("\u{FFFD}") else { continue }
            result[name] = value
        }
        return result
    }

    /// 子进程环境基底：抓取成功用抓取结果，否则用进程自身环境。
    /// 任何情况下都保留进程已有的 `HOME` / `TMPDIR` 等，避免 shell 改写。
    static var baseEnvironment: [String: String] {
        let inherited = ProcessInfo.processInfo.environment
        guard let captured = box.resolved(), !captured.isEmpty else { return inherited }
        var merged = captured
        for key in ["HOME", "TMPDIR", "LANG", "LC_ALL"] {
            if let value = inherited[key] { merged[key] = value }
        }
        return merged
    }

    /// 抓取是否已生效。UI 与回归检查据此判断“环境已完整”。
    static var isResolved: Bool { box.resolved() != nil }

    /// 注入 PTY 子进程的额外变量。
    ///
    /// Ghostty 的 `envVars` 是**叠加**在子进程继承环境之上的，因此这里只需
    /// 补充 App 从 launchd 继承不到的部分。`HOME` / `TMPDIR` 由宿主决定，
    /// 不从 profile 覆盖，避免 shell 改写把子进程带离用户实际目录。
    static var terminalInjection: [String: String] {
        guard isResolved else { return [:] }
        var environment = baseEnvironment
        environment.removeValue(forKey: "HOME")
        environment.removeValue(forKey: "TMPDIR")
        return environment
    }

    /// 目录条目按顺序去重，供 PATH 拼接。
    static func mergePath(catalog: String, captured: String?) -> String {
        var seen = Set<String>()
        let parts = catalog.split(separator: ":").map(String.init)
            + (captured?.split(separator: ":").map(String.init) ?? [])
        return parts.filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: ":")
    }
}
