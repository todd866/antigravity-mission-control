import Foundation
import SwiftUI

enum ThreadState: String, Codable, Sendable, CaseIterable, Hashable {
    case attention
    case working
    case bg
    case unread
    case idle

    var displayName: String {
        switch self {
        case .attention: return "Waiting"
        case .working: return "Working"
        case .bg: return "Background"
        case .unread: return "Unread"
        case .idle: return "Idle"
        }
    }

    var symbolName: String {
        switch self {
        case .attention: return "exclamationmark.triangle.fill"
        case .working: return "arrow.trianglehead.2.clockwise"
        case .bg: return "clock.arrow.circlepath"
        case .unread: return "diamond.fill"
        case .idle: return "circle"
        }
    }

    var tintColor: Color {
        switch self {
        case .attention: return .orange
        case .working: return .cyan
        case .bg: return .indigo
        case .unread: return .green
        case .idle: return .secondary
        }
    }
}

enum ThreadFilter: String, CaseIterable, Identifiable, Sendable {
    case all
    case attention
    case working
    case bg
    case unread
    case idle

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .all: return "All"
        case .attention: return "Waiting"
        case .working: return "Working"
        case .bg: return "Background"
        case .unread: return "Unread"
        case .idle: return "Idle"
        }
    }

    var matchingState: ThreadState? {
        switch self {
        case .all: return nil
        case .attention: return .attention
        case .working: return .working
        case .bg: return .bg
        case .unread: return .unread
        case .idle: return .idle
        }
    }

    func count(in counts: BoardCounts) -> Int {
        switch self {
        case .all: return counts.total
        case .attention: return counts.attention
        case .working: return counts.working
        case .bg: return counts.bg
        case .unread: return counts.unread
        case .idle: return counts.idle
        }
    }
}

enum SortMode: String, Codable, CaseIterable, Identifiable, Sendable {
    case fixed
    case project
    case state

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .fixed: return "Fixed"
        case .project: return "Project"
        case .state: return "State"
        }
    }
}

struct BoardCounts: Codable, Sendable, Equatable {
    let total: Int
    let attention: Int
    let working: Int
    let bg: Int
    let unread: Int
    let idle: Int
    let hidden: Int
    let pendingRelays: Int?
}

struct RelayItem: Codable, Sendable, Equatable, Hashable, Identifiable {
    let id: String
    let fromLabel: String
    let targetConversationId: String
    let targetTitle: String
    let targetHost: String
    let message: String
    let hop: Int
    let status: String
    let reason: String
    let createdAt: Double
    let error: String?
}

struct StepItem: Codable, Sendable, Hashable, Identifiable {
    var id: String { "\(title)::\(status)" }
    let title: String
    let status: String

    var symbolName: String {
        switch status {
        case "done": return "checkmark.circle.fill"
        case "in_progress": return "arrow.right.circle.fill"
        case "failed": return "xmark.circle.fill"
        case "skipped": return "minus.circle"
        default: return "circle"
        }
    }

    var tintColor: Color {
        switch status {
        case "done": return .green
        case "in_progress": return .cyan
        case "failed": return .red
        default: return .secondary
        }
    }
}

struct StepsInfo: Codable, Sendable, Hashable {
    let items: [StepItem]
    let done: Int
    let total: Int
    let currentTitle: String

    var progressFraction: Double {
        guard total > 0 else { return 0 }
        return Double(done) / Double(total)
    }

    var ratioText: String {
        "\(done)/\(total)"
    }
}

struct SubagentInfo: Codable, Sendable, Hashable, Identifiable {
    let id: String
    let title: String
    let status: String
    let lastModifiedMs: Double?
}

struct EventInfo: Codable, Sendable, Hashable, Identifiable {
    var id: String { "\(createdAt)::\(kind)::\(text.prefix(24))" }
    let kind: String
    let status: String
    let createdAt: String
    let text: String

    var kindLabel: String {
        switch kind {
        case "user": return "Prompt"
        case "agent": return "Agent"
        case "bg": return "Background"
        case "error": return "Error"
        default: return kind.capitalized
        }
    }
}

struct NextAction: Codable, Sendable, Hashable, Identifiable {
    var id: String { "\(label)::\(prompt)" }
    let label: String
    let prompt: String
}

struct BriefingInfo: Codable, Sendable, Hashable {
    let headline: String
    let brief: String
    let currentWork: String
    let priorCompleted: String
    let needsUser: String
    let nextActions: [NextAction]?
    let updatedAt: Double?
    let model: String?

    var suggestions: [NextAction] {
        nextActions ?? []
    }
}

struct ConversationRow: Codable, Sendable, Identifiable, Hashable {
    let id: String
    let shortId: String
    let title: String
    let host: String?
    let projectId: String
    let projectName: String
    let stepCount: Int
    let state: ThreadState
    let waitingReason: String
    let unread: Bool
    let stalled: Bool
    let ageMs: Double
    let lastModifiedMs: Double
    let lastUserInputMs: Double
    let autoWake: Bool?
    let focus: String
    let focusIsCurrentTurn: Bool?
    let steps: StepsInfo?
    let stepsIsCurrentTurn: Bool?
    let lastPrompt: String?
    let lastReply: String
    let lastReplyFull: String?
    let briefing: BriefingInfo?
    let briefingStale: Bool?
    let recentEvents: [EventInfo]?
    let runningBgCount: Int
    let subagentCount: Int
    let subagents: [SubagentInfo]
    let model: String
    let pinned: Bool
    let hidden: Bool
    let slot: Int

    var summaryLine: String {
        if !waitingReason.isEmpty { return waitingReason }
        if let headline = briefing?.headline, !headline.isEmpty { return headline }
        if (focusIsCurrentTurn ?? true) && !focus.isEmpty { return focus }
        if !lastReply.isEmpty { return lastReply }
        return "No activity recorded"
    }

    var subagentSummary: String? {
        guard subagentCount > 0 else { return nil }
        return subagentCount == 1 ? "1 subagent" : "\(subagentCount) subagents"
    }
}

struct HostInfo: Codable, Sendable, Equatable, Hashable, Identifiable {
    var id: String { name }
    let name: String
    let isSelf: Bool?
    let online: Bool
    let macAccessibility: Bool?
    let conversationCount: Int?
    let error: String?
}

func cleanMarkdownPlainText(_ raw: String) -> String {
    var text = raw.replacingOccurrences(of: "\r", with: "")
    if let localLinkRegex = try? NSRegularExpression(pattern: #"\[([^\]]+)\]\((file://[^)]+|/[^)]+)\)"#) {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        text = localLinkRegex.stringByReplacingMatches(in: text, range: range, withTemplate: "`$1`")
    }
    if let webLinkRegex = try? NSRegularExpression(pattern: #"\[([^\]]+)\]\((https?://[^)]+)\)"#) {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        text = webLinkRegex.stringByReplacingMatches(in: text, range: range, withTemplate: "$1")
    }
    if let bareFileRegex = try? NSRegularExpression(pattern: #"file:///\S+"#) {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        text = bareFileRegex.stringByReplacingMatches(in: text, range: range, withTemplate: "")
    }
    if let usersPathRegex = try? NSRegularExpression(pattern: #"/Users/[^\s),.;:]+"#) {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        text = usersPathRegex.stringByReplacingMatches(in: text, range: range, withTemplate: "")
    }

    var lines: [String] = []
    for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
        let trimmed = rawLine.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty {
            if lines.last != "" { lines.append("") }
            continue
        }
        if trimmed.allSatisfy({ $0 == "-" || $0 == "*" || $0 == "_" }) && trimmed.count >= 3 {
            if lines.last != "" { lines.append("") }
            continue
        }
        if trimmed.hasPrefix("#") {
            let body = trimmed.drop(while: { $0 == "#" }).trimmingCharacters(in: .whitespaces)
            if !body.isEmpty {
                lines.append("**\(body)**")
            }
            continue
        }
        if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
            lines.append("• " + trimmed.dropFirst(2))
            continue
        }
        lines.append(trimmed)
    }
    return lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
}

func cleanMarkdownForDisplay(_ raw: String) -> AttributedString {
    let cleaned = cleanMarkdownPlainText(raw)
    if let attr = try? AttributedString(
        markdown: cleaned,
        options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    ) {
        return attr
    }
    return AttributedString(cleaned)
}

struct FleetAgent: Codable, Sendable, Hashable, Identifiable {
    var id: String { "\(mac)::\(agent)::\(runtime)::\(project)" }
    let mac: String
    let agent: String
    let mode: String
    let runtime: String
    let cpu: String
    let state: String
    let project: String
}

struct ProjectInfo: Codable, Sendable, Hashable, Identifiable {
    var id: String { "\(host ?? "local")::\(rawId)::\(name)" }
    let rawId: String
    let name: String
    let host: String?

    enum CodingKeys: String, CodingKey {
        case rawId = "id"
        case name
        case host
    }

    init(id: String, name: String, host: String? = nil) {
        self.rawId = id
        self.name = name
        self.host = host
    }
}

struct BoardResponse: Codable, Sendable, Equatable {
    let generatedAt: Double
    let sortMode: SortMode
    let counts: BoardCounts
    let conversations: [ConversationRow]
    let fleet: [FleetAgent]
    let relays: [RelayItem]?
    let projects: [ProjectInfo]?
    let hosts: [HostInfo]?
    let host: String?
    let macAccessibility: Bool?
    let remoteControlUrl: String?
}

struct AutoWakeResult: Codable, Sendable {
    let ok: Bool
    let conversationId: String?
    let autoWake: Bool?
    let message: String?
    let error: String?
}

struct ThreadDetailResponse: Codable, Sendable {
    let detail: ConversationRow
}

struct ActionResult: Codable, Sendable {
    let ok: Bool
    let message: String?
    let error: String?
    let errorCode: String?
}

struct HealthResponse: Codable, Sendable {
    let ok: Bool
    let service: String?
    let host: String?
}

func ageFormatted(ms: Double) -> String {
    let sec = max(0, Int(ms / 1000.0))
    if sec < 60 { return "\(sec)s" }
    let min = sec / 60
    if min < 60 { return "\(min)m" }
    let hr = min / 60
    if hr < 24 { return "\(hr)h" }
    return "\(hr / 24)d"
}
