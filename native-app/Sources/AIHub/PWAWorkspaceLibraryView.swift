import SwiftUI

/// Both entry points share the same app library and personal inventory.
struct PWAWorkspaceLibraryView: View {
    var body: some View { ToolLauncherView(webOnly: true) }
}
