import AVFoundation

/// Stateful Apple resampler used by the actual microphone tap and native fixture tests.
final class AudioPCMConverter {
    private let converter: AVAudioConverter
    private let output: AVAudioFormat
    private let inputRate: Double
    private let lock = NSLock()
    init(input: AVAudioFormat) throws {
        guard input.sampleRate > 0, input.channelCount > 0, let output = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false), let converter = AVAudioConverter(from: input, to: output) else { throw WatsonError.message("The microphone format is unavailable. Check the connected audio device.") }
        self.converter = converter; self.output = output; self.inputRate = input.sampleRate
    }
    func convert(_ input: AVAudioPCMBuffer) throws -> (data: Data, level: Float) {
        lock.lock(); defer { lock.unlock() }
        let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * 16000 / inputRate) + 64)
        guard let converted = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { throw WatsonError.message("Audio conversion buffer is unavailable.") }
        var offset: AVAudioFrameCount = 0
        var error: NSError?
        let status = converter.convert(to: converted, error: &error) { requested, inputStatus in
            guard offset < input.frameLength, requested > 0 else { inputStatus.pointee = .noDataNow; return nil }
            // AudioConverter can request less than one tap buffer. Preserve the unread
            // part for its next callback rather than marking the entire buffer consumed.
            let frames = min(AVAudioFrameCount(requested), input.frameLength - offset)
            guard let slice = AVAudioPCMBuffer(pcmFormat: input.format, frameCapacity: frames) else { inputStatus.pointee = .noDataNow; return nil }
            slice.frameLength = frames
            let source = UnsafeMutableAudioBufferListPointer(input.mutableAudioBufferList)
            let destination = UnsafeMutableAudioBufferListPointer(slice.mutableAudioBufferList)
            let bytesPerFrame = Int(input.format.streamDescription.pointee.mBytesPerFrame)
            for index in 0..<min(source.count, destination.count) {
                if let from = source[index].mData, let to = destination[index].mData { memcpy(to, from.advanced(by: Int(offset) * bytesPerFrame), Int(frames) * bytesPerFrame) }
            }
            offset += frames; inputStatus.pointee = .haveData; return slice
        }
        guard error == nil, status != .error, let samples = converted.floatChannelData?[0] else { throw WatsonError.message("Microphone audio could not be converted for transcription.") }
        let values = Array(UnsafeBufferPointer(start: samples, count: Int(converted.frameLength)))
        return (PCM.linear16(values), PCM.rms(values))
    }
    /// Push the resampler's retained final frames before the transcription socket closes.
    func finish() throws -> Data {
        lock.lock(); defer { lock.unlock() }
        var result = Data()
        for _ in 0..<8 {
            guard let converted = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: 4096) else { break }
            var error: NSError?
            let status = converter.convert(to: converted, error: &error) { _, inputStatus in inputStatus.pointee = .endOfStream; return nil }
            guard error == nil, status != .error else { throw WatsonError.message("The microphone resampler could not flush its final audio frames.") }
            if let samples = converted.floatChannelData?[0], converted.frameLength > 0 { result.append(PCM.linear16(Array(UnsafeBufferPointer(start: samples, count: Int(converted.frameLength))))) }
            if status == .endOfStream || converted.frameLength == 0 { break }
        }
        return result
    }
}
