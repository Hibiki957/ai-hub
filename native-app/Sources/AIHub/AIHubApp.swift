import AppKit
import GhosttyTerminal
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    @MainActor static weak var model: AppModel?
    @MainActor static weak var relay: RelayRuntimeStore?
    @MainActor static weak var execution: WorkbenchExecutionBridge?
    @MainActor let workspaceWindows = WorkspaceWindowLifecycle()

    func applicationDidFinishLaunching(_: Notification) {
        // 强制浅色外观，与主题配色一致。
        NSApp.appearance = NSAppearance(named: .aqua)
        NSApp.activate(ignoringOtherApps: true)
        if ProcessInfo.processInfo.environment["AIHUB_DEBUG_TERMINAL"] == "1" {
            TerminalDebugLog.enable(.standard)
            TerminalDebugLog.sink = { message in NSLog("[AIHub] %@", message) }
        }

        // 移除系统 Window 菜单的默认 Close（Cmd+W=关窗口），换成关标签页逻辑
        DispatchQueue.main.async {
            guard let mainMenu = NSApp.mainMenu else { return }
            for topItem in mainMenu.items {
                guard let submenu = topItem.submenu else { continue }
                for item in submenu.items where item.action == #selector(NSWindow.performClose(_:)) {
                    submenu.removeItem(item)
                }
            }
            // 把自定义「关闭标签页」塞进 Window 菜单（找不到就建一个）
            let windowMenu = mainMenu.items.first { $0.submenu?.title == "Window" || $0.submenu?.title == "窗口" }?.submenu
                ?? {
                    let item = NSMenuItem()
                    let menu = NSMenu(title: "Window")
                    item.submenu = menu
                    mainMenu.addItem(item)
                    return menu
                }()
            let closeTabItem = NSMenuItem(
                title: "关闭标签页",
                action: #selector(AppDelegate.closeTabOrWindow(_:)),
                keyEquivalent: "w"
            )
            closeTabItem.target = self
            windowMenu.insertItem(closeTabItem, at: 0)

            let splitRightItem = NSMenuItem(
                title: "左右分屏",
                action: #selector(AppDelegate.splitCurrentPane(_:)),
                keyEquivalent: "d"
            )
            splitRightItem.target = self
            splitRightItem.tag = 0
            windowMenu.insertItem(splitRightItem, at: 1)

            let splitDownItem = NSMenuItem(
                title: "上下分屏",
                action: #selector(AppDelegate.splitCurrentPane(_:)),
                keyEquivalent: "D"
            )
            splitDownItem.target = self
            splitDownItem.tag = 1
            windowMenu.insertItem(splitDownItem, at: 2)
        }
    }

    @objc func splitCurrentPane(_ sender: NSMenuItem) {
        let isDown = sender.tag == 1
        MainActor.assumeIsolated {
            guard let model = AppDelegate.model, !model.tabStore.showingOverview,
                  let tabID = model.selectedTabID,
                  let tab = model.tabs.first(where: { $0.id == tabID }) else { return }
            // 分到最后一个未退出的面板；全退出则分第一个
            let target = tab.panes.last(where: { !model.exitedPaneIDs.contains($0.id) }) ?? tab.panes.first
            guard let target else { return }
            model.splitPane(tab: tab, paneID: target.id, direction: isDown ? .down : .right)
        }
    }

    @objc func closeTabOrWindow(_: NSMenuItem) {
        MainActor.assumeIsolated {
            guard let window = NSApp.keyWindow else { return }
            // Keep AppKit's cancel/close behavior while a system panel is key.
            guard workspaceWindows.contains(window) else {
                window.performClose(nil)
                return
            }
            if AppDelegate.model?.tabStore.showingOverview == true {
                window.miniaturize(nil)
                return
            }
            if let model = AppDelegate.model, let id = model.selectedTabID {
                model.closeTab(id: id)
            } else if let model = AppDelegate.model, let id = model.tabStore.selectedNativeTabID {
                model.tabStore.closeNativeTab(id: id)
            } else if let model = AppDelegate.model, let id = model.tabStore.selectedWebTabID {
                model.tabStore.closeWebTab(id: id)
            } else {
                window.close()
            }
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        MainActor.assumeIsolated { HubControlStore.shared.cancelRequests(); HubMCPStore.shared.cancel() }
        guard MainActor.assumeIsolated({ AppDelegate.relay?.hasOwnedProcesses == true || AppDelegate.execution?.hasOwnedProcesses == true }) else { return .terminateNow }
        Task { @MainActor in
            await AppDelegate.relay?.cancelAllAndWait()
            await AppDelegate.execution?.cancelAllAndWait()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    /// 关闭窗口不退出 app，保持后台运行（Dock 可恢复）
    func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool {
        false
    }

    /// 点击 Dock 图标恢复窗口
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if let window = sender.windows.first(where: { $0.title == "AI Hub" }) {
            window.deminiaturize(nil)
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        return true
    }
}

@main
struct AIHubApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()
    @StateObject private var relay = RelayRuntimeStore()
    @StateObject private var workbench: WorkbenchStore
    @StateObject private var execution: WorkbenchExecutionBridge

    init() {
        let store = WorkbenchStore(preview: AppModel.isPreview)
        _workbench = StateObject(wrappedValue: store)
        _execution = StateObject(wrappedValue: WorkbenchExecutionBridge(store: store, preview: AppModel.isPreview))
        // 抓取登录 shell 环境：与 App 启动并行，第一个 PTY / 执行器进程就能读到。
        ShellEnvironment.prewarm()
        // 清理无主写锁：Harness 被 kill 后锁不释放，下一次启动要等到超时。
        // 判定只看锁内 pid 是否仍存在；活着的持有者一律不动。
        let removals = StaleLockCleanup.run()
        if !removals.isEmpty { NSLog("[AIHub] %@", StaleLockCleanup.summary(removals)) }
        // 维护入口：AIHub --install-hooks → 幂等安装 Claude/Codex hooks 后退出（无 UI）
        if CommandLine.arguments.contains("--install-hooks") {
            HookInstaller.ensureScript()
            HookInstaller.installAll()
            exit(0)
        }
    }

    var body: some Scene {
        WindowGroup("AI Hub") {
            ContentView()
                .background(WorkspaceWindowRegistration { appDelegate.workspaceWindows.register($0) })
                .environmentObject(model)
                .environmentObject(model.tabStore)
                .environmentObject(relay)
                .environmentObject(workbench)
                .environmentObject(execution)
                .onAppear { AppDelegate.relay = relay; AppDelegate.execution = execution }
                .frame(minWidth: 1100, minHeight: 600)
        }
        .defaultSize(width: 1440, height: 880)

        Window("历史会话", id: "history") {
            HistoryView()
                .environmentObject(model)
                .environmentObject(model.tabStore)
                .frame(minWidth: 900, minHeight: 560)
        }
        .defaultSize(width: 1100, height: 680)
    }
}
