import Combine
import Foundation
import Security
import CryptoKit

struct HubAPIEndpoint: Codable, Identifiable, Equatable {
    var id = UUID()
    var name = ""
    var baseURL = "https://api.openai.com/v1"
    var model = ""
    var enabled = true
    var familyID: String? = nil
}
struct HubMemory: Codable, Identifiable, Equatable {
    var id = UUID()
    var scope: String
    var text: String
    var createdAt = Date()
    var sourceTaskID: UUID? = nil
    var sourceRunID: UUID? = nil
    var sourceAcceptanceID: UUID? = nil
}
struct HubChatMessage: Codable, Identifiable, Equatable {
    var id = UUID()
    var role: String
    var content: String
    var endpointID: UUID? = nil
    var status = "completed"
    var createdAt = Date()
    var purpose: String? = nil
    var sourceMessageID: UUID? = nil
    var contextSnapshot: String? = nil
    var receiptRunID: UUID? = nil
    var requestGroupID: UUID? = nil
    var transport: HubAPITransport? = nil
}
struct HubChatThread: Codable, Identifiable, Equatable {
    var id = UUID()
    var projectID: UUID?
    var taskID: UUID?
    var title: String
    var messages: [HubChatMessage] = []
}
struct HubControlState: Codable, Equatable {
    var schemaVersion = 1
    var endpoints: [HubAPIEndpoint] = []
    var memories: [HubMemory] = []
    var threads: [HubChatThread] = []
    var receipts: [HubAPIReceipt]? = nil
}
struct HubGatewayError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Transport provenance is assigned by the store, never by an endpoint profile
/// or a response payload. Injecting any session makes its requests fixtures.
enum HubAPITransport: String, Codable { case liveNetwork, fixture, unknown }

/// Optional fields allow older/incomplete evidence to be displayed honestly
/// rather than failing to load all conversations. Missing fields never pass.
struct HubAPIReceipt: Codable, Equatable, Identifiable {
    var provider: String? = nil
    var model: String? = nil
    var runID: UUID? = nil
    var startedAt: Date? = nil
    var endedAt: Date? = nil
    var artifactPointer: String? = nil
    var acceptanceResult: String? = nil
    var endpointID: UUID? = nil
    var requestGroupID: UUID? = nil
    var requestMessageID: UUID? = nil
    var routeFingerprint: String? = nil
    var baseURL: String? = nil
    var threadID: UUID? = nil
    var messageID: UUID? = nil
    var transport: HubAPITransport? = nil
    var responseHash: String? = nil
    var httpStatus: Int? = nil
    var status: String? = nil
    var id: String { runID?.uuidString ?? "incomplete:" + (artifactPointer ?? "") + ":" + (endpointID?.uuidString ?? "") }
}

struct HubReceiptValidation: Equatable {
    let structurallyValid: Bool
    let isLiveVerified: Bool
    let reasons: [String]
}
struct HubEndpointConnectionStatus {
    let label: String
    let isLiveVerified: Bool
    let receipt: HubAPIReceipt?
    let detail: String
}
struct HubPhase15EvidenceGate {
    let passed: Bool
    let requestGroupID: UUID?
    let receipts: [HubAPIReceipt]
    let detail: String
    var label: String { passed ? "Phase 1.5 真实双路由证据齐全" : "Phase 1.5 未验收" }
}

/// Verifies ledger evidence against its original conversation instead of trusting
/// a green status string or the presence of a configured model.
enum HubAPIEvidence {
    static func responseHash(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    static func canonicalBaseURL(_ base: String) throws -> String {
        _ = try HubGatewayClient.endpointURL(base)
        var parts = URLComponents(string: base)!
        parts.scheme = parts.scheme?.lowercased(); parts.host = parts.host?.lowercased()
        if (parts.scheme == "https" && parts.port == 443) || (parts.scheme == "http" && parts.port == 80) { parts.port = nil }
        while parts.percentEncodedPath.hasSuffix("/") { parts.percentEncodedPath.removeLast() }
        guard let value = parts.url?.absoluteString else { throw HubGatewayError(message: "无法规范化 API 地址") }
        return value
    }
    static func provider(_ base: String) throws -> String {
        var parts = URLComponents(string: try canonicalBaseURL(base))!
        parts.path = ""
        return parts.url!.absoluteString
    }
    static func routeFingerprint(baseURL: String, model: String) throws -> String {
        guard !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw HubGatewayError(message: "模型不能为空") }
        return responseHash(try canonicalBaseURL(baseURL) + "\u{0}" + model)
    }
    static func artifactPointer(threadID: UUID, messageID: UUID) -> String {
        "aihub://source/hubConversation/" + threadID.uuidString + "/" + messageID.uuidString
    }
    static func validate(_ receipt: HubAPIReceipt, in state: HubControlState) -> HubReceiptValidation {
        var reasons: [String] = []
        guard let provider = receipt.provider, !provider.isEmpty,
              let model = receipt.model, !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let runID = receipt.runID, let start = receipt.startedAt, let end = receipt.endedAt,
              let pointer = receipt.artifactPointer, !pointer.isEmpty,
              let acceptance = receipt.acceptanceResult, let endpointID = receipt.endpointID,
              let group = receipt.requestGroupID, let requestMessageID = receipt.requestMessageID,
              let fingerprint = receipt.routeFingerprint, let baseURL = receipt.baseURL,
              let threadID = receipt.threadID, let messageID = receipt.messageID,
              let transport = receipt.transport, let responseHash = receipt.responseHash,
              let httpStatus = receipt.httpStatus, let status = receipt.status else {
            return .init(structurallyValid: false, isLiveVerified: false, reasons: ["运行证据字段不完整"])
        }
        if !start.timeIntervalSince1970.isFinite || !end.timeIntervalSince1970.isFinite || end < start { reasons.append("开始与结束时间无效") }
        if status != "completed" || acceptance != "passed" || !(200...299).contains(httpStatus) { reasons.append("本次调用未通过回复验收") }
        if (try? self.provider(baseURL)) != provider || (try? routeFingerprint(baseURL: baseURL, model: model)) != fingerprint { reasons.append("服务、模型与路由指纹不匹配") }
        if pointer != artifactPointer(threadID: threadID, messageID: messageID) { reasons.append("产物指针未指向原始回复") }
        if !(state.receipts ?? []).contains(receipt) { reasons.append("台账条目与持久记录不一致") }
        if (state.receipts ?? []).filter({ $0.runID == runID }).count != 1 { reasons.append("运行 ID 缺失或重复") }
        if (state.receipts ?? []).filter({ $0.threadID == threadID && $0.messageID == messageID }).count != 1 { reasons.append("回复没有唯一调用记录") }
        if let thread = state.threads.first(where: { $0.id == threadID }),
           let message = thread.messages.first(where: { $0.id == messageID }),
           let request = thread.messages.first(where: { $0.id == requestMessageID }) {
            if message.role != "assistant" || message.status != "completed" || message.content.isEmpty || message.endpointID != endpointID { reasons.append("原始回复不存在、未完成或服务不匹配") }
            if message.receiptRunID != runID || message.requestGroupID != group || message.transport != transport { reasons.append("回复的调用来源与台账不匹配") }
            if request.role != "user" || request.status != "completed" || request.requestGroupID != group || request.content.isEmpty { reasons.append("共同提问来源无效") }
            if request.createdAt > start || message.createdAt != start || message.createdAt > end { reasons.append("提问、回复与运行时间顺序不匹配") }
            if self.responseHash(message.content) != responseHash { reasons.append("回复内容与产物摘要不一致") }
        } else { reasons.append("台账指向的提问或回复不存在") }
        if transport == .unknown { reasons.append("调用来源未知") }
        let valid = reasons.isEmpty
        if transport == .fixture { reasons.append("离线 fixture，不能作为真实联通证据") }
        return .init(structurallyValid: valid, isLiveVerified: valid && transport == .liveNetwork, reasons: reasons)
    }
}

/// Private Hub credentials only. No other app's Keychain items are queried.
enum HubCredentialVault {
    static func token(_ id: UUID) -> String? {
        var query = identity(id); query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func save(_ token: String, for id: UUID) throws {
        let query = identity(id)
        if token.isEmpty { let code = SecItemDelete(query as CFDictionary); guard code == errSecSuccess || code == errSecItemNotFound else { throw HubGatewayError(message: "无法删除 Hub API 凭据：\(code)") }; return }
        let attributes: [String: Any] = [kSecValueData as String: Data(token.utf8), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var code = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if code == errSecItemNotFound { code = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil) }
        guard code == errSecSuccess else { throw HubGatewayError(message: "无法保存 Hub API 凭据：\(code)") }
    }
    private static func identity(_ id: UUID) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.example.aihub.gateway", kSecAttrAccount as String: id.uuidString]
    }
}

/// Redirects are rejected so credentials never follow a remote redirect.
final class HubNoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
struct HubGatewayClient {
    static func endpointURL(_ base: String) throws -> URL {
        guard let parts = URLComponents(string: base), let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.scheme == "https" || (parts.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host)),
              let url = parts.url else { throw HubGatewayError(message: "API 地址必须是 HTTPS，或本机回环 HTTP；不能包含凭据、查询参数或片段") }
        return url.appendingPathComponent("chat/completions")
    }
    static func request(endpoint: HubAPIEndpoint, token: String?, context: String, history: [HubChatMessage]) throws -> URLRequest {
        guard endpoint.enabled, !endpoint.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw HubGatewayError(message: "API 已停用或尚未设置模型") }
        var request = URLRequest(url: try endpointURL(endpoint.baseURL), timeoutInterval: 120)
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token, !token.isEmpty { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        let messages = [["role": "system", "content": context]] + history.suffix(40).map { ["role": $0.role, "content": $0.content] }
        request.httpBody = try JSONSerialization.data(withJSONObject: ["model": endpoint.model, "messages": messages, "stream": false])
        return request
    }
    static func response(_ data: Data, status: Int) throws -> String {
        guard (200...299).contains(status) else { throw HubGatewayError(message: "API 返回 HTTP \(status)；请核对地址、模型与 Hub 自己的凭据") }
        guard data.count <= 4_194_304, let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = json["choices"] as? [[String: Any]], let message = choices.first?["message"] as? [String: Any],
              let text = message["content"] as? String, !text.isEmpty else { throw HubGatewayError(message: "接口没有返回受支持的文本回复（chat/completions）") }
        return text
    }
}

@MainActor final class HubControlStore: ObservableObject {
    static let shared = HubControlStore()
    @Published private(set) var state = HubControlState()
    @Published private(set) var activeRequestIDs: Set<UUID> = []
    @Published var issue: String?
    private let file: URL
    private var blocked = false
    private var requests: [UUID: Task<Void, Never>] = [:]
    private let session: URLSession
    let transport: HubAPITransport
    init(file: URL? = nil, session: URLSession? = nil) {
        self.file = file ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/" + ((Bundle.main.object(forInfoDictionaryKey: "AIHubPreviewMode") as? Bool == true) ? "AIHubPreview" : "AIHub") + "/Control/control-v1.json")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false; configuration.httpCookieStorage = nil; configuration.urlCredentialStorage = nil
        self.transport = session == nil ? .liveNetwork : .fixture
        self.session = session ?? URLSession(configuration: configuration, delegate: HubNoRedirectDelegate(), delegateQueue: nil)
        if FileManager.default.fileExists(atPath: self.file.path) {
            do {
                state = try JSONDecoder().decode(HubControlState.self, from: Data(contentsOf: self.file))
                guard state.schemaVersion == 1 else { throw HubGatewayError(message: "不支持的控制台版本") }
                var recovered = false
                for i in state.threads.indices { for j in state.threads[i].messages.indices where state.threads[i].messages[j].status == "running" {
                    state.threads[i].messages[j].status = "interrupted"; state.threads[i].messages[j].content = "Hub 已重启，此请求未自动重发"; recovered = true
                } }
                if var receipts = state.receipts {
                    for i in receipts.indices where receipts[i].status == "running" {
                        receipts[i].status = "interrupted"; receipts[i].acceptanceResult = "interrupted"
                        receipts[i].endedAt = Date(); receipts[i].responseHash = nil; recovered = true
                    }
                    state.receipts = receipts
                }
                if recovered { try persist() }
            } catch { blocked = true; issue = "控制台数据读取失败，已保留原文件并停止写入：" + error.localizedDescription }
        }
    }
    private func persist() throws {
        try HubConfigurationOwnership.requireHubWrite(to: file)
        guard !blocked else { throw HubGatewayError(message: "控制台数据读取异常，禁止覆盖") }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(state).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
    private func commit(_ mutation: () throws -> Void) throws {
        let before = state
        do { try mutation(); try persist() } catch { state = before; throw error }
    }
    func saveEndpoint(_ endpoint: HubAPIEndpoint, newToken: String? = nil) throws {
        _ = try HubGatewayClient.endpointURL(endpoint.baseURL)
        guard !endpoint.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !endpoint.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw HubGatewayError(message: "请填写名称与模型") }
        let previousToken = newToken == nil ? nil : HubCredentialVault.token(endpoint.id)
        if let newToken { try HubCredentialVault.save(newToken, for: endpoint.id) }
        do { try commit {
            if let i = state.endpoints.firstIndex(where: { $0.id == endpoint.id }) { state.endpoints[i] = endpoint }
            else { state.endpoints.append(endpoint) }
        } } catch { if newToken != nil { try? HubCredentialVault.save(previousToken ?? "", for: endpoint.id) }; throw error }
    }
    func addMemory(scope: String, text: String, sourceTaskID: UUID? = nil, sourceRunID: UUID? = nil, sourceAcceptanceID: UUID? = nil) throws {
        guard scope == "global" || scope.range(of: #"^(project|task):[A-Fa-f0-9-]{36}$"#, options: .regularExpression) != nil else { throw HubGatewayError(message: "记忆范围无效") }
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, clean.utf8.count <= 16_384 else { throw HubGatewayError(message: "记忆需为 1–16 KiB 的文本") }
        if let sourceAcceptanceID, state.memories.contains(where: { $0.sourceAcceptanceID == sourceAcceptanceID && $0.scope == scope }) { return }
        try commit { state.memories.append(HubMemory(scope: scope, text: clean, sourceTaskID: sourceTaskID, sourceRunID: sourceRunID, sourceAcceptanceID: sourceAcceptanceID)) }
    }
    func removeMemory(_ id: UUID) throws { try commit { state.memories.removeAll { $0.id == id } } }
    func memories(projectID: UUID?, taskID: UUID?) -> [HubMemory] {
        let scopes = Set(["global"] + projectID.map { ["project:" + $0.uuidString] }.orEmpty + taskID.map { ["task:" + $0.uuidString] }.orEmpty)
        return state.memories.filter { scopes.contains($0.scope) }
    }
    @discardableResult func createThread(projectID: UUID?, taskID: UUID?, title: String) throws -> UUID {
        let thread = HubChatThread(projectID: projectID, taskID: taskID, title: title)
        try commit { state.threads.append(thread) }; return thread.id
    }
    @discardableResult func append(threadID: UUID, role: String, content: String) throws -> UUID {
        guard let i = state.threads.firstIndex(where: { $0.id == threadID }), ["user", "assistant"].contains(role), !content.isEmpty else { throw HubGatewayError(message: "对话无效") }
        let message = HubChatMessage(role: role, content: content)
        try commit { state.threads[i].messages.append(message) }; return message.id
    }
    func send(threadID: UUID, text: String, endpointIDs: [UUID], context: String, purpose: String? = nil, sourceMessageID: UUID? = nil, additionalInstructions: String = "") throws {
        guard requests.isEmpty, let index = state.threads.firstIndex(where: { $0.id == threadID }), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.utf8.count <= 65_536, context.utf8.count <= 131_072 else { throw HubGatewayError(message: "有请求正在进行，或消息/上下文超出限制") }
        let ids = Array(Set(endpointIDs)).sorted { $0.uuidString < $1.uuidString }
        guard (1...4).contains(ids.count) else { throw HubGatewayError(message: "请选择 1–4 个 API 路由") }
        let endpoints = try ids.map { id -> HubAPIEndpoint in
            guard let endpoint = state.endpoints.first(where: { $0.id == id && $0.enabled }) else { throw HubGatewayError(message: "所选路由不存在或已停用") }; return endpoint
        }
        guard purpose == nil || purpose == "proposal" else { throw HubGatewayError(message: "不支持的对话用途") }
        if let sourceMessageID {
            guard state.threads[index].messages.contains(where: { $0.id == sourceMessageID && $0.status == "completed" }), purpose == "proposal", context.utf8.count <= 32_768 else { throw HubGatewayError(message: "方案来源不存在或上下文超出任务限制") }
        }
        // Validate every request before recording any turn or sending data.
        let history = state.threads[index].messages.filter { $0.status == "completed" } + [HubChatMessage(role: "user", content: text)]
        let effectiveContext = context + (additionalInstructions.isEmpty ? "" : "\n\n" + additionalInstructions)
        guard effectiveContext.utf8.count <= 131_072 else { throw HubGatewayError(message: "发送上下文超过上限") }
        let outgoing = try endpoints.map { try HubGatewayClient.request(endpoint: $0, token: HubCredentialVault.token($0.id), context: effectiveContext, history: history) }
        let groupID = UUID()
        let question = HubChatMessage(role: "user", content: text, requestGroupID: groupID)
        let replies = endpoints.map { endpoint in HubChatMessage(role: "assistant", content: "", endpointID: endpoint.id,
            status: "running", purpose: purpose, sourceMessageID: sourceMessageID, contextSnapshot: purpose == "proposal" ? context : nil,
            receiptRunID: UUID(), requestGroupID: groupID, transport: transport) }
        let receipts = try zip(endpoints, replies).map { endpoint, reply in
            HubAPIReceipt(provider: try HubAPIEvidence.provider(endpoint.baseURL), model: endpoint.model,
                runID: reply.receiptRunID, startedAt: reply.createdAt,
                artifactPointer: HubAPIEvidence.artifactPointer(threadID: threadID, messageID: reply.id), acceptanceResult: "pending",
                endpointID: endpoint.id, requestGroupID: groupID, requestMessageID: question.id,
                routeFingerprint: try HubAPIEvidence.routeFingerprint(baseURL: endpoint.baseURL, model: endpoint.model),
                baseURL: try HubAPIEvidence.canonicalBaseURL(endpoint.baseURL), threadID: threadID, messageID: reply.id,
                transport: transport, status: "running")
        }
        try commit {
            state.threads[index].messages.append(question)
            state.threads[index].messages.append(contentsOf: replies)
            state.receipts = (state.receipts ?? []) + receipts
        }
        issue = nil
        for (request, reply) in zip(outgoing, replies) {
            activeRequestIDs.insert(reply.id)
            requests[reply.id] = Task { [weak self, session] in
                var httpStatus: Int?
                do {
                    let (data, response) = try await session.data(for: request)
                    try Task.checkCancellation()
                    httpStatus = (response as? HTTPURLResponse)?.statusCode
                    let content = try HubGatewayClient.response(data, status: httpStatus ?? 0)
                    self?.finish(threadID, reply.id, content: content, status: "completed", httpStatus: httpStatus)
                } catch {
                    let cancelled = Task.isCancelled || (error as? URLError)?.code == .cancelled
                    self?.finish(threadID, reply.id, content: cancelled ? "已停止请求；远端是否已处理无法撤销" : error.localizedDescription,
                                 status: cancelled ? "cancelled" : "failed", httpStatus: httpStatus)
                }
            }
        }
    }
    private func finish(_ threadID: UUID, _ messageID: UUID, content: String, status: String, httpStatus: Int?) {
        requests.removeValue(forKey: messageID); activeRequestIDs.remove(messageID)
        guard let i = state.threads.firstIndex(where: { $0.id == threadID }), let j = state.threads[i].messages.firstIndex(where: { $0.id == messageID }) else { return }
        do { try commit {
            state.threads[i].messages[j].content = content; state.threads[i].messages[j].status = status
            if let r = state.receipts?.firstIndex(where: { $0.threadID == threadID && $0.messageID == messageID }) {
                state.receipts?[r].endedAt = Date(); state.receipts?[r].status = status
                state.receipts?[r].acceptanceResult = status == "completed" ? "passed" : status
                state.receipts?[r].httpStatus = httpStatus
                state.receipts?[r].responseHash = status == "completed" ? HubAPIEvidence.responseHash(content) : nil
            }
        } } catch { issue = error.localizedDescription }
    }
    func receiptValidation(_ receipt: HubAPIReceipt) -> HubReceiptValidation { HubAPIEvidence.validate(receipt, in: state) }
    func endpointConnectionStatus(for endpoint: HubAPIEndpoint) -> HubEndpointConnectionStatus {
        let latest = state.receipts?.last(where: { receipt in
            if receipt.endpointID == endpoint.id { return true }
            // An incomplete receipt must not expose an older success badge just
            // because its endpoint field is missing; recover attribution only.
            return state.threads.contains { thread in thread.messages.contains { $0.id == receipt.messageID && $0.endpointID == endpoint.id } }
        })
        guard endpoint.enabled else { return .init(label: "已停用 · 未真实联通", isLiveVerified: false, receipt: latest, detail: "当前连接已停用") }
        guard let latest else { return .init(label: "未真实联通", isLiveVerified: false, receipt: nil, detail: "尚无完整的真实调用记录") }
        guard latest.routeFingerprint == (try? HubAPIEvidence.routeFingerprint(baseURL: endpoint.baseURL, model: endpoint.model)) else {
            return .init(label: "未真实联通 · 配置已变更", isLiveVerified: false, receipt: latest, detail: "最近一次记录不属于当前服务与模型")
        }
        let validation = receiptValidation(latest)
        if validation.isLiveVerified { return .init(label: "已真实联通", isLiveVerified: true, receipt: latest, detail: "最近一次真实网络调用通过文本响应校验；不代表工作任务验收") }
        let suffix: String
        switch latest.status {
        case "running": suffix = "请求中"
        case "failed": suffix = "最近调用失败"
        case "cancelled": suffix = "最近调用已取消"
        case "interrupted": suffix = "最近调用被中断"
        default: suffix = latest.transport == .fixture ? "离线 fixture" : "证据不完整"
        }
        return .init(label: "未真实联通 · " + suffix, isLiveVerified: false, receipt: latest, detail: validation.reasons.joined(separator: "；"))
    }
    func endpointConnectionLabel(for endpoint: HubAPIEndpoint) -> String { endpointConnectionStatus(for: endpoint).label }
    var phase15EvidenceGate: HubPhase15EvidenceGate {
        let receipts = state.receipts ?? []
        let live = receipts.filter { receipt in
            guard receiptValidation(receipt).isLiveVerified,
                  let endpoint = state.endpoints.first(where: { $0.id == receipt.endpointID }),
                  endpointConnectionStatus(for: endpoint).isLiveVerified,
                  receipt.routeFingerprint == (try? HubAPIEvidence.routeFingerprint(baseURL: endpoint.baseURL, model: endpoint.model)) else { return false }
            return true
        }
        let groups = Dictionary(grouping: live, by: { $0.requestGroupID! })
        let passing = groups.values.filter { group in
            Set(group.compactMap(\.routeFingerprint)).count >= 2 && Set(group.compactMap(\.requestMessageID)).count == 1 && Set(group.compactMap(\.threadID)).count == 1
        }.sorted { ($0.compactMap(\.endedAt).max() ?? .distantPast) > ($1.compactMap(\.endedAt).max() ?? .distantPast) }
        if let group = passing.first {
            return .init(passed: true, requestGroupID: group.first?.requestGroupID, receipts: group,
                         detail: "同一条提问已有至少两条不同服务/模型路由的真实完整回复；当前路由最近调用也有效")
        }
        return .init(passed: false, requestGroupID: nil, receipts: [], detail: "需要同一条真实提问经两条不同路由完成回复；fixture、缺字段、配置变更或最近失败均不计入")
    }
    func cancelRequests() { requests.values.forEach { $0.cancel() } }
}

private extension Optional where Wrapped == [String] { var orEmpty: [String] { self ?? [] } }
