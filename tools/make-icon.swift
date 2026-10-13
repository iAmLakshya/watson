import Foundation
import CoreGraphics
import ImageIO

// Rasterize Watson's code-authored four-bar mark for the macOS icon container.
// No external image or service is used.
let output = URL(fileURLWithPath: ".cache/Watson.iconset", isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
for (name, size) in [("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64), ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512), ("icon_512x512", 512), ("icon_512x512@2x", 1024)] {
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.scaleBy(x: CGFloat(size) / 1024, y: CGFloat(size) / 1024)
    context.setFillColor(CGColor(red: 0.47, green: 0.33, blue: 0.86, alpha: 1))
    context.addPath(CGPath(roundedRect: CGRect(x: 42, y: 42, width: 940, height: 940), cornerWidth: 205, cornerHeight: 205, transform: nil))
    context.fillPath()
    context.translateBy(x: 512, y: 512)
    context.rotate(by: -0.13)
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    for (index, height) in [280.0, 480.0, 380.0, 530.0].enumerated() {
        let rect = CGRect(x: -240 + Double(index) * 133, y: -height / 2, width: 86, height: height)
        context.addPath(CGPath(roundedRect: rect, cornerWidth: 43, cornerHeight: 43, transform: nil))
        context.fillPath()
    }
    let image = context.makeImage()!
    let file = output.appendingPathComponent(name + ".png")
    let destination = CGImageDestinationCreateWithURL(file as CFURL, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { fatalError("PNG icon could not be saved") }
}
print("Created .cache/Watson.iconset")
