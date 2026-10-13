#if canImport(AVFoundation)
import Foundation
import AVFoundation

/// Synthetic CAF used only by explicitly labelled development/UI fixtures and tests.
public enum AudioFixture {
    public static func makeCAF(at url: URL, seconds: Double, frequency: Double = 220, sampleRate: Double = 16000, channels: AVAudioChannelCount = 1) throws {
        guard seconds > 0, seconds <= 90, (8000...96000).contains(sampleRate), (1...2).contains(channels), let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: channels, interleaved: false), let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1024) else { throw WatsonError.message("Synthetic audio fixture is unavailable.") }
        let frames = Int(seconds * sampleRate)
        do {
            var settings = format.settings; settings[AVLinearPCMIsNonInterleaved] = false
            let file = try AVAudioFile(forWriting: url, settings: settings)
            var offset = 0
            while offset < frames {
                let count = min(1024, frames - offset); buffer.frameLength = AVAudioFrameCount(count)
                for index in 0..<count { let sample = Float(sin(Double(offset + index) * 2 * .pi * frequency / sampleRate) * 0.1); for channel in 0..<Int(channels) { buffer.floatChannelData![channel][index] = sample } }
                try file.write(from: buffer); offset += count
            }
        }
    }
}
#endif
