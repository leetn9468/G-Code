// swift-tools-version: 6.2
// G-Code's own MLX inference server. MLXLMCommon and MLXLLM live in Vendor/ so they can be changed
// here, as does MLX; the tokenizer stays a pinned package. Build with xcodebuild, not `swift build`:
// SwiftPM cannot compile MLX's Metal shaders (see desktop/scripts/build-mlx-runtime.py).
import PackageDescription

let mlx: [Target.Dependency] = [
    .product(name: "MLX", package: "mlx-swift"),
    .product(name: "MLXNN", package: "mlx-swift"),
    .product(name: "MLXOptimizers", package: "mlx-swift"),
]

let package = Package(
    name: "gcode-mlx-server",
    platforms: [.macOS(.v15)],
    products: [.executable(name: "gcode-mlx-server", targets: ["gcode-mlx-server"])],
    dependencies: [
        .package(path: "Vendor/mlx-swift"),
        .package(url: "https://github.com/huggingface/swift-transformers", exact: "1.4.0"),
    ],
    targets: [
        .target(name: "MLXLMCommon", dependencies: mlx, path: "Vendor/mlx-swift-lm/MLXLMCommon"),
        .target(name: "MLXLLM", dependencies: ["MLXLMCommon"] + mlx, path: "Vendor/mlx-swift-lm/MLXLLM"),
        .target(name: "MLXServerKit", dependencies: ["MLXLMCommon"], path: "Sources/MLXServerKit", swiftSettings: [.swiftLanguageMode(.v5)]),
        .executableTarget(
            name: "gcode-mlx-server",
            dependencies: ["MLXServerKit", "MLXLLM", "MLXLMCommon", .product(name: "Tokenizers", package: "swift-transformers")] + mlx,
            path: "Sources/gcode-mlx-server",
            swiftSettings: [.swiftLanguageMode(.v5)]),
    ]
)
