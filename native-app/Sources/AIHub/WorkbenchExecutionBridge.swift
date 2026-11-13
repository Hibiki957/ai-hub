import Combine
import Foundation

/// Native presentation/ownership only. The Node bridge compiles the same plan
/// into acpx FlowRunner actions and enforces the actual process policy.
@MainActor final class WorkbenchExecutionBridge: ObservableObject {
    struct Execution {
        let process: Process
        let input: Pipe
        let output: Pipe
        let errors: Pipe
    }
    @Published private(set) var sandboxStatus = "隔离尚未检查；执行器会在每次运行前自检。"
    @Published private(set) var activeCount = 0
    @Published private(set) var resourceSummary = "CPU / 内存尚无运行样本；模型用量、费用与供应商余额未知。"
    @Published var maxActiveTasks = 2
    private weak var store: WorkbenchStore?
    private var executions: [UUID: Execution] = [:]
    private var buffers: [UUID: Data] = [:]
    private var stderr: [UUID: Data] = [:]
    private var exits: [UUID: Int32] = [:]
    private var eof: [UUID: Set<String>] = [:]
    private var terminal: [UUID: [String: Any]] = [:]
    private var approvalIDs: [UUID: (UUID, String)] = [:]
    private var probeProcess: Process?
    private let runtime: URL
    private let storage: URL
    private let management: WorkbenchManagementStore
    private let preview: Bool
    private var monitor: Task<Void, Never>?

    init(store: WorkbenchStore, runtime: URL? = nil, storage: URL? = nil, preview: Bool = false, management: WorkbenchManagementStore? = nil) {
        self.store = store; self.runtime = runtime ?? RelayRuntimeStore.runtimeDirectory
        self.storage = storage ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/AIHub/WorkbenchRuns")
        self.preview = preview
        self.management = management ?? .shared
        store.onRun = { [weak self] request in
            guard let self else { throw BridgeError(message: "执行桥已关闭") }; try self.start(request)
        }
        store.onCancel = { [weak self] id in self?.cancel(id) }
        store.onApproval = { [weak self] id, allow in self?.respond(id, allow: allow) }
        store.onProposePlan = { [weak store] taskID in
            guard let store, let task = store.state.tasks.first(where: { $0.id == taskID }) else { return }
            var planner = WorkbenchNode(id: "planner", title: "提出待确认计划", kind: .agent)
            planner.agentID = task.currentPlan.nodes.first(where: { $0.kind == .agent })?.agentID ?? "hermes"
            planner.role = "规划者"
            planner.prompt = "只提出计划，不执行任务、不调用写入或外部工具。目标：\(task.goal)\n输入：\(task.inputs)\n验收：\(task.acceptance)\n返回纯 JSON：{\"summary\":\"说明\",\"nodes\":[{\"id\":\"step_1\",\"title\":\"步骤\",\"kind\":\"agent\",\"agentID\":\"hermes\",\"dependsOn\":[],\"prompt\":\"任务\",\"sideEffect\":\"none\"}]}。最多24步骤，角色不固定品牌；不要返回或修改权限、凭证或网络设置。"
            do {
                try store.revisePlan(taskID: taskID, nodes: [planner], summary: "AI 规划请求：结果仅为建议")
                store.errorMessage = "已生成受控规划步骤。请核对规划者、确认计划与权限后执行；模型返回的计划将作为未确认的新版本，不能自动执行。"
            } catch { store.errorMessage = error.localizedDescription }
        }
    }
    struct BridgeError: LocalizedError { let message: String; var errorDescription: String? { message } }
    var hasOwnedProcesses: Bool { !executions.isEmpty || probeProcess?.isRunning == true }

    private func process(_ args: [String]) -> Process {
        let result = Process()
        result.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        result.arguments = ["node", runtime.appendingPathComponent("workbench.mjs").path] + args
        let inherited = ProcessInfo.processInfo.environment
        var environment = inherited.filter { ["HOME", "LANG", "LC_ALL", "TMPDIR"].contains($0.key) }
        environment["PATH"] = AppModel.augmentedPATH
        result.environment = environment; result.currentDirectoryURL = runtime
        return result
    }
    func probe() {
        guard probeProcess == nil else { return }
        let child = process(["probe"]), output = Pipe()
        child.standardOutput = output; child.standardError = FileHandle.nullDevice
        probeProcess = child
        child.terminationHandler = { [weak self] child in
            let data = output.fileHandleForReading.readDataToEndOfFile()
            Task { @MainActor in
                guard let self else { return }; self.probeProcess = nil
                if let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                    let okay = object["available"] as? Bool ?? object["sandboxAvailable"] as? Bool ?? false
                    self.sandboxStatus = (okay ? "本机隔离自检通过。" : "隔离不可用，任务执行将被阻止。") + " " + (object["reason"] as? String ?? object["message"] as? String ?? "每次运行仍需检查具体授权。")
                } else { self.sandboxStatus = "隔离探测失败（\(child.terminationStatus)）；任务执行不会降级为无限权限。" }
            }
        }
        do { try child.run() } catch { probeProcess = nil; sandboxStatus = error.localizedDescription }
    }

    private func start(_ original: WorkbenchRunRequest) throws {
        var request = original
        if let task = store?.state.tasks.first(where: { $0.id == request.taskID }) {
            let skills = management.effectiveSkills(projectID: task.projectID.uuidString, taskID: task.id.uuidString)
            for skill in skills {
                let path = URL(fileURLWithPath: skill.canonicalSource).standardizedFileURL.path
                let granted = request.policy.readRoots.contains { root in path == root || path.hasPrefix(root.hasSuffix("/") ? root : root + "/") }
                guard granted else { throw BridgeError(message: "所选 Skill 尚未获得任务读取权限：\(skill.name)。请核对具体目录后重新确认权限。") }
            }
            if !skills.isEmpty {
                request.inputs += "\n按范围选入的方法引用（权限仍以执行策略为准）：\n" + skills.map { "\($0.name)：\($0.canonicalSource)（版本\($0.version)）" }.joined(separator: "\n")
            }
        }
        guard !preview else { throw BridgeError(message: "隔离预览不会执行任务") }
        guard executions[request.runID] == nil, executions.count < maxActiveTasks else { throw BridgeError(message: "已达到 Hub 同时任务上限；请等待现有任务结束") }
        guard FileManager.default.fileExists(atPath: runtime.appendingPathComponent("workbench.mjs").path) else { throw BridgeError(message: "缺少受控执行后端，不会使用旧接力绕过权限") }
        let directory = storage.appendingPathComponent(request.runID.uuidString)
        guard !FileManager.default.fileExists(atPath: directory.path) else { throw BridgeError(message: "运行标识已存在，禁止重复执行") }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = directory.appendingPathComponent("request.json")
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]; encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(request).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let child = process(["run", "--request", url.path]), input = Pipe(), output = Pipe(), errors = Pipe()
        child.standardInput = input; child.standardOutput = output; child.standardError = errors
        let id = request.runID
        executions[id] = Execution(process: child, input: input, output: output, errors: errors)
        buffers[id] = Data(); stderr[id] = Data(); activeCount = executions.count
        child.terminationHandler = { [weak self] child in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.exits[id] = child.terminationStatus; self?.settle(id) } }
        }
        do { try child.run(); pump(output.fileHandleForReading, id: id, stream: "out"); pump(errors.fileHandleForReading, id: id, stream: "err"); monitorResources() }
        catch { executions.removeValue(forKey: id); activeCount = executions.count; throw error }
    }
    private func monitorResources() {
        guard monitor == nil else { return }
        monitor = Task { [weak self] in
            while let self, !self.executions.isEmpty {
                let pids = self.executions.values.filter { $0.process.isRunning }.map { String($0.process.processIdentifier) }
                if !pids.isEmpty {
                    let text = await Task.detached {
                        WorkbenchNetworkStore.readCommand("/bin/ps", ["-o", "%cpu=,rss=", "-p", pids.joined(separator: ",")])
                    }.value
                    var cpu = 0.0, memory = 0.0
                    for line in text.components(separatedBy: "\n") {
                        let values = line.split(whereSeparator: \.isWhitespace).compactMap { Double($0) }
                        if values.count == 2 { cpu += values[0]; memory += values[1] }
                    }
                    self.resourceSummary = String(format: "Hub 执行桥根进程：CPU %.1f%% · RSS %.1f MiB（不含子进程，共享页非可回收估计）；模型用量/费用/余额未知。", cpu, memory / 1024)
                }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
            self?.monitor = nil
        }
    }
    private func pump(_ handle: FileHandle, id: UUID, stream: String) {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            while true {
                let data = handle.availableData
                if data.isEmpty { break }
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        guard let self, self.executions[id] != nil else { return }
                        if stream == "out" { self.consume(data, id: id) }
                        else { self.stderr[id] = Data(((self.stderr[id] ?? Data()) + data).suffix(32_768)) }
                    }
                }
            }
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.eof[id, default: []].insert(stream); self?.settle(id) } }
        }
    }
    private func consume(_ data: Data, id: UUID) {
        var buffer = (buffers[id] ?? Data()) + data
        while let newline = buffer.firstIndex(of: 10) {
            handle(Data(buffer[..<newline]), id: id); buffer.removeSubrange(...newline)
        }
        buffers[id] = Data(buffer.suffix(1_048_576))
    }
    private func handle(_ data: Data, id: UUID) {
        guard let event = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let kind = event["type"] as? String else { return }
        if let reported = event["runID"] as? String, reported.lowercased() != id.uuidString.lowercased() { return }
        let node = event["nodeID"] as? String
        if kind == "complete" { terminal[id] = event; return }
        if kind == "approval", let requestID = event["requestID"] as? String {
            let details: String
            if let text = event["details"] as? String { details = text }
            else if let data = try? JSONSerialization.data(withJSONObject: event, options: [.prettyPrinted, .sortedKeys]) { details = String(decoding: data, as: UTF8.self) }
            else { details = "执行器未提供具体内容，应拒绝此次请求。" }
            let expiresAt = (event["expiresAt"] as? String).flatMap(WorkbenchPolicy.expiryDate)
            if let approvalID = store?.requestApproval(runID: id, nodeID: node, summary: event["summary"] as? String ?? "确认此次操作", details: details, expiresAt: expiresAt) {
                approvalIDs[approvalID] = (id, requestID)
            } else {
                sendApproval(runID: id, requestID: requestID, allow: false)
                store?.appendRunEvent(runID: id, kind: "approval-rejected", summary: "审批缺少有效期限或运行已不再接受审批，已拒绝此次请求。", nodeID: node)
            }
            return
        }
        let summary = event["summary"] as? String ?? event["message"] as? String ?? event["text"] as? String ?? kind
        store?.appendRunEvent(runID: id, kind: kind, summary: String(summary.prefix(8192)), nodeID: node)
    }
    private func settle(_ id: UUID) {
        guard let exit = exits[id], eof[id]?.count == 2 else { return }
        if let data = buffers[id], !data.isEmpty { handle(data, id: id) }
        if let value = terminal[id] {
            let reportedStatus = WorkbenchRunStatus(rawValue: value["status"] as? String ?? "failed") ?? .failed
            let status: WorkbenchRunStatus = reportedStatus == .completed && exit != 0 ? .failed : reportedStatus
            let outcomeText = value["summary"] as? String ?? ""
            let diagnostic = reportedStatus == .completed && exit != 0
                ? "执行器报告完成但进程异常退出（\(exit)）；不能视为完成，请检查产物。"
                : value["error"] as? String ?? ""
            let summary = [outcomeText, diagnostic].filter { !$0.isEmpty }.joined(separator: "\n")
            let artifacts = (value["artifactPaths"] as? [String] ?? []).map { WorkbenchArtifact(title: URL(fileURLWithPath: $0).lastPathComponent, location: $0, verification: "运行时记录；待人工验收") }
            store?.finishRun(runID: id, status: status.terminal ? status : .failed, summary: summary, artifacts: artifacts)
            if status == .completed { applyPlanningProposal(runID: id, text: summary) }
        } else {
            let diagnostic = String(decoding: stderr[id] ?? Data(), as: UTF8.self)
            store?.finishRun(runID: id, status: .failed, summary: "执行器退出（\(exit)），没有完整终态收据。\n" + diagnostic)
        }
        executions.removeValue(forKey: id); buffers.removeValue(forKey: id); stderr.removeValue(forKey: id)
        exits.removeValue(forKey: id); eof.removeValue(forKey: id); terminal.removeValue(forKey: id)
        approvalIDs = approvalIDs.filter { $0.value.0 != id }; activeCount = executions.count
    }
    private func applyPlanningProposal(runID: UUID, text: String) {
        guard let store, let task = store.state.tasks.first(where: { $0.runs.contains { $0.id == runID } }),
              task.runs.first(where: { $0.id == runID })?.plan.summary.hasPrefix("AI 规划请求") == true,
              let data = text.data(using: .utf8),
              let proposal = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let rows = proposal["nodes"] as? [[String: Any]], !rows.isEmpty, rows.count <= 24 else { return }
        var nodes: [WorkbenchNode] = []
        for row in rows {
            guard let nodeID = row["id"] as? String, let title = row["title"] as? String,
                  let kindName = row["kind"] as? String, let kind = WorkbenchNodeKind(rawValue: kindName) else { return }
            var node = WorkbenchNode(id: nodeID, title: String(title.prefix(200)), kind: kind)
            node.dependsOn = row["dependsOn"] as? [String] ?? []
            node.agentID = row["agentID"] as? String; node.model = row["model"] as? String
            node.prompt = String((row["prompt"] as? String ?? "").prefix(32_768))
            node.command = row["command"] as? String; node.arguments = row["arguments"] as? [String] ?? []
            node.condition = row["condition"] as? String
            node.sideEffect = WorkbenchSideEffect(rawValue: row["sideEffect"] as? String ?? "external") ?? .external
            nodes.append(node)
        }
        let candidate = WorkbenchPlan(revision: task.currentPlan.revision + 1, nodes: nodes)
        guard candidate.validationErrors().isEmpty else {
            store.appendRunEvent(runID: runID, kind: "planning-invalid", summary: "规划输出未通过依赖/节点检查，请人工编辑后确认。")
            return
        }
        do {
            try store.revisePlan(taskID: task.id, nodes: nodes, summary: "AI 建议，待用户确认：" + String((proposal["summary"] as? String ?? "").prefix(500)))
            store.appendRunEvent(runID: runID, kind: "planning-proposal", summary: "已保存未确认的新计划版本；模型输出未获得额外权限。")
        } catch { store.errorMessage = error.localizedDescription }
    }
    func cancel(_ id: UUID) {
        guard let execution = executions[id], execution.process.isRunning else { return }
        execution.process.terminate()
    }
    private func respond(_ approvalID: UUID, allow: Bool) {
        guard let (id, requestID) = approvalIDs.removeValue(forKey: approvalID) else { return }
        sendApproval(runID: id, requestID: requestID, allow: allow)
    }
    private func sendApproval(runID id: UUID, requestID: String, allow: Bool) {
        guard let execution = executions[id] else { return }
        let value: [String: String] = ["type": "approval_response", "requestID": requestID, "decision": allow ? "allow_once" : "reject_once"]
        do { try execution.input.fileHandleForWriting.write(contentsOf: JSONSerialization.data(withJSONObject: value) + Data([10])) }
        catch { store?.errorMessage = "审批通道已关闭：" + error.localizedDescription }
    }
    func cancelAllAndWait() async {
        probeProcess?.terminate()
        for id in executions.keys { cancel(id) }
        for _ in 0..<120 {
            if !hasOwnedProcesses { return }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }
}
