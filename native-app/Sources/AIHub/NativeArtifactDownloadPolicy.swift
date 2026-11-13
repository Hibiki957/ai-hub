import Foundation

/// Only the Hub's verified artifact endpoint may invoke the native save panel.
/// A matching URL is necessary, not sufficient: the session also requires an
/// explicit main-frame link, a matching response and manual destination approval.
struct NativeArtifactDownloadPolicy {
    let baseURL: URL

    func allows(_ url: URL) -> Bool {
        guard let base = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              let candidate = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = candidate.scheme?.lowercased(), ["http", "https"].contains(scheme),
              scheme == base.scheme?.lowercased(),
              candidate.host?.lowercased() == base.host?.lowercased(),
              candidate.user == nil, candidate.password == nil,
              candidate.query == nil, candidate.fragment == nil else { return false }
        let port: (URLComponents) -> Int = { $0.port ?? ($0.scheme?.lowercased() == "https" ? 443 : 80) }
        guard port(candidate) == port(base) else { return false }
        // Encoded slashes, traversal, URL parameters and alternate endpoints are excluded.
        return candidate.percentEncodedPath.range(
            of: #"^/api/tasks/[A-Za-z0-9_-]+/artifacts/[A-Za-z0-9_-]+/download$"#,
            options: .regularExpression
        ) != nil
    }

    static func suggestedFilename(_ value: String) -> String {
        let last = value.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last.map(String.init) ?? ""
        let safe = String(last.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }.map(Character.init).prefix(180))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return safe.isEmpty || safe == "." || safe == ".." ? "artifact" : safe
    }
}
