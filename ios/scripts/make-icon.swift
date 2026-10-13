import AppKit
import Foundation
let canvas = NSSize(width: 1024, height: 1024)
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 3, hasAlpha: false, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 3072, bitsPerPixel: 24)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor(calibratedRed: 0.45, green: 0.30, blue: 0.87, alpha: 1).setFill()
NSBezierPath(rect: NSRect(origin: .zero, size: canvas)).fill()
NSColor.white.setStroke()
let wave = NSBezierPath()
wave.lineWidth = 62; wave.lineCapStyle = .round; wave.lineJoinStyle = .round
wave.move(to: NSPoint(x: 230, y: 570))
wave.line(to: NSPoint(x: 320, y: 320))
wave.line(to: NSPoint(x: 435, y: 650))
wave.line(to: NSPoint(x: 550, y: 320))
wave.line(to: NSPoint(x: 680, y: 650))
wave.stroke()
NSColor.white.setFill()
NSBezierPath(ovalIn: NSRect(x: 742, y: 620, width: 70, height: 70)).fill()
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
