import XCTest
import Foundation
#if canImport(WatsonCore)
@testable import WatsonCore
#else
@testable import Watson
#endif

final class SmartConfigurationTests: XCTestCase {
    func testDesktopExtendedMetadataSurvivesPhoneEditRoundTrip() throws {
        var meeting = Meeting(title: "Desktop")
        meeting.attendeeIds = ["person-1"]; meeting.calendarEventId = "event-1"; meeting.commitments = [.object(["id":.string("commitment-1"),"text":.string("Send proposal")])]; meeting.coaching = [.object(["id":.string("assessment-1"),"overallScore":.number(75)])]; meeting.usage = .object(["inputTokens":.number(100),"outputTokens":.number(50)]); meeting.organizationId = "org-1"
        var decoded = try JSONDecoder().decode(Meeting.self, from: JSONEncoder().encode(meeting)); decoded.notes = "Edited on phone"
        let final = try JSONDecoder().decode(Meeting.self, from: JSONEncoder().encode(decoded))
        XCTAssertEqual(final.attendeeIds, meeting.attendeeIds); XCTAssertEqual(final.commitments, meeting.commitments); XCTAssertEqual(final.coaching, meeting.coaching); XCTAssertEqual(final.usage, meeting.usage); XCTAssertEqual(final.organizationId, meeting.organizationId)
        var mode = Mode(name: "Desktop mode"); mode.emailTemplate = "Subject and next steps"; mode.customActions = [.object(["id":.string("custom-1"),"type":.string("prompt"),"prompt":.string("Compare options")])]; mode.folderId = "folder-1"
        XCTAssertEqual(try JSONDecoder().decode(Mode.self, from: JSONEncoder().encode(mode)), mode)
        var document = KnowledgeDocument(title: "Reference", text: "Context"); document.tags = ["sales"]; document.sourceUrl = "https://example.com/reference"; document.folderId = "folder-1"
        XCTAssertEqual(try JSONDecoder().decode(KnowledgeDocument.self, from: JSONEncoder().encode(document)), document)
    }
    private func body(_ settings: MobileSettings, kind: String = "assist") throws -> [String: Any] {
        let request = MeetingContext.build(kind: kind, question: "Question", meeting: Meeting(), settings: settings, mode: nil, knowledge: [])
        let data = try request.json()
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    func testSmartDefaultRoutesSeparateModelReasoningAndBudget() throws {
        var settings = MobileSettings(); settings.smartMode = true
        let json = try body(settings)
        XCTAssertEqual(json["model"] as? String, "gpt-5.4-mini")
        XCTAssertEqual((json["reasoning"] as? [String: String])?["effort"], "medium")
        XCTAssertEqual(json["max_output_tokens"] as? Int, 25000)
        XCTAssertEqual((json["tools"] as? [[String: String]])?.first?["type"], "web_search")
        XCTAssertNil(json["reasoning_effort"]); XCTAssertNil(json["temperature"])
        XCTAssertEqual(json["stream"] as? Bool, true); XCTAssertEqual(json["store"] as? Bool, false)
        XCTAssertEqual(settings.model, "gpt-4.1-mini")
    }
    func testNormalNotesAndEmailKeepConfiguredNormalModel() throws {
        var settings = MobileSettings(); settings.model = "personal-normal-model"; settings.smartMode = false
        let ordinary = try body(settings)
        XCTAssertEqual(ordinary["model"] as? String, "personal-normal-model"); XCTAssertNil(ordinary["reasoning"]); XCTAssertNil(ordinary["tools"]); XCTAssertEqual(ordinary["max_output_tokens"] as? Int, 2400)
        settings.smartMode = true; settings.smartModel = "gpt-4.1-mini" // Invalid Smart config must not affect normal notes/email.
        for kind in ["notes", "email"] { let json = try body(settings, kind: kind); XCTAssertEqual(json["model"] as? String, "personal-normal-model"); XCTAssertNil(json["reasoning"]); XCTAssertNil(json["tools"]) }
    }
    func testWebSearchCanBeDisabledWithoutRemovingReasoning() throws {
        var settings = MobileSettings(); settings.smartMode = true; settings.smartWebSearch = false; settings.smartReasoningEffort = "high"; settings.smartMaxOutputTokens = 32000
        let json = try body(settings)
        XCTAssertNil(json["tools"]); XCTAssertEqual((json["reasoning"] as? [String: String])?["effort"], "high"); XCTAssertEqual(json["max_output_tokens"] as? Int, 32000)
    }
    func testKnownNonReasoningSmartFailsAndUnknownModelRetainsRequestedEffort() throws {
        var settings = MobileSettings(); settings.smartMode = true
        for name in ["gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"] {
            settings.smartModel = name
            XCTAssertThrowsError(try body(settings)) { error in XCTAssertTrue(error.localizedDescription.contains("does not support reasoning")) }
        }
        settings.smartModel = "personal-reasoning-deployment"; settings.smartReasoningEffort = "max"
        let json = try body(settings)
        XCTAssertEqual(json["model"] as? String, "personal-reasoning-deployment"); XCTAssertEqual((json["reasoning"] as? [String: String])?["effort"], "max")
    }
    func testMiniEffortsAndOutputBoundsAreValidatedBeforeRequest() throws {
        var settings = MobileSettings(); settings.smartMode = true
        for model in ["gpt-5.4-mini", "gpt-5.4-mini-2026-03-17"] {
            settings.smartModel = model
            for effort in SmartConfiguration.miniEfforts { settings.smartReasoningEffort = effort; XCTAssertNoThrow(try body(settings)) }
            for effort in ["minimal", "max", "invalid"] { settings.smartReasoningEffort = effort; XCTAssertThrowsError(try body(settings)) }
        }
        settings.smartReasoningEffort = "medium"
        for limit in [1024, 128000] { settings.smartMaxOutputTokens = limit; XCTAssertNoThrow(try body(settings)) }
        for limit in [1023, 128001] { settings.smartMaxOutputTokens = limit; XCTAssertThrowsError(try body(settings)) }
    }
    func testOldLocalSettingsKeepSavedValuesAndAcquireSmartDefaults() throws {
        let bytes = Data("{\"model\":\"saved-normal\",\"language\":\"fr\",\"smartMode\":true,\"backendURL\":\"https://example.com/api/v1\",\"completedOnboarding\":true}".utf8)
        let settings = try JSONDecoder().decode(MobileSettings.self, from: bytes)
        XCTAssertEqual(settings.model, "saved-normal"); XCTAssertEqual(settings.language, "fr"); XCTAssertTrue(settings.completedOnboarding); XCTAssertTrue(settings.smartMode)
        XCTAssertEqual(settings.smartModel, "gpt-5.4-mini"); XCTAssertEqual(settings.smartReasoningEffort, "medium"); XCTAssertEqual(settings.smartMaxOutputTokens, 25000); XCTAssertTrue(settings.smartWebSearch)
        XCTAssertEqual(try JSONDecoder().decode(MobileSettings.self, from: JSONEncoder().encode(settings)), settings)
    }
    func testCommonSmartPreferencesWireAndMissingLegacyFields() throws {
        var settings = MobileSettings(); settings.smartModel = "custom-smart"; settings.smartReasoningEffort = "high"; settings.smartWebSearch = false; settings.smartMaxOutputTokens = 40000
        let common = CommonSettings(settings)
        let encoded = try JSONEncoder().encode(common)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(object["smartModel"] as? String, "custom-smart"); XCTAssertEqual(object["smartMaxOutputTokens"] as? Int, 40000); XCTAssertEqual(object["smartWebSearch"] as? Bool, false)
        var old = object; for key in ["smartModel", "smartReasoningEffort", "smartWebSearch", "smartMaxOutputTokens"] { old.removeValue(forKey: key) }
        let decoded = try JSONDecoder().decode(CommonSettings.self, from: JSONSerialization.data(withJSONObject: old))
        XCTAssertNil(decoded.smartModel); XCTAssertNil(decoded.smartReasoningEffort); XCTAssertNil(decoded.smartWebSearch); XCTAssertNil(decoded.smartMaxOutputTokens)
    }
}

final class AccountRecoveryContractTests: XCTestCase {
    private func client(token: String? = "synthetic-token") throws -> CloudClient { let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [CloudProtocolStub.self]; return try CloudClient(address: "https://watson.example.com/api/v1", token: token, session: URLSession(configuration: configuration)) }
    func testCapabilitiesArePublicAndGateUnconfiguredServices() async throws {
        CloudProtocolStub.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET"); XCTAssertEqual(request.url?.path, "/api/v1/auth/capabilities"); XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            return (200, Data("{\"emailDeliveryConfigured\":false,\"verificationRequired\":false,\"passwordRecoveryConfigured\":false}".utf8))
        }
        let options = try await client().accountCapabilities(); XCTAssertFalse(options.emailDeliveryConfigured); XCTAssertFalse(options.passwordRecoveryConfigured)
    }
    func testVerificationRequestIsAuthenticatedAndContainsNoTokenInBody() async throws {
        CloudProtocolStub.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST"); XCTAssertEqual(request.url?.path, "/api/v1/me/email-verification"); XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-token")
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(CloudProtocolStub.body(request))) as? [String: String]); XCTAssertTrue(object.isEmpty)
            return (202, Data("{\"accepted\":true,\"message\":\"A one-time link will be delivered if needed.\"}".utf8))
        }
        let result = try await client().requestVerification(); XCTAssertTrue(result.accepted)
    }
    func testPasswordResetRequestIsPublicAndReturnsNonEnumeratingMessage() async throws {
        CloudProtocolStub.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST"); XCTAssertEqual(request.url?.path, "/api/v1/auth/password-reset/request"); XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(CloudProtocolStub.body(request))) as? [String: String]); XCTAssertEqual(Set(object.keys), ["email"])
            return (202, Data("{\"accepted\":true,\"message\":\"If an eligible account exists, a one-time reset link will be delivered.\"}".utf8))
        }
        let first = try await client().requestPasswordReset(email: "registered@example.invalid")
        let unknown = try await client().requestPasswordReset(email: "unknown@example.invalid")
        XCTAssertTrue(first.accepted); XCTAssertEqual(first.message, unknown.message)
    }
    func testVerifiedProfileDecodesAndLegacyUserRemainsUnknown() async throws {
        CloudProtocolStub.handler = { _ in (200, Data("{\"user\":{\"id\":\"user-1\",\"email\":\"user@example.invalid\",\"name\":\"Synthetic\",\"emailVerified\":true,\"emailVerifiedAt\":\"2026-10-12T00:00:00Z\"},\"devices\":[],\"policy\":{}}".utf8)) }
        let user = try await client().accountProfile(); XCTAssertEqual(user.emailVerified, true); XCTAssertNotNil(user.emailVerifiedAt)
        let old = try JSONDecoder().decode(CloudUser.self, from: Data("{\"id\":\"user-1\",\"email\":\"user@example.invalid\",\"name\":\"Synthetic\"}".utf8)); XCTAssertNil(old.emailVerified)
    }
    func testUnavailableEmailResponseDoesNotDisplayBodyOrToken() async throws {
        CloudProtocolStub.handler = { _ in (503, Data("{\"token\":\"MUST_NOT_DISPLAY\"}".utf8)) }
        do { _ = try await client().requestPasswordReset(email: "user@example.invalid"); XCTFail("Unavailable service must fail") } catch { XCTAssertTrue(error.localizedDescription.contains("503")); XCTAssertFalse(error.localizedDescription.contains("MUST_NOT_DISPLAY")) }
    }
}
