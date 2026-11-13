import AppKit
import Combine
import Foundation
import SwiftUI

struct HubMCPServer: Codable, Identifiable, Equatable {
    var id = UUID()
    var name = ""
    var url = "http://127.0.0.1:8000/mcp"
    var scopes: [String] = ["global"]
    var enabled = true
}
struct HubMCPTool: Identifiable, Decodable {
    let name: String
    let description: String?
    var id: String { name }
}
@MainActor final class HubMCPStore: ObservableObject {
    static let shared = HubMCPStore()
    @Published private(set) var servers: [HubMCPServer] = []
    @Published private(set) var tools: [UUID: [HubMCPTool]] = [:]
    @Published private(set) var running = false
    @Published var result = ""
    @Published var issue: String?
    private var ownedProcess: Process?
    private let file: URL
    private var blocked = false
    init(file: URL? = nil) {
        self.file = file ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/" + (AppModel.isPreview ? "AIHubPreview" : "AIHub") + "/Control/mcp-v1.json")
        if FileManager.default.fileExists(atPath: self.file.path) {
            do { servers = try JSONDecoder().decode([HubMCPServer].self, from: Data(contentsOf: self.file)) }
            catch { blocked = true; issue = "MCP 配置无法读取，已保留原文件并停止写入" }
        }
    }
    func save(_ server: HubMCPServer, token: String? = nil) throws {
        _ = try HubGatewayClient.endpointURL(server.url)
        guard !blocked, !running, !server.name.isEmpty,
              server.scopes.allSatisfy({ $0 == "global" || $0.range(of: #"^(project|task):[A-Fa-f0-9-]{36}$"#, options: .regularExpression) != nil }) else { throw HubGatewayError(message: "MCP 名称/范围无效，或配置正在使用/读取失败") }
        var updated = servers
        if let i = updated.firstIndex(where: { $0.id == server.id }) { updated[i] = server } else { updated.append(server) }
        let previous = token == nil ? nil : HubCredentialVault.token(server.id)
        if let token { try HubCredentialVault.save(token, for: server.id) }
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try JSONEncoder().encode(updated).write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            servers = updated; tools.removeValue(forKey: server.id)
        } catch { if token != nil { try? HubCredentialVault.save(previous ?? "", for: server.id) }; throw error }
    }
    func permitted(_ server: HubMCPServer, projectID: UUID?, taskID: UUID?) -> Bool {
        let scopes = ["global"] + (projectID.map { ["project:" + $0.uuidString] } ?? []) + (taskID.map { ["task:" + $0.uuidString] } ?? [])
        return server.enabled && !Set(server.scopes).isDisjoint(with: scopes)
    }
    func run(_ server: HubMCPServer, projectID: UUID?, taskID: UUID?, tool: String? = nil, arguments: String = "{}", confirmed: Bool = false) throws {
        guard !AppModel.isPreview, !running, servers.contains(server), permitted(server, projectID: projectID, taskID: taskID) else { throw HubGatewayError(message: "服务未在当前范围授权，或已有 MCP 操作在运行") }
        let args = try JSONSerialization.jsonObject(with: Data(arguments.utf8))
        guard args is [String: Any], arguments.utf8.count <= 65_536 else { throw HubGatewayError(message: "参数必须是 64 KiB 以内的 JSON 对象") }
        if let tool { guard confirmed, tools[server.id]?.contains(where: { $0.name == tool }) == true else { throw HubGatewayError(message: "请先获取工具列表，并确认本次调用") } }
        let runtime = RelayRuntimeStore.runtimeDirectory
        let script = runtime.appendingPathComponent("mcp-client.mjs")
        let node = ToolCatalog.shared.pathEntries.map { URL(fileURLWithPath: $0).appendingPathComponent("node").path }.first { FileManager.default.isExecutableFile(atPath: $0) }
        guard let node, FileManager.default.fileExists(atPath: script.path) else { throw HubGatewayError(message: "MCP SDK 运行时尚未安装") }
        var request: [String: Any] = ["action": tool == nil ? "list" : "call", "url": server.url, "confirmed": confirmed, "arguments": args, "allowedTools": tools[server.id]?.map(\.name) ?? []]
        if let tool { request["tool"] = tool }
        if let token = HubCredentialVault.token(server.id) { request["token"] = token }
        let inputData = try JSONSerialization.data(withJSONObject: request)
        let process = Process(), input = Pipe(), output = Pipe(), errors = Pipe()
        process.executableURL = URL(fileURLWithPath: node); process.arguments = [script.path]; process.currentDirectoryURL = runtime
        process.environment = ["PATH": ToolCatalog.shared.pathEntries.joined(separator: ":"), "LANG": "en_US.UTF-8"]
        process.standardInput = input; process.standardOutput = output; process.standardError = errors
        ownedProcess = process; running = true; issue = nil; result = ""
        do {
            try process.run()
            // Drain both pipes while the SDK runs; large tool lists must not
            // block on a full pipe before the termination callback can run.
            let stdout = Task.detached { output.fileHandleForReading.readDataToEndOfFile() }
            let stderr = Task.detached { errors.fileHandleForReading.readDataToEndOfFile() }
            Task { [weak self] in
                let data = await stdout.value
                _ = await stderr.value
                let status = await Task.detached { process.waitUntilExit(); return process.terminationStatus }.value
                guard let self else { return }
                self.ownedProcess = nil; self.running = false
                guard status == 0, data.count <= 4_194_304,
                      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], object["ok"] as? Bool == true, let value = object["result"] else {
                    self.issue = "MCP 操作未成功；请检查服务、地址与 Hub 授权。取消操作不能撤销远端已完成的动作。"; return
                }
                if tool == nil, let items = (value as? [String: Any])?["tools"], let encoded = try? JSONSerialization.data(withJSONObject: items), let decoded = try? JSONDecoder().decode([HubMCPTool].self, from: encoded) { self.tools[server.id] = decoded }
                if let formatted = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]) { self.result = String(decoding: formatted, as: UTF8.self) }
            }
            try input.fileHandleForWriting.write(contentsOf: inputData); try input.fileHandleForWriting.close()
        } catch { if process.isRunning { process.terminate() }; ownedProcess = nil; running = false; throw error }
    }
    func cancel() { if ownedProcess?.isRunning == true { ownedProcess?.terminate() } }
}

struct HubMCPView: View {
    @ObservedObject var workbench: WorkbenchStore
    @StateObject private var mcp = HubMCPStore.shared
    @State private var editing: HubMCPServer?
    @State private var selected: UUID?
    @State private var tool = ""
    @State private var arguments = "{}"
    @State private var confirmation = false
    private var server: HubMCPServer? { mcp.servers.first { $0.id == selected } }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Text("MCP 服务调度").font(.title2); Spacer(); Button("添加服务") { editing = HubMCPServer() } }
            Text("使用官方 MCP SDK 接入 Streamable HTTP。Hub 自己配置地址、凭据与作用域；每次工具调用展示参数并确认。暂不接管其他客户端的 stdio/OAuth 服务。").font(.caption).foregroundStyle(.secondary)
            Picker("服务", selection: $selected) { Text("请选择").tag(Optional<UUID>.none); ForEach(mcp.servers) { Text($0.name).tag(Optional($0.id)) } }
                .onChange(of: selected) { _ in tool = ""; confirmation = false }
            if let server {
                HStack {
                    Button("配置") { editing = server }
                    Button("连接并获取工具") { act { try mcp.run(server, projectID: workbench.selectedProjectID, taskID: workbench.selectedTaskID) } }.disabled(mcp.running || !mcp.permitted(server, projectID: workbench.selectedProjectID, taskID: workbench.selectedTaskID))
                    if mcp.running { ProgressView().controlSize(.small); Button("停止") { mcp.cancel() } }
                }
                Text(server.url).font(.caption).textSelection(.enabled)
                Picker("工具", selection: $tool) { Text("请选择").tag(""); ForEach(mcp.tools[server.id] ?? []) { Text($0.name).tag($0.name) } }
                if let info = mcp.tools[server.id]?.first(where: { $0.name == tool }) { Text(info.description ?? "服务未提供描述").font(.caption).lineLimit(4) }
                TextField("JSON 参数", text: $arguments, axis: .vertical).lineLimit(3...6).textFieldStyle(.roundedBorder)
                Button("预览本次调用") { confirmation = true }.disabled(tool.isEmpty || mcp.running)
            }
            if let issue = mcp.issue { Text(issue).font(.caption).foregroundStyle(HubTheme.danger).textSelection(.enabled) }
            ScrollView { Text(mcp.result).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
        }.sheet(item: $editing) { HubMCPServerEditor(store: mcp, workbench: workbench, server: $0) }
            .sheet(isPresented: $confirmation) {
                VStack(alignment: .leading, spacing: 14) {
                    Text("确认 MCP 工具调用").font(.title2)
                    Text((server?.name ?? "") + " · " + tool)
                    ScrollView { Text(arguments).font(.system(size: 12, design: .monospaced)).textSelection(.enabled) }.frame(height: 160)
                    Text("工具可能写入数据或触发外部操作。本次由你手动调用，使用该服务自身权限；不是任务执行沙箱。").font(.caption).foregroundStyle(.secondary)
                    HStack { Button("取消") { confirmation = false }; Spacer(); Button("确认调用一次") {
                        act { if let server { try mcp.run(server, projectID: workbench.selectedProjectID, taskID: workbench.selectedTaskID, tool: tool, arguments: arguments, confirmed: true) }; confirmation = false }
                    } }
                }.padding(24).frame(width: 510)
            }
    }
    private func act(_ action: () throws -> Void) { do { try action() } catch { mcp.issue = error.localizedDescription } }
}
private struct HubMCPServerEditor: View {
    @ObservedObject var store: HubMCPStore
    @ObservedObject var workbench: WorkbenchStore
    @Environment(\.dismiss) private var dismiss
    @State private var server: HubMCPServer
    @State private var scope: String
    @State private var token = ""
    @State private var replaceToken = false
    init(store: HubMCPStore, workbench: WorkbenchStore, server: HubMCPServer) { self.store = store; self.workbench = workbench; _server = State(initialValue: server); _scope = State(initialValue: server.scopes.first ?? "global") }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Hub MCP 服务").font(.title2)
            TextField("名称", text: $server.name).textFieldStyle(.roundedBorder)
            TextField("Streamable HTTP URL", text: $server.url).textFieldStyle(.roundedBorder)
            Picker("可用范围", selection: $scope) {
                Text("全局").tag("global")
                ForEach(workbench.state.projects) { Text("项目：" + $0.name).tag("project:" + $0.id.uuidString) }
                ForEach(workbench.state.tasks.filter { $0.status != .archived }) { Text("任务：" + $0.title).tag("task:" + $0.id.uuidString) }
            }
            Toggle("启用", isOn: $server.enabled)
            Toggle("设置 / 替换 Hub Token", isOn: $replaceToken)
            if replaceToken { SecureField("Token（留空移除旧凭据）", text: $token) }
            if let issue = store.issue { Text(issue).font(.caption).foregroundStyle(HubTheme.danger) }
            HStack { Button("取消") { dismiss() }; Spacer(); Button("保存") {
                do { server.scopes = [scope]; try store.save(server, token: replaceToken ? token : nil); dismiss() } catch { store.issue = error.localizedDescription }
            } }
        }.padding(24).frame(width: 520)
    }
}
