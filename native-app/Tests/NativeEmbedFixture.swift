import AppKit
import Foundation

/// An isolated, public-data-only app for testing Hub's native-window controls.
/// No user document is opened. Closing Hub must leave both fixture windows alive.
@main
struct NativeEmbedFixture {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let delegate = FixtureAppDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}

private struct FixtureWindowState: Codable {
    var title: String
    var windowNumber = 0
    var incrementCount = 0
    var contextActionCount = 0
    var checkboxOn = false
    var sliderValue = 25.0
    var text = ""
    var selectedLocation = 0
    var selectedLength = 0
    var scrollY = 0.0
    var mouseDownCount = 0
    var dragCount = 0
    var scrollEventCount = 0
    var keyDownCount = 0
    var lastKeyCode = 0
    var lastModifierFlags: UInt = 0
    var lastMouseX = 0.0
    var lastMouseY = 0.0
    var isClosed = false
    var lastEvent = "created"
}

private struct FixtureState: Codable {
    var schemaVersion = 1
    var appPID = ProcessInfo.processInfo.processIdentifier
    var updatedAt = ""
    var isTerminated = false
    var sequence = 0
    var windows: [String: FixtureWindowState] = [:]
}

@MainActor
private final class FixtureAppDelegate: NSObject, NSApplicationDelegate {
    private var fixtures: [FixtureWindowController] = []
    private var state = FixtureState()
    private let stateURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("state.json")

    func applicationDidFinishLaunching(_ notification: Notification) {
        makeMenu()
        fixtures = ["A", "B"].enumerated().map { index, name in
            FixtureWindowController(name: name, index: index) { [weak self] id, windowState in
                guard let self else { return }
                self.state.windows[id] = windowState
                self.persist()
            }
        }
        for fixture in fixtures { fixture.show() }
        persist()
    }

    func applicationWillTerminate(_ notification: Notification) {
        state.isTerminated = true
        persist()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    private func persist() {
        state.sequence += 1
        state.updatedAt = ISO8601DateFormatter().string(from: Date())
        do {
            try FileManager.default.createDirectory(at: stateURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(state).write(to: stateURL, options: .atomic)
        } catch { NSLog("[NativeEmbedFixture] Could not write synthetic test state: %@", error.localizedDescription) }
    }

    private func makeMenu() {
        let menu = NSMenu()
        let applicationItem = NSMenuItem()
        menu.addItem(applicationItem)
        let applicationMenu = NSMenu(title: "Native Embed Fixture")
        applicationItem.submenu = applicationMenu
        let quit = NSMenuItem(title: "Quit Native Embed Fixture", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quit.target = NSApplication.shared
        applicationMenu.addItem(quit)
        let editItem = NSMenuItem()
        menu.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        editItem.submenu = edit
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        NSApplication.shared.mainMenu = menu
    }
}

private final class FixtureWindow: NSWindow {
    var onInput: ((NSEvent) -> Void)?
    override func sendEvent(_ event: NSEvent) {
        onInput?(event)
        super.sendEvent(event)
    }
}

private final class FixtureTextView: NSTextView {
    var onContextAction: (() -> Void)?
    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = NSMenu(title: "Synthetic test menu")
        let item = NSMenuItem(title: "记录右键操作 / Record context action", action: #selector(recordContextAction(_:)), keyEquivalent: "")
        item.target = self
        menu.addItem(item)
        return menu
    }
    @objc private func recordContextAction(_ sender: Any?) { onContextAction?() }
}

@MainActor
private final class FixtureWindowController: NSObject, NSWindowDelegate, NSTextViewDelegate {
    let name: String
    private let window: FixtureWindow
    private let status = NSTextField(labelWithString: "Ready — synthetic public data only")
    private let editor = FixtureTextView()
    private let checkbox = NSButton(checkboxWithTitle: "启用测试选项 / Test option", target: nil, action: nil)
    private let slider = NSSlider(value: 25, minValue: 0, maxValue: 100, target: nil, action: nil)
    private var state: FixtureWindowState
    private let onState: (String, FixtureWindowState) -> Void
    private var scrollObserver: NSObjectProtocol?
    private var initialized = false

    init(name: String, index: Int, onState: @escaping (String, FixtureWindowState) -> Void) {
        self.name = name
        self.onState = onState
        state = FixtureWindowState(title: "Native Embed Fixture — \(name)")
        window = FixtureWindow(contentRect: NSRect(x: 100 + index * 70, y: 140 + index * 45, width: 720, height: 520),
                               styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.title = state.title
        window.identifier = NSUserInterfaceItemIdentifier("native-embed-fixture-\(name)")
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 600, height: 430)
        window.delegate = self
        state.windowNumber = window.windowNumber
        constructContents()
        window.onInput = { [weak self] event in self?.observeInput(event) }
        initialized = true
        emit("created")
    }

    func show() {
        // NSWorkspace's launch configuration decides whether the app activates.
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(editor)
    }

    private func constructContents() {
        let content = NSView()
        window.contentView = content
        let header = NSTextField(labelWithString: "窗口 \(name) · Native controls inside AI Hub")
        header.font = .boldSystemFont(ofSize: 20)
        let note = NSTextField(wrappingLabelWithString: "这是独立的合成测试应用。可点击按钮、拖动滑块、输入、选择文字、滚动并测试右键菜单。")
        note.textColor = .secondaryLabelColor
        let increment = NSButton(title: "增加计数 / Increment", target: self, action: #selector(increment(_:)))
        increment.bezelStyle = .rounded
        increment.setAccessibilityIdentifier("fixture-\(name)-increment")
        checkbox.target = self
        checkbox.action = #selector(toggle(_:))
        checkbox.setAccessibilityIdentifier("fixture-\(name)-checkbox")
        slider.target = self
        slider.action = #selector(slide(_:))
        slider.isContinuous = true
        slider.setAccessibilityIdentifier("fixture-\(name)-slider")
        let sliderLabel = NSTextField(labelWithString: "Slider 0–100")
        let controls = NSStackView(views: [increment, checkbox, sliderLabel, slider])
        controls.orientation = .horizontal
        controls.spacing = 12
        slider.widthAnchor.constraint(greaterThanOrEqualToConstant: 120).isActive = true
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        scroll.autohidesScrollers = false
        editor.isEditable = true
        editor.isSelectable = true
        editor.isRichText = false
        editor.allowsUndo = true
        editor.isVerticallyResizable = true
        editor.isHorizontallyResizable = false
        editor.autoresizingMask = [.width]
        editor.textContainer?.widthTracksTextView = true
        editor.textContainerInset = NSSize(width: 10, height: 10)
        editor.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
        editor.setAccessibilityIdentifier("fixture-\(name)-editor")
        editor.string = "AI Hub native embedding test \(name)\nPUBLIC SYNTHETIC TEXT — replace or append freely.\n\n" +
            (1...80).map { String(format: "Line %02d: The quick brown fox verifies typing, selection and scrolling.", $0) }.joined(separator: "\n")
        state.text = editor.string
        editor.delegate = self
        editor.onContextAction = { [weak self] in
            guard let self else { return }
            self.state.contextActionCount += 1
            self.emit("context-action")
        }
        scroll.documentView = editor
        editor.frame = NSRect(x: 0, y: 0, width: 670, height: 1600)
        scroll.contentView.postsBoundsChangedNotifications = true
        scrollObserver = NotificationCenter.default.addObserver(
            forName: NSView.boundsDidChangeNotification, object: scroll.contentView, queue: .main
        ) { [weak self, weak scroll] _ in
            MainActor.assumeIsolated {
                guard let self, let scroll, self.initialized else { return }
                self.state.scrollY = scroll.contentView.bounds.origin.y
                self.emit("scroll-position")
            }
        }
        status.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        let footer = NSTextField(labelWithString: "右键编辑区 → 记录右键操作 · 关闭 Hub 标签应保留这两个窗口")
        footer.font = .systemFont(ofSize: 11)
        footer.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [header, note, controls, status, scroll, footer])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
            controls.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 200)
        ])
    }

    @objc private func increment(_ sender: NSButton) {
        state.incrementCount += 1
        emit("increment")
    }
    @objc private func toggle(_ sender: NSButton) {
        state.checkboxOn = sender.state == .on
        emit("checkbox")
    }
    @objc private func slide(_ sender: NSSlider) {
        state.sliderValue = sender.doubleValue
        emit("slider")
    }

    func textDidChange(_ notification: Notification) {
        state.text = editor.string
        emit("text-change")
    }

    func textViewDidChangeSelection(_ notification: Notification) {
        guard initialized else { return }
        state.selectedLocation = editor.selectedRange().location
        state.selectedLength = editor.selectedRange().length
        emit("text-selection")
    }

    func windowWillClose(_ notification: Notification) {
        state.isClosed = true
        emit("window-closed")
    }

    private func observeInput(_ event: NSEvent) {
        let type: String
        switch event.type {
        case .leftMouseDown, .rightMouseDown:
            state.mouseDownCount += 1
            type = event.type == .leftMouseDown ? "mouse-down" : "right-mouse-down"
        case .leftMouseDragged: state.dragCount += 1; type = "mouse-drag"
        case .scrollWheel: state.scrollEventCount += 1; type = "scroll-event"
        case .keyDown:
            state.keyDownCount += 1
            state.lastKeyCode = Int(event.keyCode)
            type = "key-down"
        default: return
        }
        state.lastModifierFlags = event.modifierFlags.intersection(.deviceIndependentFlagsMask).rawValue
        if event.type == .leftMouseDown || event.type == .rightMouseDown || event.type == .leftMouseDragged {
            state.lastMouseX = event.locationInWindow.x
            state.lastMouseY = event.locationInWindow.y
        }
        emit(type)
    }

    private func emit(_ event: String) {
        state.lastEvent = event
        status.stringValue = "\(name): count=\(state.incrementCount) · checkbox=\(state.checkboxOn) · slider=\(Int(state.sliderValue)) · menu=\(state.contextActionCount)"
        onState(name, state)
    }

    deinit {
        if let scrollObserver { NotificationCenter.default.removeObserver(scrollObserver) }
    }
}
