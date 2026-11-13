import SwiftUI
import WebKit

/// WebView 状态持有：后退/前进可用性 + 操作。
/// 标签持有 WKWebView；视图重排和标签切换不改变网页生命周期。
@MainActor
final class WebViewHolder: NSObject, ObservableObject, WKUIDelegate, WKNavigationDelegate {
    @Published var canGoBack = false
    @Published var canGoForward = false
    private(set) var webView: WKWebView?
    private var observations: [NSKeyValueObservation] = []
    private var attemptedDSHLaunchURLs: Set<URL> = []

    func attach(_ webView: WKWebView) {
        dispose()
        self.webView = webView
        observations.append(webView.observe(\.canGoBack, options: [.initial]) { [weak self] wv, _ in
            Task { @MainActor in
                guard let self, self.webView === wv, self.canGoBack != wv.canGoBack else { return }
                self.canGoBack = wv.canGoBack
            }
        })
        observations.append(webView.observe(\.canGoForward, options: [.initial]) { [weak self] wv, _ in
            Task { @MainActor in
                guard let self, self.webView === wv, self.canGoForward != wv.canGoForward else { return }
                self.canGoForward = wv.canGoForward
            }
        })
    }

    func dispose() {
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        webView?.uiDelegate = nil
        webView?.removeFromSuperview()
        observations.forEach { $0.invalidate() }
        observations.removeAll()
        attemptedDSHLaunchURLs.removeAll()
        webView = nil
    }

    func view(for url: URL) -> WKWebView {
        if let webView { return webView }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.applicationNameForUserAgent = "AIHub/2.0"
        if #available(macOS 14.0, *) {
            config.preferences.inactiveSchedulingPolicy = .throttle
        }
        config.userContentController.addUserScript(WKUserScript(
            source: WebCompatibility.script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        let view = WKWebView(frame: .zero, configuration: config)
        view.allowsBackForwardNavigationGestures = true
        view.allowsLinkPreview = false
        view.uiDelegate = self
        attach(view)
        view.navigationDelegate = self
        load(url)
        return view
    }

    func load(_ url: URL) {
        if let launchURL = DSHWebAuthentication.nextLaunchURL(for: url, excluding: []) {
            attemptedDSHLaunchURLs.insert(launchURL)
            webView?.load(DSHWebAuthentication.loginRequest(for: launchURL))
        } else {
            webView?.load(URLRequest(url: url))
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame,
           let response = navigationResponse.response as? HTTPURLResponse,
           response.statusCode == 401, let url = response.url,
           let launchURL = DSHWebAuthentication.nextLaunchURL(for: url, excluding: attemptedDSHLaunchURLs) {
            attemptedDSHLaunchURLs.insert(launchURL)
            decisionHandler(.cancel)
            // Start after WebKit finishes cancelling the rejected response;
            // loading inside its policy callback can cancel the replacement too.
            DispatchQueue.main.async { [weak webView] in
                webView?.load(DSHWebAuthentication.loginRequest(for: launchURL))
            }
            return
        }
        if navigationResponse.isForMainFrame,
           let response = navigationResponse.response as? HTTPURLResponse,
           (200..<300).contains(response.statusCode) {
            attemptedDSHLaunchURLs.removeAll()
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let failure = error as NSError
        NSLog("[AIHub] web navigation failed: %@ (%d)", failure.domain, failure.code)
    }

    // target=_blank links otherwise silently do nothing in an embedded WKWebView.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
        return nil
    }

    func goBack() { webView?.goBack() }
    func goForward() { webView?.goForward() }
}

/// 内嵌网页标签
@MainActor
final class WebTab: Identifiable, ObservableObject {
    let id = UUID()
    let title: String
    let url: URL
    let accent: Color
    let holder = WebViewHolder()

    init(title: String, url: URL, accent: Color) {
        self.title = title
        self.url = url
        self.accent = accent
    }
}

// MARK: - 常驻网页容器

/// 页面的生命周期由 WebTab 决定；这里只负责挂载和显隐。
/// 后台页隐藏后由 WebKit 节流，不用销毁页面来换内存。
final class WebViewDock: NSView {
    func configure(tabs: [WebTab], selectedID: UUID?, isWindowVisible: Bool = true) {
        isHidden = selectedID == nil || !isWindowVisible
        let views = tabs.compactMap { $0.holder.webView }
        for child in subviews where !views.contains(where: { $0 === child }) {
            child.removeFromSuperview()
        }
        if let tab = tabs.first(where: { $0.id == selectedID }) {
            let view = tab.holder.view(for: tab.url)
            if view.superview !== self { addSubview(view) }
        }
        for tab in tabs {
            guard let view = tab.holder.webView else { continue }
            let hidden = tab.id != selectedID || !isWindowVisible
            if view.isHidden != hidden {
                view.isHidden = hidden
                view.setAllMediaPlaybackSuspended(hidden)
            }
        }
        needsLayout = true
    }

    override func layout() {
        super.layout()
        // Hidden pages retain their viewport; avoid expensive layout on every
        // sidebar drag or window resize until that page becomes visible.
        for view in subviews where !view.isHidden && view.frame != bounds {
            view.frame = bounds
        }
    }
}

/// SwiftUI 桥：只要还有网页标签，容器就常驻，不随标签选择销毁
struct WebDockView: NSViewRepresentable {
    let webTabs: [WebTab]
    let selectedID: UUID?
    var isWindowVisible = true

    func makeNSView(context: Context) -> WebViewDock {
        WebViewDock(frame: .zero)
    }

    func updateNSView(_ nsView: WebViewDock, context: Context) {
        nsView.configure(tabs: webTabs, selectedID: selectedID, isWindowVisible: isWindowVisible)
    }
}
