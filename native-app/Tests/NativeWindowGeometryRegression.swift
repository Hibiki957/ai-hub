import AppKit

@main
struct NativeWindowGeometryRegression {
    static func main() {
        func near(_ value: CGFloat, _ expected: CGFloat) -> Bool { abs(value - expected) < 0.0001 }

        // Captured Retina pixels map back into Quartz points, not pixels.
        let bounds = CGRect(x: 0, y: 0, width: 1000, height: 600)
        let rect = NativeWindowGeometry.imageRect(imageSize: CGSize(width: 1600, height: 1200), bounds: bounds)
        precondition(rect == CGRect(x: 100, y: 0, width: 800, height: 600))
        let frame = CGRect(x: -1800, y: 70, width: 800, height: 600)
        let center = NativeWindowGeometry.targetPoint(CGPoint(x: 500, y: 300), imageRect: rect, windowFrame: frame)!
        precondition(near(center.x, -1400) && near(center.y, 370), "Retina / negative display origin mapping")
        let top = NativeWindowGeometry.targetPoint(CGPoint(x: 100, y: 0), imageRect: rect, windowFrame: frame)!
        precondition(top == frame.origin, "Flipped NSView and Quartz must share top-left coordinates")

        // Black margins reject presses. Only a drag already in progress may
        // clamp to the window edge, so its matching release can be delivered.
        precondition(NativeWindowGeometry.targetPoint(CGPoint(x: 50, y: 300), imageRect: rect, windowFrame: frame) == nil)
        let outside = NativeWindowGeometry.targetPoint(CGPoint(x: 5000, y: 7000), imageRect: rect, windowFrame: frame, clamp: true)!
        precondition(outside.x <= frame.maxX && outside.y <= frame.maxY)
        let negativeDrag = NativeWindowGeometry.targetPoint(CGPoint(x: -2000, y: -2000), imageRect: rect, windowFrame: frame, clamp: true)!
        precondition(negativeDrag == frame.origin)

        // Portrait windows and nonzero view bounds retain the same invariant.
        let portraitBounds = CGRect(x: 10, y: 20, width: 600, height: 600)
        let portrait = NativeWindowGeometry.imageRect(imageSize: CGSize(width: 400, height: 800), bounds: portraitBounds)
        precondition(portrait == CGRect(x: 160, y: 20, width: 300, height: 600))
        let portraitCenter = NativeWindowGeometry.targetPoint(CGPoint(x: 310, y: 320), imageRect: portrait, windowFrame: CGRect(x: 10, y: 20, width: 200, height: 400))!
        precondition(portraitCenter == CGPoint(x: 110, y: 220))

        precondition(NativeWindowGeometry.imageRect(imageSize: .zero, bounds: bounds) == .zero)
        precondition(NativeWindowGeometry.imageRect(imageSize: CGSize(width: 800, height: 600), bounds: .zero) == .zero)
        precondition(NativeWindowGeometry.targetPoint(.zero, imageRect: .zero, windowFrame: frame) == nil)
        precondition(NativeWindowGeometry.targetPoint(.zero, imageRect: bounds, windowFrame: .zero) == nil)
        var scroll = NativeScrollAccumulator()
        var totalX: Int32 = 0, totalY: Int32 = 0
        for _ in 0..<10 {
            let delta = scroll.consume(x: 0.25, y: -0.25, precise: true)
            totalX += delta.x; totalY += delta.y
        }
        precondition(totalX == 2 && totalY == -2, "Subpixel trackpad input must accumulate on both axes")
        let remainder = scroll.consume(x: 0.5, y: -0.5, precise: true)
        precondition(remainder.x == 1 && remainder.y == -1)
        _ = scroll.consume(x: 0.75, y: 0.75, precise: true)
        scroll.reset()
        let cleared = scroll.consume(x: 0.5, y: 0.5, precise: true)
        precondition(cleared.x == 0 && cleared.y == 0, "A focus/target/gesture reset must discard the old remainder")
        let unitChanged = scroll.consume(x: 0.5, y: 0.5, precise: false)
        precondition(unitChanged.x == 0 && unitChanged.y == 0, "Pixel remainders cannot carry into line wheel events")
        let malformed = scroll.consume(x: .nan, y: .infinity, precise: false)
        precondition(malformed.x == 0 && malformed.y == 0)
        let saturated = scroll.consume(x: Double.greatestFiniteMagnitude, y: -Double.greatestFiniteMagnitude, precise: false)
        precondition(saturated.x == Int32.max && saturated.y == Int32.min)
        let afterSaturated = scroll.consume(x: 0.5, y: -0.5, precise: false)
        precondition(afterSaturated.x == 0 && afterSaturated.y == 0, "Overflow must not leave an unbounded remainder")
        print("Native window geometry and scroll: Retina, aspect-fit, portrait, negative origin, margin rejection, drag clamping, fractional accumulation, reset, unit change, and overflow checks passed.")
    }
}
