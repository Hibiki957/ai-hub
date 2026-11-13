import AppKit
import SwiftUI

struct ProjectToolStackView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var store: WorkbenchStore
    var compact: Bool = false
    @ObservedObject private var control = HubControlStore.shared
    @State private var showAll = false
    @State private var sessionVariants: [String: String] = [:]
    @State private var filter = ""
    @State private var managingTools = false
    @State private var selectedFamilyID: String?
    private var families: [ToolStackFamily] { ToolStackFamily.families(catalog: .shared) }
    private var setup: WorkbenchProjectSetup { store.selectedProject?.setup ?? .init() }
    private func included(_ family: ToolStackFamily) -> Bool {
        setup.familyIDs.map { $0.contains(family.id) } ?? family.recommended(for: setup.kind)
    }
    var body: some View {
        Group {
            if compact { teamStrip } else { fullStack }
        }
        .sheet(isPresented: $managingTools) {
            VStack(spacing: 0) {
                HStack {
                    Text("管理工具栈").font(.headline)
                    Spacer()
                    Button("完成") { managingTools = false }.keyboardShortcut(.defaultAction)
                }.padding(18)
                Divider()
                ProjectToolStackView(store: store)
            }
            .frame(minWidth: 740, idealWidth: 940, minHeight: 520, idealHeight: 660)
        }
        .onChange(of: store.selectedProjectID) { _ in selectedFamilyID = nil }
    }

    private var teamStrip: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(store.selectedProject == nil ? "我的工具团队" : "项目工具团队")
                    .font(.system(size: 12, weight: .semibold))
                Spacer()
                Button {
                    selectedFamilyID = nil
                    managingTools = true
                } label: {
                    Label("管理工具栈", systemImage: "slider.horizontal.3")
                        .font(.system(size: 11))
                }.buttonStyle(.plain).foregroundStyle(HubTheme.textSecondary)
            }
            ForEach([ToolStackFamily.Tier.brain, .execution, .specialist], id: \.self) { tier in
                teamRow(tier)
            }
        }
        .padding(.horizontal, 18).padding(.vertical, 12)
        .background(HubTheme.panel.opacity(0.45))
    }

    private func teamRow(_ tier: ToolStackFamily.Tier) -> some View {
        let items = families.filter { self.tier($0) == tier && included($0) }
        let label: String
        switch tier {
        case .brain: label = "大脑与协调"
        case .execution: label = "执行主力"
        case .specialist: label = "专项辅助"
        case .support: label = "其他工具"
        }
        return HStack(spacing: 10) {
            Label(label, systemImage: tier.symbol)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(tier.tint)
                .frame(width: 86, alignment: .leading)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 7) {
                    ForEach(items) { family in teamChip(family, tier: tier) }
                    if items.isEmpty {
                        Button("添加成员") { managingTools = true }
                            .font(.system(size: 10)).buttonStyle(.plain)
                            .foregroundStyle(HubTheme.textTertiary)
                            .padding(.vertical, 7)
                    }
                }.padding(.vertical, 1)
            }
            .frame(height: 30)
        }
    }

    private func teamChip(_ family: ToolStackFamily, tier: ToolStackFamily.Tier) -> some View {
        let hasEntry = variants(family).contains { $0.available && !$0.isAgent }
        let discussion = setup.discussionFamilyIDs.contains(family.id)
        return Button { selectedFamilyID = family.id } label: {
            HStack(spacing: 6) {
                Circle().fill(hasEntry ? tier.tint : HubTheme.textTertiary.opacity(0.45))
                    .frame(width: 5, height: 5)
                Text(family.name).font(.system(size: 11, weight: .medium))
                if discussion {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 9))
                        .foregroundStyle(tier.tint)
                }
            }
            .fixedSize()
            .padding(.horizontal, 10).padding(.vertical, 6)
            .foregroundStyle(HubTheme.text)
            .background(HubTheme.surface, in: Capsule())
            .overlay(Capsule().stroke(selectedFamilyID == family.id ? tier.tint.opacity(0.65) : HubTheme.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .help(family.capabilities + "；点击选择使用方式")
        .accessibilityLabel(family.name + "，选择使用方式与分工")
        .popover(isPresented: Binding(get: { selectedFamilyID == family.id }, set: { if !$0, selectedFamilyID == family.id { selectedFamilyID = nil } }), arrowEdge: .bottom) {
            familyCard(family, tier: tier).frame(width: 330).padding(10)
        }
    }

    private var fullStack: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    header
                    HStack(spacing: 18) {
                        ForEach(ToolStackFamily.Tier.allCases, id: \.self) { tier in
                            Button { proxy.scrollTo(tier, anchor: .top) } label: {
                                Text(shortTitle(tier)).font(.system(size: 12, weight: .medium))
                            }.buttonStyle(.plain).foregroundStyle(HubTheme.accent)
                                .help("定位到" + tier.label)
                        }
                        Spacer(minLength: 0)
                    }.padding(.bottom, 2)
                    ForEach(ToolStackFamily.Tier.allCases, id: \.self) { tier in
                        tierSection(tier).id(tier)
                    }
                    Text("入口来自本机发现或手工配置，不代表连接已验证。同族的 TUI、Desktop、Web、后台任务和 API 使用独立账号与会话；打开工具不会自动交接任务。")
                        .font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
                        .lineSpacing(4)
                        .padding(.horizontal, 2)
                }
                .padding(26)
                .frame(maxWidth: 1040, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(HubTheme.background)
    }

    private func shortTitle(_ tier: ToolStackFamily.Tier) -> String {
        switch tier {
        case .brain: return "大脑与讨论"
        case .execution: return "执行主力"
        case .specialist: return "专项辅助"
        case .support: return "环境工具"
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 7) {
                Text(store.selectedProject == nil ? "工具栈" : "项目工具栈")
                    .font(.system(size: 24, weight: .semibold))
                Text(store.selectedProject == nil ? "按能力浏览全部工具，选择适合当前工作的使用方式。" : "查看项目已选工具，按需要调整分工与使用方式。")
                    .font(.system(size: 14)).foregroundStyle(HubTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 16) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(HubTheme.textTertiary)
                    TextField("搜索工具或能力", text: $filter).textFieldStyle(.plain)
                }
                .font(.system(size: 13))
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(HubTheme.surface, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(HubTheme.border, lineWidth: 1))
                .frame(maxWidth: 480)
                if store.selectedProject != nil {
                    Toggle("显示全部", isOn: $showAll).toggleStyle(.switch).controlSize(.small)
                        .font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
                        .fixedSize()
                }
                Spacer(minLength: 0)
            }
            if store.selectedProject != nil {
                Picker("项目类型", selection: Binding(get: { setup.kind }, set: { value in change { $0.kind = value } })) {
                    ForEach(WorkbenchProjectKind.allCases, id: \.self) { Text($0.label).tag($0) }
                }.frame(maxWidth: 320)
            }
        }
    }

    private func tier(_ family: ToolStackFamily) -> ToolStackFamily.Tier {
        ToolStackFamily.Tier(rawValue: setup.tiers[family.id] ?? "") ?? family.tier
    }

    private func tierSection(_ tier: ToolStackFamily.Tier) -> some View {
        let items = families.filter { family in
            self.tier(family) == tier && (store.selectedProject == nil || showAll || included(family))
                && (filter.isEmpty || (family.name + family.capabilities).localizedCaseInsensitiveContains(filter))
        }
        return VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 9) {
                    Image(systemName: tier.symbol)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(tier.tint)
                    Text(tier.label).font(.system(size: 16, weight: .semibold))
                    Text("\(items.count) 个工具")
                        .font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
                    Spacer(minLength: 0)
                }
                Text(tier.detail).font(.system(size: 13)).foregroundStyle(HubTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            LazyVStack(spacing: 0) {
                ForEach(items) { family in
                    familyRow(family, tier: tier)
                    if family.id != items.last?.id { Divider().overlay(HubTheme.border) }
                }
            }
            if items.isEmpty {
                Text(store.selectedProject == nil ? "没有匹配的工具。" : "当前范围没有匹配的工具，可打开“显示全部”调整。")
                    .font(.system(size: 13)).foregroundStyle(HubTheme.textSecondary)
                    .padding(.vertical, 8)
            }
        }
    }

    private func familyRow(_ family: ToolStackFamily, tier: ToolStackFamily.Tier) -> some View {
        let availableCount = variants(family).filter { $0.available && !$0.isAgent }.count
        let entrySummary = availableCount > 0 ? "\(availableCount) 个入口" : "暂无入口"
        let discussionSummary = setup.discussionFamilyIDs.contains(family.id) ? " · 已加入讨论组" : ""
        let projectSummary = store.selectedProject != nil && !included(family) ? " · 未加入项目" : ""
        return HStack(alignment: .top, spacing: 12) {
            SidebarIcon(name: family.name, color: HubTheme.brandColor(for: family.name),
                        source: .cli(family.id), badgeBackground: HubTheme.surface)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(family.name).font(.system(size: 14, weight: .semibold))
                    Text(entrySummary + discussionSummary + projectSummary)
                        .font(.system(size: 12)).foregroundStyle(HubTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(family.capabilities).font(.system(size: 13)).foregroundStyle(HubTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button { selectedFamilyID = family.id } label: {
                Text("选择与使用").font(.system(size: 12, weight: .medium))
                    .padding(.horizontal, 11).padding(.vertical, 7)
                    .foregroundStyle(HubTheme.accent)
                    .background(HubTheme.surface, in: RoundedRectangle(cornerRadius: 7))
                    .overlay(RoundedRectangle(cornerRadius: 7).stroke(HubTheme.border, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .fixedSize()
            .accessibilityLabel(family.name + "，选择使用方式与分工")
            .popover(isPresented: Binding(get: { selectedFamilyID == family.id }, set: { if !$0, selectedFamilyID == family.id { selectedFamilyID = nil } }), arrowEdge: .trailing) {
                familyCard(family, tier: tier).frame(width: 360).padding(10)
            }
        }
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func familyCard(_ family: ToolStackFamily, tier: ToolStackFamily.Tier) -> some View {
        let variants = variants(family)
        let available = variants.filter { $0.available && !$0.isAgent }
        let preferred = setup.preferredVariants[family.id] ?? sessionVariants[family.id]
        let selected = variants.first { $0.id == preferred } ?? variants.first { if case .api = $0.target { return $0.available }; return false } ?? variants.first { $0.available } ?? variants.first
        let modes = ToolStackFamily.Involvement.allCases.filter { kind in available.contains { $0.involvementKind == kind } }
        return ToolFamilyCard(
            family: family, tier: tier, variants: variants, availableCount: available.count,
            modes: modes, selectedID: selected?.id,
            inProject: store.selectedProject != nil, included: included(family),
            inDiscussion: setup.discussionFamilyIDs.contains(family.id),
            onSelect: { id in
                if store.selectedProject == nil { sessionVariants[family.id] = id }
                else { change { $0.preferredVariants[family.id] = id } }
            },
            onInclude: {
                let ids = setup.familyIDs ?? families.filter { $0.recommended(for: setup.kind) }.map(\.id)
                change { $0.familyIDs = included(family) ? ids.filter { $0 != family.id } : Array(Set(ids + [family.id])).sorted() }
            },
            onTier: { target in change { $0.tiers[family.id] = target.rawValue } },
            onDiscussion: {
                change { $0.discussionFamilyIDs = setup.discussionFamilyIDs.contains(family.id) ? setup.discussionFamilyIDs.filter { $0 != family.id } : setup.discussionFamilyIDs + [family.id] }
            },
            onLaunch: { selectedFamilyID = nil; launch($0, family: family) },
            launchEnabled: { variant in variant.available && !(variant.isAgent && store.selectedTaskID == nil) }
        )
    }

    private func change(_ update: (inout WorkbenchProjectSetup) -> Void) {
        guard var project = store.selectedProject else { return }
        var value = project.setup ?? .init(); update(&value); project.setup = value
        do { try store.updateProject(project) } catch { store.errorMessage = error.localizedDescription }
    }

    struct Variant: Identifiable {
        enum Target { case cli(CLIEntry), app(AppEntry), pwa(AppEntry), web(URL), agent(String), api(UUID) }
        let id: String
        let label: String
        let available: Bool
        let target: Target
        var isAgent: Bool { if case .agent = target { return true }; return false }
        /// 按任务需要的人工介入程度选择形态；这只是选择辅助，不构成授权。
        var involvementKind: ToolStackFamily.Involvement {
            switch target {
            case .cli, .app, .pwa, .web: return .interactive
            case .api: return .delegated
            case .agent: return .checkpoint
            }
        }
        var involvement: String {
            switch target {
            case .api: return "API 对话 · 使用已配置路由；连接与模型回复仍需实际验证，不会自动执行工具"
            case .cli: return "全程交互 · Hub 内置终端；使用工具自身权限"
            case .app: return "全程交互 · Hub 内的原生应用窗口"
            case .pwa, .web: return "全程交互 · Hub 网页标签；独立登录"
            case .agent: return "关键节点确认 · 加入当前任务工作流；模型与沙箱联调待验证"
            }
        }
        var involvementLabel: String {
            if case .api = target { return "API 对话" }
            return involvementKind.label
        }
        var actionLabel: String {
            switch target { case .api: return "进入统一对话"; case .cli: return "打开内置 TUI / CLI"; case .app: return "在 Hub 内打开原生应用"; case .pwa, .web: return "在 Hub 内打开"; case .agent: return "加入当前任务工作流" }
        }
        var symbol: String {
            switch target {
            case .cli: return "terminal"
            case .app: return "macwindow"
            case .pwa, .web: return "globe"
            case .agent: return "point.3.connected.trianglepath.dotted"
            case .api: return "server.rack"
            }
        }
    }

    private func canonical(_ path: String) -> String { URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path }
    private func variants(_ family: ToolStackFamily) -> [Variant] {
        let catalog = ToolCatalog.shared
        var result: [Variant] = []
        for cli in model.visibleCLIEntries {
            guard let definition = catalog.cli.first(where: { $0.id == cli.catalogID || canonical($0.command) == canonical(cli.command) }), family.products.contains(definition.productID) else { continue }
            result.append(.init(id: cli.id, label: "TUI / CLI · " + model.displayName(cli.name), available: FileManager.default.isExecutableFile(atPath: cli.command), target: .cli(cli)))
        }
        for app in model.visibleAppEntries {
            guard let definition = catalog.apps.first(where: { $0.id == app.catalogID || canonical($0.path) == canonical(app.appPath) }), family.products.contains(definition.productID) else { continue }
            result.append(.init(id: app.id, label: "Desktop · " + model.displayName(app.name), available: FileManager.default.fileExists(atPath: app.appPath), target: .app(app)))
        }
        for pwa in model.pwaSections.flatMap(\.items) where family.pwaNames.contains(pwa.name) && !model.isHidden(pwa.name) {
            result.append(.init(id: pwa.appPath, label: "Web · " + model.displayName(pwa.name), available: FileManager.default.fileExists(atPath: pwa.appPath), target: .pwa(pwa)))
        }
        if family.id == "gpt-dot", let web = catalog.web.first(where: { $0.id == "chatgpt" }), let url = URL(string: web.url) {
            result.append(.init(id: "web.chatgpt", label: "Web · ChatGPT", available: true, target: .web(url)))
        }
        if let agent = family.agentID, catalog.agents.contains(where: { $0.id == agent }) {
            result.append(.init(id: "agent." + agent, label: "后台任务 · 待验证", available: true, target: .agent(agent)))
        }
        for endpoint in control.state.endpoints where endpoint.enabled && endpoint.familyID == family.id {
            result.append(.init(id: "api." + endpoint.id.uuidString, label: "API 对话 · " + endpoint.name, available: true, target: .api(endpoint.id)))
        }
        return result
    }
    private func launch(_ variant: Variant, family: ToolStackFamily) {
        switch variant.target {
        case let .api(id): store.selectedAPIEndpointIDs = [id]; store.page = .discussion
        case let .cli(cli): model.openCLI(cli, workingDirectory: setup.directory.isEmpty ? nil : setup.directory)
        case let .app(app): model.openNativeAppInHub(app)
        case let .pwa(app): model.openPWA(app)
        case let .web(url): model.tabStore.openWeb(title: family.name, url: url)
        case let .agent(id):
            guard let task = store.selectedTask else { return }
            var nodes = task.currentPlan.nodes
            nodes.append(WorkbenchNode(title: family.name + " 执行步骤", kind: .agent, dependsOn: nodes.last.map { [$0.id] } ?? [], agentID: id, prompt: task.goal))
            do { try store.revisePlan(taskID: task.id, nodes: nodes, summary: task.currentPlan.summary); store.page = .workflow }
            catch { store.errorMessage = error.localizedDescription }
        }
    }
}

private struct ToolFamilyCard: View {
    let family: ToolStackFamily
    let tier: ToolStackFamily.Tier
    let variants: [ProjectToolStackView.Variant]
    let availableCount: Int
    let modes: [ToolStackFamily.Involvement]
    let selectedID: String?
    let inProject: Bool
    let included: Bool
    let inDiscussion: Bool
    let onSelect: (String) -> Void
    let onInclude: () -> Void
    let onTier: (ToolStackFamily.Tier) -> Void
    let onDiscussion: () -> Void
    let onLaunch: (ProjectToolStackView.Variant) -> Void
    let launchEnabled: (ProjectToolStackView.Variant) -> Bool
    @State private var hovering = false

    private var selected: ProjectToolStackView.Variant? { variants.first { $0.id == selectedID } }
    private var brand: Color { HubTheme.brandColor(for: family.name) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 10) {
                SidebarIcon(name: family.name, color: brand,
                            source: .cli(family.id), badgeBackground: HubTheme.surface)
                    .scaleEffect(1.1)
                VStack(alignment: .leading, spacing: 2) {
                    Text(family.name).font(.system(size: 15, weight: .semibold))
                    HStack(spacing: 4) {
                        Circle().fill(availableCount > 0 ? HubTheme.success : HubTheme.textTertiary.opacity(0.5)).frame(width: 5, height: 5)
                        Text(availableCount > 0 ? "\(availableCount) 个已发现 / 已配置入口" : "未发现已配置入口")
                            .font(.system(size: 12)).foregroundStyle(HubTheme.textTertiary)
                    }
                }
                Spacer(minLength: 0)
                if inProject {
                    Menu {
                        Button(included ? "移出项目工具栈" : "加入项目工具栈", action: onInclude)
                        ForEach(ToolStackFamily.Tier.allCases, id: \.self) { target in
                            Button("归入：" + target.label) { onTier(target) }
                        }
                        Button(inDiscussion ? "移出讨论组" : "加入讨论组", action: onDiscussion)
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(HubTheme.textSecondary)
                            .frame(width: 24, height: 24)
                            .background(HubTheme.hover.opacity(hovering ? 0.9 : 0), in: Circle())
                    }.menuStyle(.borderlessButton).frame(width: 24)
                }
            }
            Text(family.capabilities).font(.system(size: 13)).foregroundStyle(HubTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("适用项目：" + (family.kinds.isEmpty ? "通用" : family.kinds.map(\.label).joined(separator: " · "))).font(.system(size: 12)).foregroundStyle(HubTheme.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 5) {
                ForEach(modes, id: \.self) { mode in
                    HStack(spacing: 4) {
                        Circle().fill(mode.tint).frame(width: 4, height: 4)
                        Text(mode == .delegated ? "API 对话" : mode.label)
                    }
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(HubTheme.textSecondary)
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(mode.tint.opacity(0.09), in: Capsule())
                }
                if inDiscussion {
                    Label("讨论组", systemImage: "bubble.left.and.bubble.right")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(HubTheme.accent)
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(HubTheme.accent.opacity(0.09), in: Capsule())
                }
                Spacer(minLength: 0)
            }
            if !variants.isEmpty {
                Menu {
                    ForEach(variants) { variant in
                        Button { onSelect(variant.id) } label: {
                            HStack {
                                Label(variant.label + "（" + variant.involvementLabel + "）" + (variant.available ? "" : " · 不可用"), systemImage: variant.symbol)
                                if variant.id == selectedID { Image(systemName: "checkmark") }
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: selected?.symbol ?? "square.dashed")
                            .font(.system(size: 10))
                            .foregroundStyle(selected?.involvementKind.tint ?? HubTheme.textTertiary)
                        Text(selected?.label ?? "选择形态")
                            .font(.system(size: 13, weight: .medium))
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundStyle(HubTheme.textTertiary)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(HubTheme.background, in: RoundedRectangle(cornerRadius: 9))
                    .overlay(RoundedRectangle(cornerRadius: 9).stroke(HubTheme.border, lineWidth: 1))
                }.menuStyle(.borderlessButton)
                if let selected {
                    Text(selected.involvement).font(.system(size: 12)).foregroundStyle(HubTheme.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                    Button { onLaunch(selected) } label: {
                        HStack(spacing: 6) {
                            Spacer()
                            Text(selected.actionLabel).font(.system(size: 12, weight: .semibold))
                            Image(systemName: "arrow.up.right").font(.system(size: 9, weight: .bold))
                            Spacer()
                        }
                        .padding(.vertical, 8)
                        .foregroundStyle(.white)
                        .background(launchEnabled(selected) ? HubTheme.primaryGradient : LinearGradient(colors: [HubTheme.textTertiary.opacity(0.45)], startPoint: .top, endPoint: .bottom),
                                    in: RoundedRectangle(cornerRadius: 9))
                    }
                    .buttonStyle(.plain)
                    .disabled(!launchEnabled(selected))
                }
            } else {
                Text("未发现已配置入口").font(.system(size: 12)).foregroundStyle(HubTheme.textTertiary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 196, alignment: .topLeading)
        .background(HubTheme.surface, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(hovering ? tier.tint.opacity(0.4) : HubTheme.border.opacity(0.8), lineWidth: 1))
        .shadow(color: tier.tint.opacity(hovering ? 0.10 : 0.04), radius: hovering ? 10 : 6, x: 0, y: 3)
        .animation(.easeOut(duration: 0.12), value: hovering)
        .onHover { hovering = $0 }
    }
}
