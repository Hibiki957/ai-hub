import GhosttyTerminal
import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var tabStore: TabStore
    @State private var serviceConnection = NativeWorkbenchConnection.loadDefault()
    @State private var sidebarDragStart: Double?
    @State private var legacyTools = false
    @State private var resourcesVisible = true
    @EnvironmentObject private var relay: RelayRuntimeStore
    @EnvironmentObject private var workbench: WorkbenchStore
    @EnvironmentObject private var execution: WorkbenchExecutionBridge

    var body: some View {
        Group {
            if (!AppModel.isPreview || Bundle.main.object(forInfoDictionaryKey: "AIHubServicePreviewMode") as? Bool == true), let serviceConnection {
                NativeWorkbenchView(connection: serviceConnection, legacyContent: AnyView(legacyBody))
            } else {
                legacyBody
            }
        }
    }

    private var legacyBody: some View {
        HStack(spacing: 0) {
            // 侧栏：可折叠（收成窄条）/ 可拖宽
            if model.sidebarCollapsed {
                // 折叠态：窄条，只留展开按钮
                VStack(spacing: 0) {
                    Button {
                        withAnimation(.easeInOut(duration: 0.15)) { model.sidebarCollapsed = false }
                    } label: {
                        Image(systemName: "sidebar.left")
                            .font(.system(size: 13))
                            .foregroundStyle(HubTheme.textSecondary)
                            .frame(width: 32, height: 32)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("展开侧栏")
                    Spacer()
                }
                .padding(.top, 10)
                .frame(width: 44)
                .background(HubTheme.panel)
                Rectangle().fill(HubTheme.border).frame(width: 1)
            } else {
                ProjectNavigatorView(store: workbench, onCollapse: {
                    withAnimation(.easeInOut(duration: 0.15)) { model.sidebarCollapsed = true }
                }, onLegacyTools: { legacyTools = true })
                .frame(width: model.sidebarWidth)
                // 拖宽分隔条
                Rectangle()
                    .fill(HubTheme.border)
                    .frame(width: 4)
                    .contentShape(Rectangle())
                    .onHover { hovering in
                        if hovering {
                            NSCursor.resizeLeftRight.push()
                        } else {
                            NSCursor.pop()
                        }
                    }
                    .gesture(
                        DragGesture(minimumDistance: 1)
                            .onChanged { value in
                                if sidebarDragStart == nil { sidebarDragStart = model.sidebarWidth }
                                let w = (sidebarDragStart ?? model.sidebarWidth) + value.translation.width
                                let width = min(max(w, 180), 420)
                                if model.sidebarWidth != width { model.sidebarWidth = width }
                            }
                            .onEnded { _ in sidebarDragStart = nil }
                    )
            }
            VStack(spacing: 0) {
                if let error = model.launcherError {
                    HStack {
                        Text(error).font(.system(size: 12)).textSelection(.enabled)
                        Spacer()
                        Button("关闭") { model.launcherError = nil }
                    }
                    .padding(12).foregroundStyle(HubTheme.danger)
                    .background(HubTheme.panel)
                }
                if model.tabBarAtBottom {
                    workspaceArea
                    Rectangle().fill(HubTheme.border).frame(height: 1)
                    TabBarView()
                } else {
                    TabBarView()
                    Rectangle().fill(HubTheme.border).frame(height: 1)
                    workspaceArea
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            // 右侧文件浏览器
            if resourcesVisible || model.showFileBrowser {
                Rectangle().fill(HubTheme.border).frame(width: 1)
                ProjectResourcesView(store: workbench).frame(width: 280)
            }
        }
        .background(HubTheme.background)
        .environmentObject(relay)
        .sheet(isPresented: $legacyTools) {
            VStack(spacing: 0) {
                HStack { Text("工具目录与个人设置").font(.headline); Spacer(); Button("完成") { legacyTools = false } }.padding(14)
                SidebarView().frame(width: 360, height: 620)
            }
        }
    }

    private var isOverviewVisible: Bool {
        tabStore.showingOverview || (tabStore.tabs.isEmpty && tabStore.webTabs.isEmpty && tabStore.nativeTabs.isEmpty)
    }

    private var workspaceArea: some View {
        WorkbenchShellView(
            store: workbench, execution: execution, relay: relay,
            onOpenInHub: { model.openIntegration($0) },
            toolContent: AnyView(TerminalAreaView()),
            showingOverview: isOverviewVisible,
            onShowOverview: { tabStore.showingOverview = true },
            onToggleResources: {
                let visible = resourcesVisible || model.showFileBrowser
                resourcesVisible = !visible
                model.showFileBrowser = false
            }
        )
    }
}

// MARK: - 拖拽落点
