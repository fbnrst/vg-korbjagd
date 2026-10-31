// Renders the app icons (macOS only): `swift scripts/make-icons.swift public/icons`
// VG green background (#669c03), light disc (#e8edde), shopping cart emoji. Re-run after changing the colours,
// then bump VERSION in public/sw.js so the new icons are picked up.
import AppKit

func color(_ hex: Int) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: 1)
}

// rounded: corners cut out (purpose "any"); disc: diameter as a fraction of the icon size
func render(size: Int, rounded: Bool, disc: CGFloat, to path: String) {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(size), rect = NSRect(x: 0, y: 0, width: s, height: s)
    if rounded { NSBezierPath(roundedRect: rect, xRadius: s * 0.22, yRadius: s * 0.22).addClip() }
    color(0x669c03).setFill(); rect.fill()
    let d = s * disc
    color(0xe8edde).setFill()
    NSBezierPath(ovalIn: NSRect(x: (s - d) / 2, y: (s - d) / 2, width: d, height: d)).fill()
    let text = NSString(string: "🛒")
    let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: d * 0.62)]
    let ts = text.size(withAttributes: attrs)
    text.draw(at: NSPoint(x: (s - ts.width) / 2, y: (s - ts.height) / 2), withAttributes: attrs)
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

let dir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "public/icons"
render(size: 192, rounded: true, disc: 0.68, to: "\(dir)/icon-192.png")
render(size: 512, rounded: true, disc: 0.68, to: "\(dir)/icon-512.png")
render(size: 512, rounded: false, disc: 0.52, to: "\(dir)/icon-maskable-512.png")   // full bleed, motif inside the safe zone
render(size: 180, rounded: false, disc: 0.64, to: "\(dir)/apple-touch-icon.png")    // iOS rounds the corners itself
print("icons written to \(dir)")
