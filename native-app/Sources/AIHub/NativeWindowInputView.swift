import AppKit
import ApplicationServices
import Darwin
import SwiftUI

/// Opt-in, bounded stage counters for local input diagnosis. No input text,
/// clipboard contents, window titles or document paths are recorded.
@MainActor
private enum NativeInputDiagnostics {
    static var enabled: Bool { UserDefaults.standard.bool(forKey: "AIHubNativeInputDiagnostics") }
    private static var events: [[String: Any]] = []

    static func record(_ stage: String, _ fields: [String: Any] = [:]) {
        guard enabled else { return }
        var event = fields
        event["stage"] = stage
        event["time"] = Date().timeIntervalSince1970
        events.append(event)
        if events.count > 128 { events.removeFirst(events.count - 128) }
        let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/AIHub", isDirectory: true)
        let url = directory.appendingPathComponent("native-input-stages.json")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let data = try JSONSerialization.data(withJSONObject: ["schema": 1, "pid": ProcessInfo.processInfo.processIdentifier, "events": events], options: [.prettyPrinted, .sortedKeys])
            try data.write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch { /* Diagnostic failure must not alter normal input. */ }
    }

    static func menuBindings() {
        guard enabled, let menu = NSApp.mainMenu else { return }
        let selectors = Set(["selectAll:", "copy:", "paste:", "cut:", "undo:"])
        func inspect(_ menu: NSMenu, depth: Int) {
            guard depth < 8 else { return }
            for item in menu.items {
                if let action = item.action, selectors.contains(NSStringFromSelector(action)) {
                    let resolved = NSApp.target(forAction: action, to: item.target, from: item)
                    record("menuBinding", ["action": NSStringFromSelector(action),
                        "targetType": item.target.map { String(reflecting: type(of: $0)) } ?? "nil",
                        "resolvedType": resolved.map { String(reflecting: type(of: $0)) } ?? "nil"])
                }
                if let submenu = item.submenu { inspect(submenu, depth: depth + 1) }
            }
        }
        inspect(menu, depth: 0)
    }
}

/// Independent Swift implementation of the background-window event metadata
/// described by https://github.com/andelf/axcli/blob/main/src/input.rs and
/// https://github.com/Lakr233/bgclick-rev-skill/blob/main/bgclick-rev-skill.md.
/// axcli declares MIT OR Apache-2.0; the latter is a method reference with no
/// explicit repository license. No source or prose is copied from either.
/// CGEventSetWindowLocation is a private, optional OS symbol: absence disables
/// pointer dispatch with a visible explanation instead of using global input.
private enum NativeBackgroundWindowEvents {
    typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void
    private static let framework = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY | RTLD_LOCAL)
    static let setWindowLocation: SetWindowLocation? = {
        guard let framework, let symbol = dlsym(framework, "CGEventSetWindowLocation") else { return nil }
        return unsafeBitCast(symbol, to: SetWindowLocation.self)
    }()
    private static var eventNumber = 0

    static func nextEventNumber() -> Int {
        eventNumber = eventNumber == Int.max ? 1 : eventNumber + 1
        return eventNumber
    }
}

/// Window capture pixels and Quartz input coordinates have different units on
/// Retina displays. Always scale through the window's point-sized frame.
enum NativeWindowGeometry {
    static func imageRect(imageSize: CGSize, bounds: CGRect) -> CGRect {
        guard imageSize.width > 0, imageSize.height > 0, bounds.width > 0, bounds.height > 0 else { return .zero }
        let scale = min(bounds.width / imageSize.width, bounds.height / imageSize.height)
        let size = CGSize(width: imageSize.width * scale, height: imageSize.height * scale)
        return CGRect(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2, width: size.width, height: size.height)
    }

    /// `point` and `imageRect` are in a flipped NSView (top-left origin).
    static func targetPoint(_ point: CGPoint, imageRect: CGRect, windowFrame: CGRect, clamp: Bool = false) -> CGPoint? {
        guard imageRect.width > 0, imageRect.height > 0, windowFrame.width > 0, windowFrame.height > 0,
              clamp || imageRect.contains(point) else { return nil }
        let x = min(max((point.x - imageRect.minX) / imageRect.width, 0), 1)
        let y = min(max((point.y - imageRect.minY) / imageRect.height, 0), 1)
        return CGPoint(x: windowFrame.minX + min(x * windowFrame.width, windowFrame.width.nextDown),
                       y: windowFrame.minY + min(y * windowFrame.height, windowFrame.height.nextDown))
    }
}

/// Trackpads send subpixel increments. Quantizing each event independently
/// loses slow gestures; retain a bounded remainder until the next increment.
struct NativeScrollAccumulator {
    private var remainderX = 0.0
    private var remainderY = 0.0
    private var precise: Bool?

    mutating func reset() {
        remainderX = 0; remainderY = 0; precise = nil
    }

    mutating func consume(x: Double, y: Double, precise: Bool) -> (x: Int32, y: Int32) {
        if self.precise != precise { reset(); self.precise = precise }
        func quantize(_ delta: Double, remainder: inout Double) -> Int32 {
            let total = delta + remainder
            guard total.isFinite else { remainder = 0; return 0 }
            let limited = min(max(total, Double(Int32.min)), Double(Int32.max))
            let whole = limited.rounded(.towardZero)
            remainder = limited == total ? total - whole : 0
            return Int32(whole)
        }
        return (quantize(x, remainder: &remainderX), quantize(y, remainder: &remainderY))
    }
}

struct NativeWindowInputView: NSViewRepresentable {
    @ObservedObject var tab: NativeAppTab
    var controlEnabled: Bool
    var onFocusChanged: ((Bool) -> Void)? = nil
    var onInputIssue: ((String?) -> Void)? = nil
    var onClose: (() -> Void)? = nil

    func makeNSView(context: Context) -> NativeWindowCanvas {
        let view = NativeWindowCanvas()
        view.update(tab: tab, controlEnabled: controlEnabled, onFocusChanged: onFocusChanged, onInputIssue: onInputIssue, onClose: onClose)
        return view
    }

    func updateNSView(_ nsView: NativeWindowCanvas, context: Context) {
        nsView.update(tab: tab, controlEnabled: controlEnabled, onFocusChanged: onFocusChanged, onInputIssue: onInputIssue, onClose: onClose)
    }

    static func dismantleNSView(_ nsView: NativeWindowCanvas, coordinator: ()) {
        nsView.releaseInput()
    }
}

/// This view receives Hub input and sends it only to the chosen process. It
/// never installs a global event tap and never posts events to the desktop.
final class NativeWindowCanvas: NSView, NSTextInputClient {
    private weak var tab: NativeAppTab?
    private var image: CGImage?
    private var controlEnabled = false
    private var onFocusChanged: ((Bool) -> Void)?
    private var onInputIssue: ((String?) -> Void)?
    private var onClose: (() -> Void)?
    private var shortcutMonitor: Any?
    private var inputIssue: String?
    private var keyboardTargetIdentity: String?
    private var identity: String?
    private var heldButtons: Set<CGMouseButton> = []
    private var heldButtonFlags: [CGMouseButton: CGEventFlags] = [:]
    private var heldKeys: Set<CGKeyCode> = []
    private var lastPoint = CGPoint.zero
    private var lastLocalPoint = CGPoint(x: 40, y: 60)
    private var sentFlags: CGEventFlags = []
    private var source = CGEventSource(stateID: .privateState)
    private var tracking: NSTrackingArea?
    private var markedText = NSAttributedString(string: "")
    private var markedSelection = NSRange(location: 0, length: 0)
    private var interpretingEvent: NSEvent?
    private var resignObserver: NSObjectProtocol?
    private var validatedIdentity: String?
    private var validatedAt = Date.distantPast
    private var validatedFrame: CGRect?
    private var focusedWindow: AXUIElement?
    private var heldTarget: (pid_t, CGWindowID)?
    private var scrollAccumulator = NativeScrollAccumulator()
    private var pendingMenuRefocus: (pid: pid_t, windowID: CGWindowID, identity: String)?
    private var contextMenuTarget: (pid: pid_t, windowID: CGWindowID, until: Date)?
    private var consumedContextClick = false
    private var menuTransaction: (token: UUID, menu: AXUIElement, pid: pid_t, identity: String?)?
    private var menuTransactionTask: Task<Void, Never>?
    private var queuedMenuInputs: [() -> Void] = []

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.cgColor
        setAccessibilityElement(true)
        setAccessibilityRole(.image)
        setAccessibilityLabel("原生应用窗口镜像")
        setAccessibilityHelp("点击窗口画面后可操作应用。原生控件的辅助功能树由原应用提供。")
        resignObserver = NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: nil, queue: .main) { [weak self] note in
            guard let self, let window = note.object as? NSWindow, window === self.window else { return }
            self.releaseInput()
            self.onFocusChanged?(false)
        }
        // AppKit may resolve an Edit command before the representable's
        // responder chain. This is local to Hub, never a global event tap.
        shortcutMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            self?.handleLocalShortcut(event) == true ? nil : event
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit {
        if let resignObserver { NotificationCenter.default.removeObserver(resignObserver) }
        if let shortcutMonitor { NSEvent.removeMonitor(shortcutMonitor) }
    }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { controlEnabled }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    func update(tab: NativeAppTab, controlEnabled: Bool, onFocusChanged: ((Bool) -> Void)?, onInputIssue: ((String?) -> Void)?, onClose: (() -> Void)? = nil) {
        self.onInputIssue = onInputIssue
        self.onClose = onClose
        let newIdentity = "\(tab.runningPID ?? 0):\(tab.selectedWindowID ?? 0)"
        let postAccess = CGPreflightPostEventAccess()
        let enabled = controlEnabled && tab.state == .streaming && AXIsProcessTrusted() && postAccess
        if identity != newIdentity || (self.controlEnabled && !enabled) {
            releaseInput()
            focusedWindow = nil
            validatedIdentity = nil
            if window?.firstResponder === self { window?.makeFirstResponder(nil) }
        }
        self.tab = tab
        self.identity = newIdentity
        self.controlEnabled = enabled
        self.onFocusChanged = onFocusChanged
        self.image = tab.image
        if controlEnabled && tab.state == .streaming && AXIsProcessTrusted() && !postAccess {
            reportInputIssue("系统尚未允许 AI Hub 投递输入事件。请在系统设置中确认 AI Hub 的辅助功能权限，再重新打开 Hub。")
        }
        setAccessibilityLabel("\(tab.appName) 原生窗口镜像")
        needsDisplay = true
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.activeInKeyWindow, .inVisibleRect, .mouseMoved, .mouseEnteredAndExited], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.setFill()
        bounds.fill()
        if let image {
            let rect = displayRect
            NSImage(cgImage: image, size: CGSize(width: image.width, height: image.height))
                .draw(in: rect, from: .zero, operation: .copy, fraction: 1, respectFlipped: true, hints: [.interpolation: NSImageInterpolation.high])
        }
        if hasMarkedText() {
            let size = markedText.size()
            let rect = CGRect(x: min(lastLocalPoint.x, max(0, bounds.width - size.width - 18)),
                              y: min(lastLocalPoint.y + 18, max(0, bounds.height - size.height - 10)),
                              width: size.width + 12, height: size.height + 8)
            NSColor.controlBackgroundColor.setFill()
            NSBezierPath(roundedRect: rect, xRadius: 4, yRadius: 4).fill()
            markedText.draw(at: CGPoint(x: rect.minX + 6, y: rect.minY + 4))
        }
    }

    private var displayRect: CGRect {
        guard let image else { return .zero }
        return NativeWindowGeometry.imageRect(imageSize: CGSize(width: image.width, height: image.height), bounds: bounds)
    }

    override func becomeFirstResponder() -> Bool {
        guard controlEnabled else { return false }
        onFocusChanged?(true)
        return true
    }

    override func resignFirstResponder() -> Bool {
        releaseInput()
        inputContext?.discardMarkedText()
        markedText = NSAttributedString(string: "")
        onFocusChanged?(false)
        return true
    }

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        if newWindow !== window { releaseInput() }
        super.viewWillMove(toWindow: newWindow)
    }

    /// Recheck the exact owner before sending input. A recycled window number
    /// or exited/restarted process must never receive an old stream's input.
    private func target() -> (pid_t, CGWindowID, CGRect)? {
        guard controlEnabled, AXIsProcessTrusted(), CGPreflightPostEventAccess(), let tab, tab.state == .streaming,
              let pid = tab.runningPID, pid != ProcessInfo.processInfo.processIdentifier,
              let windowID = tab.selectedWindowID,
              let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { return nil }
        let key = "\(pid):\(windowID)"
        if validatedIdentity != key || Date().timeIntervalSince(validatedAt) > 0.2 {
            guard let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]])?.first,
                  let owner = info[kCGWindowOwnerPID as String] as? Int, owner == Int(pid) else { return nil }
            if let bounds = info[kCGWindowBounds as String] as? [String: Any] {
                validatedFrame = CGRect(dictionaryRepresentation: bounds as CFDictionary)
            } else { validatedFrame = nil }
            validatedIdentity = key
            validatedAt = Date()
        }
        guard let frame = validatedFrame ?? tab.selectedWindowFrame else { return nil }
        return (pid, windowID, frame)
    }

    private func focusTargetWindow(pid: pid_t, frame: CGRect) {
        let application = AXUIElementCreateApplication(pid)
        focusedWindow = nil
        keyboardTargetIdentity = nil
        do {
            var value: CFTypeRef?
            if AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &value) == .success,
               let windows = value as? [AXUIElement] {
                let candidates = windows.filter { window in
                    var position: CFTypeRef?, size: CFTypeRef?
                    guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &position) == .success,
                          AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &size) == .success,
                          let position, let size,
                          CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return false }
                    var p = CGPoint.zero, s = CGSize.zero
                    AXValueGetValue(unsafeBitCast(position, to: AXValue.self), .cgPoint, &p)
                    AXValueGetValue(unsafeBitCast(size, to: AXValue.self), .cgSize, &s)
                    return abs(p.x - frame.minX) < 3 && abs(p.y - frame.minY) < 3 && abs(s.width - frame.width) < 3 && abs(s.height - frame.height) < 3
                }
                let selectedTitle = tab?.windows.first(where: { $0.id == tab?.selectedWindowID })?.title
                let titleMatches = candidates.filter { window in
                    var title: CFTypeRef?
                    return AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &title) == .success
                        && (title as? String) == selectedTitle
                }
                focusedWindow = titleMatches.count == 1 ? titleMatches.first : (candidates.count == 1 ? candidates.first : nil)
            }
        }
        if let focusedWindow {
            let focus = AXUIElementSetAttributeValue(application, kAXFocusedWindowAttribute as CFString, focusedWindow)
            let main = AXUIElementSetAttributeValue(focusedWindow, kAXMainAttribute as CFString, kCFBooleanTrue)
            NativeInputDiagnostics.record("focusTarget", ["focusResult": focus.rawValue, "mainResult": main.rawValue])
        }
        guard let windowID = tab?.selectedWindowID,
              selectedAXWindowHasFocus(pid: pid, windowID: windowID) else {
            reportInputIssue("尚未确认所选应用窗口的键盘焦点。请再次点击镜像；仍无法输入时，在外部打开并选中该窗口后重试。")
            return
        }
        keyboardTargetIdentity = "\(pid):\(windowID)"
        reportInputIssue(nil)
    }

    /// No positive-result cache: another application window can gain focus
    /// between any two keystrokes. Check the process' actual focused AX window
    /// before each key down / committed grapheme, without activating the app.
    private func selectedAXWindowHasFocus(pid: pid_t, windowID: CGWindowID) -> Bool {
        guard AXIsProcessTrusted(), let focusedWindow,
              let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]])?.first,
              (info[kCGWindowOwnerPID as String] as? Int) == Int(pid) else { return false }
        var owner: pid_t = 0
        guard AXUIElementGetPid(focusedWindow, &owner) == .success, owner == pid else { return false }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXUIElementGetTypeID(), CFEqual(value, focusedWindow) else { return false }
        return true
    }

    private func keyboardTarget() -> (pid_t, CGWindowID)? {
        let candidate = target()
        let identityMatches = candidate.map { keyboardTargetIdentity == "\($0.0):\($0.1)" } ?? false
        let focusMatches = candidate.map { selectedAXWindowHasFocus(pid: $0.0, windowID: $0.1) } ?? false
        NativeInputDiagnostics.record("keyboardTarget", ["targetPresent": candidate != nil,
            "firstResponder": window?.firstResponder === self, "identityMatches": identityMatches, "focusMatches": focusMatches])
        guard let (pid, windowID, _) = candidate, window?.firstResponder === self,
              identityMatches, focusMatches else {
            // Matching key/button releases still go directly to the held
            // original target. They must not depend on the new focus gate.
            releaseInput()
            reportInputIssue("所选窗口的键盘焦点尚未确认或已变化，输入已暂停。请点击镜像重新确认；必要时在外部选中该窗口后重试。")
            return nil
        }
        reportInputIssue(nil)
        return (pid, windowID)
    }

    private func reportInputIssue(_ issue: String?) {
        guard issue != inputIssue else { return }
        inputIssue = issue
        // Avoid publishing SwiftUI state during NSViewRepresentable updates.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.inputIssue == issue else { return }
            self.onInputIssue?(issue)
        }
    }

    private func send(_ event: CGEvent, pid: pid_t, windowID: CGWindowID) {
        guard AXIsProcessTrusted(), CGPreflightPostEventAccess(), pid != ProcessInfo.processInfo.processIdentifier,
              let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]])?.first,
              (info[kCGWindowOwnerPID as String] as? Int) == Int(pid) else {
            return
        }
        event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(pid))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowID))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowID))
        event.postToPid(pid)
    }

    private func pointerFlags(_ flags: NSEvent.ModifierFlags, pid: pid_t) -> CGEventFlags {
        var result = cgFlags(flags)
        // Background window dispatch uses this routing bit in addition to the
        // user's modifiers. It does not activate or raise the application.
        if NSRunningApplication(processIdentifier: pid)?.isActive == false { result.insert(.maskCommand) }
        return result
    }

    private func stampPointer(_ output: CGEvent, windowID: CGWindowID, frame: CGRect, point: CGPoint, flags: CGEventFlags) -> Bool {
        guard let setWindowLocation = NativeBackgroundWindowEvents.setWindowLocation else {
            reportInputIssue("当前 macOS 不提供后台鼠标窗口路由，鼠标操作已暂停。可在外部打开应用继续操作。")
            return false
        }
        output.location = point
        output.flags = flags
        output.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowID))
        output.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowID))
        output.setIntegerValueField(.mouseEventSubtype, value: 3)
        let global = output.location
        setWindowLocation(output, CGPoint(x: global.x - frame.minX, y: global.y - frame.minY))
        return true
    }

    /// NSEvent supplies the AppKit window-number metadata missing from a bare
    /// CGEventCreateMouseEvent; a global location alone cannot route into the
    /// correct background NSWindow's view hierarchy.
    private func makePointerEvent(type: CGEventType, button: CGMouseButton, windowID: CGWindowID,
                                  frame: CGRect, point: CGPoint, flags: CGEventFlags,
                                  clickCount: Int, pressure: Float) -> CGEvent? {
        guard let eventType = NSEvent.EventType(rawValue: UInt(type.rawValue)),
              let output = NSEvent.mouseEvent(with: eventType, location: point,
                  modifierFlags: NSEvent.ModifierFlags(rawValue: UInt(flags.rawValue)),
                  timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: Int(windowID),
                  context: nil, eventNumber: NativeBackgroundWindowEvents.nextEventNumber(),
                  clickCount: clickCount, pressure: pressure)?.cgEvent else {
            reportInputIssue("无法创建应用窗口鼠标事件，请重新连接该窗口后重试。")
            return nil
        }
        output.setIntegerValueField(.mouseEventButtonNumber, value: Int64(button.rawValue))
        guard stampPointer(output, windowID: windowID, frame: frame, point: point, flags: flags) else { return nil }
        return output
    }

    private func currentWindowFrame(_ windowID: CGWindowID, pid: pid_t) -> CGRect? {
        guard let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]])?.first,
              (info[kCGWindowOwnerPID as String] as? Int) == Int(pid),
              let bounds = info[kCGWindowBounds as String] as? [String: Any] else { return nil }
        return CGRect(dictionaryRepresentation: bounds as CFDictionary)
    }

    private func eventPoint(_ event: NSEvent, clamp: Bool = false) -> (pid_t, CGWindowID, CGPoint)? {
        guard let (pid, windowID, frame) = target() else { return nil }
        let local = convert(event.locationInWindow, from: nil)
        guard let point = NativeWindowGeometry.targetPoint(local, imageRect: displayRect, windowFrame: frame, clamp: clamp) else { return nil }
        lastLocalPoint = local
        NativeInputDiagnostics.record("pointerMap", [
            "localX": local.x, "localY": local.y,
            "displayX": displayRect.minX, "displayY": displayRect.minY,
            "displayWidth": displayRect.width, "displayHeight": displayRect.height,
            "windowX": frame.minX, "windowY": frame.minY,
            "windowWidth": frame.width, "windowHeight": frame.height,
            "targetX": point.x, "targetY": point.y
        ])
        return (pid, windowID, point)
    }

    private func mouse(_ event: NSEvent, type: CGEventType, button: CGMouseButton, begin: Bool = false, end: Bool = false) {
        if button == .left && end && consumedContextClick {
            consumedContextClick = false
            return
        }
        guard let (pid, windowID, point) = eventPoint(event, clamp: !heldButtons.isEmpty) else { return }
        guard let frame = currentWindowFrame(windowID, pid: pid) else { return }
        if begin {
            cancelMenuTransaction()
            // Keep traffic lights/window dragging outside the remote input
            // surface. Closing a Hub mirror must not close an app document.
            guard point.y >= frame.minY + 28 else { return }
            // A window-scoped event may arrive while another app is active.
            // Establish the Hub responder window without raising either app.
            window?.makeKey()
            window?.makeFirstResponder(self)
            NativeInputDiagnostics.record("mouseBegin", ["left": button == .left, "right": button == .right,
                "contextPending": contextMenuTarget != nil, "visible": tab?.isVisible == true,
                "firstResponder": window?.firstResponder === self, "keyWindow": NSApp.keyWindow === window])
            NativeInputDiagnostics.menuBindings()
            if button == .left, pressContextMenuItem(at: point, pid: pid, windowID: windowID) {
                consumedContextClick = true
                return
            }
            contextMenuTarget = nil
            focusTargetWindow(pid: pid, frame: frame)
            if button == .right {
                contextMenuTarget = (pid, windowID, Date().addingTimeInterval(30))
            }
            heldButtons.insert(button)
            heldTarget = (pid, windowID)
        } else if end && !heldButtons.contains(button) { return }
        let flags = end ? (heldButtonFlags[button] ?? pointerFlags(event.modifierFlags, pid: pid)) : pointerFlags(event.modifierFlags, pid: pid)
        guard let output = makePointerEvent(type: type, button: button, windowID: windowID, frame: frame,
                                            point: point, flags: flags, clickCount: event.clickCount,
                                            pressure: end || type == .mouseMoved ? 0 : 1) else { return }
        if begin { heldButtonFlags[button] = flags }
        lastPoint = point
        send(output, pid: pid, windowID: windowID)
        if end { heldButtons.remove(button); heldButtonFlags.removeValue(forKey: button) }
    }

    /// Menus are separate AppKit windows. Sending their click to the captured
    /// document can dismiss the menu without executing it. Only a menu opened
    /// by this canvas, for this still-focused root window, may use AXPress.
    private func pressContextMenuItem(at point: CGPoint, pid: pid_t, windowID: CGWindowID) -> Bool {
        guard let pending = contextMenuTarget else { NativeInputDiagnostics.record("context.none"); return false }
        contextMenuTarget = nil
        NativeInputDiagnostics.record("context.check", ["pidMatches": pending.pid == pid,
            "windowMatches": pending.windowID == windowID, "inTime": Date() < pending.until,
            "rootFocus": selectedAXWindowHasFocus(pid: pid, windowID: windowID)])
        guard pending.pid == pid, pending.windowID == windowID, Date() < pending.until,
              selectedAXWindowHasFocus(pid: pid, windowID: windowID) else { return false }
        var hit: AXUIElement?
        let hitResult = AXUIElementCopyElementAtPosition(AXUIElementCreateApplication(pid), Float(point.x), Float(point.y), &hit)
        NativeInputDiagnostics.record("context.hit", ["result": hitResult.rawValue, "element": hit != nil])
        guard hitResult == .success, var item = hit else { return false }
        for _ in 0..<4 {
            var owner: pid_t = 0
            guard AXUIElementGetPid(item, &owner) == .success, owner == pid else { return false }
            var role: CFTypeRef?
            guard AXUIElementCopyAttributeValue(item, kAXRoleAttribute as CFString, &role) == .success else { return false }
            NativeInputDiagnostics.record("context.role", ["role": (role as? String) ?? "unknown"])
            if (role as? String) == kAXMenuItemRole {
                var enabled: CFTypeRef?, actions: CFArray?
                guard AXUIElementCopyAttributeValue(item, kAXEnabledAttribute as CFString, &enabled) == .success,
                      (enabled as? NSNumber)?.boolValue == true,
                      AXUIElementCopyActionNames(item, &actions) == .success,
                      (actions as? [String])?.contains(kAXPressAction) == true else { return true }
                guard let current = target(), current.0 == pid, current.1 == windowID,
                      selectedAXWindowHasFocus(pid: pid, windowID: windowID) else { return true }
                let result = AXUIElementPerformAction(item, kAXPressAction as CFString)
                NativeInputDiagnostics.record("context.press", ["result": result.rawValue])
                if result != .success { reportInputIssue("原应用未能执行右键菜单选项（\(result.rawValue)）。") }
                return true
            }
            var parent: CFTypeRef?
            guard AXUIElementCopyAttributeValue(item, kAXParentAttribute as CFString, &parent) == .success,
                  let parent, CFGetTypeID(parent) == AXUIElementGetTypeID() else { return false }
            item = unsafeBitCast(parent, to: AXUIElement.self)
        }
        return false
    }

    override func mouseDown(with event: NSEvent) { mouse(event, type: .leftMouseDown, button: .left, begin: true) }
    override func mouseUp(with event: NSEvent) { mouse(event, type: .leftMouseUp, button: .left, end: true) }
    override func mouseDragged(with event: NSEvent) { mouse(event, type: .leftMouseDragged, button: .left) }
    override func rightMouseDown(with event: NSEvent) { mouse(event, type: .rightMouseDown, button: .right, begin: true) }
    override func rightMouseUp(with event: NSEvent) { mouse(event, type: .rightMouseUp, button: .right, end: true) }
    override func rightMouseDragged(with event: NSEvent) { mouse(event, type: .rightMouseDragged, button: .right) }
    override func otherMouseDown(with event: NSEvent) { mouse(event, type: .otherMouseDown, button: .center, begin: true) }
    override func otherMouseUp(with event: NSEvent) { mouse(event, type: .otherMouseUp, button: .center, end: true) }
    override func otherMouseDragged(with event: NSEvent) { mouse(event, type: .otherMouseDragged, button: .center) }
    override func mouseMoved(with event: NSEvent) { mouse(event, type: .mouseMoved, button: .left) }

    override func scrollWheel(with event: NSEvent) {
        cancelMenuTransaction()
        guard let (pid, windowID, point) = eventPoint(event) else { return }
        guard let frame = currentWindowFrame(windowID, pid: pid) else { return }
        let flags = pointerFlags(event.modifierFlags, pid: pid)
        // Prime the target process' window-under-pointer state before a wheel
        // event; this does not move the user's system cursor.
        guard let hover = makePointerEvent(type: .mouseMoved, button: .left, windowID: windowID,
                                           frame: frame, point: point, flags: flags, clickCount: 0, pressure: 0) else { return }
        send(hover, pid: pid, windowID: windowID)
        if event.phase.contains(.began) || event.phase.contains(.mayBegin) || event.momentumPhase.contains(.began) {
            scrollAccumulator.reset()
        }
        let delta = scrollAccumulator.consume(x: Double(event.scrollingDeltaX), y: Double(event.scrollingDeltaY), precise: event.hasPreciseScrollingDeltas)
        var scrollPhase: Int64 = 0
        if event.phase.contains(.began) { scrollPhase = 1 }
        else if event.phase.contains(.changed) || event.phase.contains(.stationary) { scrollPhase = 2 }
        else if event.phase.contains(.ended) { scrollPhase = 4 }
        else if event.phase.contains(.cancelled) { scrollPhase = 8 }
        else if event.phase.contains(.mayBegin) { scrollPhase = 128 }
        var momentumPhase: Int64 = 0
        if event.momentumPhase.contains(.began) { momentumPhase = 1 }
        else if event.momentumPhase.contains(.changed) || event.momentumPhase.contains(.stationary) { momentumPhase = 2 }
        else if event.momentumPhase.contains(.ended) || event.momentumPhase.contains(.cancelled) { momentumPhase = 3 }
        if event.phase.contains(.ended) || event.phase.contains(.cancelled) || momentumPhase == 3 { scrollAccumulator.reset() }
        guard delta.x != 0 || delta.y != 0 || scrollPhase != 0 || momentumPhase != 0 else { return }
        let unit: CGScrollEventUnit = event.hasPreciseScrollingDeltas ? .pixel : .line
        guard let output = CGEvent(scrollWheelEvent2Source: source, units: unit, wheelCount: 2,
                                   wheel1: delta.y, wheel2: delta.x, wheel3: 0) else { return }
        guard stampPointer(output, windowID: windowID, frame: frame, point: point, flags: flags) else { return }
        // A raw wheel event lacks the window-number metadata supplied by the
        // NSEvent mouse factory. Match the background scroll routing recipe
        // in axcli's scroll_wheel_bg; fields 91/92 alone do not supply it.
        if let windowNumberField = CGEventField(rawValue: 51) {
            output.setIntegerValueField(windowNumberField, value: Int64(windowID))
        }
        output.setIntegerValueField(.scrollWheelEventScrollPhase, value: scrollPhase)
        output.setIntegerValueField(.scrollWheelEventMomentumPhase, value: momentumPhase)
        send(output, pid: pid, windowID: windowID)
    }

    private func hubShortcut(_ event: NSEvent) -> Bool {
        guard event.modifierFlags.contains(.command) else { return false }
        // Cmd-W is intentionally left to AppDelegate.closeTabOrWindow.
        return ["w", "q", "h", "m", "\t"].contains(event.charactersIgnoringModifiers?.lowercased() ?? "")
            || event.keyCode == 48
    }

    private func handleLocalShortcut(_ event: NSEvent) -> Bool {
        NativeInputDiagnostics.record("localKey", ["enabled": controlEnabled, "visible": tab?.isVisible == true,
            "firstResponder": window?.firstResponder === self, "eventWindowPresent": event.window != nil,
            "ownEventWindow": event.window === window,
            "modifiers": event.modifierFlags.intersection([.command, .shift, .option, .control]).rawValue])
        guard controlEnabled, tab?.isVisible == true, let window,
              window.firstResponder === self,
              event.modifierFlags.intersection([.command, .shift, .option, .control]) == [.command] else { return false }
        if let eventWindow = event.window {
            guard eventWindow === window else { return false }
        } else {
            // Background window-scoped callers may omit an event window.
            // Ambiguity between Hub windows must never pick an arbitrary one.
            let candidates = NSApp.windows.filter {
                guard $0.isVisible, let canvas = $0.firstResponder as? NativeWindowCanvas else { return false }
                return canvas.controlEnabled && canvas.tab?.isVisible == true
            }
            guard candidates.count == 1, candidates.first === window else { return false }
        }
        let character = event.charactersIgnoringModifiers?.lowercased() ?? ""
        if hubShortcut(event) { cancelMenuTransaction() }
        if character == "w", let onClose {
            releaseInput()
            onClose()
            return true
        }
        let edits: [String: UInt16] = ["a": 0, "c": 8, "v": 9, "x": 7, "z": 6]
        guard let keyCode = edits[character] else { return false }
        if queueMenuInput({ [weak self] in self?.forwardEditAction(character, keyCode: keyCode) }) { return true }
        forwardEditAction(character, keyCode: keyCode)
        return true
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        NativeInputDiagnostics.record("keyEquivalent", ["enabled": controlEnabled, "firstResponder": window?.firstResponder === self,
            "command": event.modifierFlags.contains(.command), "hubShortcut": hubShortcut(event)])
        guard window?.firstResponder === self, controlEnabled,
              event.modifierFlags.contains(.command) else { return false }
        if hubShortcut(event) { cancelMenuTransaction(); return false }
        if queueMenuInput({ [weak self] in _ = self?.performKeyEquivalent(with: event) }) { return true }
        recoverMenuFocusIfNeeded()
        forwardKey(event, down: true)
        return true
    }

    override func keyDown(with event: NSEvent) {
        if hubShortcut(event) { cancelMenuTransaction() }
        else if queueMenuInput({ [weak self] in self?.keyDown(with: event) }) { return }
        NativeInputDiagnostics.record("keyDown", ["command": event.modifierFlags.contains(.command), "control": event.modifierFlags.contains(.control)])
        guard !hubShortcut(event), target() != nil else { super.keyDown(with: event); return }
        recoverMenuFocusIfNeeded()
        guard keyboardTarget() != nil else { return }
        if event.modifierFlags.contains(.command) || event.modifierFlags.contains(.control) {
            forwardKey(event, down: true)
        } else {
            interpretingEvent = event
            interpretKeyEvents([event])
            interpretingEvent = nil
        }
    }

    override func keyUp(with event: NSEvent) {
        if queueMenuInput({ [weak self] in self?.keyUp(with: event) }) { return }
        if heldKeys.contains(event.keyCode) { forwardKey(event, down: false) }
    }

    override func flagsChanged(with event: NSEvent) {
        if queueMenuInput({ [weak self] in self?.flagsChanged(with: event) }) { return }
        let flags = cgFlags(event.modifierFlags)
        // Focus loss already releases the previous target's modifiers. Ignore
        // the subsequent physical key release rather than reporting a new
        // keyboard-focus failure, and avoid sending unchanged modifier state.
        guard controlEnabled, window?.firstResponder === self,
              let keyboardTargetIdentity, keyboardTargetIdentity == identity,
              flags != sentFlags else { return }
        guard let (pid, windowID) = keyboardTarget(),
              let output = CGEvent(keyboardEventSource: source, virtualKey: event.keyCode, keyDown: false) else { return }
        output.type = .flagsChanged
        output.flags = flags
        sentFlags = output.flags
        heldTarget = (pid, windowID)
        send(output, pid: pid, windowID: windowID)
    }

    private func forwardKey(_ event: NSEvent, down: Bool) {
        if !down {
            // Key-up releases the original target even if another window has
            // since gained focus. Never route a release to a newly selected
            // application or let a failed focus check leave a held key behind.
            guard heldKeys.remove(event.keyCode) != nil, let (pid, windowID) = heldTarget,
                  AXIsProcessTrusted(), CGPreflightPostEventAccess(), NSRunningApplication(processIdentifier: pid)?.isTerminated == false,
                  let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]])?.first,
                  (info[kCGWindowOwnerPID as String] as? Int) == Int(pid),
                  let output = makeKeyEvent(event, down: false, windowID: windowID) else { return }
            output.flags = []
            send(output, pid: pid, windowID: windowID)
            return
        }
        guard let (pid, windowID) = keyboardTarget() else {
            return
        }
        if let character = standardEditCharacter(event) {
            if character == "a", selectFocusedText(pid: pid, windowID: windowID) { return }
            if character == "v", pasteIntoFocusedText(pid: pid, windowID: windowID) { return }
            if performNativeEditMenu(character: character, pid: pid, windowID: windowID) { return }
        }
        guard let current = keyboardTarget(), current.0 == pid, current.1 == windowID else { return }
        guard let output = makeKeyEvent(event, down: down, windowID: windowID) else {
            reportInputIssue("无法创建应用窗口键盘事件，请重新连接该窗口后重试。")
            return
        }
        output.flags = cgFlags(event.modifierFlags)
        output.setIntegerValueField(.keyboardEventAutorepeat, value: event.isARepeat ? 1 : 0)
        send(output, pid: pid, windowID: windowID)
        heldTarget = (pid, windowID)
        if down { heldKeys.insert(event.keyCode) } else { heldKeys.remove(event.keyCode) }
    }

    private func standardEditCharacter(_ event: NSEvent) -> String? {
        let modifiers = event.modifierFlags.intersection([.command, .shift, .option, .control])
        guard modifiers == [.command],
              let character = event.charactersIgnoringModifiers?.lowercased(),
              ["a", "c", "v", "x", "z"].contains(character) else { return nil }
        return character
    }

    /// Standard text clients expose a writable selection independently of
    /// their app's lazily validated background menus. Read only character
    /// count/selection metadata, never the document body. Unsupported clients
    /// retain the menu route; once a write is attempted, consume the command
    /// even on failure, so a fallback cannot repeat it against another target.
    /// https://developer.apple.com/documentation/applicationservices/kaxselectedtextrangeattribute
    private func selectFocusedText(pid: pid_t, windowID: CGWindowID) -> Bool {
        func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
            return value
        }
        guard let selectedWindow = focusedWindow,
              let current = keyboardTarget(), current.0 == pid, current.1 == windowID else { return false }
        let application = AXUIElementCreateApplication(pid)
        guard let value = attribute(application, kAXFocusedUIElementAttribute),
              CFGetTypeID(value) == AXUIElementGetTypeID() else { return false }
        let element = unsafeBitCast(value, to: AXUIElement.self)
        var owner: pid_t = 0
        guard AXUIElementGetPid(element, &owner) == .success, owner == pid,
              let role = attribute(element, kAXRoleAttribute) as? String,
              [kAXTextAreaRole, kAXTextFieldRole].contains(role),
              (attribute(element, kAXSubroleAttribute) as? String) != kAXSecureTextFieldSubrole,
              let elementWindow = attribute(element, kAXWindowAttribute),
              CFGetTypeID(elementWindow) == AXUIElementGetTypeID(),
              CFEqual(elementWindow, selectedWindow) else { return false }
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(element, kAXSelectedTextRangeAttribute as CFString, &settable) == .success,
              settable.boolValue,
              let count = attribute(element, kAXNumberOfCharactersAttribute) as? NSNumber,
              count.intValue >= 0 else { return false }
        let commandIdentity = identity
        var range = CFRange(location: 0, length: count.intValue)
        guard let selection = AXValueCreate(.cfRange, &range) else { return false }
        guard let verified = keyboardTarget(), verified.0 == pid, verified.1 == windowID,
              identity == commandIdentity,
              let stillFocused = attribute(application, kAXFocusedUIElementAttribute),
              CFEqual(stillFocused, element) else {
            reportInputIssue("原应用的编辑焦点已改变，请重新点击编辑区后重试。")
            return true
        }
        let result = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, selection)
        var actual = CFRange(location: kCFNotFound, length: 0)
        var matches = false
        if result == .success, let readback = attribute(element, kAXSelectedTextRangeAttribute),
           CFGetTypeID(readback) == AXValueGetTypeID() {
            let selected = unsafeBitCast(readback, to: AXValue.self)
            matches = AXValueGetType(selected) == .cfRange && AXValueGetValue(selected, .cfRange, &actual)
                && actual.location == range.location && actual.length == range.length
        }
        NativeInputDiagnostics.record("textSelection.selectAll", ["result": result.rawValue,
            "length": range.length, "matches": matches])
        reportInputIssue(matches ? nil : "原应用没有确认全选结果，请重新点击编辑区后重试。")
        return true
    }

    /// Some AppKit clients keep their Edit menu disabled while their window
    /// is operated in the background, even though the focused accessibility
    /// text element is writable. Paste through that focused element when it
    /// belongs to the selected PID/window. The clipboard is read once, never
    /// logged or persisted, and this path is consumed even if the write fails
    /// so the command cannot be executed a second time by an enabled menu.
    private func pasteIntoFocusedText(pid: pid_t, windowID: CGWindowID) -> Bool {
        func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
            return value
        }
        guard let selectedWindow = focusedWindow,
              let current = keyboardTarget(), current.0 == pid, current.1 == windowID else { return false }
        let application = AXUIElementCreateApplication(pid)
        guard let value = attribute(application, kAXFocusedUIElementAttribute),
              CFGetTypeID(value) == AXUIElementGetTypeID() else { return false }
        let element = unsafeBitCast(value, to: AXUIElement.self)
        var owner: pid_t = 0
        guard AXUIElementGetPid(element, &owner) == .success, owner == pid,
              let role = attribute(element, kAXRoleAttribute) as? String,
              [kAXTextAreaRole, kAXTextFieldRole].contains(role),
              (attribute(element, kAXSubroleAttribute) as? String) != kAXSecureTextFieldSubrole,
              let elementWindow = attribute(element, kAXWindowAttribute),
              CFGetTypeID(elementWindow) == AXUIElementGetTypeID(),
              CFEqual(elementWindow, selectedWindow) else { return false }
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(element, kAXSelectedTextAttribute as CFString, &settable) == .success,
              settable.boolValue,
              let text = NSPasteboard.general.string(forType: .string) else { return false }
        let commandIdentity = identity
        guard let verified = keyboardTarget(), verified.0 == pid, verified.1 == windowID,
              identity == commandIdentity,
              let stillFocused = attribute(application, kAXFocusedUIElementAttribute),
              CFEqual(stillFocused, element) else {
            reportInputIssue("原应用的编辑焦点已改变，请重新点击编辑区后重试。")
            return true
        }
        let result = AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFString)
        let inserted = attribute(element, kAXSelectedTextAttribute) as? String
        let matches = result == .success && text.isEmpty
            ? true
            : (result == .success && inserted == text)
        NativeInputDiagnostics.record("textPaste.write", ["result": result.rawValue,
            "length": text.utf16.count, "matches": matches])
        reportInputIssue(matches ? nil : "原应用没有确认粘贴结果，请重新点击编辑区后重试。")
        return true
    }

    /// AppKit can resolve an Edit shortcut through Hub's responder actions
    /// before performKeyEquivalent reaches this view. These actions use the
    /// same native adapter as physical keys. Paste reads the system clipboard
    /// once and writes it through the focused AX text element when possible.
    override func selectAll(_ sender: Any?) { forwardEditAction("a", keyCode: 0) }
    @objc func copy(_ sender: Any?) { forwardEditAction("c", keyCode: 8) }
    @objc func paste(_ sender: Any?) { forwardEditAction("v", keyCode: 9) }
    @objc func cut(_ sender: Any?) { forwardEditAction("x", keyCode: 7) }
    @objc func undo(_ sender: Any?) { forwardEditAction("z", keyCode: 6) }

    private func forwardEditAction(_ character: String, keyCode: UInt16) {
        if queueMenuInput({ [weak self] in self?.forwardEditAction(character, keyCode: keyCode) }) { return }
        NativeInputDiagnostics.record("editAction", ["command": character, "firstResponder": window?.firstResponder === self,
            "keyWindow": NSApp.keyWindow === window])
        guard window?.firstResponder === self else {
            return
        }
        recoverMenuFocusIfNeeded()
        guard keyboardTarget() != nil else {
            return
        }
        guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero,
                  modifierFlags: [.command], timestamp: ProcessInfo.processInfo.systemUptime,
                  windowNumber: window?.windowNumber ?? 0, context: nil,
                  characters: character, charactersIgnoringModifiers: character,
                  isARepeat: false, keyCode: keyCode) else {
            return
        }
        forwardKey(event, down: true)
        // A menu action need not have a physical key-up, so release only the
        // fallback event we just sent. AXPress itself does not hold a key.
        if heldKeys.contains(keyCode) { forwardKey(event, down: false) }
    }

    /// A successful native Edit menu command may temporarily clear the Hub
    /// input session. Only that known transition permits one re-confirmation
    /// on the next explicit input into the same, still-focused canvas.
    private func recoverMenuFocusIfNeeded() {
        guard let pending = pendingMenuRefocus else { return }
        pendingMenuRefocus = nil
        guard controlEnabled, window?.firstResponder === self,
              NSApp.keyWindow == nil || NSApp.keyWindow === window,
              identity == pending.identity,
              let (pid, windowID, frame) = target(),
              pid == pending.pid, windowID == pending.windowID else { return }
        // This sets and reads back the application's AXFocusedWindow only;
        // it never activates the target application or raises its window.
        focusTargetWindow(pid: pid, frame: frame)
    }

    /// Invoke the target application's own uniquely matching Edit menu item.
    /// AXMenuItemCmdModifiers uses the Carbon mask, where zero already means
    /// Command (unlike NSEvent.ModifierFlags). See Apple's AXAttributeConstants.h
    /// and AXUIElementPerformAction; never activate or raise the application.
    /// Returning false means no unique enabled action was found, so callers
    /// may use the original targeted CGEvent path. An attempted AXPress is
    /// consumed even on failure to avoid performing the same edit twice.
    private func performNativeEditMenu(character: String, pid: pid_t, windowID: CGWindowID) -> Bool {
        func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
            return value
        }
        let application = AXUIElementCreateApplication(pid)
        guard let value = attribute(application, kAXMenuBarAttribute),
              CFGetTypeID(value) == AXUIElementGetTypeID() else {
            NativeInputDiagnostics.record("nativeMenu.unavailable")
            return false
        }
        let menuBar = unsafeBitCast(value, to: AXUIElement.self)
        typealias Candidate = (item: AXUIElement, opener: AXUIElement?, menu: AXUIElement?)
        func supports(_ element: AXUIElement, _ action: String) -> Bool {
            var actions: CFArray?
            return AXUIElementCopyActionNames(element, &actions) == .success
                && (actions as? [String])?.contains(action) == true
        }
        func candidates() -> [Candidate]? {
            var pending: [(AXUIElement, Int, AXUIElement?, AXUIElement?)] = [(menuBar, 0, nil, nil)]
            var matches: [Candidate] = []
            var visited = 0
            while let (element, depth, parentOpener, parentMenu) = pending.popLast() {
                visited += 1
                guard visited <= 512, depth <= 8 else { return nil }
                let role = attribute(element, kAXRoleAttribute) as? String
                let opener = role == kAXMenuBarItemRole ? element : parentOpener
                let menu = role == kAXMenuRole ? element : parentMenu
                if role == kAXMenuItemRole,
                   (attribute(element, kAXMenuItemCmdCharAttribute) as? String)?.lowercased() == character {
                    let modifiers = attribute(element, kAXMenuItemCmdModifiersAttribute) as? NSNumber
                    let enabled = attribute(element, kAXEnabledAttribute) as? NSNumber
                    NativeInputDiagnostics.record("nativeMenu.candidate", ["command": character,
                        "modifiers": modifiers?.intValue ?? -1, "enabled": enabled?.intValue ?? -1,
                        "press": supports(element, kAXPressAction), "hasOpener": opener != nil,
                        "cancel": menu.map { supports($0, kAXCancelAction) } ?? false])
                    if modifiers?.intValue == 0 {
                        matches.append((element, opener, menu))
                        if matches.count > 1 { return nil }
                    }
                }
                if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
                    pending.append(contentsOf: children.map { ($0, depth + 1, opener, menu) })
                }
            }
            return matches
        }
        guard let matches = candidates() else { return false }
        NativeInputDiagnostics.record("nativeMenu.matches", ["command": character, "count": matches.count])
        guard let match = matches.first else { return false }
        if (attribute(match.item, kAXEnabledAttribute) as? NSNumber)?.boolValue != true {
            // AppKit validates a lazily initialized menu on its next event
            // cycle. AXPress can return before that cycle has run. Keep this
            // explicit command transaction scoped to the same input canvas.
            guard (attribute(match.item, kAXEnabledAttribute) as? NSNumber)?.boolValue == false,
                  let opener = match.opener, let menu = match.menu,
                  supports(opener, kAXPressAction), supports(menu, kAXCancelAction),
                  let current = keyboardTarget(), current.0 == pid, current.1 == windowID else {
                reportInputIssue("原应用的编辑命令暂不可用，请先在原应用中检查编辑菜单。")
                return true
            }
            let token = UUID()
            menuTransaction = (token, menu, pid, identity)
            let prime = AXUIElementPerformAction(opener, kAXPressAction as CFString)
            NativeInputDiagnostics.record("nativeMenu.prime", ["command": character, "result": prime.rawValue])
            menuTransactionTask = Task { @MainActor [weak self] in
                var succeeded = false
                defer { self?.finishMenuTransaction(token: token, replay: succeeded) }
                guard prime == .success else { return }
                // Menu validation may finish after AXPress returns. Poll within
                // a fixed bound so a fresh client can service its first edit,
                // without keeping queued user input indefinitely.
                let deadline = ContinuousClock.now + .milliseconds(1_200)
                var attempts = 0
                while ContinuousClock.now < deadline {
                    do { try await Task.sleep(nanoseconds: 40_000_000) }
                    catch { return }
                    guard !Task.isCancelled, let self,
                          let transaction = self.menuTransaction, transaction.token == token,
                          self.identity == transaction.identity,
                          self.window?.firstResponder === self else { return }
                    attempts += 1
                    guard let refreshed = candidates(), refreshed.count == 1,
                          let refreshedMatch = refreshed.first else {
                        NativeInputDiagnostics.record("nativeMenu.poll", ["command": character,
                            "attempt": attempts, "matched": false])
                        continue
                    }
                    let enabled = (attribute(refreshedMatch.item, kAXEnabledAttribute) as? NSNumber)?.boolValue == true
                    NativeInputDiagnostics.record("nativeMenu.poll", ["command": character,
                        "attempt": attempts, "matched": true, "enabled": enabled])
                    guard enabled, supports(refreshedMatch.item, kAXPressAction) else { continue }
                    succeeded = self.pressNativeEditMenuItem(refreshedMatch.item, character: character,
                                                             pid: pid, windowID: windowID)
                    return
                }
                self?.reportInputIssue("原应用的编辑命令仍不可用。")
            }
            return true
        }
        guard supports(match.item, kAXPressAction) else { return false }
        _ = pressNativeEditMenuItem(match.item, character: character, pid: pid, windowID: windowID)
        return true
    }

    @discardableResult
    private func pressNativeEditMenuItem(_ item: AXUIElement, character: String, pid: pid_t, windowID: CGWindowID) -> Bool {
        guard let current = keyboardTarget(), current.0 == pid, current.1 == windowID else { return false }
        var owner: pid_t = 0
        guard AXUIElementGetPid(item, &owner) == .success, owner == pid else { return false }
        let menuIdentity = identity
        let result = AXUIElementPerformAction(item, kAXPressAction as CFString)
        NativeInputDiagnostics.record("nativeMenu.press", ["command": character, "result": result.rawValue])
        if result == .success {
            let canRecover = controlEnabled && window?.firstResponder === self
                && identity == menuIdentity && tab?.runningPID == pid && tab?.selectedWindowID == windowID
            // Release old modifiers before waiting for another keystroke.
            // Later physical modifier-up must not restart a failed session.
            releaseInput(preserveMenuTransaction: true)
            if canRecover, let menuIdentity {
                pendingMenuRefocus = (pid, windowID, menuIdentity)
            }
            reportInputIssue(nil)
        }
        else { reportInputIssue("原应用未能执行编辑菜单命令（\(result.rawValue)）。请在外部应用中检查菜单状态后重试。") }
        return result == .success
    }

    private func makeKeyEvent(_ event: NSEvent, down: Bool, windowID: CGWindowID) -> CGEvent? {
        // Preserve AppKit's key-equivalent character metadata and target
        // window number; a virtual key plus CGEvent flags alone is incomplete
        // for applications that match menu shortcuts through NSEvent.
        NSEvent.keyEvent(with: down ? .keyDown : .keyUp, location: .zero,
                         modifierFlags: event.modifierFlags, timestamp: event.timestamp,
                         windowNumber: Int(windowID), context: nil,
                         characters: event.characters ?? "",
                         charactersIgnoringModifiers: event.charactersIgnoringModifiers ?? "",
                         isARepeat: event.isARepeat, keyCode: event.keyCode)?.cgEvent
    }

    private func cgFlags(_ flags: NSEvent.ModifierFlags) -> CGEventFlags {
        var result: CGEventFlags = []
        if flags.contains(.shift) { result.insert(.maskShift) }
        if flags.contains(.control) { result.insert(.maskControl) }
        if flags.contains(.option) { result.insert(.maskAlternate) }
        if flags.contains(.command) { result.insert(.maskCommand) }
        if flags.contains(.capsLock) { result.insert(.maskAlphaShift) }
        if flags.contains(.function) { result.insert(.maskSecondaryFn) }
        if flags.contains(.numericPad) { result.insert(.maskNumericPad) }
        return result
    }

    /// Preserve key order while AppKit initializes its menu asynchronously.
    /// Pointer changes and focus/lifecycle changes cancel instead of replaying
    /// an old edit against a new selection. The queue exists only in memory.
    private func queueMenuInput(_ input: @escaping () -> Void) -> Bool {
        guard menuTransaction != nil else { return false }
        guard queuedMenuInputs.count < 64 else {
            cancelMenuTransaction()
            reportInputIssue("原应用的编辑菜单响应过慢，后续输入已取消，请重试。")
            return true
        }
        queuedMenuInputs.append(input)
        NativeInputDiagnostics.record("nativeMenu.queued", ["count": queuedMenuInputs.count])
        return true
    }

    private func cancelMenuTransaction() {
        guard let transaction = menuTransaction else { return }
        menuTransactionTask?.cancel()
        finishMenuTransaction(token: transaction.token, replay: false)
    }

    private func finishMenuTransaction(token: UUID, replay: Bool) {
        guard let transaction = menuTransaction, transaction.token == token else { return }
        menuTransaction = nil
        menuTransactionTask = nil
        let inputs = queuedMenuInputs
        queuedMenuInputs.removeAll()
        // Clear ownership before AXCancel: callbacks cannot cancel a newly
        // opened menu, and a stale Task's defer cannot touch another session.
        var owner: pid_t = 0
        if AXUIElementGetPid(transaction.menu, &owner) == .success, owner == transaction.pid {
            let result = AXUIElementPerformAction(transaction.menu, kAXCancelAction as CFString)
            NativeInputDiagnostics.record("nativeMenu.cancel", ["result": result.rawValue])
        }
        guard replay, identity == transaction.identity, tab?.isVisible == true,
              controlEnabled, window?.firstResponder === self else {
            releaseHeldInput()
            return
        }
        if !inputs.isEmpty {
            recoverMenuFocusIfNeeded()
            guard keyboardTarget() != nil else { return }
        }
        for input in inputs {
            if !queueMenuInput(input) { input() }
        }
    }

    func releaseInput(preserveMenuTransaction: Bool = false) {
        if !preserveMenuTransaction { cancelMenuTransaction() }
        NativeInputDiagnostics.record("releaseInput", ["contextPending": contextMenuTarget != nil])
        scrollAccumulator.reset()
        contextMenuTarget = nil
        consumedContextClick = false
        pendingMenuRefocus = nil
        keyboardTargetIdentity = nil
        focusedWindow = nil
        reportInputIssue(nil)
        releaseHeldInput()
    }

    private func releaseHeldInput() {
        guard let (pid, windowID) = heldTarget, AXIsProcessTrusted(), CGPreflightPostEventAccess(),
              NSRunningApplication(processIdentifier: pid)?.isTerminated == false,
              let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]])?.first,
              (info[kCGWindowOwnerPID as String] as? Int) == Int(pid) else {
            heldButtons.removeAll(); heldButtonFlags.removeAll(); heldKeys.removeAll(); sentFlags = []
            heldTarget = nil
            return
        }
        for button in heldButtons {
            let type: CGEventType = button == .left ? .leftMouseUp : (button == .right ? .rightMouseUp : .otherMouseUp)
            if let frame = currentWindowFrame(windowID, pid: pid),
               let event = makePointerEvent(type: type, button: button, windowID: windowID, frame: frame, point: lastPoint,
                                            flags: heldButtonFlags[button] ?? pointerFlags([], pid: pid), clickCount: 1, pressure: 0) {
                send(event, pid: pid, windowID: windowID)
            }
        }
        for key in heldKeys {
            if let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false) {
                send(event, pid: pid, windowID: windowID)
            }
        }
        if !sentFlags.isEmpty, let event = CGEvent(keyboardEventSource: source, virtualKey: 56, keyDown: false) {
            event.type = .flagsChanged
            event.flags = []
            send(event, pid: pid, windowID: windowID)
        }
        heldButtons.removeAll()
        heldButtonFlags.removeAll()
        heldKeys.removeAll()
        sentFlags = []
        heldTarget = nil
    }

    // MARK: NSTextInputClient — local composition, committed text to target

    func insertText(_ string: Any, replacementRange: NSRange) {
        let text = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
        if queueMenuInput({ [weak self] in self?.insertText(text, replacementRange: replacementRange) }) { return }
        recoverMenuFocusIfNeeded()
        NativeInputDiagnostics.record("insertText", ["length": text.utf16.count, "replacementLength": replacementRange.length])
        markedText = NSAttributedString(string: "")
        guard !text.isEmpty else { needsDisplay = true; return }
        // A grapheme is kept intact, including surrogate pairs and combining
        // sequences; no pasteboard is read or replaced.
        for character in text {
            guard let (pid, windowID) = keyboardTarget() else { break }
            let utf16 = Array(String(character).utf16)
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else { continue }
            utf16.withUnsafeBufferPointer { buffer in
                guard let base = buffer.baseAddress else { return }
                down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
                up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
            }
            send(down, pid: pid, windowID: windowID)
            send(up, pid: pid, windowID: windowID)
        }
        needsDisplay = true
    }

    override func doCommand(by selector: Selector) {
        if selector == #selector(NSResponder.cancelOperation(_:)), hasMarkedText() {
            markedText = NSAttributedString(string: "")
            markedSelection = NSRange(location: 0, length: 0)
            inputContext?.discardMarkedText()
            needsDisplay = true
            return
        }
        guard let event = interpretingEvent else { return }
        forwardKey(event, down: true)
    }

    func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        let text = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
        NativeInputDiagnostics.record("setMarkedText", ["length": text.utf16.count])
        markedText = NSAttributedString(string: text, attributes: [.foregroundColor: NSColor.labelColor, .underlineStyle: NSUnderlineStyle.single.rawValue, .font: NSFont.systemFont(ofSize: 14)])
        markedSelection = selectedRange
        needsDisplay = true
    }

    func unmarkText() {
        // Confirmed composition arrives through insertText. Focus loss and
        // discardMarkedText may unmark too; those must not type pending text
        // into a target while the user is closing or switching Hub tabs.
        markedText = NSAttributedString(string: "")
        markedSelection = NSRange(location: 0, length: 0)
        needsDisplay = true
    }
    func selectedRange() -> NSRange { hasMarkedText() ? markedSelection : NSRange(location: 0, length: 0) }
    func markedRange() -> NSRange { hasMarkedText() ? NSRange(location: 0, length: markedText.length) : NSRange(location: NSNotFound, length: 0) }
    func hasMarkedText() -> Bool { markedText.length > 0 }
    func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? {
        guard range.location != NSNotFound, range.location <= markedText.length else { return nil }
        let valid = NSIntersectionRange(range, NSRange(location: 0, length: markedText.length))
        actualRange?.pointee = valid
        return markedText.attributedSubstring(from: valid)
    }
    func validAttributesForMarkedText() -> [NSAttributedString.Key] { [.underlineStyle, .foregroundColor, .font] }
    func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        actualRange?.pointee = range
        let local = CGRect(x: lastLocalPoint.x, y: lastLocalPoint.y, width: 1, height: 18)
        return window?.convertToScreen(convert(local, to: nil)) ?? .zero
    }
    func characterIndex(for point: NSPoint) -> Int { 0 }
}
