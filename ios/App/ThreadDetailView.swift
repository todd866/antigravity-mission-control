import SwiftUI
import UIKit

struct ThreadDetailView: View {
    @Bindable var model: AgyAppModel
    let initialRow: ConversationRow

    @Environment(\.dismiss) private var dismiss
    @State private var detail: ConversationRow?
    @State private var draftMessage = ""
    @State private var isSending = false
    @State private var isRefreshingBrief = false
    @State private var showStopConfirm = false
    @State private var showPrevChecklist = false
    @State private var showRawReply = false
    @State private var showEvents = false
    @FocusState private var composerFocused: Bool

    private var current: ConversationRow {
        if let detail, detail.id == initialRow.id { return detail }
        return model.board?.conversations.first(where: { $0.id == initialRow.id }) ?? initialRow
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                headerCard
                actionButtons

                let needsCallText = !current.waitingReason.isEmpty
                    ? current.waitingReason
                    : (current.briefing?.needsUser ?? "")
                if !needsCallText.isEmpty {
                    sectionCard(title: "Needs your call") {
                        Text(needsCallText)
                            .font(.subheadline)
                            .foregroundStyle(.orange)
                            .textSelection(.enabled)
                    }
                }

                briefingCard
                nextActionsCard

                if let steps = current.steps, !steps.items.isEmpty {
                    let stepsBody = VStack(alignment: .leading, spacing: 6) {
                        ForEach(steps.items) { item in
                            HStack(alignment: .top, spacing: 8) {
                                Image(systemName: item.symbolName)
                                    .font(.caption)
                                    .foregroundStyle(item.tintColor)
                                    .padding(.top, 2)
                                Text(item.title)
                                    .font(.subheadline)
                                    .foregroundStyle(item.status == "done" ? .secondary : .primary)
                            }
                        }
                    }

                    if current.stepsIsCurrentTurn ?? true {
                        sectionCard(title: "Checklist (\(steps.ratioText))") {
                            stepsBody
                        }
                    } else {
                        sectionCard(title: "Checklist") {
                            DisclosureGroup("Previous turn checklist (\(steps.ratioText))", isExpanded: $showPrevChecklist) {
                                stepsBody
                                    .padding(.top, 6)
                            }
                            .font(.subheadline.weight(.medium))
                        }
                    }
                }

                if !current.subagents.isEmpty {
                    sectionCard(title: "Active subagents (\(current.subagents.count))") {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(current.subagents) { sub in
                                HStack {
                                    Text(sub.title)
                                        .font(.subheadline)
                                    Spacer()
                                    Text(sub.status.capitalized)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }

                let replyText = (current.lastReplyFull?.isEmpty == false) ? current.lastReplyFull! : current.lastReply
                if !replyText.isEmpty {
                    if current.briefing != nil {
                        sectionCard(title: "Transcript") {
                            DisclosureGroup("Latest reply", isExpanded: $showRawReply) {
                                Text(cleanMarkdownForDisplay(replyText))
                                    .font(.subheadline)
                                    .textSelection(.enabled)
                                    .padding(.top, 6)
                            }
                            .font(.subheadline.weight(.medium))
                        }
                    } else {
                        sectionCard(title: "Latest reply") {
                            Text(cleanMarkdownForDisplay(replyText))
                                .font(.subheadline)
                                .textSelection(.enabled)
                        }
                    }
                }

                if let events = current.recentEvents, !events.isEmpty {
                    sectionCard(title: "Timeline") {
                        DisclosureGroup("Recent activity (\(events.count))", isExpanded: $showEvents) {
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(events) { ev in
                                    HStack(alignment: .top, spacing: 8) {
                                        Text(ev.kindLabel)
                                            .font(.caption.weight(.medium))
                                            .foregroundStyle(.secondary)
                                            .frame(width: 74, alignment: .leading)
                                        Text(ev.text)
                                            .font(.caption)
                                            .foregroundStyle(ev.kind == "error" ? .red : .primary)
                                    }
                                }
                            }
                            .padding(.top, 6)
                        }
                        .font(.subheadline.weight(.medium))
                    }
                }
            }
            .padding(14)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(current.projectName)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            composerBar
        }
        .task {
            await loadFullDetail()
        }
        .refreshable {
            await loadFullDetail()
        }
        .confirmationDialog("Stop active agent run?", isPresented: $showStopConfirm, titleVisibility: .visible) {
            Button("Stop \(current.title)", role: .destructive) {
                Task { await model.stopOnMac(current) }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    private var headerCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(current.title)
                .font(.headline)
                .textSelection(.enabled)

            HStack(spacing: 10) {
                Label(current.state.displayName, systemImage: current.state.symbolName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(current.state.tintColor)

                if let host = current.host, (model.board?.hosts?.count ?? 0) > 1 {
                    Text(host.uppercased())
                        .font(.caption2.weight(.semibold).monospaced())
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                }

                Text(current.projectName)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Text(ageFormatted(ms: current.ageMs))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(current.stalled ? .orange : .secondary)

                Text("\(current.stepCount) steps")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            if !current.model.isEmpty {
                Text(current.model)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var actionButtons: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                Button {
                    Task { await model.focusOnMac(current) }
                } label: {
                    Label("Open on Mac", systemImage: "macwindow")
                }
                .buttonStyle(.borderedProminent)

                Button {
                    guard !isRefreshingBrief else { return }
                    isRefreshingBrief = true
                    Task {
                        if let updated = await model.refreshBriefing(current) {
                            detail = updated
                        }
                        isRefreshingBrief = false
                    }
                } label: {
                    if isRefreshingBrief {
                        HStack(spacing: 5) {
                            ProgressView()
                                .controlSize(.small)
                            Text("Refreshing")
                        }
                    } else {
                        Label("Refresh brief", systemImage: "sparkles")
                    }
                }
                .buttonStyle(.bordered)
                .disabled(isRefreshingBrief)

                Button {
                    Task { await model.togglePin(current) }
                } label: {
                    Label(current.pinned ? "Unpin" : "Pin", systemImage: current.pinned ? "pin.slash" : "pin")
                }
                .buttonStyle(.bordered)

                Button {
                    Task { await model.sendToBottom(current) }
                } label: {
                    Label("Bottom", systemImage: "arrow.down.to.line")
                }
                .buttonStyle(.bordered)

                if current.state == .working {
                    Button(role: .destructive) {
                        showStopConfirm = true
                    } label: {
                        Label("Stop", systemImage: "stop.circle")
                    }
                    .buttonStyle(.bordered)
                }

                Button {
                    Task {
                        await model.hideRow(current)
                        dismiss()
                    }
                } label: {
                    Label("Hide", systemImage: "eye.slash")
                }
                .buttonStyle(.bordered)

                if let rawURL = model.board?.remoteControlUrl, let url = URL(string: rawURL) {
                    Link(destination: url) {
                        Label("Antigravity Web", systemImage: "safari")
                    }
                    .buttonStyle(.bordered)
                }

                Button {
                    UIPasteboard.general.string = current.id
                    model.showToast("Copied ID \(current.shortId)")
                } label: {
                    Label("Copy ID", systemImage: "doc.on.doc")
                }
                .buttonStyle(.bordered)
            }
            .font(.caption.weight(.medium))
        }
    }

    @ViewBuilder
    private var briefingCard: some View {
        if let brief = current.briefing, !brief.brief.isEmpty || !brief.headline.isEmpty {
            sectionCard(title: current.briefingStale == true ? "Project briefing (updating)" : "Project briefing") {
                VStack(alignment: .leading, spacing: 8) {
                    Text(!brief.brief.isEmpty ? brief.brief : brief.headline)
                        .font(.subheadline)
                        .textSelection(.enabled)

                    if current.state == .working || current.state == .bg {
                        let inFlight = !brief.currentWork.isEmpty
                            ? brief.currentWork
                            : ((current.focusIsCurrentTurn ?? true) ? current.focus : "")
                        if !inFlight.isEmpty {
                            (Text("In flight now: ").fontWeight(.semibold) + Text(inFlight))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }

                    if !brief.priorCompleted.isEmpty {
                        (Text("Done so far: ").fontWeight(.semibold) + Text(brief.priorCompleted))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        } else {
            let fallbackText: String = {
                if (current.focusIsCurrentTurn ?? true) && !current.focus.isEmpty {
                    return current.focus
                }
                if let prompt = current.lastPrompt, !prompt.isEmpty {
                    return prompt
                }
                if !current.lastReply.isEmpty {
                    return current.lastReply
                }
                return "Generating briefing..."
            }()
            sectionCard(title: "Project briefing (generating)") {
                Text(fallbackText)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
    }

    @ViewBuilder
    private var nextActionsCard: some View {
        if current.state != .working, let suggestions = current.briefing?.suggestions, !suggestions.isEmpty {
            sectionCard(title: "What's next") {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(suggestions) { action in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(alignment: .center, spacing: 8) {
                                Text(action.label)
                                    .font(.subheadline.weight(.semibold))
                                    .frame(maxWidth: .infinity, alignment: .leading)

                                Button("Edit") {
                                    draftMessage = action.prompt
                                    composerFocused = true
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)

                                Button("Send") {
                                    isSending = true
                                    Task {
                                        let ok = await model.sendNextAction(to: current, action: action)
                                        if ok {
                                            await loadFullDetail()
                                        }
                                        isSending = false
                                    }
                                }
                                .buttonStyle(.borderedProminent)
                                .controlSize(.small)
                                .disabled(isSending)
                            }

                            Text(action.prompt)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                        .padding(9)
                        .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                }
            }
        }
    }

    private var composerBar: some View {
        HStack(spacing: 8) {
            TextField("Message Antigravity", text: $draftMessage, axis: .vertical)
                .focused($composerFocused)
                .lineLimit(1...4)
                .textFieldStyle(.roundedBorder)

            Button {
                let text = draftMessage
                isSending = true
                Task {
                    let ok = await model.sendMessage(to: current, text: text)
                    if ok {
                        draftMessage = ""
                        await loadFullDetail()
                    }
                    isSending = false
                }
            } label: {
                if isSending {
                    ProgressView()
                } else {
                    Text("Send")
                        .fontWeight(.semibold)
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(isSending || draftMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func sectionCard<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            content()
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func loadFullDetail() async {
        do {
            detail = try await model.fetchDetail(for: initialRow)
        } catch {
            // Keep existing row summary if detail fetch fails.
        }
    }
}
