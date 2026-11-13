import Foundation
import SwiftUI

/// Harness 运行环境自检：登录 shell 环境、无主写锁、插件失败归因、最小核心 profile。
/// 四项都是只读探测，唯一会改文件的是“清理无主写锁”和“创建最小核心 profile”，
/// 两者都由用户显式点击触发，且不触碰正在运行的 Harness 或 web profile。
@MainActor
final class HarnessDiagnosticsStore: ObservableObject {
    @Published private(set) var shellStatus = "登录 shell 环境：抓取中…"
    @Published private(set) var lockStatus = "无主写锁：尚未扫描。"
    @Published private(set) var pluginReport = PluginFailureDiagnosis.Report()
    @Published private(set) var profileStatus = "最小核心 profile：尚未检查。"
    @Published var profileName = MinimalCoreProfile.defaultName
    @Published private(set) var busy = false

    private var refreshTask: Task<Void, Never>?

    func refreshAll() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            guard let self else { return }
            await self.refreshShell()
            self.scanLocks()
            self.scanPlugins()
            self.checkProfile()
        }
    }

    private func refreshShell() async {
        // prewarm 已在启动时触发；这里只等结果落地，最多等 3 秒。
        for _ in 0..<30 {
            if ShellEnvironment.isResolved { break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        guard !Task.isCancelled else { return }
        if ShellEnvironment.isResolved {
            let path = ShellEnvironment.baseEnvironment["PATH"] ?? ""
            let count = path.split(separator: ":").count
            shellStatus = "登录 shell 环境：已捕获，PATH 含 \(count) 个目录（含 \(ShellEnvironment.mergePath(catalog: "", captured: path).split(separator: ":").count) 项去重后）。"
        } else {
            shellStatus = "登录 shell 环境：未捕获（已回落到进程继承环境），PATH 仅含工具目录条目。"
        }
    }

    func scanLocks() {
        let removals = StaleLockCleanup.run()
        lockStatus = "无主写锁：" + StaleLockCleanup.summary(removals)
    }

    func scanPlugins() {
        busy = true
        // 日志读取放到后台线程；detached 闭包不捕获 self，避免把 MainActor
        // 隔离的实例带进并发上下文（Swift 6 下是错误）。
        Task { [weak self] in
            let report = await Task.detached(priority: .utility) { PluginFailureDiagnosis.run() }.value
            guard let self else { return }
            self.pluginReport = report
            self.busy = false
        }
    }

    func checkProfile() {
        do {
            let plan = try MinimalCoreProfile.plan(name: profileName)
            profileStatus = "最小核心 profile：" + plan.summary
        } catch {
            profileStatus = "最小核心 profile：" + error.localizedDescription
        }
    }

    func createProfile() {
        do {
            let plan = try MinimalCoreProfile.create(name: profileName)
            profileStatus = plan.exists
                ? "最小核心 profile：已存在，未改动。\(plan.directory.path)"
                : "最小核心 profile：已创建。\(plan.directory.path)"
        } catch {
            profileStatus = "最小核心 profile：" + error.localizedDescription
        }
    }
}

struct HarnessDiagnosticsView: View {
    @StateObject private var store = HarnessDiagnosticsStore()

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Image(systemName: "stethoscope")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(HubTheme.accent)
                Text("Harness 运行环境自检").font(.system(size: 13, weight: .semibold))
                Spacer()
                Button(store.busy ? "扫描中…" : "重新自检") { store.refreshAll() }.disabled(store.busy)
            }
            Text(store.shellStatus).font(.caption).textSelection(.enabled)
            Text(store.lockStatus).font(.caption).textSelection(.enabled)
            Divider()
            HStack(spacing: 8) {
                Text("插件失败归因").font(.system(size: 12, weight: .semibold))
                Spacer()
                Button("扫描日志") { store.scanPlugins() }.disabled(store.busy)
            }
            Text(store.pluginReport.summary)
                .font(.system(size: 11, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !store.pluginReport.findings.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(store.pluginReport.findings.prefix(8)) { finding in
                        Text("· \(finding.kind.label)｜\(finding.packageName ?? "未知包")｜\(finding.owner?.version.map { "v" + $0 } ?? "未归属")")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Divider()
            HStack(spacing: 8) {
                Text("最小核心 profile（隔离启动）").font(.system(size: 12, weight: .semibold))
                Spacer()
                TextField("profile 名", text: $store.profileName).frame(width: 160)
                Button("检查") { store.checkProfile() }
                Button("创建") { store.createProfile() }
            }
            Text(store.profileStatus).font(.caption).textSelection(.enabled)
            Text(MinimalCoreProfile.caveats).font(.caption2).foregroundStyle(.secondary)
            Text("启动命令：\(MinimalCoreProfile.launchCommand(name: store.profileName).joined(separator: " "))（需在终端自行执行；本页不启停 Harness）")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
        .padding(10)
        .hubPanel()
        .onAppear { store.refreshAll() }
    }
}
