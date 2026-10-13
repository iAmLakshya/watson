#if canImport(UIKit) && canImport(Watson)
import XCTest
import AVFoundation
@testable import Watson

final class NativeStoreTests: XCTestCase {
    @MainActor func testEmailActionsRemainBlockedWithoutConfiguredCapabilities() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("watson-account-test-\(UUID().uuidString)"); defer { try? FileManager.default.removeItem(at: directory) }
        let store = WatsonStore(directory: directory)
        await store.requestEmailVerification(); XCTAssertTrue(store.error?.contains("unavailable") ?? false); XCTAssertNil(store.accountMessage)
        store.error = nil; await store.requestPasswordReset(email: "synthetic@example.invalid"); XCTAssertTrue(store.error?.contains("unavailable") ?? false); XCTAssertFalse(store.requestingEmail)
    }
    @MainActor func testRealFilePersistenceEditAndDeleteTombstone() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("watson-store-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let original = WatsonStore(directory: directory)
        var meeting = Meeting(title: "Synthetic stored meeting"); meeting.notes = "Original notes"
        original.data.meetings = [meeting]; original.persist()
        original.update(meeting.id) { $0.title = "Renamed meeting"; $0.notes = "Edited notes" }
        let reopened = WatsonStore(directory: directory)
        XCTAssertEqual(reopened.meeting(meeting.id)?.title, "Renamed meeting"); XCTAssertEqual(reopened.meeting(meeting.id)?.notes, "Edited notes")
        XCTAssertNotNil(reopened.data.pending["meeting:\(meeting.id)"])
        await reopened.delete(meeting.id)
        let final = WatsonStore(directory: directory)
        XCTAssertNil(final.meeting(meeting.id)); XCTAssertNil(final.data.pending["meeting:\(meeting.id)"]?.data)
        XCTAssertNotNil(final.data.pending["meeting:\(meeting.id)"])
    }
    @MainActor func testUnreadableSnapshotBackedUpBeforeReplacement() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("watson-corrupt-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let invalid = Data("invalid synthetic snapshot".utf8)
        try invalid.write(to: directory.appendingPathComponent("watson.json"))
        let store = WatsonStore(directory: directory)
        XCTAssertTrue(store.error?.contains("recovery backup") ?? false)
        let backup = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first { $0.lastPathComponent.hasPrefix("watson-recovery-") })
        store.data.meetings = [Meeting(title: "New synthetic meeting")]; store.persist()
        XCTAssertEqual(try Data(contentsOf: backup), invalid)
        XCTAssertEqual(WatsonStore(directory: directory).data.meetings.count, 1)
    }
    func testActualAppleResamplerStereo48kToMono16k() throws {
        let format = try XCTUnwrap(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 2, interleaved: false))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 48000)); buffer.frameLength = 48000
        for index in 0..<48000 { let sample = Float(sin(Double(index) * 2 * .pi * 220 / 48000) * 0.5); buffer.floatChannelData![0][index] = sample; buffer.floatChannelData![1][index] = sample }
        let converter = try AudioPCMConverter(input: format)
        let converted = try converter.convert(buffer)
        let tail = try converter.finish()
        XCTAssertEqual(converted.data.count % 2, 0)
        XCTAssertEqual(Double((converted.data.count + tail.count) / 2), 16000, accuracy: 128)
        XCTAssertEqual(converted.level, 0.3535, accuracy: 0.02)
        XCTAssertTrue(converted.data.contains { $0 != 0 })
    }
}
#endif
