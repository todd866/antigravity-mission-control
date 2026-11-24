import SwiftUI

struct FleetView: View {
    @Bindable var model: AgyAppModel

    var body: some View {
        NavigationStack {
            List {
                Section("Mac Companion") {
                    LabeledContent("Host", value: model.board?.host ?? "m5")
                    LabeledContent("Server") {
                        Text(model.serverURL.isEmpty ? "Not set" : model.serverURL)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let latency = model.lastLatencyMs {
                        LabeledContent("Response time") {
                            Text("\(latency) ms")
                                .monospacedDigit()
                        }
                    }
                    if let axOk = model.board?.macAccessibility {
                        LabeledContent("Mac UI Control") {
                            Text(axOk ? "Ready" : "Accessibility needed")
                                .foregroundStyle(axOk ? .green : .orange)
                        }
                        if !axOk {
                            Text("Enable node in Mac System Settings > Privacy & Security > Accessibility to allow Focus, Stop, and Send from iPhone.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    if let err = model.lastError, !err.isEmpty {
                        Text(err)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }

                if let counts = model.board?.counts, counts.hidden > 0 {
                    Section("Board Visibility") {
                        Button("Restore \(counts.hidden) hidden") {
                            Task { await model.unhideAll() }
                        }
                    }
                }

                Section("Local Command-Line Agents") {
                    let agents = model.board?.fleet ?? []
                    if agents.isEmpty {
                        Text("No standalone command-line agents running.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(agents) { item in
                            VStack(alignment: .leading, spacing: 3) {
                                HStack {
                                    Text("\(item.mac) · \(item.agent)")
                                        .font(.subheadline.weight(.medium))
                                    Spacer()
                                    Text(item.state)
                                        .font(.caption)
                                        .foregroundStyle(item.state == "busy" ? .cyan : .secondary)
                                    Text(item.cpu)
                                        .font(.caption.monospacedDigit())
                                        .foregroundStyle(.secondary)
                                }
                                Text("\(item.mode) · \(item.runtime) · \(item.project)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Fleet")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable {
                await model.refreshBoard()
            }
        }
    }
}
