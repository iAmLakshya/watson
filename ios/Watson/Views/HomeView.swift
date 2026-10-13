import SwiftUI

struct HomeView: View {
    @EnvironmentObject var store: WatsonStore
    @State private var query = ""
    @State private var newConversation = false
    @State private var title = ""
    @State private var path: [String] = []
    @State private var deleteID: String?
    var meetings: [Meeting] {
        store.data.meetings.filter { query.isEmpty || $0.searchableText.localizedCaseInsensitiveContains(query) }.sorted { if $0.pinned != $1.pinned { return $0.pinned }; return $0.date > $1.date }
    }
    var body: some View { NavigationStack(path: $path) { content } }
    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 14) {
                    HStack { Pill(text: "YOUR CONVERSATION COMPANION"); Spacer(); Image(systemName: "sparkle").foregroundStyle(WatsonStyle.purple) }
                    Text("Be present.\nWatson remembers.").font(.system(size: 32, weight: .bold, design: .rounded)).foregroundStyle(WatsonStyle.ink)
                    Text("Get useful help as you talk, then leave with clear notes and next steps.").foregroundStyle(.secondary)
                    Button { title = ""; newConversation = true } label: { Label("Start a conversation", systemImage: "mic.fill").frame(maxWidth: .infinity).padding(.vertical, 8) }.buttonStyle(.borderedProminent).accessibilityIdentifier("start-conversation")
                    if let id = store.activeID { Button { path.append(id) } label: { HStack { Image(systemName: store.recording ? "waveform" : "pause.circle"); Text(store.recording ? "Return to recording" : "Return to paused conversation"); Spacer(); Image(systemName: "chevron.right") } }.accessibilityIdentifier("active-conversation") }
                }.padding(20).background(WatsonStyle.pale, in: RoundedRectangle(cornerRadius: 24))
                HStack { Text("Your conversations").font(.title3.bold()); Spacer(); if store.authenticated { Button { Task { await store.sync() } } label: { Image(systemName: store.syncing ? "arrow.triangle.2.circlepath" : "icloud") }.disabled(store.syncing).accessibilityLabel("Sync conversations") } }
                if meetings.isEmpty {
                    VStack(spacing: 12) { Image(systemName: "text.bubble").font(.largeTitle).foregroundStyle(WatsonStyle.purple); Text(query.isEmpty ? "Your notes will feel at home here." : "No matching conversations").font(.headline); Text(query.isEmpty ? "Start recording, or explore a clearly labeled sample." : "Search titles, transcripts, notes, and chat.").font(.subheadline).foregroundStyle(.secondary); if query.isEmpty { Button("Explore a sample") { path.append(store.addSample()) }.accessibilityIdentifier("add-sample") } }.frame(maxWidth: .infinity).padding(.vertical, 28)
                } else {
                    ForEach(meetings) { meeting in
                        Button { path.append(meeting.id) } label: { MeetingRow(meeting: meeting, active: meeting.id == store.activeID, recording: store.recording) }.buttonStyle(.plain).accessibilityIdentifier("meeting-\(meeting.id)")
                            .contextMenu { Button(meeting.pinned ? "Unpin" : "Pin", systemImage: "pin") { store.update(meeting.id) { $0.pinned.toggle() } }; Button("Delete", systemImage: "trash", role: .destructive) { deleteID = meeting.id } }
                    }
                }
                Text(store.status).font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity)
            }.padding(20)
        }
        .navigationTitle("Watson").navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Search your conversations")
        .navigationDestination(for: String.self) { id in MeetingView(id: id) }
        .sheet(isPresented: $newConversation) {
            NavigationStack {
                Form {
                    Section { TextField("Conversation title", text: $title).accessibilityIdentifier("conversation-title"); Picker("Mode", selection: Binding(get: { store.data.settings.activeModeId }, set: { value in store.setSettings { $0.activeModeId = value } })) { ForEach(store.data.modes) { Text($0.name).tag($0.id) } } }
                    Section { Text("Place your iPhone near the conversation. Recording will continue while the screen is locked.").foregroundStyle(.secondary); if !store.hasDeepgram { Label("Add a Deepgram key in Settings first.", systemImage: "key").foregroundStyle(WatsonStyle.purple) } }
                    Button { Task { if let id = await store.start(title: title) { newConversation = false; path.append(id) } } } label: { HStack { Spacer(); if store.connecting { ProgressView() } else { Label("Start recording", systemImage: "mic.fill") }; Spacer() } }.disabled(store.connecting).accessibilityIdentifier("confirm-recording")
                }.navigationTitle("New conversation").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { newConversation = false } } }
            }.presentationDetents([.medium, .large])
        }
        .confirmationDialog("Delete this conversation and its local audio?", isPresented: Binding(get: { deleteID != nil }, set: { if !$0 { deleteID = nil } }), titleVisibility: .visible) { Button("Delete conversation", role: .destructive) { if let id = deleteID { Task { await store.delete(id) } }; deleteID = nil } }
    }
}

struct MeetingRow: View {
    let meeting: Meeting
    let active: Bool
    let recording: Bool
    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: active && recording ? "waveform" : "doc.text").font(.title3).foregroundStyle(WatsonStyle.purple).frame(width: 42, height: 42).background(WatsonStyle.pale, in: RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 5) {
                HStack { Text(meeting.title).font(.headline).lineLimit(2); if meeting.pinned { Image(systemName: "pin.fill").font(.caption).foregroundStyle(WatsonStyle.purple) } }
                Text(meeting.date, format: .dateTime.month(.abbreviated).day().hour().minute()).font(.caption).foregroundStyle(.secondary)
                if meeting.demo { Pill(text: "SAMPLE DATA") } else if active { Pill(text: recording ? "RECORDING" : "PAUSED", color: recording ? .red : WatsonStyle.purple) }
                Text(meeting.notes.isEmpty ? "\(meeting.transcript.count) transcript segments" : meeting.notes.replacingOccurrences(of: "#", with: "")).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 0); Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
        }.padding(16).background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18)).overlay(RoundedRectangle(cornerRadius: 18).stroke(Color(.separator).opacity(0.25)))
    }
}
