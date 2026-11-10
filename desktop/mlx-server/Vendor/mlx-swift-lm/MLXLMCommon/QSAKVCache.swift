// G-Code: cache for Qwen Sparse Attention (Qwen3.8-Flash-Next, model type qwen4_exp).
//
// Besides the attention keys and values it keeps the indexer's raw keys (one per token) and the
// pooled keys of the complete blocks the indexer scores, so a decode step adds to both instead of
// recomputing them. It lives here, beside KVCacheSimple, so `innerState()` (which `eval(cache)`
// walks) and `trim` cover the indexer state as well.

import Foundation
import MLX

public final class QSAKVCache: KVCacheSimple {
    /// The indexer's raw keys, [B, 1, capacity, D]; the first `indexCount` rows are written.
    private var indexBuffer: MLXArray?
    public private(set) var indexCount = 0
    /// Pooled, normalized and rotated keys of complete blocks, [B, 1, capacity, D].
    private var blockBuffer: MLXArray?
    public private(set) var blockCount = 0
    /// Tokens per block for the pooled keys; 0 until a block is stored.
    public private(set) var blockRatio = 0

    public override init() {
        super.init()
    }

    public override func innerState() -> [MLXArray] {
        super.innerState() + [indexBuffer, blockBuffer].compactMap { $0 }
    }

    /// Appends `keys` ([B, 1, L, D]) and returns every indexer key so far, [B, 1, indexCount, D].
    public func appendIndexKeys(_ keys: MLXArray) -> MLXArray {
        indexBuffer = Self.write(keys, into: indexBuffer, at: indexCount, step: step)
        indexCount += keys.dim(2)
        return indexBuffer![.ellipsis, ..<indexCount, 0...]
    }

    /// The stored block keys, when they were pooled with `ratio` tokens per block.
    public func blockKeys(ratio: Int) -> MLXArray? {
        guard blockRatio == ratio, blockCount > 0, let blockBuffer else { return nil }
        return blockBuffer[.ellipsis, ..<blockCount, 0...]
    }

    /// Appends the keys of newly completed blocks ([B, 1, n, D]).
    public func appendBlockKeys(_ blocks: MLXArray, ratio: Int) {
        if blockRatio != ratio {
            blockBuffer = nil
            blockCount = 0
            blockRatio = ratio
        }
        guard blocks.dim(2) > 0 else { return }
        blockBuffer = Self.write(blocks, into: blockBuffer, at: blockCount, step: max(1, step / max(ratio, 1)))
        blockCount += blocks.dim(2)
    }

    private static func write(_ rows: MLXArray, into buffer: MLXArray?, at start: Int, step: Int) -> MLXArray {
        let end = start + rows.dim(2)
        var buffer = buffer
        if buffer == nil || end > buffer!.dim(2) {
            let steps = (rows.dim(2) + step - 1) / step
            let grown = MLXArray.zeros([rows.dim(0), rows.dim(1), steps * step, rows.dim(3)], dtype: rows.dtype)
            if let current = buffer {
                buffer = concatenated([current[.ellipsis, ..<start, 0...], grown], axis: 2)
            } else {
                buffer = grown
            }
        }
        buffer![.ellipsis, start ..< end, 0...] = rows
        return buffer!
    }

    public override var state: [MLXArray] {
        get {
            var arrays = super.state
            guard !arrays.isEmpty, let indexBuffer else { return arrays }
            arrays.append(indexBuffer[.ellipsis, ..<indexCount, 0...])
            if blockCount > 0, let blockBuffer {
                arrays.append(blockBuffer[.ellipsis, ..<blockCount, 0...])
            }
            return arrays
        }
        set {
            guard newValue.count >= 2, newValue.count <= 4 else {
                fatalError("QSAKVCache state must have 2 to 4 arrays (keys, values, index keys, block keys)")
            }
            super.state = Array(newValue[0 ..< 2])
            indexBuffer = newValue.count > 2 ? newValue[2] : nil
            indexCount = indexBuffer?.dim(2) ?? 0
            blockBuffer = newValue.count > 3 ? newValue[3] : nil
            blockCount = blockBuffer?.dim(2) ?? 0
            if blockBuffer == nil { blockRatio = 0 }
        }
    }

    /// The block ratio, so a restored state keeps the meaning of its block keys.
    public override var metaState: [String] {
        get { [String(blockRatio)] }
        set {
            guard newValue.count == 1, let ratio = Int(newValue[0]) else {
                fatalError("QSAKVCache meta_state must be one integer")
            }
            blockRatio = ratio
        }
    }

    @discardableResult
    public override func trim(_ n: Int) -> Int {
        let trimmed = super.trim(n)
        indexCount = min(indexCount, offset)
        // A block survives only when every one of its tokens does.
        blockCount = blockRatio > 0 ? min(blockCount, offset / blockRatio) : 0
        return trimmed
    }

    public override func copy() -> any KVCache {
        let new = QSAKVCache()
        new.step = step
        let current = state
        if !current.isEmpty {
            new.state = current.map { $0[.ellipsis] }
        }
        new.blockRatio = blockRatio
        return new
    }
}
