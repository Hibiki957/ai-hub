import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// The row itself handles clicks and local reordering. No separate drag grip
/// or system pasteboard session is needed for moving items within the sidebar.
struct SidebarDragSurface: NSViewRepresentable {
    let value: String
    let type: UTType
    let label: String
    var trailingControlsWidth: CGFloat = 0
    var dropActions: [String: (String) -> Void] = [:]
    var afterDropActions: [String: (String) -> Void] = [:]
    var targetedAfter: (Bool) -> Void = { _ in }
    var targeted: (Bool) -> Void = { _ in }
    let activate: () -> Void

    func makeNSView(context: Context) -> SurfaceView { SurfaceView() }
    func updateNSView(_ view: SurfaceView, context: Context) {
        view.value = value
        view.dragType = type.identifier
        view.trailingControlsWidth = trailingControlsWidth
        view.activate = activate
        view.dropActions = dropActions
        view.targeted = targeted
        view.afterDropActions = afterDropActions
        view.targetedAfter = targetedAfter
    }

    final class SurfaceView: NSView {
        private static let surfaces = NSHashTable<SurfaceView>.weakObjects()
        var value = ""
        var dragType = ""
        var trailingControlsWidth: CGFloat = 0
        var activate: (() -> Void)?
        var dropActions: [String: (String) -> Void] = [:]
        var afterDropActions: [String: (String) -> Void] = [:]
        var targetedAfter: (Bool) -> Void = { _ in }
        var targeted: (Bool) -> Void = { _ in }
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override func isAccessibilityElement() -> Bool { false }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if window != nil { Self.surfaces.add(self) }
            else { Self.surfaces.remove(self) }
        }
        override func hitTest(_ point: NSPoint) -> NSView? {
            if let type = NSApp.currentEvent?.type,
               [.rightMouseDown, .rightMouseUp, .rightMouseDragged].contains(type) { return nil }
            let local = convert(point, from: superview)
            guard bounds.contains(local), local.x < bounds.width - trailingControlsWidth else { return nil }
            return self
        }
        private func destination(at point: NSPoint) -> SurfaceView? {
            Self.surfaces.allObjects.first { candidate in
                candidate.window === window && !candidate.isHiddenOrHasHiddenAncestor
                    && candidate.dropActions[dragType] != nil
                    && candidate.bounds.contains(candidate.convert(point, from: nil))
            }
        }
        override func mouseDown(with event: NSEvent) {
            guard let window else { return }
            let origin = event.locationInWindow
            var dragging = false
            var target: SurfaceView?
            defer {
                target?.targeted(false)
                if dragging { NSCursor.pop() }
            }
            while let next = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp, .keyDown],
                                               until: .distantFuture, inMode: .eventTracking, dequeue: true) {
                if next.type == .keyDown {
                    if next.keyCode == 53 { return }
                    continue
                }
                let point = next.locationInWindow
                if next.type == .leftMouseUp {
                    if dragging {
                        if let destination = destination(at: point) {
                            let after = convert(bounds, to: nil).midY > destination.convert(destination.bounds, to: nil).midY
                            let action = (after ? destination.afterDropActions[dragType] : nil) ?? destination.dropActions[dragType]
                            let draggedValue = value
                            DispatchQueue.main.async { action?(draggedValue) }
                        }
                    } else if bounds.contains(convert(point, from: nil)) { activate?() }
                    return
                }
                if !dragging, hypot(point.x - origin.x, point.y - origin.y) >= 5 {
                    dragging = true
                    NSCursor.closedHand.push()
                }
                if dragging {
                    enclosingScrollView?.contentView.autoscroll(with: next)
                    let destination = destination(at: point)
                    if target !== destination {
                        target?.targeted(false)
                        target = destination
                        if let target {
                            target.targetedAfter(convert(bounds, to: nil).midY > target.convert(target.bounds, to: nil).midY)
                            target.targeted(true)
                        }
                    }
                }
            }
        }
    }
}
