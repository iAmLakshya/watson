import SwiftUI

struct RecordingsView: View {
    @EnvironmentObject var store: WatsonStore
    let id: String
    @State private var confirmingUpload = false
    @State private var uploadConsent = false
    @State private var deletingCloud = false
    @State private var deletingDownload: String?
    @State private var shareItems: [Any] = []
    @State private var sharing = false
    private var busy: Bool { store.audioTransferMeetingID != nil }
    var body: some View {
        List {
            if store.meeting(id)?.tags?.contains("generated-audio-fixture") == true { Section { Pill(text: "GENERATED CAF FIXTURE · NO MICROPHONE USED") } }
            Section {
                let files = store.recordings(id)
                if files.isEmpty { Text("No microphone audio segments are saved on this phone.").foregroundStyle(.secondary) }
                ForEach(Array(files.enumerated()), id: \.offset) { index, file in
                    VStack(alignment: .leading, spacing: 12) {
                        HStack { Label("Segment \(index + 1)", systemImage: "waveform").font(.headline); Spacer(); if let size = try? RecordingFile.size(file) { Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)).font(.caption).foregroundStyle(.secondary) } }
                        HStack {
                            Button("Play", systemImage: "play.circle") { store.play(file) }.buttonStyle(.borderless).disabled(store.recording).accessibilityIdentifier("play-local-segment-\(index)")
                            Spacer()
                            Button("Export", systemImage: "square.and.arrow.up") { shareItems = [file]; sharing = true }.buttonStyle(.borderless).accessibilityIdentifier("export-local-segment-\(index)")
                        }
                    }.padding(.vertical, 4)
                }
                if store.authenticated, !files.isEmpty { Button("Upload complete recording", systemImage: "icloud.and.arrow.up") { uploadConsent = false; confirmingUpload = true }.disabled(busy || store.recording || store.connecting || store.meeting(id)?.demo == true || store.recordingCapabilities?.configured != true || store.recordingCapabilities?.recordingAllowed != true).accessibilityIdentifier("upload-complete-recording") }
            } header: { Text("Nearby audio on this phone") } footer: { Text("Each pause/resume creates a separate CAF segment. Upload complete recording composes all saved segments in recorded order into one WAV, omitting paused periods. Originals remain on this phone.") }
            if store.playingAudio { Section { Button("Stop playback", systemImage: "stop.circle") { store.stopPlayback() }.accessibilityIdentifier("stop-audio-playback") } }
            Section {
                if store.authenticated {
                    Button { Task { await store.refreshRecordingMetadata(id) } } label: { HStack { Label("Refresh private recording", systemImage: "arrow.clockwise"); Spacer(); if store.refreshingRecordingID == id { ProgressView() } } }.disabled(store.refreshingRecordingID != nil || busy).accessibilityIdentifier("refresh-cloud-recording")
                    if let remote = store.remoteRecording(id) {
                        VStack(alignment: .leading, spacing: 8) {
                            Label(remote.filename ?? "Private recording", systemImage: "lock.icloud").font(.headline)
                            Text("\(ByteCountFormatter.string(fromByteCount: Int64(remote.size), countStyle: .file)) · \(remote.contentType)").font(.caption).foregroundStyle(.secondary)
                            Text(remote.encryptedAtRest ? "Server reports encrypted storage" : "Legacy server recording").font(.caption).foregroundStyle(.secondary)
                        }.accessibilityIdentifier("cloud-recording-metadata")
                        Button("Download private copy", systemImage: "icloud.and.arrow.down") { store.beginRecordingDownload(id) }.disabled(busy).accessibilityIdentifier("download-cloud-recording")
                        Button("Delete cloud recording", systemImage: "trash", role: .destructive) { deletingCloud = true }.disabled(busy || store.recording).accessibilityIdentifier("delete-cloud-recording")
                    } else { Text("No private recording is listed. Refresh to check the server.").font(.subheadline).foregroundStyle(.secondary) }
                    if let capabilities = store.recordingCapabilities, !capabilities.configured || !capabilities.recordingAllowed { Text("Private audio storage is unavailable or disabled on this server.").font(.caption).foregroundStyle(.secondary) }
                    Text("The server keeps one complete recording per meeting. Uploading replaces its cloud copy with all saved segments. Recording bytes are excluded from public meeting links.").font(.caption).foregroundStyle(.secondary)
                } else { Text("Connect your account in Settings to upload or download a private recording.").foregroundStyle(.secondary) }
            } header: { Text("Private cloud recording") }
            if !store.downloadedRecordings(id).isEmpty {
                Section {
                    ForEach(store.downloadedRecordings(id)) { copy in
                        VStack(alignment: .leading, spacing: 10) {
                            Text(copy.metadata.filename ?? "Downloaded recording").font(.headline)
                            Text("Downloaded \(WatsonTime.date(copy.downloadedAt)?.formatted(date: .abbreviated, time: .shortened) ?? copy.downloadedAt)").font(.caption).foregroundStyle(.secondary)
                            HStack { Button("Play", systemImage: "play.circle") { if let url = store.downloadedURL(copy) { store.play(url) } }.buttonStyle(.borderless).disabled(store.recording).accessibilityIdentifier("play-downloaded-recording"); Spacer(); Button("Export", systemImage: "square.and.arrow.up") { if let url = store.downloadedURL(copy) { shareItems = [url]; sharing = true } }.buttonStyle(.borderless); Button("Remove", systemImage: "trash", role: .destructive) { deletingDownload = copy.id }.buttonStyle(.borderless) }
                        }.padding(.vertical, 4)
                    }
                } header: { Text("Downloaded copies on this phone") } footer: { Text("Downloads are checked against the server’s byte count and SHA-256 before saving. Deleting the cloud copy leaves your chosen local downloads intact.") }
            }
            if store.audioTransferMeetingID == id { Section { HStack { ProgressView(); Text(store.audioTransferStatus) }; Button("Cancel transfer", role: .cancel) { store.cancelAudioTransfer() } }.accessibilityIdentifier("audio-transfer-progress") }
            Section { Text(store.status).font(.footnote).foregroundStyle(.secondary).accessibilityIdentifier("recording-status") }
        }.navigationTitle("Recordings").navigationBarTitleDisplayMode(.inline)
            .onDisappear { store.stopPlayback() }
            .task { if store.authenticated { await store.refreshRecordingMetadata(id) } }
            .sheet(isPresented: $sharing) { ActivitySheet(items: shareItems) }
            .sheet(isPresented: $confirmingUpload) {
                NavigationStack {
                    Form {
                        Section { Label("Upload complete conversation", systemImage: "lock.icloud").font(.headline); Text("All \(store.data.recordings[id]?.count ?? 0) saved CAF segments are decoded and composed in recorded order into one valid WAV. Paused periods are omitted. The complete audio replaces any existing private cloud recording; every local original remains intact.") }
                        Section { Toggle("I have permission to upload this conversation’s audio", isOn: $uploadConsent).accessibilityIdentifier("recording-upload-consent") }
                    }.navigationTitle("Upload recording").toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { confirmingUpload = false } }
                        ToolbarItem(placement: .confirmationAction) { Button("Upload") { store.beginCompleteRecordingUpload(id, consent: uploadConsent); confirmingUpload = false }.disabled(!uploadConsent || busy || store.recording).accessibilityIdentifier("confirm-recording-upload") }
                    }
                }.presentationDetents([.medium, .large])
            }
            .confirmationDialog("Delete the private cloud recording? Original segments and downloaded copies on this phone remain available.", isPresented: $deletingCloud, titleVisibility: .visible) { Button("Delete cloud copy", role: .destructive) { store.beginRemoteRecordingDelete(id) }.accessibilityIdentifier("confirm-cloud-recording-delete") }
            .confirmationDialog("Remove this downloaded copy from the phone? The server recording and original microphone segments are preserved.", isPresented: Binding(get: { deletingDownload != nil }, set: { if !$0 { deletingDownload = nil } }), titleVisibility: .visible) { Button("Remove downloaded copy", role: .destructive) { if let recordingID = deletingDownload { store.removeDownloadedRecording(id, recordingID: recordingID) }; deletingDownload = nil } }
    }
}
