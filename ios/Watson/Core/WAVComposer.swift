import Foundation
import AVFoundation

public struct ComposedRecording: Sendable {
    public var file: URL
    public var frames: Int64
    public var segmentCount: Int
    public var seconds: Double { Double(frames) / 16000 }
}

public enum WAVComposer {
    /// Decodes every complete CAF in manifest order and streams PCM16 mono/16k into
    /// one WAV. Paused wall-clock intervals are omitted. Original files are untouched.
    public static func compose(_ segments: [URL], output: URL, maximumBytes: Int = RecordingFile.maximumBytes) throws -> ComposedRecording {
        guard !segments.isEmpty else { throw WatsonError.message("This conversation has no saved audio segments.") }
        guard maximumBytes > 44 else { throw WatsonError.message("The server’s recording size limit is too small.") }
        guard output.isFileURL, !segments.contains(where: { $0.standardizedFileURL == output.standardizedFileURL }) else { throw WatsonError.message("Choose a separate destination for the complete recording.") }
        guard FileManager.default.createFile(atPath: output.path, contents: header(dataBytes: 0)) else { throw WatsonError.message("The complete recording could not be created.") }
        let handle = try FileHandle(forWritingTo: output)
        var completed = false
        defer { try? handle.close(); if !completed { try? FileManager.default.removeItem(at: output) } }
        try handle.seekToEnd()
        var dataBytes = 0
        func append(_ bytes: Data) throws {
            guard dataBytes + bytes.count <= maximumBytes - 44, dataBytes + bytes.count <= Int(UInt32.max) - 36 else { throw WatsonError.message("The complete recording exceeds the server’s size limit. No partial recording was uploaded.") }
            try handle.write(contentsOf: bytes); dataBytes += bytes.count
        }
        for (index, url) in segments.enumerated() {
            try Task.checkCancellation()
            guard url.isFileURL, url.pathExtension.lowercased() == "caf", FileManager.default.fileExists(atPath: url.path) else { throw WatsonError.message("Saved audio segment \(index + 1) is missing or invalid. A complete recording cannot be uploaded.") }
            let input: AVAudioFile
            do { input = try AVAudioFile(forReading: url) } catch { throw WatsonError.message("Saved CAF segment \(index + 1) could not be decoded. No incomplete recording was uploaded.") }
            guard input.length > 0, input.processingFormat.sampleRate.isFinite, input.processingFormat.sampleRate > 0, input.processingFormat.channelCount > 0, let buffer = AVAudioPCMBuffer(pcmFormat: input.processingFormat, frameCapacity: 4096) else { throw WatsonError.message("Saved CAF segment \(index + 1) contains no usable audio.") }
            let converter = try AudioPCMConverter(input: input.processingFormat)
            let before = dataBytes
            while input.framePosition < input.length {
                try Task.checkCancellation()
                try input.read(into: buffer)
                guard buffer.frameLength > 0 else { throw WatsonError.message("Saved CAF segment \(index + 1) ended before all audio could be read.") }
                try append(converter.convert(buffer).data)
            }
            try append(converter.finish())
            guard dataBytes > before else { throw WatsonError.message("Saved CAF segment \(index + 1) produced no audio. No incomplete recording was uploaded.") }
        }
        try Task.checkCancellation()
        try handle.seek(toOffset: 0); try handle.write(contentsOf: header(dataBytes: dataBytes)); try handle.synchronize()
        completed = true
        return ComposedRecording(file: output, frames: Int64(dataBytes / 2), segmentCount: segments.count)
    }
    private static func header(dataBytes: Int) -> Data {
        var data = Data("RIFF".utf8)
        func u16(_ value: UInt16) { var value = value.littleEndian; withUnsafeBytes(of: &value) { data.append(contentsOf: $0) } }
        func u32(_ value: UInt32) { var value = value.littleEndian; withUnsafeBytes(of: &value) { data.append(contentsOf: $0) } }
        u32(UInt32(dataBytes + 36)); data.append(Data("WAVEfmt ".utf8)); u32(16); u16(1); u16(1); u32(16000); u32(32000); u16(2); u16(16); data.append(Data("data".utf8)); u32(UInt32(dataBytes))
        return data
    }
}
