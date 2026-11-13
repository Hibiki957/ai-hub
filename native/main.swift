// AI Hub — native WKWebView wrapper
import Cocoa
import WebKit

let hubURL = URL(string: "http://127.0.0.1:8787/")!

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!

    func applicationDidFinishLaunching(_ notification: Notification) {
        ensureServerRunning()

        let config = WKWebViewConfiguration()
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) AIHub/0.1 Safari/605.1.15"
        webView.load(URLRequest(url: hubURL))

        let style: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable]
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
            styleMask: style, backing: .buffered, defer: false)
        window.title = "AI Hub"
        window.contentView = webView
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    func ensureServerRunning() {
        // 探测；没起就拉 LaunchAgent，等它就绪（最多 5s）
        let sem = DispatchSemaphore(value: 0)
        var up = false
        URLSession.shared.dataTask(with: hubURL) { _, res, _ in
            up = (res as? HTTPURLResponse)?.statusCode == 200
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 1.5)

        if !up {
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            p.arguments = ["load", home + "/Library/LaunchAgents/com.example.aihub.plist"]
            try? p.run(); p.waitUntilExit()
            // 轮询就绪
            for _ in 0..<10 {
                let s2 = DispatchSemaphore(value: 0)
                URLSession.shared.dataTask(with: hubURL) { _, res, _ in
                    if (res as? HTTPURLResponse)?.statusCode == 200 { up = true }
                    s2.signal()
                }.resume()
                _ = s2.wait(timeout: .now() + 0.5)
                if up { break }
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
