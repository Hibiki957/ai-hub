import AppKit
import SwiftUI

/// The action stores a reference in the current project or task: (integrationID, canonicalURL).
/// Manual web/terminal tabs do not grant read/write/execute access to Agents.
struct IntegrationsView: View {
    var onAttachURL: ((String, String) -> Void)? = nil
    var onOpenInHub: ((AppIntegrations.WorkspaceRoute) -> Void)? = nil
    @State private var catalog: AppIntegrations?
    @State private var installations: [String: [AppIntegrations.Installation]] = [:]
    @State private var selectedID = "eagle"
    @State private var drafts: [String: String] = [:]
    @State private var error: String?
    @State private var feedback: String?

    init(initialSelection: String = "eagle", onAttachURL: ((String, String) -> Void)? = nil,
         onOpenInHub: ((AppIntegrations.WorkspaceRoute) -> Void)? = nil) {
        _selectedID = State(initialValue: initialSelection)
        self.onAttachURL = onAttachURL
        self.onOpenInHub = onOpenInHub
    }

    private var selected: AppIntegrations.Entry? { catalog?.integrations.first { $0.id == selectedID } }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("资料库与应用").font(.system(size: 14, weight: .semibold))
                    Text("选择应用，打开入口或关联当前工作的资料。")
                        .font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
                }
                Spacer()
                Button { reload() } label: { Label("检查安装", systemImage: "arrow.clockwise") }
                    .help("只读应用元数据，不启动应用或检测 API")
            }
            if let error { Text(error).font(.system(size: 12)).foregroundStyle(HubTheme.danger).textSelection(.enabled) }
            if let catalog {
                HStack(alignment: .top, spacing: 18) {
                    ScrollView {
                        VStack(spacing: 6) {
                            ForEach(catalog.integrations) { entry in
                                Button {
                                    selectedID = entry.id
                                    error = nil
                                    feedback = nil
                                } label: {
                                    HStack(alignment: .top, spacing: 10) {
                                        Image(systemName: symbol(entry.id)).frame(width: 20)
                                        VStack(alignment: .leading, spacing: 5) {
                                            Text(entry.name).font(.system(size: 13, weight: .semibold))
                                            Text(entry.role).font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
                                                .fixedSize(horizontal: false, vertical: true)
                                        }
                                        Spacer(minLength: 0)
                                    }
                                    .padding(11)
                                    .background(selectedID == entry.id ? HubTheme.hover : Color.clear)
                                    .clipShape(RoundedRectangle(cornerRadius: 10))
                                    .contentShape(Rectangle())
                                }.buttonStyle(.plain)
                            }
                        }
                    }.frame(width: 195)
                    Divider()
                    if let selected { detail(selected).id(selected.id).frame(maxWidth: .infinity, alignment: .leading) }
                }
            } else if error == nil {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(24)
        .foregroundStyle(HubTheme.text)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(HubTheme.background)
        .onAppear { reload() }
    }

    private func detail(_ entry: AppIntegrations.Entry) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 12) {
                    Text(entry.name).font(.system(size: 24, weight: .semibold))
                    Text(entry.role).font(.system(size: 14)).foregroundStyle(HubTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    openingActions(entry)
                    HStack(spacing: 8) {
                        Text("Agent API 未接通").font(.system(size: 12, weight: .semibold))
                        Text("尚未授权 Agent 读取、写回或执行内容。")
                            .font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
                    }.fixedSize(horizontal: false, vertical: true)
                    if let route = catalog?.workspaceRoutes(for: entry).first {
                        Text(presentationNote(route, entry: entry)).font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
                    } else {
                        Text("Hub 内资料面板尚未接入。可先关联资料引用；已安装时可打开原应用。")
                            .font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
                    }
                }

                VStack(alignment: .leading, spacing: 10) {
                    Label("关联资料", systemImage: "link").font(.system(size: 14, weight: .semibold))
                    Text("将资料引用加入当前项目或任务。只保存位置，不读取正文或执行文件。")
                        .font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
                    TextField("粘贴链接、file:// URL 或绝对路径", text: Binding(
                        get: { drafts[entry.id] ?? "" },
                        set: { drafts[entry.id] = $0; feedback = nil; error = nil }))
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel("\(entry.name)资料引用")
                        .onSubmit { attach(entry) }
                    if onAttachURL != nil {
                        Button("关联到当前工作范围") { attach(entry) }
                            .disabled((drafts[entry.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    } else {
                        Text("先在左侧选择项目，再关联资料；选中任务时将关联到该任务。")
                            .font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
                    }
                    if let feedback { Text(feedback).font(.system(size: 12)).foregroundStyle(HubTheme.success) }
                    DisclosureGroup("支持的格式与示例") {
                        VStack(alignment: .leading, spacing: 7) {
                            Text("支持 HTTPS、已存在的本地文件或目录，以及本应用允许的定位协议。")
                                .foregroundStyle(HubTheme.textSecondary)
                            ForEach(entry.referenceRules.examples, id: \.self) { example in
                                Text(example).font(.system(size: 12, design: .monospaced))
                                    .foregroundStyle(HubTheme.textSecondary).textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }.padding(.top, 8)
                    }
                    .font(.system(size: 12))
                }.padding(14).background(HubTheme.surface).clipShape(RoundedRectangle(cornerRadius: 12))

                VStack(alignment: .leading, spacing: 16) {
                    Divider()
                    DisclosureGroup("本机安装与路径") {
                        installationDetails(entry).padding(.top, 10)
                    }
                    DisclosureGroup("能力接口与授权要求") {
                        capabilityDetails(entry).padding(.top, 10)
                    }
                    DisclosureGroup("使用边界") {
                        VStack(alignment: .leading, spacing: 9) {
                            ForEach(entry.limitations, id: \.self) { Text("• " + $0) }
                            Text(entry.authorization)
                        }.foregroundStyle(HubTheme.textSecondary).padding(.top, 10)
                    }
                    DisclosureGroup("官方依据 · \(catalog?.auditedAt ?? "")") {
                        VStack(alignment: .leading, spacing: 9) {
                            ForEach(entry.officialSources) { source in
                                if let url = URL(string: source.url) {
                                    Link(source.title, destination: url)
                                }
                            }
                        }.padding(.top, 10)
                    }
                }.font(.system(size: 12))
            }
            .frame(maxWidth: 760, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.trailing, 6)
        }
    }

    private func openingActions(_ entry: AppIntegrations.Entry) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 10) {
                if let onOpenInHub, let route = catalog?.workspaceRoutes(for: entry).first {
                    Button(route.buttonTitle) { onOpenInHub(route) }
                        .buttonStyle(.borderedProminent).tint(HubTheme.accent)
                    if let routes = catalog?.workspaceRoutes(for: entry), routes.count > 1 {
                        Menu("其他入口") {
                            ForEach(Array(routes.dropFirst().enumerated()), id: \.offset) { _, alternative in
                                Button(alternative.title) { onOpenInHub(alternative) }
                            }
                        }
                    }
                }
                if let installation = installations[entry.id]?.first {
                    Button("在外部打开") { open(installation) }
                }
            }
            Text(installations[entry.id]?.isEmpty == false ? "已发现本机入口 · 仅表示已安装" : "未发现配置中的本机入口")
                .font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
        }
    }

    private func installationDetails(_ entry: AppIntegrations.Entry) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("安装信息来自本机元数据，不代表 API 或账户已连接。")
            if let found = installations[entry.id], !found.isEmpty {
                ForEach(found) { installation in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(installation.isPWA ? "PWA · 容器版本 \(installation.version ?? "未知")" : "原生应用 · \(installation.version ?? "版本未知")")
                            .fontWeight(.medium)
                        Text(installation.path).font(.system(size: 12, design: .monospaced))
                            .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }
                }
            } else {
                Text("未找到本机安装。如已移动应用，请更新目录配置后重新检查。")
            }
        }.foregroundStyle(HubTheme.textSecondary)
    }

    private func capabilityDetails(_ entry: AppIntegrations.Entry) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("已收录到目录并支持引用关联。下列接口分别记录核实与接入状态。")
                .foregroundStyle(HubTheme.textSecondary)
            ForEach(["read", "write", "execute", "embed"], id: \.self) { key in
                if let capability = entry.capabilities[key] {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(levelName(key)).font(.system(size: 13, weight: .semibold))
                        Text(capability.available ? "Hub 内入口已接通" : (capability.officialSupport == "documented" ? "接口已核实 · Hub 未接入" : "接口未核实 · 未接入"))
                        Text(capability.interface)
                        Text(capability.detail)
                        Text("授权要求：" + capability.authorization)
                    }.foregroundStyle(HubTheme.textSecondary)
                }
            }
        }
    }

    private func reload() {
        do {
            let loaded = try AppIntegrations.loadDefault()
            catalog = loaded
            installations = Dictionary(uniqueKeysWithValues: loaded.integrations.map { ($0.id, $0.metadata()) })
            if !loaded.integrations.contains(where: { $0.id == selectedID }) { selectedID = loaded.integrations.first?.id ?? "" }
            error = nil
        } catch {
            self.error = "应用目录读取失败：" + error.localizedDescription
        }
    }
    private func attach(_ entry: AppIntegrations.Entry) {
        guard let catalog, let onAttachURL else { return }
        do {
            let url = try catalog.validateReference(drafts[entry.id] ?? "", integrationID: entry.id)
            onAttachURL(entry.id, url)
            drafts[entry.id] = ""
            error = nil
            feedback = "已提交引用关联；内容仍保存在原应用。"
        } catch {
            self.error = error.localizedDescription
            feedback = nil
        }
    }
    private func open(_ installation: AppIntegrations.Installation) {
        guard FileManager.default.fileExists(atPath: installation.path) else {
            error = "入口已不存在，请重新检查安装。"
            return
        }
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: installation.path), configuration: NSWorkspace.OpenConfiguration()) { _, failure in
            if let failure {
                DispatchQueue.main.async { error = "应用打开失败：" + failure.localizedDescription }
            }
        }
    }
    private func presentationNote(_ route: AppIntegrations.WorkspaceRoute, entry: AppIntegrations.Entry) -> String {
        switch route {
        case .web:
            return entry.id == "chatbox"
                ? "网页版在 Hub 的独立标签中使用，首次需在 Hub 内登录；桌面端的聊天、知识库和 MCP 不会自动迁入。登录与高级功能需另行验证。"
                : "网页在 Hub 内独立标签中打开。首次使用需在 Hub 内登录；登录与高级功能的兼容性需实际验证。"
        case .terminal:
            return "使用 Hub 已有的 Ghostty 内置终端，创建本机交互 shell；此手动会话不属于受控任务沙箱。"
        }
    }
    private func levelName(_ key: String) -> String {
        ["read": "Agent 读取", "write": "Agent 写回", "execute": "Agent 执行", "embed": "Hub 内使用"][key] ?? key
    }
    private func symbol(_ id: String) -> String {
        ["eagle": "photo.on.rectangle", "zotero": "books.vertical", "masscode": "curlybraces", "miro": "square.grid.2x2", "obsidian": "book.closed", "notion": "calendar", "chatbox": "bubble.left.and.bubble.right", "ghostty": "terminal", "outlook": "envelope", "finalshell": "server.rack"][id] ?? "app"
    }
}
