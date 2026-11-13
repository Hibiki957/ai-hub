// 手动构建用：替代 SwiftPM 自动生成的 Bundle.module 访问器。
// 资源 bundle 按既有布局放在 .app 根目录（与此前 SwiftPM 产物一致）。
import Foundation

private final class GhosttyBundleFinder {}

extension Foundation.Bundle {
    static let module: Bundle = {
        let name = "GhosttyKit_GhosttyTerminal"
        let candidates: [URL] = [
            Bundle.main.bundleURL,
            Bundle(for: GhosttyBundleFinder.self).resourceURL,
            Bundle.main.resourceURL,
            Bundle.main.bundleURL.appendingPathComponent("Contents/Resources"),
        ].compactMap { $0 }
        for candidate in candidates {
            let bundleURL = candidate.appendingPathComponent("\(name).bundle")
            if let bundle = Bundle(url: bundleURL) {
                return bundle
            }
        }
        fatalError("unable to find bundle named \(name)")
    }()
}
