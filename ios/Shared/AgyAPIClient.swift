import Foundation

enum AgyAPIError: LocalizedError, Sendable {
    case notConfigured
    case invalidURL
    case httpError(Int, String)
    case decodingError(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Pair with your Mac in Settings first."
        case .invalidURL:
            return "Invalid server address."
        case .httpError(_, let message):
            return message
        case .decodingError(let msg):
            return "Response error: \(msg)"
        }
    }
}

struct AgyAPIClient: Sendable {
    let baseURL: String
    let token: String

    private var session: URLSession {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 12
        cfg.timeoutIntervalForResource = 20
        return URLSession(configuration: cfg)
    }

    private var briefSession: URLSession {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 45
        cfg.timeoutIntervalForResource = 60
        return URLSession(configuration: cfg)
    }

    func healthz() async throws -> HealthResponse {
        try await request(path: "/healthz", method: "GET", body: nil, authenticated: false)
    }

    func fetchBoard(includeHidden: Bool = false) async throws -> BoardResponse {
        let suffix = includeHidden ? "?includeHidden=1" : ""
        return try await request(path: "/v1/board\(suffix)", method: "GET", body: nil, authenticated: true)
    }

    func fetchDetail(id: String, host: String? = nil) async throws -> ThreadDetailResponse {
        let q = hostQuery(host)
        return try await request(path: "/v1/threads/\(id)\(q)", method: "GET", body: nil, authenticated: true)
    }

    func refreshBriefing(id: String, host: String? = nil) async throws -> ThreadDetailResponse {
        let body = try JSONSerialization.data(withJSONObject: hostBody(host))
        return try await request(
            path: "/v1/threads/\(id)/brief",
            method: "POST",
            body: body,
            authenticated: true,
            urlSession: briefSession
        )
    }

    func mutateOrder(
        action: String,
        conversationId: String? = nil,
        direction: String? = nil,
        toIndex: Int? = nil,
        value: String? = nil
    ) async throws -> BoardResponse {
        var payload: [String: Any] = ["action": action]
        if let conversationId { payload["conversationId"] = conversationId }
        if let direction { payload["direction"] = direction }
        if let toIndex { payload["toIndex"] = toIndex }
        if let value { payload["value"] = value }
        let body = try JSONSerialization.data(withJSONObject: payload)
        return try await request(path: "/v1/order", method: "POST", body: body, authenticated: true)
    }

    func focusThread(id: String, host: String? = nil) async throws -> ActionResult {
        let body = try JSONSerialization.data(withJSONObject: hostBody(host))
        return try await request(path: "/v1/threads/\(id)/focus", method: "POST", body: body, authenticated: true)
    }

    func stopThread(id: String, host: String? = nil) async throws -> ActionResult {
        let body = try JSONSerialization.data(withJSONObject: hostBody(host))
        return try await request(path: "/v1/threads/\(id)/stop", method: "POST", body: body, authenticated: true)
    }

    func sendMessage(id: String, text: String, host: String? = nil) async throws -> ActionResult {
        var payload: [String: Any] = ["text": text]
        if let host, !host.isEmpty { payload["host"] = host }
        let body = try JSONSerialization.data(withJSONObject: payload)
        return try await request(path: "/v1/threads/\(id)/message", method: "POST", body: body, authenticated: true)
    }

    func startThread(host: String? = nil, projectName: String?, text: String) async throws -> ActionResult {
        var payload: [String: Any] = ["text": text]
        if let host, !host.isEmpty { payload["host"] = host }
        if let projectName, !projectName.isEmpty {
            payload["projectName"] = projectName
        }
        let body = try JSONSerialization.data(withJSONObject: payload)
        return try await request(path: "/v1/threads/new", method: "POST", body: body, authenticated: true)
    }

    private func hostBody(_ host: String?) -> [String: Any] {
        guard let host, !host.isEmpty else { return [:] }
        return ["host": host]
    }

    private func hostQuery(_ host: String?) -> String {
        guard let host, !host.isEmpty,
              let encoded = host.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else {
            return ""
        }
        return "?host=\(encoded)"
    }

    private func request<T: Decodable>(
        path: String,
        method: String,
        body: Data?,
        authenticated: Bool,
        urlSession: URLSession? = nil
    ) async throws -> T {
        let cleanBase = baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        guard !cleanBase.isEmpty else { throw AgyAPIError.notConfigured }
        if authenticated && token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw AgyAPIError.notConfigured
        }
        guard let url = URL(string: cleanBase + path) else {
            throw AgyAPIError.invalidURL
        }

        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if authenticated {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, response) = try await (urlSession ?? session).data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if let errObj = try? JSONDecoder().decode(ActionResult.self, from: data),
               let errMsg = errObj.error, !errMsg.isEmpty {
                throw AgyAPIError.httpError(status, errMsg)
            }
            if status == 401 {
                throw AgyAPIError.httpError(401, "Invalid pairing token.")
            }
            throw AgyAPIError.httpError(status, "Server returned HTTP \(status).")
        }

        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw AgyAPIError.decodingError(error.localizedDescription)
        }
    }
}
