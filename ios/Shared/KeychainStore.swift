import Foundation
import Security

enum KeychainStore {
    private static let service = (Bundle.main.bundleIdentifier ?? "org.example.agycontrol") + ".auth"
    private static let serverAccount = "server-url"
    private static let fallbackServerAccount = "fallback-server-url"
    private static let tokenAccount = "bearer-token"

    static func loadServerURL() -> String? {
        load(account: serverAccount)
    }

    static func saveServerURL(_ value: String) {
        save(value, account: serverAccount)
    }

    static func loadFallbackServerURL() -> String? {
        load(account: fallbackServerAccount)
    }

    static func saveFallbackServerURL(_ value: String) {
        save(value, account: fallbackServerAccount)
    }

    static func loadToken() -> String? {
        load(account: tokenAccount)
    }

    static func saveToken(_ value: String) {
        save(value, account: tokenAccount)
    }

    private static func load(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    private static func save(_ value: String, account: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(baseQuery as CFDictionary)
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else {
            return
        }
        var addQuery = baseQuery
        addQuery[kSecValueData as String] = data
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(addQuery as CFDictionary, nil)
    }
}
