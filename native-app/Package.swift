// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AIHub",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/Lakr233/libghostty-spm.git", from: "1.5.2"),
    ],
    targets: [
        .executableTarget(
            name: "AIHub",
            dependencies: [
                .product(name: "GhosttyTerminal", package: "libghostty-spm"),
            ],
            path: "Sources/AIHub",
            resources: [.copy("Resources/SidebarIcons"), .copy("Resources/Artwork"), .copy("Resources/ToolCatalog.json"), .copy("Resources/Integrations.json")]
        ),
    ],
    swiftLanguageVersions: [.v5]
)
