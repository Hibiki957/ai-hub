import AppKit
import SwiftUI

/// Stop drawing when the window is fully covered/minimized, without stopping
/// PTYs or discarding web pages. Merely losing keyboard focus is not enough.
struct WindowVisibilityObserver: NSViewRepresentable {
    let onChange: (Bool) -> Void

    func makeNSView(context: Context) -> WindowVisibilityView {
        let view = WindowVisibilityView()
        view.onChange = onChange
        return view
    }

    func updateNSView(_ view: WindowVisibilityView, context: Context) {
        view.onChange = onChange
    }
}

final class WindowVisibilityView: NSView {
    var onChange: ((Bool) -> Void)?
    private var observation: NSObjectProtocol?
    private var lastVisible: Bool?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let observation { NotificationCenter.default.removeObserver(observation) }
        observation = nil
        if let window {
            observation = NotificationCenter.default.addObserver(
                forName: NSWindow.didChangeOcclusionStateNotification, object: window, queue: .main
            ) { [weak self] _ in self?.reportVisibility() }
        }
        reportVisibility()
    }

    private func reportVisibility() {
        // Defer out of SwiftUI's update pass and read the latest window state.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let visible = self.window?.occlusionState.contains(.visible) == true
            guard visible != self.lastVisible else { return }
            self.lastVisible = visible
            self.onChange?(visible)
        }
    }

    deinit {
        if let observation { NotificationCenter.default.removeObserver(observation) }
    }
}
