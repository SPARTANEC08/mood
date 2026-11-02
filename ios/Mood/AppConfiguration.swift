import Foundation

/// Настройки сборки и адрес приложения.
///
/// Адрес лежит в Info.plist (`MoodAppURL`), чтобы можно было собрать сборку под
/// другой сервер, не трогая код: достаточно изменить строку в настройках таргета
/// или в `ios/project.yml`.
enum AppConfiguration {
    static let fallbackURL = URL(string: "https://mood-app.ru")!

    static var baseURL: URL {
        guard
            let raw = Bundle.main.object(forInfoDictionaryKey: "MoodAppURL") as? String,
            let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
            let scheme = url.scheme?.lowercased(),
            scheme == "https" || scheme == "http"
        else {
            return fallbackURL
        }
        return url
    }

    /// Домены, которые открываются внутри приложения. Всё остальное уходит в
    /// Safari: чужие сайты не должны получать доступ к сессии Mood.
    static var allowedHosts: Set<String> {
        guard let host = baseURL.host?.lowercased() else { return [] }
        var hosts: Set<String> = [host]
        if !host.hasPrefix("www.") {
            hosts.insert("www." + host)
        }
        return hosts
    }

    static var isDebugBuild: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }
}
