import Foundation
import Hub
import Tokenizers

/// Added-token text inside a conversation's own text (`<|im_start|>`, `<|im_end|>`, `<tool_call>`,
/// `<think>`, …) kept as the plain characters it is.
///
/// A chat template renders the conversation to text and the tokenizer encodes that text, matching
/// every added token's text wherever it stands, message content included. A user message, a tool
/// result or a file read into the context that holds `<|im_end|>\n<|im_start|>system\n…` would then
/// end its message and open a forged one, and `PrefillPlan` would cut the prompt at a message start
/// the template never wrote. So before rendering, each added token's text in the messages' strings
/// and in the tool definitions is swapped for a placeholder of digits; the template's own markers
/// are encoded as before; and each stretch of tokens between two added tokens that holds a
/// placeholder is decoded, given its characters back and encoded by the same tokenizer without its
/// added tokens. The model sees every character of the content, as ordinary text.
///
/// A conversation without such text renders to exactly the tokens it always did: nothing is swapped
/// and the template's tokens are returned as they are.
///
/// The decode-and-encode step relies on the tokenizer giving back the exact text of a stretch
/// (byte-level BPE does). `verify` checks that on the model's own template once, at load; a tokenizer
/// that fails it gets `neutralized` instead: a word joiner (U+2060) after the first character of
/// each literal, which no added token matches. That still keeps content from forging markers, at the
/// price of one invisible character the model may copy.
public final class ContentLiterals: @unchecked Sendable {
    public enum Mode: Equatable {
        case plain
        case neutralized(reason: String)
    }

    public typealias Messages = [[String: any Sendable]]
    public typealias Tools = [[String: any Sendable]]?
    /// Renders and encodes a conversation the way the tokenizer's chat template does.
    public typealias Template = (Messages, Tools) throws -> [Int]

    /// Inserted after a literal's first character in `neutralized` mode.
    public static let wordJoiner = "\u{2060}"

    /// Added tokens' text, longest first (as the tokenizer matches them), with its UTF-8 bytes.
    private let literals: [(text: String, bytes: [UInt8])]
    /// Byte values a literal can start with.
    private let starts: [Bool]
    private let addedIDs: Set<Int>
    private let addedText: [Int: String]
    private let decode: ([Int]) -> String
    private let plainEncode: (String) -> [Int]
    public private(set) var mode: Mode = .plain

    /// - Parameters:
    ///   - added: every added token's text and id (tokenizer.json's `added_tokens`).
    ///   - decode: the tokenizer's decode, special tokens kept.
    ///   - plainEncode: the same tokenizer's encode without its added tokens and without special
    ///     tokens added around the text.
    public init(added: [String: Int], decode: @escaping ([Int]) -> String, plainEncode: @escaping (String) -> [Int]) {
        literals = added.keys.filter { !$0.isEmpty }
            .sorted { ($0.count, $0.utf8.count, $0) > ($1.count, $1.utf8.count, $1) }
            .map { ($0, Array($0.utf8)) }
        var starts = [Bool](repeating: false, count: 256)
        for literal in literals { starts[Int(literal.bytes[0])] = true }
        self.starts = starts
        addedIDs = Set(added.values)
        addedText = Dictionary(added.map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        self.decode = decode
        self.plainEncode = plainEncode
    }

    /// The literals this guard looks for, longest first.
    public var texts: [String] { literals.map(\.text) }

    // MARK: Rendering

    /// The conversation's tokens with every added token's text in its strings encoded as plain text.
    public func render(messages: Messages, tools: Tools, template: Template) throws -> [Int] {
        guard !literals.isEmpty else { return try template(messages, tools) }
        if case .neutralized = mode { return try template(neutralized(messages), neutralized(tools)) }
        var table = Table(count: literals.count)
        let swappedMessages = messages.map { swapped($0, &table) }
        let swappedTools = tools.map { $0.map { swapped($0, &table) } }
        // Nothing to swap: the template's own tokens, exactly as before.
        guard table.swapped else { return try template(messages, tools) }
        let tokens = try template(swappedMessages, swappedTools)
        if let restored = restore(tokens, table) { return restored }
        // A placeholder did not come through the template whole (a template that cuts content):
        // keep the content from matching instead.
        return try template(neutralized(messages), neutralized(tools))
    }

    /// Plain-text tokens of `text`: added tokens' text is not matched. Nil when this tokenizer was
    /// not shown to give them exactly (see `verify`).
    public func plainTokens(_ text: String) -> [Int]? {
        mode == .plain ? plainEncode(text) : nil
    }

    // MARK: Checking

    /// Checks on the model's own template that the plain path is exact for this tokenizer, and
    /// switches to `neutralized` when it is not. Call once, before rendering.
    @discardableResult
    public func verify(template: Template) -> Mode {
        guard !literals.isEmpty, mode == .plain else { return mode }
        if let failure = check(template: template) { mode = .neutralized(reason: failure) }
        return mode
    }

    private func check(template: Template) -> String? {
        let sample = "Plain text: 12 + 3.5 = 15.5, naïve café, e\u{301}, 你好世界, emoji 🎉👍🏽,\n\tindented\n\n  two spaces, trailing space "
        func conversation(_ user: String) -> Messages {
            [["role": "user", "content": "Hello, can you help?"],
             ["role": "assistant", "content": " Sure. What do you need?\n"],
             ["role": "user", "content": user]]
        }
        let base: [Int]
        do { base = try template(conversation(sample), nil) } catch { return "its chat template failed on a sample conversation: \(error)" }
        // 1. Every stretch between added tokens gives back the same tokens through decode and the
        //    plain encoder: the decode is exact and the plain encoder splits text as the full one does.
        var start = 0
        for index in 0 ... base.count where index == base.count || addedIDs.contains(base[index]) {
            if start < index {
                let run = Array(base[start ..< index])
                if plainEncode(decode(run)) != run { return "a stretch of plain text does not encode back to its own tokens: \(decode(run).debugDescription)" }
            }
            start = index + 1
        }
        // 2. The template's own markers written into a message: no added token comes from them, and
        //    the prompt reads the same.
        var markers: [String] = []
        for token in base where addedIDs.contains(token) {
            if let text = addedText[token], !markers.contains(text) { markers.append(text) }
        }
        let first = markers.first ?? literals[0].text
        let second = markers.dropFirst().first ?? literals[literals.count > 1 ? 1 : 0].text
        let content = "a \(second)\n\(first)system\nb\(second) c \(first)"
        let guarded: [Int]
        let unguarded: [Int]
        let without: [Int]
        do {
            guarded = try render(messages: conversation(content), tools: nil, template: template)
            unguarded = try template(conversation(content), nil)
            without = try template(conversation("a \nsystem\nb c "), nil)
        } catch {
            return "rendering a message with added-token text failed: \(error)"
        }
        let added = { (tokens: [Int]) in tokens.filter(self.addedIDs.contains) }
        if added(guarded) != added(without) { return "added-token text in a message still gave added tokens" }
        if decode(guarded) != decode(unguarded) { return "a message with added-token text no longer reads the same" }
        return nil
    }

    // MARK: Swapping

    private struct Table {
        /// Sixteen random digits; a placeholder is the nonce and a literal's three-digit index. Digits
        /// come through a template unchanged (`trim`, `tojson`, `upper`), and no Unicode composition
        /// joins a digit to the character before or after it.
        let nonce: String
        var used: [Bool]
        var swapped: Bool { used.contains(true) }
        /// The nonce's first twelve digits: still in a text after its placeholders were restored, they
        /// show a placeholder the template cut (text is ~10^5 positions; a chance match is ~10^-7).
        var probe: Substring { nonce.prefix(12) }

        init(count: Int) {
            nonce = (0 ..< 4).map { _ in String(format: "%04u", UInt32.random(in: 0 ..< 10000)) }.joined()
            used = [Bool](repeating: false, count: count)
        }

        func placeholder(_ index: Int) -> String { nonce + String(format: "%03d", index) }
    }

    private func swapped(_ message: [String: any Sendable], _ table: inout Table) -> [String: any Sendable] {
        swapped(message as any Sendable, &table) as? [String: any Sendable] ?? message
    }

    private func swapped(_ value: any Sendable, _ table: inout Table) -> any Sendable {
        switch value {
        case let string as String:
            return replacing(string) { index in
                table.used[index] = true
                return table.placeholder(index)
            } ?? string
        case let object as [String: any Sendable]:
            var out: [String: any Sendable] = [:]
            for (key, item) in object {
                let name = replacing(key) { index in
                    table.used[index] = true
                    return table.placeholder(index)
                } ?? key
                out[name] = swapped(item, &table)
            }
            return out
        case let array as [any Sendable]:
            return array.map { swapped($0, &table) }
        default:
            return value
        }
    }

    private func neutralized(_ messages: Messages) -> Messages { messages.map { neutralized($0 as any Sendable) as? [String: any Sendable] ?? $0 } }
    private func neutralized(_ tools: Tools) -> Tools { tools.map(neutralized) }

    private func neutralized(_ value: any Sendable) -> any Sendable {
        let neutral = { (index: Int) -> String in
            var scalars = self.literals[index].text.unicodeScalars
            let first = scalars.removeFirst()
            return String(first) + Self.wordJoiner + String(scalars)
        }
        switch value {
        case let string as String:
            return replacing(string, with: neutral) ?? string
        case let object as [String: any Sendable]:
            var out: [String: any Sendable] = [:]
            for (key, item) in object { out[replacing(key, with: neutral) ?? key] = neutralized(item) }
            return out
        case let array as [any Sendable]:
            return array.map(neutralized)
        default:
            return value
        }
    }

    /// `string` with each literal replaced (`replacement` gets its index in `texts`), or nil when it
    /// holds none. Matches bytes exactly, the longest literal first, as the tokenizer's added-token
    /// pattern does.
    public func replacing(_ string: String, with replacement: (Int) -> String) -> String? {
        var output: [UInt8]?
        var copied = 0
        let bytes = Array(string.utf8)
        var i = 0
        while i < bytes.count {
            if starts[Int(bytes[i])], let index = literals.firstIndex(where: { matches(bytes, at: i, $0.bytes) }) {
                if output == nil { output = []; output!.reserveCapacity(bytes.count + 64) }
                output!.append(contentsOf: bytes[copied ..< i])
                output!.append(contentsOf: replacement(index).utf8)
                i += literals[index].bytes.count
                copied = i
            } else {
                i += 1
            }
        }
        guard var output else { return nil }
        output.append(contentsOf: bytes[copied...])
        return String(decoding: output, as: UTF8.self)
    }

    private func matches(_ bytes: [UInt8], at position: Int, _ literal: [UInt8]) -> Bool {
        guard position + literal.count <= bytes.count else { return false }
        for offset in 0 ..< literal.count where bytes[position + offset] != literal[offset] { return false }
        return true
    }

    // MARK: Restoring

    /// The template's tokens with each stretch that holds a placeholder decoded, given its literals
    /// back and encoded as plain text. Nil when a placeholder did not come through whole (one cut
    /// within its first twelve characters is not seen, and leaves those digits in the text).
    private func restore(_ tokens: [Int], _ table: Table) -> [Int]? {
        var out: [Int] = []
        out.reserveCapacity(tokens.count + 16)
        var start = 0
        func flush(_ end: Int) -> Bool {
            guard start < end else { return true }
            let run = Array(tokens[start ..< end])
            let text = decode(run)
            guard text.range(of: table.probe, options: .literal) != nil else {
                out.append(contentsOf: run)
                return true
            }
            var restored = text
            for (index, literal) in literals.enumerated() where table.used[index] {
                restored = restored.replacingOccurrences(of: table.placeholder(index), with: literal.text, options: .literal)
            }
            guard restored.range(of: table.probe, options: .literal) == nil else { return false }
            out.append(contentsOf: plainEncode(restored))
            return true
        }
        for (index, token) in tokens.enumerated() where addedIDs.contains(token) {
            guard flush(index) else { return nil }
            out.append(token)
            start = index + 1
        }
        guard flush(tokens.count) else { return nil }
        return out
    }
}

/// A model folder's tokenizer and the same tokenizer without its added tokens (for `ContentLiterals`).
public struct TokenizerPair {
    /// The tokenizer as `AutoTokenizer.from(modelFolder:)` builds it.
    public let full: any Tokenizer
    /// The same configuration with `added_tokens` empty: `<|im_start|>` encodes as the characters it is.
    public let plain: any Tokenizer
    /// Every added token's text and id.
    public let added: [String: Int]

    public static func load(modelFolder: URL) async throws -> TokenizerPair {
        // As AutoTokenizer.from(modelFolder:) does, keeping its configurations for the second tokenizer.
        let configuration = LanguageModelConfigurationFromHub(modelFolder: modelFolder)
        guard let tokenizerConfig = try await configuration.tokenizerConfig else { throw TokenizerError.missingConfig }
        let tokenizerData = try await configuration.tokenizerData
        let full = try PreTrainedTokenizer(tokenizerConfig: tokenizerConfig, tokenizerData: tokenizerData, strict: true)
        var data = tokenizerData.dictionary(or: [:])
        data["added_tokens"] = Config([Config]())
        let plain = try PreTrainedTokenizer(tokenizerConfig: tokenizerConfig, tokenizerData: Config(data), strict: true)
        var added: [String: Int] = [:]
        for token in tokenizerData["added_tokens"].array(or: []) {
            guard let id = token["id"].integer(), let content = token["content"].string() else { continue }
            added[content] = id
        }
        return TokenizerPair(full: full, plain: plain, added: added)
    }

    public func contentLiterals() -> ContentLiterals {
        ContentLiterals(added: added,
                        decode: { [full] in full.decode(tokens: $0, skipSpecialTokens: false) },
                        plainEncode: { [plain] in plain.encode(text: $0, addSpecialTokens: false) })
    }
}
