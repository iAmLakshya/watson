import SwiftUI
import UniformTypeIdentifiers

struct KnowledgeView: View {
    @EnvironmentObject var store: WatsonStore
    @State private var mode: Mode?
    @State private var addingDocument = false
    @State private var importing = false
    @State private var documentTitle = ""
    @State private var documentText = ""
    @State private var deleteDocument: String?
    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 10) { Image(systemName: "sparkles").font(.largeTitle).foregroundStyle(WatsonStyle.purple); Text("Make Watson yours.").font(.title2.bold()); Text("Choose how Watson helps and add the context it should use.").foregroundStyle(.secondary) }.padding(.vertical, 12)
            }
            Section("Conversation modes") {
                ForEach(store.data.modes) { item in
                    Button { mode = item } label: { HStack { VStack(alignment: .leading, spacing: 5) { Text(item.name).font(.headline); Text(item.instructions).font(.caption).foregroundStyle(.secondary).lineLimit(2) }; Spacer(); if item.id == store.data.settings.activeModeId { Image(systemName: "checkmark.circle.fill").foregroundStyle(WatsonStyle.purple) }; Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary) } }.buttonStyle(.plain)
                }
                Button("Create a mode", systemImage: "plus") { mode = Mode(name: "My mode") }.accessibilityIdentifier("create-mode")
            }
            Section {
                ForEach(store.data.knowledge) { document in
                    NavigationLink { ScrollView { Text(document.text).textSelection(.enabled).padding(20).frame(maxWidth: .infinity, alignment: .leading) }.navigationTitle(document.title).toolbar { Button("Delete", systemImage: "trash", role: .destructive) { deleteDocument = document.id } } } label: { VStack(alignment: .leading, spacing: 5) { Text(document.title).font(.headline); Text("\(document.fileType.uppercased()) · \(document.size) bytes").font(.caption).foregroundStyle(.secondary) } }
                }
                Button("Write context", systemImage: "square.and.pencil") { documentTitle = ""; documentText = ""; addingDocument = true }
                Button("Import a document", systemImage: "doc.badge.plus") { importing = true }
            } header: { Text("Knowledge") } footer: { Text("Import a text, Markdown, or text-based PDF document. Attach documents to a mode to use them in its answers. Files remain local unless you connect sync.") }
        }.navigationTitle("Personalize")
            .sheet(item: $mode) { item in ModeEditor(mode: item) }
            .sheet(isPresented: $addingDocument) {
                NavigationStack { Form { Section { TextField("Document title", text: $documentTitle); TextEditor(text: $documentText).frame(minHeight: 250) } }.navigationTitle("Add context").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { addingDocument = false } }; ToolbarItem(placement: .confirmationAction) { Button("Save") { store.addKnowledge(title: documentTitle, text: documentText); addingDocument = false }.disabled(documentTitle.isEmpty || documentText.isEmpty) } } }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.plainText, .pdf, UTType(filenameExtension: "md") ?? .plainText], allowsMultipleSelection: false) { result in switch result { case .success(let urls): if let url = urls.first { store.importKnowledge(url) }; case .failure(let error): store.error = error.localizedDescription } }
            .confirmationDialog("Delete this document?", isPresented: Binding(get: { deleteDocument != nil }, set: { if !$0 { deleteDocument = nil } }), titleVisibility: .visible) { Button("Delete document", role: .destructive) { if let id = deleteDocument { store.deleteKnowledge(id) }; deleteDocument = nil } }
    }
}

struct ModeEditor: View {
    @EnvironmentObject var store: WatsonStore
    @Environment(\.dismiss) var dismiss
    @State var mode: Mode
    @State private var deleteConfirmation = false
    private let templates = ["General": "## Summary\n## Decisions\n## Action items\n## Open questions", "Sales": "## Customer needs\n## Discussion\n## Objections\n## Decisions\n## Action items", "Interview": "## Candidate background\n## Questions and answers\n## Evidence\n## Action items", "Standup": "## Progress\n## Blockers\n## Decisions\n## Action items"]
    var body: some View {
        NavigationStack {
            Form {
                Section("Mode") { TextField("Name", text: $mode.name).accessibilityIdentifier("mode-name"); TextEditor(text: $mode.instructions).frame(minHeight: 110).accessibilityIdentifier("mode-instructions") }
                Section("Note template") { Menu("Choose a template") { ForEach(templates.keys.sorted(), id: \.self) { name in Button(name) { mode.noteTemplate = templates[name]! } } }; TextEditor(text: $mode.noteTemplate).frame(minHeight: 140) }
                Section { ForEach(store.data.knowledge) { document in Toggle(document.title, isOn: Binding(get: { mode.documentIds.contains(document.id) }, set: { enabled in if enabled { mode.documentIds.append(document.id) } else { mode.documentIds.removeAll { $0 == document.id } } })) } } header: { Text("Reference documents") } footer: { Text("Watson uses the final transcript and these documents when generating an answer in this mode.") }
                Button("Use as default mode") { store.setSettings { $0.activeModeId = mode.id }; store.saveMode(mode); dismiss() }
                if mode.builtIn != true { Button("Delete mode", role: .destructive) { deleteConfirmation = true } }
            }.navigationTitle("Edit mode").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Save") { store.saveMode(mode); dismiss() }.disabled(mode.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).accessibilityIdentifier("save-mode") } }
                .confirmationDialog("Delete this mode?", isPresented: $deleteConfirmation, titleVisibility: .visible) { Button("Delete mode", role: .destructive) { store.deleteMode(mode.id); dismiss() } }
        }
    }
}
