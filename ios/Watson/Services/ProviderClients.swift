import Foundation

struct OpenAIClient {
    func stream(key: String, request: AssistanceRequest, onEvent: @escaping @Sendable (ResponseEvent) async -> Void) async throws -> ResponseOutcome {
        var http = URLRequest(url: URL(string: "https://api.openai.com/v1/responses")!)
        http.httpMethod = "POST"; http.timeoutInterval = 120
        http.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        http.setValue("application/json", forHTTPHeaderField: "Content-Type")
        http.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        http.httpBody = try request.json()
        let (bytes, response) = try await URLSession.shared.bytes(for: http)
        guard let response = response as? HTTPURLResponse else { throw WatsonError.message("AI provider returned an invalid HTTP response.") }
        guard (200..<300).contains(response.statusCode) else {
            // Do not display arbitrary provider bodies: they can echo credential-bearing requests.
            throw WatsonError.message("OpenAI request failed (HTTP \(response.statusCode)). Check the model, key, account limits, and connection.")
        }
        var parser = SSEParser()
        var outcome = ResponseOutcome()
        for try await line in bytes.lines {
            try Task.checkCancellation()
            if let data = parser.receive(line: line), let event = try ResponseEvent.decode(data) {
                outcome.receive(event)
                if case .failed(let message) = event { throw WatsonError.message(message) }
                await onEvent(event)
            }
        }
        if let data = parser.finish(), let event = try ResponseEvent.decode(data) {
            outcome.receive(event)
            if case .failed(let message) = event { throw WatsonError.message(message) }
            await onEvent(event)
        }
        guard outcome.completed else { throw WatsonError.message("The AI connection ended before completion. The partial answer is saved.") }
        return outcome
    }
}

actor DeepgramClient {
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var keepAlive: Task<Void, Never>?
    private var sender: Task<Void, Never>?
    private var queue: [Data] = []
    private var queuedBytes = 0
    private var accepting = false
    private var failureSent = false
    private var onResult: (@Sendable (DeepgramResult) async -> Void)?
    private var onError: (@Sendable (String) async -> Void)?
    private var connectionID = UUID()
    private var flushed = false
    func connect(key: String, language: String, model: String, onResult: @escaping @Sendable (DeepgramResult) async -> Void, onError: @escaping @Sendable (String) async -> Void) async throws {
        await close()
        self.onResult = onResult; self.onError = onError; failureSent = false; connectionID = UUID(); flushed = false
        var components = URLComponents(string: "wss://api.deepgram.com/v1/listen")!
        components.queryItems = ["model": model, "language": language, "encoding": "linear16", "sample_rate": "16000", "channels": "1", "interim_results": "true", "punctuate": "true", "smart_format": "true", "diarize_model": "latest", "endpointing": "300", "utterance_end_ms": "1000"].map { URLQueryItem(name: $0.key, value: $0.value) }
        var request = URLRequest(url: components.url!); request.setValue("Token \(key)", forHTTPHeaderField: "Authorization")
        let task = URLSession.shared.webSocketTask(with: request)
        socket = task; accepting = true; task.resume()
        let id = connectionID
        receiveTask = Task { [weak self] in await self?.receive(id: id) }
        keepAlive = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 4_000_000_000); try Task.checkCancellation(); try await self?.sendControl("KeepAlive", id: id) }
                catch { if !Task.isCancelled { await self?.fail("Transcription connection was interrupted. Resume recording to reconnect.", id: id) }; break }
            }
        }
        // Ping waits for the WebSocket handshake before AVAudioEngine starts delivering audio.
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            task.sendPing { error in if let error { continuation.resume(throwing: error) } else { continuation.resume() } }
        }
    }
    func enqueue(_ data: Data) async {
        guard accepting, !data.isEmpty else { return }
        guard queuedBytes + data.count <= 16000 * 2 * 8 else { await fail("Transcription is too slow to keep up. Recording paused to avoid losing speech.", id: connectionID); return }
        queue.append(data); queuedBytes += data.count
        if sender == nil { let id = connectionID; sender = Task { [weak self] in await self?.drain(id: id) } }
    }
    private func drain(id: UUID) async {
        while !queue.isEmpty, id == connectionID, let socket {
            let data = queue.removeFirst(); queuedBytes -= data.count
            do { try await socket.send(.data(data)) }
            catch { await fail("Transcription audio could not be sent. Resume recording to reconnect.", id: id); break }
        }
        if id == connectionID { sender = nil }
    }
    private func receive(id: UUID) async {
        while !Task.isCancelled, id == connectionID, let socket {
            do {
                let message = try await socket.receive()
                let data: Data
                switch message { case .data(let bytes): data = bytes; case .string(let text): data = Data(text.utf8); @unknown default: continue }
                if let result = try DeepgramResult.decode(data), id == connectionID { await onResult?(result) }
                else if !accepting, (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["type"] as? String == "Metadata" { flushed = true }
            } catch { if id == connectionID && !accepting { flushed = true }; if !Task.isCancelled && accepting && id == connectionID { await fail("Transcription disconnected. Check the Deepgram key, language, and connection, then resume.", id: id) }; break }
        }
    }
    private func sendControl(_ type: String, id: UUID) async throws { if id == connectionID { try await socket?.send(.string("{\"type\":\"\(type)\"}")) } }
    private func fail(_ message: String, id: UUID) async {
        guard id == connectionID, !failureSent else { return }
        failureSent = true; accepting = false; queue = []; queuedBytes = 0
        await onError?(message)
    }
    func finish() async {
        accepting = false; keepAlive?.cancel(); keepAlive = nil
        let id = connectionID
        await sender?.value
        do { try await sendControl("CloseStream", id: id) } catch { await fail("The transcription connection ended before final speech could be confirmed. Only final text was saved.", id: id) }
        // Wait for trailing Metadata/close, rather than discarding late final Results.
        for _ in 0..<20 { if flushed || id != connectionID { break }; try? await Task.sleep(nanoseconds: 250_000_000) }
        if !flushed && id == connectionID { await fail("Transcription did not confirm its final flush. Only final transcript text was saved.", id: id) }
        await close()
    }
    func close() async {
        accepting = false; connectionID = UUID()
        receiveTask?.cancel(); keepAlive?.cancel(); sender?.cancel()
        receiveTask = nil; keepAlive = nil; sender = nil
        socket?.cancel(with: .normalClosure, reason: nil); socket = nil; queue = []; queuedBytes = 0
    }
}
