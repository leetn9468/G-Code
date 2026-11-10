import Foundation
import MLX
import MLXLLM
import MLXLMCommon
import MLXServerKit
import Tokenizers

enum ServerError: Error {
    case badRequest(String)
    case contextExceeded(prompt: Int, context: Int)
    case failed(String)
}

/// A saved rewind point: the recurrent layers' state once `position` tokens were in the cache.
/// MLX arrays are immutable, so this holds references and copies nothing.
private struct Checkpoint {
    let position: Int
    /// One entry per layer; nil for an attention layer, which can simply be trimmed.
    let states: [[MLXArray]?]
}

/// Numbers `/slots` reports while the inference queue is busy.
final class SlotStatus {
    private let lock = NSLock()
    private var processing = false
    private var promptTokens = 0
    private var past = 0
    private var decoded = 0

    func begin() { lock.withLock { processing = true; promptTokens = 0; past = 0; decoded = 0 } }
    func update(promptTokens value: Int) { lock.withLock { promptTokens = value } }
    func update(past value: Int) { lock.withLock { past = value } }
    func update(decoded value: Int) { lock.withLock { decoded = value } }
    func end() { lock.withLock { processing = false } }

    func json(contextSize: Int) -> [[String: Any]] {
        lock.withLock {
            [["id": 0, "n_ctx": contextSize, "is_processing": processing, "n_prompt_tokens": promptTokens, "n_past": past, "n_decoded": decoded]]
        }
    }
}

struct CompletionResult {
    enum Finish: String { case stop, length, toolCalls = "tool_calls", cancelled }
    var finish: Finish
    var promptTokens: Int
    var cachedTokens: Int
    var completionTokens: Int
    var promptMs: Double
    var predictedMs: Double
}

/// The loaded model and the one conversation cache it keeps. Generation runs on `queue`, one request
/// at a time; nothing else touches the caches.
final class Engine {
    private static let prefillStep = 512
    private static let checkpointSpacing = 1024
    private static let maxCheckpoints = 16

    let context: ModelContext
    let contextSize: Int
    let status = SlotStatus()
    let queue = DispatchQueue(label: "gcode.mlx.inference")

    private var caches: [any KVCache] = []
    private var represented: [Int] = []
    private var checkpoints: [Checkpoint] = []

    private let stopTokens: Set<Int>
    private let messageStart: Int?
    private let defaults: (temperature: Float, topP: Float, topK: Int)

    private let renderedLock = NSLock()
    private var rendered: (prompt: String, tokens: [Int])?

    init(context: ModelContext, directory: URL, contextSize: Int) {
        self.context = context
        self.contextSize = contextSize
        let generation = (try? JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("generation_config.json")))) as? [String: Any] ?? [:]
        var stops = context.configuration.eosTokenIds
        if let id = generation["eos_token_id"] as? Int { stops.insert(id) }
        if let ids = generation["eos_token_id"] as? [Int] { stops.formUnion(ids) }
        if let id = context.tokenizer.eosTokenId { stops.insert(id) }
        for token in context.configuration.extraEOSTokens {
            if let id = context.tokenizer.convertTokenToId(token) { stops.insert(id) }
        }
        stopTokens = stops
        messageStart = context.tokenizer.convertTokenToId("<|im_start|>")
        defaults = ((generation["temperature"] as? NSNumber)?.floatValue ?? 0.8, (generation["top_p"] as? NSNumber)?.floatValue ?? 0.95, (generation["top_k"] as? NSNumber)?.intValue ?? 40)
    }

    // MARK: Prompt

    /// The rendered prompt as tokens. Pure tokenizer work: safe beside a running generation.
    func render(_ body: [String: Any]) throws -> [Int] {
        guard let messages = body["messages"] as? [[String: Any]] else { throw ServerError.badRequest("messages is required.") }
        var extra: [String: any Sendable] = [:]
        for (key, value) in (body["chat_template_kwargs"] as? [String: Any]) ?? [:] { extra[key] = Self.sendable(value) }
        do {
            return try context.tokenizer.applyChatTemplate(messages: try messages.map(Self.templateMessage), tools: Self.tools(body), additionalContext: extra)
        } catch let error as ServerError {
            throw error
        } catch {
            throw ServerError.badRequest("Chat template failed: \(error)")
        }
    }

    /// Text the tokenizer maps back to these tokens; `tokenize` answers it from the same render.
    func applyTemplate(_ body: [String: Any]) throws -> String {
        let tokens = try render(body)
        let prompt = context.tokenizer.decode(tokenIds: tokens, skipSpecialTokens: false)
        renderedLock.withLock { rendered = (prompt, tokens) }
        return prompt
    }

    func tokenize(_ body: [String: Any]) throws -> [Int] {
        guard let content = body["content"] as? String else { throw ServerError.badRequest("content is required.") }
        if let known = renderedLock.withLock({ rendered }), known.prompt == content { return known.tokens }
        return context.tokenizer.encode(text: content, addSpecialTokens: body["add_special"] as? Bool ?? false)
    }

    private static func tools(_ body: [String: Any]) -> [[String: any Sendable]]? {
        guard let tools = body["tools"] as? [[String: Any]], !tools.isEmpty else { return nil }
        return tools.map { $0.compactMapValues(present).mapValues(sendable) }
    }

    /// JSON as the chat template expects it: tool arguments are objects, a missing content is empty text.
    private static func templateMessage(_ message: [String: Any]) throws -> [String: any Sendable] {
        var out: [String: any Sendable] = [:]
        for (key, value) in message where !(value is NSNull) { out[key] = sendable(value) }
        out["content"] = try text(of: message["content"])
        if let calls = message["tool_calls"] as? [[String: Any]] {
            out["tool_calls"] = calls.map { call -> [String: any Sendable] in
                var function = (call["function"] as? [String: Any]) ?? [:]
                if let arguments = function["arguments"] as? String {
                    let parsed = arguments.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
                    function["arguments"] = parsed ?? [String: Any]()
                }
                var result = call.compactMapValues(present).mapValues(sendable)
                result["function"] = sendable(function)
                return result
            }
        }
        return out
    }

    private static func text(of content: Any?) throws -> String {
        if let string = content as? String { return string }
        guard let parts = content as? [[String: Any]] else { return "" }
        return try parts.map { part in
            guard part["type"] as? String == "text", let text = part["text"] as? String else {
                throw ServerError.badRequest("This MLX server reads text only; this message has an image or other media.")
            }
            return text
        }.joined()
    }

    private static func present(_ value: Any) -> Any? { value is NSNull ? nil : value }

    private static func sendable(_ value: Any) -> any Sendable {
        switch value {
        case let number as NSNumber:
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue }
            return CFNumberIsFloatType(number) ? number.doubleValue : number.intValue
        case let string as String: return string
        case let array as [Any]: return array.compactMap(present).map(sendable)
        case let object as [String: Any]: return object.compactMapValues(present).mapValues(sendable)
        default: return ""
        }
    }

    // MARK: Cache

    private func resetCaches() throws {
        caches = try context.model.newCache(parameters: nil)
        represented = []
        checkpoints = []
        Memory.clearCache()
    }

    /// Brings the cache to the longest usable prefix of `prompt` and returns its length.
    private func reconcile(prompt: [Int]) throws -> Int {
        if caches.isEmpty { try resetCaches() }
        // The last token always goes through the model: it produces the first reply token.
        let limit = prompt.count - 1
        var common = 0
        let bound = min(limit, represented.count)
        while common < bound, represented[common] == prompt[common] { common += 1 }
        if common == represented.count { return common }

        if canTrimPromptCache(caches) {
            let drop = represented.count - common
            guard trimPromptCache(caches, numTokens: drop) == drop else { try resetCaches(); return 0 }
            represented.removeLast(drop)
            checkpoints.removeAll { $0.position > common }
            return common
        }
        // Recurrent layers cannot be trimmed: go back to the nearest saved state.
        guard let checkpoint = checkpoints.last(where: { $0.position <= common }) else { try resetCaches(); return 0 }
        for (index, cache) in caches.enumerated() {
            if let state = checkpoint.states[index] {
                guard let recurrent = cache as? BaseKVCache else { try resetCaches(); return 0 }
                recurrent.state = state
                recurrent.offset = checkpoint.position
            } else {
                let drop = cache.offset - checkpoint.position
                if drop > 0, cache.trim(drop) != drop { try resetCaches(); return 0 }
            }
        }
        represented.removeLast(represented.count - checkpoint.position)
        checkpoints.removeAll { $0.position > checkpoint.position }
        return checkpoint.position
    }

    private func saveCheckpoint() {
        // Nothing to save when every layer can be trimmed.
        guard !canTrimPromptCache(caches) else { return }
        if checkpoints.last?.position == represented.count { return }
        eval(caches.flatMap { $0.state })
        checkpoints.append(Checkpoint(position: represented.count, states: caches.map { $0.isTrimmable ? nil : $0.state }))
        // Divergence happens near the end, so the recent ones matter; the first covers the system prompt.
        if checkpoints.count > Self.maxCheckpoints { checkpoints.remove(at: 1) }
    }

    /// Runs `prompt[represented.count ..< limit]` through the model, stopping at message starts to save rewind points.
    private func prefill(_ prompt: [Int], limit: Int, cancelled: () -> Bool) throws -> Bool {
        while represented.count < limit {
            if cancelled() { return false }
            let start = represented.count
            var end = min(start + Self.prefillStep, limit)
            var boundary = false
            if let messageStart, let next = prompt[(start + 1)..<max(end, start + 1)].firstIndex(of: messageStart) {
                end = next
                boundary = true
            }
            autoreleasepool {
                let chunk = MLXArray(prompt[start..<end].map { Int32($0) })[.newAxis, .ellipsis]
                _ = context.model.callAsFunction(LMInput.Text(tokens: chunk), cache: caches, state: nil)
                eval(caches.flatMap { $0.state })
            }
            represented.append(contentsOf: prompt[start..<end])
            status.update(past: represented.count)
            let last = checkpoints.last?.position ?? 0
            if boundary, represented.count - last >= Self.checkpointSpacing { saveCheckpoint() }
            if (represented.count / Self.prefillStep) % 8 == 0 { Memory.clearCache() }
        }
        saveCheckpoint()
        return true
    }

    // MARK: Generation

    /// Must run on `queue`. `emit` receives the reply in order.
    func complete(_ body: [String: Any], cancelled: () -> Bool, emit: @escaping (ReplyPart) -> Void) throws -> CompletionResult {
        status.begin()
        defer { status.end() }
        let prompt = try render(body)
        status.update(promptTokens: prompt.count)
        guard !prompt.isEmpty else { throw ServerError.badRequest("The prompt is empty.") }
        guard prompt.count < contextSize else { throw ServerError.contextExceeded(prompt: prompt.count, context: contextSize) }

        let started = Date()
        let cached: Int
        do {
            cached = try reconcile(prompt: prompt)
            status.update(past: cached)
            if try !prefill(prompt, limit: prompt.count - 1, cancelled: cancelled) {
                return CompletionResult(finish: .cancelled, promptTokens: prompt.count, cachedTokens: cached, completionTokens: 0, promptMs: 0, predictedMs: 0)
            }
        } catch {
            try? resetCaches()
            throw error
        }
        let promptEnd = Date()

        let requested = (body["max_tokens"] as? Int) ?? (body["max_completion_tokens"] as? Int) ?? contextSize
        let room = contextSize - prompt.count
        let maxNew = max(1, min(requested, room))
        var parameters = GenerateParameters()
        parameters.temperature = (body["temperature"] as? NSNumber)?.floatValue ?? defaults.temperature
        parameters.topP = (body["top_p"] as? NSNumber)?.floatValue ?? defaults.topP
        parameters.topK = (body["top_k"] as? NSNumber)?.intValue ?? defaults.topK

        let tail = context.tokenizer.decode(tokenIds: Array(prompt.suffix(8)), skipSpecialTokens: false)
        let tools = Self.tools(body)
        let router = OutputRouter(inThinking: tail.hasSuffix("<think>\n"), format: context.configuration.toolCallFormat ?? .json, tools: tools, emit: emit)
        let budget = (body["thinking_budget_tokens"] as? Int).flatMap { $0 >= 0 ? $0 : nil }

        var detokenizer = NaiveStreamingDetokenizer(tokenizer: context.tokenizer)
        var finish = CompletionResult.Finish.length
        var generated = 0
        var reasoned = 0
        var input = [prompt[prompt.count - 1]]

        generation: while generated < maxNew {
            parameters.maxTokens = maxNew - generated
            var iterator: TokenIterator
            do {
                iterator = try TokenIterator(input: LMInput(tokens: MLXArray(input.map { Int32($0) })), model: context.model, cache: caches, parameters: parameters)
            } catch {
                try? resetCaches()
                throw ServerError.failed("Generation failed: \(error)")
            }
            represented.append(contentsOf: input)
            while let token = iterator.next() {
                represented.append(token)
                if stopTokens.contains(token) { finish = .stop; break generation }
                generated += 1
                status.update(decoded: generated)
                detokenizer.append(token: token)
                if let text = detokenizer.next() { router.push(text) }
                if cancelled() { finish = .cancelled; break generation }
                if router.inThinking {
                    reasoned += 1
                    if let budget, reasoned >= budget {
                        // The budget is spent: close the block and continue with the answer.
                        input = context.tokenizer.encode(text: "\n</think>\n\n", addSpecialTokens: false)
                        router.closeThinking()
                        detokenizer = NaiveStreamingDetokenizer(tokenizer: context.tokenizer)
                        continue generation
                    }
                }
            }
            break
        }
        router.finish()
        verifyCache()

        let end = Date()
        FileHandle.standardError.write(Data("request: prompt \(prompt.count), cached \(cached), generated \(generated), \(finish.rawValue), checkpoints \(checkpoints.count)\n".utf8))
        return CompletionResult(finish: finish, promptTokens: prompt.count, cachedTokens: cached, completionTokens: generated,
            promptMs: promptEnd.timeIntervalSince(started) * 1000, predictedMs: end.timeIntervalSince(promptEnd) * 1000)
    }

    /// The token ledger and the cache must agree, or the next request would continue from the wrong place.
    private func verifyCache() {
        guard let attention = caches.first(where: { $0.isTrimmable }) else { return }
        if attention.offset != represented.count {
            FileHandle.standardError.write(Data("cache ledger mismatch: offset \(attention.offset), tokens \(represented.count); resetting\n".utf8))
            try? resetCaches()
        }
    }
}

/// Bridges the tokenizer package to MLXLMCommon.
struct TokenizerBridge: MLXLMCommon.Tokenizer {
    let upstream: any Tokenizers.Tokenizer

    func encode(text: String, addSpecialTokens: Bool) -> [Int] { upstream.encode(text: text, addSpecialTokens: addSpecialTokens) }
    func decode(tokenIds: [Int], skipSpecialTokens: Bool) -> String { upstream.decode(tokens: tokenIds, skipSpecialTokens: skipSpecialTokens) }
    func convertTokenToId(_ token: String) -> Int? { upstream.convertTokenToId(token) }
    func convertIdToToken(_ id: Int) -> String? { upstream.convertIdToToken(id) }
    var bosToken: String? { upstream.bosToken }
    var eosToken: String? { upstream.eosToken }
    var unknownToken: String? { upstream.unknownToken }

    func applyChatTemplate(messages: [[String: any Sendable]], tools: [[String: any Sendable]]?, additionalContext: [String: any Sendable]?) throws -> [Int] {
        do {
            return try upstream.applyChatTemplate(messages: messages, tools: tools, additionalContext: additionalContext)
        } catch Tokenizers.TokenizerError.missingChatTemplate {
            throw MLXLMCommon.TokenizerError.missingChatTemplate
        }
    }
}

struct LocalTokenizerLoader: TokenizerLoader {
    func load(from directory: URL) async throws -> any MLXLMCommon.Tokenizer {
        TokenizerBridge(upstream: try await AutoTokenizer.from(modelFolder: directory))
    }
}
