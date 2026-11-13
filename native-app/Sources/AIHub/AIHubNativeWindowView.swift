import AppKit
import ApplicationServices
import Combine
import SwiftUI

/// A manual session with the application's real window. Capture and input stay
/// on this Mac; the target process owns its documents and window lifecycle.
struct AIHubNativeWindowView: View {
    @ObservedObject var tab: NativeAppTab
    @EnvironmentObject private var tabStore: TabStore
    @State private var accessibilityAllowed = AXIsProcessTrusted()
    @State private var interactionEnabled = true
    @State private var inputFocused = false
    @State private var inputIssue: String?
    private let permissionTimer = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

    private var canInteract: Bool {
        accessibilityAllowed && interactionEnabled && tab.state == .streaming
    }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            if tab.state == .streaming || (tab.state == .paused && tab.image != nil) {
                if !accessibilityAllowed { accessibilityBanner }
                if canInteract, let inputIssue {
                    Label(inputIssue, systemImage: "keyboard.badge.exclamationmark")
                        .font(.system(size: 12))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14).padding(.vertical, 9)
                        .background(Color.accentColor.opacity(0.07))
                }
                ZStack {
                    NativeWindowInputView(tab: tab, controlEnabled: canInteract,
                                          onFocusChanged: { inputFocused = $0 },
                                          onInputIssue: { inputIssue = $0 },
                                          onClose: { tabStore.closeNativeTab(id: tab.id) })
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    if tab.state == .paused {
                        VStack(spacing: 12) {
                            Label(pauseTitle, systemImage: "pause.circle.fill").font(.headline)
                            if tab.userPaused {
                                Button("继续") { tab.setUserPaused(false) }.buttonStyle(.borderedProminent)
                            } else {
                                Text("返回此标签且 Hub 窗口可见后会自动恢复，无需重新授权。")
                                    .font(.system(size: 13)).foregroundStyle(.secondary)
                            }
                        }
                        .padding(24).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            } else {
                statusView.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            Divider()
            HStack(spacing: 8) {
                Image(systemName: canInteract && inputFocused ? "keyboard" : "macwindow")
                Text(footerText).lineLimit(1)
                Spacer(minLength: 8)
                Text("⌘W 关闭标签").foregroundStyle(.tertiary)
            }
            .font(.system(size: 11)).foregroundStyle(.secondary)
            .padding(.horizontal, 14).padding(.vertical, 7)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .onReceive(permissionTimer) { _ in accessibilityAllowed = AXIsProcessTrusted() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            accessibilityAllowed = AXIsProcessTrusted()
        }
    }

    private var toolbar: some View {
        HStack(spacing: 10) {
            Image(nsImage: NSWorkspace.shared.icon(forFile: tab.appPath))
                .resizable().frame(width: 22, height: 22)
            Text(tab.appName).font(.system(size: 13, weight: .semibold)).lineLimit(1)
            if !tab.windows.isEmpty {
                Picker("窗口", selection: Binding(get: { tab.selectedWindowID }, set: { id in
                    if let id { tab.selectWindow(id) }
                })) {
                    ForEach(tab.windows) { item in
                        Text(item.title.isEmpty ? "未命名窗口" : item.title).tag(Optional(item.id))
                    }
                }
                .labelsHidden().frame(minWidth: 140, maxWidth: 300)
                .help("选择要在 Hub 中操作的原生窗口")
            }
            Spacer(minLength: 8)
            if accessibilityAllowed {
                Toggle("允许操作", isOn: $interactionEnabled).toggleStyle(.checkbox)
                    .font(.system(size: 12)).help("关闭后仅查看，不向原应用发送输入")
            }
            Button { tab.refreshWindows() } label: { Image(systemName: "arrow.clockwise") }
                .help("刷新应用窗口").accessibilityLabel("刷新应用窗口")
            if tab.state == .streaming || tab.state == .paused {
                Button { tab.setUserPaused(!tab.userPaused) } label: {
                    Image(systemName: tab.userPaused ? "play.fill" : "pause.fill")
                }
                .help(tab.userPaused ? "继续窗口显示" : "暂停窗口显示")
                .accessibilityLabel(tab.userPaused ? "继续窗口显示" : "暂停窗口显示")
            }
            Button { tab.openExternally() } label: {
                Label("原应用", systemImage: "arrow.up.right.square")
            }
            .help("在桌面上打开原应用，处理系统菜单或独立弹窗")
        }
        .buttonStyle(.bordered).controlSize(.small)
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private var accessibilityBanner: some View {
        HStack(spacing: 10) {
            Image(systemName: "hand.point.up.left")
            Text("当前可查看窗口。启用辅助功能后，可在这里点击和输入。")
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("设置操作权限") { openAccessibilitySettings() }
            Button("已授权，重新检查") { accessibilityAllowed = AXIsProcessTrusted() }
        }
        .font(.system(size: 12)).padding(.horizontal, 14).padding(.vertical, 9)
        .background(Color.accentColor.opacity(0.07))
    }

    @ViewBuilder private var statusView: some View {
        VStack(spacing: 16) {
            switch tab.state {
            case .idle, .launching, .connecting:
                ProgressView()
                Text(tab.state == .launching ? "正在打开 \(tab.appName)…" : "正在连接原生窗口…")
            case .needsScreenRecording:
                Image(systemName: "macwindow.badge.plus").font(.system(size: 36)).foregroundStyle(.secondary)
                Text("允许 Hub 显示原生窗口").font(.title3.weight(.semibold))
                Text("macOS 需要屏幕录制权限来显示应用的实时画面。窗口画面只在本机显示，不上传、不录制音频。")
                    .foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 440)
                if let message = tab.errorMessage {
                    Text(message).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 440)
                }
                HStack {
                    Button("允许显示窗口") { tab.requestScreenRecording() }.buttonStyle(.borderedProminent)
                    Button("打开系统设置") { tab.openScreenRecordingSettings() }
                }
                Button("检查授权") { tab.retry() }
            case .noWindows:
                Image(systemName: "macwindow").font(.system(size: 36)).foregroundStyle(.secondary)
                Text("还没有可显示的窗口").font(.title3.weight(.semibold))
                Text("请在 \(tab.appName) 中打开一个窗口，然后刷新。最小化的窗口可能需要先恢复。")
                    .foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 440)
                HStack { Button("打开原应用") { tab.openExternally() }; Button("刷新窗口") { tab.refreshWindows() } }
            case .appExited:
                Image(systemName: "app.dashed").font(.system(size: 36)).foregroundStyle(.secondary)
                Text("\(tab.appName) 已退出").font(.title3.weight(.semibold))
                Button("重新打开") { tab.retry() }.buttonStyle(.borderedProminent)
            case .failed:
                Image(systemName: "exclamationmark.triangle").font(.system(size: 36)).foregroundStyle(.secondary)
                Text("暂时无法显示窗口").font(.title3.weight(.semibold))
                if let message = tab.errorMessage {
                    Text(message).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        .textSelection(.enabled).frame(maxWidth: 500)
                }
                HStack { Button("重试") { tab.retry() }; Button("打开原应用") { tab.openExternally() } }
            case .paused:
                Image(systemName: "pause.circle").font(.system(size: 36)).foregroundStyle(.secondary)
                Text(pauseTitle)
                if tab.userPaused {
                    Button("继续") { tab.setUserPaused(false) }
                } else {
                    Text("返回此标签且 Hub 窗口可见后会自动恢复，无需重新授权。")
                        .foregroundStyle(.secondary)
                }
            case .streaming:
                EmptyView()
            }
        }
        .font(.system(size: 13)).padding(30)
    }

    private var pauseTitle: String {
        tab.userPaused ? "窗口已暂停" : "窗口显示已自动暂停"
    }

    private var footerText: String {
        switch tab.state {
        case .idle, .launching, .connecting:
            return "正在连接原生窗口"
        case .needsScreenRecording:
            return "等待屏幕录制授权 · 原应用独立运行"
        case .noWindows:
            return "等待应用窗口 · 可刷新或打开原应用"
        case .appExited:
            return "原应用已退出 · 可重新打开"
        case .failed:
            return "窗口连接失败 · 可重试或打开原应用"
        case .paused:
            return tab.userPaused ? "已暂停 · 原应用继续运行" : "窗口不可见，已自动暂停显示 · 返回后恢复"
        case .streaming:
            if !canInteract { return "窗口已连接 · 仅查看" }
            if inputIssue != nil { return "键盘输入已暂停 · 点击镜像重新确认焦点" }
            return inputFocused ? "正在操作 \(tab.appName) · 快捷键发送到此窗口" : "点击窗口画面开始操作 · 支持键盘、滚动和拖动"
        }
    }

    private func openAccessibilitySettings() {
        // An already-approved but stale signing entry must be repaired in
        // Settings. Reissuing a prompt on every click cannot repair that entry.
        // This action and the timer only inspect trust; neither prompts again.
        accessibilityAllowed = AXIsProcessTrusted()
        if !accessibilityAllowed,
           let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }
}

struct NativeAppTabItemView: View {
    @EnvironmentObject private var tabStore: TabStore
    @ObservedObject var tab: NativeAppTab
    @State private var hovering = false

    private var selected: Bool { !tabStore.showingOverview && tabStore.selectedNativeTabID == tab.id }

    var body: some View {
        HStack(spacing: 6) {
            Image(nsImage: NSWorkspace.shared.icon(forFile: tab.appPath)).resizable().frame(width: 15, height: 15)
            Text(tab.appName).font(.system(size: 12)).lineLimit(1).frame(maxWidth: 160)
            if hovering || selected {
                Button { tabStore.closeNativeTab(id: tab.id) } label: {
                    Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
                }
                .buttonStyle(.plain).help("关闭镜像，原应用继续运行")
                .accessibilityLabel("关闭 \(tab.appName) 标签")
            }
        }
        .foregroundStyle(selected ? HubTheme.text : HubTheme.textSecondary)
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 8).fill(selected ? Color.white : (hovering ? HubTheme.hover : .clear)))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(selected ? HubTheme.border : .clear, lineWidth: 1))
        .contentShape(Rectangle())
        .onTapGesture { tabStore.focusNativeTab(id: tab.id) }
        .onHover { hovering = $0 }
        .contextMenu {
            Button("在外部打开") { tab.openExternally() }
            Button("关闭镜像标签") { tabStore.closeNativeTab(id: tab.id) }
        }
    }
}
