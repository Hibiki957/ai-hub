import Foundation

/// 陈旧写锁清理。
///
/// `@deepseek-ai/dsh-atomic-write` 用 `wx` 独占创建 `<文件>.lock`，内容为
/// `${process.pid}\n`（mode 384 = 0o600）。库的设计是**从不**主动删除已存在
/// 的锁——文档原话是文件年龄无法证明持有者已停止，孤儿锁的回收属于运维动作。
/// 于是 Harness 被 kill -9 或崩溃后，锁留在原地，下一次启动会一直等到
/// `DEFAULT_LOCK_WAIT_MS` 超时（2 秒）并抛
/// `atomic-write: timed out waiting for the writer lock at ...`。
///
/// 这里补上那个“运维动作”，判定条件与库本身一样窄：
/// 只认内容为纯 pid 且不超过 32 字节的锁，且该 pid 确实不存在才删除。
/// 目录、读不到的、格式不符的、以及活着的持有者一律不动。
///
/// 与 DSH Desktop 的 `stale-writer-locks.ts` 的差异：它只扫 `DSH_HOME` 与
/// `DSH_HOME/profiles` 两层，而本机 `task-board/ledger-v2.lock` 在第三层，
/// 因此这里按深度上限递归，并跳过 `node_modules` 等大体量目录。
enum StaleLockCleanup {
    struct Removal: CustomStringConvertible {
        let path: String
        let pid: Int32
        var description: String { "\(path)（原持有进程 \(pid) 已不存在）" }
    }

    /// 锁内容上限，与库的 MAX_LOCK_BYTES 一致。
    private static let maxLockBytes = 32
    /// 递归深度上限：DSH_HOME 下再走三层足够覆盖 profiles/、task-board/ 等。
    private static let maxDepth = 3
    /// 这些目录只可能装包，不可能是锁的宿主，跳过以免遍历 node_modules。
    private static let skippedDirectories: Set<String> = ["node_modules", ".git", "dist", "build"]

    /// 扫描并删除无主锁。只读探测 + 有限删除，不做任何其他改动。
    /// - Parameter home: DSH_HOME，默认 `~/.dsh`。
    /// - Returns: 实际删除的锁列表；未删除任何内容时为空数组。
    @discardableResult
    static func run(home: URL? = nil, isAlive: (Int32) -> Bool = processIsAlive) -> [Removal] {
        let root = home ?? defaultHome
        guard FileManager.default.fileExists(atPath: root.path) else { return [] }

        var removals: [Removal] = []
        var stack: [(URL, Int)] = [(root, 0)]
        while let (directory, depth) = stack.popLast() {
            guard depth <= maxDepth else { continue }
            let entries = (try? FileManager.default.contentsOfDirectory(
                at: directory, includingPropertiesForKeys: [.isDirectoryKey], options: []
            )) ?? []
            for entry in entries {
                let isDirectory = (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
                if isDirectory {
                    if skippedDirectories.contains(entry.lastPathComponent) { continue }
                    stack.append((entry, depth + 1))
                } else if entry.pathExtension == "lock", let removal = reap(entry, isAlive: isAlive) {
                    removals.append(removal)
                }
            }
        }
        return removals.sorted { $0.path < $1.path }
    }

    /// 单个锁的判定。任何不确定的情况都返回 nil（保留锁）。
    private static func reap(_ url: URL, isAlive: (Int32) -> Bool) -> Removal? {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = attributes[.size] as? Int, size <= maxLockBytes,
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .utf8) else { return nil }
        // 只接受 "<pid>" 或 "<pid>\n"；其他格式说明不是这个库写的，不碰。
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let pid = Int32(trimmed), pid > 0, String(pid) == trimmed else { return nil }
        guard !isAlive(pid) else { return nil }
        guard (try? FileManager.default.removeItem(at: url)) != nil else { return nil }
        return Removal(path: url.path, pid: pid)
    }

    /// `kill(pid, 0)`：ESRCH 表示进程不存在；EPERM 表示存在但属于别人。
    static func processIsAlive(_ pid: Int32) -> Bool {
        guard pid > 0 else { return false }
        if kill(pid, 0) == 0 { return true }
        return errno == EPERM
    }

    static var defaultHome: URL {
        if let configured = ProcessInfo.processInfo.environment["DSH_HOME"], !configured.isEmpty {
            return URL(fileURLWithPath: (configured as NSString).expandingTildeInPath)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".dsh")
    }

    /// 摘要文案，供 UI 与日志使用；无删除时说明未发现。
    static func summary(_ removals: [Removal]) -> String {
        guard !removals.isEmpty else { return "未发现无主写锁；未修改任何文件。" }
        return "已清理 \(removals.count) 个无主写锁：\n" + removals.map { "· " + $0.description }.joined(separator: "\n")
    }
}
