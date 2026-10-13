import Foundation

public enum PCM {
    /// Signed 16-bit little-endian, one channel. NaN/Infinity are silenced.
    public static func linear16(_ samples: [Float]) -> Data {
        var result = Data(capacity: samples.count * 2)
        for sample in samples {
            let value = sample.isFinite ? max(-1, min(1, sample)) : 0
            let integer = Int16(value < 0 ? value * 32768 : value * 32767)
            var littleEndian = integer.littleEndian
            withUnsafeBytes(of: &littleEndian) { result.append(contentsOf: $0) }
        }
        return result
    }
    public static func rms(_ samples: [Float]) -> Float {
        guard !samples.isEmpty else { return 0 }
        let squared = samples.reduce(Float(0)) { $0 + ($1.isFinite ? $1 * $1 : 0) }
        return min(1, sqrt(squared / Float(samples.count)))
    }
}

public struct DeepgramSegment: Equatable, Sendable {
    public var text: String
    public var speaker: Int?
    public var start: Double
}
public struct DeepgramResult: Equatable, Sendable {
    public var final: Bool
    public var speechFinal: Bool
    public var start: Double
    public var duration: Double
    public var segments: [DeepgramSegment]
    public var key: String { "\(start):\(duration)" }
    public static func decode(_ data: Data) throws -> DeepgramResult? {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any], let type = object["type"] as? String else { return nil }
        if type == "Error" { throw WatsonError.message(object["description"] as? String ?? "Transcription provider reported an error.") }
        if type == "UtteranceEnd" { return DeepgramResult(final: true, speechFinal: true, start: object["last_word_end"] as? Double ?? 0, duration: 0, segments: []) }
        guard type == "Results", let channel = object["channel"] as? [String: Any], let alternatives = channel["alternatives"] as? [[String: Any]], let best = alternatives.first, let text = best["transcript"] as? String else { return nil }
        let start = object["start"] as? Double ?? 0
        var segments: [DeepgramSegment] = []
        let words = best["words"] as? [[String: Any]] ?? []
        for word in words {
            let value = word["punctuated_word"] as? String ?? word["word"] as? String ?? ""
            guard !value.isEmpty else { continue }
            let speaker = word["speaker"] as? Int
            if let last = segments.last, last.speaker == speaker { segments[segments.count - 1].text += " " + value }
            else { segments.append(DeepgramSegment(text: value, speaker: speaker, start: word["start"] as? Double ?? start)) }
        }
        if segments.isEmpty, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { segments = [DeepgramSegment(text: text, speaker: nil, start: start)] }
        return DeepgramResult(final: object["is_final"] as? Bool ?? false, speechFinal: object["speech_final"] as? Bool ?? false, start: start, duration: object["duration"] as? Double ?? 0, segments: segments)
    }
}

public struct TranscriptAccumulator {
    public private(set) var interim: [TranscriptLine] = []
    private var committed = Set<String>()
    public var origin: Date
    public var runID: String
    public init(origin: Date = Date(), runID: String = UUID().uuidString) { self.origin = origin; self.runID = runID }
    public mutating func receive(_ result: DeepgramResult) -> [TranscriptLine] {
        let lines = result.segments.enumerated().map { index, segment in
            TranscriptLine(id: "\(runID):\(result.key):\(index)", text: segment.text, timestamp: WatsonTime.string(origin.addingTimeInterval(segment.start)), final: result.final, speaker: segment.speaker)
        }
        if !result.final { interim = lines; return [] }
        interim = []
        guard committed.insert(result.key).inserted else { return [] }
        return lines
    }
}
