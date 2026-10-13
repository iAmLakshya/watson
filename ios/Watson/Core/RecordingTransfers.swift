import Foundation
import CryptoKit

public struct RecordingMetadata: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var contentType: String
    public var size: Int
    public var sha256: String
    public var filename: String?
    public var createdAt: String
    public var ownerOnly: Bool
    public var encryptedAtRest: Bool
    public var inline: Bool?
    public var fileExtension: String { switch contentType { case "audio/x-caf", "audio/caf": return "caf"; case "audio/wav": return "wav"; case "audio/webm": return "webm"; case "audio/mp4": return "m4a"; case "audio/mpeg": return "mp3"; case "audio/ogg": return "ogg"; default: return "audio" } }
}
public struct RecordingUploadResponse: Decodable, Sendable { public var recording: RecordingMetadata; public var revision: Int }
public struct RecordingInfoResponse: Decodable, Sendable { public var recording: RecordingMetadata }
public struct RecordingCapabilities: Codable, Equatable, Sendable { public var configured: Bool; public var maxBytes: Int; public var supportedContentTypes: [String]; public var recordingAllowed: Bool; public var consentRequired: Bool; public var attachmentsPerMeeting: Int }
public struct RecordingDeleteResponse: Decodable, Sendable { public var deleted: Bool; public var revision: Int }
public struct MeetingEnvelope: Decodable, Sendable { public var id: String; public var revision: Int; public var meeting: Meeting; public var updatedAt: String? }
public struct DownloadedRecording: Codable, Equatable, Identifiable, Sendable {
    public var metadata: RecordingMetadata
    public var filename: String
    public var downloadedAt: String
    public var id: String { metadata.id }
}

public enum RecordingFile {
    public static let maximumBytes = 128 * 1024 * 1024
    public static func size(_ url: URL) throws -> Int {
        guard url.isFileURL else { throw WatsonError.message("Choose a local audio recording.") }
        let resource = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard resource.isRegularFile == true, let size = resource.fileSize, size > 0 else { throw WatsonError.message("This recording is empty or unavailable.") }
        guard size <= maximumBytes else { throw WatsonError.message("This recording is larger than 128 MiB. Choose a smaller segment.") }
        return size
    }
    public static func hash(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
        var digest = SHA256()
        while let bytes = try handle.read(upToCount: 65536), !bytes.isEmpty { digest.update(data: bytes) }
        return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }
    public static func validate(_ url: URL, metadata: RecordingMetadata) throws {
        guard try size(url) == metadata.size, try hash(url).lowercased() == metadata.sha256.lowercased() else { throw WatsonError.message("Downloaded audio did not match its private recording metadata. No local copy was saved.") }
    }
}

extension CloudClient {
    func recordingCapabilities() async throws -> RecordingCapabilities { try await request("GET", path: "recordings/capabilities") }
    private func recordingRequest(_ method: String, id: String) throws -> URLRequest {
        guard let token, !token.isEmpty else { throw WatsonError.message("Connect an account before transferring a recording.") }
        guard !id.isEmpty, id.count <= 128, !id.contains("/"), !id.contains("\\") else { throw WatsonError.message("This meeting has an invalid recording identifier.") }
        var request = URLRequest(url: base.appendingPathComponent("meetings").appendingPathComponent(id).appendingPathComponent("recording"))
        request.httpMethod = method; request.timeoutInterval = 300
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }
    private func recordingResponse(_ response: URLResponse, allowed: Set<Int> = [200, 201]) throws -> HTTPURLResponse {
        guard let http = response as? HTTPURLResponse else { throw WatsonError.message("Private recording service returned an invalid response.") }
        guard allowed.contains(http.statusCode) else {
            switch http.statusCode {
            case 401: throw WatsonError.message("Your account session expired. Sign in before transferring audio.")
            case 403: throw WatsonError.message("Your account policy does not allow this recording transfer.")
            case 404: throw WatsonError.message("This private recording is unavailable for your account.")
            case 409: throw WatsonError.message("The meeting changed while audio was transferring. Sync and review the current meeting, then retry explicitly.")
            case 413: throw WatsonError.message("This recording exceeds the server’s upload limit.")
            case 415: throw WatsonError.message("This server does not accept CAF recordings. Ask its operator to enable audio/x-caf support.")
            case 503: throw WatsonError.message("Private recording storage is not configured on this server.")
            default: throw WatsonError.message("Private recording transfer failed (HTTP \(http.statusCode)).")
            }
        }
        return http
    }
    func meetingEnvelope(_ id: String) async throws -> MeetingEnvelope { try await request("GET", path: "meetings/\(id)") }
    func recordingInfo(_ id: String) async throws -> RecordingMetadata? {
        var request = try recordingRequest("GET", id: id); request.url = request.url?.appendingPathComponent("info")
        let (data, response) = try await session.data(for: request)
        if (response as? HTTPURLResponse)?.statusCode == 404 { return nil }
        _ = try recordingResponse(response)
        return try JSONDecoder().decode(RecordingInfoResponse.self, from: data).recording
    }
    func uploadRecording(_ id: String, file: URL, expectedRevision: Int, consent: Bool) async throws -> RecordingUploadResponse {
        guard consent else { throw WatsonError.message("Confirm permission to upload this conversation’s audio first.") }
        guard expectedRevision >= 1 else { throw WatsonError.message("Sync this meeting before uploading its recording.") }
        let contentType: String
        switch file.pathExtension.lowercased() { case "caf": contentType = "audio/x-caf"; case "wav": contentType = "audio/wav"; default: throw WatsonError.message("Choose a CAF recording or a complete WAV composed by Watson.") }
        let size = try RecordingFile.size(file)
        var request = try recordingRequest("PUT", id: id)
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.setValue(String(size), forHTTPHeaderField: "Content-Length")
        request.setValue(String(expectedRevision), forHTTPHeaderField: "X-Watson-Expected-Revision")
        request.setValue("true", forHTTPHeaderField: "X-Watson-Recording-Consent")
        let safe = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._"))
        request.setValue(file.lastPathComponent.addingPercentEncoding(withAllowedCharacters: safe), forHTTPHeaderField: "X-Watson-Filename")
        let (data, response) = try await session.upload(for: request, fromFile: file)
        _ = try recordingResponse(response, allowed: [201])
        return try JSONDecoder().decode(RecordingUploadResponse.self, from: data)
    }
    /// URLSession downloads to disk; audio is not accumulated in a response Data buffer.
    func downloadRecording(_ id: String, metadata: RecordingMetadata) async throws -> URL {
        let request = try recordingRequest("GET", id: id)
        let (url, response) = try await session.download(for: request)
        do {
            let http = try recordingResponse(response, allowed: [200])
            guard http.value(forHTTPHeaderField: "Content-Type")?.split(separator: ";").first?.lowercased() == metadata.contentType.lowercased() else { throw WatsonError.message("The recording format changed. Refresh its metadata and retry.") }
            try Task.checkCancellation(); try RecordingFile.validate(url, metadata: metadata)
            return url
        } catch { try? FileManager.default.removeItem(at: url); throw error }
    }
    func recordingRange(_ id: String, start: Int, end: Int) async throws -> Data {
        guard start >= 0, end >= start, end - start < 1024 * 1024 else { throw WatsonError.message("Choose a valid recording range smaller than 1 MiB.") }
        var request = try recordingRequest("GET", id: id); request.setValue("bytes=\(start)-\(end)", forHTTPHeaderField: "Range")
        let (data, response) = try await session.data(for: request)
        let http = try recordingResponse(response, allowed: [206])
        guard http.value(forHTTPHeaderField: "Content-Range")?.hasPrefix("bytes \(start)-\(end)/") == true, data.count == end - start + 1 else { throw WatsonError.message("The recording range was incomplete.") }
        return data
    }
    func deleteRecording(_ id: String, expectedRevision: Int) async throws -> RecordingDeleteResponse { try await request("DELETE", path: "meetings/\(id)/recording", body: JSONSerialization.data(withJSONObject: ["expectedRevision":expectedRevision])) }
}
