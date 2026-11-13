import AppKit

@main
struct WorkspaceWindowLifecycleRegression {
    @MainActor static func main() {
        _ = NSApplication.shared
        let lifecycle = WorkspaceWindowLifecycle()
        let workspace = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
                                 styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        workspace.isReleasedWhenClosed = false
        lifecycle.register(workspace)
        precondition(lifecycle.contains(workspace))
        precondition(workspace.delegate === lifecycle)

        let panel = NSSavePanel()
        let originalDelegate = panel.delegate
        lifecycle.register(panel)
        precondition(!lifecycle.contains(panel))
        precondition(panel.delegate === originalDelegate)
        precondition(lifecycle.windowShouldClose(panel))

        let otherWindow = NSWindow(contentRect: .zero, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        otherWindow.isReleasedWhenClosed = false
        precondition(!lifecycle.contains(otherWindow))
        precondition(otherWindow.delegate == nil)
        precondition(lifecycle.windowShouldClose(otherWindow))
        workspace.close()
        otherWindow.close()
        print("Workspace window lifecycle: 8 checks passed")
    }
}
