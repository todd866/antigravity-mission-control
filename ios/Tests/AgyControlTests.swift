import XCTest
@testable import AgyControl

final class AgyControlTests: XCTestCase {
    func testPairingLinkParsesValidHTTPS() throws {
        let link = try PairingLink.parse("agycontrol://pair?url=https%3A%2F%2Fmac.example.ts.net%3A8446&fallback=https%3A%2F%2Fbackup.example.ts.net%3A8446&token=0123456789abcdef0123456789abcdef")
        XCTAssertEqual(link.serverURL, "https://mac.example.ts.net:8446")
        XCTAssertEqual(link.fallbackServerURL, "https://backup.example.ts.net:8446")
        XCTAssertEqual(link.token, "0123456789abcdef0123456789abcdef")
    }

    func testPairingLinkAllowsLocalhostHTTP() throws {
        let link = try PairingLink.parse("agycontrol://pair?url=http%3A%2F%2F127.0.0.1%3A8696&token=0123456789abcdef")
        XCTAssertEqual(link.serverURL, "http://127.0.0.1:8696")
        XCTAssertNil(link.fallbackServerURL)
    }

    func testPairingLinkRejectsNonLocalHTTPAndShortToken() {
        XCTAssertThrowsError(try PairingLink.parse("agycontrol://pair?url=http%3A%2F%2Fexample.com%3A8446&token=0123456789abcdef"))
        XCTAssertThrowsError(try PairingLink.parse("agycontrol://pair?url=https%3A%2F%2Fmac.example.ts.net%3A8446&fallback=http%3A%2F%2Fexample.com%3A8446&token=0123456789abcdef"))
        XCTAssertThrowsError(try PairingLink.parse("agycontrol://pair?url=https%3A%2F%2Fexample.com%3A8446&token=short"))
    }

    func testPlainEnglishStateAndFilterLabels() {
        XCTAssertEqual(ThreadState.attention.displayName, "Waiting")
        XCTAssertEqual(ThreadState.working.displayName, "Working")
        XCTAssertEqual(ThreadState.bg.displayName, "Background")
        XCTAssertEqual(ThreadState.unread.displayName, "Unread")
        XCTAssertEqual(ThreadState.idle.displayName, "Idle")
        XCTAssertEqual(ThreadFilter.idle.displayName, "Idle")
        XCTAssertEqual(ThreadFilter.idle.matchingState, .idle)
    }

    func testAgeFormatting() {
        XCTAssertEqual(ageFormatted(ms: 12_000), "12s")
        XCTAssertEqual(ageFormatted(ms: 185_000), "3m")
        XCTAssertEqual(ageFormatted(ms: 7_200_000), "2h")
        XCTAssertEqual(ageFormatted(ms: 172_800_000), "2d")
    }

    func testMarkdownSanitizerStripsFileLinksAndHeadings() {
        let raw = "### Overall verdict\n\nManuscript [paper.tex](file:///Users/dev/work/paper.tex) is ready.\n\n---\n\n- Check `/Users/dev/work/notes.txt` builds."
        let rendered = cleanMarkdownPlainText(raw)
        XCTAssertFalse(rendered.contains("file:///"))
        XCTAssertFalse(rendered.contains("/Users/"))
        XCTAssertFalse(rendered.contains("###"))
        XCTAssertTrue(rendered.contains("`paper.tex`"))
        XCTAssertTrue(rendered.contains("• Check"))
    }

    func testBoardResponseWithBriefingsAndTurnScopedFocus() throws {
        let json = """
        {
          "generatedAt": 1795478542488,
          "sortMode": "fixed",
          "counts": { "total": 2, "attention": 0, "working": 1, "bg": 0, "unread": 0, "idle": 1, "hidden": 0 },
          "conversations": [
            {
              "id": "11111111-1111-1111-1111-111111111111",
              "shortId": "11111111",
              "title": "Demo Paper",
              "host": "m5",
              "projectId": "p1",
              "projectName": "Research",
              "stepCount": 42,
              "state": "working",
              "waitingReason": "",
              "unread": false,
              "stalled": false,
              "ageMs": 60000,
              "lastModifiedMs": 1795478480000,
              "lastUserInputMs": 1795478400000,
              "focus": "Prior turn completed and ready for review",
              "focusIsCurrentTurn": false,
              "steps": {
                "items": [{ "title": "Draft", "status": "done" }, { "title": "Compile", "status": "done" }],
                "done": 2,
                "total": 2,
                "currentTitle": ""
              },
              "stepsIsCurrentTurn": false,
              "lastPrompt": "Keep pushing on the follow-up checks",
              "lastReply": "Follow-up checks running",
              "briefing": {
                "headline": "Running follow-up edits after draft review",
                "brief": "Previous turn finished the draft cleanly. Currently continuing polish passes.",
                "currentWork": "Addressing remaining review comments.",
                "priorCompleted": "Completed initial draft and PDF.",
                "needsUser": "",
                "nextActions": [],
                "updatedAt": 1795478540000,
                "model": "gemini-3.8-flash-low"
              },
              "briefingStale": false,
              "runningBgCount": 0,
              "subagentCount": 0,
              "subagents": [],
              "model": "gemini-4-neon-xhigh",
              "pinned": true,
              "hidden": false,
              "slot": 1
            },
            {
              "id": "22222222-2222-2222-2222-222222222222",
              "shortId": "22222222",
              "title": "Idle Feature",
              "host": "m2",
              "projectId": "p1",
              "projectName": "App",
              "stepCount": 10,
              "state": "idle",
              "waitingReason": "",
              "unread": false,
              "stalled": false,
              "ageMs": 360000,
              "lastModifiedMs": 1795478180000,
              "lastUserInputMs": 1795478100000,
              "focus": "Old turn focus",
              "focusIsCurrentTurn": false,
              "steps": null,
              "lastReply": "Waiting for follow-up",
              "briefing": {
                "headline": "Ready to run test suite and commit",
                "brief": "Feature implementation compiled cleanly in the previous turn.",
                "currentWork": "",
                "priorCompleted": "Implemented new API endpoints.",
                "needsUser": "",
                "nextActions": [
                  { "label": "Run test suite", "prompt": "Run all unit tests and summarize failures." },
                  { "label": "Commit changes", "prompt": "Check git diff and create a clean commit." }
                ],
                "updatedAt": 1795478540000,
                "model": "gemini-3.8-flash-low"
              },
              "briefingStale": false,
              "runningBgCount": 0,
              "subagentCount": 0,
              "subagents": [],
              "model": "",
              "pinned": false,
              "hidden": false,
              "slot": 2
            }
          ],
          "fleet": [],
          "projects": [
            { "id": "p1", "name": "Projects", "host": "m5" },
            { "id": "p1", "name": "Projects", "host": "m2" }
          ],
          "hosts": [
            { "name": "m5", "isSelf": true, "online": true, "macAccessibility": false, "conversationCount": 1 },
            { "name": "m2", "isSelf": false, "online": true, "macAccessibility": true, "conversationCount": 1 }
          ],
          "host": "macbook",
          "macAccessibility": false,
          "remoteControlUrl": "https://antigravity.google.com"
        }
        """
        let decoded = try JSONDecoder().decode(BoardResponse.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.conversations.count, 2)
        XCTAssertEqual(decoded.counts.idle, 1)
        XCTAssertEqual(decoded.hosts?.count, 2)
        XCTAssertEqual(decoded.projects?.count, 2)
        XCTAssertEqual(decoded.projects?[1].host, "m2")
        XCTAssertEqual(decoded.conversations[0].host, "m5")
        XCTAssertEqual(decoded.conversations[1].host, "m2")
        XCTAssertEqual(decoded.conversations[0].focusIsCurrentTurn, false)
        XCTAssertEqual(decoded.conversations[0].summaryLine, "Running follow-up edits after draft review")
        XCTAssertEqual(decoded.conversations[1].briefing?.suggestions.count, 2)
        XCTAssertEqual(decoded.conversations[1].briefing?.suggestions.first?.label, "Run test suite")
        XCTAssertEqual(decoded.macAccessibility, false)
    }

    func testRelayAndAutoWakeDecoding() throws {
        let json = """
        {
          "generatedAt": 1795480000000,
          "sortMode": "fixed",
          "counts": { "total": 1, "attention": 0, "working": 0, "bg": 0, "unread": 0, "idle": 1, "hidden": 0, "pendingRelays": 1 },
          "conversations": [
            {
              "id": "33333333-3333-3333-3333-333333333333",
              "shortId": "33333333",
              "title": "Worker Tab",
              "host": "m2",
              "projectId": "p1",
              "projectName": "App",
              "stepCount": 4,
              "state": "idle",
              "waitingReason": "",
              "unread": false,
              "stalled": false,
              "ageMs": 5000,
              "lastModifiedMs": 1795479995000,
              "lastUserInputMs": 1795479990000,
              "autoWake": true,
              "focus": "",
              "steps": null,
              "lastReply": "Ready",
              "runningBgCount": 0,
              "subagentCount": 0,
              "subagents": [],
              "model": "",
              "pinned": false,
              "hidden": false,
              "slot": 1
            }
          ],
          "fleet": [],
          "relays": [
            {
              "id": "44444444-4444-4444-4444-444444444444",
              "fromLabel": "Coordinator (m5)",
              "targetConversationId": "33333333-3333-3333-3333-333333333333",
              "targetTitle": "Worker Tab",
              "targetHost": "m2",
              "message": "Run final checks and report back.",
              "hop": 1,
              "status": "pending",
              "reason": "Approval required (auto-wake off)",
              "createdAt": 1795479998000,
              "error": ""
            }
          ]
        }
        """
        let decoded = try JSONDecoder().decode(BoardResponse.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.counts.pendingRelays, 1)
        XCTAssertEqual(decoded.conversations.first?.autoWake, true)
        XCTAssertEqual(decoded.relays?.count, 1)
        XCTAssertEqual(decoded.relays?.first?.fromLabel, "Coordinator (m5)")
        XCTAssertEqual(decoded.relays?.first?.targetHost, "m2")
        XCTAssertEqual(decoded.relays?.first?.status, "pending")
    }
}
