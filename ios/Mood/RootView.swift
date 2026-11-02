import Combine
import SwiftUI
import WebKit

/// Корневой экран первой версии: полноэкранное веб-приложение Mood.
///
/// Это осознанно тонкая оболочка, а не готовый нативный интерфейс. Её задача —
/// дать устанавливаемое приложение с иконкой, сохранённой сессией и системным
/// поведением, пока нативные экраны пишутся по одному на SwiftUI.
struct RootView: View {
    @StateObject private var store = WebViewStore()

    var body: some View {
        ZStack(alignment: .top) {
            Color("LaunchBackground")
                .ignoresSafeArea()

            WebViewContainer(store: store)
                .ignoresSafeArea(.container, edges: .all)

            if store.showsProgress {
                ProgressView(value: store.progress)
                    .progressViewStyle(.linear)
                    .tint(.accentColor)
                    .frame(height: 2)
                    .accessibilityLabel("Загрузка")
            }

            if let message = store.errorMessage {
                LoadErrorView(message: message) {
                    store.reload()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color("LaunchBackground").ignoresSafeArea())
            }
        }
        .preferredColorScheme(store.theme == .light ? .light : .dark)
        .onAppear {
            store.loadIfNeeded()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            store.refreshAfterForeground()
        }
    }
}

/// Мост между SwiftUI и `WKWebView`. Сам web view живёт в `WebViewStore`, чтобы
/// навигационные делегаты и состояние переживали перерисовку SwiftUI.
private struct WebViewContainer: UIViewRepresentable {
    @ObservedObject var store: WebViewStore

    func makeUIView(context: Context) -> WKWebView {
        store.webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

private struct LoadErrorView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(.secondary)

            Text(message)
                .font(.callout)
                .multilineTextAlignment(.center)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)

            Button("Повторить", action: retry)
                .buttonStyle(.borderedProminent)
        }
        .padding(28)
        .frame(maxWidth: 340)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .padding(24)
    }
}
