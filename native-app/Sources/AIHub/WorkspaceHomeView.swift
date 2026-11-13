import AppKit
import SwiftUI

struct WorkspaceHomeView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var tabStore: TabStore
    @ObservedObject var relay: RelayRuntimeStore
    @State private var goal = ""
    @State private var directory = ""
    @State private var firstAgent = "hermes"
    @State private var secondAgent = "opencode"
    @State private var selectedRun: RelayRun?
    @State private var timeoutMinutes = 5
    @State private var firstModel = ""
    @State private var secondModel = ""
    @Environment(\.openWindow) private var openWindow

    private let columns = [GridItem(.adaptive(minimum: 146), spacing: 12)]
    private var partners: [(String, String, String)] {
        ToolCatalog.shared.primaryAgents.map { ($0.id, $0.name, $0.subtitle) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                hero
                partnersSection
                Text("自动执行已移到任务工作台。请在那里确认计划、权限与隔离；此处保留工具入口和旧接力记录。")
                    .font(.callout).foregroundStyle(HubTheme.textSecondary)
                activitySection
                footer
            }
            .padding(28)
            .frame(maxWidth: 1200)
            .frame(maxWidth: .infinity)
        }
        .background(HubTheme.background)
        .onAppear { relay.refreshCapabilities() }
        .onChange(of: firstAgent) { _ in firstModel = "" }
        .onChange(of: secondAgent) { _ in secondModel = "" }
        .sheet(item: $selectedRun) { run in
            runDetail(run)
        }
    }

    private var hero: some View {
        ZStack(alignment: .leading) {
            SkyArtwork()
            LinearGradient(colors: [Color(hex: 0x17564C).opacity(0.74), Color(hex: 0x226D60).opacity(0.12), .clear],
                           startPoint: .leading, endPoint: .trailing)
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 7) {
                    Image(systemName: "sparkle")
                    Text("YOUR PERSONAL AI WORKSPACE")
                        .tracking(2.4)
                }
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Color.white.opacity(0.88))
                Text("让想法，\n抵达更远的地方。")
                    .font(.system(size: 32, weight: .medium, design: .rounded))
                    .lineSpacing(5)
                    .foregroundStyle(.white)
                Text("熟悉的工具，在这里相遇。")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.white.opacity(0.9))
            }
            .padding(30)
            VStack {
                HStack {
                    Spacer()
                    Label("云间工作台", systemImage: "sun.haze")
                        .font(.system(size: 11, weight: .medium))
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(.white.opacity(0.82), in: Capsule())
                        .foregroundStyle(HubTheme.text)
                }
                Spacer()
            }
            .padding(20)
        }
        .frame(height: 252)
        .clipShape(RoundedRectangle(cornerRadius: 22))
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(.white.opacity(0.6), lineWidth: 1))
        .shadow(color: HubTheme.accent.opacity(0.12), radius: 18, x: 0, y: 8)
        .accessibilityElement(children: .combine)
    }

    private var partnersSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionTitle("主力伙伴", subtitle: "熟悉的能力，一键抵达") {
                Button { model.refreshToolInventory(); relay.refreshCapabilities() } label: {
                    Label(relay.detecting ? "检测中" : "重新检测", systemImage: "arrow.clockwise")
                        .font(.system(size: 11))
                }.buttonStyle(.plain).foregroundStyle(HubTheme.textSecondary).disabled(relay.detecting)
            }
            LazyVGrid(columns: columns, spacing: 12) {
                ForEach(partners, id: \.0) { id, name, subtitle in
                    PartnerCard(id: id, name: name, subtitle: subtitle,
                                capability: relay.capability(id), action: { openPartner(id) })
                }
            }
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "point.topleft.down.curvedto.point.bottomright.up")
                    .font(.system(size: 20, weight: .light))
                    .foregroundStyle(HubTheme.accent)
                    .frame(width: 40, height: 40)
                    .background(HubTheme.hover, in: RoundedRectangle(cornerRadius: 12))
                VStack(alignment: .leading, spacing: 4) {
                    Text("从一个目标开始").font(.system(size: 18, weight: .semibold))
                    Text("交代一次，让两位伙伴接力完成。")
                        .font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
                }
                Spacer()
                Text("接力任务").font(.system(size: 10, weight: .medium))
                    .foregroundStyle(HubTheme.accent).padding(.horizontal, 10).padding(.vertical, 5)
                    .background(HubTheme.hover.opacity(0.6), in: Capsule())
            }
            ZStack(alignment: .topLeading) {
                if goal.isEmpty {
                    Text("例如：研究这个开源项目，再请另一位伙伴复核结论，交付一份有来源的建议。")
                        .font(.system(size: 13)).foregroundStyle(HubTheme.textTertiary)
                        .padding(.horizontal, 10).padding(.vertical, 12).allowsHitTesting(false)
                }
                TextEditor(text: $goal)
                    .font(.system(size: 13))
                    .scrollContentBackground(.hidden)
                    .padding(5)
                    .accessibilityLabel("任务目标")
            }
            .frame(height: 78)
            .background(HubTheme.background, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(HubTheme.border, lineWidth: 1))

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { agentPickers; Spacer(minLength: 12); startButton }
                VStack(alignment: .leading, spacing: 14) {
                    agentPickers
                    HStack { Spacer(); startButton }
                }
            }
            directoryPicker
            HStack(spacing: 12) {
                Picker("每步限时", selection: $timeoutMinutes) {
                    Text("2 分钟").tag(2)
                    Text("5 分钟").tag(5)
                    Text("15 分钟").tag(15)
                }.font(.system(size: 10)).frame(width: 132)
                if relay.isRunning {
                    Label("已有接力正在进行", systemImage: "circle.dotted")
                        .font(.system(size: 11)).foregroundStyle(HubTheme.accent)
                } else {
                    Text("执行中可停止 · 工具确认由执行器提供")
                        .font(.system(size: 10)).foregroundStyle(HubTheme.textTertiary)
                }
                Spacer()
            }
            DisclosureGroup("会话模型（可选）") {
                VStack(alignment: .leading, spacing: 12) {
                    Text("默认沿用工具自己的模型。这里的选择仅用于此次任务。")
                        .font(.system(size: 11)).foregroundStyle(HubTheme.textSecondary)
                    modelRow(agent: firstAgent, selection: $firstModel)
                    if secondAgent != firstAgent { modelRow(agent: secondAgent, selection: $secondModel) }
                }.padding(.top, 10)
            }.font(.system(size: 11)).foregroundStyle(HubTheme.textSecondary)
            if AppModel.isPreview {
                Label("测试窗口：真实任务执行已隔离。", systemImage: "eye")
                    .font(.system(size: 11)).foregroundStyle(HubTheme.textSecondary)
            } else if let message = relay.errorMessage {
                Label(message, systemImage: "exclamationmark.circle")
                    .font(.system(size: 11)).foregroundStyle(HubTheme.danger).textSelection(.enabled)
            } else if !relay.detecting && !relay.capabilities.isEmpty && !selectedAgentsAvailable {
                Label("所选伙伴暂不可调用，请查看工具检测结果或选择其他伙伴。", systemImage: "info.circle")
                    .font(.system(size: 11)).foregroundStyle(HubTheme.warning)
            }
            ForEach(relay.permissions) { permission in
                permissionRow(permission)
            }
        }
        .padding(22)
        .hubCard()
    }

    private var agentPickers: some View {
        HStack(spacing: 9) {
            Text("执行").font(.system(size: 11)).foregroundStyle(HubTheme.textSecondary)
            agentPicker($firstAgent, label: "执行伙伴")
            Image(systemName: "arrow.right").font(.system(size: 11)).foregroundStyle(HubTheme.textTertiary)
            Text("复核").font(.system(size: 11)).foregroundStyle(HubTheme.textSecondary)
            agentPicker($secondAgent, label: "复核伙伴")
        }
    }

    private func agentPicker(_ selection: Binding<String>, label: String) -> some View {
        Picker("伙伴", selection: selection) {
            ForEach(partners, id: \.0) { id, name, _ in Text(name).tag(id) }
            Divider()
            ForEach(ToolCatalog.shared.agents.filter { !ToolCatalog.shared.primaryAgentIDs.contains($0.id) }) { agent in
                Text(agent.name).tag(agent.id)
            }
        }
        .labelsHidden().pickerStyle(.menu).frame(width: 114)
        .accessibilityLabel(label)
    }

    private var selectedAgentsAvailable: Bool {
        relay.capability(firstAgent)?.available == true && relay.capability(secondAgent)?.available == true
    }

    private var startButton: some View {
        Button {
            guard relay.start(goal: goal, cwd: workingDirectory, agents: [firstAgent, secondAgent],
                models: selectedModels, timeoutMs: timeoutMinutes * 60_000) != nil else { return }
            goal = ""
        } label: {
            HStack(spacing: 8) {
                Text("开始接力")
                Image(systemName: "arrow.up.right")
            }
            .font(.system(size: 12, weight: .semibold))
            .padding(.horizontal, 18).padding(.vertical, 11)
            .foregroundStyle(.white)
            .background(HubTheme.primaryGradient, in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .opacity(canStart ? 1 : 0.45)
        .disabled(!canStart)
        .help(AppModel.isPreview ? "预览模式不会调用模型" : "将目标发送给所选伙伴，并将第一步成果交给第二位伙伴复核")
    }

    private var selectedModels: [String: String] {
        var models: [String: String] = [:]
        if !firstModel.isEmpty { models[firstAgent] = firstModel }
        if secondAgent != firstAgent && !secondModel.isEmpty { models[secondAgent] = secondModel }
        return models
    }

    private func modelRow(agent: String, selection: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 10) {
                Text(partners.first { $0.0 == agent }?.1 ?? agent).frame(width: 74, alignment: .leading)
                if let catalog = relay.modelCatalogs[agent], catalog.modelControl {
                    Picker("此次模型", selection: selection) {
                        Text("沿用工具当前模型").tag("")
                        ForEach(catalog.availableModels) { model in Text(model.name).tag(model.id) }
                    }.labelsHidden().frame(maxWidth: 320)
                } else {
                    Text("沿用工具当前模型").font(.system(size: 11)).foregroundStyle(HubTheme.textTertiary)
                }
                Spacer(minLength: 4)
                Button(relay.loadingModels.contains(agent) ? "读取中…" : "读取模型") {
                    relay.refreshModels(agent: agent, cwd: workingDirectory)
                }
                .font(.system(size: 10))
                .disabled(workingDirectory.isEmpty || relay.hasOwnedProcesses || AppModel.isPreview)
            }
            if let catalog = relay.modelCatalogs[agent], !catalog.modelControl {
                Text(catalog.reason ?? "该执行器未提供会话模型切换接口。")
                    .font(.system(size: 10)).foregroundStyle(HubTheme.textTertiary)
            }
        }
    }

    private var canStart: Bool {
        !workingDirectory.isEmpty && !goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && relay.canRun([firstAgent, secondAgent])
    }

    private var workingDirectory: String {
        (directory.trimmingCharacters(in: .whitespacesAndNewlines) as NSString).expandingTildeInPath
    }

    private var directoryPicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "folder").foregroundStyle(HubTheme.textSecondary)
                TextField("粘贴工作目录的绝对路径，支持 ~/", text: $directory)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12))
                    .accessibilityLabel("工作目录路径")
                    .onSubmit { directory = workingDirectory }
                Button("浏览…") {
                    let panel = NSOpenPanel()
                    panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
                    let initial = workingDirectory.hasPrefix("/") ? workingDirectory : NSHomeDirectory()
                    panel.directoryURL = URL(fileURLWithPath: initial)
                    panel.message = "选择任务的起始工作目录；也可关闭此窗口，直接在工作台粘贴路径。"
                    if panel.runModal() == .OK, let url = panel.url { directory = url.path }
                }
                .buttonStyle(.bordered)
                .help("打开系统目录选择器；不可用时可直接粘贴路径")
            }
            Text("任务从这里开始；选择目录不会限制执行器只能访问这里。")
                .font(.system(size: 10)).foregroundStyle(HubTheme.textTertiary)
        }
        .help(workingDirectory)
    }

    private func permissionRow(_ permission: RelayPermission) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("\(permission.agent) 需要你的确认", systemImage: "hand.raised")
                .font(.system(size: 12, weight: .semibold))
            Text(permission.title).font(.system(size: 12)).textSelection(.enabled)
            if !permission.detail.isEmpty {
                DisclosureGroup("查看具体命令与操作") {
                    ScrollView {
                        Text(permission.detail).font(.system(size: 11, design: .monospaced))
                            .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    }.frame(maxHeight: 140).padding(.top, 6)
                }.font(.system(size: 11))
            }
            HStack {
                Spacer()
                Button("拒绝此次操作") { relay.respond(permission, allow: false) }
                Button("仅允许此次") { relay.respond(permission, allow: true) }
                    .buttonStyle(.borderedProminent).tint(HubTheme.accent)
            }
        }
        .padding(14).background(HubTheme.sunlight.opacity(0.22), in: RoundedRectangle(cornerRadius: 12))
    }

    private var activitySection: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionTitle("工作轨迹", subtitle: "每一次交付，都有来处") {
                Button { openWindow(id: "history") } label: {
                    Label("会话历史", systemImage: "clock.arrow.circlepath").font(.system(size: 11))
                }.buttonStyle(.plain).foregroundStyle(HubTheme.textSecondary)
            }
            if relay.runs.isEmpty {
                HStack(spacing: 16) {
                    Image(systemName: "paperplane")
                        .font(.system(size: 23, weight: .ultraLight)).foregroundStyle(HubTheme.accent.opacity(0.7))
                        .frame(width: 48, height: 48).background(HubTheme.panel, in: Circle())
                    VStack(alignment: .leading, spacing: 5) {
                        Text("新的旅程，从这里出发").font(.system(size: 13, weight: .medium))
                        Text("接力开始后，进度、交付文件和需要处理的问题都会留在这里。")
                            .font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
                    }
                    Spacer()
                }
                .padding(22).frame(maxWidth: .infinity, alignment: .leading).hubCard()
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(relay.runs.prefix(12).enumerated()), id: \.element.id) { index, run in
                        if index > 0 { Divider().padding(.leading, 62) }
                        runRow(run)
                    }
                }.hubCard()
            }
        }
    }

    private func runRow(_ run: RelayRun) -> some View {
        HStack(spacing: 14) {
            Image(systemName: run.status == "completed" ? "checkmark.circle" : "point.3.connected.trianglepath.dotted")
                .font(.system(size: 18)).foregroundStyle(run.status == "completed" ? HubTheme.success : HubTheme.accent)
                .frame(width: 28)
            Button { selectedRun = run } label: {
                VStack(alignment: .leading, spacing: 5) {
                    Text(run.title).font(.system(size: 12, weight: .medium)).lineLimit(1)
                    Text((run.progress ?? run.agents.joined(separator: " → ")) + "  ·  " + run.createdAt.formatted(date: .abbreviated, time: .shortened))
                        .font(.system(size: 10)).foregroundStyle(HubTheme.textSecondary)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.buttonStyle(.plain)
            Text(run.statusLabel).font(.system(size: 10, weight: .medium)).foregroundStyle(HubTheme.textSecondary)
            if run.status == "running" || run.status == "waiting" {
                Button { relay.cancel(run.id) } label: { Image(systemName: "stop.circle").font(.system(size: 16)) }
                    .buttonStyle(.plain).help("停止此次接力")
            } else {
                Button { relay.reveal(run) } label: { Image(systemName: "folder").font(.system(size: 13)) }
                    .buttonStyle(.plain).help("查看交付文件与记录")
            }
        }.padding(18)
    }

    private func runDetail(_ initial: RelayRun) -> some View {
        let run = relay.runs.first { $0.id == initial.id } ?? initial
        return VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("接力记录").font(.system(size: 20, weight: .semibold))
                Spacer()
                Button("完成") { selectedRun = nil }.keyboardShortcut(.defaultAction)
            }
            Text(run.goal).font(.system(size: 13)).textSelection(.enabled)
            Label(run.agents.joined(separator: " → ") + " · " + run.statusLabel, systemImage: "point.3.connected.trianglepath.dotted")
                .font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
            ScrollView {
                Text(run.result.isEmpty ? "等待伙伴的输出…" : run.result)
                    .font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(16)
            }.background(HubTheme.background, in: RoundedRectangle(cornerRadius: 12))
            HStack { Spacer(); Button("在访达查看记录") { relay.reveal(run) } }
        }
        .padding(26).frame(width: 680, height: 520).background(HubTheme.surface)
    }

    private var footer: some View {
        HStack(spacing: 6) {
            Image(systemName: "cloud.sun").font(.system(size: 12))
            Text("AI HUB  /  把日常，留给创造。 ").tracking(0.7)
            Spacer()
            Text("本地工作台 · acpx 开源接力引擎")
        }
        .font(.system(size: 10)).foregroundStyle(HubTheme.textTertiary)
        .padding(.horizontal, 2).padding(.bottom, 8)
    }

    private func sectionTitle<Accessory: View>(_ title: String, subtitle: String, @ViewBuilder accessory: () -> Accessory) -> some View {
        HStack(alignment: .firstTextBaseline) {
            HStack(spacing: 10) {
                Text(title).font(.system(size: 16, weight: .semibold))
                Text(subtitle).font(.system(size: 11)).foregroundStyle(HubTheme.textTertiary)
            }
            Spacer()
            accessory()
        }
        .foregroundStyle(HubTheme.text)
    }

    private func openPartner(_ id: String) {
        guard !AppModel.isPreview else { return }
        if id == "openclaw", let entry = model.pwaSections.flatMap(\.items).first(where: { $0.name.lowercased().contains("openclaw") }) {
            tabStore.openPWA(entry); return
        }
        if let cli = (model.cliEntries + model.customCLIEntries).first(where: {
            id == "zcode" ? $0.name.lowercased().contains("zcode") : $0.name.lowercased() == id
        }) { model.openCLI(cli, workingDirectory: workingDirectory.isEmpty ? nil : workingDirectory); return }
        if let app = model.appEntries.first(where: { $0.name.lowercased() == id }) { model.openNativeAppInHub(app) }
    }
}

private struct PartnerCard: View {
    let id: String
    let name: String
    let subtitle: String
    let capability: RelayCapability?
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 13) {
                HStack {
                    SidebarIcon(name: name, color: HubTheme.brandColor(for: id),
                                source: .cli(id == "zcode" ? "zcode-tui" : id), badgeBackground: HubTheme.surface)
                        .scaleEffect(1.15)
                    Spacer()
                    Image(systemName: "arrow.up.right").font(.system(size: 10, weight: .medium))
                        .foregroundStyle(HubTheme.textTertiary)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(name).font(.system(size: 14, weight: .semibold)).foregroundStyle(HubTheme.text)
                    Text(subtitle).font(.system(size: 10)).foregroundStyle(HubTheme.textSecondary)
                }
                HStack(spacing: 5) {
                    Circle().fill(capability?.available == true ? HubTheme.success : HubTheme.textTertiary).frame(width: 4, height: 4)
                    Text(capability == nil ? "检测接口中" : (capability!.available ? "入口已找到 · 待实测" : "待接入"))
                        .font(.system(size: 10)).foregroundStyle(HubTheme.textSecondary)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(hovering ? HubTheme.hover.opacity(0.7) : HubTheme.surface, in: RoundedRectangle(cornerRadius: 15))
            .overlay(RoundedRectangle(cornerRadius: 15).stroke(hovering ? HubTheme.accent.opacity(0.35) : HubTheme.border.opacity(0.75), lineWidth: 1))
            .shadow(color: HubTheme.accent.opacity(hovering ? 0.08 : 0.025), radius: 8, x: 0, y: 3)
            .contentShape(RoundedRectangle(cornerRadius: 15))
        }
        .buttonStyle(.plain).onHover { hovering = $0 }
        .help(capability?.reason ?? "打开 \(name)")
    }
}

struct SkyArtwork: View {
    private static let image: NSImage? = {
        let bundled = Bundle.main.resourceURL?.appendingPathComponent("Artwork/sky-workspace.png")
        let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Resources/Artwork/sky-workspace.png")
        return [bundled, source].compactMap { $0 }.compactMap { NSImage(contentsOf: $0) }.first
    }()
    var body: some View {
        GeometryReader { geometry in
            if let image = Self.image {
                Image(nsImage: image).resizable().scaledToFill()
                    .frame(width: geometry.size.width, height: geometry.size.height).clipped()
            } else {
                LinearGradient(colors: [HubTheme.sky, HubTheme.dusk, HubTheme.sunlight], startPoint: .topLeading, endPoint: .bottomTrailing)
            }
        }.accessibilityHidden(true)
    }
}

private struct HubCardModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(HubTheme.surface, in: RoundedRectangle(cornerRadius: HubTheme.cardRadius))
            .overlay(RoundedRectangle(cornerRadius: HubTheme.cardRadius).stroke(HubTheme.border.opacity(0.8), lineWidth: 1))
            .shadow(color: HubTheme.accent.opacity(0.035), radius: 12, x: 0, y: 4)
    }
}
private extension View {
    func hubCard() -> some View { modifier(HubCardModifier()) }
}
