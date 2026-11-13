import Foundation

@main
struct NativeWorkbenchEmbedRegression {
    static func main() {
        let source = URL(string: "http://127.0.0.1:18787/")!
        let base = "https://miro.com/app/live-embed/uXjPublicFixture%3D/"
        let query = "?embedMode=view_only_without_ui&autoplay=true"
        let canvas = URL(string: base + query)!
        precondition(NativeWorkbenchEmbedPolicy.boardID(canvas) == "uXjPublicFixture=")
        precondition(NativeWorkbenchEmbedPolicy.allows(canvas, targetIsMainFrame: false, source: source, sourceIsHub: true))
        precondition(!NativeWorkbenchEmbedPolicy.allows(canvas, targetIsMainFrame: true, source: source, sourceIsHub: true))
        let located = URL(string: base + query + "&moveToWidget=3458764667992300439")!
        precondition(NativeWorkbenchEmbedPolicy.allows(located, targetIsMainFrame: false, source: canvas, sourceIsHub: false))
        precondition(!NativeWorkbenchEmbedPolicy.allows(URL(string: base.replacingOccurrences(of: "Public", with: "Other") + query)!, targetIsMainFrame: false, source: canvas, sourceIsHub: false))
        precondition(!NativeWorkbenchEmbedPolicy.allows(canvas, targetIsMainFrame: false, source: URL(string: "https://example.com/")!, sourceIsHub: false))
        let denied = [
            base, base + "?embedMode=view_only&autoplay=true",
            base + "?embedMode=editable&autoplay=true", base + "?embedMode=view_only_without_ui",
            base + query + "&embedMode=view_only_without_ui", base + query + "&boardsAccessToken=secret",
            base + query + "&moveToViewport=0,0,100,100", base + query + "&moveToWidget=bad/value",
            base + query + "&moveToWidget=", base + query + "#fragment",
            base.replacingOccurrences(of: "https:", with: "http:") + query,
            base.replacingOccurrences(of: "miro.com", with: "miro.com.evil.invalid") + query,
            base.replacingOccurrences(of: "miro.com", with: "user@miro.com") + query,
            base.replacingOccurrences(of: "miro.com", with: "miro.com:443") + query,
            base.replacingOccurrences(of: "/live-embed/", with: "/board/") + query,
            base.replacingOccurrences(of: "uXjPublicFixture%3D", with: "%2E%2E") + query,
            base.replacingOccurrences(of: "uXjPublicFixture%3D", with: "board%2Fother") + query,
            "https://miro.com/login/", "https://miro.com/signup/", "file:///tmp/canvas",
            "data:text/html,canvas", "about:blank"
        ]
        for value in denied { precondition(NativeWorkbenchEmbedPolicy.boardID(URL(string: value)!) == nil, "Unexpected embed URL admitted") }
        print("Native Miro embed policy: \(denied.count + 6) checks passed; URL policy only, no WebKit/network authentication claim.")
    }
}
