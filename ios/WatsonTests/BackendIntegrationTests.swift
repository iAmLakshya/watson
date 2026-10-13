import XCTest
import Foundation
#if canImport(WatsonCore)
@testable import WatsonCore
#else
@testable import Watson
#endif

/// Runs against the actual Node/SQLite Watson service when explicitly configured.
/// Credentials and meetings below are synthetic, created and deleted in an isolated DB.
final class BackendIntegrationTests: XCTestCase {
    func testLiveBackendMobileDesktopSyncShareConflictAndDeletion() async throws {
        guard let address = ProcessInfo.processInfo.environment["WATSON_IOS_TEST_BACKEND"] else { throw XCTSkip("Run scripts/validate-cloud.py to test the real local backend.") }
        let password = "Synthetic-local-fixture-123!"
        let email = "ios-test-\(UUID().uuidString.lowercased())@example.invalid"
        let first = try await CloudClient(address: address).auth(email: email, password: password, name: "Synthetic iPhone tester", signup: true)
        let iphone = try CloudClient(address: address, token: first.token)
        let second = try await CloudClient(address: address).auth(email: email, password: password, name: "", signup: false)
        let desktop = try CloudClient(address: address, token: second.token)
        XCTAssertNotEqual(first.device.id, second.device.id)
        let capabilities = try await iphone.accountCapabilities()
        XCTAssertFalse(capabilities.emailDeliveryConfigured); XCTAssertFalse(capabilities.passwordRecoveryConfigured)
        let profile = try await iphone.accountProfile(); XCTAssertEqual(profile.emailVerified, false)
        // This isolated service has no mail transport: the request must fail without delivering mail.
        do { _ = try await CloudClient(address: address).requestPasswordReset(email: email); XCTFail("Unconfigured recovery must fail") } catch { XCTAssertTrue(error.localizedDescription.contains("503")) }
        var meeting = Meeting(title: "Synthetic iPhone conversation")
        meeting.transcript = [TranscriptLine(text: "This is fixture speech, not a microphone recording.", speaker: 0)]
        meeting.notes = "A synthetic conversation for cloud contract verification."
        meeting.answers = [Answer(kind: "recap", text: "Synthetic recap", status: "complete")]
        let creation = try await iphone.sync(SyncRequest(deviceId: first.device.id, cursor: 0, changes: [PendingChange(entity: "meeting", id: meeting.id, expectedRevision: 0, data: JSONValue.encode(meeting))]))
        XCTAssertTrue(creation.conflicts.isEmpty)
        let uploaded = try XCTUnwrap(creation.changes.first { $0.id == meeting.id })
        XCTAssertEqual(uploaded.revision, 1); XCTAssertEqual(try uploaded.data?.decode(Meeting.self), meeting)
        let pulled = try await desktop.sync(SyncRequest(deviceId: second.device.id, cursor: 0, changes: []))
        XCTAssertEqual(try pulled.changes.first { $0.id == meeting.id }?.data?.decode(Meeting.self), meeting)
        meeting.title = "Edited on synthetic desktop"
        let edit = try await desktop.sync(SyncRequest(deviceId: second.device.id, cursor: pulled.cursor, changes: [PendingChange(entity: "meeting", id: meeting.id, expectedRevision: 1, data: JSONValue.encode(meeting))]))
        XCTAssertTrue(edit.conflicts.isEmpty); XCTAssertEqual(edit.applied?.first?.revision, 2)
        let stale = try await iphone.sync(SyncRequest(deviceId: first.device.id, cursor: creation.cursor, changes: [PendingChange(entity: "meeting", id: meeting.id, expectedRevision: 1, data: JSONValue.encode(Meeting(id: meeting.id, title: "Stale phone version")))]))
        XCTAssertEqual(stale.conflicts.first?.code, "revision_conflict"); XCTAssertEqual(stale.conflicts.first?.current?.revision, 2)
        XCTAssertEqual(try stale.conflicts.first?.current?.data?.decode(Meeting.self).title, "Edited on synthetic desktop")
        let link = try await iphone.share(meeting.id)
        let publicResponse: JSONValue = try await CloudClient(address: address).request("GET", path: "public/shares/\(link.token)")
        guard case .object(let envelope) = publicResponse, case .object(let publicMeeting) = envelope["meeting"] else { return XCTFail("Public meeting missing") }
        XCTAssertNil(publicMeeting["answers"]); XCTAssertNil(publicMeeting["recording"]); XCTAssertNil(publicMeeting["id"])
        XCTAssertEqual(publicMeeting["title"], .string(meeting.title))
        try await iphone.revokeShare(meeting.id)
        do { let _: JSONValue = try await CloudClient(address: address).request("GET", path: "public/shares/\(link.token)"); XCTFail("Revoked link should fail") } catch {}
        let deleted = try await iphone.sync(SyncRequest(deviceId: first.device.id, cursor: stale.cursor, changes: [PendingChange(entity: "meeting", id: meeting.id, expectedRevision: 2, data: nil)]))
        XCTAssertTrue(deleted.conflicts.isEmpty)
        let tombstone = try XCTUnwrap(deleted.changes.first { $0.id == meeting.id })
        XCTAssertTrue(tombstone.deleted ?? false); XCTAssertEqual(tombstone.revision, 3)
        var preferences = MobileSettings(); preferences.smartMode = true; preferences.smartModel = "gpt-5.4-mini"; preferences.smartReasoningEffort = "high"; preferences.smartWebSearch = false; preferences.smartMaxOutputTokens = 30000
        let preferencePush = try await iphone.sync(SyncRequest(deviceId: first.device.id, cursor: deleted.cursor, changes: [PendingChange(entity: "settings", id: "preferences", expectedRevision: 0, data: JSONValue.encode(CommonSettings(preferences)))]))
        XCTAssertTrue(preferencePush.conflicts.isEmpty)
        let preferencePull = try await desktop.sync(SyncRequest(deviceId: second.device.id, cursor: edit.cursor, changes: []))
        let common = try XCTUnwrap(preferencePull.changes.first { $0.entity == "settings" && $0.id == "preferences" }?.data?.decode(CommonSettings.self))
        XCTAssertEqual(common.smartModel, "gpt-5.4-mini"); XCTAssertEqual(common.smartReasoningEffort, "high"); XCTAssertEqual(common.smartWebSearch, false); XCTAssertEqual(common.smartMaxOutputTokens, 30000)
        try await iphone.deleteAccount(password: password)
        do { let _: JSONValue = try await desktop.request("GET", path: "me"); XCTFail("Account deletion should revoke desktop token") } catch {}
    }
}
