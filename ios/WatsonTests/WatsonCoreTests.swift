import XCTest
import Foundation
#if canImport(WatsonCore)
@testable import WatsonCore
#else
@testable import Watson
#endif

final class WatsonCoreTests: XCTestCase {
    func testDesktopSessionWireRoundTrip() throws {
        let fixture = """
        {"id":"desktop-1","title":"Design review","startedAt":"2026-10-12T09:00:00.123Z","endedAt":"2026-10-12T09:30:00Z","modeId":"general","demo":false,"pinned":true,"transcript":[{"id":"line-1","source":"system","text":"Friday is the deadline.","timestamp":"2026-10-12T09:00:03Z","final":true,"speaker":1}],"answers":[{"id":"answer-1","kind":"recap","question":"","text":"Deadline Friday.","createdAt":"2026-10-12T09:03:00Z","status":"complete","sources":[{"id":"line-1","title":"Transcript","kind":"transcript"}],"latencyMs":310,"scope":"session"}],"notes":"Friday deadline","actions":["Prepare release"],"followupDraft":"Thanks!","tags":["design"]}
        """
        let meeting = try JSONDecoder().decode(Meeting.self, from: Data(fixture.utf8))
        XCTAssertEqual(meeting.transcript[0].source, "system")
        XCTAssertEqual(meeting.transcript[0].label, "Speaker 2")
        XCTAssertEqual(meeting.answers[0].latencyMs, 310)
        XCTAssertEqual(try JSONDecoder().decode(Meeting.self, from: JSONEncoder().encode(meeting)), meeting)
        XCTAssertEqual(meeting.date.timeIntervalSince1970, 1791795600.123, accuracy: 0.01)
    }
    func testPartialTranscriptNeverAppearsInExport() {
        var meeting = Meeting(title: "Test")
        meeting.transcript = [TranscriptLine(text: "confirmed", final: true), TranscriptLine(text: "provisional secret", final: false)]
        XCTAssertTrue(meeting.markdown.contains("confirmed"))
        XCTAssertFalse(meeting.markdown.contains("provisional secret"))
    }
    func testSampleClearlyLabeled() { XCTAssertTrue(MeetingContext.sample().demo); XCTAssertTrue(MeetingContext.sample().markdown.contains("fixture data")) }
    func testPCMEndpointsLittleEndianAndInvalidSamples() {
        let data = PCM.linear16([-2, -1, 0, 1, 2, .nan, .infinity])
        XCTAssertEqual(Array(data), [0x00,0x80,0x00,0x80,0x00,0x00,0xff,0x7f,0xff,0x7f,0x00,0x00,0x00,0x00])
        XCTAssertEqual(data.count, 14)
        XCTAssertEqual(PCM.rms([]), 0)
        XCTAssertEqual(PCM.rms([0.5, -0.5]), 0.5, accuracy: 0.0001)
    }
    func testDeepgramInterimFinalDedupeAndDiarization() throws {
        let provisional = try XCTUnwrap(DeepgramResult.decode(Data("{\"type\":\"Results\",\"start\":1,\"duration\":2,\"is_final\":false,\"channel\":{\"alternatives\":[{\"transcript\":\"Tentative\"}]}}".utf8)))
        let final = try XCTUnwrap(DeepgramResult.decode(Data("{\"type\":\"Results\",\"start\":1,\"duration\":2,\"is_final\":true,\"speech_final\":true,\"channel\":{\"alternatives\":[{\"transcript\":\"Hi there. Yes.\",\"words\":[{\"punctuated_word\":\"Hi\",\"speaker\":0,\"start\":1},{\"punctuated_word\":\"there.\",\"speaker\":0,\"start\":1.3},{\"punctuated_word\":\"Yes.\",\"speaker\":1,\"start\":2}]}]}}".utf8)))
        var accumulator = TranscriptAccumulator(origin: Date(timeIntervalSince1970: 0), runID: "run")
        XCTAssertTrue(accumulator.receive(provisional).isEmpty)
        XCTAssertEqual(accumulator.interim.map(\.text), ["Tentative"])
        let lines = accumulator.receive(final)
        XCTAssertEqual(lines.map(\.text), ["Hi there.", "Yes."])
        XCTAssertEqual(lines.map(\.speaker), [0, 1])
        XCTAssertTrue(lines.allSatisfy(\.final)); XCTAssertTrue(accumulator.interim.isEmpty)
        XCTAssertEqual(lines[0].timestamp, "1970-01-01T00:00:01Z")
        XCTAssertTrue(accumulator.receive(final).isEmpty)
    }
    func testDeepgramIgnoresMetadataAndExposesProviderError() throws {
        XCTAssertNil(try DeepgramResult.decode(Data("{\"type\":\"Metadata\"}".utf8)))
        XCTAssertThrowsError(try DeepgramResult.decode(Data("{\"type\":\"Error\",\"description\":\"Unsupported model\"}".utf8)))
        let end = try XCTUnwrap(DeepgramResult.decode(Data("{\"type\":\"UtteranceEnd\",\"last_word_end\":3.5}".utf8)))
        XCTAssertTrue(end.speechFinal); XCTAssertTrue(end.segments.isEmpty)
    }
    func testNewCaptureRunDoesNotDedupeDifferentSessionSpeech() throws {
        let result = DeepgramResult(final: true, speechFinal: true, start: 0, duration: 1, segments: [DeepgramSegment(text: "Hello", speaker: nil, start: 0)])
        var first = TranscriptAccumulator(runID: "first"); var second = TranscriptAccumulator(runID: "second")
        XCTAssertNotEqual(first.receive(result)[0].id, second.receive(result)[0].id)
    }
    func testSSEMultiLineCRLFAndComments() {
        var parser = SSEParser()
        XCTAssertNil(parser.receive(line: ": heartbeat")); XCTAssertNil(parser.receive(line: "event: response.output_text.delta"))
        XCTAssertNil(parser.receive(line: "data: {\r")); XCTAssertNil(parser.receive(line: "data: \"delta\":\"Hi\"}\r"))
        XCTAssertEqual(parser.receive(line: "\r"), "{\n\"delta\":\"Hi\"}")
        XCTAssertNil(parser.finish())
    }
    func testResponsesTypedEventsAndIncompleteFailure() throws {
        XCTAssertEqual(try ResponseEvent.decode("{\"type\":\"response.output_text.delta\",\"delta\":\"Hello\"}"), .text("Hello"))
        XCTAssertEqual(try ResponseEvent.decode("{\"type\":\"response.completed\"}"), .completed)
        if case .failed = try ResponseEvent.decode("{\"type\":\"response.incomplete\"}") {} else { XCTFail("Incomplete stream must be a failure") }
        XCTAssertEqual(try ResponseEvent.decode("{\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"Rate limit\"}}}"), .failed("Rate limit"))
        XCTAssertEqual(try ResponseEvent.decode("{\"type\":\"response.output_text.annotation.added\",\"annotation\":{\"type\":\"url_citation\",\"url\":\"https://example.com\",\"title\":\"Source\"}}"), .citation("Source", "https://example.com"))
        XCTAssertNil(try ResponseEvent.decode("[DONE]"))
    }
    func testContextUsesFinalTranscriptChosenDocumentsAndLanguage() throws {
        var meeting = Meeting(title: "Meeting")
        meeting.transcript = [TranscriptLine(text: "Final fact"), TranscriptLine(text: "Never include provisional", final: false)]
        let chosen = KnowledgeDocument(id: "chosen", title: "Product", text: "Chosen context")
        let excluded = KnowledgeDocument(id: "excluded", title: "Private", text: "Excluded context")
        var settings = MobileSettings(); settings.outputLanguage = "French"
        let request = MeetingContext.build(kind: "say", question: "", meeting: meeting, settings: settings, mode: Mode(name: "Support", documentIds: ["chosen"]), knowledge: [chosen, excluded])
        XCTAssertTrue(request.instructions.contains("Respond in French")); XCTAssertTrue(request.input.contains("Final fact")); XCTAssertTrue(request.input.contains("Chosen context")); XCTAssertFalse(request.input.contains("Never include provisional")); XCTAssertFalse(request.input.contains("Excluded context")); XCTAssertTrue(request.input.contains("natural response"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: request.json()) as? [String: Any])
        XCTAssertEqual(json["stream"] as? Bool, true); XCTAssertEqual(json["store"] as? Bool, false)
        XCTAssertNil(json["tools"])
    }
    func testHistoryExcludesSamplesAndLimitsToRecentNotes() {
        var meeting = Meeting(title: "Current"); meeting.notes = "Current notes"
        var sample = MeetingContext.sample(); sample.notes = "SAMPLE MUST NOT LEAK"
        var previous = Meeting(title: "Previous"); previous.notes = "Known commitment"
        let request = MeetingContext.build(kind: "chat", question: "What was promised?", meeting: meeting, settings: MobileSettings(), mode: nil, knowledge: [], history: [meeting, sample, previous])
        XCTAssertTrue(request.input.contains("Known commitment")); XCTAssertFalse(request.input.contains("SAMPLE MUST NOT LEAK"))
    }
    func testNotesActionsBoundedBySection() { XCTAssertEqual(MeetingContext.actions(from: "## Summary\n- Ignore\n## Action items\n- Alice: send notes\n* Bob: review\n## Open questions\n- Ignore"), ["Alice: send notes", "Bob: review"]) }
    func testSmartUsesWebSearchExceptNotes() throws {
        var settings = MobileSettings(); settings.smartMode = true
        let request = MeetingContext.build(kind: "chat", question: "Research this", meeting: Meeting(), settings: settings, mode: nil, knowledge: [])
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: request.json()) as? [String: Any]); XCTAssertEqual((json["tools"] as? [[String: String]])?.first?["type"], "web_search")
        XCTAssertFalse(MeetingContext.build(kind: "notes", question: "", meeting: Meeting(), settings: settings, mode: nil, knowledge: []).smart)
    }
    func testCloudTombstoneEncodesExplicitNullAndRevision() throws {
        let request = SyncRequest(deviceId: "iphone-1", cursor: 42, changes: [PendingChange(entity: "meeting", id: "meeting-1", expectedRevision: 3, data: nil)])
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]); let changes = try XCTUnwrap(json["changes"] as? [[String: Any]])
        XCTAssertTrue(changes[0]["data"] is NSNull); XCTAssertEqual(changes[0]["expectedRevision"] as? Int, 3); XCTAssertEqual(json["cursor"] as? Int, 42)
    }
    func testSyncEnvelopeConflictAndJSONMeetingDecode() throws {
        let meeting = Meeting(title: "Server")
        let value = try JSONValue.encode(meeting)
        let data = try JSONSerialization.data(withJSONObject: ["cursor": 9, "changes": [["sequence": 9, "entity": "meeting", "id": meeting.id, "revision": 2, "data": try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)), "deleted": false, "updatedAt": WatsonTime.string()]], "conflicts": [["id":"other", "entity":"meeting", "code":"revision_conflict", "current": NSNull()]], "shared": [], "policy": ["retentionDays":365,"recordingAllowed":true,"publicSharingAllowed":true]])
        let response = try JSONDecoder().decode(SyncResponse.self, from: data)
        XCTAssertEqual(response.cursor, 9); XCTAssertEqual(try response.changes[0].data?.decode(Meeting.self), meeting); XCTAssertEqual(response.conflicts[0].key, "meeting:other"); XCTAssertTrue(response.policy?.recordingAllowed ?? false)
    }
    func testSyncPreferencesDoNotContainKeysServerOrMobileFlags() throws {
        var settings = MobileSettings(); settings.backendURL = "https://private-server/api/v1"; settings.completedOnboarding = true
        let json = String(data: try JSONEncoder().encode(CommonSettings(settings)), encoding: .utf8)!
        XCTAssertFalse(json.contains("backend")); XCTAssertFalse(json.contains("private-server")); XCTAssertFalse(json.contains("Onboarding")); XCTAssertFalse(json.contains("Key")); XCTAssertFalse(json.contains("automaticSync"))
    }
    func testBackendTransportAcceptsHTTPSAndOnlyLoopbackHTTP() throws {
        XCTAssertEqual(try BackendAddress.validate("https://watson.example.com/api/v1").host, "watson.example.com")
        XCTAssertNoThrow(try BackendAddress.validate("http://127.0.0.1:4319/api/v1"))
        for address in ["http://192.168.1.10/api/v1", "ftp://example.com", "https://name:password@example.com", "https://example.com?token=secret", "not a url"] { XCTAssertThrowsError(try BackendAddress.validate(address)) }
    }
    func testSnapshotPersistsPendingDeletesAndConflictState() throws {
        var snapshot = LocalSnapshot(); snapshot.meetings = [MeetingContext.sample()]; snapshot.pending["meeting:deleted"] = PendingChange(entity: "meeting", id: "deleted", expectedRevision: 8, data: nil); snapshot.cursor = 12
        let restored = try JSONDecoder().decode(LocalSnapshot.self, from: JSONEncoder().encode(snapshot))
        XCTAssertEqual(restored.pending["meeting:deleted"]?.expectedRevision, 8); XCTAssertEqual(restored.cursor, 12); XCTAssertEqual(restored.meetings, snapshot.meetings)
    }
}

final class CloudContractTests: XCTestCase {
    func testAuthenticatedSyncRESTContract() async throws {
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [CloudProtocolStub.self]
        let session = URLSession(configuration: configuration)
        CloudProtocolStub.handler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://watson.example.com/api/v1/sync"); XCTAssertEqual(request.httpMethod, "POST"); XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
            let body = try XCTUnwrap(CloudProtocolStub.body(request)); let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any]); XCTAssertEqual(object["deviceId"] as? String, "device-1"); XCTAssertEqual(object["cursor"] as? Int, 4)
            return (200, Data("{\"cursor\":5,\"changes\":[],\"conflicts\":[],\"shared\":[]}".utf8))
        }
        let result = try await CloudClient(address: "https://watson.example.com/api/v1", token: "test-token", session: session).sync(SyncRequest(deviceId: "device-1", cursor: 4, changes: []))
        XCTAssertEqual(result.cursor, 5)
    }
    func testAccountDeletionRequiresPasswordBody() async throws {
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [CloudProtocolStub.self]
        CloudProtocolStub.handler = { request in
            XCTAssertEqual(request.httpMethod, "DELETE"); XCTAssertEqual(request.url?.path, "/api/v1/me")
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(CloudProtocolStub.body(request))) as? [String: String]); XCTAssertEqual(object["currentPassword"], "test-password")
            return (200, Data("{\"deleted\":true}".utf8))
        }
        try await CloudClient(address: "https://watson.example.com/api/v1", token: "test-token", session: URLSession(configuration: configuration)).deleteAccount(password: "test-password")
    }
    func testAuthHeaderAbsentBeforeLoginAndDeviceNameSent() async throws {
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [CloudProtocolStub.self]
        CloudProtocolStub.handler = { request in
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization")); XCTAssertEqual(request.url?.path, "/api/v1/auth/signup")
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(CloudProtocolStub.body(request))) as? [String: String]); XCTAssertEqual(object["deviceName"], "Watson iPhone")
            return (200, Data("{\"token\":\"opaque-token\",\"expiresAt\":\"2026-11-12T00:00:00Z\",\"user\":{\"id\":\"user-1\",\"email\":\"test@example.com\",\"name\":\"Test\"},\"device\":{\"id\":\"device-1\",\"name\":\"Watson iPhone\",\"createdAt\":\"2026-10-12T00:00:00Z\"}}".utf8))
        }
        let response = try await CloudClient(address: "https://watson.example.com/api/v1", session: URLSession(configuration: configuration)).auth(email: "test@example.com", password: "test-password", name: "Test", signup: true)
        XCTAssertEqual(response.device.id, "device-1")
    }
    func testProviderErrorBodyNeverDisplayed() async throws {
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [CloudProtocolStub.self]
        CloudProtocolStub.handler = { _ in (401, Data("{\"secret\":\"SHOULD NOT DISPLAY\"}".utf8)) }
        do { let _: JSONValue = try await CloudClient(address: "https://watson.example.com/api/v1", session: URLSession(configuration: configuration)).request("GET", path: "me"); XCTFail("Unauthorized should fail") }
        catch { XCTAssertFalse(error.localizedDescription.contains("SHOULD NOT DISPLAY")); XCTAssertTrue(error.localizedDescription.contains("Sign in")) }
    }
}

final class CloudProtocolStub: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    static func body(_ request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open(); defer { stream.close() }; var data = Data(); let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096); defer { buffer.deallocate() }
        while stream.hasBytesAvailable { let count = stream.read(buffer, maxLength: 4096); if count <= 0 { break }; data.append(buffer, count: count) }; return data
    }
    override func startLoading() {
        do { let (status, data) = try Self.handler!(request); client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type":"application/json"])!, cacheStoragePolicy: .notAllowed); client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self) }
        catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
