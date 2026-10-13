import Foundation
import AVFoundation

/// One tap captures in-person microphone audio. No ReplayKit, screen capture, or call audio.
final class MicrophoneRecorder {
    private var engine: AVAudioEngine?
    private var interruption: NSObjectProtocol?
    private var routeChange: NSObjectProtocol?
    private var converter: AudioPCMConverter?
    private var finalData: (@Sendable (Data) -> Void)?
    private var finalError: (@Sendable (String) -> Void)?
    var onInterrupted: (() -> Void)?
    static func requestPermission() async -> Bool {
        await withCheckedContinuation { continuation in AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) } }
    }
    func start(recordingURL: URL, onData: @escaping @Sendable (Data) -> Void, onLevel: @escaping @Sendable (Float) -> Void, onError: @escaping @Sendable (String) -> Void) throws {
        stop()
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [.allowBluetoothHFP])
        try session.setPreferredSampleRate(16000)
        try session.setPreferredIOBufferDuration(0.064)
        try session.setActive(true)
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        let converter = try AudioPCMConverter(input: format)
        self.converter = converter; self.finalData = onData; self.finalError = onError
        var fileSettings = format.settings; fileSettings[AVLinearPCMIsNonInterleaved] = false
        let recording = try AVAudioFile(forWriting: recordingURL, settings: fileSettings)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            do { try recording.write(from: buffer) } catch { onError("The audio recording could not be saved. Check available device storage."); return }
            do { let converted = try converter.convert(buffer); onData(converted.data); onLevel(converted.level) }
            catch { onError(error.localizedDescription) }
        }
        self.engine = engine
        engine.prepare()
        do { try engine.start() } catch { stop(); throw error }
        interruption = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { [weak self] notification in
            guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
            self?.onInterrupted?()
        }
        routeChange = NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: .main) { [weak self] notification in
            guard let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt, AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable else { return }
            self?.onInterrupted?()
        }
    }
    func stop() {
        engine?.inputNode.removeTap(onBus: 0); engine?.stop(); engine = nil
        if let converter { do { let tail = try converter.finish(); if !tail.isEmpty { finalData?(tail) } } catch { finalError?(error.localizedDescription) } }
        converter = nil; finalData = nil; finalError = nil
        if let interruption { NotificationCenter.default.removeObserver(interruption) }; interruption = nil
        if let routeChange { NotificationCenter.default.removeObserver(routeChange) }; routeChange = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    deinit { stop() }
}
