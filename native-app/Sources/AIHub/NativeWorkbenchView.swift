import AppKit
import Combine
import Darwin
import Foundation
import SwiftUI
import WebKit

/// A pointer to this Hub service only. It never searches another application's credentials.
struct NativeWorkbenchConnection {
    let baseURL: URL
    let accessTokenFile: URL

    static let configurationURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/AIHub/service-connection.json")
    static let serviceTokenURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/AIHubService/secrets/hub_access_token")

    private struct Document: Decodable { let baseURL: String; let accessTokenFile: String }

    static func loadDefault() -> NativeWorkbenchConnection? {
        try? load(from: configurationURL, allowedTokenFile: serviceTokenURL)
    }

    /// The explicit token argument exists for an isolated fixture; production calls loadDefault.
    static func load(from url: URL, allowedTokenFile: URL) throws -> NativeWorkbenchConnection {
        let data = try Data(contentsOf: url)
        guard data.count <= 16_384 else { throw NativeWorkbenchFailure.invalidConfiguration }
        let document = try JSONDecoder().decode(Document.self, from: data)
        guard let parts = URLComponents(string: document.baseURL),
              let scheme = parts.scheme?.lowercased(), let host = parts.host?.lowercased(),
              !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              scheme == "https" || (scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)),
              let base = parts.url,
              document.accessTokenFile.hasPrefix("/") else { throw NativeWorkbenchFailure.invalidConfiguration }
        let token = URL(fileURLWithPath: document.accessTokenFile).standardizedFileURL
        guard token == allowedTokenFile.standardizedFileURL else { throw NativeWorkbenchFailure.invalidTokenLocation }
        return NativeWorkbenchConnection(baseURL: base, accessTokenFile: token)
    }

    func readAccessToken() throws -> String {
        // O_NOFOLLOW prevents a symlink from turning this service-specific pointer into another file.
        let descriptor = open(accessTokenFile.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw NativeWorkbenchFailure.tokenUnavailable }
        defer { close(descriptor) }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              metadata.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              metadata.st_uid == getuid(), metadata.st_mode & 0o777 == 0o600,
              metadata.st_size > 0, metadata.st_size <= 4096 else { throw NativeWorkbenchFailure.tokenPermissions }
        var bytes = [UInt8](repeating: 0, count: Int(metadata.st_size))
        var offset = 0
        while offset < bytes.count {
            let count = bytes.withUnsafeMutableBytes { buffer in
                read(descriptor, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
            }
            guard count > 0 else { throw NativeWorkbenchFailure.tokenUnavailable }
            offset += count
        }
        guard let token = String(bytes: bytes, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !token.isEmpty, !token.contains("\n"), !token.contains("\r") else { throw NativeWorkbenchFailure.tokenUnavailable }
        return token
    }

    func owns(_ url: URL) -> Bool {
        guard let a = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              let b = URLComponents(url: url, resolvingAgainstBaseURL: false),
              b.user == nil, b.password == nil else { return false }
        let port: (URLComponents) -> Int = { $0.port ?? ($0.scheme?.lowercased() == "https" ? 443 : 80) }
        return a.scheme?.lowercased() == b.scheme?.lowercased()
            && a.host?.lowercased() == b.host?.lowercased() && port(a) == port(b)
    }
}

enum NativeWorkbenchFailure: LocalizedError {
    case invalidConfiguration, invalidTokenLocation, tokenUnavailable, tokenPermissions, loginRejected, cookieMissing
    var errorDescription: String? {
        switch self {
        case .invalidConfiguration: return "工作台连接配置无效。地址须为本机 HTTP 或 HTTPS origin，不可携带账号或参数。"
        case .invalidTokenLocation: return "访问令牌必须来自 AI Hub 本服务的专用令牌文件。"
        case .tokenUnavailable: return "无法读取 AI Hub 服务自己的访问令牌，请检查本机服务安装。"
        case .tokenPermissions: return "AI Hub 令牌须为当前用户持有的普通文件，权限为 0600；不读取符号链接。"
        case .loginRejected: return "工作台服务未接受当前访问令牌。请检查本机业务服务与连接配置。"
        case .cookieMissing: return "工作台服务没有返回有效的专用登录会话。"
        }
    }
}

private final class NativeWorkbenchRedirectGuard: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // Authentication bodies must never follow redirects to another origin.
        completionHandler(nil)
    }
}

@MainActor
private final class NativeWorkbenchSession: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    enum Phase: Equatable { case connecting, ready, failed(String) }
    @Published var phase: Phase = .connecting
    @Published var downloadInProgress = false
    @Published var downloadNotice: String?
    let connection: NativeWorkbenchConnection
    let webView: WKWebView
    var onOpenReference: ((URL) -> Void)?
    private var authentication: Task<Void, Never>?
    private var pendingDownloadURL: URL?
    private var downloads: [ObjectIdentifier: (download: WKDownload, url: URL)] = [:]
    private var downloadPolicy: NativeArtifactDownloadPolicy { NativeArtifactDownloadPolicy(baseURL: connection.baseURL) }
    private let redirectGuard = NativeWorkbenchRedirectGuard()
    private lazy var transport: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 15
        return URLSession(configuration: configuration, delegate: redirectGuard, delegateQueue: nil)
    }()

    init(connection: NativeWorkbenchConnection) {
        self.connection = connection
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        // No WKScriptMessageHandler or JavaScript credential injection is installed.
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
    }

    func connect() {
        authentication?.cancel()
        webView.stopLoading()
        phase = .connecting
        authentication = Task { [weak self] in
            guard let self else { return }
            do {
                let token = try connection.readAccessToken()
                var request = URLRequest(url: connection.baseURL.appendingPathComponent("api/session"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["token": token])
                let (_, response) = try await transport.data(for: request)
                try Task.checkCancellation()
                guard let response = response as? HTTPURLResponse, response.statusCode == 200,
                      response.url.map(connection.owns) == true else { throw NativeWorkbenchFailure.loginRejected }
                let headers = response.allHeaderFields.reduce(into: [String: String]()) { output, element in
                    if let key = element.key as? String, let value = element.value as? String { output[key] = value }
                }
                let host = connection.baseURL.host?.lowercased() ?? ""
                let cookies = HTTPCookie.cookies(withResponseHeaderFields: headers, for: connection.baseURL)
                    .filter { $0.name == "hub_session" && $0.isHTTPOnly && $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased() == host }
                guard !cookies.isEmpty else { throw NativeWorkbenchFailure.cookieMissing }
                for cookie in cookies {
                    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                        self.webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { continuation.resume() }
                    }
                }
                try Task.checkCancellation()
                webView.load(URLRequest(url: connection.baseURL))
            } catch is CancellationError { }
            catch { if !Task.isCancelled { phase = .failed(error.localizedDescription) } }
        }
    }

    /// Refresh only this service page; tool tabs and their processes belong to TabStore.
    /// The view must confirm first because some web drafts live only in JavaScript memory.
    func reloadWorkbench() {
        guard phase != .connecting else { return }
        if phase == .ready, webView.url.map(connection.owns) == true {
            phase = .connecting
            webView.reloadFromOrigin()
        } else {
            // A failed/terminated page may need a fresh service-specific login cookie.
            connect()
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { phase = .ready }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error) }
    private func fail(_ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        if pendingDownloadURL != nil {
            pendingDownloadURL = nil
            downloadInProgress = false
            downloadNotice = "产物下载未完成，请检查工作台服务后重试。"
            return
        }
        phase = .failed("工作台页面加载失败：\(error.localizedDescription)")
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { phase = .failed("工作台网页进程已结束。点击重试可重新连接；本机工具会话仍保留。") }

    private func handle(_ action: WKNavigationAction) -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if downloadPolicy.allows(url) {
            guard action.navigationType == .linkActivated, action.sourceFrame.isMainFrame,
                  action.sourceFrame.request.url.map(connection.owns) == true,
                  (action.request.httpMethod ?? "GET") == "GET", !downloadInProgress else { return .cancel }
            pendingDownloadURL = url
            downloadInProgress = true
            downloadNotice = nil
            return .download
        }
        // No generic download, blob bridge or script-initiated save API is exposed.
        if action.shouldPerformDownload { return .cancel }
        if connection.owns(url) { return .allow }
        if let targetFrame = action.targetFrame,
           NativeWorkbenchEmbedPolicy.allows(url, targetIsMainFrame: targetFrame.isMainFrame,
               source: action.sourceFrame.request.url,
               sourceIsHub: action.sourceFrame.isMainFrame && action.sourceFrame.request.url.map(connection.owns) == true) {
            return .allow
        }
        // Explicit clicks can open public HTTP(S) resources in the existing Hub tool tabs.
        // Script navigation, file/custom schemes, and cross-origin credential redirects cannot invoke native actions.
        if action.navigationType == .linkActivated,
           ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
           let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), parts.user == nil, parts.password == nil {
            onOpenReference?(url)
        }
        return .cancel
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(handle(navigationAction))
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if let url = navigationResponse.response.url, downloadPolicy.allows(url) {
            decisionHandler(pendingDownloadURL == url ? .download : .cancel)
        } else {
            let attachment = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().hasPrefix("attachment") == true
            decisionHandler(navigationResponse.canShowMIMEType && !attachment ? .allow : .cancel)
        }
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        accept(download)
    }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        accept(download)
    }
    private func accept(_ download: WKDownload) {
        guard let expected = pendingDownloadURL, download.originalRequest?.url == expected,
              downloadPolicy.allows(expected) else {
            pendingDownloadURL = nil
            downloadInProgress = !downloads.isEmpty
            download.cancel { _ in }
            return
        }
        pendingDownloadURL = nil
        if #available(macOS 15.2, *), !download.isUserInitiated {
            downloadInProgress = false
            download.cancel { _ in }
            return
        }
        downloads[ObjectIdentifier(download)] = (download, expected)
        download.delegate = self
    }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard let owned = downloads[ObjectIdentifier(download)], response.url == owned.url,
              downloadPolicy.allows(owned.url), let http = response as? HTTPURLResponse,
              http.statusCode == 200,
              http.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().hasPrefix("attachment") == true,
              let window = webView.window else {
            completionHandler(nil)
            finish(download)
            downloadNotice = "服务未返回可保存的任务产物，请回到工作台核验后重试。"
            return
        }
        let panel = NSSavePanel()
        panel.title = "保存任务产物"
        panel.message = "来自当前 AI Hub 服务。请选择新文件名；现有文件不会被覆盖。"
        panel.nameFieldStringValue = NativeArtifactDownloadPolicy.suggestedFilename(suggestedFilename)
        panel.canCreateDirectories = true
        panel.isExtensionHidden = false
        panel.beginSheetModal(for: window) { [weak self] result in
            guard let self else { completionHandler(nil); return }
            guard result == .OK, let destination = panel.url else {
                completionHandler(nil)
                self.finish(download)
                return
            }
            guard destination.isFileURL, !FileManager.default.fileExists(atPath: destination.path) else {
                completionHandler(nil)
                self.finish(download)
                self.downloadNotice = "未覆盖现有文件。请重新下载并选择一个新文件名。"
                return
            }
            completionHandler(destination)
        }
    }
    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        // Artifact routes never redirect. In particular, no Hub session cookie may follow elsewhere.
        decisionHandler(.cancel)
        finish(download)
        downloadNotice = "产物下载发生重定向，已停止；请检查工作台服务。"
    }
    func download(_ download: WKDownload, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        // Normal TLS trust only; never borrow an HTTP login/client certificate from Keychain.
        completionHandler(challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust ? .performDefaultHandling : .rejectProtectionSpace, nil)
    }
    func downloadDidFinish(_ download: WKDownload) {
        guard downloads[ObjectIdentifier(download)] != nil else { return }
        finish(download)
        downloadNotice = "任务产物已保存。"
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        guard downloads[ObjectIdentifier(download)] != nil else { return }
        finish(download)
        downloadNotice = "产物下载未完成，请重试。没有自动恢复或重复下载。"
    }
    private func finish(_ download: WKDownload) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        downloadInProgress = pendingDownloadURL != nil || !downloads.isEmpty
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil {
            if connection.owns(navigationAction.request.url ?? connection.baseURL) { webView.load(navigationAction.request) }
            else { _ = handle(navigationAction) }
        }
        return nil
    }
}

private struct NativeWorkbenchWebView: NSViewRepresentable {
    @ObservedObject var session: NativeWorkbenchSession
    func makeNSView(context: Context) -> WKWebView { session.webView }
    func updateNSView(_ nsView: WKWebView, context: Context) { }
}

struct NativeWorkbenchView: View {
    let connection: NativeWorkbenchConnection
    let legacyContent: AnyView
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var tabStore: TabStore
    @StateObject private var session: NativeWorkbenchSession
    @State private var surface: Surface = .workbench
    @State private var toolsVisible = false
    @State private var confirmingReload = false
    private enum Surface { case workbench, tools, legacy }

    init(connection: NativeWorkbenchConnection, legacyContent: AnyView) {
        self.connection = connection
        self.legacyContent = legacyContent
        _session = StateObject(wrappedValue: NativeWorkbenchSession(connection: connection))
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                surfaceButton("工作台", icon: "rectangle.grid.2x2", active: surface == .workbench) { select(.workbench) }
                surfaceButton("本机工具与 PWA", icon: "square.stack.3d.up", active: surface == .tools) { toolsVisible = true }
                Spacer()
                if surface == .workbench {
                    Button { confirmingReload = true } label: {
                        Label("重新加载工作台", systemImage: "arrow.clockwise")
                            .font(.system(size: 12)).padding(.horizontal, 6).padding(.vertical, 3)
                    }
                    .buttonStyle(.bordered)
                    .keyboardShortcut("r", modifiers: .command)
                    .disabled(session.phase == .connecting || toolsVisible || confirmingReload || session.downloadInProgress)
                    .help("重新载入工作台页面（⌘R）；本机终端和 PWA 会话保留。")
                }
                surfaceButton("旧版工作台", icon: "clock.arrow.circlepath", active: surface == .legacy) { select(.legacy) }
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
            .background(Color(nsColor: .windowBackgroundColor))
            Divider()
            if surface == .workbench, let notice = session.downloadNotice {
                HStack(spacing: 10) {
                    Text(notice).font(.system(size: 12)).frame(maxWidth: .infinity, alignment: .leading)
                    Button { session.downloadNotice = nil } label: { Image(systemName: "xmark") }
                        .buttonStyle(.plain).accessibilityLabel("关闭下载提示")
                }
                .padding(.horizontal, 16).padding(.vertical, 8)
                .background(Color(nsColor: .windowBackgroundColor))
            }
            if surface != .legacy, let error = model.launcherError {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "exclamationmark.circle")
                    Text(error).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    Button { model.launcherError = nil } label: { Image(systemName: "xmark") }
                        .buttonStyle(.plain).accessibilityLabel("关闭启动错误提示")
                }
                .font(.system(size: 13)).foregroundStyle(HubTheme.danger)
                .padding(.horizontal, 16).padding(.vertical, 10)
                .background(HubTheme.surface)
            }
            ZStack {
                NativeWorkbenchWebView(session: session)
                    .opacity(surface == .workbench ? 1 : 0)
                    .allowsHitTesting(surface == .workbench)
                    .accessibilityHidden(surface != .workbench)
                if surface != .legacy {
                    VStack(spacing: 0) {
                        TabBarView()
                        Divider()
                        TerminalAreaView()
                    }
                    .opacity(surface == .tools ? 1 : 0)
                    .allowsHitTesting(surface == .tools)
                    .accessibilityHidden(surface != .tools)
                }
                if surface == .legacy { legacyContent }
                if surface == .workbench {
                    switch session.phase {
                    case .connecting:
                        VStack(spacing: 12) { ProgressView(); Text("正在连接本机工作台…").font(.system(size: 13)) }
                            .frame(maxWidth: .infinity, maxHeight: .infinity).background(Color(nsColor: .windowBackgroundColor))
                    case .failed(let message):
                        VStack(spacing: 16) {
                            Image(systemName: "exclamationmark.circle").font(.system(size: 28)).foregroundStyle(.secondary)
                            Text("暂时无法打开工作台").font(.headline)
                            Text(message).font(.system(size: 13)).foregroundStyle(.secondary).multilineTextAlignment(.center).textSelection(.enabled).frame(maxWidth: 520)
                            HStack { Button("重试") { session.connect() }; Button("旧版工作台") { select(.legacy) } }
                        }
                        .padding(30).frame(maxWidth: .infinity, maxHeight: .infinity).background(Color(nsColor: .windowBackgroundColor))
                    case .ready: EmptyView()
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .sheet(isPresented: $toolsVisible) {
            ToolLauncherView {
                toolsVisible = false
                select(.tools)
            }
        }
        .alert("重新加载工作台？", isPresented: $confirmingReload) {
            Button("保留当前页面", role: .cancel) { }
                .keyboardShortcut(.defaultAction)
            Button("重新加载", role: .destructive) { session.reloadWorkbench() }
        } message: {
            Text("未发送的消息、未保存的提案和其他输入可能丢失，请先取消并保存或复制。已保存内容仍在；本机终端、PWA 会话和后台任务不会因此重启或取消。")
        }
        .onAppear {
            session.onOpenReference = { url in tabStore.openWeb(title: url.host ?? "资源", url: url) }
            tabStore.showingOverview = true
            if session.phase == .connecting { session.connect() }
        }
        .onReceive(tabStore.$selectedTabID.dropFirst()) { id in if id != nil { toolsVisible = false; select(.tools) } }
        .onReceive(tabStore.$selectedWebTabID.dropFirst()) { id in if id != nil { toolsVisible = false; select(.tools) } }
        .onReceive(tabStore.$selectedNativeTabID.dropFirst()) { id in if id != nil { toolsVisible = false; select(.tools) } }
        .onChange(of: tabStore.showingOverview) { overview in if overview && surface == .tools { surface = .workbench } }
    }

    private func select(_ value: Surface) {
        surface = value
        tabStore.showingOverview = value != .tools
    }
    private func surfaceButton(_ title: String, icon: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) { Label(title, systemImage: icon).font(.system(size: 12, weight: active ? .semibold : .regular)).padding(.horizontal, 6).padding(.vertical, 3) }
            .buttonStyle(.bordered).tint(active ? .accentColor : .gray)
    }
}
