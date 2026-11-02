import SafariServices
import UIKit

/// Всё, что не должно открываться внутри приложения: чужие сайты, почта,
/// Telegram, файлы. Внутри остаётся только домен Mood — иначе внешняя страница
/// получила бы доступ к `localStorage` с PWA-токеном.
@MainActor
enum ExternalBrowser {
    static func open(_ url: URL) {
        let scheme = url.scheme?.lowercased() ?? ""
        guard scheme == "http" || scheme == "https" else {
            UIApplication.shared.open(url)
            return
        }

        guard let presenter = TopViewController.current else {
            UIApplication.shared.open(url)
            return
        }

        let safari = SFSafariViewController(url: url)
        safari.preferredControlTintColor = .tintColor
        safari.dismissButtonStyle = .close
        presenter.present(safari, animated: true)
    }

    static func share(_ url: URL) {
        guard let presenter = TopViewController.current else { return }

        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        if let popover = controller.popoverPresentationController {
            popover.sourceView = presenter.view
            popover.sourceRect = CGRect(
                x: presenter.view.bounds.midX,
                y: presenter.view.bounds.midY,
                width: 1,
                height: 1
            )
            popover.permittedArrowDirections = []
        }
        presenter.present(controller, animated: true)
    }
}

/// Поиск верхнего контроллера для показа Safari/алертов/«Поделиться» из
/// SwiftUI, где нет прямого доступа к иерархии UIKit.
@MainActor
enum TopViewController {
    static var current: UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes
            .flatMap(\.windows)
            .first(where: \.isKeyWindow) ?? scenes.first?.windows.first

        guard var top = window?.rootViewController else { return nil }
        while let presented = top.presentedViewController {
            top = presented
        }
        if let navigation = top as? UINavigationController {
            return navigation.visibleViewController ?? navigation
        }
        if let tab = top as? UITabBarController {
            return tab.selectedViewController ?? tab
        }
        return top
    }

    /// Возвращает `false`, если показать некому: вызывающий код обязан сам
    /// завершить JS-колбэк, иначе страница зависнет на диалоге.
    @discardableResult
    static func present(_ controller: UIViewController) -> Bool {
        guard let presenter = current else { return false }
        presenter.present(controller, animated: true)
        return true
    }
}
