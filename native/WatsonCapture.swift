import Foundation
import AVFoundation
import AudioToolbox
import CoreAudio
import ScreenCaptureKit
import CoreMedia
import CoreGraphics
import CoreImage
import Darwin
import AppKit

// Independent capture helper. Its stdout is exclusively newline-delimited JSON.
// Audio is signed little-endian PCM16, mono, 16 kHz, in separate source streams.
final class Output {
    private let lock = NSLock()
    func send(_ event: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys]) else { return }
        lock.lock(); defer { lock.unlock() }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}
let output = Output()

// Reads HAL metadata only: no audio client, tap, screen stream or permission request.
// IsRunningInput/Output describe active streams, not sound levels or app launch state.
@available(macOS 14.2, *)
func meetingActivity(_ args: [String], retries: Int = 1) {
    let checkedAt = ISO8601DateFormatter().string(from: Date())
    var accepted = Set<String>()
    for index in args.indices where args[index] == "--app-bundle-id" && index + 1 < args.count { accepted.insert(args[index + 1].lowercased()) }
    if args.contains("--include-browsers") { accepted.formUnion(["com.google.chrome", "com.apple.safari", "com.microsoft.edgemac", "org.mozilla.firefox", "com.brave.browser", "com.operasoftware.opera", "com.vivaldi.vivaldi", "company.thebrowser.browser"]) }
    let hostPID: pid_t? = args.firstIndex(of: "--exclude-pid").flatMap { $0 + 1 < args.count ? Int32(args[$0 + 1]) : nil }
    // Explicit PID scope is used by the disposable HAL fixture because an
    // unbundled command-line process can have an empty HAL bundle identifier.
    // The desktop detector supplies bundle scopes only, never arbitrary PIDs.
    let selectedPID: pid_t? = args.firstIndex(of: "--activity-pid").flatMap { $0 + 1 < args.count ? Int32(args[$0 + 1]) : nil }
    let system = AudioObjectID(kAudioObjectSystemObject)
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    var rows = [[String: Any]]()
    var errors = [String]()
    let status = AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size)
    guard status == noErr else { output.send(["type": "activity", "supported": true, "checkedAt": checkedAt, "processes": rows, "error": "CoreAudio process activity enumeration failed (\(status))."]); return }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    if size > 0 {
        let result = ids.withUnsafeMutableBytes { AudioObjectGetPropertyData(system, &address, 0, nil, &size, $0.baseAddress!) }
        guard result == noErr else { output.send(["type": "activity", "supported": true, "checkedAt": checkedAt, "processes": rows, "error": "CoreAudio process activity read failed (\(result))."]); return }
    }
    func integer(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
        var field = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: UInt32 = 0; var length = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(id, &field, 0, nil, &length, &value) == noErr ? value : nil
    }
    func matchBundle(_ value: String) -> String? { accepted.sorted(by: { $0.count > $1.count }).first(where: { value == $0 || value.hasPrefix($0 + ".") }) }
    for id in ids {
        // Filter by HAL bundle scope BEFORE inspecting process metadata. Unrelated
        // daemons, PID zero objects and other users cannot poison this reading.
        var bundleValue: Unmanaged<CFString>?
        var bundleField = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyBundleID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var length = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let bundleStatus = AudioObjectGetPropertyData(id, &bundleField, 0, nil, &length, &bundleValue)
        let rawBundle = bundleValue.map { ($0.takeRetainedValue() as String).lowercased() } ?? ""
        var bundle = matchBundle(rawBundle)
        if bundle == nil && selectedPID == nil {
            // A registered user app remains identifiable if its HAL object races
            // with termination. Mark an accepted app unreadable; ignore others.
            if bundleStatus != noErr || rawBundle.isEmpty, let rawPID = integer(id, kAudioProcessPropertyPID), let application = NSRunningApplication(processIdentifier: pid_t(bitPattern: rawPID)), let identity = application.bundleIdentifier?.lowercased(), let scoped = matchBundle(identity) {
                if bundleStatus != noErr { errors.append("Bundle identity for \(scoped) changed or is restricted.") }
                else { bundle = scoped }
            }
            if bundle == nil { continue }
        }
        guard let rawPID = integer(id, kAudioProcessPropertyPID) else { if bundle != nil { errors.append("A selected audio process identity could not be read.") }; continue }
        let pid = pid_t(bitPattern: rawPID)
        if let selectedPID, selectedPID != pid { continue }
        if pid <= 0 || pid == getpid() || pid == hostPID { continue }
        // Only accepted candidates require a same-user metadata check. A failure
        // for a selected live process prevents any automatic end decision.
        var info = proc_bsdinfo()
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) > 0 else { errors.append("A selected audio process changed or its metadata is restricted."); continue }
        guard info.pbi_uid == getuid() else { continue }
        if bundleStatus != noErr { errors.append("A selected audio process bundle identity could not be read."); continue }
        bundle = bundle ?? (rawBundle.isEmpty ? "pid:\(pid)" : rawBundle)
        let scopedBundle = bundle!
        // Electron/browser audio helpers use a suffix of the verified parent
        // bundle ID. Match the longest configured identity before canonicalizing.
        guard let input = integer(id, kAudioProcessPropertyIsRunningInput), let outputState = integer(id, kAudioProcessPropertyIsRunningOutput) else { errors.append("Activity for \(scopedBundle) could not be read."); continue }
        let name = NSRunningApplication(processIdentifier: pid)?.localizedName ?? scopedBundle
        rows.append(["pid": pid, "bundleId": scopedBundle, "name": name, "inputActive": input != 0, "outputActive": outputState != 0])
    }
    // HAL process objects can vanish between enumeration and property reads.
    // One fresh enumeration distinguishes that race from restricted live data.
    if !errors.isEmpty && retries > 0 { meetingActivity(args, retries: retries - 1); return }
    var event: [String: Any] = ["type": "activity", "supported": true, "checkedAt": checkedAt, "processes": rows]
    if !errors.isEmpty { event["error"] = Array(Set(errors)).sorted().joined(separator: " ") }
    output.send(event)
}

enum CaptureFailure: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

struct MicrophoneDevice {
    let deviceID: AudioDeviceID
    let uid: String
    let label: String
    let isDefault: Bool
}

func microphoneDevices() throws -> [MicrophoneDevice] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    let system = AudioObjectID(kAudioObjectSystemObject)
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { throw CaptureFailure.message("Unable to enumerate audio devices.") }
    if size == 0 { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    let status = ids.withUnsafeMutableBytes { AudioObjectGetPropertyData(system, &address, 0, nil, &size, $0.baseAddress!) }
    guard status == noErr else { throw CaptureFailure.message("Audio device enumeration failed (\(status)).") }
    var defaultID = AudioDeviceID(0)
    address.mSelector = kAudioHardwarePropertyDefaultInputDevice
    var defaultSize = UInt32(MemoryLayout<AudioDeviceID>.size)
    _ = AudioObjectGetPropertyData(system, &address, 0, nil, &defaultSize, &defaultID)
    func property(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String? {
        var value: Unmanaged<CFString>?
        var field = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var length = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &field, 0, nil, &length, &value) == noErr, let value else { return nil }
        return value.takeRetainedValue() as String
    }
    return ids.compactMap { id in
        var input = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
        var length: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &input, 0, nil, &length) == noErr, length >= MemoryLayout<AudioBufferList>.size else { return nil }
        let memory = UnsafeMutableRawPointer.allocate(byteCount: Int(length), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { memory.deallocate() }
        guard AudioObjectGetPropertyData(id, &input, 0, nil, &length, memory) == noErr else { return nil }
        let buffers = UnsafeMutableAudioBufferListPointer(memory.assumingMemoryBound(to: AudioBufferList.self))
        guard buffers.reduce(0, { $0 + Int($1.mNumberChannels) }) > 0,
              let uid = property(id, kAudioDevicePropertyDeviceUID),
              let label = property(id, kAudioObjectPropertyName) else { return nil }
        return MicrophoneDevice(deviceID: id, uid: uid, label: label, isDefault: id == defaultID)
    }
}

// AVAudioConverter provides anti-aliasing when converting the native device rate.
final class PCMEncoder {
    private var converter: AVAudioConverter?
    private var inputFormat: AVAudioFormat?
    private let destination = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    func encode(_ input: AVAudioPCMBuffer) throws -> Data {
        if inputFormat != input.format {
            inputFormat = input.format
            converter = AVAudioConverter(from: input.format, to: destination)
        }
        guard let converter else { throw CaptureFailure.message("Audio format cannot be converted to PCM16.") }
        let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * destination.sampleRate / input.format.sampleRate)) + 32
        guard let result = AVAudioPCMBuffer(pcmFormat: destination, frameCapacity: capacity) else {
            throw CaptureFailure.message("Unable to allocate audio conversion buffer.")
        }
        var consumed = false
        var error: NSError?
        let status = converter.convert(to: result, error: &error) { _, state in
            if consumed { state.pointee = .noDataNow; return nil }
            consumed = true; state.pointee = .haveData; return input
        }
        if let error { throw error }
        guard status != .error, result.frameLength > 0, let pointer = result.int16ChannelData?[0] else { return Data() }
        return Data(bytes: pointer, count: Int(result.frameLength) * 2)
    }
}

@available(macOS 13.0, *)
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let args: [String]
    var stream: SCStream?
    let engine = AVAudioEngine()
    let audioQueue = DispatchQueue(label: "com.watson.capture.audio")
    let videoQueue = DispatchQueue(label: "com.watson.capture.screen")
    let systemEncoder = PCMEncoder()
    let micEncoder = PCMEncoder()
    let ciContext = CIContext(options: [.cacheIntermediates: false])
    var lastFrame: Data?
    var lastFrameDate: Date?
    var lastPublished = Date.distantPast
    private let stateLock = NSLock()
    private var failedAudio = false
    var microphoneInstalled = false
    private var reportedMicrophoneBuffer = false
    private var stopping = false
    var terminating: Bool { stateLock.lock(); defer { stateLock.unlock() }; return stopping }
    var oneShot: Bool { args.contains("--screenshot") }
    var wantsScreen: Bool { args.contains("--screen") || oneShot }
    var wantsSystem: Bool { !args.contains("--no-system") && !oneShot }
    init(args: [String]) { self.args = args; super.init() }
    func option(_ name: String) -> String? {
        guard let position = args.firstIndex(of: name), position + 1 < args.count else { return nil }
        return args[position + 1]
    }
    func start() async throws {
        if !wantsSystem && !wantsScreen {
            guard args.contains("--microphone") else { throw CaptureFailure.message("Select at least one audio source or screen context.") }
            try await startMicrophone()
            output.send(["type": "status", "status": "capturing", "system": false, "microphone": true, "screen": false])
            return
        }
        if !CGPreflightScreenCaptureAccess() {
            output.send(["type": "status", "status": "permission-required", "permission": "screen"])
            guard !args.contains("--no-permission-prompts"), CGRequestScreenCaptureAccess() else { throw CaptureFailure.message("Screen & System Audio Recording permission is required. Grant Watson access in System Settings, then restart Watson.") }
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let requestedID = option("--display-id").flatMap(UInt32.init)
        guard let display = requestedID == nil ? content.displays.first : content.displays.first(where: { $0.displayID == requestedID }) else {
            throw CaptureFailure.message("The selected display is unavailable. Choose another display in Watson settings.")
        }
        let bundle = option("--exclude-bundle-id") ?? "com.watson.app"
        let hostPID = option("--exclude-pid").flatMap(Int32.init)
        let exclusions = content.applications.filter { app in
            if let hostPID { return app.processID == getpid() || app.processID == hostPID }
            return app.processID == getpid() || app.bundleIdentifier == bundle
        }
        // This filter excludes Watson from OUR capture, and cannot control another app's screen share.
        let filter = SCContentFilter(display: display, excludingApplications: exclusions, exceptingWindows: [])
        let config = SCStreamConfiguration()
        let scale = min(1.0, 1600.0 / Double(display.width))
        config.width = wantsScreen ? max(2, Int(Double(display.width) * scale)) : 2
        config.height = wantsScreen ? max(2, Int(Double(display.height) * scale)) : 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: wantsScreen ? 2 : 1)
        config.queueDepth = 3
        config.showsCursor = false
        config.capturesAudio = wantsSystem
        config.sampleRate = 48000
        config.channelCount = 2
        config.excludesCurrentProcessAudio = true
        let captureStream = SCStream(filter: filter, configuration: config, delegate: self)
        if wantsScreen { try captureStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: videoQueue) }
        if wantsSystem { try captureStream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue) }
        stream = captureStream
        if args.contains("--microphone") && !oneShot { try await startMicrophone() }
        try await captureStream.startCapture()
        output.send(["type": "status", "status": "capturing", "system": wantsSystem, "microphone": microphoneInstalled, "screen": wantsScreen, "displayId": display.displayID])
        if oneShot {
            DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self] in
                guard let self, !self.terminating else { return }
                output.send(["type": "error", "message": "Screen capture timed out without a complete frame."])
                self.finish(code: 1)
            }
        }
    }
    func startMicrophone() async throws {
        let access = AVCaptureDevice.authorizationStatus(for: .audio)
        if access == .notDetermined {
            guard !args.contains("--no-permission-prompts") else { throw CaptureFailure.message("Microphone permission must be granted before starting a detected session. Open Watson setup when you are ready.") }
            let granted = await AVCaptureDevice.requestAccess(for: .audio)
            if !granted { throw CaptureFailure.message("Microphone permission was declined.") }
        } else if access != .authorized {
            throw CaptureFailure.message("Microphone permission is required. Grant Watson access in System Settings.")
        }
        let input = engine.inputNode
        if let uid = option("--microphone-device-id"), !uid.isEmpty {
            guard let device = try microphoneDevices().first(where: { $0.uid == uid }) else {
                throw CaptureFailure.message("The selected microphone is unavailable. Choose another microphone in Watson settings.")
            }
            // Preserve AVAudioEngine's existing input/output routing when the
            // requested UID already denotes the default input device.
            if !device.isDefault {
                guard let unit = input.audioUnit else { throw CaptureFailure.message("The microphone audio unit is unavailable.") }
                var id = device.deviceID
                let status = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &id, UInt32(MemoryLayout<AudioDeviceID>.size))
                guard status == noErr else { throw CaptureFailure.message("Unable to select the microphone (\(status)).") }
            }
        }
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw CaptureFailure.message("No microphone device is available.") }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            let first = !self.reportedMicrophoneBuffer
            self.reportedMicrophoneBuffer = true
            if first && self.args.contains("--diagnostics") {
                output.send(["type": "diagnostic", "event": "microphone-tap", "frames": buffer.frameLength, "sampleRate": buffer.format.sampleRate, "channels": buffer.format.channelCount])
            }
            // Do not retain the engine-owned tap buffer after callback returns.
            do {
                let pcm = try self.micEncoder.encode(buffer)
                if first && self.args.contains("--diagnostics") { output.send(["type": "diagnostic", "event": "microphone-pcm", "bytes": pcm.count]) }
                self.publishAudio(pcm, source: "microphone")
            }
            catch { self.reportAudioError(error) }
        }
        microphoneInstalled = true
        engine.prepare()
        try engine.start()
        if args.contains("--diagnostics") { output.send(["type": "diagnostic", "event": "microphone-engine", "running": engine.isRunning, "sampleRate": format.sampleRate, "channels": format.channelCount]) }
    }
    func publishAudio(_ data: Data, source: String) {
        if data.isEmpty || terminating { return }
        output.send(["type": "audio", "source": source, "sampleRate": 16000, "channels": 1, "data": data.base64EncodedString()])
    }
    func reportAudioError(_ error: Error) {
        stateLock.lock()
        if failedAudio { stateLock.unlock(); return }; failedAudio = true
        stateLock.unlock()
        output.send(["type": "error", "message": "Audio conversion failed: \(error.localizedDescription)"])
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard buffer.isValid, !terminating else { return }
        if type == .audio {
            guard CMSampleBufferDataIsReady(buffer), let description = buffer.formatDescription else { return }
            let format = AVAudioFormat(cmAudioFormatDescription: description)
            guard let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(buffer.numSamples)) else { return }
            pcm.frameLength = pcm.frameCapacity
            let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(buffer, at: 0, frameCount: Int32(buffer.numSamples), into: pcm.mutableAudioBufferList)
            guard status == noErr else { reportAudioError(CaptureFailure.message("PCM extraction error \(status).")); return }
            do { publishAudio(try systemEncoder.encode(pcm), source: "system") }
            catch { reportAudioError(error) }
        } else if type == .screen {
            guard let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let rawStatus = attachments.first?[.status] as? Int,
                  SCFrameStatus(rawValue: rawStatus) == .complete,
                  let image = buffer.imageBuffer else { return }
            let frame = CIImage(cvPixelBuffer: image)
            guard let jpeg = ciContext.jpegRepresentation(of: frame, colorSpace: CGColorSpaceCreateDeviceRGB(), options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.72]) else { return }
            lastFrame = jpeg; lastFrameDate = Date()
            if oneShot || Date().timeIntervalSince(lastPublished) >= 2 { publishScreen() }
            if oneShot { finish(code: 0) }
        }
    }
    func publishScreen() {
        guard let data = lastFrame, let date = lastFrameDate else { return }
        lastPublished = Date()
        output.send(["type": "screen", "data": data.base64EncodedString(), "mimeType": "image/jpeg", "capturedAt": ISO8601DateFormatter().string(from: date)])
    }
    func command(_ value: String) {
        if value == "stop" { finish(code: 0) }
        if value == "screenshot" { videoQueue.async { [weak self] in self?.publishScreen() } }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        output.send(["type": "error", "message": error.localizedDescription]); finish(code: 1)
    }
    func finish(code: Int32) {
        stateLock.lock()
        if stopping { stateLock.unlock(); return }; stopping = true
        stateLock.unlock()
        Task {
            engine.stop()
            if microphoneInstalled { engine.inputNode.removeTap(onBus: 0) }
            try? await stream?.stopCapture()
            output.send(["type": "status", "status": "stopped"])
            exit(code)
        }
    }
}

func permissions() {
    let mic = AVCaptureDevice.authorizationStatus(for: .audio)
    output.send(["type": "permissions", "screen": CGPreflightScreenCaptureAccess() ? "granted" : "denied", "microphone": mic == .authorized ? "granted" : mic == .notDetermined ? "not-determined" : "denied"])
}

func selfTest() throws {
    let encoder = PCMEncoder()
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 2, interleaved: false)!
    let input = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4800)!
    input.frameLength = 4800
    for channel in 0..<2 { for frame in 0..<4800 { input.floatChannelData![channel][frame] = Float(sin(Double(frame) * 2 * .pi * 440 / 48000) * 0.5) } }
    // First chunk includes the resampling filter's priming latency. The next
    // chunk must produce the expected 100 ms of PCM without losing samples.
    let first = try encoder.encode(input)
    let data = try encoder.encode(input)
    guard first.count >= 2500, first.count <= 3300, data.count >= 3100, data.count <= 3300 else { throw CaptureFailure.message("PCM self-test produced incorrect frame counts: \(first.count), \(data.count).") }
    let peak = data.withUnsafeBytes { bytes -> Int in bytes.bindMemory(to: Int16.self).map { abs(Int($0)) }.max() ?? 0 }
    guard peak > 10000, peak < 20000 else { throw CaptureFailure.message("PCM self-test produced incorrect amplitude: \(peak).") }
    output.send(["type": "self-test", "passed": true, "inputFrames": 4800, "outputBytes": data.count, "peak": peak, "sampleRate": 16000, "channels": 1, "encoding": "pcm16le"])
}

let args = Array(CommandLine.arguments.dropFirst())
if args.contains("--activity") {
    if #available(macOS 14.2, *) { meetingActivity(args) }
    else { output.send(["type": "activity", "supported": false, "checkedAt": ISO8601DateFormatter().string(from: Date()), "processes": [], "error": "Audio process activity requires macOS 14.2 or newer."]) }
    exit(0)
}
if args.contains("--permissions") { permissions(); exit(0) }
if args.contains("--microphones") {
    do {
        let devices = try microphoneDevices()
        output.send(["type": "microphones", "devices": devices.map { ["id": $0.uid, "label": $0.label, "isDefault": $0.isDefault] as [String: Any] }])
        exit(0)
    } catch { output.send(["type": "error", "message": error.localizedDescription]); exit(1) }
}
if args.contains("--self-test") {
    do { try selfTest(); exit(0) } catch { output.send(["type": "error", "message": error.localizedDescription]); exit(1) }
}
guard #available(macOS 13.0, *) else { output.send(["type": "error", "message": "Watson capture requires macOS 13 or newer."]); exit(1) }
if args.contains("--list") {
    // Listing CG displays does not request screen recording access.
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    output.send(["type": "displays", "displays": ids.prefix(Int(count)).enumerated().map { index, id in ["id": String(id), "name": "Display \(index + 1)", "width": CGDisplayPixelsWide(id), "height": CGDisplayPixelsHigh(id)] as [String: Any] }])
    exit(0)
}
if !args.contains("--capture") && !args.contains("--screenshot") {
    output.send(["type": "error", "message": "Use --capture [--microphone] [--screen] [--no-system], --screenshot, --permissions, --list, or --self-test."]); exit(1)
}
let capture = Capture(args: args)
signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termination.setEventHandler { capture.finish(code: 0) }; termination.resume()
let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
interrupt.setEventHandler { capture.finish(code: 0) }; interrupt.resume()
if !args.contains("--screenshot") {
    DispatchQueue.global().async {
        while let line = readLine() { capture.command(line.trimmingCharacters(in: .whitespacesAndNewlines)) }
        capture.finish(code: 0)
    }
}
Task { do { try await capture.start() } catch { output.send(["type": "error", "message": error.localizedDescription]); capture.finish(code: 1) } }
dispatchMain()
