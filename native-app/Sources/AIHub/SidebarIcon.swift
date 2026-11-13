import AppKit
import SwiftUI

/// Paths identify installed apps/PWAs and folders; CLI names resolve to a
/// matching installed application. Display-name changes do not affect icons.
enum SidebarIconSource: Hashable {
    case path(String)
    case cli(String)

    var cacheKey: String {
        switch self {
        case .path(let path): return "path:" + path
        case .cli(let name): return "cli:" + name.lowercased()
        }
    }
}

@MainActor
final class SidebarIconCache {
    static let shared = SidebarIconCache()
    private final class Entry {
        let image: NSImage?
        init(_ image: NSImage?) { self.image = image }
    }
    private let cache = NSCache<NSString, Entry>()
    private lazy var installedApps: [String: String] = {
        var apps: [String: String] = [:]
        let directories = ["/Applications", NSHomeDirectory() + "/Applications",
                           NSHomeDirectory() + "/Applications/Chrome Apps.localized",
                           "/System/Applications/Utilities"]
        for directory in directories {
            for name in ((try? FileManager.default.contentsOfDirectory(atPath: directory)) ?? []).sorted()
                where name.hasSuffix(".app") {
                let key = String(name.dropLast(4)).lowercased()
                if apps[key] == nil { apps[key] = directory + "/" + name }
            }
        }
        return apps
    }()

    private init() {
        cache.countLimit = 256
        cache.totalCostLimit = 24 * 1024 * 1024
    }

    func image(for source: SidebarIconSource, pixelSize: Int = 64) -> NSImage? {
        let outputPixels = min(512, max(64, pixelSize))
        let key = (source.cacheKey + ":pixels:\(outputPixels)") as NSString
        if let cached = cache.object(forKey: key) { return cached.image }
        let path: String?
        switch source {
        case .path(let value): path = value
        case .cli(let name):
            let aliases: [String: [String]] = [
                "claude": ["Claude"], "codex": ["Codex"],
                "grok": ["Grok", "Grok Bot"], "kimi": ["Kimi Code", "Kimi"],
                "opencode": ["OpenCode"],
                "dsh": ["DeepSeek Harness"], "hermes": ["Hermes"],
                "codebuddy": ["CodeBuddy"], "cmd": ["Command Code"],
                "qoder cli": ["Qoder IDE", "Qoder"],
                "zcode tui": ["ZCode"], "zcode-tui": ["ZCode"],
                "mimo code": ["Xiaomi MiMo"], "mimocode": ["Xiaomi MiMo"],
                "mimo": ["Xiaomi MiMo"],
                "zsh": ["Terminal"]
            ]
            path = (aliases[name.lowercased()] ?? [name]).compactMap { installedApps[$0.lowercased()] }.first
        }
        let original: NSImage?
        if let path, FileManager.default.fileExists(atPath: path) {
            original = NSWorkspace.shared.icon(forFile: path)
        } else if case .cli(let name) = source {
            original = bundledIcon(named: name.lowercased())
        } else {
            original = nil
        }
        guard let original, let image = normalizedIcon(original, pixelSize: outputPixels) else {
            cache.setObject(Entry(nil), forKey: key)
            return nil
        }
        cache.setObject(Entry(image), forKey: key, cost: outputPixels * outputPixels * 4)
        return image
    }

    private func normalizedIcon(_ original: NSImage, pixelSize: Int) -> NSImage? {
        let canvasPixels = max(128, pixelSize * 2)
        let canvasSize = CGFloat(canvasPixels)
        let outputSize = CGFloat(pixelSize)
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: canvasPixels, pixelsHigh: canvasPixels,
                  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
            return nil
        }
        // Measure visible artwork instead of the canvas: installed macOS icons
        // include padding/shadows, while website icons often fill the canvas.
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        context.imageInterpolation = .high
        let sourceScale = min(canvasSize / original.size.width, canvasSize / original.size.height)
        let sourceSize = NSSize(width: original.size.width * sourceScale, height: original.size.height * sourceScale)
        original.draw(in: NSRect(x: (canvasSize - sourceSize.width) / 2, y: (canvasSize - sourceSize.height) / 2,
                                width: sourceSize.width, height: sourceSize.height))
        NSGraphicsContext.restoreGraphicsState()

        guard let pixels = bitmap.bitmapData else { return nil }
        var minX = canvasPixels, minY = canvasPixels, maxX = -1, maxY = -1
        for y in 0..<canvasPixels {
            for x in 0..<canvasPixels where pixels[y * bitmap.bytesPerRow + x * 4 + 3] >= 48 {
                minX = min(minX, x); maxX = max(maxX, x)
                minY = min(minY, y); maxY = max(maxY, y)
            }
        }
        guard maxX >= minX, maxY >= minY,
              let output = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixelSize, pixelsHigh: pixelSize,
                  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let outputContext = NSGraphicsContext(bitmapImageRep: output),
              let cgImage = bitmap.cgImage else { return nil }
        // A 24pt visible extent inside the existing 26pt row slot. Draw the
        // entire image so antialiasing and faint shadows survive normalization.
        let scale = (outputSize * 24 / 26) / CGFloat(max(maxX - minX + 1, maxY - minY + 1))
        let centerX = CGFloat(minX + maxX + 1) / 2
        let centerY = canvasSize - CGFloat(minY + maxY + 1) / 2
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = outputContext
        outputContext.imageInterpolation = .high
        NSImage(cgImage: cgImage, size: NSSize(width: canvasSize, height: canvasSize)).draw(
            in: NSRect(x: outputSize / 2 - centerX * scale, y: outputSize / 2 - centerY * scale,
                       width: canvasSize * scale, height: canvasSize * scale))
        NSGraphicsContext.restoreGraphicsState()
        output.size = NSSize(width: 32, height: 32)
        let image = NSImage(size: output.size)
        image.addRepresentation(output)
        return image
    }

    private func bundledIcon(named name: String) -> NSImage? {
        // A fixed allowlist keeps custom CLI names out of filesystem paths.
        guard ["aider", "pi", "cmd", "codebuddy", "codex", "stepcode"].contains(name) else { return nil }
        #if SWIFT_PACKAGE
        let bundle = Bundle.module
        #else
        let bundle = Bundle.main
        #endif
        guard let url = bundle.url(forResource: name, withExtension: "png", subdirectory: "SidebarIcons") else {
            return nil
        }
        return NSImage(contentsOf: url)
    }
}

struct SidebarIcon: View {
    let name: String
    let color: Color
    let source: SidebarIconSource?
    var isRunning = false
    var badgeBackground: Color = .white

    var body: some View {
        Group {
            if let source, let icon = SidebarIconCache.shared.image(for: source) {
                Image(nsImage: icon).resizable().interpolation(.high).scaledToFit()
            } else {
                Text(String(name.prefix(1)).uppercased())
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(color)
                    .frame(width: 24, height: 24)
                    .background(RoundedRectangle(cornerRadius: 8).fill(color.opacity(0.12)))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(color.opacity(0.25), lineWidth: 1))
            }
        }
        .frame(width: 26, height: 26)
        .overlay(alignment: .bottomTrailing) {
            if isRunning {
                Circle().fill(Color(red: 34/255, green: 165/255, blue: 94/255))
                    .frame(width: 8, height: 8)
                    .overlay(Circle().stroke(badgeBackground, lineWidth: 2))
            }
        }
        .accessibilityHidden(true)
    }
}
