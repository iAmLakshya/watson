import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var store: WatsonStore
    @State private var openai = ""
    @State private var deepgram = ""
    @State private var email = ""
    @State private var password = ""
    @State private var name = ""
    @State private var signup = false
    @State private var authenticating = false
    @State private var deletingAccount = false
    @State private var clearingLocal = false
    @State private var removingKeys = false
    @State private var accountPassword = ""
    private func binding<T>(_ keyPath: WritableKeyPath<MobileSettings, T>) -> Binding<T> { Binding(get: { store.data.settings[keyPath: keyPath] }, set: { value in store.setSettings { $0[keyPath: keyPath] = value } }) }
    var body: some View {
        Form {
            Section {
                HStack { Image(systemName: "waveform.circle.fill").font(.system(size: 42)).foregroundStyle(WatsonStyle.purple); VStack(alignment: .leading, spacing: 3) { Text("Watson").font(.title2.bold()); Text("Your conversation companion").font(.caption).foregroundStyle(.secondary) } }
            }
            Section {
                credentialRow("OpenAI", present: store.hasOpenAI)
                SecureField(store.hasOpenAI ? "Replace OpenAI key" : "OpenAI API key", text: $openai).textContentType(.password).autocorrectionDisabled().textInputAutocapitalization(.never).accessibilityIdentifier("openai-key")
                credentialRow("Deepgram", present: store.hasDeepgram)
                SecureField(store.hasDeepgram ? "Replace Deepgram key" : "Deepgram API key", text: $deepgram).textContentType(.password).autocorrectionDisabled().textInputAutocapitalization(.never).accessibilityIdentifier("deepgram-key")
                Button("Save provider keys") { store.saveKeys(openai: openai.isEmpty ? nil : openai, deepgram: deepgram.isEmpty ? nil : deepgram); openai = ""; deepgram = "" }.disabled(openai.isEmpty && deepgram.isEmpty).accessibilityIdentifier("save-provider-keys")
                if store.hasOpenAI || store.hasDeepgram { Button("Remove provider keys", role: .destructive) { removingKeys = true } }
            } header: { Text("AI providers") } footer: { Text("Keys stay in this device’s Keychain and are sent directly to their provider. Recording sends nearby microphone audio to Deepgram. Assistance sends conversation context to OpenAI. Provider usage is billed to your accounts.") }
            Section("Languages") {
                Picker("Audio input", selection: binding(\.language)) { ForEach(MobileSettings.inputLanguages, id: \.0) { code, title in Text(title).tag(code) } }
                Picker("Answer output", selection: binding(\.outputLanguage)) { ForEach(MobileSettings.outputLanguages, id: \.self) { Text($0).tag($0) } }
            }
            Section("Assistance") {
                Picker("Default mode", selection: binding(\.activeModeId)) { ForEach(store.data.modes) { Text($0.name).tag($0.id) } }
                Toggle("Offer help after speech", isOn: binding(\.autoAssist))
                Toggle("Generate notes when I finish", isOn: binding(\.automaticNotes))
                TextField("Normal OpenAI model", text: binding(\.model)).autocorrectionDisabled().textInputAutocapitalization(.never).accessibilityIdentifier("normal-model")
                TextField("Deepgram model", text: binding(\.transcriptionModel)).autocorrectionDisabled().textInputAutocapitalization(.never)
                TextField("How should Watson help you?", text: binding(\.instructions), axis: .vertical).lineLimit(3...8)
            }
            Section {
                Toggle("Use Smart assistance", isOn: binding(\.smartMode)).accessibilityIdentifier("smart-enabled")
                TextField("Smart OpenAI model", text: binding(\.smartModel)).autocorrectionDisabled().textInputAutocapitalization(.never).accessibilityIdentifier("smart-model")
                Picker("Reasoning effort", selection: binding(\.smartReasoningEffort)) { ForEach(SmartConfiguration.options(model: store.data.settings.smartModel), id: \.self) { Text($0.capitalized).tag($0) } }.accessibilityIdentifier("smart-effort")
                Toggle("Search the web in Smart", isOn: binding(\.smartWebSearch)).accessibilityIdentifier("smart-web-search")
                HStack { Text("Output token limit"); Spacer(); TextField("25000", value: binding(\.smartMaxOutputTokens), format: .number).keyboardType(.numberPad).multilineTextAlignment(.trailing).frame(width: 100).accessibilityIdentifier("smart-token-limit") }
                if let message = smartConfigurationError { Label(message, systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.red).accessibilityIdentifier("smart-configuration-error") }
            } header: { Text("Smart") } footer: { Text("Smart uses GPT-5.4 mini with Medium reasoning by default. Its 25,000 token ceiling includes reasoning and visible text; it is a limit, not measured usage. Web search is optional. Smart can take longer; notes and email drafts use your normal model. A model incompatibility is shown as an error.") }
            accountSection
            if !store.data.conflicts.isEmpty {
                Section("Sync conflicts") {
                    ForEach(store.data.conflicts, id: \.key) { conflict in
                        VStack(alignment: .leading, spacing: 10) {
                            Text("\(conflict.entity.capitalized): \(store.meeting(conflict.id)?.title ?? conflict.id)").font(.headline)
                            Text("This item changed on another device. Choose the version to keep.").font(.caption).foregroundStyle(.secondary)
                            if let remote = conflict.current?.data, let meeting = try? remote.decode(Meeting.self) { Text("Server: \(meeting.title)\n\(String(meeting.notes.prefix(220)))").font(.caption) }
                            HStack {
                                Button("Keep phone version") { Task { await store.resolve(conflict, keepLocal: true) } }
                                Button("Use server version") { Task { await store.resolve(conflict, keepLocal: false) } }
                            }
                        }
                    }
                }
            }
            Section("This phone") {
                Button("Open iPhone settings", systemImage: "mic") { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } }
                Button("Show introduction", systemImage: "info.circle") { store.setSettings { $0.completedOnboarding = false } }
                Button("Remove local meeting data", systemImage: "trash", role: .destructive) { clearingLocal = true }.disabled(store.recording || store.connecting)
                Text("Watson iPhone 0.1.0 · iOS 17+\nNearby microphone recording; phone/video calls and screen capture are unavailable.").font(.caption).foregroundStyle(.secondary)
            }
        }.navigationTitle("Settings")
            .onAppear { name = store.data.cloudUser?.name ?? "" }
            .task { if !store.data.settings.backendURL.isEmpty { await store.refreshAccountOptions() } }
            .confirmationDialog("Remove OpenAI and Deepgram keys from this phone?", isPresented: $removingKeys, titleVisibility: .visible) { Button("Remove keys", role: .destructive) { store.saveKeys(openai: "", deepgram: "") } }
            .confirmationDialog("Remove local meetings, audio, knowledge, and account sync data? Cloud data remains on your server.", isPresented: $clearingLocal, titleVisibility: .visible) { Button("Remove local data", role: .destructive) { Task { await store.logout(); await store.clearLocalData() } } }
            .sheet(isPresented: $deletingAccount) {
                NavigationStack { Form { Section { Text("Delete your Watson account and all its server meetings. This also removes meeting data from this phone."); SecureField("Current account password", text: $accountPassword).textContentType(.password) }; Button("Delete my account", role: .destructive) { Task { await store.deleteAccount(password: accountPassword); accountPassword = ""; if !store.authenticated { deletingAccount = false } } }.disabled(accountPassword.isEmpty) }.navigationTitle("Delete account").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { accountPassword = ""; deletingAccount = false } } } }
            }
    }
    private func credentialRow(_ title: String, present: Bool) -> some View { HStack { Text(title).font(.subheadline.weight(.medium)); Spacer(); Label(present ? "Saved in Keychain" : "Not configured", systemImage: present ? "checkmark.shield" : "key").font(.caption).foregroundStyle(present ? Color.green : Color.secondary) } }
    private var smartConfigurationError: String? { do { try SmartConfiguration.validate(model: store.data.settings.smartModel, effort: store.data.settings.smartReasoningEffort); return nil } catch { return error.localizedDescription } }
    @ViewBuilder private var accountSection: some View {
        Section {
            if ProcessInfo.processInfo.arguments.contains("--ui-testing") && ProcessInfo.processInfo.arguments.contains("--account-options-fixture") { Pill(text: "SAMPLE ACCOUNT OPTIONS · FIXTURE DATA") }
            TextField("https://your-server/api/v1", text: binding(\.backendURL)).keyboardType(.URL).autocorrectionDisabled().textInputAutocapitalization(.never).disabled(store.authenticated).accessibilityIdentifier("backend-url")
            if store.authenticated, let user = store.data.cloudUser {
                Label(user.email, systemImage: "person.crop.circle")
                Label(user.emailVerified == true ? "Email verified" : (user.emailVerified == false ? "Email not verified" : "Email status unavailable"), systemImage: user.emailVerified == true ? "checkmark.seal" : "envelope").font(.subheadline).foregroundStyle(user.emailVerified == true ? Color.green : Color.secondary).accessibilityIdentifier("email-verification-status")
                if user.emailVerified != true, store.accountCapabilities?.emailDeliveryConfigured == true { Button("Send verification email") { Task { await store.requestEmailVerification() } }.disabled(store.requestingEmail).accessibilityIdentifier("request-email-verification") }
                TextField("Name", text: $name).textContentType(.name)
                Button("Update profile") { Task { await store.updateProfile(name: name) } }
                Toggle("Sync automatically", isOn: binding(\.automaticSync))
                Button { Task { await store.sync() } } label: { HStack { Label("Sync now", systemImage: "arrow.triangle.2.circlepath"); Spacer(); if store.syncing { ProgressView() } } }.disabled(store.syncing)
                if let date = store.lastSync { Text("Last synced \(date.formatted(date: .omitted, time: .shortened))").font(.caption).foregroundStyle(.secondary) }
                Text("\(store.data.pending.count) pending changes").font(.caption).foregroundStyle(.secondary)
                Button("Sign out") { Task { await store.logout() } }
                Button("Delete account", role: .destructive) { deletingAccount = true }
            } else {
                Picker("Account action", selection: $signup) { Text("Sign in").tag(false); Text("Create account").tag(true) }.pickerStyle(.segmented).accessibilityIdentifier("account-action")
                if signup { TextField("Your name", text: $name).textContentType(.name) }
                TextField("Email", text: $email).textContentType(.emailAddress).keyboardType(.emailAddress).autocorrectionDisabled().textInputAutocapitalization(.never).accessibilityIdentifier("account-email")
                SecureField(signup ? "Password (12+ characters)" : "Password", text: $password).textContentType(signup ? .newPassword : .password).accessibilityIdentifier("account-password")
                Button { authenticating = true; Task { await store.login(email: email, password: password, name: name, signup: signup); password = ""; authenticating = false } } label: { HStack { Text(signup ? "Create account & connect sync" : "Sign in & connect sync"); Spacer(); if authenticating { ProgressView() } } }.disabled(authenticating || email.isEmpty || password.isEmpty || store.data.settings.backendURL.isEmpty).accessibilityIdentifier("account-submit")
                if !signup, store.accountCapabilities?.passwordRecoveryConfigured == true { Button("Forgot password?") { Task { await store.requestPasswordReset(email: email) } }.disabled(store.requestingEmail || email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).accessibilityIdentifier("forgot-password") }
            }
            if !store.data.settings.backendURL.isEmpty { Button { Task { await store.refreshAccountOptions() } } label: { HStack { Text(store.authenticated ? "Refresh account status" : "Check server account options"); Spacer(); if store.checkingAccount { ProgressView() } } }.disabled(store.checkingAccount).accessibilityIdentifier("check-account-options") }
            if let capabilities = store.accountCapabilities, !capabilities.emailDeliveryConfigured { Text("Email verification and password recovery are unavailable on this server.").font(.caption).foregroundStyle(.secondary) }
            if let message = store.accountMessage { Text(message).font(.caption).foregroundStyle(WatsonStyle.purple).accessibilityIdentifier("account-email-message") }
        } header: { Text("Account & sync") } footer: { Text("Optional. Connect your own Watson backend to sync meetings, modes, and knowledge with desktop. Use an HTTPS server reachable by your phone. A phone’s localhost is the phone itself. Public share links are available after sync.") }
    }
}
