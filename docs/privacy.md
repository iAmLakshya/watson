# Watson capture exclusion and privacy

Capture exclusion is enabled for new profiles in [shared/defaults.ts](../shared/defaults.ts). The dashboard and overlay request protection before either window is shown. An explicit saved preference persists, and the overlay control changes it immediately. The user confirmed that enabling exclusion worked in their tested Google Meet setup.

## Capture behavior

Watson requests protection through Electron's `BrowserWindow.setContentProtection`. This is a platform capture preference whose behavior depends on the recording application and sharing mode. Electron documents that macOS ScreenCaptureKit callers can still capture protected windows. See the [Electron API contract](https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable-macos-windows).

The macOS [Swift capture helper](../native/WatsonCapture.swift) excludes Watson from its own selected-screen context using `SCContentFilter`. That prevents the assistant from reading its own overlay into subsequent context. Another recording application's capture filter is controlled by that application.

The [Windows capture implementation](windows-capture.md) applies content protection and serializes fresh selected-display screenshots. Windows runtime and receiver-side sharing compatibility remain acceptance checks.

For a sharing result, record the OS, meeting app, display/window mode, protection setting, and actual receiver output. Repeat after moving, resizing, and showing/hiding the overlay. The [verification procedure](verification.md#receiver-side-screen-sharing-check) describes these checks. Current validation does not establish universal exclusion.

## Data handling

Personal sessions are stored locally in the app's user-data directory without content encryption. Desktop provider keys use Electron `safeStorage`; iPhone provider keys use Keychain. Keys are excluded from renderer state, exports, and account preference sync.

Active transcription sends enabled audio sources to Deepgram. Assistance sends selected conversation, reference, and screen context to OpenAI. Smart web research follows its independent setting. Disabled inputs are omitted from capture requests.

Account synchronization and private audio transfers are explicit. Private attachments require consent and final review, use encrypted server storage, and are omitted from public note links. See [cloud recording behavior](cloud-recordings.md) and [service documentation](../server/README.md).

The [validation snapshot](validation.json) distinguishes automated fixtures, actual local runtime checks, user confirmation, and remaining device/provider acceptance.
