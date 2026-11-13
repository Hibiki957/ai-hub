import Foundation

/// Only the documented, non-editing Miro canvas may be a child of the Hub.
/// This does not grant REST access or authenticate a private board. In
/// particular, a child cannot turn the Hub into a general browser or download
/// surface by navigating to a board, login page or credential-bearing URL.
struct NativeWorkbenchEmbedPolicy {
    static func boardID(_ url: URL) -> String? {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "https", parts.host == "miro.com",
              parts.port == nil, parts.user == nil, parts.password == nil,
              parts.fragment == nil else { return nil }
        let pieces = parts.path.split(separator: "/", omittingEmptySubsequences: false)
        guard pieces.count == 5, pieces[0].isEmpty, pieces[1] == "app",
              pieces[2] == "live-embed", pieces[4].isEmpty else { return nil }
        let board = String(pieces[3])
        guard board.range(of: "^[A-Za-z0-9_-]{6,100}={0,2}$", options: .regularExpression) != nil else { return nil }
        let query = parts.queryItems ?? []
        guard query.count == 2 || query.count == 3,
              Set(query.map(\.name)).count == query.count,
              query.first(where: { $0.name == "embedMode" })?.value == "view_only_without_ui",
              query.first(where: { $0.name == "autoplay" })?.value == "true",
              query.allSatisfy({ ["embedMode", "autoplay", "moveToWidget"].contains($0.name) }) else { return nil }
        if let item = query.first(where: { $0.name == "moveToWidget" }) {
            guard let value = item.value,
                  value.range(of: "^[0-9]{1,32}$", options: .regularExpression) != nil else { return nil }
        }
        return board
    }

    static func allows(_ target: URL, targetIsMainFrame: Bool, source: URL?, sourceIsHub: Bool) -> Bool {
        guard !targetIsMainFrame, let board = boardID(target) else { return false }
        if sourceIsHub { return true }
        // A canvas can navigate within the same read-only board. Switching to
        // a different board must come from the explicit Hub address/selection.
        return source.flatMap(boardID) == board
    }
}
