import ApplicationServices
import Darwin
import Foundation

private func parseSemver(_ dirName: String) -> [Int] {
    let trimmed = dirName.hasPrefix("v") ? String(dirName.dropFirst()) : dirName
    return trimmed.split(separator: ".").map { Int($0) ?? 0 }
}

private func isNewerSemver(_ lhs: [Int], than rhs: [Int]) -> Bool {
    let count = max(lhs.count, rhs.count)
    for idx in 0..<count {
        let a = idx < lhs.count ? lhs[idx] : 0
        let b = idx < rhs.count ? rhs[idx] : 0
        if a != b { return a > b }
    }
    return false
}

private func nodeMajorVersion(_ nodePath: String) -> Int {
    let probe = Process()
    probe.executableURL = URL(fileURLWithPath: nodePath)
    probe.arguments = ["-p", "Number(process.versions.node.split('.')[0])"]
    let pipe = Pipe()
    probe.standardOutput = pipe
    probe.standardError = FileHandle.nullDevice
    do {
        try probe.run()
        probe.waitUntilExit()
        guard probe.terminationStatus == 0 else { return 0 }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let out = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "0"
        return Int(out) ?? 0
    } catch {
        return 0
    }
}

private func resolveNodeBinary(home: URL) -> String? {
    let fm = FileManager.default
    var candidates: [String] = []
    if let explicit = ProcessInfo.processInfo.environment["AGY_NODE_BIN"], !explicit.isEmpty {
        candidates.append(explicit)
    }

    let nvmVersionsDir = home.appendingPathComponent(".nvm/versions/node", isDirectory: true)
    if let entries = try? fm.contentsOfDirectory(atPath: nvmVersionsDir.path) {
        let sorted = entries
            .filter { $0.hasPrefix("v") }
            .sorted { isNewerSemver(parseSemver($0), than: parseSemver($1)) }
        for entry in sorted {
            candidates.append(nvmVersionsDir.appendingPathComponent("\(entry)/bin/node").path)
        }
    }

    candidates.append("/opt/homebrew/bin/node")
    candidates.append("/usr/local/bin/node")

    for path in candidates {
        guard fm.isExecutableFile(atPath: path) else { continue }
        if nodeMajorVersion(path) >= 22 {
            return path
        }
    }
    return nil
}

private func resolveApiScript(home: URL) -> String? {
    let fm = FileManager.default
    if let envScript = ProcessInfo.processInfo.environment["AGY_API_SCRIPT"], !envScript.isEmpty {
        let url = URL(fileURLWithPath: envScript)
        if url.lastPathComponent == "agy-control-api.mjs", fm.fileExists(atPath: url.path) {
            return url.path
        }
    }
    let defaultPath = home.appendingPathComponent("Projects/agy-control/server/agy-control-api.mjs").path
    return fm.fileExists(atPath: defaultPath) ? defaultPath : nil
}

if CommandLine.arguments.contains("--register-accessibility") {
    let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    let trusted = AXIsProcessTrustedWithOptions([promptKey: true] as CFDictionary)
    print("trusted=\(trusted)")
    exit(0)
}

let home = FileManager.default.homeDirectoryForCurrentUser
guard let nodeBin = resolveNodeBinary(home: home) else {
    FileHandle.standardError.write(Data("MissionControlHelper: Node.js 22 or newer not found.\n".utf8))
    exit(1)
}
guard let scriptPath = resolveApiScript(home: home) else {
    FileHandle.standardError.write(Data("MissionControlHelper: agy-control-api.mjs not found.\n".utf8))
    exit(1)
}

var env = ProcessInfo.processInfo.environment
env["AGY_HELPER_APP"] = "Mission Control Helper"
let nodeDir = URL(fileURLWithPath: nodeBin).deletingLastPathComponent().path
let localBin = home.appendingPathComponent(".local/bin").path
let existingPath = env["PATH"] ?? "/usr/bin:/bin"
env["PATH"] = [nodeDir, localBin, "/opt/homebrew/bin", "/usr/local/bin", existingPath]
    .filter { !$0.isEmpty }
    .joined(separator: ":")

let child = Process()
child.executableURL = URL(fileURLWithPath: nodeBin)
child.arguments = [scriptPath]
child.environment = env

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)

let sigTermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
sigTermSource.setEventHandler {
    let pid = child.processIdentifier
    if pid > 0 { kill(pid, SIGTERM) }
}
sigTermSource.resume()

let sigIntSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
sigIntSource.setEventHandler {
    let pid = child.processIdentifier
    if pid > 0 { kill(pid, SIGINT) }
}
sigIntSource.resume()

do {
    try child.run()
} catch {
    FileHandle.standardError.write(Data("MissionControlHelper: failed to launch server: \(error)\n".utf8))
    exit(1)
}

child.waitUntilExit()
exit(child.terminationStatus)
