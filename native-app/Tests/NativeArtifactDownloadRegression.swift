import Foundation

@main
struct NativeArtifactDownloadRegression {
    static func main() {
        let base = URL(string: "http://127.0.0.1:18787/")!
        let policy = NativeArtifactDownloadPolicy(baseURL: base)
        let path = "/api/tasks/task-123/artifacts/artifact_456/download"
        precondition(policy.allows(URL(string: "http://127.0.0.1:18787" + path)!))
        for candidate in [
            "http://127.0.0.1:18788" + path, "https://127.0.0.1:18787" + path,
            "http://localhost:18787" + path, "http://127.0.0.1.evil.invalid:18787" + path,
            "http://user:password@127.0.0.1:18787" + path,
            "http://127.0.0.1:18787" + path + "?token=fixture", "http://127.0.0.1:18787" + path + "#fragment",
            "http://127.0.0.1:18787/api/tasks/task-123/artifacts/artifact_456/preview",
            "http://127.0.0.1:18787/api/tasks/task-123/artifacts/artifact_456/download/",
            "http://127.0.0.1:18787/api/tasks/task%2F123/artifacts/artifact_456/download",
            "http://127.0.0.1:18787/api/tasks/../artifacts/artifact_456/download",
            "http://127.0.0.1:18787/api/tasks/task-123/artifacts/%2e%2e/download",
            "http://127.0.0.1:18787/api/tasks/task-123/artifacts/artifact_456/download%0A",
            "blob:http://127.0.0.1:18787/fixture", "data:text/plain,fixture", "file:///tmp/fixture"
        ] { precondition(!policy.allows(URL(string: candidate)!), "Unexpected download route admitted") }
        precondition(NativeArtifactDownloadPolicy(baseURL: URL(string: "https://hub.example/")!).allows(URL(string: "https://hub.example:443" + path)!))
        precondition(NativeArtifactDownloadPolicy.suggestedFilename("../../report.md") == "report.md")
        precondition(NativeArtifactDownloadPolicy.suggestedFilename("folder\\结果.md") == "结果.md")
        precondition(NativeArtifactDownloadPolicy.suggestedFilename("../..") == "artifact")
        precondition(NativeArtifactDownloadPolicy.suggestedFilename("file\n\r\0.md") == "file.md")
        precondition(NativeArtifactDownloadPolicy.suggestedFilename("").count > 0)
        print("Native artifact download policy: 23 checks passed (URL/filename only; no WebKit/UI/network/file writes)")
    }
}
