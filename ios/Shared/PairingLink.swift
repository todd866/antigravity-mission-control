import Foundation

struct PairingLink: Sendable, Equatable {
    let serverURL: String
    let fallbackServerURL: String?
    let token: String

    static func validateServerURL(_ raw: String) throws -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parsed = URL(string: trimmed),
              let scheme = parsed.scheme?.lowercased(),
              let host = parsed.host?.lowercased(),
              !host.isEmpty else {
            throw PairingLinkError.invalidServerURL
        }
        let isLocalHTTP = scheme == "http" && (host == "127.0.0.1" || host == "localhost")
        guard scheme == "https" || isLocalHTTP else {
            throw PairingLinkError.insecureServerURL
        }
        return trimmed.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    static func parse(_ url: URL) throws -> PairingLink {
        guard let scheme = url.scheme?.lowercased(), scheme == "agycontrol" else {
            throw PairingLinkError.invalidScheme
        }
        let host = url.host?.lowercased() ?? ""
        let path = url.path.lowercased()
        guard host == "pair" || path == "/pair" else {
            throw PairingLinkError.invalidAction
        }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let items = components.queryItems else {
            throw PairingLinkError.missingParameters
        }
        let rawServer = items.first(where: { $0.name == "url" || $0.name == "server" })?.value ?? ""
        let rawFallback = items.first(where: { $0.name == "fallback" || $0.name == "secondary" })?.value?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let rawToken = items.first(where: { $0.name == "token" || $0.name == "t" })?.value?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        let normalized = try validateServerURL(rawServer)
        let normalizedFallback = rawFallback.isEmpty ? nil : try validateServerURL(rawFallback)
        guard rawToken.count >= 16 else {
            throw PairingLinkError.invalidToken
        }
        return PairingLink(serverURL: normalized, fallbackServerURL: normalizedFallback, token: rawToken)
    }

    static func parse(_ rawString: String) throws -> PairingLink {
        let trimmed = rawString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed) else {
            throw PairingLinkError.invalidURL
        }
        return try parse(url)
    }
}

enum PairingLinkError: LocalizedError, Sendable, Equatable {
    case invalidURL
    case invalidScheme
    case invalidAction
    case missingParameters
    case invalidServerURL
    case insecureServerURL
    case invalidToken

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid pairing link format."
        case .invalidScheme:
            return "Pairing links must start with agycontrol://."
        case .invalidAction:
            return "Unsupported pairing action."
        case .missingParameters:
            return "Pairing link is missing server address or token."
        case .invalidServerURL:
            return "Pairing link has an invalid Mac address."
        case .insecureServerURL:
            return "Server address must use HTTPS (or loopback HTTP for local testing)."
        case .invalidToken:
            return "Pairing token is missing or too short."
        }
    }
}
