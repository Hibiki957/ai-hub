import AppKit
import Combine
import Foundation

struct RelayCapability: Identifiable, Decodable {
    let id: String
    let name: String
    let available: Bool
    let verified: Bool?
    let reason: String?
    let transport: String?
}

struct RelayModelOption: Identifiable, Decodable {
    let id: String
    let name: String
}

struct RelayModelCatalog: Decodable {
    let agent: String
    let availableModels: [RelayModelOption]
    let currentModelId: String?
    let modelControl: Bool
    let reason: String?
}

struct RelayRun: Identifiable, Codable {
    let id: String
    let goal: String
    let cwd: String
    let agents: [String]
    let createdAt: Date
    var status: String
    var currentAgent: String?
    var result: String
    var artifactPath: String?
    var completedSteps: Int
    var progress: String? = nil

    var title: String { String(goal.prefix(70)).replacingOccurrences(of: "\n", with: " ") }
    var statusLabel: String {
        switch status {
        case "running": return "接力中"
        case "waiting": return "等待确认"
        case "completed": return "已交付"
        case "cancelled": return "已停止"
        case "interrupted": return "运行已中断"
        default: return "需要处理"
        }
    }
}

struct RelayPermission: Identifiable {
    let id: String
    let runID: String
    let agent: String
    let title: String
    let kind: String
    let detail: String
}

/// Owns the native presentation and its own process handles. Step scheduling,
/// persistence/checkpoints and cancellation are delegated to the acpx bridge.
@MainActor
final class RelayRuntimeStore: ObservableObject {
    @Published private(set) var capabilities: [RelayCapability] = []
    @Published private(set) var runs: [RelayRun] = []
    @Published private(set) var permissions: [RelayPermission] = []
    @Published private(set) var detecting = false
    @Published private(set) var modelCatalogs: [String: RelayModelCatalog] = [:]
    @Published private(set) var loadingModels: Set<String> = []
    @Published var errorMessage: String?

    private struct Execution {
        let process: Process
        let input: Pipe
        let output: Pipe
        let errors: Pipe
    }
    private var executions: [String: Execution] = [:]
    private var buffers: [String: Data] = [:]
    private var stderrBuffers: [String: Data] = [:]
    private var detection: Process?
    private var modelQueries: [String: Process] = [:]
    private var exitCodes: [String: Int32] = [:]
    private var closedStreams: [String: Set<String>] = [:]
    private let storage: URL
    private let runtime: URL
    private let preview: Bool
    private let testRuntimeOverride: Bool
    static var primaryIDs: [String] { ToolCatalog.shared.primaryAgentIDs }

    static var runtimeDirectory: URL {
        let bundled = Bundle.main.resourceURL!.appendingPathComponent("RelayRuntime")
        if FileManager.default.fileExists(atPath: bundled.appendingPathComponent("bridge.mjs").path) { return bundled }
        return URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("runtime")
    }

    init(preview: Bool? = nil, runtimeDirectory: URL? = nil, storageDirectory: URL? = nil) {
        let preview = preview ?? AppModel.isPreview
        self.preview = preview
        testRuntimeOverride = runtimeDirectory != nil
        runtime = runtimeDirectory ?? Self.runtimeDirectory
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        storage = storageDirectory ?? appSupport.appendingPathComponent(preview ? "AIHubPreview/RelayRuns" : "AIHub/RelayRuns")
        if !preview { load() }
    }

    var isRunning: Bool { !executions.isEmpty }
    var runningCount: Int { executions.count }
    var hasOwnedProcesses: Bool { isRunning || detecting || !modelQueries.isEmpty }
    func capability(_ id: String) -> RelayCapability? { capabilities.first { $0.id == id } }
    func canRun(_ ids: [String]) -> Bool {
        !preview && !isRunning && modelQueries.isEmpty && !ids.isEmpty && ids.allSatisfy { capability($0)?.available == true }
    }

    func refreshCapabilities() {
        guard !detecting else { return }
        detecting = true
        let process = makeProcess(["capabilities"])
        let output = Pipe(), errors = Pipe()
        process.standardOutput = output; process.standardError = errors
        detection = process
        // The small detection response contains paths/capability facts only.
        process.terminationHandler = { [weak self] task in
            let data = output.fileHandleForReading.readDataToEndOfFile()
            let errorData = errors.fileHandleForReading.readDataToEndOfFile()
            Task { @MainActor in
                guard let self else { return }
                self.detecting = false; self.detection = nil
                struct Response: Decodable { let agents: [RelayCapability] }
                if task.terminationStatus == 0, let decoded = try? JSONDecoder().decode(Response.self, from: data) {
                    self.capabilities = decoded.agents
                    self.errorMessage = nil
                } else {
                    self.errorMessage = String(data: errorData, encoding: .utf8).flatMap { $0.isEmpty ? nil : $0 }
                        ?? "接力引擎暂不可用，请检查本地运行时。"
                }
            }
        }
        do { try process.run() }
        catch { detecting = false; detection = nil; errorMessage = error.localizedDescription }
    }

    func refreshModels(agent: String, cwd: String) {
        guard !preview, !isRunning, modelQueries.isEmpty, capability(agent)?.available == true else { return }
        guard !cwd.isEmpty else { errorMessage = "请先选择工作目录，再读取该工具的模型列表。"; return }
        let process = makeProcess(["models", "--agent", agent, "--cwd", cwd])
        let output = Pipe(), errors = Pipe()
        process.standardOutput = output; process.standardError = errors
        modelQueries[agent] = process; loadingModels.insert(agent)
        process.terminationHandler = { [weak self] task in
            let data = output.fileHandleForReading.readDataToEndOfFile()
            let errorData = errors.fileHandleForReading.readDataToEndOfFile()
            Task { @MainActor in
                guard let self else { return }
                self.modelQueries.removeValue(forKey: agent); self.loadingModels.remove(agent)
                if task.terminationStatus == 0, let catalog = try? JSONDecoder().decode(RelayModelCatalog.self, from: data) {
                    self.modelCatalogs[agent] = catalog
                    self.errorMessage = nil
                } else {
                    self.errorMessage = String(data: errorData, encoding: .utf8).flatMap { $0.isEmpty ? nil : String($0.suffix(1500)) }
                        ?? "模型列表读取失败，请使用工具当前模型，或检查执行器状态。"
                }
            }
        }
        do { try process.run() }
        catch {
            modelQueries.removeValue(forKey: agent); loadingModels.remove(agent)
            errorMessage = error.localizedDescription
        }
    }

    @discardableResult
    func start(goal: String, cwd: String, agents: [String], models: [String: String] = [:], timeoutMs: Int = 300_000) -> String? {
        guard testRuntimeOverride else {
            errorMessage = "旧接力不提供任务隔离。请在任务工作台确认计划和权限后执行。"
            return nil
        }
        let goal = goal.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !goal.isEmpty, canRun(agents) else { return nil }
        guard goal.utf8.count <= 32_768 else { errorMessage = "任务目标过长，请控制在 32 KiB 以内。"; return nil }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: cwd, isDirectory: &isDirectory), isDirectory.boolValue else {
            errorMessage = "请选择一个存在的工作目录。"; return nil
        }
        let id = UUID().uuidString.lowercased()
        let directory = storage.appendingPathComponent(id)
        let request = directory.appendingPathComponent("request.json")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let object: [String: Any] = ["id": id, "goal": goal, "cwd": cwd, "agents": agents,
                                       "outputDir": directory.path, "permissionMode": "interactive", "models": models,
                                       "timeoutMs": timeoutMs, "hostBound": true]
            try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted]).write(to: request, options: .atomic)
        } catch { errorMessage = error.localizedDescription; return nil }
        let process = makeProcess(["run", "--request", request.path])
        let input = Pipe(), output = Pipe(), errors = Pipe()
        process.standardInput = input; process.standardOutput = output; process.standardError = errors
        executions[id] = Execution(process: process, input: input, output: output, errors: errors)
        buffers[id] = Data(); stderrBuffers[id] = Data()
        runs.insert(RelayRun(id: id, goal: goal, cwd: cwd, agents: agents, createdAt: Date(), status: "running",
                             result: "", completedSteps: 0), at: 0)
        save(); errorMessage = nil
        process.terminationHandler = { [weak self] task in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self?.exitCodes[id] = task.terminationStatus
                    self?.settleIfFinished(id)
                }
            }
        }
        do {
            try process.run()
            pump(output.fileHandleForReading, stream: "stdout", runID: id)
            pump(errors.fileHandleForReading, stream: "stderr", runID: id)
        } catch { errorMessage = error.localizedDescription; finish(id, code: -1) }
        return id
    }

    func cancel(_ id: String) {
        guard let execution = executions[id] else { return }
        // Stop pending permission waits before the bridge handles SIGTERM.
        permissions.filter { $0.runID == id }.forEach { respond($0, allow: false) }
        update(id) { $0.status = "cancelled" }
        execution.process.terminate()
        save()
    }

    func cancelAllAndWait() async {
        if let detection, detection.isRunning { detection.terminate() }
        for process in modelQueries.values where process.isRunning { process.terminate() }
        for id in Array(executions.keys) { cancel(id) }
        let deadline = Date().addingTimeInterval(12)
        while hasOwnedProcesses && Date() < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    func respond(_ permission: RelayPermission, allow: Bool) {
        guard let execution = executions[permission.runID] else { return }
        let object: [String: String] = ["type": "permission_response", "requestId": permission.id,
                                       "decision": allow ? "allow_once" : "reject_once"]
        if let data = try? JSONSerialization.data(withJSONObject: object) {
            do { try execution.input.fileHandleForWriting.write(contentsOf: data + Data([10])) }
            catch { errorMessage = "无法回复执行器：\(error.localizedDescription)" }
        }
        permissions.removeAll { $0.id == permission.id }
        update(permission.runID) { $0.status = "running" }
    }

    func reveal(_ run: RelayRun) {
        let path = run.artifactPath ?? storage.appendingPathComponent(run.id).path
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    private func makeProcess(_ arguments: [String]) -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", runtime.appendingPathComponent("bridge.mjs").path] + arguments
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = AppModel.augmentedPATH
        process.environment = env
        process.currentDirectoryURL = runtime
        return process
    }

    private func pump(_ handle: FileHandle, stream: String, runID: String) {
        // Each pipe has one reader. FIFO main-queue delivery settles every byte
        // before its EOF marker; process termination alone never closes a run.
        DispatchQueue.global(qos: .utility).async { [weak self] in
            while true {
                let data = handle.availableData
                if data.isEmpty { break }
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        guard let self, self.executions[runID] != nil else { return }
                        if stream == "stdout" { self.consume(data, runID: runID) }
                        else {
                            var combined = self.stderrBuffers[runID] ?? Data(); combined.append(data)
                            self.stderrBuffers[runID] = Data(combined.suffix(32_768))
                        }
                    }
                }
            }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.closedStreams[runID, default: []].insert(stream)
                    self.settleIfFinished(runID)
                }
            }
        }
    }

    private func settleIfFinished(_ id: String) {
        guard let code = exitCodes[id], closedStreams[id]?.count == 2 else { return }
        if let remainder = buffers[id], !remainder.isEmpty { handleLine(remainder, runID: id) }
        finish(id, code: code)
    }

    private func consume(_ data: Data, runID: String) {
        guard executions[runID] != nil else { return }
        var buffer = buffers[runID] ?? Data(); buffer.append(data)
        while let newline = buffer.firstIndex(of: 10) {
            let line = Data(buffer[..<newline]); buffer.removeSubrange(...newline)
            handleLine(line, runID: runID)
        }
        // A malformed provider cannot grow the UI's line buffer without bound.
        buffers[runID] = Data(buffer.suffix(1_048_576))
    }

    private func handleLine(_ line: Data, runID: String) {
        guard let event = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
              let type = event["type"] as? String else { return }
        if let reported = event["runId"] as? String, reported != runID { return }
        switch type {
        case "session_info":
            if let agent = event["agent"] as? String,
               let data = try? JSONSerialization.data(withJSONObject: event),
               let catalog = try? JSONDecoder().decode(RelayModelCatalog.self, from: data) {
                modelCatalogs[agent] = catalog
            }
        case "step_start":
            update(runID) { $0.currentAgent = event["agent"] as? String; $0.status = "running" }
        case "message":
            if event["stream"] as? String == "status" {
                update(runID) { $0.progress = String((event["text"] as? String ?? "").prefix(160)) }
                return
            }
            if let text = event["text"] as? String {
                update(runID) { $0.result = String(($0.result + text).suffix(120_000)) }
            }
        case "step_complete":
            update(runID) { $0.completedSteps += 1 }
            save()
        case "permission":
            if let requestID = event["requestId"] as? String {
                permissions.append(RelayPermission(id: requestID, runID: runID,
                    agent: event["agent"] as? String ?? "执行器", title: event["title"] as? String ?? "请求执行操作",
                    kind: event["kind"] as? String ?? "tool", detail: event["detail"] as? String ?? ""))
                update(runID) { $0.status = "waiting" }
            }
        case "complete":
            update(runID) {
                $0.status = event["status"] as? String ?? "failed"
                $0.progress = nil
                if let result = event["result"] as? String, !result.isEmpty { $0.result = String(result.suffix(120_000)) }
                $0.artifactPath = event["artifactPath"] as? String
                if let error = event["error"] as? String, !error.isEmpty, !$0.result.contains(error) {
                    $0.result = String(($0.result + "\n" + error).suffix(120_000))
                }
            }
            save()
        case "error":
            let message = event["message"] as? String ?? event["error"] as? String ?? "执行失败，请查看运行记录。"
            update(runID) { $0.status = "failed"; $0.result += "\n" + message }
            save()
        default: break
        }
    }

    private func finish(_ id: String, code: Int32) {
        let errors = String(data: stderrBuffers[id] ?? Data(), encoding: .utf8) ?? ""
        update(id) {
            if $0.status == "running" || $0.status == "waiting" {
                $0.status = "failed"
                $0.result += "\n执行器退出（\(code)），未收到完整交付。\n" + errors
            }
        }
        executions.removeValue(forKey: id)
        buffers.removeValue(forKey: id); stderrBuffers.removeValue(forKey: id)
        exitCodes.removeValue(forKey: id); closedStreams.removeValue(forKey: id)
        permissions.removeAll { $0.runID == id }
        save()
    }

    private func update(_ id: String, _ operation: (inout RelayRun) -> Void) {
        guard let index = runs.firstIndex(where: { $0.id == id }) else { return }
        operation(&runs[index])
    }

    private func load() {
        let url = storage.appendingPathComponent("index.json")
        guard let data = try? Data(contentsOf: url), var saved = try? JSONDecoder().decode([RelayRun].self, from: data) else { return }
        for i in saved.indices where saved[i].status == "running" || saved[i].status == "waiting" { saved[i].status = "interrupted" }
        runs = saved
    }
    private func save() {
        guard !preview else { return }
        do {
            try FileManager.default.createDirectory(at: storage, withIntermediateDirectories: true)
            try JSONEncoder().encode(runs).write(to: storage.appendingPathComponent("index.json"), options: .atomic)
        } catch { errorMessage = "运行记录保存失败：\(error.localizedDescription)" }
    }
}
