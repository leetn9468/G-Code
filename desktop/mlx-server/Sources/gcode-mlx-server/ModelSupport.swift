import Foundation
import MLXLLM
import MLXLMCommon

/// Whether this server can load the model in a folder, decided from its config.json alone: the
/// architecture must be one this build registers, and the configuration must decode for it (which
/// runs the architecture's own checks). No weights are read. The app asks before it starts the
/// server (`--check-model`), so the list of architectures lives only here.
struct ModelSupport {
    let supported: Bool
    let modelType: String?
    let message: String?

    var json: [String: Any] {
        var object: [String: Any] = ["supported": supported]
        if let modelType { object["model_type"] = modelType }
        if let message { object["message"] = message }
        return object
    }

    static func unsupported(_ type: String?, _ message: String) -> ModelSupport {
        ModelSupport(supported: false, modelType: type, message: message)
    }
}

func modelSupport(_ folder: URL) async -> ModelSupport {
    guard let data = try? Data(contentsOf: folder.appendingPathComponent("config.json")) else {
        return .unsupported(nil, "This folder is not an MLX model: config.json is missing.")
    }
    guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        return .unsupported(nil, "config.json in this folder is not valid JSON.")
    }
    guard let type = object["model_type"] as? String, !type.isEmpty else {
        return .unsupported(nil, "config.json in this folder does not name a model_type.")
    }
    guard await LLMTypeRegistry.shared.contains(type) else {
        return .unsupported(type, "This model's architecture (\(type)) is not supported by G-Code's built-in MLX engine.")
    }
    do {
        _ = try await LLMTypeRegistry.shared.createModel(configuration: data, modelType: type)
        return ModelSupport(supported: true, modelType: type, message: nil)
    } catch {
        return .unsupported(type, "This model's config.json does not fit G-Code's \(type) support: \(describe(error))")
    }
}

/// `modelSupport` for synchronous callers (the `--check-model` mode on the main thread).
func modelSupportBlocking(_ folder: URL) -> ModelSupport {
    final class Box: @unchecked Sendable { var value: ModelSupport? }
    let box = Box()
    let done = DispatchSemaphore(value: 0)
    Task.detached {
        box.value = await modelSupport(folder)
        done.signal()
    }
    done.wait()
    return box.value!
}

func describe(_ error: Error) -> String {
    func path(_ context: DecodingError.Context) -> String {
        context.codingPath.map(\.stringValue).joined(separator: ".")
    }
    switch error {
    case DecodingError.dataCorrupted(let context): return context.debugDescription
    case DecodingError.keyNotFound(let key, _): return "\(key.stringValue) is missing."
    case DecodingError.typeMismatch(_, let context): return "\(path(context)) has the wrong type."
    case DecodingError.valueNotFound(_, let context): return "\(path(context)) is null."
    default: return "\(error)"
    }
}
