import Foundation
import SwiftUI
import UIKit
import WebKit

/// Тема, которую выбрал пользователь внутри PWA (localStorage `mood_theme`).
/// Нужна только для системного оформления: статус-бар, алерты, клавиатура.
enum AppTheme: String, Equatable {
    case light
    case dark

    init(webValue: String?) {
        self = webValue == "light" ? .light : .dark
    }
}

/// Владелец `WKWebView`: загрузка, навигация, файлы, JS-диалоги, тема.
///
/// Класс намеренно `@MainActor`: и `WKWebView`, и все его делегаты живут на
/// главном потоке, а SwiftUI подписан на `@Published`-свойства.
@MainActor
final class WebViewStore: NSObject, ObservableObject {
    @Published private(set) var progress: Double = 0
    @Published private(set) var isLoading = false
    @Published private(set) var hasLoadedOnce = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var theme: AppTheme = .dark

    let webView: WKWebView

    private var observations: [NSKeyValueObservation] = []
    private var requestedInitialLoad = false
    private var downloadDestinations: [ObjectIdentifier: URL] = [:]

    /// Тонкая полоска прогресса только на самой первой загрузке: дальше PWA
    /// обновляет данные сама, и мигать полоской при каждом переходе не нужно.
    var showsProgress: Bool {
        !hasLoadedOnce && progress > 0 && progress < 1
    }

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.preferences.isFraudulentWebsiteWarningEnabled = true

        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()

        configureWebView()
        observeLoading()
        installThemeBridge(into: configuration.userContentController)
    }

    // MARK: - Публичные действия

    func loadIfNeeded() {
        guard !requestedInitialLoad else { return }
        requestedInitialLoad = true
        load(URLRequest(url: AppConfiguration.baseURL))
    }

    func reload() {
        errorMessage = nil
        load(URLRequest(url: AppConfiguration.baseURL))
    }

    /// Возврат из фона: если приложение так и не открылось или показывало
    /// ошибку — пробуем снова. Успешно загруженную страницу не трогаем:
    /// PWA сама обновляет данные по `visibilitychange`.
    func refreshAfterForeground() {
        guard errorMessage != nil || webView.url == nil else { return }
        reload()
    }

    // MARK: - Настройка

    private func configureWebView() {
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.underPageBackgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        // PWA уже учитывает safe area через env(safe-area-inset-*) и
        // viewport-fit=cover, поэтому вторая поправка от UIKit только мешает.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.keyboardDismissMode = .interactive
        webView.scrollView.alwaysBounceVertical = true
        webView.scrollView.bounces = true

        #if DEBUG
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        #endif
    }

    private func observeLoading() {
        observations = [
            webView.observe(\.estimatedProgress, options: [.new]) { [weak self] webView, _ in
                let value = webView.estimatedProgress
                Task { @MainActor in
                    self?.progress = value
                }
            },
            webView.observe(\.isLoading, options: [.new]) { [weak self] webView, _ in
                let value = webView.isLoading
                Task { @MainActor in
                    self?.isLoading = value
                }
            },
        ]
    }

    /// Тема PWA живёт в localStorage и меняется без перезагрузки страницы.
    /// Отдельный MutationObserver сообщает о ней нативной оболочке, чтобы
    /// статус-бар и системные алерты не спорили с фоном приложения.
    private func installThemeBridge(into controller: WKUserContentController) {
        let source = """
        (function () {
          if (window.__moodThemeBridge) { return; }
          window.__moodThemeBridge = true;

          function report() {
            try {
              var value = document.documentElement.getAttribute('data-theme');
              if (value && window.webkit && window.webkit.messageHandlers.moodTheme) {
                window.webkit.messageHandlers.moodTheme.postMessage(value);
              }
            } catch (e) {}
          }

          report();
          try {
            new MutationObserver(report).observe(document.documentElement, {
              attributes: true,
              attributeFilter: ['data-theme']
            });
          } catch (e) {}
        })();
        """

        let script = WKUserScript(
            source: source,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )
        controller.addUserScript(script)
        controller.add(WeakScriptMessageHandler(delegate: self), name: "moodTheme")
    }

    private func load(_ request: URLRequest) {
        errorMessage = nil
        webView.load(request)
    }
}

// MARK: - WKNavigationDelegate

extension WebViewStore: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        errorMessage = nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hasLoadedOnce = true
        errorMessage = nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleLoadFailure(error)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        handleLoadFailure(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // iOS выгрузила процесс WebContent (нехватка памяти). Без перезагрузки
        // пользователь видит пустой экран.
        reload()
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }

        let scheme = url.scheme?.lowercased() ?? ""

        // Внутри приложения — только Mood. Ссылки на почту МЭИ, GitHub, канал
        // и прочие внешние адреса открываются в Safari, без доступа к сессии.
        if scheme == "http" || scheme == "https" {
            let host = url.host?.lowercased() ?? ""
            guard AppConfiguration.allowedHosts.contains(host) else {
                ExternalBrowser.open(url)
                decisionHandler(.cancel)
                return
            }
        } else if scheme == "about" || scheme == "blob" || scheme == "data" {
            decisionHandler(.allow)
            return
        } else {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }

        // target="_blank": внутри домена грузим в текущем web view, иначе — наружу.
        if navigationAction.targetFrame == nil {
            let host = url.host?.lowercased() ?? ""
            if AppConfiguration.allowedHosts.contains(host) {
                webView.load(URLRequest(url: url))
            } else {
                ExternalBrowser.open(url)
            }
            decisionHandler(.cancel)
            return
        }

        decisionHandler(.allow)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        // PDF и документы, которые WebKit не умеет показать, скачиваем и отдаём
        // системе через share sheet. Картинки и HTML остаются в приложении.
        if navigationResponse.canShowMIMEType {
            decisionHandler(.allow)
        } else {
            decisionHandler(.download)
        }
    }

    func webView(
        _ webView: WKWebView,
        navigationAction: WKNavigationAction,
        didBecome download: WKDownload
    ) {
        download.delegate = self
    }

    func webView(
        _ webView: WKWebView,
        navigationResponse: WKNavigationResponse,
        didBecome download: WKDownload
    ) {
        download.delegate = self
    }

    private func handleLoadFailure(_ error: Error) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
            return
        }
        // Если страница уже показывалась, её мог отдать Service Worker из кэша.
        // Не перекрываем офлайн-оболочку красной плашкой.
        guard !hasLoadedOnce else { return }
        errorMessage = "Не удалось загрузить Mood.\nПроверьте подключение к интернету и повторите."
    }
}

// MARK: - WKUIDelegate

extension WebViewStore: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        let host = url.host?.lowercased() ?? ""
        if AppConfiguration.allowedHosts.contains(host) {
            webView.load(URLRequest(url: url))
        } else {
            ExternalBrowser.open(url)
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Ок", style: .default) { _ in completionHandler() })
        if !TopViewController.present(alert) {
            completionHandler()
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Отмена", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "Ок", style: .default) { _ in completionHandler(true) })
        if !TopViewController.present(alert) {
            completionHandler(false)
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { field in
            field.text = defaultText
        }
        alert.addAction(UIAlertAction(title: "Отмена", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "Ок", style: .default) { [weak alert] _ in
            completionHandler(alert?.textFields?.first?.text)
        })
        if !TopViewController.present(alert) {
            completionHandler(defaultText)
        }
    }
}

// MARK: - WKDownloadDelegate

extension WebViewStore: WKDownloadDelegate {
    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let fileManager = FileManager.default
        let directory = fileManager.temporaryDirectory
            .appendingPathComponent("MoodDownloads", isDirectory: true)

        do {
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            completionHandler(nil)
            return
        }

        // Имя от сервера может содержать слэши и «..» — на диск кладём UUID,
        // а исходное имя сохраняем как суффикс только для читаемости.
        let cleaned = suggestedFilename
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "\\", with: "_")
        let destination = directory.appendingPathComponent("\(UUID().uuidString)-\(cleaned)")
        downloadDestinations[ObjectIdentifier(download)] = destination
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = downloadDestinations.removeValue(forKey: ObjectIdentifier(download)) else {
            return
        }
        ExternalBrowser.share(url)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadDestinations.removeValue(forKey: ObjectIdentifier(download))
        errorMessage = "Не удалось скачать файл. Попробуйте ещё раз."
    }
}

// MARK: - WKScriptMessageHandler

extension WebViewStore: WKScriptMessageHandler {
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == "moodTheme", let value = message.body as? String else { return }
        theme = AppTheme(webValue: value)
    }
}

/// `WKUserContentController` держит обработчик сообщений сильно. Без прокси это
/// даёт цикл `store → webView → configuration → controller → store`, и экран
/// никогда не освобождается.
private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var delegate: WKScriptMessageHandler?

    init(delegate: WKScriptMessageHandler) {
        self.delegate = delegate
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        delegate?.userContentController(userContentController, didReceive: message)
    }
}
