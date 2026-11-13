import AppKit
import SwiftUI

/// Registered from WindowGroup content, never from global key-window events.
struct WorkspaceWindowRegistration: NSViewRepresentable {
    let onWindow: (NSWindow) -> Void

    func makeNSView(context: Context) -> WorkspaceWindowRegistrationView {
        let view = WorkspaceWindowRegistrationView()
        view.onWindow = onWindow
        return view
    }

    func updateNSView(_ view: WorkspaceWindowRegistrationView, context: Context) {
        view.onWindow = onWindow
    }
}

final class WorkspaceWindowRegistrationView: NSView {
    var onWindow: ((NSWindow) -> Void)?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let window { onWindow?(window) }
    }
}
