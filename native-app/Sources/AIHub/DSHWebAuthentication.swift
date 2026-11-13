import Foundation

/// DSH exchanges its printed, per-process launch token for a browser cookie.
/// Keep the token out of saved shortcuts, app preferences and diagnostic logs.
enum DSHWebAuthentication {
    static func loginRequest(for url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        // DSH's gzip middleware currently drops Location and Set-Cookie on
        // the 303 token exchange. Only the local login request needs this.
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        return request
    }

    static func launchURLs(in text: String, for target: URL) -> [URL] {
        guard target.scheme == "http", target.host == "127.0.0.1", target.port == 3080,
              target.user == nil, target.password == nil else { return [] }
        let pattern = #"dsh web:\s+(http://[^\s\x1b]+)"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed().compactMap { match in
            guard let range = Range(match.range(at: 1), in: text),
                  let parts = URLComponents(string: String(text[range])),
                  parts.scheme == target.scheme, parts.host == target.host, parts.port == target.port,
                  parts.user == nil, parts.password == nil, parts.fragment == nil,
                  parts.path == "/" || parts.path.isEmpty,
                  let query = parts.queryItems, query.count == 1, query[0].name == "token",
                  let token = query[0].value, !token.isEmpty, token.count <= 1024 else { return nil }
            return parts.url
        }
    }

    static func nextLaunchURL(for target: URL, excluding attempted: Set<URL>) -> URL? {
        guard target.scheme == "http", target.host == "127.0.0.1", target.port == 3080,
              target.user == nil, target.password == nil else { return nil }
        let paths = ["/tmp/dsh-web.log", NSHomeDirectory() + "/workspace/logs/dsh-launch.log"]
        let files = paths.map { URL(fileURLWithPath: $0) }.sorted {
            let left = (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            let right = (try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return left > right
        }
        for file in files {
            guard let handle = try? FileHandle(forReadingFrom: file) else { continue }
            defer { try? handle.close() }
            // Bounded reads also work with a long-running server's large log.
            guard let length = try? handle.seekToEnd() else { continue }
            try? handle.seek(toOffset: length > 1_048_576 ? length - 1_048_576 : 0)
            guard let data = try? handle.read(upToCount: 1_048_576) else { continue }
            var text = String(decoding: data, as: UTF8.self)
            if length > 1_048_576 {
                try? handle.seek(toOffset: 0)
                if let prefix = try? handle.read(upToCount: 65_536) {
                    text = String(decoding: prefix, as: UTF8.self) + "\n" + text
                }
            }
            if let url = launchURLs(in: text, for: target).prefix(4).first(where: { !attempted.contains($0) }) {
                return url
            }
        }
        return nil
    }
}
