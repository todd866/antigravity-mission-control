import SwiftUI

private struct NextActionTarget: Identifiable {
    var id: String { "\(row.id)::\(action.id)" }
    let row: ConversationRow
    let action: NextAction
}

struct BoardView: View {
    @Bindable var model: AgyAppModel
    @State private var showNewSheet = false
    @State private var stopCandidate: ConversationRow?
    @State private var nextActionCandidate: NextActionTarget?

    var body: some View {
        NavigationStack {
            Group {
                if !model.isConfigured {
                    ContentUnavailableView {
                        Label("Mac Not Paired", systemImage: "link.badge.plus")
                    } description: {
                        Text("Open Settings and apply your pairing link to monitor Antigravity.")
                    } actions: {
                        Button("Open Settings") {
                            model.selectedTab = .settings
                        }
                        .buttonStyle(.borderedProminent)
                    }
                } else if model.board == nil && model.isLoading {
                    ProgressView("Loading conversations")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    boardContent
                }
            }
            .navigationTitle("Mission Control")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if model.isConfigured && model.board?.sortMode == .fixed && model.selectedFilter == .all {
                    ToolbarItem(placement: .topBarLeading) {
                        Button(model.isReordering ? "Done" : "Reorder") {
                            model.isReordering.toggle()
                        }
                    }
                }
                if model.isConfigured {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            showNewSheet = true
                        } label: {
                            Image(systemName: "plus")
                        }
                        .accessibilityLabel("New conversation")
                    }
                }
            }
            .sheet(isPresented: $showNewSheet) {
                NewThreadSheet(model: model)
            }
            .confirmationDialog(
                "Stop active agent run?",
                isPresented: Binding(
                    get: { stopCandidate != nil },
                    set: { if !$0 { stopCandidate = nil } }
                ),
                titleVisibility: .visible
            ) {
                if let candidate = stopCandidate {
                    Button("Stop \(candidate.title)", role: .destructive) {
                        Task { await model.stopOnMac(candidate) }
                    }
                }
                Button("Cancel", role: .cancel) {}
            }
            .confirmationDialog(
                nextActionCandidate.map { "Run \"\($0.action.label)\"?" } ?? "Run suggested next step?",
                isPresented: Binding(
                    get: { nextActionCandidate != nil },
                    set: { if !$0 { nextActionCandidate = nil } }
                ),
                titleVisibility: .visible,
                presenting: nextActionCandidate
            ) { target in
                Button("Send Prompt") {
                    Task { _ = await model.sendNextAction(to: target.row, action: target.action) }
                }
                Button("Cancel", role: .cancel) {}
            } message: { target in
                Text(target.action.prompt)
            }
        }
    }

    @ViewBuilder
    private var boardContent: some View {
        VStack(spacing: 0) {
            filterAndSortHeader
            Divider()

            let rows = model.filteredConversations
            if rows.isEmpty {
                ContentUnavailableView(
                    "No Matching Conversations",
                    systemImage: "tray",
                    description: Text(model.lastError ?? "No conversations match this filter.")
                )
            } else {
                let showHosts = (model.board?.hosts?.count ?? 0) > 1
                List {
                    ForEach(rows) { row in
                        NavigationLink(value: row) {
                            ConversationInstrumentRow(row: row, showHost: showHosts)
                        }
                        .swipeActions(edge: .leading, allowsFullSwipe: row.state == .working || row.briefing?.suggestions.isEmpty != false) {
                            if row.state != .working, let next0 = row.briefing?.suggestions.first {
                                Button {
                                    nextActionCandidate = NextActionTarget(row: row, action: next0)
                                } label: {
                                    Label("Next", systemImage: "play.fill")
                                }
                                .tint(.green)
                            }
                            Button {
                                Task { await model.togglePin(row) }
                            } label: {
                                Label(row.pinned ? "Unpin" : "Pin", systemImage: row.pinned ? "pin.slash" : "pin")
                            }
                            .tint(.orange)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                Task { await model.hideRow(row) }
                            } label: {
                                Label("Hide", systemImage: "eye.slash")
                            }

                            Button {
                                Task { await model.sendToBottom(row) }
                            } label: {
                                Label("Bottom", systemImage: "arrow.down.to.line")
                            }
                            .tint(.indigo)

                            Button {
                                Task { await model.focusOnMac(row) }
                            } label: {
                                Label("Open on Mac", systemImage: "macwindow")
                            }
                            .tint(.blue)

                            if row.state == .working {
                                Button {
                                    stopCandidate = row
                                } label: {
                                    Label("Stop", systemImage: "stop.circle")
                                }
                                .tint(.red)
                            }
                        }
                    }
                    .onMove { src, dst in
                        Task { await model.moveFixedRows(from: src, to: dst) }
                    }
                }
                .listStyle(.plain)
                .environment(\.editMode, .constant(model.isReordering ? .active : .inactive))
                .refreshable {
                    await model.refreshBoard()
                }
                .navigationDestination(for: ConversationRow.self) { row in
                    ThreadDetailView(model: model, initialRow: row)
                }
            }
        }
    }

    private var filterAndSortHeader: some View {
        VStack(spacing: 8) {
            if let counts = model.board?.counts {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(ThreadFilter.allCases) { filter in
                            let count = filter.count(in: counts)
                            let selected = model.selectedFilter == filter
                            let zeroMuted = filter != .all && count == 0
                            Button {
                                model.selectedFilter = filter
                                if filter != .all { model.isReordering = false }
                            } label: {
                                HStack(spacing: 4) {
                                    if let st = filter.matchingState {
                                        Image(systemName: st.symbolName)
                                            .font(.caption2)
                                            .foregroundStyle(zeroMuted ? .secondary : st.tintColor)
                                    }
                                    Text(filter.displayName)
                                        .font(.caption.weight(selected ? .semibold : .regular))
                                    Text("\(count)")
                                        .font(.caption.monospacedDigit())
                                        .foregroundStyle(zeroMuted ? .tertiary : .secondary)
                                }
                                .padding(.horizontal, 9)
                                .padding(.vertical, 5)
                                .background(
                                    selected ? Color(.tertiarySystemFill) : Color.clear,
                                    in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                                )
                                .overlay(
                                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                                        .stroke(selected ? Color.primary.opacity(0.18) : Color.clear, lineWidth: 1)
                                )
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(zeroMuted ? .secondary : .primary)
                        }
                    }
                    .padding(.horizontal, 12)
                }
            }

            if let hosts = model.board?.hosts, hosts.count > 1 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        Button {
                            model.selectedHost = nil
                        } label: {
                            Text("All Macs")
                                .font(.caption.weight(model.selectedHost == nil ? .semibold : .regular))
                                .padding(.horizontal, 9)
                                .padding(.vertical, 4)
                                .background(
                                    model.selectedHost == nil ? Color(.tertiarySystemFill) : Color.clear,
                                    in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                                )
                        }
                        .buttonStyle(.plain)

                        ForEach(hosts) { h in
                            let selected = model.selectedHost == h.name
                            Button {
                                model.selectedHost = h.name
                            } label: {
                                HStack(spacing: 5) {
                                    Circle()
                                        .fill(h.online ? Color.green : Color.secondary)
                                        .frame(width: 6, height: 6)
                                    Text(h.name.uppercased())
                                        .font(.caption.weight(selected ? .semibold : .regular).monospaced())
                                    if let count = h.conversationCount {
                                        Text("\(count)")
                                            .font(.caption.monospacedDigit())
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                .padding(.horizontal, 9)
                                .padding(.vertical, 4)
                                .background(
                                    selected ? Color(.tertiarySystemFill) : Color.clear,
                                    in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 12)
                }
            }

            HStack(spacing: 8) {
                Picker("Sort", selection: Binding(
                    get: { model.board?.sortMode ?? .fixed },
                    set: { mode in
                        Task { await model.setSortMode(mode) }
                    }
                )) {
                    ForEach(SortMode.allCases) { mode in
                        Text(mode.displayName).tag(mode)
                    }
                }
                .pickerStyle(.segmented)

                if let err = model.lastError, !err.isEmpty {
                    Image(systemName: "wifi.exclamationmark")
                        .foregroundStyle(.orange)
                        .accessibilityLabel(err)
                }
            }
            .padding(.horizontal, 12)
        }
        .padding(.vertical, 8)
        .background(Color(.secondarySystemBackground))
    }
}

private struct ConversationInstrumentRow: View {
    let row: ConversationRow
    var showHost: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: row.state.symbolName)
                    .font(.caption)
                    .foregroundStyle(row.state.tintColor)
                    .frame(width: 15)
                    .accessibilityLabel(row.state.displayName)

                if row.pinned {
                    Image(systemName: "pin.fill")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                        .accessibilityLabel("Pinned")
                }

                Text(row.title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)

                Text(row.projectName)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                if showHost, let host = row.host {
                    Text(host.uppercased())
                        .font(.caption2.weight(.semibold).monospaced())
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 3, style: .continuous))
                }

                Spacer(minLength: 4)

                if let steps = row.steps {
                    Text(steps.ratioText)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }

                Text(ageFormatted(ms: row.ageMs))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(row.stalled ? .orange : .secondary)
                    .frame(minWidth: 26, alignment: .trailing)
            }

            HStack(spacing: 8) {
                Text(row.summaryLine)
                    .font(.caption)
                    .foregroundStyle(row.state == .attention ? .orange : .secondary)
                    .lineLimit(1)

                Spacer(minLength: 4)

                if let subText = row.subagentSummary {
                    Text(subText)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                if let steps = row.steps, steps.total > 0 {
                    ProgressView(value: steps.progressFraction)
                        .tint(steps.done == steps.total ? .green : .cyan)
                        .frame(width: 44)
                }
            }
            .padding(.leading, 21)

            if row.state != .working, let next0 = row.briefing?.suggestions.first {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.turn.down.right")
                        .font(.caption2)
                        .foregroundStyle(.green)
                    Text("Next: \(next0.label)")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.green)
                        .lineLimit(1)
                }
                .padding(.leading, 21)
            }
        }
        .padding(.vertical, 2)
    }
}
