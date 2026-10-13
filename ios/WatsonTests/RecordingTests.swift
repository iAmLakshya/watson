import XCTest
import Foundation
import AVFoundation
#if canImport(WatsonCore)
@testable import WatsonCore
#else
@testable import Watson
#endif

enum RecordingTestFixture {
    static func folder() throws -> URL { let url = FileManager.default.temporaryDirectory.appendingPathComponent("watson-audio-test-\(UUID().uuidString)"); try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true); return url }
    static func pair(_ folder: URL, seconds: Double = 0.5) throws -> [URL] {
        let first = folder.appendingPathComponent("First segment.caf"), second = folder.appendingPathComponent("Second segment.caf")
        try AudioFixture.makeCAF(at: first, seconds: seconds, frequency: 220, sampleRate: 48000, channels: 2)
        try AudioFixture.makeCAF(at: second, seconds: seconds, frequency: 440, sampleRate: 16000, channels: 1)
        return [first, second]
    }
    static func crossings(_ file: AVAudioFile, offset: AVAudioFramePosition, frames: AVAudioFrameCount) throws -> Int {
        file.framePosition = offset; let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames)); try file.read(into: buffer)
        let samples = try XCTUnwrap(buffer.floatChannelData?[0]); var count = 0
        for index in 1..<Int(buffer.frameLength) where samples[index - 1] <= 0 && samples[index] > 0 { count += 1 }; return count
    }
}

final class RecordingCompositionTests: XCTestCase {
    func testDifferentCAFFormatsComposeInRecordedOrderWithExactDuration() throws {
        let folder = try RecordingTestFixture.folder(); defer { try? FileManager.default.removeItem(at: folder) }
        let pair = try RecordingTestFixture.pair(folder, seconds: 0.5); let originalHashes = try pair.map(RecordingFile.hash)
        let result = try WAVComposer.compose(pair, output: folder.appendingPathComponent("Complete.wav"))
        let wave = try AVAudioFile(forReading: result.file)
        XCTAssertEqual(result.segmentCount, 2); XCTAssertEqual(result.seconds, 1, accuracy: 0.001)
        XCTAssertEqual(Double(wave.length), 16000, accuracy: 2); XCTAssertEqual(wave.processingFormat.sampleRate, 16000); XCTAssertEqual(wave.processingFormat.channelCount, 1)
        XCTAssertEqual(Double(try RecordingTestFixture.crossings(wave, offset: 1600, frames: 4000)), 55, accuracy: 2)
        XCTAssertEqual(Double(try RecordingTestFixture.crossings(wave, offset: 9600, frames: 4000)), 110, accuracy: 2)
        XCTAssertEqual(try pair.map(RecordingFile.hash), originalHashes)
        XCTAssertEqual(try RecordingFile.size(result.file), 44 + 32000)
    }
    func testMissingOrMalformedSegmentLeavesNoPartialCompleteFile() throws {
        let folder = try RecordingTestFixture.folder(); defer { try? FileManager.default.removeItem(at: folder) }
        let pair = try RecordingTestFixture.pair(folder); let target = folder.appendingPathComponent("Complete.wav")
        for invalid in [folder.appendingPathComponent("Missing.caf"), folder.appendingPathComponent("Invalid.caf")] {
            if invalid.lastPathComponent == "Invalid.caf" { try Data("Not audio".utf8).write(to: invalid) }
            XCTAssertThrowsError(try WAVComposer.compose([pair[0], invalid], output: target)); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        }
    }
    func testSizeOverflowAndEmptyManifestDoNotProduceACompleteRecording() throws {
        let folder = try RecordingTestFixture.folder(); defer { try? FileManager.default.removeItem(at: folder) }
        let pair = try RecordingTestFixture.pair(folder); let target = folder.appendingPathComponent("Complete.wav")
        XCTAssertThrowsError(try WAVComposer.compose(pair, output: target, maximumBytes: 1000)); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        XCTAssertThrowsError(try WAVComposer.compose([], output: target)); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }
    func testDownloadChecksumMismatchRejectsTheFile() throws {
        let folder = try RecordingTestFixture.folder(); defer { try? FileManager.default.removeItem(at: folder) }; let file = try RecordingTestFixture.pair(folder)[0]
        let metadata = RecordingMetadata(id: "recording-1", contentType: "audio/x-caf", size: try RecordingFile.size(file), sha256: String(repeating: "0", count: 64), filename: "First.caf", createdAt: WatsonTime.string(), ownerOnly: true, encryptedAtRest: true)
        XCTAssertThrowsError(try RecordingFile.validate(file, metadata: metadata)); XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
    }
}

final class RecordingWireTests: XCTestCase {
    private func client() throws -> CloudClient { let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [CloudProtocolStub.self]; return try CloudClient(address: "https://watson.example.com/api/v1", token: "synthetic-audio-token", session: URLSession(configuration: config)) }
    func testUploadIsBinaryWithConsentRevisionAndEncodedFilename() async throws {
        let folder = try RecordingTestFixture.folder(); defer { try? FileManager.default.removeItem(at: folder) }; let pair = try RecordingTestFixture.pair(folder); let file = folder.appendingPathComponent("Complete conversation.wav"); _ = try WAVComposer.compose(pair, output: file)
        let size = try RecordingFile.size(file), hash = try RecordingFile.hash(file)
        CloudProtocolStub.handler = { request in
            XCTAssertEqual(request.httpMethod, "PUT"); XCTAssertEqual(request.url?.path, "/api/v1/meetings/meeting-1/recording"); XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-audio-token"); XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "audio/wav"); XCTAssertEqual(request.value(forHTTPHeaderField: "X-Watson-Expected-Revision"), "7"); XCTAssertEqual(request.value(forHTTPHeaderField: "X-Watson-Recording-Consent"), "true"); XCTAssertEqual(request.value(forHTTPHeaderField: "X-Watson-Filename"), "Complete%20conversation.wav")
            let object: [String: Any] = ["revision":8,"recording":["id":"recording-1","contentType":"audio/wav","size":size,"sha256":hash,"createdAt":WatsonTime.string(),"ownerOnly":true,"encryptedAtRest":true]]
            return (201, try JSONSerialization.data(withJSONObject: object))
        }
        let reply = try await client().uploadRecording("meeting-1", file: file, expectedRevision: 7, consent: true); XCTAssertEqual(reply.revision, 8); XCTAssertEqual(reply.recording.sha256, hash)
    }
    func testMissingConsentNeverStartsARequest() async throws {
        let folder = try RecordingTestFixture.folder(); defer { try? FileManager.default.removeItem(at: folder) }; let file = try RecordingTestFixture.pair(folder)[0]; var requests = 0
        CloudProtocolStub.handler = { _ in requests += 1; return (500, Data()) }
        do { _ = try await client().uploadRecording("meeting-1", file: file, expectedRevision: 1, consent: false); XCTFail("Consent is required") } catch { XCTAssertTrue(error.localizedDescription.contains("permission")) }
        XCTAssertEqual(requests, 0)
    }
    func testAbsentMetadataAndStorageCapabilityAreExplicit() async throws {
        CloudProtocolStub.handler = { request in if request.url?.path.hasSuffix("/info") == true { return (404, Data("{}".utf8)) }; return (200, Data("{\"configured\":false,\"maxBytes\":134217728,\"supportedContentTypes\":[\"audio/wav\",\"audio/x-caf\"],\"recordingAllowed\":true,\"consentRequired\":true,\"attachmentsPerMeeting\":1}".utf8)) }
        let metadata = try await client().recordingInfo("meeting-1"); XCTAssertNil(metadata)
        let capabilities = try await client().recordingCapabilities(); XCTAssertFalse(capabilities.configured); XCTAssertEqual(capabilities.attachmentsPerMeeting, 1)
    }
    func testStaleUploadFailsWithoutFallbackOrRetry() async throws {
        let folder = try RecordingTestFixture.folder(); defer { try? FileManager.default.removeItem(at: folder) }; let file = try RecordingTestFixture.pair(folder)[0]; var requests = 0
        CloudProtocolStub.handler = { _ in requests += 1; return (409, Data("{\"token\":\"MUST_NOT_DISPLAY\"}".utf8)) }
        do { _ = try await client().uploadRecording("meeting-1", file: file, expectedRevision: 1, consent: true); XCTFail("Stale upload must fail") } catch { XCTAssertTrue(error.localizedDescription.contains("changed")); XCTAssertFalse(error.localizedDescription.contains("MUST_NOT_DISPLAY")) }; XCTAssertEqual(requests, 1)
    }
}

final class RecordingBackendIntegrationTests: XCTestCase {
    func testCompleteWAVRealEncryptedStorageDownloadRangeReplaceAndDelete() async throws {
        guard let address = ProcessInfo.processInfo.environment["WATSON_IOS_RECORDING_BACKEND"] else { throw XCTSkip("Run scripts/validate-recordings.py for actual private recording storage.") }
        let folder = try RecordingTestFixture.folder(); defer { try? FileManager.default.removeItem(at: folder) }
        let pair = try RecordingTestFixture.pair(folder, seconds: 75); let originalHashes = try pair.map(RecordingFile.hash); let complete = try WAVComposer.compose(pair, output: folder.appendingPathComponent("Complete conversation.wav"))
        XCTAssertEqual(complete.seconds, 150, accuracy: 0.001); XCTAssertGreaterThan(try RecordingFile.size(complete.file), 4 * 1024 * 1024)
        let password = "Synthetic-audio-fixture-password-123!"
        let account = try await CloudClient(address: address).auth(email: "audio-\(UUID().uuidString.lowercased())@example.invalid", password: password, name: "Synthetic audio tester", signup: true)
        let client = try CloudClient(address: address, token: account.token)
        var meeting = Meeting(title: "Generated complete audio fixture"); meeting.notes = "Original notes survive audio transfer."; meeting.commitments = [.object(["id":.string("commitment-1"),"text":.string("Preserve metadata")])]
        let created = try await client.sync(SyncRequest(deviceId: account.device.id, cursor: 0, changes: [PendingChange(entity: "meeting", id: meeting.id, expectedRevision: 0, data: JSONValue.encode(meeting))])); XCTAssertTrue(created.conflicts.isEmpty)
        let capabilities = try await client.recordingCapabilities(); XCTAssertTrue(capabilities.configured); XCTAssertTrue(capabilities.supportedContentTypes.contains("audio/wav"))
        let uploaded = try await client.uploadRecording(meeting.id, file: complete.file, expectedRevision: 1, consent: true)
        XCTAssertEqual(uploaded.revision, 2); XCTAssertTrue(uploaded.recording.encryptedAtRest); XCTAssertEqual(uploaded.recording.sha256, try RecordingFile.hash(complete.file))
        if let storage = ProcessInfo.processInfo.environment["WATSON_IOS_RECORDING_STORAGE"] {
            let encrypted = try FileManager.default.contentsOfDirectory(at: URL(fileURLWithPath: storage), includingPropertiesForKeys: nil).filter { $0.pathExtension == "wrec" }
            XCTAssertEqual(encrypted.count, 1)
            let bytes = try Data(contentsOf: XCTUnwrap(encrypted.first)); let source = try Data(contentsOf: complete.file)
            XCTAssertNil(bytes.range(of: Data(source.prefix(256))))
        }
        let fetched = try await client.recordingInfo(meeting.id); let info = try XCTUnwrap(fetched); XCTAssertEqual(info.sha256, uploaded.recording.sha256)
        let downloaded = try await client.downloadRecording(meeting.id, metadata: info); defer { try? FileManager.default.removeItem(at: downloaded) }
        XCTAssertEqual(try RecordingFile.hash(downloaded), try RecordingFile.hash(complete.file)); XCTAssertEqual(try AVAudioFile(forReading: downloaded).length, complete.frames)
        let range = try await client.recordingRange(meeting.id, start: 65520, end: 65620)
        let source = try Data(contentsOf: complete.file); XCTAssertEqual(range, source.subdata(in: 65520..<65621))
        let other = try await CloudClient(address: address).auth(email: "other-audio-\(UUID().uuidString.lowercased())@example.invalid", password: password, name: "Other synthetic user", signup: true)
        let foreign = try await CloudClient(address: address, token: other.token).recordingInfo(meeting.id); XCTAssertNil(foreign)
        do { _ = try await client.uploadRecording(meeting.id, file: complete.file, expectedRevision: 1, consent: true); XCTFail("Stale upload must fail") } catch { XCTAssertTrue(error.localizedDescription.contains("changed")) }
        let replacement = try await client.uploadRecording(meeting.id, file: complete.file, expectedRevision: 2, consent: true); XCTAssertEqual(replacement.revision, 3)
        let envelope = try await client.meetingEnvelope(meeting.id); XCTAssertEqual(envelope.revision, 3); XCTAssertEqual(envelope.meeting.notes, meeting.notes); XCTAssertEqual(envelope.meeting.commitments, meeting.commitments)
        let deleted = try await client.deleteRecording(meeting.id, expectedRevision: 3); XCTAssertTrue(deleted.deleted); XCTAssertEqual(deleted.revision, 4)
        let absent = try await client.recordingInfo(meeting.id); XCTAssertNil(absent); XCTAssertEqual(try pair.map(RecordingFile.hash), originalHashes)
        try await client.deleteAccount(password: password); try await CloudClient(address: address, token: other.token).deleteAccount(password: password)
    }
}
