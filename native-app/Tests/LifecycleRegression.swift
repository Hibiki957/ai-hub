import AppKit
import GhosttyTerminal
import SwiftUI
import WebKit

// AppModel only needs this reference; tests never initialize AppModel or hooks.
final class AppDelegate {
    @MainActor static weak var model: AppModel?
}

@main
struct LifecycleRegression {
    struct Failure: Error, CustomStringConvertible { let description: String }
    @MainActor static func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        guard condition() else { throw Failure(description: message) }
        print("PASS: \(message)")
    }
    static func pause(_ seconds: Double = 0.3) async throws {
        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }
    @MainActor static func waitFor(_ message: String, _ condition: () -> Bool) async throws {
        for _ in 0..<100 {
            if condition() { return }
            try await pause(0.1)
        }
        throw Failure(description: "Timed out: \(message)")
    }

    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 720),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.title = "AI Hub regression tests"
        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
        Task { @MainActor in
            do {
                try await testWeb(window)
                try testClosedTabOwnership()
                try await testTerminals(window)
                if CommandLine.arguments.contains("--live") { try await testOpenClaw(window) }
                print("ALL LIFECYCLE REGRESSIONS PASSED")
                exit(0)
            } catch {
                fputs("FAIL: \(error)\n", stderr)
                exit(1)
            }
        }
        app.run()
    }

    @MainActor static func testOpenClaw(_ window: NSWindow) async throws {
        let store = TabStore(controller: TerminalController())
        window.contentView = NSHostingView(rootView: TerminalAreaView().environmentObject(store))
        store.openCLI(CLIEntry(name: "test-zsh", command: "/bin/zsh -f", title: "Background shell"))
        let tab = WebTab(title: "OpenClaw test", url: URL(string: "http://127.0.0.1:18789/")!, accent: .blue)
        store.webTabs.append(tab)
        store.selectedTabID = nil
        store.selectedWebTabID = tab.id
        try await waitFor("OpenClaw native view") { tab.holder.webView != nil }
        let view = tab.holder.webView!
        try await pause(8)
        for pass in 0..<2 {
            if pass == 1 {
                store.selectedWebTabID = nil
                store.selectedTabID = store.tabs[0].id
                try await pause()
                store.selectedTabID = nil
                store.selectedWebTabID = tab.id
                try await pause()
            }
            let rect = try await view.evaluateJavaScript("(()=>{let r=document.querySelector('[data-chat-model-select]').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()") as! [Double]
            let point = view.convert(NSPoint(x: rect[0], y: view.isFlipped ? rect[1] : view.bounds.height - rect[1]), to: nil)
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
                NSApp.sendEvent(event)
            }
            try await pause(1)
            let open = try await view.evaluateJavaScript("(()=>{let d=document.querySelector('.chat-controls__model-picker'),m=d?.querySelector('.chat-controls__model-menu'),r=m?.getBoundingClientRect();return !!(d?.open&&r?.width>0&&r?.height>0&&m.contains(document.elementFromPoint(r.x+20,r.y+20)))})()") as? Bool
            try check(open == true, "OpenClaw model picker opens on native click, pass \(pass + 1)")
            _ = try await view.evaluateJavaScript("document.querySelector('.chat-controls__model-picker').open=false")
        }
        store.closeWebTab(id: tab.id)
        for id in store.tabs.map(\.id) { store.closeTab(id: id) }
    }

    @MainActor static func testWeb(_ window: NSWindow) async throws {
        var dock = WebViewDock(frame: window.contentView!.bounds)
        window.contentView = dock
        var tabs = (0..<5).map { WebTab(title: "Test \($0)", url: URL(string: "about:blank#\($0)")!, accent: .blue) }
        for (index, tab) in tabs.enumerated() {
            dock.configure(tabs: tabs, selectedID: tab.id)
            dock.layoutSubtreeIfNeeded()
            let view = tab.holder.webView!
            try await waitFor("blank page load") { !view.isLoading }
            view.loadHTMLString("<textarea id='draft'></textarea><div style='height:3000px'></div>", baseURL: nil)
            try await waitFor("fixture load") { !view.isLoading }
            _ = try await view.evaluateJavaScript("window.marker='page-\(index)'; document.querySelector('#draft').value='draft-\(index)'; history.pushState({},'', '#route-\(index)'); window.scrollTo(0, 300)")
        }
        try check(tabs.allSatisfy { $0.holder.webView != nil }, "five web pages stay alive (old limit was two)")
        for (index, tab) in tabs.enumerated() {
            let original = tab.holder.webView!
            dock.configure(tabs: tabs, selectedID: tab.id)
            try await pause()
            let preserved = try await original.evaluateJavaScript("window.marker==='page-\(index)' && document.querySelector('#draft').value==='draft-\(index)' && location.hash==='#route-\(index)' && scrollY===300") as? Bool
            try check(preserved == true, "web page \(index) retains JS state, draft, route and scroll")
            try check(tab.holder.webView === original, "web page \(index) reuses the same WKWebView")
        }
        dock.configure(tabs: tabs, selectedID: nil)
        try check(tabs.allSatisfy { $0.holder.webView?.isHidden == true }, "terminal selection hides all web views")
        let first = tabs[0].holder.webView!
        dock.configure(tabs: tabs, selectedID: tabs[0].id, isWindowVisible: false)
        try check(dock.isHidden && tabs.allSatisfy { $0.holder.webView?.isHidden == true },
                  "occluded window hides even the selected web page")
        dock.configure(tabs: tabs, selectedID: tabs[0].id, isWindowVisible: true)
        try check(!dock.isHidden && !first.isHidden, "visible window restores the selected page")
        let restored = try await first.evaluateJavaScript("window.marker==='page-0' && document.querySelector('#draft').value==='draft-0' && scrollY===300") as? Bool
        try check(restored == true, "window visibility changes preserve draft, JS state and scroll")
        dock = WebViewDock(frame: window.contentView!.bounds)
        window.contentView = dock
        dock.configure(tabs: tabs, selectedID: tabs[0].id)
        try check(tabs[0].holder.webView === first && first.superview === dock, "rebuilding the dock reparents the existing page")
        let marker = try await first.evaluateJavaScript("window.marker") as? String
        try check(marker == "page-0", "layout changes preserve page state")

        weak var closed = tabs.last!.holder.webView
        tabs.last!.holder.dispose()
        tabs.removeLast()
        dock.configure(tabs: tabs, selectedID: tabs[0].id)
        try await waitFor("closed webview release") { closed == nil }
        print("PASS: closing a web tab releases its WKWebView")
        for tab in tabs { tab.holder.dispose() }
        tabs.removeAll()
        dock.configure(tabs: [], selectedID: nil)
    }

    @MainActor static func testClosedTabOwnership() throws {
        let store = TabStore(controller: TerminalController())
        weak var tab: TerminalTab?
        weak var pane: TerminalPane?
        autoreleasepool {
            store.openCLI(CLIEntry(name: "test", command: "/bin/zsh -f", title: "Unattached test"))
            tab = store.tabs[0]
            pane = tab?.primary
            store.closeTab(id: store.tabs[0].id)
        }
        try check(tab == nil && pane == nil, "closed tab and pane callbacks have no ownership cycle")
    }

    @MainActor static func testTerminals(_ window: NSWindow) async throws {
        let store = TabStore(controller: TerminalController())
        let host = NSHostingView(rootView: AnyView(TerminalAreaView().environmentObject(store)))
        window.contentView = host
        let shell = CLIEntry(name: "test-zsh", command: "/bin/zsh -f", title: "Test shell")
        store.openCLI(shell)
        let firstID = store.tabs[0].id
        weak var firstPane = store.tabs[0].primary
        try await waitFor("first terminal") { firstPane?.state.surface != nil }
        let originalViewID = ObjectIdentifier(firstPane!.platformView!)
        let originalSurfaceID = ObjectIdentifier(firstPane!.state.surface!)
        let output = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("aihub-regression-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: output) }
        _ = firstPane!.state.paste(text: "AIHUB_TEST=preserved; print -r -- $$ > '\(output.path)'")
        _ = firstPane!.state.sendKey(.enter)
        try await waitFor("shell PID") { FileManager.default.fileExists(atPath: output.path) }
        let originalPID = try String(contentsOf: output, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        for _ in 0..<3 { store.openCLI(shell) }
        try await pause(0.5)
        try check(firstPane!.platformView!.window === window, "background terminal remains attached for output and hooks")
        try check(firstPane!.platformView!.isHidden && !firstPane!.state.isSurfaceVisible, "background terminal stops rendering")
        store.selectedTabID = firstID
        try await pause()
        try check(ObjectIdentifier(firstPane!.platformView!) == originalViewID, "terminal selection reuses native view")
        try check(ObjectIdentifier(firstPane!.state.surface!) == originalSurfaceID, "terminal selection preserves Ghostty surface")
        _ = firstPane!.state.paste(text: "print -r -- $AIHUB_TEST-$$ > '\(output.path)'")
        _ = firstPane!.state.sendKey(.enter)
        try await pause(0.5)
        let outputText = try String(contentsOf: output, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        try check(outputText == "preserved-\(originalPID)", "shell PID and environment survive tab switches")

        store.showingOverview = true
        try await pause()
        try check(firstPane!.platformView!.isHidden && !firstPane!.state.isSurfaceVisible,
                  "overview stops terminal drawing while retaining the selected session")
        _ = firstPane!.state.paste(text: "print -r -- overview-$AIHUB_TEST-$$ > '\(output.path)'")
        _ = firstPane!.state.sendKey(.enter)
        try await waitFor("overview terminal keeps executing") {
            (try? String(contentsOf: output, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)) == "overview-preserved-\(originalPID)"
        }
        store.showingOverview = false
        try await pause()
        try check(firstPane!.state.isSurfaceVisible && ObjectIdentifier(firstPane!.state.surface!) == originalSurfaceID,
                  "returning from overview preserves shell identity and resumes drawing")

        window.orderOut(nil)
        try await waitFor("window occlusion notification") { !store.isWindowVisible }
        try check(firstPane!.platformView!.isHidden && !firstPane!.state.isSurfaceVisible,
                  "occluded window stops selected terminal rendering")
        _ = firstPane!.state.paste(text: "print -r -- hidden-$AIHUB_TEST-$$ > '\(output.path)'")
        _ = firstPane!.state.sendKey(.enter)
        try await waitFor("hidden terminal keeps executing") {
            (try? String(contentsOf: output, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)) == "hidden-preserved-\(originalPID)"
        }
        window.makeKeyAndOrderFront(nil)
        try await waitFor("window visibility notification") { store.isWindowVisible }
        try check(firstPane!.state.isSurfaceVisible && ObjectIdentifier(firstPane!.state.surface!) == originalSurfaceID,
                  "restoring window preserves live terminal and resumes rendering")

        store.splitPane(tab: store.tabs[0], paneID: firstPane!.id, direction: .right, cli: shell)
        try await pause(0.5)
        try check(ObjectIdentifier(firstPane!.state.surface!) == originalSurfaceID, "splitting preserves the original shell")
        let splitID = store.tabs[0].panes[1].id
        weak var splitPane = store.tabs[0].panes[1]
        store.closePane(tab: store.tabs[0], paneID: splitID)
        try await waitFor("split pane release") { splitPane == nil }
        print("PASS: closing split pane releases its state")

        store.closeTab(id: firstID)
        try check(firstPane?.state.surface == nil, "closing terminal immediately frees its Ghostty surface")
        try await waitFor("closed shell exits") { kill(pid_t(originalPID)!, 0) != 0 }
        print("PASS: closing terminal terminates its shell process")
        for id in store.tabs.map(\.id) { store.closeTab(id: id) }
        try await pause()
        try check(store.tabs.isEmpty && store.selectedTabID == nil, "closing all tabs clears selection")
        // SwiftUI may cache removed ForEach values. The resource checks above
        // intentionally verify the PTY/surface independently of graph caching.
        host.rootView = AnyView(EmptyView())
        window.contentView = NSView()
    }
}
