import Foundation

final class FixtureProtocol: URLProtocol {
    static var received: [URLRequest] = []
    static let lock = NSLock()
    static var responseStatus = 200
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); Self.received.append(request); let status = Self.responseStatus; Self.lock.unlock()
        if request.url?.path.contains("slow") == true { return }
        let data = Data(#"{"choices":[{"message":{"content":"offline fixture reply"}}]}"#.utf8)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type":"application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
@main struct HubControlRegression {
    @MainActor static func main() async throws {
        var count = 0
        func check(_ condition: Bool, _ label: String) { precondition(condition, label); count += 1 }
        func reject(_ label: String, _ body: () throws -> Void) { do { try body(); fatalError(label) } catch { count += 1 } }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("hub-control-test-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        for bad in ["http://remote.example/v1", "https://u:secret@example.com", "https://example.com?token=secret", "file:///tmp", "https://example.com#fragment"] {
            reject("unsafe endpoint") { _ = try HubGatewayClient.endpointURL(bad) }
        }
        check(try HubGatewayClient.endpointURL("http://127.0.0.1:8000/v1").path == "/v1/chat/completions", "loopback service route")
        let endpoint = HubAPIEndpoint(name: "Fixture", baseURL: "https://fixture.invalid/v1", model: "fixture-model")
        let request = try HubGatewayClient.request(endpoint: endpoint, token: "placeholder-token", context: "Selected memory", history: [.init(role: "user", content: "A question")])
        let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
        check(request.value(forHTTPHeaderField: "Authorization") == "Bearer placeholder-token" && !request.url!.absoluteString.contains("placeholder-token"), "secret is header-only")
        check(body["model"] as? String == "fixture-model" && (body["messages"] as? [[String: String]])?.first?["content"] == "Selected memory", "actual dispatch body contains selected model and context")
        reject("HTTP errors rejected") { _ = try HubGatewayClient.response(Data(), status: 401) }
        reject("malformed response rejected") { _ = try HubGatewayClient.response(Data("{}".utf8), status: 200) }
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [FixtureProtocol.self]
        let session = URLSession(configuration: config)
        let file = root.appendingPathComponent("control.json")
        let store = HubControlStore(file: file, session: session)
        let project = UUID(), other = UUID(), task = UUID()
        try store.addMemory(scope: "global", text: "Global")
        try store.addMemory(scope: "project:" + project.uuidString, text: "Project")
        try store.addMemory(scope: "project:" + other.uuidString, text: "Other project")
        try store.addMemory(scope: "task:" + task.uuidString, text: "Task")
        check(store.memories(projectID: project, taskID: task).map(\.text) == ["Global", "Project", "Task"], "scope filter prevents unrelated memory")
        check(store.memories(projectID: nil, taskID: nil).map(\.text) == ["Global"], "global view does not expose project memory")
        reject("invalid scope rejected") { try store.addMemory(scope: "whatever", text: "No") }
        try store.saveEndpoint(endpoint)
        let second = HubAPIEndpoint(name: "Second fixture", baseURL: "https://fixture.invalid/v1", model: "second-model")
        try store.saveEndpoint(second)
        let thread = try store.createThread(projectID: project, taskID: task, title: "Offline fixture")
        reject("unknown provider does not append messages") { try store.send(threadID: thread, text: "Question", endpointIDs: [UUID()], context: "No") }
        check(store.state.threads[0].messages.isEmpty, "failed route validation is transactional")
        try store.send(threadID: thread, text: "Question", endpointIDs: [endpoint.id, second.id], context: "Explicitly selected context")
        for _ in 0..<100 where !store.activeRequestIDs.isEmpty { try await Task.sleep(nanoseconds: 10_000_000) }
        check(store.activeRequestIDs.isEmpty && store.state.threads[0].messages.count == 3, "parallel API discussion finishes in background with one user message and two attributed replies")
        check(store.state.threads[0].messages.filter { $0.role == "assistant" }.allSatisfy { $0.status == "completed" && $0.content == "offline fixture reply" && $0.endpointID != nil }, "reply sources and completion are retained")
        check(FixtureProtocol.received.count == 2, "real URLSession path exercised by offline protocol fixture")
        // Injected sessions are fixtures regardless of URL, HTTP success, or response body.
        check(store.transport == .fixture, "injected URLSession has unforgeable fixture provenance")
        let production = HubControlStore(file: root.appendingPathComponent("no-call-production.json"))
        check(production.transport == .liveNetwork && production.state.receipts == nil, "built-in session is live transport but configuration alone creates no evidence")
        let receipts = store.state.receipts ?? []
        check(receipts.count == 2 && Set(receipts.compactMap(\.runID)).count == 2, "each reply owns one distinct receipt run")
        check(Set(receipts.compactMap(\.requestGroupID)).count == 1 && Set(receipts.compactMap(\.requestMessageID)).count == 1, "parallel routes share one question group and source message")
        check(Set(receipts.compactMap(\.routeFingerprint)).count == 2, "different models produce distinct route fingerprints")
        check(receipts.allSatisfy { store.receiptValidation($0).structurallyValid }, "complete offline receipts pass structure and message validation")
        check(receipts.allSatisfy { !store.receiptValidation($0).isLiveVerified } && !store.phase15EvidenceGate.passed, "complete fixtures cannot satisfy real connection or Phase 1.5")
        check(store.endpointConnectionLabel(for: endpoint).contains("未真实联通"), "fixture endpoint UI never claims a live connection")
        check(receipts.allSatisfy { $0.provider == "https://fixture.invalid" && $0.model != nil && $0.startedAt != nil && $0.endedAt != nil && $0.acceptanceResult == "passed" && $0.httpStatus == 200 }, "mandatory ledger fields are retained")
        let firstReceipt = receipts[0]
        let firstReply = store.state.threads[0].messages.first { $0.id == firstReceipt.messageID }!
        check(firstReceipt.artifactPointer == "aihub://source/hubConversation/" + thread.uuidString + "/" + firstReply.id.uuidString && firstReceipt.responseHash == HubAPIEvidence.responseHash(firstReply.content), "receipt has typed Hub source identity and actual response hash without copied body")
        check(try HubAPIEvidence.routeFingerprint(baseURL: "https://FIXTURE.invalid:443/v1/", model: endpoint.model) == HubAPIEvidence.routeFingerprint(baseURL: endpoint.baseURL, model: endpoint.model), "equivalent normalized base URLs have the same route identity")
        var renamed = endpoint; renamed.name = "Different label"
        check(try HubAPIEvidence.routeFingerprint(baseURL: renamed.baseURL, model: renamed.model) == HubAPIEvidence.routeFingerprint(baseURL: endpoint.baseURL, model: endpoint.model), "endpoint names never affect route identity")
        let missingFields: [(String, (inout HubAPIReceipt) -> Void)] = [
            ("provider", { $0.provider = nil }), ("model", { $0.model = nil }), ("runID", { $0.runID = nil }),
            ("start", { $0.startedAt = nil }), ("end", { $0.endedAt = nil }), ("artifactPointer", { $0.artifactPointer = nil }),
            ("acceptance", { $0.acceptanceResult = nil }), ("endpointID", { $0.endpointID = nil }), ("requestGroupID", { $0.requestGroupID = nil }),
            ("requestMessageID", { $0.requestMessageID = nil }), ("fingerprint", { $0.routeFingerprint = nil }), ("baseURL", { $0.baseURL = nil }),
            ("threadID", { $0.threadID = nil }), ("messageID", { $0.messageID = nil }), ("transport", { $0.transport = nil }),
            ("hash", { $0.responseHash = nil }), ("httpStatus", { $0.httpStatus = nil }), ("status", { $0.status = nil })
        ]
        for (label, mutate) in missingFields {
            var receipt = firstReceipt; mutate(&receipt)
            var state = store.state; state.receipts?[0] = receipt
            check(!HubAPIEvidence.validate(receipt, in: state).structurallyValid, "missing " + label + " cannot count as evidence")
        }
        var wrong = firstReceipt; wrong.endedAt = wrong.startedAt!.addingTimeInterval(-1)
        check(!HubAPIEvidence.validate(wrong, in: store.state).structurallyValid, "reversed run times rejected")
        wrong = firstReceipt; wrong.artifactPointer = "aihub://conversation/" + UUID().uuidString
        check(!HubAPIEvidence.validate(wrong, in: store.state).structurallyValid, "unrelated artifact pointer rejected")
        wrong = firstReceipt; wrong.responseHash = String(repeating: "0", count: 64)
        check(!HubAPIEvidence.validate(wrong, in: store.state).structurallyValid, "response tampering rejected")
        wrong = firstReceipt; wrong.model = "different-model"
        check(!HubAPIEvidence.validate(wrong, in: store.state).structurallyValid, "model must match route fingerprint")
        wrong = firstReceipt; wrong.transport = .liveNetwork
        check(!HubAPIEvidence.validate(wrong, in: store.state).isLiveVerified, "changing a fixture receipt transport alone cannot promote its message provenance")
        var missingMessage = store.state; missingMessage.threads[0].messages.removeAll { $0.id == firstReceipt.messageID }
        check(!HubAPIEvidence.validate(firstReceipt, in: missingMessage).structurallyValid, "missing original reply rejected")
        var editedMessage = store.state
        let replyIndex = editedMessage.threads[0].messages.firstIndex { $0.id == firstReceipt.messageID }!
        editedMessage.threads[0].messages[replyIndex].status = "failed"
        check(!HubAPIEvidence.validate(firstReceipt, in: editedMessage).structurallyValid, "receipt cannot override a failed original reply")
        var duplicate = store.state; duplicate.receipts?.append(firstReceipt)
        check(!HubAPIEvidence.validate(firstReceipt, in: duplicate).structurallyValid, "duplicate receipt identities rejected")
        // These synthesized snapshots test verifier logic only; they are not network evidence.
        func syntheticLive(_ source: HubControlState) -> HubControlState {
            var value = source
            for i in value.receipts?.indices ?? 0..<0 { value.receipts?[i].transport = .liveNetwork }
            for i in value.threads.indices { for j in value.threads[i].messages.indices where value.threads[i].messages[j].role == "assistant" { value.threads[i].messages[j].transport = .liveNetwork } }
            return value
        }
        let syntheticFile = root.appendingPathComponent("synthetic-live-verifier.json")
        try JSONEncoder().encode(syntheticLive(store.state)).write(to: syntheticFile)
        let verifier = HubControlStore(file: syntheticFile, session: session)
        check(verifier.phase15EvidenceGate.passed && verifier.phase15EvidenceGate.receipts.count == 2, "offline verifier accepts a structurally complete claimed-live two-route snapshot")
        check(verifier.endpointConnectionStatus(for: renamed).isLiveVerified, "renaming a profile does not invalidate its route evidence")
        var changed = endpoint; changed.model = "new-model"
        check(!verifier.endpointConnectionStatus(for: changed).isLiveVerified, "changed model cannot reuse old evidence")
        changed = endpoint; changed.baseURL = "https://other.invalid/v1"
        check(!verifier.endpointConnectionStatus(for: changed).isLiveVerified, "changed service cannot reuse old evidence")
        changed = endpoint; changed.enabled = false
        check(!verifier.endpointConnectionStatus(for: changed).isLiveVerified, "disabled endpoint is not displayed as connected")
        var incomplete = syntheticLive(store.state); incomplete.receipts?[0].provider = nil
        let incompleteFile = root.appendingPathComponent("incomplete-evidence.json")
        try JSONEncoder().encode(incomplete).write(to: incompleteFile)
        let incompleteStore = HubControlStore(file: incompleteFile, session: session)
        check(!incompleteStore.phase15EvidenceGate.passed && incompleteStore.endpointConnectionLabel(for: incomplete.endpoints.first(where: { $0.id == firstReceipt.endpointID })!).contains("未真实联通"), "missing evidence field loads compatibly and blocks live badge and gate")
        var missingEndpoint = syntheticLive(store.state); missingEndpoint.receipts?[0].endpointID = nil
        let missingEndpointFile = root.appendingPathComponent("missing-endpoint-evidence.json")
        try JSONEncoder().encode(missingEndpoint).write(to: missingEndpointFile)
        let missingEndpointStore = HubControlStore(file: missingEndpointFile, session: session)
        check(!missingEndpointStore.endpointConnectionStatus(for: store.state.endpoints.first(where: { $0.id == firstReceipt.endpointID })!).isLiveVerified, "missing endpoint field cannot fall back to an older green status")
        var untyped = syntheticLive(store.state)
        untyped.receipts?[0].artifactPointer = "aihub://conversation/" + thread.uuidString + "/message/" + firstReply.id.uuidString
        let untypedFile = root.appendingPathComponent("old-untyped-evidence.json")
        let untypedBytes = try JSONEncoder().encode(untyped)
        try untypedBytes.write(to: untypedFile)
        let untypedStore = HubControlStore(file: untypedFile, session: session)
        let untypedAfter = try Data(contentsOf: untypedFile)
        check(untypedStore.state == untyped && untypedAfter == untypedBytes, "legacy untyped receipt loads read-only without inventing a source namespace")
        check(!untypedStore.receiptValidation(untypedStore.state.receipts![0]).isLiveVerified && !untypedStore.phase15EvidenceGate.passed, "ambiguous legacy pointer cannot qualify as real evidence even with live transport fields")
        var legacyNamespace = firstReceipt
        legacyNamespace.artifactPointer = "aihub://source/legacyConversation/" + thread.uuidString + "/" + firstReply.id.uuidString
        var namespaceState = store.state; namespaceState.receipts?[0] = legacyNamespace
        check(!HubAPIEvidence.validate(legacyNamespace, in: namespaceState).structurallyValid, "matching UUIDs in another source namespace cannot resolve as a Hub API response")
        var legacy = store.state; legacy.receipts = nil
        let legacyFile = root.appendingPathComponent("legacy-no-receipts.json"); try JSONEncoder().encode(legacy).write(to: legacyFile)
        let legacyStore = HubControlStore(file: legacyFile, session: session)
        check(legacyStore.state.receipts == nil && !legacyStore.phase15EvidenceGate.passed && !legacyStore.endpointConnectionStatus(for: endpoint).isLiveVerified, "schema 1 without receipts remains readable but unverified")
        let singles = HubControlStore(file: root.appendingPathComponent("singles.json"), session: session)
        try singles.saveEndpoint(endpoint); try singles.saveEndpoint(second)
        let singlesThread = try singles.createThread(projectID: nil, taskID: nil, title: "Separate questions")
        for route in [endpoint.id, second.id] {
            try singles.send(threadID: singlesThread, text: "Separate question", endpointIDs: [route], context: "Fixture")
            for _ in 0..<100 where !singles.activeRequestIDs.isEmpty { try await Task.sleep(nanoseconds: 10_000_000) }
        }
        let singleFile = root.appendingPathComponent("synthetic-singles.json"); try JSONEncoder().encode(syntheticLive(singles.state)).write(to: singleFile)
        check(!HubControlStore(file: singleFile, session: session).phase15EvidenceGate.passed, "two successful routes for different questions do not meet same-group gate")
        let aliasStore = HubControlStore(file: root.appendingPathComponent("aliases.json"), session: session)
        let alias = HubAPIEndpoint(name: "Alias label", baseURL: endpoint.baseURL, model: endpoint.model)
        try aliasStore.saveEndpoint(endpoint); try aliasStore.saveEndpoint(alias)
        let aliasThread = try aliasStore.createThread(projectID: nil, taskID: nil, title: "Same route twice")
        try aliasStore.send(threadID: aliasThread, text: "Question", endpointIDs: [endpoint.id, alias.id], context: "Fixture")
        for _ in 0..<100 where !aliasStore.activeRequestIDs.isEmpty { try await Task.sleep(nanoseconds: 10_000_000) }
        let aliasFile = root.appendingPathComponent("synthetic-aliases.json"); try JSONEncoder().encode(syntheticLive(aliasStore.state)).write(to: aliasFile)
        check(!HubControlStore(file: aliasFile, session: session).phase15EvidenceGate.passed, "two profiles with same baseURL and model cannot impersonate two routes")
        FixtureProtocol.responseStatus = 503
        try verifier.send(threadID: thread, text: "Failure after success", endpointIDs: [endpoint.id], context: "Fixture")
        for _ in 0..<100 where !verifier.activeRequestIDs.isEmpty { try await Task.sleep(nanoseconds: 10_000_000) }
        FixtureProtocol.responseStatus = 200
        check(verifier.state.receipts?.last?.status == "failed" && verifier.state.receipts?.last?.acceptanceResult == "failed" && verifier.state.receipts?.last?.httpStatus == 503 && verifier.state.receipts?.last?.endedAt != nil, "failed HTTP attempt writes terminal receipt")
        check(!verifier.endpointConnectionStatus(for: endpoint).isLiveVerified && !verifier.phase15EvidenceGate.passed, "recent failure invalidates old connected badge and Phase 1.5 gate")
        let reloaded = HubControlStore(file: file, session: session)
        check(reloaded.state == store.state, "memory, endpoint and conversations persist")
        let bytes = try String(contentsOf: file)
        check(!bytes.contains("placeholder-token"), "credentials absent from persisted JSON")
        let mode = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int
        check(mode == 0o600, "storage is user-private")
        var interrupted = store.state; interrupted.threads[0].messages.append(.init(role: "assistant", content: "", status: "running"))
        try JSONEncoder().encode(interrupted).write(to: file)
        let recovered = HubControlStore(file: file, session: session)
        check(recovered.state.threads[0].messages.last?.status == "interrupted" && recovered.activeRequestIDs.isEmpty, "restart does not replay model request")
        let slow = HubAPIEndpoint(name: "Slow fixture", baseURL: "https://fixture.invalid/slow/v1", model: "fixture")
        try store.saveEndpoint(slow)
        try store.send(threadID: thread, text: "Cancel this", endpointIDs: [slow.id], context: "No network")
        check(!store.activeRequestIDs.isEmpty, "pending request remains visible while switching pages")
        check(store.state.receipts?.last?.status == "running" && store.state.receipts?.last?.endedAt == nil && store.state.receipts?.last?.acceptanceResult == "pending", "running receipt is persisted before response")
        let recoveryFile = root.appendingPathComponent("recover-running-receipt.json")
        try JSONEncoder().encode(store.state).write(to: recoveryFile)
        let recoveryStore = HubControlStore(file: recoveryFile, session: session)
        check(recoveryStore.state.receipts?.last?.status == "interrupted" && recoveryStore.state.receipts?.last?.acceptanceResult == "interrupted" && recoveryStore.state.receipts?.last?.endedAt != nil && recoveryStore.state.threads[0].messages.last?.status == "interrupted", "restart atomically interrupts receipt and message without replay")
        check(recoveryStore.activeRequestIDs.isEmpty && !recoveryStore.phase15EvidenceGate.passed, "recovered evidence cannot claim success or start requests")
        store.cancelRequests()
        for _ in 0..<100 where !store.activeRequestIDs.isEmpty { try await Task.sleep(nanoseconds: 10_000_000) }
        check(store.activeRequestIDs.isEmpty && store.state.threads[0].messages.last?.status == "cancelled", "owned API request cancellation clears live state and persists outcome")
        check(store.state.receipts?.last?.status == "cancelled" && store.state.receipts?.last?.acceptanceResult == "cancelled" && store.state.receipts?.last?.endedAt != nil && store.state.receipts?.last?.responseHash == nil, "cancellation has a terminal non-success receipt")
        let corrupt = root.appendingPathComponent("corrupt.json"); try Data("broken".utf8).write(to: corrupt)
        let blocked = HubControlStore(file: corrupt, session: session)
        reject("corrupt store not overwritten") { try blocked.addMemory(scope: "global", text: "Must not save") }
        check(try String(contentsOf: corrupt) == "broken" && blocked.state.memories.isEmpty, "corrupt bytes and transactional state preserved")
        print("PASS: \(count) gateway/conversation/memory checks (offline URLSession fixtures; no account/model/API contacted)")
    }
}
