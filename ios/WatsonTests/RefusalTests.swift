import XCTest
#if canImport(WatsonCore)
@testable import WatsonCore
#else
@testable import Watson
#endif

final class RefusalTests: XCTestCase {
    func testCanonicalRefusalDeltasStayInHistoryWithoutReplacingNotesEmailOrCoaching() throws {
        var outcome = ResponseOutcome()
        for payload in ["{\"type\":\"response.refusal.delta\",\"delta\":\"I cannot \"}","{\"type\":\"response.refusal.delta\",\"delta\":\"help with that.\"}","{\"type\":\"response.refusal.done\",\"refusal\":\"I cannot help with that.\"}","{\"type\":\"response.completed\"}"] { outcome.receive(try XCTUnwrap(ResponseEvent.decode(payload))) }
        XCTAssertTrue(outcome.refused); XCTAssertTrue(outcome.completed); XCTAssertEqual(outcome.visibleText, "I cannot help with that.")
        for kind in ["notes", "email", "coaching"] {
            var meeting = Meeting(); meeting.notes = "Keep existing notes"; meeting.actions = ["Keep action"]; meeting.followupDraft = "Keep email"; meeting.coaching = [.object(["id":.string("previous-assessment")])]
            let answer = Answer(kind: kind); meeting.answers = [answer]
            AnswerCompletion.apply(outcome, to: &meeting, answerID: answer.id, originalNotes: meeting.notes, originalEmail: meeting.followupDraft)
            XCTAssertEqual(meeting.answers[0].status, "error"); XCTAssertEqual(meeting.answers[0].text, "I cannot help with that."); XCTAssertTrue(meeting.answers[0].error?.contains("declined") ?? false)
            XCTAssertEqual(meeting.notes, "Keep existing notes"); XCTAssertEqual(meeting.actions, ["Keep action"]); XCTAssertEqual(meeting.followupDraft, "Keep email"); XCTAssertEqual(meeting.coaching?.count, 1)
        }
    }
    func testCompletedPayloadRefusalIsDetectedWithoutDelta() throws {
        let event = try XCTUnwrap(ResponseEvent.decode("{\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"refusal\",\"refusal\":\"Request declined.\"}]}]}}"))
        var outcome = ResponseOutcome(); outcome.receive(event); XCTAssertTrue(outcome.refused); XCTAssertTrue(outcome.completed); XCTAssertEqual(outcome.refusal, "Request declined.")
    }
    func testAcceptedAnswerPreservesEditsAndEmptyCompletionDoesNotMakeNotes() {
        var meeting = Meeting(); meeting.notes = "User edited notes"; meeting.followupDraft = "User edited email"
        var accepted = ResponseOutcome(); accepted.text = "Generated replacement"; accepted.completed = true
        for kind in ["notes", "email"] { let answer = Answer(kind: kind); meeting.answers = [answer]; AnswerCompletion.apply(accepted, to: &meeting, answerID: answer.id, originalNotes: "Original", originalEmail: "Original"); XCTAssertEqual(meeting.answers[0].status, "complete"); XCTAssertEqual(meeting.notes, "User edited notes"); XCTAssertEqual(meeting.followupDraft, "User edited email") }
        var empty = ResponseOutcome(); empty.completed = true; let answer = Answer(kind: "notes"); meeting.answers = [answer]
        AnswerCompletion.apply(empty, to: &meeting, answerID: answer.id, originalNotes: meeting.notes, originalEmail: meeting.followupDraft); XCTAssertEqual(meeting.answers[0].status, "error"); XCTAssertEqual(meeting.notes, "User edited notes")
    }
}

final class ResponseTimingTests: XCTestCase {
    func testFirstTextAndCompletionAreSeparateMonotonicMeasurements() {
        var answer = Answer(kind: "chat"); answer.latencyScope = "application-request"
        answer.recordFirstText(" \n", startedAt: 100, now: 100.1); XCTAssertNil(answer.firstTextLatencyMs)
        answer.recordFirstText("Hello", startedAt: 100, now: 100.2); XCTAssertEqual(answer.firstTextLatencyMs ?? -1, 200, accuracy: 0.001)
        answer.recordFirstText("World", startedAt: 100, now: 100.4); XCTAssertEqual(answer.firstTextLatencyMs ?? -1, 200, accuracy: 0.001)
        answer.recordCompletion(startedAt: 100, now: 100.5); XCTAssertEqual(answer.latencyMs ?? -1, 500, accuracy: 0.001)
        answer.recordCompletion(startedAt: 100, now: 99); XCTAssertGreaterThanOrEqual(answer.latencyMs ?? -1, answer.firstTextLatencyMs ?? 0)
    }
    func testDesktopTimingAndRefusalSurvivePhoneEncodingAndAreExcludedFromLaterContext() throws {
        let json = """
        {"id":"desktop-answer","kind":"chat","question":"Prior question","text":"UNUSABLE_REFUSAL_CONTEXT","createdAt":"2026-10-12T12:00:00Z","status":"complete","sources":[],"latencyMs":250,"firstTextLatencyMs":40,"latencyScope":"application-request","refused":true}
        """
        let answer = try JSONDecoder().decode(Answer.self, from: Data(json.utf8)); XCTAssertEqual(answer.firstTextLatencyMs, 40); XCTAssertEqual(answer.latencyMs, 250); XCTAssertEqual(answer.refused, true)
        let restored = try JSONDecoder().decode(Answer.self, from: JSONEncoder().encode(answer)); XCTAssertEqual(restored, answer)
        var meeting = Meeting(); meeting.answers = [restored]
        let request = MeetingContext.build(kind: "chat", question: "A new question", meeting: meeting, settings: MobileSettings(), mode: nil, knowledge: [])
        XCTAssertFalse(request.input.contains("UNUSABLE_REFUSAL_CONTEXT"))
    }
}
