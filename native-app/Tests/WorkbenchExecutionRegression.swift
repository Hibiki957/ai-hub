import CryptoKit
import Darwin
import Foundation
import SwiftUI

// Unrelated settings presentation is not mounted in execution regressions.
struct HarnessDiagnosticsView: View { var body: some View { EmptyView() } }

// Only application wiring is substituted. Store, bridge, policy, management,
// catalog and the successful Node/Seatbelt runs use their production sources.
// The explicitly labelled negative protocol fixture only tests failure handling;
// it does not execute a command and is not evidence of successful task execution.
enum AppModel {
    static let isPreview = false
    static let augmentedPATH = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"
}

@main
struct WorkbenchExecutionRegression {
    struct Failure: Error, CustomStringConvertible { let description: String }
    @MainActor static var checks = 0

    @MainActor static func check(_ condition: @autoclosure () -> Bool, _ label: String) throws {
        guard condition() else { throw Failure(description: label) }
        checks += 1
    }
    static func object(_ url: URL) throws -> [String: Any] {
        guard let value = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else {
            throw Failure(description: "Expected JSON object: \(url.lastPathComponent)")
        }
        return value
    }
    static func unwrap<T>(_ value: T?, _ label: String) throws -> T {
        guard let value else { throw Failure(description: label) }; return value
    }
    static func physicalURL(_ url: URL) throws -> URL {
        guard let path = realpath(url.path, nil) else { throw Failure(description: "Cannot resolve fixture directory") }
        defer { free(path) }
        return URL(fileURLWithPath: String(cString: path))
    }
    static func persistedBytes<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(value)
    }
    @MainActor static func waitFor(_ label: String, diagnostic: () -> String = { "" }, condition: () -> Bool) async throws {
        for _ in 0..<500 {
            if condition() { return }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        throw Failure(description: "Timed out: \(label). \(diagnostic())")
    }
    @MainActor static func task(_ store: WorkbenchStore, _ id: UUID) throws -> WorkbenchTask {
        try unwrap(store.state.tasks.first { $0.id == id }, "Task missing from real store")
    }
    @MainActor static func prepare(_ store: WorkbenchStore, project: UUID, cwd: URL, marker: String, approval: Bool) throws -> UUID {
        let id = try store.createTask(projectID: project, goal: "Offline native bridge regression \(marker)")
        var draft = try task(store, id)
        draft.acceptance = "The real sandboxed echo output is persisted for manual acceptance."
        draft.inputs = "Synthetic fixture only"
        draft.constraints = "No models, external services or personal documents"
        draft.deliverables = "Immutable result and provenance files"
        draft.decisionSummary = "Explicit fixture plan"
        try store.updateDetails(draft)
        var nodes: [WorkbenchNode] = []
        if approval { nodes.append(WorkbenchNode(id: "confirm", title: "Allow this fixture once", kind: .approval, prompt: "Approve synthetic echo only")) }
        nodes.append(WorkbenchNode(id: "echo", title: "Run real echo", kind: .tool,
                                   dependsOn: approval ? ["confirm"] : [], command: "/bin/echo", arguments: [marker], timeoutMs: 10_000))
        nodes.append(WorkbenchNode(id: "result", title: "Collect result", kind: .output, dependsOn: ["echo"], timeoutMs: 10_000))
        try store.revisePlan(taskID: id, nodes: nodes, summary: "Offline executable fixture")
        try store.confirmPlan(taskID: id)
        var policy = WorkbenchPolicy()
        policy.workingDirectory = cwd.path
        policy.readRoots = [cwd.path]
        policy.writeRoots = [cwd.path]
        policy.allowedCommands = ["/bin/echo"]
        policy.allowedTools = ["command"]
        policy.expiresAt = Date().addingTimeInterval(180)
        policy.budgetUSD = nil
        try store.updatePolicy(taskID: id, policy: policy, confirm: true)
        return id
    }
    @MainActor static func completed(_ store: WorkbenchStore, bridge: WorkbenchExecutionBridge, taskID: UUID, runID: UUID) async throws -> WorkbenchRun {
        try await waitFor("native bridge process and both streams to settle", diagnostic: {
            store.state.tasks.first { $0.id == taskID }?.runs.last?.summary ?? store.errorMessage ?? "No run receipt"
        }) {
            !bridge.hasOwnedProcesses && bridge.activeCount == 0 &&
                store.state.tasks.first { $0.id == taskID }?.runs.first { $0.id == runID }?.status.terminal == true
        }
        let value = try task(store, taskID)
        let run = try unwrap(value.runs.first { $0.id == runID }, "Completed run missing")
        try check(run.status == .completed, "Real runtime failed: \(run.summary)")
        try check(value.status == .awaitingAcceptance, "Execution completion must await user acceptance")
        try check(run.finishedAt != nil && !bridge.hasOwnedProcesses, "Completion must follow process and EOF settlement")
        try check(store.errorMessage == nil, "Store persistence or approval error: \(store.errorMessage ?? "")")
        return run
    }
    @MainActor static func verifyArtifacts(_ run: WorkbenchRun, cwd: URL, marker: String, nodeCount: Int) throws {
        let expectedRunRoot = cwd.appendingPathComponent(".aihub-runs/\(run.id.uuidString)")
        try check(run.summary.contains(marker), "Native summary must contain actual echo stdout")
        try check(run.artifacts.count == nodeCount + 1, "Summary and every completed node manifest must reach native Store")
        try check(run.artifacts.allSatisfy { $0.location.hasPrefix(expectedRunRoot.path + "/") }, "Artifacts must stay within this temporary run")
        let summary = try object(expectedRunRoot.appendingPathComponent("summary.json"))
        try check(summary["status"] as? String == "completed", "Node summary must report completed")
        try check(summary["summary"] as? String == run.summary, "Swift summary must exactly match the real Node receipt")
        try check(summary["usage"] is NSNull && summary["costUSD"] is NSNull, "Unknown usage and cost must stay unknown")
        let nodes = try unwrap(summary["nodes"] as? [String: [String: Any]], "Node receipts missing")
        try check(nodes["echo"]?["text"] as? String == marker + "\n", "Echo receipt must contain the actual process stdout")
        for id in ["echo", "result"] {
            let manifest = try object(expectedRunRoot.appendingPathComponent("artifacts/\(id)/manifest.json"))
            let files = try unwrap(manifest["files"] as? [[String: Any]], "Manifest files missing")
            let result = try unwrap(files.first { $0["relativePath"] as? String == "result.txt" }, "Immutable result missing")
            let path = try unwrap(result["path"] as? String, "Result path missing")
            let content = try Data(contentsOf: URL(fileURLWithPath: path))
            try check(String(decoding: content, as: UTF8.self).contains(marker), "Published \(id) result must contain the real marker")
            let hash = SHA256.hash(data: content).map { String(format: "%02x", $0) }.joined()
            try check(result["sha256"] as? String == hash, "Published \(id) hash must match actual bytes")
        }
        let handoff = try object(expectedRunRoot.appendingPathComponent("artifacts/result/handoff.json"))
        let previous = handoff["completed"] as? [[String: Any]]
        try check(previous?.first?["summary"] as? String == marker + "\n", "Dependent output must receive echo's actual handoff")
    }

    @MainActor static func main() async {
        var bridge: WorkbenchExecutionBridge?
        do {
            guard CommandLine.arguments.count == 3 else { throw Failure(description: "Usage: check RUNTIME_DIRECTORY TEMP_FIXTURE_DIRECTORY") }
            let fm = FileManager.default
            let runtime = URL(fileURLWithPath: CommandLine.arguments[1]).resolvingSymlinksInPath()
            let requestedFixture = URL(fileURLWithPath: CommandLine.arguments[2])
            // Match Node realpath, including macOS's /tmp → /private/tmp alias.
            let fixture = try physicalURL(requestedFixture.deletingLastPathComponent())
                .appendingPathComponent(requestedFixture.lastPathComponent)
            let isolatedHome = try physicalURL(URL(fileURLWithPath: ProcessInfo.processInfo.environment["HOME"] ?? "/"))
            // Refuse direct use outside the wrapper's fresh temporary root.
            try check(fixture.path.hasPrefix("/private/tmp/aihub-execution-check."), "Fixture must be in an owned test directory")
            try check(isolatedHome.deletingLastPathComponent().path == fixture.deletingLastPathComponent().path, "The Node process must use the same isolated test HOME")
            try check(fm.fileExists(atPath: runtime.appendingPathComponent("workbench.mjs").path), "Real workbench runtime must exist")
            try check(!fm.fileExists(atPath: fixture.path), "Fixture must be fresh; never overwrite existing Hub data")
            try fm.createDirectory(at: fixture, withIntermediateDirectories: true)
            let cwd = fixture.appendingPathComponent("work directory with spaces")
            try fm.createDirectory(at: cwd, withIntermediateDirectories: true)
            let storage = fixture.appendingPathComponent("hub/workbench-v1.json")
            let bridgeStorage = fixture.appendingPathComponent("hub/WorkbenchRuns")
            let manager = WorkbenchManagementStore(directory: fixture.appendingPathComponent("hub/Management"))
            let store = WorkbenchStore(storageURL: storage)
            let execution = WorkbenchExecutionBridge(store: store, runtime: runtime, storage: bridgeStorage, management: manager)
            bridge = execution
            try check(manager.inventory.isEmpty && manager.scopes.isEmpty, "Temporary management must not import user selections")
            let workspace = try unwrap(store.state.workspaces.first?.id, "Initial workspace missing")
            let project = try store.createProject(workspaceID: workspace, name: "Native E2E fixture")
            let marker = "NATIVE_E2E_" + UUID().uuidString
            let id = try prepare(store, project: project, cwd: cwd, marker: marker, approval: false)
            let runID = try store.requestRun(taskID: id)
            try check(execution.activeCount == 1, "Store request must launch the real owned bridge process")
            let run = try await completed(store, bridge: execution, taskID: id, runID: runID)
            try verifyArtifacts(run, cwd: cwd, marker: marker, nodeCount: 2)

            let native = try object(bridgeStorage.appendingPathComponent("\(runID.uuidString)/request.json"))
            let nativePolicy = try unwrap(native["policy"] as? [String: Any], "Native wire policy missing")
            let expiry = try unwrap(nativePolicy["expiresAt"] as? String, "Native expiry must be ISO text")
            try check(WorkbenchPolicy.expiryDate(expiry) != nil, "Wire expiry must parse as ISO 8601")
            try check(nativePolicy["budgetUSD"] == nil, "Swift nil budget must be omitted, not converted to zero")
            let normalized = try object(cwd.appendingPathComponent(".aihub-runs/\(runID.uuidString)/request.json"))
            let normalizedPolicy = try unwrap(normalized["policy"] as? [String: Any], "Runtime normalized policy missing")
            try check(normalizedPolicy["budgetUSD"] is NSNull, "Real JS validator must normalize omitted budget to unknown/null")
            try check(normalizedPolicy["expiresAt"] as? String == expiry, "ISO expiry must survive the Swift/JS boundary unchanged")
            try check(normalizedPolicy["networkHosts"] as? [String] == [], "Tool fixture must authorize no network")

            let reload = WorkbenchStore(storageURL: storage)
            let restored = try task(reload, id)
            try check(reload.errorMessage == nil && restored.status == .awaitingAcceptance, "Restart must preserve awaiting acceptance")
            // Policy ISO timestamps intentionally persist millisecond precision.
            let restoredBytes = try persistedBytes(restored.runs)
            let expectedBytes = try persistedBytes([run])
            try check(restoredBytes == expectedBytes, "Restart must preserve every persisted run, policy, artifact and result field")
            try check(restored.policy.budgetUSD == nil && restored.policy.expiresAt != nil, "Restart must decode nil budget and ISO expiry")
            try check(reload.onRun == nil && !execution.hasOwnedProcesses, "Restart must not replay a completed task")
            print("PASS real Swift → Node → Seatbelt echo, immutable results and persistence")

            // A complete business chain with a real sandboxed command, no model or account.
            let control = HubControlStore(file: fixture.appendingPathComponent("hub/control.json"))
            let business = WorkbenchBusinessService(workbench: store, control: control, executorIDs: [])
            let discussion = try control.createThread(projectID: project, taskID: nil, title: "Real command business loop")
            let origin = try control.append(threadID: discussion, role: "user", content: "Produce an offline echo receipt")
            var proposal = try business.draftProposal(threadID: discussion, messageID: origin, context: "Explicit synthetic context")
            let businessMarker = "BUSINESS_E2E_" + UUID().uuidString
            proposal.deliverables = "Echo output and immutable manifests"
            proposal.acceptance = "The actual receipt contains the unique marker"
            proposal.nodes = [WorkbenchNode(id: "echo", title: "Produce real receipt", kind: .tool, command: "/bin/echo", arguments: [businessMarker], timeoutMs: 10_000),
                              WorkbenchNode(id: "result", title: "Collect receipt", kind: .output, dependsOn: ["echo"], timeoutMs: 10_000)]
            try business.saveProposal(proposal)
            let businessTask = try business.acceptProposal(proposal.id)
            let repeatedBusinessTask = try business.acceptProposal(proposal.id)
            try check(repeatedBusinessTask == businessTask, "Repeated business acceptance must not duplicate work")
            try store.confirmPlan(taskID: businessTask)
            var businessPolicy = WorkbenchPolicy()
            businessPolicy.workingDirectory = cwd.path; businessPolicy.readRoots = [cwd.path]; businessPolicy.writeRoots = [cwd.path]
            businessPolicy.allowedCommands = ["/bin/echo"]; businessPolicy.allowedTools = ["command"]; businessPolicy.expiresAt = Date().addingTimeInterval(180)
            try store.updatePolicy(taskID: businessTask, policy: businessPolicy, confirm: true)
            let businessRun = try store.requestRun(taskID: businessTask)
            let businessReceipt = try await completed(store, bridge: execution, taskID: businessTask, runID: businessRun)
            try verifyArtifacts(businessReceipt, cwd: cwd, marker: businessMarker, nodeCount: 2)
            try check(business.conversationTasks(threadID: discussion).last?.runs.last?.id == businessRun, "Real receipt must project back to original issue")
            try check(businessReceipt.source?.messageID == origin, "Real run must retain its original request identity")
            try store.verify(taskID: businessTask, accepted: true, note: "Real sandboxed marker and manifests inspected")
            try business.saveAcceptedMemory(taskID: businessTask)
            try check(control.state.memories.first?.sourceRunID == businessRun, "Adopted conclusion must name the actual real run")
            print("PASS business issue → proposal → task → real sandboxed command → original issue → acceptance → sourced memory")

            let approvedMarker = "APPROVED_E2E_" + UUID().uuidString
            let approvalTask = try prepare(store, project: project, cwd: cwd, marker: approvedMarker, approval: true)
            let approvalRun = try store.requestRun(taskID: approvalTask)
            try await waitFor("real runtime approval event", diagnostic: {
                store.state.tasks.first { $0.id == approvalTask }?.runs.last?.summary ?? ""
            }) { store.state.approvals.contains { $0.runID == approvalRun && $0.resolvedAt == nil } }
            let pending = try unwrap(store.state.approvals.first { $0.runID == approvalRun && $0.resolvedAt == nil }, "Pending approval missing")
            let awaiting = try task(store, approvalTask)
            try check(awaiting.status == .awaitingApproval && awaiting.runs.last?.status == .awaitingApproval, "Real approval must pause both task and run")
            try check(pending.expiresAt > Date() && pending.expiresAt <= awaiting.policy.expiresAt!, "Approval deadline must parse from JS and respect task grant expiry")
            try check(pending.details.contains("policyHash") && pending.details.contains("writeDirectory") && pending.details.contains(approvalRun.uuidString), "Approval must preserve concrete runtime scope details")
            try await Task.sleep(nanoseconds: 200_000_000)
            try check(execution.activeCount == 1 && !fm.fileExists(atPath: cwd.appendingPathComponent(".aihub-runs/\(approvalRun.uuidString)/artifacts/echo/manifest.json").path), "Dependent echo must not run before approval")
            try store.resolveApproval(pending.id, allowed: true)
            let approvedRun = try await completed(store, bridge: execution, taskID: approvalTask, runID: approvalRun)
            try verifyArtifacts(approvedRun, cwd: cwd, marker: approvedMarker, nodeCount: 3)
            let resolution = try unwrap(store.state.approvals.first { $0.id == pending.id }, "Approval resolution disappeared")
            try check(resolution.allowed == true && resolution.resolvedAt != nil, "Native allow decision must persist")
            let approvedTask = try task(store, approvalTask)
            try check(approvedTask.events.contains { $0.summary.contains("用户允许本节点一次执行") }, "Runtime must acknowledge actual stdin allow_once response")
            let finalReload = WorkbenchStore(storageURL: storage)
            try check(finalReload.state.approvals.first { $0.id == pending.id } == resolution, "Approval outcome must survive restart")
            let reloadedApprovalTask = try task(finalReload, approvalTask)
            let reloadedApprovedBytes = try persistedBytes(reloadedApprovalTask.runs)
            let expectedApprovedBytes = try persistedBytes([approvedRun])
            try check(reloadedApprovedBytes == expectedApprovedBytes, "Approved run artifacts and result must survive restart")
            print("PASS real approval NDJSON/stdin round trip and dependent command gating")
            await execution.cancelAllAndWait()
            try check(!execution.hasOwnedProcesses && execution.activeCount == 0, "Regression must leave no owned processes")
            let realChecks = checks
            print("REAL command-chain E2E: \(realChecks) checks passed")

            // Deliberately contradictory protocol fixture. This separate runtime
            // only reads our synthetic request, writes a matching complete event
            // synchronously, and immediately exits 1. No tool command is run.
            let negativeRoot = fixture.appendingPathComponent("negative-protocol-fixture")
            let negativeRuntime = negativeRoot.appendingPathComponent("runtime")
            let negativeCWD = negativeRoot.appendingPathComponent("unused-work-directory")
            try fm.createDirectory(at: negativeRuntime, withIntermediateDirectories: true)
            try fm.createDirectory(at: negativeCWD, withIntermediateDirectories: true)
            let negativeMarker = "NEGATIVE_PROTOCOL_FIXTURE_NO_COMMAND_EXECUTED"
            let negativeSource = """
            import { readFileSync, writeSync } from 'node:fs';
            const request = JSON.parse(readFileSync(process.argv[4], 'utf8'));
            writeSync(1, JSON.stringify({ type: 'complete', status: 'completed',
              runID: request.runID, summary: '\(negativeMarker)', artifactPaths: [] }) + '\\n');
            process.exit(1);
            """
            try negativeSource.write(to: negativeRuntime.appendingPathComponent("workbench.mjs"), atomically: true, encoding: .utf8)
            let negativeStorage = negativeRoot.appendingPathComponent("hub/workbench-v1.json")
            let negativeStore = WorkbenchStore(storageURL: negativeStorage)
            let negativeManagement = WorkbenchManagementStore(directory: negativeRoot.appendingPathComponent("hub/Management"))
            let negativeExecution = WorkbenchExecutionBridge(store: negativeStore, runtime: negativeRuntime,
                storage: negativeRoot.appendingPathComponent("hub/WorkbenchRuns"), management: negativeManagement)
            bridge = negativeExecution
            let negativeWorkspace = try unwrap(negativeStore.state.workspaces.first?.id, "Negative fixture workspace missing")
            let negativeProject = try negativeStore.createProject(workspaceID: negativeWorkspace, name: "Failure protocol fixture only")
            let negativeID = try negativeStore.createTask(projectID: negativeProject, goal: "Reject completed receipt followed by exit 1")
            var negativeDraft = try task(negativeStore, negativeID)
            negativeDraft.acceptance = "Must remain failed; this fixture executes no tool or model"
            try negativeStore.updateDetails(negativeDraft)
            try negativeStore.revisePlan(taskID: negativeID,
                nodes: [WorkbenchNode(id: "unused-output", title: "Protocol fixture only", kind: .output)],
                summary: "Negative protocol test; no command execution")
            try negativeStore.confirmPlan(taskID: negativeID)
            var negativePolicy = WorkbenchPolicy()
            negativePolicy.workingDirectory = negativeCWD.path
            negativePolicy.readRoots = [negativeCWD.path]
            negativePolicy.writeRoots = [negativeCWD.path]
            negativePolicy.expiresAt = Date().addingTimeInterval(60)
            // No executable, tool or network permission is granted to this fixture.
            try negativeStore.updatePolicy(taskID: negativeID, policy: negativePolicy, confirm: true)
            let negativeRunID = try negativeStore.requestRun(taskID: negativeID)
            try check(negativeExecution.activeCount == 1, "Negative fixture must pass through the real bridge process")
            try await waitFor("negative fixture process and EOF settlement") {
                !negativeExecution.hasOwnedProcesses && negativeExecution.activeCount == 0 &&
                    negativeStore.state.tasks.first { $0.id == negativeID }?.runs.last?.status.terminal == true
            }
            let negativeTask = try task(negativeStore, negativeID)
            let negativeRun = try unwrap(negativeTask.runs.first { $0.id == negativeRunID }, "Negative run receipt missing")
            try check(negativeRun.status == .failed, "Completed protocol message plus exit 1 must become a failed run")
            try check(negativeTask.status == .failed && negativeTask.status != .awaitingAcceptance, "Abnormal exit must not produce a task awaiting acceptance")
            try check(negativeRun.summary.contains(negativeMarker), "Matching complete message must actually be consumed before failure handling")
            try check(negativeRun.summary.contains("异常退出（1）"), "Failure summary must explain the nonzero process exit")
            try check(negativeRun.finishedAt != nil && negativeRun.artifacts.isEmpty, "Negative fixture must settle without manufacturing artifacts")
            try check(negativeTask.events.contains { $0.kind == "run-failed" } && !negativeTask.events.contains { $0.kind == "run-completed" }, "Store history must record failure instead of completion")
            try check(!fm.fileExists(atPath: negativeCWD.appendingPathComponent(".aihub-runs").path), "Protocol fixture must not run the production command pipeline")
            let negativeReload = WorkbenchStore(storageURL: negativeStorage)
            let restoredNegative = try task(negativeReload, negativeID)
            try check(restoredNegative.status == .failed && restoredNegative.runs.last?.status == .failed,
                      "Failed protocol outcome must remain failed after reload")
            try check(restoredNegative.runs.last?.summary == negativeRun.summary && negativeReload.errorMessage == nil,
                      "Abnormal exit diagnostic must persist")
            await negativeExecution.cancelAllAndWait()
            try check(!negativeExecution.hasOwnedProcesses && negativeExecution.activeCount == 0, "Negative fixture must leave no owned processes")
            print("NEGATIVE protocol fixture: \(checks - realChecks) checks passed; completed + exit 1 rejected; no command executed")
            print("Workbench execution regression: \(checks) total checks passed (\(realChecks) real-chain + \(checks - realChecks) negative-protocol); no model or existing service invoked")
        } catch {
            await bridge?.cancelAllAndWait()
            FileHandle.standardError.write(Data("FAIL WorkbenchExecutionRegression: \(error)\n".utf8))
            exit(1)
        }
    }
}
