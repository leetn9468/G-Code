//
//  Qwen4Exp.swift
//  G-Code
//
//  Qwen3.8-Flash-Next (model type `qwen4_exp`), text only. Port of mlx-vlm 0.7.12
//  `mlx_vlm/models/qwen4_exp` (PR #2032).
//
//  Per decoder layer: an optional PLE n-gram embedding (linear-attention layers only), then a
//  hyper-connection around a Gated DeltaNet or a Qwen Sparse Attention layer, then a
//  hyper-connection around a sparse MoE. The residual stream is `hc_count` copies wide; a final
//  mixer folds it back to one before the LM head. The vision tower and the MTP head are not used.
//

import Foundation
import MLX
import MLXLMCommon
import MLXNN

// MARK: - Configuration

public struct Qwen4ExpTextConfiguration: Codable, Sendable {
    var hiddenSize: Int
    var hiddenLayers: Int
    var attentionHeads: Int
    var kvHeads: Int
    var headDim: Int
    var linearNumValueHeads: Int
    var linearNumKeyHeads: Int
    var linearKeyHeadDim: Int
    var linearValueHeadDim: Int
    var linearConvKernelDim: Int
    var numExperts: Int
    var numExpertsPerTok: Int
    var sharedExpertIntermediateSize: Int
    var moeIntermediateSize: Int
    var normTopkProb: Bool
    var rmsNormEps: Float
    var vocabularySize: Int
    var maxPositionEmbeddings: Int
    var tieWordEmbeddings: Bool
    var attentionBias: Bool
    var hcCount: Int
    var hcLowrank: Int
    /// "linear_attention" or "qwen_sparse_attention" per layer.
    var layerTypes: [String]
    /// One-indexed decoder layers that carry a PLE n-gram embedding.
    var pleLayerIds: [Int]
    var pleEmbedDim: Int
    var pleConvKernelSize: Int
    var ngramSize: Int
    var headsPerNgram: Int
    var ngramVocabSizeBase: Int
    var makeNgramVocabSizeDivisibleBy: Int
    var splitNgramParts: Int
    var seed: Int
    var indexerHeads: Int
    var indexerHeadDim: Int
    var indexerBudget: Int
    var indexerCompressRatio: Int
    var outputGateType: String
    var eosTokenId: Int?
    var ropeTheta: Float
    var partialRotaryFactor: Float

    enum CodingKeys: String, CodingKey {
        case hiddenSize = "hidden_size"
        case hiddenLayers = "num_hidden_layers"
        case attentionHeads = "num_attention_heads"
        case kvHeads = "num_key_value_heads"
        case headDim = "head_dim"
        case linearNumValueHeads = "linear_num_value_heads"
        case linearNumKeyHeads = "linear_num_key_heads"
        case linearKeyHeadDim = "linear_key_head_dim"
        case linearValueHeadDim = "linear_value_head_dim"
        case linearConvKernelDim = "linear_conv_kernel_dim"
        case numExperts = "num_experts"
        case numExpertsPerTok = "num_experts_per_tok"
        case sharedExpertIntermediateSize = "shared_expert_intermediate_size"
        case moeIntermediateSize = "moe_intermediate_size"
        case normTopkProb = "norm_topk_prob"
        case rmsNormEps = "rms_norm_eps"
        case vocabularySize = "vocab_size"
        case maxPositionEmbeddings = "max_position_embeddings"
        case tieWordEmbeddings = "tie_word_embeddings"
        case attentionBias = "attention_bias"
        case hcCount = "hc_count"
        case hcLowrank = "hc_lowrank"
        case layerTypes = "layer_types"
        case fullAttentionInterval = "full_attention_interval"
        case pleLayerIds = "ple_layer_ids"
        case pleEmbedDim = "ple_embed_dim"
        case pleConvKernelSize = "ple_conv_kernel_size"
        case ngramSize = "ngram_size"
        case headsPerNgram = "heads_per_ngram"
        case ngramVocabSizeBase = "ngram_vocab_size_base"
        case makeNgramVocabSizeDivisibleBy = "make_ngram_vocab_size_divisible_by"
        case splitNgramParts = "split_ngram_parts"
        case seed
        case pleStorage = "ple_storage"
        case indexerHeads = "indexer_n_heads"
        case indexerKVHeads = "indexer_kv_heads"
        case indexerHeadDim = "indexer_head_dim"
        case indexerBudget = "indexer_budget"
        case indexerCompressRatio = "indexer_compress_ratio"
        case outputGateType = "output_gate_type"
        case hiddenAct = "hidden_act"
        case eosTokenId = "eos_token_id"
        case ropeParameters = "rope_parameters"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func fail(_ message: String) -> DecodingError {
            DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "qwen4_exp: \(message)"))
        }
        hiddenSize = try c.decode(Int.self, forKey: .hiddenSize)
        hiddenLayers = try c.decode(Int.self, forKey: .hiddenLayers)
        attentionHeads = try c.decode(Int.self, forKey: .attentionHeads)
        kvHeads = try c.decode(Int.self, forKey: .kvHeads)
        headDim = try c.decodeIfPresent(Int.self, forKey: .headDim) ?? hiddenSize / attentionHeads
        linearNumValueHeads = try c.decode(Int.self, forKey: .linearNumValueHeads)
        linearNumKeyHeads = try c.decode(Int.self, forKey: .linearNumKeyHeads)
        linearKeyHeadDim = try c.decode(Int.self, forKey: .linearKeyHeadDim)
        linearValueHeadDim = try c.decode(Int.self, forKey: .linearValueHeadDim)
        linearConvKernelDim = try c.decode(Int.self, forKey: .linearConvKernelDim)
        numExperts = try c.decode(Int.self, forKey: .numExperts)
        numExpertsPerTok = try c.decode(Int.self, forKey: .numExpertsPerTok)
        sharedExpertIntermediateSize = try c.decode(Int.self, forKey: .sharedExpertIntermediateSize)
        moeIntermediateSize = try c.decode(Int.self, forKey: .moeIntermediateSize)
        normTopkProb = try c.decodeIfPresent(Bool.self, forKey: .normTopkProb) ?? true
        rmsNormEps = try c.decode(Float.self, forKey: .rmsNormEps)
        vocabularySize = try c.decode(Int.self, forKey: .vocabularySize)
        maxPositionEmbeddings = try c.decode(Int.self, forKey: .maxPositionEmbeddings)
        tieWordEmbeddings = try c.decodeIfPresent(Bool.self, forKey: .tieWordEmbeddings) ?? false
        attentionBias = try c.decodeIfPresent(Bool.self, forKey: .attentionBias) ?? false
        hcCount = try c.decodeIfPresent(Int.self, forKey: .hcCount) ?? 4
        hcLowrank = try c.decodeIfPresent(Int.self, forKey: .hcLowrank) ?? 320
        let interval = try c.decodeIfPresent(Int.self, forKey: .fullAttentionInterval) ?? 4
        if let types = try c.decodeIfPresent([String].self, forKey: .layerTypes) {
            layerTypes = types.map { $0 == "full_attention" ? "qwen_sparse_attention" : $0 }
        } else {
            layerTypes = (0 ..< hiddenLayers).map {
                ($0 + 1) % interval == 0 ? "qwen_sparse_attention" : "linear_attention"
            }
        }
        pleLayerIds = Array(Set(try c.decodeIfPresent([Int].self, forKey: .pleLayerIds) ?? [])).sorted()
        pleEmbedDim = try c.decodeIfPresent(Int.self, forKey: .pleEmbedDim) ?? hiddenSize
        pleConvKernelSize = try c.decodeIfPresent(Int.self, forKey: .pleConvKernelSize) ?? 4
        ngramSize = try c.decodeIfPresent(Int.self, forKey: .ngramSize) ?? 3
        headsPerNgram = try c.decodeIfPresent(Int.self, forKey: .headsPerNgram) ?? 8
        ngramVocabSizeBase = try c.decodeIfPresent(Int.self, forKey: .ngramVocabSizeBase) ?? 20_000_000
        makeNgramVocabSizeDivisibleBy =
            try c.decodeIfPresent(Int.self, forKey: .makeNgramVocabSizeDivisibleBy) ?? 128
        splitNgramParts = try c.decodeIfPresent(Int.self, forKey: .splitNgramParts) ?? 128
        seed = try c.decodeIfPresent(Int.self, forKey: .seed) ?? 1234
        indexerHeads = try c.decodeIfPresent(Int.self, forKey: .indexerHeads) ?? 4
        let indexerKVHeads = try c.decodeIfPresent(Int.self, forKey: .indexerKVHeads) ?? 1
        indexerHeadDim = try c.decodeIfPresent(Int.self, forKey: .indexerHeadDim) ?? 128
        indexerBudget = try c.decodeIfPresent(Int.self, forKey: .indexerBudget) ?? 2048
        indexerCompressRatio = try c.decodeIfPresent(Int.self, forKey: .indexerCompressRatio) ?? 4
        outputGateType =
            try c.decodeIfPresent(String.self, forKey: .outputGateType)
            ?? c.decodeIfPresent(String.self, forKey: .hiddenAct) ?? "sigmoid"
        if let id = try? c.decode(Int.self, forKey: .eosTokenId) {
            eosTokenId = id
        } else if let ids = try? c.decode([Int].self, forKey: .eosTokenId) {
            eosTokenId = ids.first
        } else {
            eosTokenId = nil
        }

        let rope = try c.decodeIfPresent([String: StringOrNumber].self, forKey: .ropeParameters) ?? [:]
        if let ropeType = rope["type"] ?? rope["rope_type"] {
            guard case .string(let name) = ropeType, name == "default" else {
                throw fail("rope type \(ropeType) is not supported (only the default rope is).")
            }
        }
        ropeTheta = rope["rope_theta"]?.asFloat() ?? 10_000_000
        partialRotaryFactor = rope["partial_rotary_factor"]?.asFloat() ?? 0.25

        // The same checks the reference makes, so an unexpected checkpoint fails with its reason.
        if c.contains(.pleStorage), try !c.decodeNil(forKey: .pleStorage) {
            throw fail("external PLE storage (ple_storage) is not supported.")
        }
        guard layerTypes.count == hiddenLayers else {
            throw fail("layer_types has \(layerTypes.count) entries for \(hiddenLayers) layers.")
        }
        if let other = layerTypes.first(where: { $0 != "linear_attention" && $0 != "qwen_sparse_attention" }) {
            throw fail("layer type \(other) is not supported.")
        }
        guard hcCount > 1 else { throw fail("hc_count must be greater than 1.") }
        guard outputGateType == "sigmoid" || outputGateType == "silu" else {
            throw fail("output_gate_type must be sigmoid or silu.")
        }
        guard indexerKVHeads == 1 else { throw fail("indexer_kv_heads must be 1.") }
        guard indexerCompressRatio > 0, indexerBudget % indexerCompressRatio == 0 else {
            throw fail("indexer_budget must be divisible by indexer_compress_ratio.")
        }
        let ngramHeads = (ngramSize - 1) * headsPerNgram
        guard ngramHeads > 0, pleEmbedDim % ngramHeads == 0 else {
            throw fail("ple_embed_dim must be divisible by the number of n-gram heads.")
        }
        for id in pleLayerIds {
            guard id >= 1, id <= hiddenLayers, layerTypes[id - 1] == "linear_attention" else {
                throw fail("PLE layer \(id) must be a linear-attention layer (ids are one-indexed).")
            }
        }
        if !pleLayerIds.isEmpty, eosTokenId == nil {
            throw fail("eos_token_id is required when PLE is enabled.")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(hiddenSize, forKey: .hiddenSize)
        try c.encode(hiddenLayers, forKey: .hiddenLayers)
        try c.encode(layerTypes, forKey: .layerTypes)
    }
}

public struct Qwen4ExpConfiguration: Codable, Sendable {
    var textConfig: Qwen4ExpTextConfiguration

    enum CodingKeys: String, CodingKey {
        case textConfig = "text_config"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let text = try c.decodeIfPresent(Qwen4ExpTextConfiguration.self, forKey: .textConfig) {
            textConfig = text
        } else {
            textConfig = try Qwen4ExpTextConfiguration(from: decoder)
        }
    }
}

// MARK: - Norms

/// RMSNorm whose checkpoint gains are centered at zero: the scale is `1 + w`. Do not shift the
/// weights at load time; conversions that did (mlx-vlm issue #2041) produce noise.
final class Qwen4ExpRMSNorm: Module, UnaryLayer {
    @ParameterInfo(key: "weight") var weight: MLXArray
    let eps: Float
    let groupSize: Int?

    init(dimensions: Int, groupSize: Int? = nil, eps: Float) {
        precondition(groupSize.map { dimensions % $0 == 0 } ?? true)
        self.eps = eps
        self.groupSize = groupSize
        self._weight.wrappedValue = MLXArray.zeros([dimensions])
        super.init()
    }

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        let shape = x.shape
        var y = x.asType(.float32)
        var w = weight.asType(.float32)
        if let groupSize {
            y = y.reshaped(Array(shape.dropLast()) + [-1, groupSize])
            w = w.reshaped(-1, groupSize)
        }
        y = y * rsqrt(mean(square(y), axis: -1, keepDims: true) + eps)
        y = y * (w + 1)
        return y.reshaped(shape).asType(x.dtype)
    }
}

/// Gated RMSNorm for the Gated DeltaNet output: plain gains, sigmoid (or SiLU) gate.
final class Qwen4ExpRMSNormGated: Module {
    @ParameterInfo(key: "weight") var weight: MLXArray
    let eps: Float
    let sigmoidGate: Bool

    init(dimensions: Int, eps: Float, activation: String) {
        self.eps = eps
        self.sigmoidGate = activation == "sigmoid"
        self._weight.wrappedValue = MLXArray.ones([dimensions])
        super.init()
    }

    func callAsFunction(_ x: MLXArray, gate: MLXArray) -> MLXArray {
        let y = MLXFast.rmsNorm(x, weight: weight, eps: eps).asType(.float32)
        let g = gate.asType(.float32)
        return (y * (sigmoidGate ? sigmoid(g) : silu(g))).asType(x.dtype)
    }
}

// MARK: - Gated DeltaNet

final class Qwen4ExpGatedDeltaNet: Module {
    let numVHeads: Int
    let numKHeads: Int
    let headKDim: Int
    let headVDim: Int
    let keyDim: Int
    let convKernelSize: Int
    let convDim: Int

    @ModuleInfo(key: "conv1d") var conv1d: Conv1d
    @ModuleInfo(key: "in_proj_qkv") var inProjQKV: Linear
    @ModuleInfo(key: "in_proj_z") var inProjZ: Linear
    @ModuleInfo(key: "in_proj_b") var inProjB: Linear
    @ModuleInfo(key: "in_proj_a") var inProjA: Linear
    @ParameterInfo(key: "dt_bias") var dtBias: MLXArray
    @ParameterInfo(key: "A_log") var aLog: MLXArray
    @ModuleInfo(key: "norm") var norm: Qwen4ExpRMSNormGated
    @ModuleInfo(key: "out_proj") var outProj: Linear

    init(_ args: Qwen4ExpTextConfiguration) {
        numVHeads = args.linearNumValueHeads
        numKHeads = args.linearNumKeyHeads
        headKDim = args.linearKeyHeadDim
        headVDim = args.linearValueHeadDim
        keyDim = headKDim * numKHeads
        let valueDim = headVDim * numVHeads
        convKernelSize = args.linearConvKernelDim
        convDim = keyDim * 2 + valueDim
        _conv1d.wrappedValue = Conv1d(
            inputChannels: convDim, outputChannels: convDim, kernelSize: convKernelSize,
            groups: convDim, bias: false)
        _inProjQKV.wrappedValue = Linear(args.hiddenSize, convDim, bias: false)
        _inProjZ.wrappedValue = Linear(args.hiddenSize, valueDim, bias: false)
        _inProjB.wrappedValue = Linear(args.hiddenSize, numVHeads, bias: false)
        _inProjA.wrappedValue = Linear(args.hiddenSize, numVHeads, bias: false)
        _dtBias.wrappedValue = MLXArray.ones([numVHeads])
        _aLog.wrappedValue = log(MLXRandom.uniform(low: 1, high: 16, [numVHeads]))
        _norm.wrappedValue = Qwen4ExpRMSNormGated(
            dimensions: headVDim, eps: args.rmsNormEps, activation: args.outputGateType)
        _outProj.wrappedValue = Linear(valueDim, args.hiddenSize, bias: false)
        super.init()
    }

    /// `cache` slots: 0 = conv state, 1 = recurrent state.
    func callAsFunction(_ x: MLXArray, cache: ArraysCache?) -> MLXArray {
        let B = x.dim(0)
        let S = x.dim(1)
        let qkv = inProjQKV(x)
        let z = inProjZ(x).reshaped(B, S, numVHeads, headVDim)
        let b = inProjB(x)
        let a = inProjA(x)

        let convState = cache?[0] ?? MLXArray.zeros([B, convKernelSize - 1, convDim], dtype: x.dtype)
        let convInput = concatenated([convState, qkv], axis: 1)
        cache?[0] = contiguous(convInput[0..., (-(convKernelSize - 1))..., 0...])
        let convOut = silu(conv1d(convInput))

        let parts = MLX.split(convOut, indices: [keyDim, 2 * keyDim], axis: -1)
        var q = parts[0].reshaped(B, S, numKHeads, headKDim)
        var k = parts[1].reshaped(B, S, numKHeads, headKDim)
        let v = parts[2].reshaped(B, S, numVHeads, headVDim)
        // L2 normalization with the epsilon after the sum (as Transformers/FLA), then 1/sqrt(d) on q.
        let queryScale: Float = 1 / Float(headKDim).squareRoot()
        q = q * rsqrt(sum(square(q), axis: -1, keepDims: true) + 1e-6) * queryScale
        k = k * rsqrt(sum(square(k), axis: -1, keepDims: true) + 1e-6)

        let (out, state) = gatedDeltaUpdate(
            q: q, k: k, v: v, a: a, b: b, aLog: aLog, dtBias: dtBias, state: cache?[1], mask: nil)
        if let cache {
            cache[1] = state
            cache.offset += S
        }
        return outProj(norm(out, gate: z).reshaped(B, S, -1))
    }
}

// MARK: - Qwen Sparse Attention

/// Scores compressed key blocks and returns which tokens each query may attend: the top
/// `budget / ratio` blocks plus the tokens after the last complete block. A query that sees at
/// most that many complete blocks attends causally.
final class Qwen4ExpQSAIndexer: Module {
    let heads: Int
    let headDim: Int
    let ratio: Int
    let topK: Int
    /// Queries scored per pass, which bounds the [heads, queries, blocks] score tensor.
    private let scoreChunk = 128

    @ModuleInfo(key: "index_qk_proj") var indexQKProj: Linear
    @ModuleInfo(key: "q_layernorm") var qLayerNorm: Qwen4ExpRMSNorm
    @ModuleInfo(key: "k_layernorm") var kLayerNorm: Qwen4ExpRMSNorm

    init(_ args: Qwen4ExpTextConfiguration) {
        heads = args.indexerHeads
        headDim = args.indexerHeadDim
        ratio = args.indexerCompressRatio
        topK = args.indexerBudget / args.indexerCompressRatio
        _indexQKProj.wrappedValue = Linear(args.hiddenSize, (heads + 1) * headDim, bias: false)
        _qLayerNorm.wrappedValue = Qwen4ExpRMSNorm(dimensions: headDim, eps: args.rmsNormEps)
        _kLayerNorm.wrappedValue = Qwen4ExpRMSNorm(dimensions: headDim, eps: args.rmsNormEps)
        super.init()
    }

    enum Selection {
        /// A single-token step that sees at most `topK` complete blocks: plain attention.
        case dense
        /// Every query sees at most `topK` complete blocks: causal attention.
        case causal
        /// Boolean [B, 1, L, keyLength] mask of the tokens each query attends.
        case mask(MLXArray)
    }

    /// Must run before the attention layer writes this step's keys, so `cache.offset` is the past length.
    func select(
        _ x: MLXArray, cache: QSAKVCache?, rope: (MLXArray, Int, Float) -> MLXArray
    ) -> Selection {
        let B = x.dim(0)
        let L = x.dim(1)
        let past = cache?.offset ?? 0
        let qk = indexQKProj(x).reshaped(B, L, heads + 1, headDim)
        let query = qLayerNorm(qk[0..., 0..., ..<heads, 0...]).transposed(0, 2, 1, 3)
        let raw = qk[0..., 0..., heads ..< (heads + 1), 0...].transposed(0, 2, 1, 3)  // [B, 1, L, D]
        let keys = cache?.appendIndexKeys(raw) ?? raw
        let keyLength = keys.dim(2)
        let blocks = keyLength / ratio
        if L == 1 && blocks <= topK { return .dense }

        // Pooled keys of the complete blocks: mean (in float32) of each block's raw keys,
        // normalized, rotated to the position of the block's first token.
        let stored = cache?.blockKeys(ratio: ratio).flatMap { $0.dim(2) <= blocks ? $0 : nil }
        let first = stored?.dim(2) ?? 0
        var pooled = stored ?? MLXArray.zeros([B, 1, 0, headDim], dtype: keys.dtype)
        if blocks > first {
            let tokens = keys[.ellipsis, (first * ratio) ..< (blocks * ratio), 0...]
                .reshaped(B, 1, blocks - first, ratio, headDim)
            var fresh = mean(tokens.asType(.float32), axis: 3).asType(keys.dtype)
            fresh = rope(kLayerNorm(fresh), first, Float(ratio))
            cache?.appendBlockKeys(fresh, ratio: ratio)
            pooled = first > 0 ? concatenated([pooled, fresh], axis: 2) : fresh
        }

        let completeAtEnd = (past + L) / ratio
        if completeAtEnd <= topK { return .causal }

        let rotated = rope(query, past, 1)
        let pooledT = pooled.asType(.float32).transposed(0, 1, 3, 2)
        let blockIds = MLXArray((0 ..< blocks).map { Int32($0) })
        let offsets = MLXArray((0 ..< ratio).map { Int32($0) })
        let tokenIds = MLXArray((0 ..< keyLength).map { Int32($0) })
        var masks: [MLXArray] = []
        var start = 0
        while start < L {
            let end = min(L, start + scoreChunk)
            let n = end - start
            let ends = (past + start + 1) ... (past + end)
            let queryEnds = MLXArray(ends.map { Int32($0) })  // [n]
            let complete = MLXArray(ends.map { Int32($0 / ratio) })  // complete blocks each query sees
            // Scores in float32, as the reference: which blocks win is a discrete choice.
            var scores = matmul(rotated[0..., 0..., start ..< end, 0...].asType(.float32), pooledT)
            scores = sum(maximum(scores, 0), axis: 1) / sqrt(Float(headDim))  // [B, n, blocks]
            let valid = blockIds[.newAxis, .newAxis, 0...] .< complete[.newAxis, 0..., .newAxis]
            scores = MLX.where(valid, scores, MLXArray(-Float.infinity))
            if blocks < topK {
                scores = padded(scores, widths: [0, 0, [0, topK - blocks]], value: MLXArray(-Float.infinity))
            }
            var selected = argPartition(scores, kth: -topK, axis: -1)[.ellipsis, (-topK)...]
                .asType(.int32)  // [B, n, topK]
            selected = MLX.where(selected .< complete[.newAxis, 0..., .newAxis], selected, MLXArray(Int32(-1)))

            // Scatter the winning blocks onto the token axis; slot keyLength takes the misses.
            let picked = (selected[.ellipsis, .newAxis] * Int32(ratio) + offsets).reshaped(B, n, topK * ratio)
            let hit = (picked .>= 0) .&& (picked .< Int32(keyLength))
            let slots = MLX.where(hit, picked, MLXArray(Int32(keyLength)))
            let chosen = putAlong(
                MLXArray.zeros([B, n, keyLength + 1], dtype: .bool), slots, values: hit, axis: -1
            )[.ellipsis, ..<keyLength]

            let endColumn = queryEnds[0..., .newAxis]
            let tail = (tokenIds[.newAxis, 0...] .>= (complete * Int32(ratio))[0..., .newAxis]) .&& (tokenIds[.newAxis, 0...] .< endColumn)
            let causal = tokenIds[.newAxis, 0...] .< endColumn
            let sparse = (complete .> Int32(topK))[0..., .newAxis]
            masks.append(MLX.where(sparse, chosen .|| tail, causal))
            start = end
        }
        let mask = masks.count == 1 ? masks[0] : concatenated(masks, axis: 1)
        return .mask(mask[0..., .newAxis, 0..., 0...])
    }
}

final class Qwen4ExpAttention: Module {
    let heads: Int
    let kvHeads: Int
    let scale: Float
    let ropeDims: Int
    let ropeTheta: Float

    @ModuleInfo(key: "q_proj") var qProj: Linear
    @ModuleInfo(key: "k_proj") var kProj: Linear
    @ModuleInfo(key: "v_proj") var vProj: Linear
    @ModuleInfo(key: "o_proj") var oProj: Linear
    @ModuleInfo(key: "q_norm") var qNorm: Qwen4ExpRMSNorm
    @ModuleInfo(key: "k_norm") var kNorm: Qwen4ExpRMSNorm
    @ModuleInfo(key: "indexer") var indexer: Qwen4ExpQSAIndexer

    init(_ args: Qwen4ExpTextConfiguration) {
        heads = args.attentionHeads
        kvHeads = args.kvHeads
        scale = pow(Float(args.headDim), -0.5)
        ropeDims = max(1, Int(Float(args.headDim) * args.partialRotaryFactor))
        ropeTheta = args.ropeTheta
        _qProj.wrappedValue = Linear(args.hiddenSize, heads * args.headDim * 2, bias: args.attentionBias)
        _kProj.wrappedValue = Linear(args.hiddenSize, kvHeads * args.headDim, bias: args.attentionBias)
        _vProj.wrappedValue = Linear(args.hiddenSize, kvHeads * args.headDim, bias: args.attentionBias)
        _oProj.wrappedValue = Linear(heads * args.headDim, args.hiddenSize, bias: args.attentionBias)
        _qNorm.wrappedValue = Qwen4ExpRMSNorm(dimensions: args.headDim, eps: args.rmsNormEps)
        _kNorm.wrappedValue = Qwen4ExpRMSNorm(dimensions: args.headDim, eps: args.rmsNormEps)
        _indexer.wrappedValue = Qwen4ExpQSAIndexer(args)
        super.init()
    }

    /// Text positions in all three MRoPE sections are equal, so MRoPE is the plain partial rope.
    /// Positions are `(offset + i) * scale`.
    func rope(_ x: MLXArray, offset: Int, scale positionScale: Float) -> MLXArray {
        MLXFast.RoPE(
            x, dimensions: ropeDims, traditional: false, base: ropeTheta, scale: positionScale,
            offset: offset)
    }

    func callAsFunction(_ x: MLXArray, cache: QSAKVCache?) -> MLXArray {
        let B = x.dim(0)
        let L = x.dim(1)
        let past = cache?.offset ?? 0
        let selection = indexer.select(x, cache: cache) { [self] in rope($0, offset: $1, scale: $2) }

        let projected = qProj(x).reshaped(B, L, heads, -1).split(parts: 2, axis: -1)
        let gate = projected[1].reshaped(B, L, -1)
        var queries = qNorm(projected[0]).transposed(0, 2, 1, 3)
        var keys = kNorm(kProj(x).reshaped(B, L, kvHeads, -1)).transposed(0, 2, 1, 3)
        var values = vProj(x).reshaped(B, L, kvHeads, -1).transposed(0, 2, 1, 3)
        queries = rope(queries, offset: past, scale: 1)
        keys = rope(keys, offset: past, scale: 1)
        if let cache { (keys, values) = cache.update(keys: keys, values: values) }

        let mask: MLXFast.ScaledDotProductAttentionMaskMode
        switch selection {
        case .dense: mask = L > 1 ? .causal : .none
        case .causal: mask = .causal
        case .mask(let array): mask = .array(array)
        }
        let output = MLXFast.scaledDotProductAttention(
            queries: queries, keys: keys, values: values, scale: scale, mask: mask)
        return oProj(output.transposed(0, 2, 1, 3).reshaped(B, L, -1) * sigmoid(gate))
    }
}

// MARK: - Hyper-connections

/// Reads the `hc_count` residual streams into one branch input and, unless it is the final mixer,
/// gives the per-stream weights the branch output is added back with.
final class Qwen4ExpGatedResidual: Module {
    let hcCount: Int
    let hidden: Int

    @ModuleInfo(key: "hc_norm") var hcNorm: Qwen4ExpRMSNorm
    @ModuleInfo(key: "input_mix_weight_down") var mixDown: Linear
    @ModuleInfo(key: "input_mix_weight_up") var mixUp: Linear
    @ModuleInfo(key: "block_inject_weight") var inject: Linear?

    init(_ args: Qwen4ExpTextConfiguration, combine: Bool = true) {
        hcCount = args.hcCount
        hidden = args.hiddenSize
        let width = hcCount * hidden
        _hcNorm.wrappedValue = Qwen4ExpRMSNorm(dimensions: width, groupSize: hidden, eps: args.rmsNormEps)
        _mixDown.wrappedValue = Linear(width, args.hcLowrank, bias: false)
        _mixUp.wrappedValue = Linear(args.hcLowrank, width, bias: false)
        if combine { _inject.wrappedValue = Linear(width, hcCount, bias: false) }
        super.init()
    }

    func callAsFunction(_ streams: MLXArray) -> (input: MLXArray, weights: MLXArray?) {
        let normed = hcNorm(streams)
        let lead = Array(normed.shape.dropLast())
        let mix = silu(mixDown(normed) / Float(hcCount))
        let gates = sigmoid(mixUp(mix)).reshaped(lead + [hcCount, hidden])
        let input = mean(gates * normed.reshaped(lead + [hcCount, hidden]), axis: -2)
        let weights = inject.map { 2 * sigmoid($0(normed) / Float(hcCount)) }
        return (input, weights)
    }

    /// Adds `branch` ([..., hidden]) to every stream, scaled by that stream's weight.
    static func add(_ branch: MLXArray, to streams: MLXArray, weights: MLXArray) -> MLXArray {
        streams + (branch[.ellipsis, .newAxis, 0...] * weights[.ellipsis, .newAxis]).reshaped(streams.shape)
    }
}

// MARK: - MoE

final class Qwen4ExpSparseMoeBlock: Module, UnaryLayer {
    let topK: Int
    let normTopkProb: Bool

    @ModuleInfo(key: "gate") var gate: Linear
    @ModuleInfo(key: "switch_mlp") var switchMLP: SwitchGLU
    @ModuleInfo(key: "shared_expert") var sharedExpert: Qwen3NextMLP
    @ModuleInfo(key: "shared_expert_gate") var sharedExpertGate: Linear

    init(_ args: Qwen4ExpTextConfiguration) {
        topK = args.numExpertsPerTok
        normTopkProb = args.normTopkProb
        _gate.wrappedValue = Linear(args.hiddenSize, args.numExperts, bias: false)
        _switchMLP.wrappedValue = SwitchGLU(
            inputDims: args.hiddenSize, hiddenDims: args.moeIntermediateSize, numExperts: args.numExperts)
        _sharedExpert.wrappedValue = Qwen3NextMLP(
            dimensions: args.hiddenSize, hiddenDimensions: args.sharedExpertIntermediateSize)
        _sharedExpertGate.wrappedValue = Linear(args.hiddenSize, 1, bias: false)
        super.init()
    }

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        let gates = softmax(gate(x), axis: -1, precise: true)
        let indices = argPartition(gates, kth: -topK, axis: -1)[.ellipsis, (-topK)...]
        var scores = takeAlong(gates, indices, axis: -1)
        if normTopkProb { scores = scores / scores.sum(axis: -1, keepDims: true) }
        let routed = (switchMLP(x, indices) * scores[.ellipsis, .newAxis]).sum(axis: -2)
        return routed + sigmoid(sharedExpertGate(x)) * sharedExpert(x)
    }
}

// MARK: - PLE n-gram embedding

/// An embedding kept in row shards as the checkpoint stores it (the full table is ~100 GB).
final class Qwen4ExpShardedEmbedding: Module {
    @ModuleInfo(key: "shards") var shards: [Embedding]
    let starts: [Int]
    let dims: Int

    init(rows: Int, dims: Int, parts: Int) {
        precondition(parts > 0 && parts <= rows)
        let base = rows / parts
        let extra = rows % parts
        let sizes = (0 ..< parts).map { base + ($0 < extra ? 1 : 0) }
        var starts = [0]
        for size in sizes { starts.append(starts.last! + size) }
        self.starts = starts
        self.dims = dims
        _shards.wrappedValue = sizes.map { Embedding(embeddingCount: $0, dimensions: dims) }
        super.init()
    }

    /// Rows for `ids` (global row numbers), [ids.count, dims], in order.
    func callAsFunction(_ ids: [Int]) -> MLXArray {
        var groups = [Int: (positions: [Int], local: [Int32])]()
        for (position, id) in ids.enumerated() {
            precondition(id >= 0 && id < starts.last!, "PLE row \(id) is outside the table")
            var low = 0
            var high = starts.count - 1
            while high - low > 1 {
                let mid = (low + high) / 2
                if starts[mid] <= id { low = mid } else { high = mid }
            }
            groups[low, default: ([], [])].positions.append(position)
            groups[low, default: ([], [])].local.append(Int32(id - starts[low]))
        }
        var parts: [MLXArray] = []
        var order: [Int] = []
        for shard in groups.keys.sorted() {
            let group = groups[shard]!
            parts.append(shards[shard](MLXArray(group.local)))
            order.append(contentsOf: group.positions)
        }
        let rows = parts.count == 1 ? parts[0] : concatenated(parts, axis: 0)
        var inverse = [Int32](repeating: 0, count: order.count)
        for (row, position) in order.enumerated() { inverse[position] = Int32(row) }
        return rows[MLXArray(inverse)]
    }
}

/// Hashes the 2..n-gram ending at each token into `heads_per_ngram` tables per n and concatenates
/// the rows. Context before the prompt, and context across an end-of-sequence token, is EOS.
final class Qwen4ExpNGramEmbedding: Module {
    let ngramSize: Int
    let contextLength: Int
    let headsPerNgram: Int
    let eos: Int64

    @ParameterInfo(key: "layer_multipliers") var layerMultipliers: MLXArray
    @ParameterInfo(key: "ngram_heads_vocab_sizes") var headSizes: MLXArray
    @ParameterInfo(key: "ngram_heads_offsets") var headOffsets: MLXArray
    @ModuleInfo(key: "ngram_embedding") var table: Qwen4ExpShardedEmbedding

    /// Host copies of the three tables above, read once after the weights are loaded. A plain
    /// class, so module reflection does not take it for parameters.
    private final class HostTables {
        var value: (multipliers: [Int64], sizes: [Int64], offsets: [Int64])?
    }
    private let host = HostTables()

    init(_ args: Qwen4ExpTextConfiguration, pleIndex: Int) {
        ngramSize = args.ngramSize
        contextLength = args.ngramSize - 1
        headsPerNgram = args.headsPerNgram
        eos = Int64(args.eosTokenId ?? 0)
        let heads = contextLength * headsPerNgram
        var sizes: [Int64] = []
        var offsets: [Int64] = []
        var total: Int64 = 0
        for head in 0 ..< heads {
            let size = Int64(Self.nthPrime(after: args.ngramVocabSizeBase - 1, count: pleIndex * heads + head + 1))
            sizes.append(size)
            offsets.append(total)
            total += size
        }
        let divisor = Int64(args.makeNgramVocabSizeDivisibleBy)
        let rows = (total + divisor - 1) / divisor * divisor
        _layerMultipliers.wrappedValue = MLXArray(
            Self.multipliers(vocabulary: args.vocabularySize, count: ngramSize, pleIndex: pleIndex, seed: args.seed))
        _headSizes.wrappedValue = MLXArray(sizes)
        _headOffsets.wrappedValue = MLXArray(offsets)
        _table.wrappedValue = Qwen4ExpShardedEmbedding(
            rows: Int(rows), dims: args.pleEmbedDim / heads, parts: args.splitNgramParts)
        super.init()
    }

    private static func splitmix64(_ value: UInt64) -> UInt64 {
        var z = value &+ 0x9E37_79B9_7F4A_7C15
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }

    static func multipliers(vocabulary: Int, count: Int, pleIndex: Int, seed: Int) -> [Int64] {
        let limit = UInt64(Int64.max) / UInt64(max(vocabulary, 1))
        let half = max(1, limit / 2)
        let base = UInt64(bitPattern: Int64(seed + 10007 * pleIndex))
        return (0 ..< count).map { index in
            let value = base &+ 0x9E37_79B9_7F4A_7C15 &* UInt64(index + 1)
            return Int64(2 * (splitmix64(value) % half) + 1)
        }
    }

    static func nthPrime(after start: Int, count: Int) -> Int {
        func isPrime(_ n: Int) -> Bool {
            if n < 2 { return false }
            if n % 2 == 0 { return n == 2 }
            var d = 3
            while d * d <= n {
                if n % d == 0 { return false }
                d += 2
            }
            return true
        }
        var prime = start
        for _ in 0 ..< count {
            prime += 1
            while !isPrime(prime) { prime += 1 }
        }
        return prime
    }

    private func tables() -> (multipliers: [Int64], sizes: [Int64], offsets: [Int64]) {
        if let value = host.value { return value }
        let read = (
            layerMultipliers.asType(.int64).asArray(Int64.self),
            headSizes.asType(.int64).asArray(Int64.self),
            headOffsets.asType(.int64).asArray(Int64.self))
        host.value = read
        return read
    }

    /// `cache` slot 3 keeps the last `ngram_size - 1` tokens. Returns [B, L, ple_embed_dim].
    func callAsFunction(_ tokens: MLXArray, cache: ArraysCache?) -> MLXArray {
        let B = tokens.dim(0)
        let L = tokens.dim(1)
        let (multipliers, sizes, offsets) = tables()
        let ids = tokens.asType(.int64).asArray(Int64.self)
        let previous = cache?[3]?.asType(.int64).asArray(Int64.self)
        var rows: [Int] = []
        rows.reserveCapacity(B * L * sizes.count)
        var nextContext: [Int64] = []
        for batch in 0 ..< B {
            let context = previous.map { Array($0[(batch * contextLength) ..< ((batch + 1) * contextLength)]) }
                ?? Array(repeating: eos, count: contextLength)
            let history = context + Array(ids[(batch * L) ..< ((batch + 1) * L)])
            nextContext.append(contentsOf: history.suffix(contextLength))
            var lastEOS = -1  // the last EOS strictly before the current position
            for position in 0 ..< history.count {
                defer { if history[position] == eos { lastEOS = position } }
                guard position >= contextLength else { continue }
                // shifted[s] is the token s back, or EOS when an EOS lies between it and this one.
                let shifted = (0 ..< ngramSize).map { shift -> Int64 in
                    let source = position - shift
                    return source >= 0 && position - (lastEOS + 1) >= shift ? history[source] : eos
                }
                for n in 2 ... ngramSize {
                    var mixed = shifted[0] &* multipliers[0]
                    for k in 1 ..< n { mixed ^= shifted[k] &* multipliers[k] }
                    for head in ((n - 2) * headsPerNgram) ..< ((n - 1) * headsPerNgram) {
                        rows.append(Int(mixed % sizes[head] + offsets[head]))
                    }
                }
            }
        }
        if let cache { cache[3] = MLXArray(nextContext, [B, contextLength]) }
        return table(rows).reshaped(B, L, -1)
    }
}

final class Qwen4ExpPLELayer: Module {
    let hcCount: Int
    let hidden: Int
    let stateLength: Int

    @ModuleInfo(key: "ple_embedding") var embedding: Qwen4ExpNGramEmbedding
    @ModuleInfo(key: "key_proj") var keyProj: Linear
    @ModuleInfo(key: "value_proj") var valueProj: Linear
    @ModuleInfo(key: "norm_key") var normKey: Qwen4ExpRMSNorm
    @ModuleInfo(key: "norm_query") var normQuery: Qwen4ExpRMSNorm
    @ModuleInfo(key: "norm_conv") var normConv: Qwen4ExpRMSNorm
    @ModuleInfo(key: "conv1d") var conv1d: Conv1d

    init(_ args: Qwen4ExpTextConfiguration, pleIndex: Int) {
        hcCount = args.hcCount
        hidden = args.hiddenSize
        let width = hcCount * hidden
        stateLength = (args.pleConvKernelSize - 1) * args.ngramSize
        _embedding.wrappedValue = Qwen4ExpNGramEmbedding(args, pleIndex: pleIndex)
        _keyProj.wrappedValue = Linear(args.pleEmbedDim, width, bias: false)
        _valueProj.wrappedValue = Linear(args.pleEmbedDim, hidden, bias: false)
        _normKey.wrappedValue = Qwen4ExpRMSNorm(dimensions: width, groupSize: hidden, eps: args.rmsNormEps)
        _normQuery.wrappedValue = Qwen4ExpRMSNorm(dimensions: width, groupSize: hidden, eps: args.rmsNormEps)
        _normConv.wrappedValue = Qwen4ExpRMSNorm(dimensions: width, groupSize: hidden, eps: args.rmsNormEps)
        _conv1d.wrappedValue = Conv1d(
            inputChannels: width, outputChannels: width, kernelSize: args.pleConvKernelSize,
            dilation: args.ngramSize, groups: width, bias: false)
        super.init()
    }

    /// `cache` slots: 2 = short-conv state, 3 = n-gram context (slots 0 and 1 are the layer's DeltaNet).
    func callAsFunction(_ streams: MLXArray, tokens: MLXArray, cache: ArraysCache?) -> MLXArray {
        let B = streams.dim(0)
        let L = streams.dim(1)
        let rows = embedding(tokens, cache: cache)
        let keys = normKey(keyProj(rows)).reshaped(B, L, hcCount, hidden)
        let values = valueProj(rows)
        let queries = normQuery(streams).reshaped(B, L, hcCount, hidden)
        var gate = sum(keys * queries, axis: -1, keepDims: true) / sqrt(Float(hidden))
        gate = sign(gate) * sqrt(maximum(abs(gate), 1e-6))
        let gated = (sigmoid(gate) * values[0..., 0..., .newAxis, 0...]).reshaped(streams.shape)
        let normed = normConv(gated)
        let state = cache?[2] ?? MLXArray.zeros([B, stateLength, normed.dim(-1)], dtype: normed.dtype)
        let convInput = concatenated([state, normed], axis: 1)
        cache?[2] = contiguous(convInput[0..., (-stateLength)..., 0...])
        return gated + silu(conv1d(convInput))
    }
}

// MARK: - Decoder

final class Qwen4ExpDecoderLayer: Module {
    let isLinear: Bool

    @ModuleInfo(key: "linear_attn") var linearAttn: Qwen4ExpGatedDeltaNet?
    @ModuleInfo(key: "self_attn") var selfAttn: Qwen4ExpAttention?
    @ModuleInfo(key: "mlp") var mlp: Qwen4ExpSparseMoeBlock
    @ModuleInfo(key: "ple") var ple: Qwen4ExpPLELayer?
    @ModuleInfo(key: "attn_hyper_connection") var attnHyper: Qwen4ExpGatedResidual
    @ModuleInfo(key: "mlp_hyper_connection") var mlpHyper: Qwen4ExpGatedResidual

    init(_ args: Qwen4ExpTextConfiguration, layer: Int) {
        isLinear = args.layerTypes[layer] == "linear_attention"
        if isLinear {
            _linearAttn.wrappedValue = Qwen4ExpGatedDeltaNet(args)
        } else {
            _selfAttn.wrappedValue = Qwen4ExpAttention(args)
        }
        _mlp.wrappedValue = Qwen4ExpSparseMoeBlock(args)
        if let pleIndex = args.pleLayerIds.firstIndex(of: layer + 1) {
            _ple.wrappedValue = Qwen4ExpPLELayer(args, pleIndex: pleIndex)
        }
        _attnHyper.wrappedValue = Qwen4ExpGatedResidual(args)
        _mlpHyper.wrappedValue = Qwen4ExpGatedResidual(args)
        super.init()
    }

    func callAsFunction(_ streams: MLXArray, tokens: MLXArray, cache: KVCache?) -> MLXArray {
        var streams = streams
        if let ple { streams = streams + ple(streams, tokens: tokens, cache: cache as? ArraysCache) }

        let attention = attnHyper(streams)
        let branch =
            isLinear
            ? linearAttn!(attention.input, cache: cache as? ArraysCache)
            : selfAttn!(attention.input, cache: cache as? QSAKVCache)
        streams = Qwen4ExpGatedResidual.add(branch, to: streams, weights: attention.weights!)

        let moe = mlpHyper(streams)
        return Qwen4ExpGatedResidual.add(mlp(moe.input), to: streams, weights: moe.weights!)
    }
}

public class Qwen4ExpTextModelInner: Module {
    let hcCount: Int

    @ModuleInfo(key: "embed_tokens") var embedTokens: Embedding
    fileprivate let layers: [Qwen4ExpDecoderLayer]
    @ModuleInfo(key: "hyper_connection_mixer") var mixer: Qwen4ExpGatedResidual

    init(_ args: Qwen4ExpTextConfiguration) {
        hcCount = args.hcCount
        _embedTokens.wrappedValue = Embedding(embeddingCount: args.vocabularySize, dimensions: args.hiddenSize)
        layers = (0 ..< args.hiddenLayers).map { Qwen4ExpDecoderLayer(args, layer: $0) }
        _mixer.wrappedValue = Qwen4ExpGatedResidual(args, combine: false)
        super.init()
    }

    func callAsFunction(_ tokens: MLXArray, cache: [KVCache]?) -> MLXArray {
        var streams = tiled(embedTokens(tokens), repetitions: [1, 1, hcCount])
        for (index, layer) in layers.enumerated() {
            streams = layer(streams, tokens: tokens, cache: cache?[index])
        }
        return mixer(streams).input
    }
}

public class Qwen4ExpTextModel: Module, LLMModel, KVCacheDimensionProvider {
    public let vocabularySize: Int
    public let kvHeads: [Int]
    let configuration: Qwen4ExpTextConfiguration

    @ModuleInfo(key: "model") var model: Qwen4ExpTextModelInner
    @ModuleInfo(key: "lm_head") var lmHead: Linear?

    public init(_ args: Qwen4ExpTextConfiguration) {
        configuration = args
        vocabularySize = args.vocabularySize
        kvHeads = (0 ..< args.hiddenLayers).map { _ in args.kvHeads }
        _model.wrappedValue = Qwen4ExpTextModelInner(args)
        if !args.tieWordEmbeddings {
            _lmHead.wrappedValue = Linear(args.hiddenSize, args.vocabularySize, bias: false)
        }
        super.init()
    }

    public func callAsFunction(_ inputs: MLXArray, cache: [KVCache]?) -> MLXArray {
        let hidden = model(inputs, cache: cache)
        return lmHead.map { $0(hidden) } ?? model.embedTokens.asLinear(hidden)
    }

    /// Linear-attention layers keep a fixed state ([conv, recurrent], plus [PLE conv, n-gram
    /// context] on a PLE layer); sparse-attention layers keep keys, values and the indexer's keys.
    public func newCache(parameters: GenerateParameters?) throws -> [KVCache] {
        model.layers.map { layer -> KVCache in
            layer.isLinear ? ArraysCache(size: layer.ple == nil ? 2 : 4) : QSAKVCache()
        }
    }
}

extension Qwen4ExpTextModel: LoRAModel {
    public var loraLayers: [Module] { model.layers }
}

// MARK: - Top-level model

public class Qwen4ExpModel: Module, LLMModel, KVCacheDimensionProvider {
    public let vocabularySize: Int
    public let kvHeads: [Int]
    let tieWordEmbeddings: Bool

    @ModuleInfo(key: "language_model") var languageModel: Qwen4ExpTextModel

    public init(_ args: Qwen4ExpConfiguration) {
        let text = Qwen4ExpTextModel(args.textConfig)
        vocabularySize = text.vocabularySize
        kvHeads = text.kvHeads
        tieWordEmbeddings = args.textConfig.tieWordEmbeddings
        _languageModel.wrappedValue = text
        super.init()
    }

    public func callAsFunction(_ inputs: MLXArray, cache: [KVCache]?) -> MLXArray {
        languageModel(inputs, cache: cache)
    }

    public func newCache(parameters: GenerateParameters?) throws -> [KVCache] {
        try languageModel.newCache(parameters: parameters)
    }

    /// Drops the vision tower and the MTP head; maps raw-checkpoint names onto the converted layout.
    public func sanitize(weights: [String: MLXArray]) -> [String: MLXArray] {
        var sanitized = [String: MLXArray]()
        for (key, value) in weights {
            if key.hasPrefix("vision_tower") || key.hasPrefix("model.visual") || key.hasPrefix("mtp.")
                || key.contains(".mtp.")
            {
                continue
            }
            var key = key
            if key.hasPrefix("model.language_model") {
                key = key.replacingOccurrences(of: "model.language_model", with: "language_model.model")
            } else if !key.hasPrefix("language_model.") {
                key = "language_model." + key
            }
            key = key.replacingOccurrences(
                of: #"\.ngram_embedding\.shard_(\d+)\."#, with: ".ngram_embedding.shards.$1.",
                options: .regularExpression)
            var value = value
            if key.contains("conv1d.weight") && value.dim(-1) != 1 {
                value = value.movedAxis(source: 2, destination: 1)
            }
            sanitized[key] = value
        }
        if tieWordEmbeddings { sanitized["language_model.lm_head.weight"] = nil }
        return sanitized
    }
}

extension Qwen4ExpModel: LoRAModel {
    public var loraLayers: [Module] { languageModel.model.layers }
}

// MARK: - Chat conventions

extension Qwen4ExpModel {
    public var toolCallFormat: ToolCallFormat? { .qwen35 }
    public var reasoningConfig: ReasoningConfig? { QwenReasoningProtocol.tagged }
}

extension Qwen4ExpTextModel {
    public var toolCallFormat: ToolCallFormat? { .qwen35 }
    public var reasoningConfig: ReasoningConfig? { QwenReasoningProtocol.tagged }
}
