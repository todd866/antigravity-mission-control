import SwiftUI

struct NewThreadSheet: View {
    @Bindable var model: AgyAppModel
    @Environment(\.dismiss) private var dismiss

    @State private var selectedHost = ""
    @State private var selectedProjectName = ""
    @State private var promptText = ""
    @State private var isStarting = false

    private var hosts: [HostInfo] {
        model.board?.hosts ?? []
    }

    private var projects: [ProjectInfo] {
        let all = model.board?.projects ?? []
        guard !selectedHost.isEmpty else { return all }
        return all.filter { $0.host == nil || $0.host == selectedHost }
    }

    var body: some View {
        NavigationStack {
            Form {
                if hosts.count > 1 {
                    Section("Mac") {
                        Picker("Target Mac", selection: $selectedHost) {
                            ForEach(hosts) { h in
                                Text("\(h.name.uppercased())\(h.online ? "" : " (offline)")").tag(h.name)
                            }
                        }
                        .pickerStyle(.segmented)
                    }
                }

                Section("Project") {
                    Picker("Target project", selection: $selectedProjectName) {
                        Text("Default").tag("")
                        ForEach(projects) { proj in
                            Text(proj.name).tag(proj.name)
                        }
                    }
                }

                Section("Prompt") {
                    TextEditor(text: $promptText)
                        .frame(minHeight: 140)
                }
            }
            .navigationTitle("New conversation")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear {
                if selectedHost.isEmpty {
                    selectedHost = model.selectedHost
                        ?? hosts.first(where: { $0.online })?.name
                        ?? model.board?.host
                        ?? hosts.first?.name
                        ?? ""
                }
            }
            .onChange(of: selectedHost) { _, _ in
                selectedProjectName = ""
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Start") {
                        isStarting = true
                        Task {
                            let host = selectedHost.isEmpty ? nil : selectedHost
                            let proj = selectedProjectName.isEmpty ? nil : selectedProjectName
                            let ok = await model.startConversation(host: host, projectName: proj, text: promptText)
                            isStarting = false
                            if ok { dismiss() }
                        }
                    }
                    .disabled(isStarting || promptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}
