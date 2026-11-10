// gcode-mlx-server: G-Code's built-in MLX inference. It answers the same local API as the llama.cpp
// server G-Code runs for GGUF files (/health, /props, /slots, /apply-template, /tokenize and
// /v1/chat/completions), so the app treats both alike.
import Foundation
import MLX
import MLXLLM
import MLXLMCommon
import MLXServerKit

let usage = """
Usage: gcode-mlx-server --model <folder> --port <n> [--host 127.0.0.1] [--ctx-size <tokens>] [--alias <name>]
"""

func log(_ message: String) { FileHandle.standardError.write(Data((message + "\n").utf8)) }

func fatal(_ message: String) -> Never {
    log(message)
    exit(1)
}

var arguments = [String: String]()
var index = 1
while index < CommandLine.arguments.count {
    let name = CommandLine.arguments[index]
    if name == "--help" || name == "-h" { print(usage); exit(0) }
    guard name.hasPrefix("--"), index + 1 < CommandLine.arguments.count else { fatal("Unknown argument \(name)\n\(usage)") }
    arguments[name] = CommandLine.arguments[index + 1]
    index += 2
}
guard let modelPath = arguments["--model"], let port = arguments["--port"].flatMap(UInt16.init) else { fatal(usage) }
let host = arguments["--host"] ?? "127.0.0.1"
let contextSize = arguments["--ctx-size"].flatMap(Int.init) ?? 262_144
let alias = arguments["--alias"] ?? "local-mlx"
guard host == "127.0.0.1" || host == "localhost" || host == "::1" else { fatal("Only a loopback host is allowed.") }
let directory = URL(fileURLWithPath: modelPath, isDirectory: true)

let engineLock = NSLock()
nonisolated(unsafe) var loadedEngine: Engine?
func currentEngine() -> Engine? { engineLock.withLock { loadedEngine } }

func errorBody(_ status: Int, _ message: String, type: String, extra: [String: Any] = [:]) -> [String: Any] {
    var error: [String: Any] = ["code": status, "message": message, "type": type]
    error.merge(extra) { first, _ in first }
    return ["error": error]
}

func send(_ error: Error, to client: HTTPClient) {
    let status: Int
    let body: [String: Any]
    switch error {
    case ServerError.badRequest(let message):
        status = 400
        body = errorBody(400, message, type: "invalid_request_error")
    case ServerError.contextExceeded(let prompt, let context):
        status = 400
        body = errorBody(400, "The request (\(prompt) tokens) exceeds the available context size (\(context) tokens).", type: "exceed_context_size_error", extra: ["n_prompt_tokens": prompt, "n_ctx": context])
    case ServerError.failed(let message):
        status = 500
        body = errorBody(500, message, type: "server_error")
    default:
        status = 500
        body = errorBody(500, "\(error)", type: "server_error")
    }
    if client.hasStartedStream {
        client.sendEvent(body)
        client.finish()
    } else {
        client.respond(status: status, json: body)
    }
}

func parseJSON(_ data: Data) throws -> [String: Any] {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ServerError.badRequest("The body is not a JSON object.") }
    return object
}

func toolCallJSON(_ call: ToolCall, index: Int) -> [String: Any] {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    let arguments = (try? encoder.encode(call.function.arguments)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    return ["index": index, "id": call.id ?? "call_\(UUID().uuidString.prefix(12))", "type": "function", "function": ["name": call.function.name, "arguments": arguments]]
}

func usageFields(_ result: CompletionResult) -> [String: Any] {
    let timings: [String: Any] = ["prompt_n": result.promptTokens - result.cachedTokens, "cache_n": result.cachedTokens, "prompt_ms": result.promptMs, "predicted_n": result.completionTokens, "predicted_ms": result.predictedMs]
    let usage: [String: Any] = ["prompt_tokens": result.promptTokens, "completion_tokens": result.completionTokens, "total_tokens": result.promptTokens + result.completionTokens, "prompt_tokens_details": ["cached_tokens": result.cachedTokens]]
    return ["usage": usage, "timings": timings]
}

func runCompletion(_ engine: Engine, _ body: [String: Any], _ client: HTTPClient) {
    let id = "chatcmpl-\(UUID().uuidString.prefix(16))"
    let created = Int(Date().timeIntervalSince1970)
    let stream = body["stream"] as? Bool ?? false
    var text = ""
    var reasoning = ""
    var calls: [[String: Any]] = []
    let chunk: ([String: Any], Any) -> [String: Any] = { delta, finish in
        ["id": id, "object": "chat.completion.chunk", "created": created, "model": alias, "choices": [["index": 0, "delta": delta, "finish_reason": finish]]]
    }
    do {
        let result = try engine.complete(body, cancelled: { client.isClosed }) { part in
            if stream && !client.hasStartedStream { client.beginStream() }
            switch part {
            case .reasoning(let value):
                reasoning += value
                if stream { client.sendEvent(chunk(["reasoning_content": value], NSNull())) }
            case .text(let value):
                text += value
                if stream { client.sendEvent(chunk(["content": value], NSNull())) }
            case .toolCall(let call):
                let json = toolCallJSON(call, index: calls.count)
                calls.append(json)
                if stream { client.sendEvent(chunk(["tool_calls": [json]], NSNull())) }
            }
        }
        if result.finish == .cancelled { client.abort(); return }
        let finish = !calls.isEmpty ? CompletionResult.Finish.toolCalls.rawValue : result.finish.rawValue
        if stream {
            if !client.hasStartedStream { client.beginStream() }
            client.sendEvent(chunk([:], finish))
            var final = chunk([:], NSNull())
            final["choices"] = [Any]()
            final.merge(usageFields(result)) { first, _ in first }
            client.sendEvent(final)
            client.sendDone()
            client.finish()
        } else {
            var message: [String: Any] = ["role": "assistant", "content": text]
            if !reasoning.isEmpty { message["reasoning_content"] = reasoning }
            if !calls.isEmpty { message["tool_calls"] = calls }
            var reply: [String: Any] = ["id": id, "object": "chat.completion", "created": created, "model": alias, "choices": [["index": 0, "message": message, "finish_reason": finish]]]
            reply.merge(usageFields(result)) { first, _ in first }
            client.respond(status: 200, json: reply)
        }
    } catch {
        send(error, to: client)
    }
}

let server: HTTPServer
do {
    server = try HTTPServer(host: host, port: port) { request, client in
        let route = "\(request.method) \(request.path)"
        guard let engine = currentEngine() else {
            if route == "GET /health" { client.respond(status: 503, json: ["status": "loading"]) }
            else { client.respond(status: 503, json: errorBody(503, "The model is still loading.", type: "unavailable_error")) }
            return
        }
        switch route {
        case "GET /health":
            client.respond(status: 200, json: ["status": "ok"])
        case "GET /props":
            client.respond(status: 200, json: ["default_generation_settings": ["n_ctx": engine.contextSize], "n_ctx": engine.contextSize, "model_path": modelPath, "total_slots": 1])
        case "GET /slots":
            client.respond(status: 200, json: engine.status.json(contextSize: engine.contextSize))
        case "GET /v1/models", "GET /models":
            client.respond(status: 200, json: ["object": "list", "data": [["id": alias, "object": "model", "owned_by": "local"]]])
        case "POST /apply-template":
            DispatchQueue.global().async {
                do { client.respond(status: 200, json: ["prompt": try engine.applyTemplate(try parseJSON(request.body))]) }
                catch { send(error, to: client) }
            }
        case "POST /tokenize":
            DispatchQueue.global().async {
                do { client.respond(status: 200, json: ["tokens": try engine.tokenize(try parseJSON(request.body))]) }
                catch { send(error, to: client) }
            }
        case "POST /v1/chat/completions", "POST /chat/completions":
            do {
                let body = try parseJSON(request.body)
                engine.queue.async { runCompletion(engine, body, client) }
            } catch {
                send(error, to: client)
            }
        default:
            client.respond(status: 404, json: errorBody(404, "Not found.", type: "not_found_error"))
        }
    }
} catch {
    fatal("Cannot listen on \(host):\(port): \(error)")
}
server.start { fatal($0) }

Task.detached {
    do {
        Memory.cacheLimit = 2 * 1024 * 1024 * 1024
        let context = try await loadModel(from: directory, using: LocalTokenizerLoader())
        let engine = Engine(context: context, directory: directory, contextSize: contextSize)
        engineLock.withLock { loadedEngine = engine }
        log("model loaded: \(directory.lastPathComponent), context \(contextSize) tokens")
    } catch {
        fatal("Failed to load the MLX model: \(error)")
    }
}

dispatchMain()
