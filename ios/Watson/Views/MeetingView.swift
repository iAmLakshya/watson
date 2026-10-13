import SwiftUI

struct MeetingView: View {
    @EnvironmentObject var store: WatsonStore
    @Environment(\.dismiss) var dismiss
    let id: String
    @State private var tab = "Notes"
    @State private var question = ""
    @State private var recentMeetings = false
    @State private var editor: String?
    @State private var draft = ""
    @State private var shareItems: [Any] = []
    @State private var sharing = false
    @State private var publicShare = false
    @State private var deleteConfirmation = false
    private let tabs = ["Live", "Notes", "Transcript", "Chat"]
    var body: some View {
        Group {
            if let meeting = store.meeting(id) {
                VStack(spacing: 0) {
                    if meeting.demo { HStack { Image(systemName: "testtube.2"); Text("Sample conversation · fixture data") }.font(.caption.weight(.semibold)).foregroundStyle(WatsonStyle.purple).padding(10).frame(maxWidth: .infinity).background(WatsonStyle.pale) }
                    Picker("View", selection: $tab) { ForEach(tabs, id: \.self) { Text($0).tag($0) } }.pickerStyle(.segmented).padding(16).accessibilityIdentifier("meeting-tabs")
                    if store.activeID == id { recordingBar(meeting) }
                    ScrollView {
                        VStack(alignment: .leading, spacing: 18) {
                            switch tab {
                            case "Live": live(meeting)
                            case "Transcript": transcript(meeting)
                            case "Chat": chat(meeting)
                            default: notes(meeting)
                            }
                        }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
                    }.scrollDismissesKeyboard(.interactively)
                    if tab == "Chat" { chatInput }
                }.navigationTitle(meeting.title).navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .topBarTrailing) { Menu {
                        NavigationLink { RecordingsView(id: id) } label: { Label("Recordings", systemImage: "waveform") }.accessibilityIdentifier("open-recordings")
                        Button("Rename", systemImage: "pencil") { draft = meeting.title; editor = "Rename" }
                        Button(meeting.pinned ? "Unpin" : "Pin", systemImage: "pin") { store.update(id) { $0.pinned.toggle() } }
                        Button("Copy transcript", systemImage: "doc.on.doc") { UIPasteboard.general.string = meeting.transcript.filter(\.final).map { "\($0.label): \($0.text)" }.joined(separator: "\n\n") }
                        Button("Copy notes", systemImage: "doc.on.doc") { UIPasteboard.general.string = meeting.notes }
                        Button("Share notes file", systemImage: "square.and.arrow.up") { if let url = store.export(id) { shareItems = [url]; sharing = true } }
                        Button("Export JSON", systemImage: "curlybraces") { if let url = store.export(id, json: true) { shareItems = [url]; sharing = true } }
                        if store.authenticated && !meeting.demo { Button("Create public link", systemImage: "link") { publicShare = true }; Button("Revoke public link", systemImage: "link.badge.plus") { Task { await store.revokeShare(id) } } }
                        Button("Clear chat", systemImage: "bubble.left.and.exclamationmark.bubble.right") { store.clearChat(id) }
                        if !meeting.demo && store.activeID != id { Button("Resume recording", systemImage: "mic") { Task { _ = await store.start(title: meeting.title, resumeID: id); tab = "Live" } }.disabled(store.connecting) }
                        Button("Delete", systemImage: "trash", role: .destructive) { deleteConfirmation = true }
                    } label: { Image(systemName: "ellipsis.circle") }.accessibilityIdentifier("meeting-menu") } }
            } else { ContentUnavailableView("Conversation deleted", systemImage: "doc.text"); Button("Back to conversations") { dismiss() } }
        }
        .onAppear { if store.activeID == id { tab = "Live" } }
        .onDisappear { store.stopPlayback() }
        .sheet(isPresented: $sharing) { ActivitySheet(items: shareItems) }
        .sheet(isPresented: Binding(get: { editor != nil }, set: { if !$0 { editor = nil } })) {
            NavigationStack {
                Group { if editor == "Rename" { Form { TextField("Title", text: $draft).accessibilityIdentifier("rename-title") } } else { TextEditor(text: $draft).padding(16).accessibilityIdentifier("notes-editor") } }.navigationTitle(editor ?? "Edit").toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { editor = nil } }
                    ToolbarItem(placement: .confirmationAction) { Button("Save") { store.update(id) { meeting in if editor == "Rename" { meeting.title = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? meeting.title : draft } else if editor == "Edit actions" { meeting.actions = draft.components(separatedBy: .newlines).filter { !$0.isEmpty } } else if editor == "Edit follow-up" { meeting.followupDraft = draft } else { meeting.notes = draft } }; editor = nil }.accessibilityIdentifier("save-edit") }
                }
            }
        }
        .confirmationDialog("Create a public meeting link? Anyone with the link can read notes and the transcript.", isPresented: $publicShare, titleVisibility: .visible) { Button("Create link") { Task { await store.publicShare(id); if let url = store.shareURL { shareItems = [url]; sharing = true } } } }
        .confirmationDialog("Delete this conversation and its local audio?", isPresented: $deleteConfirmation, titleVisibility: .visible) { Button("Delete conversation", role: .destructive) { Task { await store.delete(id); dismiss() } } }
    }
    @ViewBuilder private func recordingBar(_ meeting: Meeting) -> some View {
        VStack(spacing: 12) {
            HStack { Circle().fill(store.recording ? Color.red : Color.gray).frame(width: 8, height: 8); Text(store.recording ? "Recording nearby speech" : "Recording paused").font(.subheadline.weight(.semibold)); Spacer(); if store.recording { ProgressView(value: Double(store.microphoneLevel)).frame(width: 55).tint(.red) } }
            HStack { Button { Task { if store.recording { await store.pause() } else { _ = await store.start(title: meeting.title, resumeID: id) } } } label: { Label(store.recording ? "Pause" : "Resume", systemImage: store.recording ? "pause.fill" : "mic.fill").frame(maxWidth: .infinity) }.buttonStyle(.bordered).disabled(store.connecting || store.finishing).accessibilityIdentifier("pause-resume-recording"); Button { Task { await store.finish(); tab = "Notes" } } label: { Label("Finish", systemImage: "stop.fill").frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent).disabled(store.finishing).accessibilityIdentifier("finish-recording") }
        }.padding(16).background(WatsonStyle.pale)
    }
    @ViewBuilder private func live(_ meeting: Meeting) -> some View {
        HStack { Text("A helpful next step").font(.title3.bold()); Spacer(); if store.generatingID != nil { ProgressView().controlSize(.small) } }
        assistanceButtons
        if meeting.answers.isEmpty { Text("Ask Watson for help when you need it. Assistance uses final transcript text and the documents in this conversation's mode.").foregroundStyle(.secondary) }
        ForEach(meeting.answers.suffix(4).reversed()) { AnswerCard(answer: $0) }
        if let last = meeting.transcript.last { VStack(alignment: .leading, spacing: 8) { Label("Last heard", systemImage: "waveform").font(.caption.weight(.semibold)).foregroundStyle(.secondary); Text(last.text) }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(WatsonStyle.pale, in: RoundedRectangle(cornerRadius: 16)) }
        if store.activeID == id && !store.interim.isEmpty { Text(store.interim.map(\.text).joined(separator: " ")).italic().foregroundStyle(.secondary); Pill(text: "PROVISIONAL · NOT SAVED") }
    }
    private var assistanceButtons: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            assistButton("Assist", "sparkles", "assist"); assistButton("What should I say?", "quote.bubble", "say"); assistButton("Follow-up questions", "questionmark.bubble", "followup"); assistButton("Recap", "arrow.clockwise", "recap")
        }
    }
    private func assistButton(_ title: String, _ icon: String, _ kind: String) -> some View { Button { store.assist(id: id, kind: kind) } label: { Label(title, systemImage: icon).font(.subheadline.weight(.medium)).frame(maxWidth: .infinity, minHeight: 46) }.buttonStyle(.bordered).disabled(store.generatingID != nil).accessibilityIdentifier("assist-\(kind)") }
    @ViewBuilder private func notes(_ meeting: Meeting) -> some View {
        HStack { Text("Meeting notes").font(.title2.bold()); Spacer(); Button { draft = meeting.notes; editor = "Edit notes" } label: { Image(systemName: "pencil") }.accessibilityLabel("Edit notes") }
        if meeting.notes.isEmpty { Text("Notes will appear here after recording, or you can write your own.").foregroundStyle(.secondary) } else { MarkdownText(text: meeting.notes).accessibilityIdentifier("meeting-notes") }
        Button { store.assist(id: id, kind: "notes") } label: { Label(meeting.notes.isEmpty ? "Generate notes" : "Regenerate notes", systemImage: "sparkles") }.buttonStyle(.bordered).disabled(store.generatingID != nil)
        if !meeting.actions.isEmpty { HStack { Text("Action items").font(.headline); Spacer(); Button("Edit") { draft = meeting.actions.joined(separator: "\n"); editor = "Edit actions" } }; ForEach(Array(meeting.actions.enumerated()), id: \.offset) { _, action in Label(action, systemImage: "circle").font(.subheadline).frame(maxWidth: .infinity, alignment: .leading) } }
        Divider()
        HStack { Text("Follow-up email").font(.headline); Spacer(); if !meeting.followupDraft.isEmpty { Button("Edit") { draft = meeting.followupDraft; editor = "Edit follow-up" } } }
        if !meeting.followupDraft.isEmpty { MarkdownText(text: meeting.followupDraft); HStack { Button("Copy email", systemImage: "doc.on.doc") { UIPasteboard.general.string = meeting.followupDraft }; Button("Share draft", systemImage: "square.and.arrow.up") { shareItems = [meeting.followupDraft]; sharing = true } }.font(.subheadline) }
        Button { store.assist(id: id, kind: "email") } label: { Label("Draft follow-up email", systemImage: "envelope") }.buttonStyle(.bordered).disabled(store.generatingID != nil)
        Divider()
        NavigationLink { RecordingsView(id: id) } label: { Label("Audio recordings", systemImage: "waveform") }.accessibilityIdentifier("view-recordings")
    }
    @ViewBuilder private func transcript(_ meeting: Meeting) -> some View {
        HStack { Text("Transcript").font(.title2.bold()); Spacer(); Text("\(meeting.transcript.count) segments").font(.caption).foregroundStyle(.secondary) }
        if meeting.transcript.isEmpty { Text("Final speech appears here while recording.").foregroundStyle(.secondary) }
        ForEach(meeting.transcript.filter(\.final)) { line in VStack(alignment: .leading, spacing: 6) { HStack { Text(line.label).font(.caption.weight(.semibold)).foregroundStyle(WatsonStyle.purple); Spacer(); if let date = WatsonTime.date(line.timestamp) { Text(date, style: .time).font(.caption2).foregroundStyle(.secondary) } }; Text(line.text).textSelection(.enabled) }.padding(14).frame(maxWidth: .infinity, alignment: .leading).background(WatsonStyle.pale, in: RoundedRectangle(cornerRadius: 14)) }
        if store.activeID == id { ForEach(store.interim) { line in VStack(alignment: .leading, spacing: 5) { Pill(text: "PROVISIONAL"); Text(line.text).italic().foregroundStyle(.secondary) }.padding(14) } }
    }
    @ViewBuilder private func chat(_ meeting: Meeting) -> some View {
        Text("Ask your conversation").font(.title2.bold())
        Toggle("Include recent meeting notes", isOn: $recentMeetings).font(.subheadline)
        if recentMeetings { Text("Includes notes from up to four recent non-sample meetings.").font(.caption).foregroundStyle(.secondary) }
        if meeting.answers.isEmpty { Text("Ask what was decided, request a follow-up, or find a detail in the discussion.").foregroundStyle(.secondary) }
        ForEach(meeting.answers) { AnswerCard(answer: $0) }
    }
    private var chatInput: some View {
        HStack(alignment: .bottom, spacing: 12) {
            TextField("Ask Watson…", text: $question, axis: .vertical).lineLimit(1...5).padding(12).background(WatsonStyle.pale, in: RoundedRectangle(cornerRadius: 16)).accessibilityIdentifier("chat-question")
            if store.generatingID != nil { Button { store.cancelAssistance() } label: { Image(systemName: "stop.circle.fill").font(.title) }.accessibilityLabel("Cancel response") }
            else { Button { let value = question; question = ""; store.assist(id: id, kind: "chat", question: value, history: recentMeetings) } label: { Image(systemName: "arrow.up.circle.fill").font(.title) }.disabled(question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).accessibilityIdentifier("chat-send") }
        }.padding(16).background(.background)
    }
}

struct AnswerCard: View {
    let answer: Answer
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack { Image(systemName: "sparkles").foregroundStyle(WatsonStyle.purple); Text(answer.question.isEmpty ? answer.kind.capitalized : answer.question).font(.subheadline.bold()); Spacer(); if answer.status == "streaming" { ProgressView().controlSize(.mini) } else { Button { UIPasteboard.general.string = answer.text } label: { Image(systemName: "doc.on.doc").font(.caption) }.accessibilityLabel("Copy response") } }
            MarkdownText(text: answer.text.isEmpty ? "Thinking with your conversation context…" : answer.text)
            if let error = answer.error { Label(error, systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.red) }
            ForEach(answer.sources.filter { $0.kind == "web" && $0.url != nil }) { source in if let url = URL(string: source.url ?? ""), ["http", "https"].contains(url.scheme ?? "") { Link(destination: url) { Label(source.title, systemImage: "link").font(.caption) } } }
            if let latency = answer.firstTextLatencyMs { Text("First text in \(latency / 1000, specifier: "%.2f")s").font(.caption2).foregroundStyle(.secondary) }
            if let latency = answer.latencyMs { Text("\(answer.latencyScope == "application-request" ? "Completed in" : "Legacy timing") \(latency / 1000, specifier: "%.2f")s").font(.caption2).foregroundStyle(.secondary) }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(WatsonStyle.pale, in: RoundedRectangle(cornerRadius: 16))
    }
}
