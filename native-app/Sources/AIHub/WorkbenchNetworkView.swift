import Foundation
import SwiftUI

private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor final class WorkbenchNetworkStore: ObservableObject {
    @Published var target = "http://127.0.0.1:18789/"
    @Published var forbidden = false
    @Published private(set) var checking = false
    @Published private(set) var report = "尚未检查。检查只发送无认证的 HEAD，不跟随重定向，不更改系统路由。"
    @Published private(set) var dependencies = "尚未读取网络依赖。"

    nonisolated static func sanitizedOrigin(_ text: String) throws -> URL {
        guard let components = URLComponents(string: text), let host = components.host, !host.isEmpty,
              !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.port == nil || (1...65535).contains(components.port!),
              let scheme = components.scheme?.lowercased(),
              scheme == "https" || (scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host.lowercased())) else {
            throw NetworkError.invalidTarget
        }
        var origin = components; origin.path = "/"; origin.scheme = scheme
        guard let url = origin.url else { throw NetworkError.invalidTarget }
        return url
    }
    nonisolated static func diagnosticRequest(_ text: String) throws -> URLRequest {
        var request = URLRequest(url: try sanitizedOrigin(text))
        request.httpMethod = "HEAD"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpShouldHandleCookies = false
        return request
    }
    nonisolated static func diagnosticConfiguration() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 8; config.timeoutIntervalForResource = 10
        config.httpCookieStorage = nil; config.urlCredentialStorage = nil
        config.httpShouldSetCookies = false; config.httpAdditionalHeaders = nil
        return config
    }
    enum NetworkError: LocalizedError {
        case invalidTarget
        var errorDescription: String? { "仅检查无凭据、无查询参数的 HTTPS 地址或本机 HTTP；不会使用邮件、资料或登录令牌。" }
    }

    nonisolated static func readCommand(_ executable: String, _ args: [String]) -> String {
        let process = Process(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: executable); process.arguments = args
        process.standardOutput = output; process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
            timer.schedule(deadline: .now() + 4)
            timer.setEventHandler { if process.isRunning { process.terminate() } }
            timer.resume()
            let data = output.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit(); timer.cancel()
            return String(decoding: data.prefix(16_384), as: UTF8.self)
        } catch { return "" }
    }

    func inspectDependencies() {
        Task {
            let proxy = await Task.detached { Self.readCommand("/usr/sbin/scutil", ["--proxy"]) }.value
            let flags = proxy.components(separatedBy: "\n").filter {
                $0.contains("Enable :") || $0.contains("Port :")
            }.map { $0.trimmingCharacters(in: .whitespaces) }
            let binaries = ["Clash": "/Applications/Clash Verge.app", "Tailscale": "/Applications/Tailscale.app", "SSH": "/usr/bin/ssh"]
                .map { key, value in key + "：" + (FileManager.default.fileExists(atPath: value) ? "发现入口，未授权操作" : "此路径未发现") }.sorted()
            dependencies = (flags.isEmpty ? ["系统代理标志未读取到，路由未知。"] : ["系统代理标志（不含地址或认证值）："] + flags).joined(separator: "\n")
                + "\n" + binaries.joined(separator: "\n") + "\n浏览器、模型 CLI、MCP 和远程主机可能使用不同路由；此处不改 Clash、Tailscale 或 SSH。"
        }
    }

    func check() {
        guard !checking else { return }
        if forbidden { report = "当前诊断规则为禁止：未创建请求。"; return }
        let url: URL
        do { url = try Self.sanitizedOrigin(target) } catch { report = error.localizedDescription; return }
        checking = true
        Task {
            defer { checking = false }
            let host = url.host ?? ""
            let dns = await Task.detached { Self.readCommand("/usr/bin/dscacheutil", ["-q", "host", "-a", "name", host]) }.value
            let addresses = dns.components(separatedBy: "\n").filter { $0.hasPrefix("ip_address:") || $0.hasPrefix("ipv6_address:") }
            var steps = ["目标：" + url.absoluteString, addresses.isEmpty ? "DNS：未获得独立解析结果（字面 IP 可直接连接）。" : "DNS：" + addresses.joined(separator: "；")]
            let config = Self.diagnosticConfiguration()
            let session = URLSession(configuration: config, delegate: NoRedirectDelegate(), delegateQueue: nil)
            defer { session.invalidateAndCancel() }
            guard let request = try? Self.diagnosticRequest(url.absoluteString) else { return }
            do {
                let (_, response) = try await session.data(for: request)
                if let response = response as? HTTPURLResponse {
                    steps.append("连接/\(url.scheme == "https" ? "TLS/" : "")HTTP：收到 \(response.statusCode)。")
                    if (300..<400).contains(response.statusCode) { steps.append("重定向已阻止；未向其他地址转发请求。") }
                    if response.statusCode == 401 || response.statusCode == 403 { steps.append("入口可达，认证/授权仍未验证。") }
                    steps.append("模型协议、MCP 握手和供应商计费未在此检查。实际出口由现有系统路由决定，未确认直连或指定代理。")
                }
            } catch {
                let code = (error as NSError).code
                let stage: String
                switch code {
                case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed: stage = "DNS"
                case NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasBadDate: stage = "TLS/证书"
                case NSURLErrorTimedOut: stage = "连接/响应超时（具体链路未知）"
                case NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost: stage = "连接"
                default: stage = "网络请求"
                }
                steps.append(stage + "失败：" + error.localizedDescription + "（\(code)）")
                steps.append("没有切换出口、绕过证书检查或尝试未批准备用路由。")
            }
            report = steps.joined(separator: "\n")
        }
    }
}

struct WorkbenchNetworkView: View {
    @StateObject private var network = WorkbenchNetworkStore()
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("网络与执行环境").font(.title2)
                Text("任务运行环境由任务权限决定。当前受控执行为本机 macOS 沙箱；远程主机执行尚未获得 Hub 独立授权，不能通过 FinalShell 入口继承全部连接。")
                    .font(.callout)
                GroupBox("现有网络依赖（只读）") {
                    VStack(alignment: .leading, spacing: 10) {
                        Button("读取系统代理标志和入口") { network.inspectDependencies() }
                        Text(network.dependencies).font(.caption).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    }.padding(6)
                }
                GroupBox("无认证连通性诊断") {
                    VStack(alignment: .leading, spacing: 12) {
                        TextField("HTTPS origin / 本机 HTTP origin", text: $network.target)
                        Toggle("禁止此次诊断目标", isOn: $network.forbidden)
                        Button(network.checking ? "检查中…" : "检查 DNS / 连接 / HTTP") { network.check() }.disabled(network.checking)
                        Text(network.report).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                    }.padding(6).frame(maxWidth: .infinity, alignment: .leading)
                }
                HarnessDiagnosticsView()
                Text("任务的网络允许列表由执行层另外校验；此页面的诊断规则不会修改任务权限或系统代理。需要新出口或远程执行时，应在任务中列明目标、影响、回退方式并重新确认。")
                    .font(.caption).foregroundStyle(.secondary)
            }.padding(22)
        }
    }
}
