import Foundation

struct CloudClient {
    let base: URL
    let token: String?
    let session: URLSession
    init(address: String, token: String? = nil, session: URLSession = .shared) throws { base = try BackendAddress.validate(address); self.token = token; self.session = session }
    func request<T: Decodable>(_ method: String, path: String, body: Data? = nil, as type: T.Type = T.self, authenticated: Bool = true) async throws -> T {
        let url = path.split(separator: "/").reduce(base) { $0.appendingPathComponent(String($1)) }
        var request = URLRequest(url: url); request.httpMethod = method; request.httpBody = body; request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if authenticated, let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw WatsonError.message("Watson backend returned an invalid response.") }
        guard (200..<300).contains(response.statusCode) else {
            switch response.statusCode { case 401: throw WatsonError.message("Your account session expired. Sign in again."); case 409: throw WatsonError.message("This item changed on another device. Sync and resolve the conflict first."); case 403: throw WatsonError.message("Your account does not have access to this action."); default: throw WatsonError.message("Watson backend request failed (HTTP \(response.statusCode)).") }
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    func auth(email: String, password: String, name: String, signup: Bool) async throws -> AuthResponse {
        let body = try JSONSerialization.data(withJSONObject: ["email": email, "password": password, "name": name, "deviceName": "Watson iPhone"])
        return try await request("POST", path: "auth/\(signup ? "signup" : "login")", body: body)
    }
    func sync(_ request: SyncRequest) async throws -> SyncResponse { try await self.request("POST", path: "sync", body: JSONEncoder().encode(request)) }
    func share(_ id: String) async throws -> ShareResponse { try await request("POST", path: "meetings/\(id)/share", body: Data("{}".utf8)) }
    func revokeShare(_ id: String) async throws { let _: JSONValue = try await request("DELETE", path: "meetings/\(id)/share") }
    func logout() async throws { let _: JSONValue = try await request("POST", path: "auth/logout", body: Data("{}".utf8)) }
    func deleteAccount(password: String) async throws { let _: JSONValue = try await request("DELETE", path: "me", body: JSONSerialization.data(withJSONObject: ["currentPassword": password])) }
    func profile(name: String) async throws -> CloudUser {
        let body = try JSONSerialization.data(withJSONObject: ["name": name])
        let response: JSONValue = try await request("PATCH", path: "me", body: body)
        if case .object(let object) = response, let user = object["user"] { return try user.decode(CloudUser.self) }
        return try response.decode(CloudUser.self)
    }
    func accountCapabilities() async throws -> AccountCapabilities { try await request("GET", path: "auth/capabilities", authenticated: false) }
    func accountProfile() async throws -> CloudUser { let response: AccountProfile = try await request("GET", path: "me"); return response.user }
    func requestVerification() async throws -> AccountActionResponse { try await request("POST", path: "me/email-verification", body: Data("{}".utf8)) }
    func requestPasswordReset(email: String) async throws -> AccountActionResponse { try await request("POST", path: "auth/password-reset/request", body: JSONSerialization.data(withJSONObject: ["email":email]), authenticated: false) }
}
