import AppKit
import Foundation
import GhosttyTerminal

// Compile with production sources except the application's entry point.
// No AppModel is initialized and no terminal view or native application is opened.
final class AppDelegate {
    @MainActor static weak var model: AppModel?
}

@main
struct NativeTabLifecycleRegression {
    struct Failure: Error, CustomStringConvertible { let description: String }

    @MainActor static func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        guard condition() else { throw Failure(description: message) }
        print("PASS: \(message)")
    }

    @MainActor static func selectedCount(_ store: TabStore) -> Int {
        [store.selectedTabID, store.selectedWebTabID, store.selectedNativeTabID].compactMap { $0 }.count
    }

    @MainActor static func main() {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)
        do {
            try check(!AppModel.isPreview, "launcher reuse is exercised outside preview mode")
            try lifecycle()
            print("ALL NATIVE TAB LIFECYCLE REGRESSIONS PASSED")
        } catch {
            fputs("FAIL: \(error)\n", stderr)
            exit(1)
        }
    }

    @MainActor static func lifecycle() throws {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("aihub-native-tabs-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: temporary) }
        let appPath = temporary.appendingPathComponent("Fixture.app")
        let aliasPath = temporary.appendingPathComponent("Fixture Alias.app")
        try FileManager.default.createDirectory(at: appPath, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: aliasPath, withDestinationURL: appPath)

        let store = TabStore(controller: TerminalController())
        let first = NativeAppTab(appPath: appPath.path, appName: "Fixture")
        let second = NativeAppTab(appPath: temporary.appendingPathComponent("Other.app").path, appName: "Other")
        store.nativeTabs = [first, second]
        store.setWindowVisible(false)
        store.selectedNativeTabID = first.id
        try check(selectedCount(store) == 1 && !store.showingOverview, "native selection activates exactly one presentation")
        try check(!first.isVisible && !second.isVisible, "hidden Hub does not present either native mirror")
        store.setWindowVisible(true)
        try check(first.isVisible && !second.isVisible, "visible Hub presents only the selected native mirror")
        store.showingOverview = true
        try check(!first.isVisible && !second.isVisible, "workbench overview hides native mirrors")
        store.showingOverview = false
        try check(first.isVisible, "returning to tools restores the selected native presentation")

        let initialIDs = store.nativeTabs.map(\.id)
        store.openNativeApp(AppEntry(name: "Renamed fixture", appPath: aliasPath.path))
        try check(store.nativeTabs.map(\.id) == initialIDs && store.selectedNativeTabID == first.id,
                  "canonical-path alias reuses the existing native tab")
        try check(first.runningPID == nil && first.state == .idle,
                  "reusing the existing tab never launches or captures the fixture app")

        store.openWeb(title: "First web", url: URL(string: "about:blank#native-tabs-first")!)
        let firstWeb = store.webTabs[0]
        try check(selectedCount(store) == 1 && store.selectedNativeTabID == nil && !first.isVisible,
                  "opening a web tab clears native selection and hides its mirror")
        store.openWeb(title: "Second web", url: URL(string: "about:blank#native-tabs-second")!)
        let secondWeb = store.webTabs[1]
        try check(store.orderedTabs.map(\.id) == [first.id, second.id, firstWeb.id, secondWeb.id],
                  "new tabs append after the existing mixed native/web order")
        store.moveTab(secondWeb.id, before: first.id)
        store.moveTab(second.id, before: firstWeb.id)
        try check(store.orderedTabs.map(\.id) == [secondWeb.id, first.id, second.id, firstWeb.id],
                  "native and web tabs participate in the same drag order")

        store.openCLI(CLIEntry(name: "unattached-native-regression", command: "/usr/bin/true", title: "Unattached fixture"))
        let terminal = store.tabs[0]
        try check(selectedCount(store) == 1 && store.selectedTabID == terminal.id && store.selectedNativeTabID == nil && store.selectedWebTabID == nil,
                  "opening an unattached terminal clears web/native selection")
        try check(terminal.primary?.state.surface == nil, "terminal lifecycle test does not launch a process")
        store.selectedNativeTabID = first.id
        try check(selectedCount(store) == 1 && store.selectedTabID == nil && first.isVisible,
                  "direct native selection clears terminal selection")
        store.selectedWebTabID = firstWeb.id
        try check(selectedCount(store) == 1 && store.selectedNativeTabID == nil && !first.isVisible,
                  "direct web selection clears native selection")

        store.selectedNativeTabID = second.id
        store.closeNativeTab(id: second.id)
        try check(!store.nativeTabs.contains { $0.id == second.id } && second.isClosed && !second.isVisible,
                  "closing native tab disposes the mirror session")
        try check(store.selectedWebTabID == firstWeb.id && selectedCount(store) == 1,
                  "closing selected native tab selects its neighboring web tab")
        try check(first.runningPID == nil && second.runningPID == nil,
                  "fixture native lifecycle remains free of application launches")

        store.closeWebTab(id: firstWeb.id)
        try check(store.selectedTabID == terminal.id && selectedCount(store) == 1,
                  "closing selected web tab selects its neighboring terminal")
        store.closeTab(id: terminal.id)
        try check(store.selectedNativeTabID == first.id && first.isVisible,
                  "closing selected terminal can return to a native tab")
        store.closeNativeTab(id: first.id)
        try check(store.selectedWebTabID == secondWeb.id && first.isClosed,
                  "closing last native mirror preserves the existing web session")
        store.closeWebTab(id: secondWeb.id)
        try check(store.orderedTabs.isEmpty && selectedCount(store) == 0 && store.showingOverview,
                  "closing the final tab returns to the workbench overview")
        try check(firstWeb.holder.webView == nil && secondWeb.holder.webView == nil,
                  "web lifecycle test never instantiated a web process")
    }
}
