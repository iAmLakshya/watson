import Foundation

public enum ResponseEvent: Equatable, Sendable {
    case text(String), refusal(String), refusalDone(String), completedRefusal(String), citation(String, String), completed, failed(String)
    public static func decode(_ data: String) throws -> ResponseEvent? {
        if data == "[DONE]" { return nil }
        guard let bytes = data.data(using: .utf8), let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { return nil }
        switch value["type"] as? String {
        case "response.output_text.delta": return .text(value["delta"] as? String ?? "")
        case "response.refusal.delta": return .refusal(value["delta"] as? String ?? "")
        case "response.refusal.done": return .refusalDone(value["refusal"] as? String ?? "")
        case "response.output_text.annotation.added":
            guard let annotation = value["annotation"] as? [String: Any], annotation["type"] as? String == "url_citation", let url = annotation["url"] as? String else { return nil }
            return .citation(annotation["title"] as? String ?? url, url)
        case "response.completed":
            if let response = value["response"] as? [String: Any], let output = response["output"] as? [[String: Any]] {
                let refusal = output.flatMap { $0["content"] as? [[String: Any]] ?? [] }.filter { $0["type"] as? String == "refusal" }.compactMap { $0["refusal"] as? String }.joined(separator: "\n")
                if !refusal.isEmpty { return .completedRefusal(refusal) }
            }
            return .completed
        case "response.incomplete": return .failed("Response stopped before it was complete. The partial answer is saved.")
        case "response.failed", "error":
            let response = value["response"] as? [String: Any] ?? value
            let error = response["error"] as? [String: Any] ?? response
            return .failed(error["message"] as? String ?? "The AI provider could not finish this response.")
        default: return nil
        }
    }
}

public struct ResponseOutcome: Equatable, Sendable {
    public var text = ""
    public var refusal = ""
    public var refused = false
    public var completed = false
    public init() {}
    public var visibleText: String { text + (refusal.isEmpty ? "" : (text.isEmpty ? "" : "\n\n") + refusal) }
    public mutating func receive(_ event: ResponseEvent) {
        switch event {
        case .text(let value): text += value
        case .refusal(let value): refused = true; refusal += value
        case .refusalDone(let value): refused = true; refusal = value
        case .completedRefusal(let value): refused = true; refusal = value; completed = true
        case .completed: completed = true
        case .citation, .failed: break
        }
    }
}

public enum AnswerCompletion {
    /// Terminal provider output is kept in history. Only a usable accepted answer
    /// can replace notes/email, and only if the user has not edited them mid-stream.
    public static func apply(_ outcome: ResponseOutcome, to meeting: inout Meeting, answerID: String, originalNotes: String, originalEmail: String) {
        guard let index = meeting.answers.firstIndex(where: { $0.id == answerID }) else { return }
        meeting.answers[index].text = outcome.visibleText
        meeting.answers[index].refused = outcome.refused
        if outcome.refused {
            meeting.answers[index].status = "error"; meeting.answers[index].error = "The AI declined this request. Existing notes and email drafts were preserved."; return
        }
        guard outcome.completed, !outcome.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            meeting.answers[index].status = "error"; meeting.answers[index].error = "The AI did not return a usable complete text answer. Existing notes and email drafts were preserved."; return
        }
        meeting.answers[index].status = "complete"
        if meeting.answers[index].kind == "notes", meeting.notes == originalNotes { meeting.notes = outcome.text; meeting.actions = MeetingContext.actions(from: outcome.text) }
        if meeting.answers[index].kind == "email", meeting.followupDraft == originalEmail { meeting.followupDraft = outcome.text }
    }
}

/// SSE records may span several data lines; an empty line dispatches one record.
public struct SSEParser {
    private var data: [String] = []
    public init() {}
    public mutating func receive(line: String) -> String? {
        let clean = line.hasSuffix("\r") ? String(line.dropLast()) : line
        if clean.isEmpty { return finish() }
        if clean.hasPrefix("data:") { var value = String(clean.dropFirst(5)); if value.hasPrefix(" ") { value.removeFirst() }; data.append(value) }
        return nil
    }
    public mutating func finish() -> String? {
        guard !data.isEmpty else { return nil }
        let value = data.joined(separator: "\n"); data = []; return value
    }
}

/// Both desktop and iPhone use application acceptance as the origin. Uptime is
/// monotonic; wall-clock changes cannot shorten completion below first text.
public extension Answer {
    mutating func recordFirstText(_ text: String, startedAt: TimeInterval, now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        guard firstTextLatencyMs == nil, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        firstTextLatencyMs = max(0, (now - startedAt) * 1000)
    }
    mutating func recordCompletion(startedAt: TimeInterval, now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        latencyMs = max(latencyMs ?? 0, max(firstTextLatencyMs ?? 0, max(0, (now - startedAt) * 1000)))
    }
}
