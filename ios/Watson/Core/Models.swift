import Foundation

public enum WatsonTime {
    public static func string(_ date: Date = Date()) -> String { ISO8601DateFormatter().string(from: date) }
    public static func date(_ string: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: string) ?? ISO8601DateFormatter().date(from: string)
    }
}

public struct TranscriptLine: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var source: String
    public var text: String
    public var timestamp: String
    public var final: Bool
    public var speaker: Int?
    public init(id: String = UUID().uuidString, source: String = "microphone", text: String, timestamp: String = WatsonTime.string(), final: Bool = true, speaker: Int? = nil) {
        self.id = id; self.source = source; self.text = text; self.timestamp = timestamp; self.final = final; self.speaker = speaker
    }
    public var label: String { speaker.map { "Speaker \($0 + 1)" } ?? (source == "system" ? "Computer audio" : "Nearby speech") }
}

public struct ContextSource: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var kind: String
    public var excerpt: String?
    public var url: String?
    public init(id: String = UUID().uuidString, title: String, kind: String, excerpt: String? = nil, url: String? = nil) {
        self.id = id; self.title = title; self.kind = kind; self.excerpt = excerpt; self.url = url
    }
}

public struct Answer: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var kind: String
    public var question: String
    public var text: String
    public var createdAt: String
    public var status: String
    public var sources: [ContextSource]
    public var latencyMs: Double?
    public var firstTextLatencyMs: Double?
    public var latencyScope: String?
    public var refused: Bool?
    public var error: String?
    public var scope: String?
    public var eventId: String?
    public var actionId: String?
    public var coachingAssessmentId: String?
    public init(kind: String, question: String = "", text: String = "", status: String = "streaming", sources: [ContextSource] = []) {
        self.id = UUID().uuidString; self.kind = kind; self.question = question; self.text = text; self.createdAt = WatsonTime.string(); self.status = status; self.sources = sources
    }
}

/// Wire-compatible with shared/types.ts Session. Mobile audio-file references stay local.
public struct Meeting: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var startedAt: String
    public var endedAt: String?
    public var modeId: String
    public var demo: Bool
    public var pinned: Bool
    public var transcript: [TranscriptLine]
    public var answers: [Answer]
    public var notes: String
    public var actions: [String]
    public var followupDraft: String
    public var tags: [String]?
    public var attendeeIds: [String]?
    public var calendarEventId: String?
    public var commitments: [JSONValue]?
    public var coaching: [JSONValue]?
    public var usage: JSONValue?
    public var meetingDetectionId: String?
    public var organizationId: String?
    public var recording: JSONValue?
    public var consentConfirmed: Bool?
    public init(id: String = UUID().uuidString, title: String = "New conversation", modeId: String = "general", demo: Bool = false) {
        self.id = id; self.title = title; self.startedAt = WatsonTime.string(); self.modeId = modeId; self.demo = demo; self.pinned = false; self.transcript = []; self.answers = []; self.notes = ""; self.actions = []; self.followupDraft = ""; self.tags = []
    }
    public var date: Date { WatsonTime.date(startedAt) ?? Date.distantPast }
    public var searchableText: String { ([title, notes, followupDraft] + transcript.map(\.text) + answers.map(\.text) + actions + (tags ?? [])).joined(separator: "\n") }
    public var markdown: String {
        var text = "# \(title)\n\n\(demo ? "Sample conversation — fixture data\n\n" : "")Started: \(startedAt)\n\n## Notes\n\n\(notes)\n\n## Actions\n\n\(actions.map { "- \($0)" }.joined(separator: "\n"))\n\n## Transcript\n\n"
        text += transcript.filter(\.final).map { "**\($0.label)**: \($0.text)" }.joined(separator: "\n\n")
        if !followupDraft.isEmpty { text += "\n\n## Follow-up email\n\n\(followupDraft)" }
        if !answers.isEmpty { text += "\n\n## Assistance\n\n" + answers.map { "### \($0.question.isEmpty ? $0.kind : $0.question)\n\n\($0.text)\($0.status == "error" ? "\n\nIncomplete: \($0.error ?? "Response failed")" : "")" }.joined(separator: "\n\n") }
        return text
    }
}

public struct Mode: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var instructions: String
    public var noteTemplate: String
    public var documentIds: [String]
    public var builtIn: Bool?
    public var emailTemplate: String?
    public var customActions: [JSONValue]?
    public var shared: Bool?
    public var assigned: Bool?
    public var folderId: String?
    public var inference: String?
    public var organizationId: String?
    public var teamId: String?
    public init(id: String = UUID().uuidString, name: String, instructions: String = "", noteTemplate: String = "## Summary\n## Decisions\n## Action items\n## Open questions", documentIds: [String] = [], builtIn: Bool = false) {
        self.id = id; self.name = name; self.instructions = instructions; self.noteTemplate = noteTemplate; self.documentIds = documentIds; self.builtIn = builtIn
    }
    public static let defaults: [Mode] = [Mode(id: "general", name: "General", instructions: "Offer concise, useful help for this conversation.", builtIn: true), Mode(id: "sales", name: "Sales", instructions: "Help discover needs, address objections accurately, and agree on clear next steps.", noteTemplate: "## Customer needs\n## Discussion\n## Decisions\n## Action items\n## Open questions", builtIn: true), Mode(id: "interview", name: "Interview", instructions: "Help structure authentic answers from the user's own experience. Do not invent experience.", builtIn: true)]
}

public struct KnowledgeDocument: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var text: String
    public var addedAt: String
    public var size: Int
    public var fileType: String
    public var shared: Bool?
    public var folderId: String?
    public var tags: [String]?
    public var sourceUrl: String?
    public init(id: String = UUID().uuidString, title: String, text: String, fileType: String = "txt") {
        self.id = id; self.title = title; self.text = text; self.addedAt = WatsonTime.string(); self.size = text.utf8.count; self.fileType = fileType
    }
}

public struct MobileSettings: Codable, Equatable, Sendable {
    public var language = "en"
    public var outputLanguage = "English"
    public var model = "gpt-4.1-mini"
    public var transcriptionModel = "nova-3"
    public var instructions = ""
    public var activeModeId = "general"
    public var autoAssist = false
    public var smartMode = false
    public var smartModel = "gpt-5.4-mini"
    public var smartReasoningEffort = "medium"
    public var smartWebSearch = true
    public var smartMaxOutputTokens = 25000
    public var automaticNotes = true
    public var backendURL = ""
    public var automaticSync = true
    public var completedOnboarding = false
    public init() {}
    enum CodingKeys: String, CodingKey { case language, outputLanguage, model, transcriptionModel, instructions, activeModeId, autoAssist, smartMode, smartModel, smartReasoningEffort, smartWebSearch, smartMaxOutputTokens, automaticNotes, backendURL, automaticSync, completedOnboarding }
    /// Older snapshots preserve all saved preferences and acquire the new Smart defaults.
    public init(from decoder: Decoder) throws {
        self.init()
        let values = try decoder.container(keyedBy: CodingKeys.self)
        language = try values.decodeIfPresent(String.self, forKey: .language) ?? language
        outputLanguage = try values.decodeIfPresent(String.self, forKey: .outputLanguage) ?? outputLanguage
        model = try values.decodeIfPresent(String.self, forKey: .model) ?? model
        transcriptionModel = try values.decodeIfPresent(String.self, forKey: .transcriptionModel) ?? transcriptionModel
        instructions = try values.decodeIfPresent(String.self, forKey: .instructions) ?? instructions
        activeModeId = try values.decodeIfPresent(String.self, forKey: .activeModeId) ?? activeModeId
        autoAssist = try values.decodeIfPresent(Bool.self, forKey: .autoAssist) ?? autoAssist
        smartMode = try values.decodeIfPresent(Bool.self, forKey: .smartMode) ?? smartMode
        smartModel = try values.decodeIfPresent(String.self, forKey: .smartModel) ?? smartModel
        smartReasoningEffort = try values.decodeIfPresent(String.self, forKey: .smartReasoningEffort) ?? smartReasoningEffort
        smartWebSearch = try values.decodeIfPresent(Bool.self, forKey: .smartWebSearch) ?? smartWebSearch
        smartMaxOutputTokens = try values.decodeIfPresent(Int.self, forKey: .smartMaxOutputTokens) ?? smartMaxOutputTokens
        automaticNotes = try values.decodeIfPresent(Bool.self, forKey: .automaticNotes) ?? automaticNotes
        backendURL = try values.decodeIfPresent(String.self, forKey: .backendURL) ?? backendURL
        automaticSync = try values.decodeIfPresent(Bool.self, forKey: .automaticSync) ?? automaticSync
        completedOnboarding = try values.decodeIfPresent(Bool.self, forKey: .completedOnboarding) ?? completedOnboarding
    }
    public static let inputLanguages = [("en", "English"), ("es", "Spanish"), ("fr", "French"), ("de", "German"), ("it", "Italian"), ("pt", "Portuguese")]
    public static let outputLanguages = ["Arabic", "Bengali", "Cantonese", "German", "English", "Farsi", "French", "Italian", "Japanese", "Korean", "Mandarin", "Dutch", "Polish", "Portuguese", "Russian", "Spanish", "Tamil", "Thai", "Turkish", "Urdu", "Vietnamese"]
}

public struct LocalSnapshot: Codable {
    public var version = 1
    public var settings: MobileSettings
    public var meetings: [Meeting]
    public var knowledge: [KnowledgeDocument]
    public var modes: [Mode]
    public var recordings: [String: [String]]
    public var revisions: [String: Int]
    public var pending: [String: PendingChange]
    public var cursor: Int
    public var cloudUser: CloudUser?
    public var cloudDevice: CloudDevice?
    public var cloudOwnerId: String?
    public var cloudPolicy: BackendPolicy?
    public var remoteRecordings: [String: RecordingMetadata]?
    public var downloadedRecordings: [String: [DownloadedRecording]]?
    public var conflicts: [SyncConflict]
    public init() { settings = MobileSettings(); meetings = []; knowledge = []; modes = Mode.defaults; recordings = [:]; revisions = [:]; pending = [:]; cursor = 0; conflicts = [] }
}

public enum WatsonError: LocalizedError, Equatable {
    case message(String)
    public var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}
