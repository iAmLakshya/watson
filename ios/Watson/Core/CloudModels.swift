import Foundation

public enum JSONValue: Codable, Equatable, Sendable {
    case object([String: JSONValue]), array([JSONValue]), string(String), number(Double), bool(Bool), null
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else { self = .array(try container.decode([JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self { case .object(let v): try container.encode(v); case .array(let v): try container.encode(v); case .string(let v): try container.encode(v); case .number(let v): try container.encode(v); case .bool(let v): try container.encode(v); case .null: try container.encodeNil() }
    }
    public static func encode<T: Encodable>(_ value: T) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value)) }
    public func decode<T: Decodable>(_ type: T.Type) throws -> T { try JSONDecoder().decode(type, from: JSONEncoder().encode(self)) }
}
public struct CloudUser: Codable, Equatable, Sendable {
    public var id: String
    public var email: String
    public var name: String
    public var emailVerified: Bool?
    public var emailVerifiedAt: String?
}
public struct AccountCapabilities: Codable, Equatable, Sendable { public var emailDeliveryConfigured: Bool; public var verificationRequired: Bool; public var passwordRecoveryConfigured: Bool }
public struct AccountProfile: Decodable, Sendable { public var user: CloudUser }
public struct AccountActionResponse: Decodable, Sendable { public var accepted: Bool; public var message: String }
public struct CloudDevice: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var createdAt: String
}
public struct AuthResponse: Codable, Sendable {
    public var token: String
    public var expiresAt: String
    public var user: CloudUser
    public var device: CloudDevice
}
public struct PendingChange: Codable, Equatable, Sendable {
    public var entity: String
    public var id: String
    public var expectedRevision: Int
    public var data: JSONValue?
    public var changeId: String
    public init(entity: String, id: String, expectedRevision: Int, data: JSONValue?) {
        self.entity = entity; self.id = id; self.expectedRevision = expectedRevision; self.data = data; self.changeId = UUID().uuidString
    }
    enum CodingKeys: String, CodingKey { case entity, id, expectedRevision, data, changeId }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(entity, forKey: .entity); try container.encode(id, forKey: .id); try container.encode(expectedRevision, forKey: .expectedRevision); try container.encode(changeId, forKey: .changeId)
        if let data { try container.encode(data, forKey: .data) } else { try container.encodeNil(forKey: .data) }
    }
    public var key: String { "\(entity):\(id)" }
}
public struct SyncChange: Codable, Equatable, Sendable {
    public var sequence: Int?
    public var entity: String
    public var id: String
    public var revision: Int
    public var data: JSONValue?
    public var deleted: Bool?
    public var updatedAt: String?
    public var key: String { "\(entity):\(id)" }
}
public struct SyncConflict: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var entity: String
    public var code: String
    public var current: SyncChange?
    public var key: String { "\(entity):\(id)" }
}
public struct SyncRequest: Encodable, Sendable {
    public var deviceId: String
    public var cursor: Int
    public var changes: [PendingChange]
    public init(deviceId: String, cursor: Int, changes: [PendingChange]) { self.deviceId = deviceId; self.cursor = cursor; self.changes = changes }
}
public struct SyncResponse: Decodable, Sendable {
    public var cursor: Int
    public var changes: [SyncChange]
    public var conflicts: [SyncConflict]
    public var applied: [SyncChange]?
    public var policy: BackendPolicy?
}
public struct BackendPolicy: Codable, Equatable, Sendable { public var retentionDays: Int; public var recordingAllowed: Bool; public var publicSharingAllowed: Bool }
public struct ShareResponse: Decodable, Sendable { public var token: String; public var url: String; public var expiresAt: String? }

public enum BackendAddress {
    public static func validate(_ text: String) throws -> URL {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)), let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(), !host.isEmpty, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { throw WatsonError.message("Enter a backend URL such as https://watson.example.com/api/v1.") }
        let loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host)
        guard scheme == "https" || (scheme == "http" && loopback) else { throw WatsonError.message("Use HTTPS for a network backend. HTTP is available only for localhost development.") }
        return url
    }
}

/// Shares only common preferences; credentials and phone backend configuration never sync.
public struct CommonSettings: Codable {
    public var language: String
    public var outputLanguage: String
    public var model: String
    public var transcriptionModel: String
    public var instructions: String
    public var activeModeId: String
    public var autoAssist: Bool
    public var smartMode: Bool
    public var smartModel: String?
    public var smartReasoningEffort: String?
    public var smartWebSearch: Bool?
    public var smartMaxOutputTokens: Int?
    public init(_ settings: MobileSettings) { language = settings.language; outputLanguage = settings.outputLanguage; model = settings.model; transcriptionModel = settings.transcriptionModel; instructions = settings.instructions; activeModeId = settings.activeModeId; autoAssist = settings.autoAssist; smartMode = settings.smartMode; smartModel = settings.smartModel; smartReasoningEffort = settings.smartReasoningEffort; smartWebSearch = settings.smartWebSearch; smartMaxOutputTokens = settings.smartMaxOutputTokens }
}
