import Foundation

// Compile the real store without AppModel or any live runtime/configuration.
enum AppModel {
    static let isPreview = false
    static let augmentedPATH = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"
}

@main
struct RelayRuntimeRegression {
    struct Failure: Error, CustomStringConvertible { let description: String }
    static func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        guard condition() else { throw Failure(description: message) }
        print("PASS: \(message)")
    }

    @MainActor static func waitFor(_ message: String, _ condition: () -> Bool) async throws {
        for _ in 0..<500 {
            if condition() { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        throw Failure(description: "Timed out: \(message)")
    }

    @MainActor static func main() async {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("aihub-relay-regression-\(UUID())")
        let runtime = root.appendingPathComponent("runtime")
        let storage = root.appendingPathComponent("runs")
        var store: RelayRuntimeStore?
        do {
            try fm.createDirectory(at: runtime, withIntermediateDirectories: true)
            try fixture.write(to: runtime.appendingPathComponent("bridge.mjs"), atomically: true, encoding: .utf8)
            let active = RelayRuntimeStore(preview: false, runtimeDirectory: runtime, storageDirectory: storage)
            store = active
            active.refreshCapabilities()
            try await waitFor("fixture capabilities") { !active.detecting }
            try check(RelayRuntimeStore.primaryIDs.allSatisfy { active.capability($0)?.available == true },
                      "capability detection reads only the injected offline fixture")
            try await testTailDelivery(active, root: root)
            try await testPermission(active, root: root, storage: storage, allow: true)
            try await testPermission(active, root: root, storage: storage, allow: false)
            try await testCancellation(active, root: root, storage: storage)
            try await testFailure(active, root: root, runtime: runtime, storage: storage)
            try testRestart(root: root, runtime: runtime)
            try await testPreview(root: root, runtime: runtime)
            try fm.removeItem(at: root)
            print("ALL RELAY RUNTIME REGRESSIONS PASSED")
        } catch {
            if let store {
                for run in store.runs where run.status == "running" || run.status == "waiting" { store.cancel(run.id) }
                try? await waitFor("fixture cleanup") { !store.isRunning }
            }
            try? fm.removeItem(at: root)
            fputs("FAIL: \(error)\n", stderr)
            exit(1)
        }
    }

    @MainActor static func start(_ store: RelayRuntimeStore, goal: String, root: URL) throws -> String {
        guard let id = store.start(goal: goal, cwd: root.path, agents: ["hermes", "kimi"]) else {
            throw Failure(description: "Fixture did not start: \(store.errorMessage ?? goal)")
        }
        return id
    }

    @MainActor static func testTailDelivery(_ store: RelayRuntimeStore, root: URL) async throws {
        for pass in 0..<12 {
            let id = try start(store, goal: "burst-\(pass)", root: root)
            try await waitFor("burst \(pass) drained") { !store.isRunning }
            guard let run = store.runs.first(where: { $0.id == id }) else { throw Failure(description: "Missing burst run") }
            guard run.status == "completed", run.completedSteps == 2, run.result == "FINAL-\(pass)-中文-tail",
                  let artifact = run.artifactPath, FileManager.default.fileExists(atPath: artifact) else {
                throw Failure(description: "Lost final event on burst \(pass): \(run.status), steps=\(run.completedSteps), result=\(run.result.suffix(100))")
            }
        }
        try check(true, "12 rapid exits preserve the unterminated final JSON line, steps and artifact after both pipe EOFs")
    }

    @MainActor static func testPermission(_ store: RelayRuntimeStore, root: URL, storage: URL, allow: Bool) async throws {
        let id = try start(store, goal: "permission", root: root)
        try await waitFor("permission request") { !store.permissions.isEmpty }
        let permission = store.permissions[0]
        try check(permission.runID == id && permission.agent == "hermes" && permission.kind == "execute"
                  && permission.detail == #"{"command":"echo fixture","note":"离线确认"}"#,
                  "permission \(allow ? "allow" : "reject") preserves request identity and operation detail")
        try check(store.runs.first { $0.id == id }?.status == "waiting", "permission request marks its run waiting")
        store.respond(permission, allow: allow)
        try await waitFor("permission response consumed") { !store.isRunning }
        let data = try Data(contentsOf: storage.appendingPathComponent(id).appendingPathComponent("approval.json"))
        let reply = try JSONSerialization.jsonObject(with: data) as? [String: String]
        try check(reply?["type"] == "permission_response" && reply?["requestId"] == "permission-\(id)"
                  && reply?["decision"] == (allow ? "allow_once" : "reject_once"),
                  "\(allow ? "allow_once" : "reject_once") reaches the real fixture stdin")
        try check(store.permissions.isEmpty && store.runs.first { $0.id == id }?.status == (allow ? "completed" : "failed"),
                  "permission response clears pending UI and records the terminal outcome")
    }

    @MainActor static func testCancellation(_ store: RelayRuntimeStore, root: URL, storage: URL) async throws {
        let id = try start(store, goal: "cancel", root: root)
        let directory = storage.appendingPathComponent(id)
        try await waitFor("cancel fixture ready") { FileManager.default.fileExists(atPath: directory.appendingPathComponent("ready").path) }
        store.cancel(id)
        try await waitFor("cancel fixture exited") { !store.isRunning }
        try check(store.runs.first { $0.id == id }?.status == "cancelled"
                  && FileManager.default.fileExists(atPath: directory.appendingPathComponent("terminated").path),
                  "cancel terminates the owned bridge process and preserves cancelled status after EOF")
    }

    @MainActor static func testFailure(_ store: RelayRuntimeStore, root: URL, runtime: URL, storage: URL) async throws {
        let id = try start(store, goal: "failure", root: root)
        try await waitFor("failed fixture exited") { !store.isRunning }
        let run = store.runs.first { $0.id == id }!
        try check(run.status == "failed" && run.result.contains("useful partial output")
                  && run.result.contains("fixture terminal failure"),
                  "terminal failure preserves partial output and the bridge error field")
        try check(!run.result.contains("STATUS_ONLY_NOISE"), "status-stream messages do not pollute saved output")
        let reloaded = RelayRuntimeStore(preview: false, runtimeDirectory: runtime, storageDirectory: storage)
        let saved = reloaded.runs.first { $0.id == id }
        try check(saved?.status == "failed" && saved?.result == run.result,
                  "failed runs and their diagnostic result survive store reload")
    }

    @MainActor static func testRestart(root: URL, runtime: URL) throws {
        let storage = root.appendingPathComponent("restart")
        try FileManager.default.createDirectory(at: storage, withIntermediateDirectories: true)
        let runs = ["running", "waiting", "completed", "failed"].map { status in
            RelayRun(id: status, goal: "fixture", cwd: root.path, agents: ["hermes"], createdAt: Date(),
                     status: status, result: "saved-\(status)", completedSteps: 0)
        }
        try JSONEncoder().encode(runs).write(to: storage.appendingPathComponent("index.json"))
        let store = RelayRuntimeStore(preview: false, runtimeDirectory: runtime, storageDirectory: storage)
        try check(store.runs.filter { ["running", "waiting"].contains($0.id) }.allSatisfy { $0.status == "interrupted" }
                  && store.runs.first { $0.id == "completed" }?.status == "completed"
                  && store.runs.first { $0.id == "failed" }?.status == "failed" && !store.isRunning,
                  "reload marks unfinished records interrupted while preserving terminal outcomes")
    }

    @MainActor static func testPreview(root: URL, runtime: URL) async throws {
        let storage = root.appendingPathComponent("preview")
        let store = RelayRuntimeStore(preview: true, runtimeDirectory: runtime, storageDirectory: storage)
        store.refreshCapabilities()
        try await waitFor("preview capabilities") { !store.detecting }
        try check(store.capability("hermes")?.available == true && !store.canRun(["hermes"])
                  && store.start(goal: "must not run", cwd: root.path, agents: ["hermes"]) == nil
                  && !store.isRunning && store.runs.isEmpty && !FileManager.default.fileExists(atPath: storage.path),
                  "preview refuses execution even with available capabilities and writes no run storage")
    }

    // Only Node built-ins. This executable never imports the real bridge or calls
    // an agent, network endpoint, credential source or user conversation store.
    static let fixture = #"""
    import { readFileSync, writeFileSync, writeSync } from 'node:fs';
    import { join } from 'node:path';
    import { createInterface } from 'node:readline';
    if (process.argv[2] === 'capabilities') {
      writeSync(1, JSON.stringify({ agents: ['openclaw','hermes','zcode','kimi','opencode'].map(id => ({ id, name: id, available: true, verified: true, transport: 'fixture' })) }));
      process.exit(0);
    }
    const request = JSON.parse(readFileSync(process.argv[4], 'utf8'));
    const emit = (event, newline = true) => writeSync(1, JSON.stringify({ runId: request.id, ...event }) + (newline ? '\n' : ''));
    const finish = (status, result = '', error = '') => {
      const artifactPath = join(request.outputDir, 'summary.json');
      writeFileSync(artifactPath, JSON.stringify({ status, result, error }));
      emit({ type: 'complete', status, result, error, artifactPath }, false);
      process.exit(status === 'completed' ? 0 : 1);
    };
    emit({ type: 'step_start', agent: 'hermes' });
    if (request.goal.startsWith('burst-')) {
      for (let n = 0; n < 180; n++) emit({ type: 'message', stream: 'output', text: '中'.repeat(200) });
      writeSync(2, 'fixture stderr flood\n'.repeat(9000));
      emit({ type: 'step_complete', agent: 'hermes' });
      emit({ type: 'step_start', agent: 'kimi' });
      emit({ type: 'step_complete', agent: 'kimi' });
      finish('completed', `FINAL-${request.goal.slice(6)}-中文-tail`);
    } else if (request.goal === 'permission') {
      const input = createInterface({ input: process.stdin });
      emit({ type: 'permission', requestId: `permission-${request.id}`, agent: 'hermes', title: 'Fixture tool', kind: 'execute', detail: JSON.stringify({ command: 'echo fixture', note: '离线确认' }) });
      input.once('line', line => {
        const reply = JSON.parse(line);
        writeFileSync(join(request.outputDir, 'approval.json'), JSON.stringify(reply));
        finish(reply.decision === 'allow_once' ? 'completed' : 'failed', `decision:${reply.decision}`);
      });
    } else if (request.goal === 'cancel') {
      process.once('SIGTERM', () => { writeFileSync(join(request.outputDir, 'terminated'), 'yes'); process.exit(0); });
      writeFileSync(join(request.outputDir, 'ready'), 'yes');
      setInterval(() => {}, 1000);
    } else if (request.goal === 'failure') {
      emit({ type: 'message', stream: 'status', text: 'STATUS_ONLY_NOISE' });
      emit({ type: 'message', stream: 'output', text: 'useful partial output' });
      finish('failed', '', 'fixture terminal failure');
    } else { finish('failed', '', 'unexpected fixture mode'); }
    """#
}
