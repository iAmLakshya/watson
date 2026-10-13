#if canImport(UIKit) && canImport(Watson)
import XCTest
import AVFoundation
@testable import Watson

final class NativeRecordingIntegrationTests: XCTestCase {
    @MainActor func testActualStoreCompleteUploadDownloadPlaybackRevisionAndLocalHistory() async throws {
        guard let address = ProcessInfo.processInfo.environment["WATSON_IOS_RECORDING_BACKEND"] else { throw XCTSkip("Run scripts/validate-recordings.py --native for the real iOS store/service workflow.") }
        let folder = try RecordingTestFixture.folder(); defer { try? FileManager.default.removeItem(at: folder) }
        let password = "Synthetic-native-audio-password-123!"
        let account = try await CloudClient(address: address).auth(email: "native-audio-\(UUID().uuidString.lowercased())@example.invalid", password: password, name: "Native synthetic audio", signup: true)
        let client = try CloudClient(address: address, token: account.token)
        let store = WatsonStore(directory: folder, accountToken: account.token)
        store.data.settings.backendURL = address; store.data.settings.automaticSync = false; store.data.cloudUser = account.user; store.data.cloudDevice = account.device; store.data.cloudOwnerId = account.user.id
        var meeting = Meeting(title: "Generated complete recording — native fixture"); meeting.notes = "Notes and people metadata must survive."; meeting.attendeeIds = ["synthetic-person"]; meeting.commitments = [.object(["id":.string("commitment-1"),"text":.string("Preserve original files")])]
        store.data.meetings = [meeting]
        let pair = try RecordingTestFixture.pair(folder.appendingPathComponent("Recordings"), seconds: 0.5)
        store.data.recordings[meeting.id] = pair.map(\.lastPathComponent)
        let originalHashes = try pair.map(RecordingFile.hash)
        let create = try await client.sync(SyncRequest(deviceId: account.device.id, cursor: 0, changes: [PendingChange(entity: "meeting", id: meeting.id, expectedRevision: 0, data: JSONValue.encode(meeting))]))
        store.data.cursor = create.cursor; store.data.revisions["meeting:\(meeting.id)"] = 1; store.persist()
        do { try await store.uploadCompleteRecording(meeting.id, consent: false); XCTFail("Consent is required") } catch {}
        try await store.uploadCompleteRecording(meeting.id, consent: true)
        XCTAssertEqual(store.data.revisions["meeting:\(meeting.id)"], 2); XCTAssertEqual(store.remoteRecording(meeting.id)?.contentType, "audio/wav"); XCTAssertEqual(try pair.map(RecordingFile.hash), originalHashes)
        try await store.downloadRecording(meeting.id)
        let copy = try XCTUnwrap(store.downloadedRecordings(meeting.id).first); let downloaded = try XCTUnwrap(store.downloadedURL(copy))
        XCTAssertEqual(try AVAudioFile(forReading: downloaded).length, 16000)
        let player = try AVAudioPlayer(contentsOf: downloaded); player.volume = 0; XCTAssertTrue(player.prepareToPlay()); XCTAssertTrue(player.play()); XCTAssertTrue(player.isPlaying); player.stop()
        let reopened = WatsonStore(directory: folder, accountToken: account.token)
        XCTAssertEqual(reopened.downloadedRecordings(meeting.id).count, 1); XCTAssertEqual(reopened.data.recordings[meeting.id], pair.map(\.lastPathComponent))
        try await reopened.deleteRemoteRecording(meeting.id)
        XCTAssertEqual(reopened.data.revisions["meeting:\(meeting.id)"], 3); XCTAssertNil(reopened.remoteRecording(meeting.id)); XCTAssertEqual(reopened.downloadedRecordings(meeting.id).count, 1); XCTAssertTrue(FileManager.default.fileExists(atPath: downloaded.path))
        XCTAssertEqual(reopened.meeting(meeting.id)?.notes, meeting.notes); XCTAssertEqual(reopened.meeting(meeting.id)?.commitments, meeting.commitments)
        XCTAssertEqual(try pair.map(RecordingFile.hash), originalHashes)
        try await reopened.uploadCompleteRecording(meeting.id, consent: true); XCTAssertEqual(reopened.data.revisions["meeting:\(meeting.id)"], 4)
        try await client.deleteAccount(password: password)
    }
}
#endif
