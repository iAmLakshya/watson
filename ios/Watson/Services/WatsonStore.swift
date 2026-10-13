import Foundation
import SwiftUI
import AVFoundation
import PDFKit
import UniformTypeIdentifiers

@MainActor final class WatsonStore: ObservableObject {
    @Published var data = LocalSnapshot()
    @Published var activeID: String?
    @Published var recording = false
    @Published var connecting = false
    @Published var finishing = false
    @Published var interim: [TranscriptLine] = []
    @Published var microphoneLevel: Float = 0
    @Published var error: String?
    @Published var status = "Ready for your next conversation"
    @Published var generatingID: String?
    @Published var syncing = false
    @Published var lastSync: Date?
    @Published var hasOpenAI = false
    @Published var hasDeepgram = false
    @Published var shareURL: URL?
    @Published var accountCapabilities: AccountCapabilities?
    @Published var checkingAccount = false
    @Published var requestingEmail = false
    @Published var accountMessage: String?
    @Published var audioTransferMeetingID: String?
    @Published var audioTransferStatus = ""
    @Published var refreshingRecordingID: String?
    @Published var playingAudio = false
    @Published var recordingCapabilities: RecordingCapabilities?
    private let recorder = MicrophoneRecorder()
    private let transcriber = DeepgramClient()
    private var accumulator = TranscriptAccumulator()
    private var generation: Task<Void, Never>?
    private var syncTask: Task<Void, Never>?
    private var autoAssistTask: Task<Void, Never>?
    private var lastAutoAssist = Date.distantPast
    private var lastAutoAssistLineID: String?
    private var player: AVAudioPlayer?
    private var audioContinuation: AsyncStream<Data>.Continuation?
    private var audioPump: Task<Void, Never>?
    private var persistenceBlocked = false
    private var audioTransferTask: Task<Void, Never>?
    private var audioOperationActive = false
    private var volatileAccountToken: String?
    private let volatileCredentials: Bool
    private let networkSession: URLSession
    private let directory: URL
    private var snapshotURL: URL { directory.appendingPathComponent("watson.json") }
    private var recordingDirectory: URL { directory.appendingPathComponent("Recordings", isDirectory: true) }
    private var downloadedDirectory: URL { directory.appendingPathComponent("DownloadedRecordings", isDirectory: true) }
    private var accountToken: String? { volatileCredentials ? volatileAccountToken : KeychainStore.read("account-token") }
    var authenticated: Bool { accountToken != nil && data.cloudUser != nil }
    var active: Meeting? { data.meetings.first { $0.id == activeID } }
    init(directory: URL? = nil, accountToken: String? = nil, session: URLSession = .shared) {
        self.volatileCredentials = accountToken != nil || ProcessInfo.processInfo.arguments.contains("--ui-testing")
        self.volatileAccountToken = accountToken; self.networkSession = session
        self.directory = directory ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        do {
            try FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: recordingDirectory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
            try FileManager.default.createDirectory(at: downloadedDirectory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
            if FileManager.default.fileExists(atPath: snapshotURL.path) { data = try JSONDecoder().decode(LocalSnapshot.self, from: Data(contentsOf: snapshotURL)) }
        } catch {
            if FileManager.default.fileExists(atPath: snapshotURL.path) {
                let backup = self.directory.appendingPathComponent("watson-recovery-\(UUID().uuidString).json")
                do { try FileManager.default.copyItem(at: snapshotURL, to: backup); self.error = "Local data could not be read. The original was saved as a recovery backup." }
                catch { persistenceBlocked = true; self.error = "Local data is unreadable and could not be backed up. Existing files are preserved; remove local data in Settings before saving new conversations." }
            } else { self.error = error.localizedDescription }
        }
        refreshCredentials()
        recorder.onInterrupted = { [weak self] in Task { @MainActor in await self?.pause(); self?.status = "Audio interrupted. Resume when you are ready." } }
        if ProcessInfo.processInfo.arguments.contains("--ui-testing") {
            data = LocalSnapshot(); data.settings.completedOnboarding = true
            if ProcessInfo.processInfo.arguments.contains("--sample") { data.meetings = [MeetingContext.sample()] }
            if ProcessInfo.processInfo.arguments.contains("--account-options-fixture") { accountCapabilities = AccountCapabilities(emailDeliveryConfigured: true, verificationRequired: false, passwordRecoveryConfigured: true) }
            if ProcessInfo.processInfo.arguments.contains("--recording-fixture") {
                var meeting = Meeting(title: "Generated CAF fixture — no microphone used"); meeting.endedAt = WatsonTime.string(); meeting.tags = ["generated-audio-fixture"]; meeting.notes = "Two separately generated CAF segments. No microphone was used."
                data.meetings = [meeting]
                for (index, duration) in [0.6, 0.4].enumerated() {
                    let name = "\(meeting.id)-fixture-\(index + 1).caf"
                    do { try AudioFixture.makeCAF(at: recordingDirectory.appendingPathComponent(name), seconds: duration, frequency: index == 0 ? 220 : 440, sampleRate: index == 0 ? 48000 : 16000, channels: index == 0 ? 2 : 1); data.recordings[meeting.id, default: []].append(name) } catch { self.error = error.localizedDescription }
                }
            }
        }
    }
    func refreshCredentials() { hasOpenAI = !(KeychainStore.read("openai") ?? "").isEmpty; hasDeepgram = !(KeychainStore.read("deepgram") ?? "").isEmpty }
    func saveKeys(openai: String?, deepgram: String?) {
        do {
            if let openai { try KeychainStore.save(openai.trimmingCharacters(in: .whitespacesAndNewlines), as: "openai") }
            if let deepgram { try KeychainStore.save(deepgram.trimmingCharacters(in: .whitespacesAndNewlines), as: "deepgram") }
            refreshCredentials(); status = "Provider keys saved in Keychain"
        } catch { self.error = error.localizedDescription }
    }
    func persist() {
        if ProcessInfo.processInfo.arguments.contains("--ui-testing") { return }
        guard !persistenceBlocked else { return }
        do {
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
            try encoder.encode(data).write(to: snapshotURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch { self.error = "Local changes could not be saved. \(error.localizedDescription)" }
    }
    func setSettings(_ change: (inout MobileSettings) -> Void) {
        let originalAddress = data.settings.backendURL
        change(&data.settings)
        if authenticated && originalAddress != data.settings.backendURL { data.settings.backendURL = originalAddress; error = "Sign out before changing the account server." }
        if originalAddress != data.settings.backendURL { accountCapabilities = nil; accountMessage = nil; recordingCapabilities = nil }
        persist()
        mark(entity: "settings", id: "preferences", value: try? JSONValue.encode(CommonSettings(data.settings)))
        scheduleSync()
    }
    func meeting(_ id: String) -> Meeting? { data.meetings.first { $0.id == id } }
    func update(_ id: String, _ change: (inout Meeting) -> Void, sync: Bool = true) {
        guard let index = data.meetings.firstIndex(where: { $0.id == id }) else { return }
        change(&data.meetings[index]); persist()
        if !data.meetings[index].demo { mark(entity: "meeting", id: id, value: try? JSONValue.encode(data.meetings[index])); if sync { scheduleSync() } }
    }
    func mark(entity: String, id: String, value: JSONValue?) {
        let key = "\(entity):\(id)"
        data.pending[key] = PendingChange(entity: entity, id: id, expectedRevision: data.revisions[key] ?? 0, data: value)
        persist()
    }
    func addSample() -> String { let meeting = MeetingContext.sample(); data.meetings.insert(meeting, at: 0); persist(); return meeting.id }
    func start(title: String, resumeID: String? = nil) async -> String? {
        guard !connecting, !finishing else { return activeID }
        guard !persistenceBlocked else { error = "Recover or remove unreadable local data before recording."; return nil }
        if authenticated { await sync(); guard data.cloudPolicy?.recordingAllowed != false else { error = "Your account’s organization policy disables recording."; return nil } }
        if recording { await pause() }
        player?.stop()
        guard let key = KeychainStore.read("deepgram"), !key.isEmpty else { error = "Add your Deepgram key in Settings to record and transcribe."; return nil }
        connecting = true; defer { connecting = false }
        guard await MicrophoneRecorder.requestPermission() else { error = "Microphone access is off. Enable Watson in iPhone Settings → Privacy & Security → Microphone."; return nil }
        let id: String
        if let resumeID, meeting(resumeID) != nil { id = resumeID; update(id, { $0.endedAt = nil }) }
        else {
            let meeting = Meeting(title: title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "New conversation" : title, modeId: data.settings.activeModeId)
            id = meeting.id; data.meetings.insert(meeting, at: 0); mark(entity: "meeting", id: id, value: try? JSONValue.encode(meeting))
        }
        activeID = id; interim = []; microphoneLevel = 0; accumulator = TranscriptAccumulator()
        status = "Connecting transcription…"
        do {
            try await transcriber.connect(key: key, language: data.settings.language, model: data.settings.transcriptionModel, onResult: { [weak self] result in await self?.receive(result, id: id) }, onError: { [weak self] message in await self?.captureError(message, id: id) })
            accumulator = TranscriptAccumulator(origin: Date())
            let stream = AsyncStream<Data>(bufferingPolicy: .bufferingOldest(128)) { self.audioContinuation = $0 }
            let continuation = audioContinuation!
            audioPump = Task { [transcriber] in for await bytes in stream { await transcriber.enqueue(bytes) } }
            let fileName = "\(id)-\(UUID().uuidString).caf"
            try recorder.start(recordingURL: recordingDirectory.appendingPathComponent(fileName), onData: { [weak self] bytes in
                if case .dropped = continuation.yield(bytes) { Task { @MainActor in await self?.captureError("Microphone audio is arriving too quickly. Recording paused to preserve the transcript.", id: id) } }
            }, onLevel: { [weak self] level in Task { @MainActor in if self?.recording == true { self?.microphoneLevel = level } } }, onError: { [weak self] message in Task { @MainActor in await self?.captureError(message, id: id) } })
            data.recordings[id, default: []].append(fileName); persist()
            recording = true; status = "Recording nearby speech"
        } catch { recorder.stop(); audioContinuation?.finish(); audioContinuation = nil; await audioPump?.value; audioPump = nil; await transcriber.close(); recording = false; self.error = "Recording could not start. \(error.localizedDescription)"; status = "Paused" }
        return id
    }
    private func receive(_ result: DeepgramResult, id: String) {
        guard activeID == id else { return }
        let final = accumulator.receive(result); interim = accumulator.interim
        if !final.isEmpty { update(id, { $0.transcript.append(contentsOf: final) }); status = "Recording nearby speech" }
        if result.speechFinal, let lastLine = meeting(id)?.transcript.last, lastLine.id != lastAutoAssistLineID, data.settings.autoAssist, hasOpenAI, Date().timeIntervalSince(lastAutoAssist) > 12 {
            autoAssistTask?.cancel()
            autoAssistTask = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: 700_000_000); try Task.checkCancellation() } catch { return }
                guard let self, self.recording, self.generatingID == nil, self.activeID == id else { return }
                self.lastAutoAssist = Date(); self.lastAutoAssistLineID = lastLine.id; self.assist(id: id, kind: "assist")
            }
        }
    }
    private func captureError(_ message: String, id: String) async {
        guard activeID == id else { return }
        recorder.stop(); recording = false; microphoneLevel = 0; interim = []
        audioContinuation?.finish(); audioContinuation = nil; audioPump?.cancel(); audioPump = nil
        await transcriber.close(); error = message; status = "Paused"
    }
    func pause() async {
        guard recording || connecting else { return }
        recording = false; recorder.stop(); microphoneLevel = 0; autoAssistTask?.cancel()
        audioContinuation?.finish(); audioContinuation = nil; await audioPump?.value; audioPump = nil
        await transcriber.finish(); interim = []; persist(); status = "Paused — resume to continue"
    }
    func finish() async {
        guard let id = activeID, !finishing else { return }
        finishing = true; await pause(); update(id, { $0.endedAt = WatsonTime.string() }); activeID = nil; finishing = false
        status = "Conversation saved"
        if data.settings.automaticNotes, hasOpenAI, meeting(id)?.transcript.isEmpty == false { assist(id: id, kind: "notes") }
        scheduleSync()
    }
    func cancelAssistance() { generation?.cancel(); generation = nil }
    func assist(id: String, kind: String, question: String = "", history: Bool = false) {
        guard generatingID == nil else { return }
        guard let meeting = meeting(id) else { return }
        let started = ProcessInfo.processInfo.systemUptime
        guard let key = KeychainStore.read("openai"), !key.isEmpty else { error = "Add your OpenAI key in Settings for live assistance, notes, and meeting chat."; return }
        let mode = data.modes.first { $0.id == meeting.modeId }
        let request = MeetingContext.build(kind: kind, question: question, meeting: meeting, settings: data.settings, mode: mode, knowledge: data.knowledge, history: history ? data.meetings : [])
        do { _ = try request.json() } catch { self.error = error.localizedDescription; return }
        let sources = [ContextSource(id: id, title: meeting.title, kind: "transcript")] + data.knowledge.filter { mode?.documentIds.contains($0.id) == true }.map { ContextSource(id: $0.id, title: $0.title, kind: "knowledge") }
        var preparedAnswer = Answer(kind: kind, question: question, sources: sources)
        preparedAnswer.latencyScope = "application-request"
        let answer = preparedAnswer
        let originalNotes = meeting.notes; let originalEmail = meeting.followupDraft
        update(id, { $0.answers.append(answer) }, sync: false); generatingID = answer.id
        generation = Task { [weak self] in
            guard let self else { return }
            do {
                let outcome = try await OpenAIClient().stream(key: key, request: request) { [weak self] event in
                    await self?.receive(event, meetingID: id, answerID: answer.id, started: started)
                }
                self.update(id, { meeting in
                    AnswerCompletion.apply(outcome, to: &meeting, answerID: answer.id, originalNotes: originalNotes, originalEmail: originalEmail)
                    if let index = meeting.answers.firstIndex(where: { $0.id == answer.id }) { meeting.answers[index].recordFirstText(outcome.visibleText, startedAt: started); meeting.answers[index].recordCompletion(startedAt: started) }
                })
                self.status = outcome.refused ? "AI declined the request; existing notes preserved" : (self.meeting(id)?.answers.first(where: { $0.id == answer.id })?.status == "complete" ? "Response complete" : "AI returned no usable answer")
            } catch {
                let message = error is CancellationError ? "Generation cancelled. Partial text was saved." : error.localizedDescription
                self.update(id, { meeting in
                    guard let index = meeting.answers.firstIndex(where: { $0.id == answer.id }) else { return }
                    meeting.answers[index].status = "error"; meeting.answers[index].error = message; meeting.answers[index].recordCompletion(startedAt: started)
                })
                self.error = message
            }
            self.generatingID = nil; self.generation = nil
        }
    }
    private func receive(_ event: ResponseEvent, meetingID: String, answerID: String, started: TimeInterval) {
        guard let meetingIndex = data.meetings.firstIndex(where: { $0.id == meetingID }), let answerIndex = data.meetings[meetingIndex].answers.firstIndex(where: { $0.id == answerID }) else { return }
        switch event {
        case .text(let delta), .refusal(let delta):
            data.meetings[meetingIndex].answers[answerIndex].recordFirstText(delta, startedAt: started)
            data.meetings[meetingIndex].answers[answerIndex].text += delta
        case .refusalDone(let value), .completedRefusal(let value):
            data.meetings[meetingIndex].answers[answerIndex].recordFirstText(value, startedAt: started)
            if data.meetings[meetingIndex].answers[answerIndex].text.isEmpty { data.meetings[meetingIndex].answers[answerIndex].text = value }
        case .citation(let title, let url):
            if !data.meetings[meetingIndex].answers[answerIndex].sources.contains(where: { $0.url == url }) { data.meetings[meetingIndex].answers[answerIndex].sources.append(ContextSource(id: url, title: title, kind: "web", url: url)) }
        case .completed, .failed: break
        }
    }
    func delete(_ id: String) async {
        if audioTransferMeetingID == id { cancelAudioTransfer() }
        if activeID == id { await pause(); activeID = nil }
        if meeting(id)?.answers.contains(where: { $0.id == generatingID }) == true { cancelAssistance() }
        for file in data.recordings[id] ?? [] { try? FileManager.default.removeItem(at: recordingDirectory.appendingPathComponent(file)) }
        data.recordings.removeValue(forKey: id)
        removeDownloadedRecordings(id); data.remoteRecordings?.removeValue(forKey: id)
        let demo = meeting(id)?.demo ?? false
        data.meetings.removeAll { $0.id == id }
        if !demo { mark(entity: "meeting", id: id, value: nil) }; persist(); scheduleSync()
    }
    func saveMode(_ mode: Mode) {
        if let index = data.modes.firstIndex(where: { $0.id == mode.id }) { data.modes[index] = mode } else { data.modes.append(mode) }
        mark(entity: "mode", id: mode.id, value: try? JSONValue.encode(mode)); scheduleSync()
    }
    func deleteMode(_ id: String) {
        guard data.modes.first(where: { $0.id == id })?.builtIn != true else { return }
        data.modes.removeAll { $0.id == id }; if data.settings.activeModeId == id { data.settings.activeModeId = "general" }; mark(entity: "mode", id: id, value: nil); scheduleSync()
    }
    func addKnowledge(title: String, text: String, fileType: String = "txt") {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { error = "This document contains no readable text."; return }
        let document = KnowledgeDocument(title: title, text: text, fileType: fileType)
        data.knowledge.append(document); mark(entity: "knowledge", id: document.id, value: try? JSONValue.encode(document)); scheduleSync()
    }
    func importKnowledge(_ url: URL) {
        let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            guard (attributes[.size] as? Int ?? 0) <= 20_000_000 else { throw WatsonError.message("Choose a document smaller than 20 MB.") }
            let text: String
            if url.pathExtension.lowercased() == "pdf" { guard let pdf = PDFDocument(url: url) else { throw WatsonError.message("This PDF could not be opened.") }; text = (0..<pdf.pageCount).compactMap { pdf.page(at: $0)?.string }.joined(separator: "\n") }
            else { text = try String(contentsOf: url, encoding: .utf8) }
            addKnowledge(title: url.deletingPathExtension().lastPathComponent, text: text, fileType: url.pathExtension.lowercased())
        } catch { self.error = error.localizedDescription }
    }
    func deleteKnowledge(_ id: String) {
        data.knowledge.removeAll { $0.id == id }
        for index in data.modes.indices where data.modes[index].documentIds.contains(id) { data.modes[index].documentIds.removeAll { $0 == id }; mark(entity: "mode", id: data.modes[index].id, value: try? JSONValue.encode(data.modes[index])) }
        mark(entity: "knowledge", id: id, value: nil); scheduleSync()
    }
    func clearChat(_ id: String) { cancelAssistance(); update(id, { $0.answers = [] }) }
    func export(_ id: String, json: Bool = false) -> URL? {
        guard let meeting = meeting(id) else { return nil }
        do {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("Watson-\(id).\(json ? "json" : "md")")
            let content = json ? try JSONEncoder().encode(meeting) : Data(meeting.markdown.utf8)
            try content.write(to: url, options: .atomic); return url
        } catch { self.error = error.localizedDescription; return nil }
    }
    func recordings(_ id: String) -> [URL] { (data.recordings[id] ?? []).map { recordingDirectory.appendingPathComponent($0) }.filter { FileManager.default.fileExists(atPath: $0.path) } }
    func play(_ url: URL) {
        guard !recording else { error = "Pause recording before playing audio."; return }
        do { try AVAudioSession.sharedInstance().setCategory(.playback); try AVAudioSession.sharedInstance().setActive(true); player = try AVAudioPlayer(contentsOf: url); if ProcessInfo.processInfo.arguments.contains("--ui-testing") { player?.volume = 0 }; guard player?.play() == true else { throw WatsonError.message("This audio format could not be played. You can export the file instead.") }; playingAudio = true; status = "Playing audio" } catch { playingAudio = false; self.error = error.localizedDescription }
    }
    func stopPlayback() { player?.stop(); player = nil; playingAudio = false }
    func login(email: String, password: String, name: String, signup: Bool) async {
        do {
            let client = try CloudClient(address: data.settings.backendURL, session: networkSession)
            let result = try await client.auth(email: email, password: password, name: name, signup: signup)
            if let owner = data.cloudOwnerId, owner != result.user.id, !data.meetings.isEmpty || !data.knowledge.isEmpty {
                try? await CloudClient(address: data.settings.backendURL, token: result.token).logout()
                throw WatsonError.message("This phone still has data from another account. Remove local account data before signing into a different account.")
            }
            let firstConnection = data.cloudOwnerId == nil
            if volatileCredentials { volatileAccountToken = result.token }
            else { try KeychainStore.save(result.token, as: "account-token"); try KeychainStore.save(data.settings.backendURL, as: "account-origin") }
            data.cloudUser = result.user; data.cloudDevice = result.device; data.cloudOwnerId = result.user.id
            if firstConnection {
                for meeting in data.meetings where !meeting.demo { mark(entity: "meeting", id: meeting.id, value: try? JSONValue.encode(meeting)) }
                for document in data.knowledge { mark(entity: "knowledge", id: document.id, value: try? JSONValue.encode(document)) }
                for mode in data.modes where mode.builtIn != true { mark(entity: "mode", id: mode.id, value: try? JSONValue.encode(mode)) }
            }
            persist(); await sync()
            await refreshAccountOptions()
        } catch { self.error = error.localizedDescription }
    }
    func logout() async {
        cancelAudioTransfer()
        syncTask?.cancel()
        if let token = accountToken { do { try await CloudClient(address: data.settings.backendURL, token: token, session: networkSession).logout() } catch { self.error = "Remote sign-out could not finish. Local sign-out is complete; the server token will expire." } }
        if volatileCredentials { volatileAccountToken = nil } else { do { try KeychainStore.save("", as: "account-token") } catch { self.error = error.localizedDescription } }
        data.cloudUser = nil; data.cloudDevice = nil; persist()
        accountMessage = nil; recordingCapabilities = nil
    }
    func updateProfile(name: String) async {
        do { data.cloudUser = try await cloud().profile(name: name); persist() } catch { self.error = error.localizedDescription }
    }
    func refreshAccountOptions() async {
        guard !checkingAccount, !data.settings.backendURL.isEmpty else { return }
        let address = data.settings.backendURL
        checkingAccount = true; defer { checkingAccount = false }
        do {
            let capabilities = try await CloudClient(address: address, session: networkSession).accountCapabilities()
            guard data.settings.backendURL == address else { return }
            accountCapabilities = capabilities
            if authenticated { let user = try await cloud().accountProfile(); guard data.settings.backendURL == address else { return }; data.cloudUser = user; persist() }
        } catch { accountCapabilities = nil; self.error = "Account options could not be checked. \(error.localizedDescription)" }
    }
    func requestEmailVerification() async {
        guard !requestingEmail else { return }
        guard accountCapabilities?.emailDeliveryConfigured == true else { error = "Email verification is unavailable on this server."; return }
        requestingEmail = true; defer { requestingEmail = false }
        do { let response = try await cloud().requestVerification(); accountMessage = response.accepted ? "If verification is needed, a one-time link will arrive in your account email. Open it in your browser, then refresh the account status here." : "The server did not accept this request." }
        catch { self.error = error.localizedDescription }
    }
    func requestPasswordReset(email: String) async {
        guard !requestingEmail else { return }
        guard !authenticated, accountCapabilities?.passwordRecoveryConfigured == true else { error = "Password recovery is unavailable on this server."; return }
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty else { error = "Enter your account email first."; return }
        requestingEmail = true; defer { requestingEmail = false }
        do { let response = try await CloudClient(address: data.settings.backendURL, session: networkSession).requestPasswordReset(email: address); accountMessage = response.accepted ? "If an eligible account exists, a one-time reset link will arrive in its email. Open that link in your browser to choose a new password, then sign in here." : "The server did not accept this request." }
        catch { self.error = error.localizedDescription }
    }
    func deleteAccount(password: String) async {
        do { try await cloud().deleteAccount(password: password); if volatileCredentials { volatileAccountToken = nil } else { try KeychainStore.save("", as: "account-token") }; await clearLocalData(); status = "Account and local meeting data deleted" } catch { self.error = error.localizedDescription }
    }
    func clearLocalData() async {
        await pause(); activeID = nil; cancelAssistance(); stopPlayback(); syncTask?.cancel()
        cancelAudioTransfer()
        for id in data.recordings.keys { for url in recordings(id) { try? FileManager.default.removeItem(at: url) } }
        for id in data.downloadedRecordings?.keys.map({ $0 }) ?? [] { removeDownloadedRecordings(id) }
        let settings = data.settings; data = LocalSnapshot(); data.settings = settings; persistenceBlocked = false; persist()
        accountCapabilities = nil; accountMessage = nil; recordingCapabilities = nil
        if volatileCredentials { volatileAccountToken = nil } else { try? KeychainStore.save("", as: "account-token"); try? KeychainStore.save("", as: "account-origin") }
    }
    private func cloud() throws -> CloudClient {
        guard let token = accountToken, authenticated else { throw WatsonError.message("Connect an account in Settings first.") }
        guard volatileCredentials || KeychainStore.read("account-origin") == data.settings.backendURL else { throw WatsonError.message("Account server changed. Sign in again to reconnect.") }
        return try CloudClient(address: data.settings.backendURL, token: token, session: networkSession)
    }
    private func scheduleSync() {
        guard authenticated, data.settings.automaticSync else { return }
        syncTask?.cancel(); syncTask = Task { [weak self] in do { try await Task.sleep(nanoseconds: 3_000_000_000); try Task.checkCancellation() } catch { return }; await self?.sync() }
    }
    func sync() async {
        guard !syncing, let device = data.cloudDevice else { return }
        syncing = true; defer { syncing = false }
        // The backend limits one batch to 100 mutations. Later changes remain queued.
        let sent = Dictionary(uniqueKeysWithValues: data.pending.sorted { $0.key < $1.key }.prefix(100).map { ($0.key, $0.value) })
        do {
            let result = try await cloud().sync(SyncRequest(deviceId: device.id, cursor: data.cursor, changes: Array(sent.values)))
            let conflicts = Set(result.conflicts.map(\.key))
            for (key, change) in sent where !conflicts.contains(key) && data.pending[key]?.changeId == change.changeId { data.pending.removeValue(forKey: key) }
            for change in result.applied ?? [] {
                data.revisions[change.key] = change.revision
                if var pending = data.pending[change.key], !conflicts.contains(change.key) { pending.expectedRevision = change.revision; data.pending[change.key] = pending }
            }
            for change in result.changes {
                data.revisions[change.key] = change.revision
                if var pending = data.pending[change.key] {
                    if !conflicts.contains(change.key) { pending.expectedRevision = change.revision; data.pending[change.key] = pending }
                    continue
                }
                try apply(change)
            }
            for conflict in result.conflicts { data.conflicts.removeAll { $0.key == conflict.key }; data.conflicts.append(conflict) }
            if let policy = result.policy { data.cloudPolicy = policy }
            data.cursor = result.cursor; lastSync = Date(); persist()
            status = result.conflicts.isEmpty ? "Meetings synced" : "Resolve sync conflicts in Settings"
            if data.pending.keys.contains(where: { !conflicts.contains($0) }), data.settings.automaticSync { scheduleSync() }
        } catch { self.error = error.localizedDescription }
    }
    private func apply(_ change: SyncChange) throws {
        switch change.entity {
        case "meeting":
            if change.deleted == true || change.data == nil || change.data == .null {
                if activeID == change.id { recorder.stop(); audioContinuation?.finish(); audioContinuation = nil; audioPump?.cancel(); audioPump = nil; recording = false; activeID = nil; interim = []; Task { await transcriber.close() } }
                for url in recordings(change.id) { try? FileManager.default.removeItem(at: url) }; data.recordings.removeValue(forKey: change.id)
                removeDownloadedRecordings(change.id); data.remoteRecordings?.removeValue(forKey: change.id)
                data.meetings.removeAll { $0.id == change.id }
            }
            else if let value = change.data { let meeting = try value.decode(Meeting.self); if let index = data.meetings.firstIndex(where: { $0.id == change.id }) { data.meetings[index] = meeting } else { data.meetings.insert(meeting, at: 0) } }
        case "knowledge":
            if change.deleted == true || change.data == nil || change.data == .null { data.knowledge.removeAll { $0.id == change.id } }
            else if let value = change.data { let document = try value.decode(KnowledgeDocument.self); if let index = data.knowledge.firstIndex(where: { $0.id == change.id }) { data.knowledge[index] = document } else { data.knowledge.append(document) } }
        case "mode":
            if change.deleted == true || change.data == nil || change.data == .null { data.modes.removeAll { $0.id == change.id && $0.builtIn != true } }
            else if let value = change.data { let mode = try value.decode(Mode.self); if let index = data.modes.firstIndex(where: { $0.id == change.id }) { data.modes[index] = mode } else { data.modes.append(mode) } }
        case "settings":
            if let value = change.data, let settings = try? value.decode(CommonSettings.self) {
                data.settings.language = settings.language; data.settings.outputLanguage = settings.outputLanguage; data.settings.model = settings.model; data.settings.transcriptionModel = settings.transcriptionModel; data.settings.instructions = settings.instructions; data.settings.activeModeId = settings.activeModeId; data.settings.autoAssist = settings.autoAssist; data.settings.smartMode = settings.smartMode
                if let value = settings.smartModel { data.settings.smartModel = value }
                if let value = settings.smartReasoningEffort { data.settings.smartReasoningEffort = value }
                if let value = settings.smartWebSearch { data.settings.smartWebSearch = value }
                if let value = settings.smartMaxOutputTokens { data.settings.smartMaxOutputTokens = value }
            }
        default: break
        }
    }
    func resolve(_ conflict: SyncConflict, keepLocal: Bool) async {
        do {
            if keepLocal, var pending = data.pending[conflict.key] { pending.expectedRevision = conflict.current?.revision ?? 0; pending.changeId = UUID().uuidString; data.pending[conflict.key] = pending }
            else { data.pending.removeValue(forKey: conflict.key); let current = conflict.current ?? SyncChange(sequence: nil, entity: conflict.entity, id: conflict.id, revision: 0, data: nil, deleted: true, updatedAt: nil); try apply(current); data.revisions[current.key] = current.revision }
            data.conflicts.removeAll { $0.key == conflict.key }; persist(); await sync()
        } catch { self.error = error.localizedDescription }
    }
    func publicShare(_ id: String) async {
        guard meeting(id)?.demo == false else { error = "Sample conversations are local fixtures. Export them as a file instead."; return }
        await sync()
        guard data.cloudPolicy?.publicSharingAllowed != false else { error = "Your account’s organization policy disables public sharing."; return }
        guard data.pending["meeting:\(id)"] == nil, !data.conflicts.contains(where: { $0.key == "meeting:\(id)" }) else { error = "Sync this meeting and resolve any conflict before creating a public link."; return }
        do { let result = try await cloud().share(id); guard let url = URL(string: result.url), ["http", "https"].contains(url.scheme ?? "") else { throw WatsonError.message("Backend returned an invalid share link.") }; shareURL = url } catch { self.error = error.localizedDescription }
    }
    func revokeShare(_ id: String) async { do { try await cloud().revokeShare(id); shareURL = nil; status = "Public share link revoked" } catch { self.error = error.localizedDescription } }

    func remoteRecording(_ id: String) -> RecordingMetadata? { data.remoteRecordings?[id] }
    func downloadedRecordings(_ id: String) -> [DownloadedRecording] { (data.downloadedRecordings?[id] ?? []).filter { downloadedURL($0) != nil } }
    func downloadedURL(_ recording: DownloadedRecording) -> URL? {
        guard !recording.filename.contains("/"), !recording.filename.contains("\\") else { return nil }
        let url = downloadedDirectory.appendingPathComponent(recording.filename)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }
    private func removeDownloadedRecordings(_ id: String) {
        for item in data.downloadedRecordings?[id] ?? [] { if let url = downloadedURL(item) { try? FileManager.default.removeItem(at: url) } }
        data.downloadedRecordings?.removeValue(forKey: id)
    }
    func removeDownloadedRecording(_ id: String, recordingID: String) {
        if let item = data.downloadedRecordings?[id]?.first(where: { $0.id == recordingID }), let url = downloadedURL(item) { stopPlayback(); try? FileManager.default.removeItem(at: url) }
        data.downloadedRecordings?[id]?.removeAll { $0.id == recordingID }; persist()
    }
    func refreshRecordingMetadata(_ id: String) async {
        guard refreshingRecordingID == nil, authenticated else { return }
        let owner = data.cloudOwnerId; let address = data.settings.backendURL
        refreshingRecordingID = id; defer { refreshingRecordingID = nil }
        do {
            let client = try cloud(); let capabilities = try await client.recordingCapabilities()
            let metadata = try await client.recordingInfo(id)
            guard authenticated, data.cloudOwnerId == owner, data.settings.backendURL == address, meeting(id) != nil else { return }
            recordingCapabilities = capabilities
            if data.remoteRecordings == nil { data.remoteRecordings = [:] }
            if let metadata { data.remoteRecordings?[id] = metadata } else { data.remoteRecordings?.removeValue(forKey: id) }
            persist()
        } catch { self.error = error.localizedDescription }
    }
    private func recordingPreflight(_ id: String) async throws -> (CloudClient, Int) {
        guard !recording, !connecting else { throw WatsonError.message("Pause recording before transferring audio so its CAF segment is complete.") }
        guard let meeting = meeting(id), !meeting.demo else { throw WatsonError.message("Sample conversations cannot be uploaded as recordings.") }
        let client = try cloud(); let owner = data.cloudOwnerId; let address = data.settings.backendURL
        await sync()
        guard data.cloudPolicy?.recordingAllowed != false else { throw WatsonError.message("Your account policy does not allow recording transfers.") }
        guard data.pending["meeting:\(id)"] == nil, !data.conflicts.contains(where: { $0.key == "meeting:\(id)" }) else { throw WatsonError.message("Sync this meeting and resolve its conflict before transferring audio.") }
        let envelope = try await client.meetingEnvelope(id)
        guard authenticated, data.cloudOwnerId == owner, data.settings.backendURL == address, envelope.id == id, envelope.meeting.id == id, let index = data.meetings.firstIndex(where: { $0.id == id }), data.pending["meeting:\(id)"] == nil else { throw WatsonError.message("The account or meeting changed while preparing audio. Review it and retry explicitly.") }
        data.meetings[index] = envelope.meeting; data.revisions["meeting:\(id)"] = envelope.revision; persist()
        return (client, envelope.revision)
    }
    private func beginAudioOperation(_ id: String, status: String) throws {
        guard !audioOperationActive else { throw WatsonError.message("Another audio transfer is in progress.") }
        audioOperationActive = true; audioTransferMeetingID = id; audioTransferStatus = status
    }
    private func finishAudioOperation() { audioOperationActive = false; audioTransferMeetingID = nil }
    private func applyAudioRevision(_ id: String, previous: Int, revision: Int, uploaded: Bool) {
        let key = "meeting:\(id)"
        data.revisions[key] = max(data.revisions[key] ?? 0, revision)
        if let index = data.meetings.firstIndex(where: { $0.id == id }) { data.meetings[index].recording = nil; if uploaded { data.meetings[index].consentConfirmed = true } }
        if var pending = data.pending[key], pending.expectedRevision == previous, let meeting = meeting(id) {
            pending.expectedRevision = revision; pending.data = try? JSONValue.encode(meeting); pending.changeId = UUID().uuidString; data.pending[key] = pending
        }
        persist()
    }
    func uploadCompleteRecording(_ id: String, consent: Bool) async throws {
        guard consent else { throw WatsonError.message("Confirm permission to upload this conversation’s audio first.") }
        let names = data.recordings[id] ?? []
        guard !names.isEmpty, Set(names).count == names.count, names.allSatisfy({ !$0.contains("/") && !$0.contains("\\") && $0.lowercased().hasSuffix(".caf") }) else { throw WatsonError.message("This conversation’s complete CAF segment list is unavailable or invalid.") }
        let sources = names.map { recordingDirectory.appendingPathComponent($0) }
        try beginAudioOperation(id, status: "Preparing complete conversation audio…"); defer { finishAudioOperation() }
        let owner = data.cloudOwnerId; let address = data.settings.backendURL
        let (client, revision) = try await recordingPreflight(id)
        let capabilities = try await client.recordingCapabilities(); recordingCapabilities = capabilities
        guard capabilities.configured, capabilities.recordingAllowed, capabilities.supportedContentTypes.contains("audio/wav") else { throw WatsonError.message("This server’s private WAV recording storage is unavailable or disabled.") }
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("watson-audio-upload-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let copy = temporary.appendingPathComponent("Watson-complete-conversation.wav")
        let maximum = min(RecordingFile.maximumBytes, capabilities.maxBytes)
        let job = Task.detached(priority: .utility) { try WAVComposer.compose(sources, output: copy, maximumBytes: maximum) }
        let composition = try await withTaskCancellationHandler(operation: { try await job.value }, onCancel: { job.cancel() })
        let digest = try RecordingFile.hash(copy); audioTransferStatus = "Uploading complete recording (\(composition.segmentCount) segments)…"
        let result = try await client.uploadRecording(id, file: copy, expectedRevision: revision, consent: true)
        guard authenticated, data.cloudOwnerId == owner, data.settings.backendURL == address, meeting(id) != nil else { throw WatsonError.message("The account changed while audio was uploading. Refresh the account before continuing.") }
        applyAudioRevision(id, previous: revision, revision: result.revision, uploaded: true)
        guard result.recording.sha256.lowercased() == digest, result.recording.size == (try RecordingFile.size(copy)) else { throw WatsonError.message("The server’s uploaded recording metadata did not match the complete WAV. Refresh it before continuing.") }
        if data.remoteRecordings == nil { data.remoteRecordings = [:] }; data.remoteRecordings?[id] = result.recording
        persist(); status = "Complete recording uploaded privately; paused periods omitted"; audioTransferStatus = status
    }
    func downloadRecording(_ id: String) async throws {
        try beginAudioOperation(id, status: "Checking private recording…"); defer { finishAudioOperation() }
        let owner = data.cloudOwnerId; let address = data.settings.backendURL
        let client = try cloud()
        guard let metadata = try await client.recordingInfo(id) else { throw WatsonError.message("No private cloud recording is available for this meeting.") }
        guard metadata.ownerOnly, metadata.size > 0, metadata.size <= RecordingFile.maximumBytes else { throw WatsonError.message("This private recording exceeds the supported download limit.") }
        audioTransferStatus = "Downloading private recording…"
        let temporary = try await client.downloadRecording(id, metadata: metadata)
        defer { try? FileManager.default.removeItem(at: temporary) }
        try Task.checkCancellation()
        guard authenticated, data.cloudOwnerId == owner, data.settings.backendURL == address, meeting(id) != nil else { throw WatsonError.message("The account or meeting changed while audio was downloading. No local copy was saved.") }
        let name = "\(UUID().uuidString).\(metadata.fileExtension)"; let saved = downloadedDirectory.appendingPathComponent(name)
        try FileManager.default.moveItem(at: temporary, to: saved)
        try FileManager.default.setAttributes([.protectionKey:FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: saved.path)
        if data.downloadedRecordings == nil { data.downloadedRecordings = [:] }
        var copies = data.downloadedRecordings?[id] ?? []
        if let previous = copies.first(where: { $0.id == metadata.id }), let url = downloadedURL(previous) { try? FileManager.default.removeItem(at: url) }
        copies.removeAll { $0.id == metadata.id }; copies.append(DownloadedRecording(metadata: metadata, filename: name, downloadedAt: WatsonTime.string())); data.downloadedRecordings?[id] = copies
        if data.remoteRecordings == nil { data.remoteRecordings = [:] }; data.remoteRecordings?[id] = metadata
        persist(); status = "Private recording downloaded and verified"; audioTransferStatus = status
    }
    func deleteRemoteRecording(_ id: String) async throws {
        try beginAudioOperation(id, status: "Deleting cloud recording…"); defer { finishAudioOperation() }
        let owner = data.cloudOwnerId; let address = data.settings.backendURL
        let (client, revision) = try await recordingPreflight(id)
        let result = try await client.deleteRecording(id, expectedRevision: revision)
        guard result.deleted, authenticated, data.cloudOwnerId == owner, data.settings.backendURL == address, meeting(id) != nil else { throw WatsonError.message("The account changed while deleting audio. Refresh the account before continuing.") }
        applyAudioRevision(id, previous: revision, revision: result.revision, uploaded: false)
        data.remoteRecordings?.removeValue(forKey: id); persist(); status = "Cloud recording deleted; local segments and downloads retained"; audioTransferStatus = status
    }
    private func runAudioTransfer(_ operation: @escaping @MainActor () async throws -> Void) {
        guard audioTransferTask == nil, !audioOperationActive else { error = "Another audio transfer is in progress."; return }
        audioTransferTask = Task { [weak self] in
            do { try await operation() }
            catch { guard let self else { return }; if error is CancellationError || (error as NSError).code == NSURLErrorCancelled { self.status = "Audio transfer cancelled" } else { self.error = error.localizedDescription } }
            self?.audioTransferTask = nil
        }
    }
    func beginCompleteRecordingUpload(_ id: String, consent: Bool) { runAudioTransfer { [weak self] in try await self?.uploadCompleteRecording(id, consent: consent) } }
    func beginRecordingDownload(_ id: String) { runAudioTransfer { [weak self] in try await self?.downloadRecording(id) } }
    func beginRemoteRecordingDelete(_ id: String) { runAudioTransfer { [weak self] in try await self?.deleteRemoteRecording(id) } }
    func cancelAudioTransfer() { audioTransferTask?.cancel() }
}
