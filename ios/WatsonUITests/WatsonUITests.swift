import XCTest
import Foundation

final class WatsonUITests: XCTestCase {
    private var app: XCUIApplication!
    override func setUp() { continueAfterFailure = false; app = XCUIApplication(); app.launchArguments = ["--ui-testing", "--sample"]; app.launch() }
    private func capture(_ name: String) { let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment) }
    private func scrollTo(_ element: XCUIElement, attempts: Int = 10) {
        for _ in 0..<attempts {
            if element.exists {
                let frame = element.frame, screen = app.frame
                // iOS26's floating tab bar can cover a control which XCUI still calls
                // hittable. Position the actual tap above that overlay.
                if element.isHittable, frame.minY > screen.minY + 170, frame.maxY < screen.maxY - 150 { return }
                if frame.height > 0 {
                    let distance = min(140, max(-140, screen.midY - frame.midY))
                    let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.06, dy: 0.52))
                    start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: distance)))
                    continue
                }
            }
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.06, dy: 0.65))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -140)))
        }
    }
    func testSampleNotesTranscriptRenameAndChatConfiguration() {
        let sample = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'meeting-' ")).firstMatch
        XCTAssertTrue(sample.waitForExistence(timeout: 15)); capture("Watson-Conversations-Sample"); sample.tap()
        XCTAssertTrue(app.staticTexts["Sample conversation · fixture data"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Summary"].exists)
        capture("Watson-Notes-Sample")
        app.segmentedControls["meeting-tabs"].buttons["Transcript"].tap()
        XCTAssertTrue(app.staticTexts["Speaker 1"].firstMatch.exists)
        capture("Watson-Transcript-Sample")
        app.segmentedControls["meeting-tabs"].buttons["Chat"].tap()
        XCTAssertTrue(app.textFields["chat-question"].exists)
        app.buttons["meeting-menu"].tap(); app.buttons["Rename"].tap()
        let title = app.textFields["rename-title"]; XCTAssertTrue(title.waitForExistence(timeout: 5)); title.tap()
        let existing = title.value as? String ?? ""
        title.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count) + "Watson test conversation")
        app.buttons["save-edit"].tap()
        XCTAssertTrue(app.buttons["meeting-menu"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.navigationBars["Watson test conversation"].exists)
    }
    func testSettingsAndModeCreation() {
        app.tabBars.buttons["Settings"].tap()
        XCTAssertTrue(app.secureTextFields["openai-key"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.secureTextFields["deepgram-key"].exists)
        capture("Watson-Settings")
        app.tabBars.buttons["Personalize"].tap(); app.buttons["create-mode"].tap()
        let name = app.textFields["mode-name"]; XCTAssertTrue(name.waitForExistence(timeout: 5))
        app.buttons["save-mode"].tap()
        XCTAssertTrue(app.staticTexts["My mode"].waitForExistence(timeout: 5))
    }
    func testSmartSettingsShowSeparateDefaultsAndRejectKnownNonReasoningModel() {
        app.tabBars.buttons["Settings"].tap()
        let smart = app.textFields["smart-model"]
        for _ in 0..<6 { if smart.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(smart.isHittable); XCTAssertEqual(smart.value as? String, "gpt-5.4-mini")
        let limit = app.textFields["smart-token-limit"]
        XCTAssertEqual((limit.value as? String)?.replacingOccurrences(of: ",", with: ""), "25000")
        let web = app.switches["smart-web-search"]
        scrollTo(web)
        XCTAssertTrue(web.isHittable); XCTAssertEqual(web.value as? String, "1")
        web.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        let changed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == '0'"), object: web)
        XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 3), .completed)
        capture("Watson-Smart-Settings")
        scrollTo(smart); smart.tap(); let existing = smart.value as? String ?? ""; smart.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count) + "gpt-4.1-mini")
        XCTAssertEqual(smart.value as? String, "gpt-4.1-mini")
        smart.typeText("\n")
        let warning = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'does not support reasoning'")).firstMatch
        scrollTo(warning)
        XCTAssertTrue(warning.waitForExistence(timeout: 5))
    }
    func testForgotPasswordControlRequiresConfiguredAccountCapability() {
        app.terminate(); app.launchArguments = ["--ui-testing", "--sample", "--account-options-fixture"]; app.launch()
        app.tabBars.buttons["Settings"].tap()
        let email = app.textFields["account-email"]
        for _ in 0..<9 { if email.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(email.isHittable)
        let forgot = app.buttons["forgot-password"]; XCTAssertTrue(forgot.exists); XCTAssertFalse(forgot.isEnabled)
        email.tap(); email.typeText("synthetic@example.invalid")
        XCTAssertTrue(forgot.isEnabled)
        XCTAssertTrue(app.staticTexts["SAMPLE ACCOUNT OPTIONS · FIXTURE DATA"].exists)
        capture("Watson-Account-Recovery-Fixture")
        // The control is not tapped: no real or fixture email request is sent by UI tests.
    }
    @MainActor func testActualCompleteRecordingUploadDownloadAndDelete() async throws {
        guard let address = ProcessInfo.processInfo.environment["WATSON_IOS_RECORDING_BACKEND"] else { throw XCTSkip("Run scripts/validate-recordings.py --ui with actual private fixture storage.") }
        let fixtureEmail = "ui-audio-\(UUID().uuidString.lowercased())@example.invalid"
        let fixturePassword = "Synthetic-ui-audio-password-123!"
        var signup = URLRequest(url: URL(string: address)!.appendingPathComponent("auth/signup")); signup.httpMethod = "POST"; signup.setValue("application/json", forHTTPHeaderField: "Content-Type"); signup.httpBody = try JSONSerialization.data(withJSONObject: ["email":fixtureEmail,"password":fixturePassword,"name":"Generated audio UI fixture","deviceName":"UI test setup"])
        let (_, response) = try await URLSession.shared.data(for: signup); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 201)
        app.terminate(); app.launchArguments = ["--ui-testing", "--recording-fixture"]; app.launch()
        app.tabBars.buttons["Settings"].tap()
        let server = app.textFields["backend-url"]; scrollTo(server); XCTAssertTrue(server.isHittable); server.tap(); server.typeText(address)
        let email = app.textFields["account-email"]; scrollTo(email); email.tap(); email.typeText(fixtureEmail)
        let password = app.secureTextFields["account-password"]; scrollTo(password); password.tap(); password.typeText(fixturePassword)
        let submit = app.buttons["account-submit"]; scrollTo(submit); XCTAssertTrue(submit.isEnabled); submit.tap()
        let signedIn = app.buttons["Sign out"].waitForExistence(timeout: 30)
        capture("Watson-Recording-Fixture-Account")
        guard signedIn else { XCTFail("The generated fixture account did not sign in."); return }
        app.tabBars.buttons["Conversations"].tap()
        let meeting = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'meeting-' ")).firstMatch; XCTAssertTrue(meeting.waitForExistence(timeout: 15)); meeting.tap()
        let recordings = app.buttons["view-recordings"]; scrollTo(recordings); recordings.tap()
        let upload = app.buttons["upload-complete-recording"]; guard upload.waitForExistence(timeout: 15) else { XCTFail("Complete recording control is missing."); return }
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: upload); guard XCTWaiter.wait(for: [ready], timeout: 20) == .completed else { XCTFail("Private recording storage did not become ready."); return }
        capture("Watson-Complete-Recording-Before-Upload")
        upload.tap()
        let confirm = app.buttons["confirm-recording-upload"]; guard confirm.waitForExistence(timeout: 5) else { capture("Watson-Upload-Dialog-Diagnostic"); XCTFail("Upload confirmation control is missing."); return }; XCTAssertFalse(confirm.isEnabled)
        let consent = app.switches["recording-upload-consent"]; scrollTo(consent); consent.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        XCTAssertTrue(confirm.isEnabled); confirm.tap()
        let download = app.buttons["download-cloud-recording"]; guard download.waitForExistence(timeout: 30) else { capture("Watson-Upload-Result-Diagnostic"); XCTFail("A complete recording did not become available."); return }; scrollTo(download)
        capture("Watson-Complete-Recording-Uploaded")
        download.tap()
        let playback = app.buttons["play-downloaded-recording"]; scrollTo(playback); guard playback.waitForExistence(timeout: 15) else { capture("Watson-Download-Result-Diagnostic"); XCTFail("Verified download did not become available."); return }; playback.tap()
        let stop = app.buttons["stop-audio-playback"]; XCTAssertTrue(stop.waitForExistence(timeout: 5)); scrollTo(stop); stop.tap()
        capture("Watson-Complete-Recording-Downloaded")
        let deletion = app.buttons["delete-cloud-recording"]; app.swipeDown(); scrollTo(deletion); deletion.tap()
        let remove = app.buttons["confirm-cloud-recording-delete"].firstMatch; XCTAssertTrue(remove.waitForExistence(timeout: 5)); remove.tap()
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: download); XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: 20), .completed)
        XCTAssertTrue(app.buttons["play-downloaded-recording"].exists)
        XCTAssertTrue(app.buttons["play-local-segment-0"].exists); XCTAssertTrue(app.buttons["play-local-segment-1"].exists)
    }
}
