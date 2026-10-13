// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "WatsonCore", platforms: [.macOS(.v13), .iOS(.v17)], products: [.library(name: "WatsonCore", targets: ["WatsonCore"])], targets: [.target(name: "WatsonCore", path: "Watson/Core"), .testTarget(name: "WatsonCoreTests", dependencies: ["WatsonCore"], path: "WatsonTests")])
