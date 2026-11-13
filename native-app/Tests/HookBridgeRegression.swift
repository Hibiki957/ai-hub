import Foundation

// Standalone stubs satisfy the unused decay path. No AppModel, CLI configuration,
// hook installation, live spool or GUI is initialized by this executable.
@MainActor final class AppDelegate {
    static var model: HookRegressionModel? = nil
}
@MainActor final class HookRegressionModel {
    let tabStore = HookRegressionTabStore()
}
@MainActor final class HookRegressionTabStore {
    var tabStatuses: [UUID: TabStatus] = [:]
    var statusUpdatedAt: [UUID: Date] = [:]
}

@main
struct HookBridgeRegression {
    struct Failure: Error, CustomStringConvertible { let description: String }
    static func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        guard condition() else { throw Failure(description: message) }
        print("PASS: \(message)")
    }

    @MainActor static func main() {
        do {
            try testConfigurationOwnership()
            try testParser()
            try testSpoolDelivery()
            print("ALL HOOK BRIDGE REGRESSIONS PASSED")
        } catch {
            fputs("FAIL: \(error)\n", stderr)
            exit(1)
        }
    }

    static func testConfigurationOwnership() throws {
        let attempts: [() throws -> Void] = [
            { try HookInstaller.installClaudeHooks() },
            { try HookInstaller.installCodexHooks() },
            { try HookInstaller.ensureCodexFeatureHooks(dir: NSHomeDirectory() + "/.codex") }
        ]
        for attempt in attempts {
            do { try attempt(); throw Failure(description: "shared hook config must reject writes") }
            catch HubConfigurationOwnership.OwnershipError.sharedConfigurationReadOnly {
                try check(true, "shared hook writer rejects before reading or modifying CC Switch configuration")
            }
        }
    }

    static func testParser() throws {
        let paneID = UUID(uuidString: "F1D2D3D4-1122-3344-5566-778899AABBCC")!
        let filename = "\(paneID)-1792396800-12345-42.json"
        let payload = Data(#"{"hook_event_name":"PermissionRequest","message":"请确认","session_id":"fixture"}"#.utf8)
        let event = HookEventParser.parse(filename: filename, data: payload)
        try check(event?.paneID == paneID, "current dispatcher filename preserves the full hyphenated pane UUID")
        try check(event?.event == "PermissionRequest" && event?.payload["message"] as? String == "请确认",
                  "event name and Unicode payload survive parsing")
        try check(HookEventParser.paneID(from: "\(paneID.uuidString.lowercased())-1-0.json") == paneID,
                  "old dispatcher filenames and lowercase UUIDs remain readable")
        try check(HookEventParser.parse(filename: "\(paneID)-1-0.json", data: payload) != nil,
                  "old queued events are retained for the existing live-pane filter")

        let invalidNames = [
            "F1D2D3D4-1792396800-1-42.json", "not-a-uuid-1792396800-1-42.json",
            "\(paneID).json", "\(paneID)_1792396800-1-42.json", "\(paneID)-1792396800.json",
            "\(paneID)-1792396800--42.json", "\(paneID)-x-1-42.json",
            "\(paneID)-1792396800-1-42-7.json", "\(paneID)-1-2.json.bak",
            ".tmp.fixture", "../\(filename)", "\(paneID)-1-18446744073709551616.json",
        ]
        try check(invalidNames.allSatisfy { HookEventParser.paneID(from: $0) == nil },
                  "truncated UUIDs, malformed suffixes, temporary files and paths are rejected")
        let invalidPayloads = ["{", "[]", "null", "{}", #"{"hook_event_name":12}"#,
                               #"{"hook_event_name":""}"#, #"{"hook_event_name":" \n "}"#]
        try check(invalidPayloads.allSatisfy { HookEventParser.parse(filename: filename, data: Data($0.utf8)) == nil },
                  "invalid JSON, non-object payloads and missing or blank event names are rejected")
    }

    @MainActor static func testSpoolDelivery() throws {
        let fm = FileManager.default
        let directory = fm.temporaryDirectory.appendingPathComponent("aihub-hook-regression-\(UUID())")
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: directory) }
        let paneID = UUID()
        let currentName = "\(paneID)-1792396800-17-42.json"
        let oldName = "\(paneID)-1-8.json"
        let badJSONName = "\(paneID)-1792396801-18-42.json"
        let malformedName = "truncated-1792396801-18.json"
        let payload = Data(#"{"hook_event_name":"Stop","message":"fixture"}"#.utf8)
        for name in [currentName, oldName, malformedName] {
            try payload.write(to: directory.appendingPathComponent(name))
        }
        try Data("{".utf8).write(to: directory.appendingPathComponent(badJSONName))
        let temporary = directory.appendingPathComponent(".tmp.pending")
        let staleTemporary = directory.appendingPathComponent(".tmp.stale")
        let unrelated = directory.appendingPathComponent("keep.txt")
        for file in [temporary, staleTemporary, unrelated] { try Data().write(to: file) }
        try fm.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -7200)], ofItemAtPath: staleTemporary.path)

        let bridge = HookBridge(spoolDirectory: directory.path)
        var events: [HookEvent] = []
        bridge.handler = { events.append($0) }
        bridge.drainSpool()
        try check(events.count == 2 && events.allSatisfy { $0.paneID == paneID && $0.event == "Stop" },
                  "real spool drain delivers current and old-format events with intact pane identity")
        try check([currentName, oldName, badJSONName, malformedName].allSatisfy {
            !fm.fileExists(atPath: directory.appendingPathComponent($0).path)
        }, "consumed and malformed event files leave the queue")
        bridge.drainSpool()
        try check(events.count == 2, "a second drain does not replay consumed events")
        try check(fm.fileExists(atPath: temporary.path) && fm.fileExists(atPath: unrelated.path)
                  && !fm.fileExists(atPath: staleTemporary.path),
                  "pending writes and unrelated files survive while stale temporary files are cleared")
    }
}
