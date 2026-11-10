import Foundation
import MLXLMCommon

/// What a reply is made of, in the order it arrived.
public enum ReplyPart {
    case reasoning(String)
    case text(String)
    case toolCall(ToolCall)
}

/// Splits generated text into reasoning, answer text and tool calls.
public final class OutputRouter {
    private static let closeTag = "</think>"

    public private(set) var inThinking: Bool
    private var held = ""
    /// Blank space around a tool call is template layout, not part of the answer: it is kept back
    /// until more text follows, and dropped when a call or the end of the reply comes first.
    private var heldSpace = ""
    private var atTextStart = true
    private let processor: ToolCallProcessor
    private let emit: (ReplyPart) -> Void

    /// `inThinking`: the prompt ended inside an open thinking block.
    public init(inThinking: Bool, format: ToolCallFormat, tools: [[String: any Sendable]]?, emit: @escaping (ReplyPart) -> Void) {
        self.inThinking = inThinking
        self.processor = ToolCallProcessor(format: format, tools: tools)
        self.emit = emit
    }

    public func push(_ chunk: String) {
        guard inThinking else { answer(chunk); return }
        held += chunk
        if let close = held.range(of: Self.closeTag) {
            let reasoning = String(held[..<close.lowerBound])
            let rest = String(held[close.upperBound...])
            held = ""
            inThinking = false
            if !reasoning.isEmpty { emit(.reasoning(reasoning)) }
            answer(rest)
            return
        }
        // Keep back only what could still become the closing tag.
        var keep = min(held.count, Self.closeTag.count - 1)
        while keep > 0, !Self.closeTag.hasPrefix(String(held.suffix(keep))) { keep -= 1 }
        let ready = String(held.dropLast(keep))
        held = String(held.suffix(keep))
        if !ready.isEmpty { emit(.reasoning(ready)) }
    }

    /// Thinking ended without the model writing the tag (its budget ran out).
    public func closeThinking() {
        guard inThinking else { return }
        if !held.isEmpty { emit(.reasoning(held)) }
        held = ""
        inThinking = false
    }

    public func finish() {
        closeThinking()
        deliver(processor.processEOSOutputs())
    }

    private func answer(_ chunk: String) {
        deliver(processor.processChunkOutputs(chunk))
    }

    private func say(_ chunk: String) {
        var text = Substring(chunk)
        if atTextStart { text = text.drop(while: { $0.isWhitespace }) }
        guard let last = text.lastIndex(where: { !$0.isWhitespace }) else {
            if !atTextStart { heldSpace += text }
            return
        }
        let end = text.index(after: last)
        emit(.text(heldSpace + text[..<end]))
        heldSpace = String(text[end...])
        atTextStart = false
    }

    private func deliver(_ outputs: [ToolCallProcessor.Output]) {
        for output in outputs {
            switch output {
            case .response(let text): say(text)
            case .toolCall(let call):
                heldSpace = ""
                atTextStart = true
                emit(.toolCall(call))
            case .rejectedToolCall(let rejected):
                // Say so instead of ending the turn with nothing: the model reads this and can write the call again.
                FileHandle.standardError.write(Data("rejected tool call: \(rejected)\n".utf8))
                say("\n[A tool call in this reply was malformed and was not run.]\n")
            }
        }
    }
}
