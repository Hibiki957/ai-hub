import AppKit
import Combine
import CoreImage
import CoreMedia
import CoreVideo
import ScreenCaptureKit

struct NativeAppWindow: Identifiable, Equatable {
    let windowID: CGWindowID
    let title: String
    let frame: CGRect
    var id: CGWindowID { windowID }
}

/// A live view of an independently running application. Hub owns the stream,
/// never the application's process or documents.
@MainActor
final class NativeAppTab: ObservableObject, Identifiable {
    enum State: Equatable {
        case idle, launching, needsScreenRecording, connecting, streaming
        case paused, noWindows, appExited, failed
    }

    let id = UUID()
    let appPath: String
    let appName: String
    @Published private(set) var windows: [NativeAppWindow] = []
    @Published private(set) var selectedWindowID: CGWindowID?
    @Published private(set) var image: CGImage?
    @Published private(set) var state: State = .idle
    @Published private(set) var errorMessage: String?
    @Published private(set) var runningPID: pid_t?
    @Published private(set) var userPaused = false

    var selectedWindowFrame: CGRect? { windows.first { $0.id == selectedWindowID }?.frame }
    var title: String { appName }
    var isVisible: Bool { visible }
    var isClosed: Bool { closed }

    private var application: NSRunningApplication?
    private var shareableWindows: [CGWindowID: SCWindow] = [:]
    private var visible = false
    private var closed = false
    private static var screenCaptureConsent = NativeScreenCaptureConsent()
    private static let authorizationPendingMessage = "系统授权尚未对当前 Hub 进程生效。若录屏开关已经打开，请退出并重新打开 Hub，无需重复批准。"
    /// CoreGraphics preflight is only an initial hint. An explicit retry may
    /// ask the real ScreenCaptureKit API once; its result owns this session.
    /// A denial never retries from the periodic window monitor.
    private enum CaptureAccess {
        case preflightOnly, explicitAttempt, confirmed, declined
    }
    private var captureAccess: CaptureAccess = .preflightOnly
    private var mayAttemptCapture: Bool {
        switch captureAccess {
        case .preflightOnly: return !Self.screenCaptureConsent.deniedInThisProcess && CGPreflightScreenCaptureAccess()
        case .explicitAttempt, .confirmed: return true
        case .declined: return false
        }
    }
    private var stream: SCStream?
    private var output: NativeWindowCaptureOutput?
    private var capturedWindowID: CGWindowID?
    private var capturedSize = CGSize.zero
    private var generation = 0
    private var openTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var monitoringTask: Task<Void, Never>?
    private var streamTask: Task<Void, Never>?
    private var firstFrameTask: Task<Void, Never>?
    private var terminationObserver: NSObjectProtocol?
    private let captureQueue = DispatchQueue(label: "AIHub.native-window.frames", qos: .userInteractive)

    init(appPath: String, appName: String) {
        self.appPath = URL(fileURLWithPath: appPath).resolvingSymlinksInPath().standardizedFileURL.path
        self.appName = appName
        terminationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main
        ) { [weak self] notification in
            guard let terminated = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            Task { @MainActor [weak self] in
                guard let self, self.runningPID == terminated.processIdentifier else { return }
                self.targetExited()
            }
        }
    }

    func open() {
        guard !closed, openTask == nil else { return }
        errorMessage = nil
        state = .launching
        openTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.openTask = nil }
            do {
                guard FileManager.default.fileExists(atPath: self.appPath) else {
                    throw NativeCaptureFailure("应用入口不存在，请在工具配置中更新路径。")
                }
                let existing = NSWorkspace.shared.runningApplications.first {
                    $0.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path == self.appPath && !$0.isTerminated
                }
                let app: NSRunningApplication
                if let existing { app = existing }
                else {
                    let configuration = NSWorkspace.OpenConfiguration()
                    configuration.activates = false
                    configuration.createsNewApplicationInstance = false
                    app = try await NSWorkspace.shared.openApplication(
                        at: URL(fileURLWithPath: self.appPath), configuration: configuration
                    )
                }
                guard !self.closed, !Task.isCancelled else { return }
                guard app.processIdentifier != ProcessInfo.processInfo.processIdentifier else {
                    throw NativeCaptureFailure("不能将 AI Hub 自己的窗口嵌入自身。")
                }
                self.application = app
                self.runningPID = app.processIdentifier
                guard self.mayAttemptCapture else {
                    self.state = .needsScreenRecording
                    return
                }
                // Newly launched apps may publish their first window after launch returns.
                for attempt in 0..<16 {
                    guard !self.closed, !Task.isCancelled, !app.isTerminated else { return }
                    try await self.enumerateWindows()
                    if !self.windows.isEmpty { break }
                    if attempt < 15 { try await Task.sleep(nanoseconds: 250_000_000) }
                }
                guard !self.closed, !Task.isCancelled else { return }
                self.scheduleCapture()
                self.beginMonitoring()
            } catch is CancellationError {
                return
            } catch {
                guard !self.closed else { return }
                self.report(error)
            }
        }
    }

    func refreshWindows() {
        guard !closed, refreshTask == nil, openTask == nil else { return }
        // A failed/declined session waits for the explicit Retry action. A
        // visibility change or the two-second monitor must not re-prompt.
        guard state != .failed, state != .needsScreenRecording else { return }
        guard application?.isTerminated == false else { targetExited(); return }
        guard mayAttemptCapture else {
            state = .needsScreenRecording
            scheduleCapture()
            return
        }
        refreshTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.refreshTask = nil }
            do {
                try await self.enumerateWindows()
                guard !self.closed, !Task.isCancelled else { return }
                self.scheduleCapture()
            } catch is CancellationError {
                return
            } catch {
                guard !self.closed else { return }
                self.report(error)
            }
        }
    }

    func retry() {
        guard !closed, openTask == nil, refreshTask == nil else { return }
        // Reopening the independent app is still allowed while capture awaits
        // authorization. Launching it must not consume another consent attempt.
        if application?.isTerminated != false || runningPID == nil {
            if captureAccess != .confirmed || Self.screenCaptureConsent.deniedInThisProcess {
                captureAccess = .preflightOnly
            }
            errorMessage = nil
            open()
            return
        }
        guard captureAccess == .confirmed || Self.screenCaptureConsent.allowAttempt(preflightAllowed: CGPreflightScreenCaptureAccess()) else {
            waitForScreenRecordingAuthorization()
            return
        }
        beginExplicitCaptureAttempt()
    }

    private func beginExplicitCaptureAttempt() {
        captureAccess = .explicitAttempt
        errorMessage = nil
        if application?.isTerminated == false, runningPID != nil {
            state = .connecting
            refreshWindows()
            beginMonitoring()
        } else { open() }
    }

    func selectWindow(_ id: CGWindowID) {
        guard !closed, windows.contains(where: { $0.id == id }), selectedWindowID != id else { return }
        selectedWindowID = id
        image = nil
        errorMessage = nil
        state = .connecting
        scheduleCapture()
    }

    func setVisible(_ visible: Bool) {
        guard !closed, self.visible != visible else { return }
        self.visible = visible
        scheduleCapture()
        if visible {
            if application?.isTerminated == false { refreshWindows(); beginMonitoring() }
        } else {
            monitoringTask?.cancel()
            monitoringTask = nil
        }
    }

    func setUserPaused(_ paused: Bool) {
        guard !closed, userPaused != paused else { return }
        userPaused = paused
        scheduleCapture()
    }

    func requestScreenRecording() {
        guard !closed, openTask == nil, refreshTask == nil else { return }
        let allowed = CGPreflightScreenCaptureAccess()
        guard Self.screenCaptureConsent.allowAttempt(preflightAllowed: allowed) else {
            waitForScreenRecordingAuthorization()
            openScreenRecordingSettings()
            return
        }
        if allowed || CGRequestScreenCaptureAccess() { beginExplicitCaptureAttempt() }
        else { waitForScreenRecordingAuthorization() }
    }

    private func waitForScreenRecordingAuthorization() {
        state = .needsScreenRecording
        errorMessage = Self.authorizationPendingMessage
    }

    func openScreenRecordingSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(url)
        }
    }

    func openExternally() {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: appPath), configuration: configuration) { _, _ in }
    }

    /// Closing a tab releases capture only. Never send terminate, close-window,
    /// or document commands to the independent application.
    func close() {
        guard !closed else { return }
        closed = true
        visible = false
        openTask?.cancel(); openTask = nil
        refreshTask?.cancel(); refreshTask = nil
        monitoringTask?.cancel(); monitoringTask = nil
        firstFrameTask?.cancel(); firstFrameTask = nil
        if let terminationObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(terminationObserver)
            self.terminationObserver = nil
        }
        image = nil
        scheduleCapture()
    }

    private func enumerateWindows() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        guard !closed, !Task.isCancelled, let pid = runningPID else { return }
        guard application?.isTerminated == false else { targetExited(); return }
        // A successful real SCK request supersedes a stale CoreGraphics
        // preflight result. Later SCK permission errors revoke confirmation.
        captureAccess = .confirmed
        let candidates = content.windows.filter {
            $0.owningApplication?.processID == pid && $0.windowLayer == 0 && $0.frame.width > 32 && $0.frame.height > 32
        }.sorted {
            if $0.isOnScreen != $1.isOnScreen { return $0.isOnScreen }
            return $0.windowID < $1.windowID
        }
        shareableWindows = Dictionary(uniqueKeysWithValues: candidates.map { ($0.windowID, $0) })
        let updated = candidates.enumerated().map { index, window in
            let title = window.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return NativeAppWindow(windowID: window.windowID,
                                   title: title.isEmpty ? "\(appName) · 窗口 \(index + 1)" : title,
                                   frame: window.frame)
        }
        if windows != updated { windows = updated }
        if !windows.contains(where: { $0.id == selectedWindowID }) {
            selectedWindowID = windows.first?.id
            image = nil
        }
        if windows.isEmpty { state = .noWindows }
    }

    private func beginMonitoring() {
        guard visible, !closed, monitoringTask == nil,
              state != .failed, state != .needsScreenRecording, mayAttemptCapture else { return }
        monitoringTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
                guard let self, !self.closed, self.visible else { return }
                if self.application?.isTerminated != false { self.targetExited(); return }
                // Refresh discovers new windows and keeps input coordinates aligned
                // after the external window is moved or resized.
                self.refreshWindows()
            }
        }
    }

    private func targetExited() {
        guard !closed else { return }
        application = nil
        runningPID = nil
        windows = []
        shareableWindows = [:]
        selectedWindowID = nil
        image = nil
        state = .appExited
        errorMessage = nil
        monitoringTask?.cancel(); monitoringTask = nil
        scheduleCapture()
    }

    /// Serialize asynchronous stop/start operations. An obsolete start is
    /// explicitly stopped before a newer one is allowed to take ownership.
    private func scheduleCapture() {
        generation += 1
        let requestedGeneration = generation
        let previous = streamTask
        streamTask = Task { @MainActor [weak self] in
            await previous?.value
            guard let self, requestedGeneration == self.generation else { return }
            await self.reconcileCapture(generation: requestedGeneration)
        }
    }

    private func reconcileCapture(generation expected: Int) async {
        let window = selectedWindowID.flatMap { shareableWindows[$0] }
        let wantsStream = !closed && visible && !userPaused && runningPID != nil &&
            application?.isTerminated == false && window != nil &&
            state != .failed && state != .needsScreenRecording && mayAttemptCapture
        if !wantsStream {
            firstFrameTask?.cancel(); firstFrameTask = nil
            let oldStream = stream
            stream = nil; output = nil; capturedWindowID = nil; capturedSize = .zero
            try? await oldStream?.stopCapture()
            guard expected == generation, !closed else { return }
            if state == .failed || state == .needsScreenRecording { return }
            if !mayAttemptCapture, runningPID != nil { state = .needsScreenRecording }
            else if runningPID == nil {
                if state != .launching && state != .idle && state != .failed { state = .appExited }
            } else if window == nil { state = .noWindows }
            else { state = .paused }
            return
        }
        guard let window else { return }
        let configuration = captureConfiguration(window: window)
        let size = CGSize(width: configuration.width, height: configuration.height)
        if let stream, capturedWindowID == window.windowID {
            if size != capturedSize {
                do {
                    try await stream.updateConfiguration(configuration)
                    guard expected == generation else { return }
                    capturedSize = size
                } catch { report(error) }
            }
            return
        }
        let oldStream = stream
        firstFrameTask?.cancel(); firstFrameTask = nil
        stream = nil; output = nil; capturedWindowID = nil
        try? await oldStream?.stopCapture()
        guard expected == generation, !closed, visible, !userPaused else { return }
        state = .connecting
        errorMessage = nil
        let sink = NativeWindowCaptureOutput()
        let newStream = SCStream(filter: SCContentFilter(desktopIndependentWindow: window),
                                 configuration: configuration, delegate: sink)
        sink.onFrame = { [weak self, weak newStream] image in
            guard let self, let newStream, self.stream === newStream,
                  self.capturedWindowID == self.selectedWindowID,
                  !self.closed, self.visible, !self.userPaused,
                  self.state != .failed, self.state != .needsScreenRecording else { return }
            self.image = image
            self.state = .streaming
            self.firstFrameTask?.cancel(); self.firstFrameTask = nil
        }
        sink.onStop = { [weak self, weak newStream] error in
            guard let self, let newStream, self.stream === newStream, !self.closed else { return }
            self.stream = nil
            self.output = nil
            self.capturedWindowID = nil
            if self.application?.isTerminated != false { self.targetExited() }
            else { self.report(error) }
        }
        do {
            try newStream.addStreamOutput(sink, type: .screen, sampleHandlerQueue: captureQueue)
            stream = newStream
            output = sink
            capturedWindowID = window.windowID
            capturedSize = size
            try await newStream.startCapture()
            if expected != generation || closed || !visible || userPaused {
                if stream === newStream { stream = nil; output = nil; capturedWindowID = nil }
                try? await newStream.stopCapture()
            } else if state == .connecting {
                firstFrameTask = Task { @MainActor [weak self, weak newStream] in
                    do { try await Task.sleep(nanoseconds: 8_000_000_000) } catch { return }
                    guard let self, let newStream, self.stream === newStream,
                          !self.closed, self.visible, !self.userPaused, self.state == .connecting else { return }
                    self.report(NativeCaptureFailure("尚未收到窗口画面。请在外部恢复该应用窗口，再点重试；受保护的窗口可能不允许捕获。"))
                }
            }
        } catch {
            if stream === newStream { stream = nil; output = nil; capturedWindowID = nil }
            guard expected == generation, !closed else { return }
            report(error)
        }
    }

    private func captureConfiguration(window: SCWindow) -> SCStreamConfiguration {
        let config = SCStreamConfiguration()
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let scale: CGFloat
        if #available(macOS 14.0, *) { scale = CGFloat(filter.pointPixelScale) }
        else { scale = NSScreen.screens.map(\.backingScaleFactor).max() ?? 2 }
        // Preserve Retina detail while bounding very large windows' memory use.
        let proposed = CGSize(width: window.frame.width * max(1, scale), height: window.frame.height * max(1, scale))
        let limitScale = min(1, 4096 / max(proposed.width, proposed.height, 1))
        config.width = max(2, Int((proposed.width * limitScale).rounded()))
        config.height = max(2, Int((proposed.height * limitScale).rounded()))
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.queueDepth = 3
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = false
        config.capturesAudio = false
        config.scalesToFit = true
        if #available(macOS 14.0, *) {
            config.ignoreShadowsSingleWindow = true
            config.captureResolution = .best
            config.preservesAspectRatio = true
        }
        return config
    }

    private func report(_ error: Error) {
        let nsError = error as NSError
        // SDK SCError.h: userDeclined (-3801) specifically means the user did
        // not authorize capture. Missing entitlements, connection failures,
        // and other SCK errors retain their real diagnostic and Retry path.
        if nsError.domain == SCStreamErrorDomain && nsError.code == SCStreamError.Code.userDeclined.rawValue {
            captureAccess = .declined
            Self.screenCaptureConsent.recordDenial()
            waitForScreenRecordingAuthorization()
        } else {
            state = .failed
            errorMessage = nsError.domain == SCStreamErrorDomain
                ? "\(error.localizedDescription)（\(nsError.domain) \(nsError.code)）"
                : error.localizedDescription
        }
        monitoringTask?.cancel(); monitoringTask = nil
        // Prevent late frames from resetting a failure to streaming, and release
        // a stream whose enumeration/update/start failed. Retry is explicit.
        scheduleCapture()
    }

    deinit {
        openTask?.cancel()
        refreshTask?.cancel()
        monitoringTask?.cancel()
        streamTask?.cancel()
        firstFrameTask?.cancel()
        // Defensive cleanup for a view/store disappearing without close().
        // Capture is the only owned resource; never terminate the target app.
        if let stream { Task { try? await stream.stopCapture() } }
        if let terminationObserver { NSWorkspace.shared.notificationCenter.removeObserver(terminationObserver) }
    }
}

private struct NativeCaptureFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// All conversion happens on the capture queue; only complete images cross to
/// the main actor. A single pending frame bounds UI work when drawing is slow.
private final class NativeWindowCaptureOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    var onFrame: (@MainActor (CGImage) -> Void)?
    var onStop: (@MainActor (Error) -> Void)?
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let pendingLock = NSLock()
    private var pendingFrame = false

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int,
              status == SCFrameStatus.complete.rawValue,
              let buffer = sampleBuffer.imageBuffer else { return }
        pendingLock.lock()
        if pendingFrame { pendingLock.unlock(); return }
        pendingFrame = true
        pendingLock.unlock()
        let frame = CIImage(cvPixelBuffer: buffer)
        guard let image = context.createCGImage(frame, from: frame.extent) else {
            pendingLock.lock(); pendingFrame = false; pendingLock.unlock()
            return
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.onFrame?(image)
            self.pendingLock.withLock { self.pendingFrame = false }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task { @MainActor [weak self] in self?.onStop?(error) }
    }
}
