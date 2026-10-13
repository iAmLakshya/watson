import SwiftUI

@main struct WatsonApp: App {
    @StateObject private var store = WatsonStore()
    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(store).tint(WatsonStyle.purple)
                .alert("Watson", isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })) { Button("OK") { store.error = nil } } message: { Text(store.error ?? "") }
        }
    }
}

enum WatsonStyle {
    static let purple = Color(red: 0.45, green: 0.30, blue: 0.87)
    static let pale = Color(red: 0.96, green: 0.95, blue: 0.99)
    static let ink = Color(red: 0.15, green: 0.12, blue: 0.23)
}

struct RootView: View {
    @EnvironmentObject var store: WatsonStore
    var body: some View {
        TabView {
            HomeView().tabItem { Label("Conversations", systemImage: "bubble.left.and.bubble.right") }
            NavigationStack { KnowledgeView() }.tabItem { Label("Personalize", systemImage: "sparkles") }
            NavigationStack { SettingsView() }.tabItem { Label("Settings", systemImage: "slider.horizontal.3") }
        }
        .sheet(isPresented: Binding(get: { !store.data.settings.completedOnboarding }, set: { if !$0 { store.setSettings { $0.completedOnboarding = true } } })) { OnboardingView().interactiveDismissDisabled() }
    }
}

struct OnboardingView: View {
    @EnvironmentObject var store: WatsonStore
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Spacer()
            Image(systemName: "waveform.circle.fill").font(.system(size: 72)).foregroundStyle(WatsonStyle.purple)
            Text("A little help,\nright when you need it.").font(.system(size: 36, weight: .bold, design: .rounded)).foregroundStyle(WatsonStyle.ink)
            Text("Watson records nearby conversations and turns them into useful answers, notes, and next steps.").font(.title3).foregroundStyle(.secondary)
            Label("Record an in-person conversation or voice memo", systemImage: "mic")
            Label("Ask for help using the saved conversation context", systemImage: "sparkles")
            Label("Keep notes on this phone or connect your account", systemImage: "lock.icloud")
            Text("iPhone recording uses your microphone. Phone calls, video calls, and other apps’ screens are unavailable.").font(.footnote).foregroundStyle(.secondary)
            Spacer()
            Button { store.setSettings { $0.completedOnboarding = true } } label: { Text("Get started").frame(maxWidth: .infinity).padding(.vertical, 10) }.buttonStyle(.borderedProminent).accessibilityIdentifier("onboarding-start")
        }.padding(28).background(WatsonStyle.pale)
    }
}

struct ActivitySheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: items, applicationActivities: nil) }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

struct Pill: View {
    let text: String
    var color: Color = WatsonStyle.purple
    var body: some View { Text(text).font(.caption.weight(.semibold)).padding(.horizontal, 9).padding(.vertical, 5).foregroundStyle(color).background(color.opacity(0.1), in: Capsule()) }
}
