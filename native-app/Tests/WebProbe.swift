import AppKit
import WebKit

@main
struct WebProbe {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.applicationNameForUserAgent = "AIHub/2.0"
        if ProcessInfo.processInfo.environment["AIHUB_COMPAT"] == "1" {
            config.userContentController.addUserScript(WKUserScript(source: WebCompatibility.script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        let capture = "window.__probeErrors=[]; addEventListener('error', e => __probeErrors.push(e.message)); addEventListener('unhandledrejection', e => __probeErrors.push(String(e.reason)));"
        config.userContentController.addUserScript(WKUserScript(source: capture, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 1180, height: 780), configuration: config)
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.title = "AI Hub WebKit diagnostics"
        window.contentView = view
        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
        let args = CommandLine.arguments
        view.load(URLRequest(url: URL(string: args[1])!))
        Task { @MainActor in
            do {
                try await Task.sleep(nanoseconds: 8_000_000_000)
                for path in args.dropFirst(2) {
                    let script = try String(contentsOfFile: path, encoding: .utf8)
                    if script.hasPrefix("// native-click:") {
                        let selector = script.dropFirst("// native-click:".count).trimmingCharacters(in: .whitespacesAndNewlines)
                        let quoted = String(data: try JSONSerialization.data(withJSONObject: selector, options: .fragmentsAllowed), encoding: .utf8)!
                        let rect = try await view.evaluateJavaScript("(()=>{let r=document.querySelector(\(quoted)).getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()") as! [Double]
                        _ = try await view.evaluateJavaScript("window.__probeClicks=[]; for(const type of ['mousedown','mouseup','click']) document.addEventListener(type,e=>__probeClicks.push({type,x:e.clientX,y:e.clientY,tag:e.target.tagName,cls:e.target.className}),true)")
                        let point = view.convert(NSPoint(x: rect[0], y: view.isFlipped ? rect[1] : view.bounds.height - rect[1]), to: nil)
                        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                            let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
                            app.sendEvent(event)
                        }
                        try await Task.sleep(nanoseconds: 2_000_000_000)
                        print("NATIVE CLICKS: \(String(describing: try await view.evaluateJavaScript("JSON.stringify(window.__probeClicks)")))")
                        continue
                    }
                    let result = try await view.evaluateJavaScript(script)
                    print("RESULT \((path as NSString).lastPathComponent): \(String(describing: result))")
                    try await Task.sleep(nanoseconds: 2_000_000_000)
                }
                print("ERRORS: \(String(describing: try await view.evaluateJavaScript("JSON.stringify(window.__probeErrors)")))")
            } catch { print("PROBE ERROR: \(error)") }
            app.terminate(nil)
        }
        app.run()
    }
}
