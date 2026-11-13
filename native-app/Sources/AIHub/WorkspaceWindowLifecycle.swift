import AppKit

/// Only windows registered by the workspace root get the keep-running behavior.
/// AppKit owns the delegates of save/open panels and their remote child windows.
@MainActor
final class WorkspaceWindowLifecycle: NSObject, NSWindowDelegate {
    private let windows = NSHashTable<NSWindow>.weakObjects()

    func register(_ window: NSWindow) {
        guard !(window is NSPanel), window.sheetParent == nil else { return }
        windows.add(window)
        window.delegate = self
    }

    func contains(_ window: NSWindow) -> Bool { windows.contains(window) }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard contains(sender) else { return true }
        sender.miniaturize(nil)
        return false
    }
}
