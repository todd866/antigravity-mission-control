import SwiftUI
import UIKit

struct SettingsView: View {
    @Bindable var model: AgyAppModel

    @State private var serverInput = ""
    @State private var fallbackInput = ""
    @State private var tokenInput = ""
    @State private var pairingInput = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Quick Pairing") {
                    TextField("Paste agycontrol://pair link", text: $pairingInput)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    HStack {
                        Button("Paste from Clipboard") {
                            if let str = UIPasteboard.general.string {
                                pairingInput = str
                            }
                        }
                        Spacer()
                        Button("Apply Link") {
                            if model.applyPairingString(pairingInput) {
                                serverInput = model.serverURL
                                fallbackInput = model.fallbackServerURL
                                tokenInput = model.token
                                pairingInput = ""
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(pairingInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }

                Section("Connection") {
                    TextField("Primary server address", text: $serverInput)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    TextField("Fallback server address (optional)", text: $fallbackInput)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    SecureField("Bearer token", text: $tokenInput)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    if !model.activeServerURL.isEmpty {
                        Text("Active: \(model.activeServerURL)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    Button("Save Connection") {
                        model.saveCredentials(server: serverInput, fallback: fallbackInput, token: tokenInput)
                        Task { await model.refreshBoard() }
                    }
                    .disabled(
                        serverInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            && fallbackInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
                }

                if let hosts = model.board?.hosts, !hosts.isEmpty {
                    Section("Connected Macs") {
                        ForEach(hosts) { h in
                            HStack {
                                Circle()
                                    .fill(h.online ? Color.green : Color.secondary)
                                    .frame(width: 8, height: 8)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(h.name.uppercased())
                                        .font(.subheadline.weight(.semibold))
                                    Text(
                                        h.online
                                            ? "\(h.conversationCount ?? 0) tabs · \((h.macAccessibility ?? true) ? "Accessibility OK" : "Accessibility needed")"
                                            : (h.error ?? "Offline")
                                    )
                                    .font(.caption)
                                    .foregroundStyle(h.online && (h.macAccessibility ?? true) ? AnyShapeStyle(.secondary) : AnyShapeStyle(.orange))
                                }
                            }
                        }
                    }
                }

                Section("Refresh Interval") {
                    Picker("Poll every", selection: $model.pollIntervalSeconds) {
                        Text("3 seconds").tag(3)
                        Text("5 seconds").tag(5)
                        Text("10 seconds").tag(10)
                    }
                    .pickerStyle(.segmented)
                }

                Section("Board Actions") {
                    Button("Reset Fixed Order") {
                        Task { await model.resetFixedOrder() }
                    }
                    .disabled(!model.isConfigured)

                    if let rawURL = model.board?.remoteControlUrl, let url = URL(string: rawURL) {
                        Link("Open Antigravity Web", destination: url)
                    } else if let url = URL(string: "https://antigravity.google.com") {
                        Link("Open Antigravity Web", destination: url)
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear {
                serverInput = model.serverURL
                fallbackInput = model.fallbackServerURL
                tokenInput = model.token
            }
        }
    }
}
