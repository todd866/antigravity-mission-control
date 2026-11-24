import Observation
import SwiftUI

enum MainTab: Hashable {
    case board
    case fleet
    case settings
}

@Observable
@MainActor
final class AgyAppModel {
    var selectedTab: MainTab = .board
    var board: BoardResponse?
    var selectedFilter: ThreadFilter = .all
    var selectedHost: String? = nil
    var isReordering = false

    var serverURL: String
    var fallbackServerURL: String
    var activeServerURL: String
    var token: String
    var pollIntervalSeconds: Int = 3

    var isLoading = false
    var lastError: String?
    var lastUpdatedAt: Date?
    var lastLatencyMs: Int?

    var toastMessage: String?
    var toastIsError = false

    private var toastTask: Task<Void, Never>?

    init() {
        let defaultServer = (Bundle.main.object(forInfoDictionaryKey: "AgyDefaultServer") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let defaultFallback = (Bundle.main.object(forInfoDictionaryKey: "AgyFallbackServer") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var primary = (KeychainStore.loadServerURL() ?? defaultServer).trimmingCharacters(in: .whitespacesAndNewlines)
        let fallback = (KeychainStore.loadFallbackServerURL() ?? defaultFallback).trimmingCharacters(in: .whitespacesAndNewlines)
        var initialToken = KeychainStore.loadToken() ?? ""
        #if DEBUG
        let env = ProcessInfo.processInfo.environment
        if let qaServer = env["AGY_QA_SERVER"]?.trimmingCharacters(in: .whitespacesAndNewlines), !qaServer.isEmpty {
            primary = qaServer
        }
        if let qaToken = env["AGY_QA_TOKEN"]?.trimmingCharacters(in: .whitespacesAndNewlines), !qaToken.isEmpty {
            initialToken = qaToken
        }
        #endif
        self.serverURL = primary
        self.fallbackServerURL = fallback
        self.activeServerURL = primary.isEmpty ? fallback : primary
        self.token = initialToken
    }

    var isConfigured: Bool {
        let hasServer = !serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !fallbackServerURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return hasServer && !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var client: AgyAPIClient {
        let chosen = activeServerURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let base = chosen.isEmpty ? (serverURL.isEmpty ? fallbackServerURL : serverURL) : chosen
        return AgyAPIClient(baseURL: base, token: token)
    }

    var filteredConversations: [ConversationRow] {
        var all = board?.conversations ?? []
        if let selectedHost, !selectedHost.isEmpty {
            all = all.filter { $0.host == selectedHost }
        }
        guard let target = selectedFilter.matchingState else { return all }
        return all.filter { $0.state == target }
    }

    var pendingRelays: [RelayItem] {
        (board?.relays ?? []).filter { $0.status == "pending" }
    }

    func saveCredentials(server: String, fallback: String = "", token: String) {
        let cleanServer = server.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let cleanFallback = fallback.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let cleanToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        self.serverURL = cleanServer
        self.fallbackServerURL = cleanFallback
        self.activeServerURL = cleanServer.isEmpty ? cleanFallback : cleanServer
        self.token = cleanToken
        KeychainStore.saveServerURL(cleanServer)
        KeychainStore.saveFallbackServerURL(cleanFallback)
        KeychainStore.saveToken(cleanToken)
    }

    func applyPairingURL(_ url: URL) {
        do {
            let link = try PairingLink.parse(url)
            saveCredentials(server: link.serverURL, fallback: link.fallbackServerURL ?? "", token: link.token)
            selectedTab = .board
            showToast("Paired with Mac")
            Task { await refreshBoard() }
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    func applyPairingString(_ raw: String) -> Bool {
        do {
            let link = try PairingLink.parse(raw)
            saveCredentials(server: link.serverURL, fallback: link.fallbackServerURL ?? "", token: link.token)
            showToast("Paired with Mac")
            Task { await refreshBoard() }
            return true
        } catch {
            showToast(error.localizedDescription, isError: true)
            return false
        }
    }

    func showToast(_ message: String, isError: Bool = false) {
        toastTask?.cancel()
        toastMessage = message
        toastIsError = isError
        toastTask = Task {
            try? await Task.sleep(for: .seconds(3.5))
            guard !Task.isCancelled else { return }
            toastMessage = nil
        }
    }

    private func shouldFailover(after error: Error) -> Bool {
        if let apiErr = error as? AgyAPIError {
            switch apiErr {
            case .notConfigured, .invalidURL:
                return false
            case .httpError(let code, _):
                return code >= 502 && code <= 504
            case .decodingError:
                return false
            }
        }
        return true
    }

    private func withClientFailover<T>(_ op: (AgyAPIClient) async throws -> T) async throws -> T {
        let primary = (activeServerURL.isEmpty ? serverURL : activeServerURL)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let candidateAlt = (primary == serverURL ? fallbackServerURL : serverURL)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let alt = (!candidateAlt.isEmpty && candidateAlt != primary) ? candidateAlt : nil

        do {
            return try await op(AgyAPIClient(baseURL: primary, token: token))
        } catch {
            guard let alt, shouldFailover(after: error) else { throw error }
            let result = try await op(AgyAPIClient(baseURL: alt, token: token))
            activeServerURL = alt
            return result
        }
    }

    func refreshBoard() async {
        guard isConfigured else { return }
        if isLoading && board == nil { return }
        isLoading = true
        let start = ContinuousClock.now
        defer { isLoading = false }

        do {
            let next = try await withClientFailover { try await $0.fetchBoard() }
            let elapsed = ContinuousClock.now - start
            lastLatencyMs = Int(elapsed.components.seconds * 1000) + Int(elapsed.components.attoseconds / 1_000_000_000_000_000)
            board = next
            lastUpdatedAt = Date()
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    func fetchDetail(for row: ConversationRow) async throws -> ConversationRow {
        let res = try await withClientFailover { try await $0.fetchDetail(id: row.id, host: row.host) }
        return res.detail
    }

    func setSortMode(_ mode: SortMode) async {
        if mode != .fixed { isReordering = false }
        do {
            board = try await withClientFailover { try await $0.mutateOrder(action: "set_sort", value: mode.rawValue) }
            lastUpdatedAt = Date()
            lastError = nil
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    func togglePin(_ row: ConversationRow) async {
        do {
            board = try await withClientFailover { try await $0.mutateOrder(action: "pin", conversationId: row.id) }
            showToast(row.pinned ? "Unpinned" : "Pinned")
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    func sendToBottom(_ row: ConversationRow) async {
        do {
            board = try await withClientFailover {
                try await $0.mutateOrder(action: "move", conversationId: row.id, direction: "bottom")
            }
            showToast("Sent to bottom")
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    func sendToTop(_ row: ConversationRow) async {
        do {
            board = try await withClientFailover {
                try await $0.mutateOrder(action: "move", conversationId: row.id, direction: "top")
            }
            showToast("Sent to top")
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    func hideRow(_ row: ConversationRow) async {
        do {
            board = try await withClientFailover { try await $0.mutateOrder(action: "hide", conversationId: row.id) }
            showToast("Hidden from board")
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    func unhideAll() async {
        do {
            board = try await withClientFailover { try await $0.mutateOrder(action: "unhide_all") }
            showToast("Restored hidden conversations")
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    func resetFixedOrder() async {
        do {
            board = try await withClientFailover { try await $0.mutateOrder(action: "reset_order") }
            showToast("Reset fixed order")
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    func moveFixedRows(from source: IndexSet, to destination: Int) async {
        guard let currentRows = board?.conversations,
              let srcIndex = source.first,
              srcIndex < currentRows.count else { return }
        let moved = currentRows[srcIndex]
        let sameGroup = currentRows.filter { $0.pinned == moved.pinned }
        guard let srcGroupIdx = sameGroup.firstIndex(where: { $0.id == moved.id }) else { return }

        let groupOffset = currentRows.firstIndex(where: { $0.pinned == moved.pinned }) ?? 0
        var targetGroupIdx = destination - groupOffset
        if destination > srcIndex { targetGroupIdx -= 1 }
        targetGroupIdx = max(0, min(sameGroup.count - 1, targetGroupIdx))
        guard targetGroupIdx != srcGroupIdx else { return }

        do {
            board = try await withClientFailover {
                try await $0.mutateOrder(action: "move", conversationId: moved.id, toIndex: targetGroupIdx)
            }
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    func focusOnMac(_ row: ConversationRow) async {
        do {
            let res = try await withClientFailover { try await $0.focusThread(id: row.id, host: row.host) }
            showToast(res.message ?? "Opened on Mac")
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    func stopOnMac(_ row: ConversationRow) async {
        do {
            let res = try await withClientFailover { try await $0.stopThread(id: row.id, host: row.host) }
            showToast(res.message ?? "Stopped")
            await refreshBoard()
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    func sendMessage(to row: ConversationRow, text: String) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        do {
            let res = try await withClientFailover { try await $0.sendMessage(id: row.id, text: trimmed, host: row.host) }
            showToast(res.message ?? "Sent message")
            await refreshBoard()
            return true
        } catch {
            showToast(error.localizedDescription, isError: true)
            return false
        }
    }

    func sendNextAction(to row: ConversationRow, action: NextAction) async -> Bool {
        let trimmed = action.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        do {
            _ = try await withClientFailover { try await $0.sendMessage(id: row.id, text: trimmed, host: row.host) }
            showToast("Sent \"\(action.label)\"")
            await refreshBoard()
            return true
        } catch {
            showToast(error.localizedDescription, isError: true)
            return false
        }
    }

    func refreshBriefing(_ row: ConversationRow) async -> ConversationRow? {
        do {
            let res = try await withClientFailover { try await $0.refreshBriefing(id: row.id, host: row.host) }
            if var currentBoard = board,
               let idx = currentBoard.conversations.firstIndex(where: { $0.id == row.id }) {
                var updated = currentBoard.conversations
                updated[idx] = res.detail
                currentBoard = BoardResponse(
                    generatedAt: currentBoard.generatedAt,
                    sortMode: currentBoard.sortMode,
                    counts: currentBoard.counts,
                    conversations: updated,
                    fleet: currentBoard.fleet,
                    relays: currentBoard.relays,
                    projects: currentBoard.projects,
                    hosts: currentBoard.hosts,
                    host: currentBoard.host,
                    macAccessibility: currentBoard.macAccessibility,
                    remoteControlUrl: currentBoard.remoteControlUrl
                )
                board = currentBoard
            }
            showToast("Updated briefing")
            return res.detail
        } catch {
            showToast(error.localizedDescription, isError: true)
            return nil
        }
    }

    func startConversation(host: String? = nil, projectName: String?, text: String) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        do {
            let res = try await withClientFailover {
                try await $0.startThread(host: host, projectName: projectName, text: trimmed)
            }
            showToast(res.message ?? "Started conversation")
            await refreshBoard()
            return true
        } catch {
            showToast(error.localizedDescription, isError: true)
            return false
        }
    }

    func approveRelay(_ relay: RelayItem, text: String? = nil) async -> Bool {
        do {
            let res = try await withClientFailover {
                try await $0.approveRelay(id: relay.id, host: relay.targetHost, text: text)
            }
            showToast(res.message ?? "Sent relay")
            await refreshBoard()
            return true
        } catch {
            showToast(error.localizedDescription, isError: true)
            return false
        }
    }

    func dismissRelay(_ relay: RelayItem) async {
        do {
            let res = try await withClientFailover {
                try await $0.dismissRelay(id: relay.id, host: relay.targetHost)
            }
            showToast(res.message ?? "Dismissed relay")
            await refreshBoard()
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    func toggleAutoWake(_ row: ConversationRow) async {
        do {
            let res = try await withClientFailover {
                try await $0.toggleAutoWake(id: row.id, host: row.host)
            }
            showToast(res.message ?? (res.autoWake == true ? "Auto-wake enabled" : "Auto-wake disabled"))
            await refreshBoard()
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }
}

@main
struct MissionControlApp: App {
    @State private var model = AgyAppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootTabView(model: model)
                .onOpenURL { url in
                    model.applyPairingURL(url)
                }
                .task(id: scenePhase) {
                    guard scenePhase == .active else { return }
                    while !Task.isCancelled && scenePhase == .active {
                        await model.refreshBoard()
                        let interval = max(2, model.pollIntervalSeconds)
                        try? await Task.sleep(for: .seconds(interval))
                    }
                }
        }
    }
}

private struct RootTabView: View {
    @Bindable var model: AgyAppModel

    var body: some View {
        ZStack(alignment: .bottom) {
            TabView(selection: $model.selectedTab) {
                Tab("Board", systemImage: "list.bullet.rectangle.portrait", value: MainTab.board) {
                    BoardView(model: model)
                }
                Tab("Fleet", systemImage: "desktopcomputer", value: MainTab.fleet) {
                    FleetView(model: model)
                }
                Tab("Settings", systemImage: "gearshape", value: MainTab.settings) {
                    SettingsView(model: model)
                }
            }

            if let toast = model.toastMessage {
                Text(toast)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(model.toastIsError ? .white : .primary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(
                        model.toastIsError ? Color.red.opacity(0.92) : Color(.secondarySystemBackground),
                        in: Capsule()
                    )
                    .overlay(
                        Capsule().stroke(Color.primary.opacity(0.12), lineWidth: 0.5)
                    )
                    .padding(.bottom, 60)
                    .padding(.horizontal, 16)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.18), value: model.toastMessage)
    }
}
