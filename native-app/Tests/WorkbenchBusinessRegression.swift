import Foundation

final class ProposalFixtureProtocol: URLProtocol {
    static var requests: [URLRequest] = []
    static var bodies: [Data] = []
    static let lock = NSLock()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; body.append(contentsOf: buffer.prefix(n)) }
        }
        Self.lock.lock(); Self.requests.append(request); Self.bodies.append(body); Self.lock.unlock()
        let plan = #"{"title":"Implement feature","goal":"Deliver the feature","deliverables":"Patch and test receipt","acceptance":"Tests pass and output is reviewed","nodes":[{"id":"implement","title":"Implement and check","agentID":"fixture-agent","prompt":"Implement only the agreed goal"}]}"#
        let data = try! JSONSerialization.data(withJSONObject: ["choices": [["message": ["content": plan]]]])
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type":"application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main struct WorkbenchBusinessRegression {
    @MainActor static func main() async throws {
        var count = 0
        func check(_ condition: Bool, _ label: String) { precondition(condition, label); count += 1 }
        func reject(_ label: String, _ body: () throws -> Void) { do { try body(); fatalError(label) } catch { count += 1 } }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("business-loop-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [ProposalFixtureProtocol.self]
        let control = HubControlStore(file: root.appendingPathComponent("control.json"), session: URLSession(configuration: configuration))
        let store = WorkbenchStore(storageURL: root.appendingPathComponent("workbench.json"))
        let project = try store.createProject(workspaceID: store.state.workspaces[0].id, name: "Business loop fixture")
        let thread = try control.createThread(projectID: project, taskID: nil, title: "One continuous issue")
        let source = try control.append(threadID: thread, role: "user", content: "Implement a feature with evidence")
        let service = WorkbenchBusinessService(workbench: store, control: control, executorIDs: ["fixture-agent"])
        reject("missing source must not create a proposal") { _ = try service.draftProposal(threadID: thread, messageID: UUID(), context: "") }
        var draft = try service.draftProposal(threadID: thread, messageID: source, context: "Chosen context")
        draft.deliverables = "Actual command receipt"; draft.acceptance = "Receipt contains marker"
        draft.nodes = [WorkbenchNode(id: "echo", title: "Synthetic command", kind: .tool, command: "/bin/echo", arguments: ["BUSINESS_FIXTURE"])]
        try service.saveProposal(draft)
        let taskID = try service.acceptProposal(draft.id)
        check(try service.acceptProposal(draft.id) == taskID && store.state.tasks.count == 1, "acceptance is idempotent across the business service")
        check(service.conversationTasks(threadID: thread).map(\.id) == [taskID], "original conversation projects the linked task without a copied message")
        check(store.selectedTask?.confirmedRevision == nil && store.selectedTask?.policy.confirmed == false, "acceptance creates work without executing or granting permissions")
        var forged = draft; forged.source.evidence = .suggestion
        reject("source evidence is checked against the actual saved message") { try service.saveProposal(forged) }
        let otherThread = try control.createThread(projectID: UUID(), taskID: nil, title: "Invalid project")
        let otherSource = try control.append(threadID: otherThread, role: "user", content: "No")
        reject("unregistered project rejected") { _ = try service.draftProposal(threadID: otherThread, messageID: otherSource, context: "") }
        let suggestion = try control.append(threadID: thread, role: "assistant", content: "Model suggestion")
        let proposed = try service.draftProposal(threadID: thread, messageID: suggestion, context: "")
        check(proposed.source.evidence == .suggestion, "model text remains a suggestion in typed provenance")
        reject("oversize context rejected") { _ = try service.draftProposal(threadID: thread, messageID: source, context: String(repeating: "x", count: 32_769)) }
        var tampered = draft; tampered.projectID = UUID()
        reject("cross-project proposal cannot be saved") { try service.saveProposal(tampered) }
        let endpoint = HubAPIEndpoint(name: "Offline planning fixture", baseURL: "https://fixture.invalid/v1", model: "fixture-planner")
        try control.saveEndpoint(endpoint)
        let unaccepted = try service.draftProposal(threadID: thread, messageID: source, context: "Old unaccepted draft context")
        try service.saveProposal(unaccepted)
        try service.requestProposal(threadID: thread, messageID: source, endpointID: endpoint.id, context: "Frozen selected context")
        for _ in 0..<100 where !control.activeRequestIDs.isEmpty { try await Task.sleep(nanoseconds: 10_000_000) }
        let reply = control.state.threads.first { $0.id == thread }!.messages.last!
        check(reply.status == "completed" && reply.purpose == "proposal" && reply.sourceMessageID == source, "API proposal carries its original source through the real URLSession path")
        let imported = try service.importProposalReply(threadID: thread, messageID: reply.id)
        check(imported.contextSnapshot == "Frozen selected context" && imported.coordinatorEndpointID == endpoint.id, "proposal keeps the exact chosen context and coordinator")
        check(try service.importProposalReply(threadID: thread, messageID: reply.id).id == imported.id, "re-import does not duplicate a proposal")
        var forgedGeneration = imported; forgedGeneration.generationMessageID = UUID()
        reject("generated reply identity must be verified") { try service.saveProposal(forgedGeneration) }
        var forgedContext = imported; forgedContext.contextSnapshot = "Changed snapshot"
        reject("generated context snapshot must remain the one previewed") { try service.saveProposal(forgedContext) }
        let plannedTask = try service.acceptProposal(imported.id)
        check(store.state.tasks.first { $0.id == plannedTask }?.currentPlan.nodes.first?.agentID == "fixture-agent", "reviewed structured proposal supplies actual workflow steps")
        let object = try JSONSerialization.jsonObject(with: ProposalFixtureProtocol.bodies.last!) as! [String:Any]
        let system = (object["messages"] as! [[String:String]])[0]["content"]!
        check(system.contains("fixture-agent") && system.contains("Frozen selected context"), "planner receives registered executors and chosen context")
        for malicious in [
            #"{"title":"x","goal":"x","deliverables":"x","acceptance":"x","nodes":[{"id":"x","title":"x","agentID":"unknown"}]}"#,
            #"{"title":"x","goal":"x","deliverables":"x","acceptance":"x","nodes":[{"id":"x","title":"x","agentID":"fixture-agent","command":"/bin/sh"}]}"#,
            #"{"title":"x","goal":"x","deliverables":"x","acceptance":"x","nodes":[{"id":"x","title":"x","agentID":"fixture-agent","dependsOn":["missing"]}]}"#
        ] { reject("unsafe model plan rejected") { _ = try WorkbenchProposalParser.parse(malicious, base: proposed, executorIDs: ["fixture-agent"]) } }
        let largeFallback = try JSONSerialization.data(withJSONObject: ["title":"x", "goal":String(repeating:"x", count:20_000), "deliverables":"x", "acceptance":"x", "nodes":[["id":"x", "title":"x", "agentID":"fixture-agent"]]])
        reject("fallback prompt length cannot bypass parser bounds") { _ = try WorkbenchProposalParser.parse(String(decoding: largeFallback, as: UTF8.self), base: proposed, executorIDs: ["fixture-agent"]) }
        var largeProposal = draft; largeProposal.goal = String(repeating: "x", count: 32_769)
        check(!largeProposal.validationErrors.isEmpty, "oversize runtime fields rejected before adoption")
        var grants = WorkbenchPolicy(); grants.workingDirectory = root.path; grants.readRoots = [root.path]; grants.writeRoots = [root.path]; grants.allowedCommands = ["/bin/echo"]; grants.allowedTools = ["command"]
        try store.confirmPlan(taskID: taskID); try store.updatePolicy(taskID: taskID, policy: grants, confirm: true)
        var captured: WorkbenchRunRequest?
        store.onRun = { captured = $0 }
        let runID = try store.requestRun(taskID: taskID)
        check(captured?.source?.messageID == source && captured?.inputs == "Chosen context", "execution receives fixed source and context")
        let artifact = WorkbenchArtifact(title: "Fixture receipt", location: root.appendingPathComponent("receipt.txt").path)
        store.finishRun(runID: runID, status: .completed, summary: "Synthetic fixture, not a real command", artifacts: [artifact])
        check(service.conversationTasks(threadID: thread).first?.runs.last?.id == runID, "result returns to original conversation from the run record")
        reject("memory cannot be stored before acceptance") { try service.saveAcceptedMemory(taskID: taskID) }
        try store.verify(taskID: taskID, accepted: true, note: "Fixture receipt checked")
        try service.saveAcceptedMemory(taskID: taskID); try service.saveAcceptedMemory(taskID: taskID)
        check(control.state.memories.count == 1 && control.state.memories[0].sourceRunID == runID && control.state.memories[0].sourceAcceptanceID != nil, "accepted memory has evidence and is idempotent")
        let reloaded = WorkbenchStore(storageURL: store.storageURL)
        check(reloaded.state.proposals == store.state.proposals && reloaded.state.tasks.first?.acceptanceRecords == store.state.tasks.first?.acceptanceRecords, "proposal/task/acceptance loop survives reload")
        print("PASS: \(count) business loop checks (offline model and run receipts; no real account/model invoked)")
    }
}
