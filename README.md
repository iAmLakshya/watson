# Watson

Watson is a local-first conversation and screen assistant. Version 0.4 includes a macOS desktop app, Windows capture implementation, native iPhone project, and optional Node/SQLite account service. The current development builds, implemented features, and completed validation are summarized in the project progress report.

[Project progress](docs/progress.md) · [Validation](docs/validation.json)

## Run the desktop

Use Node.js 24+, npm, macOS 13+, and Apple's command-line Swift toolchain. Windows development does not require Swift.

```sh
npm ci
npm run build
npm start
```

On Windows, run `npm run build:renderer` and `npm run build:electron` instead of the Mac native build. Installation scripts install Electron; use `npm run setup:electron` if scripts were disabled. `npm run dev` starts development mode. `npm run preview` shows a labeled browser fixture and cannot record audio, capture the desktop, or store provider keys.

In Settings, configure OpenAI/Deepgram keys, input/output languages, microphone, display, and desired inputs. Desktop keys are encrypted with Electron `safeStorage`; environment keys `OPENAI_API_KEY` and `DEEPGRAM_API_KEY` are also supported. Grant macOS Microphone and Screen & System Audio Recording access when prompted. A live session becomes active only after the helper reports capture success; missing permission/provider errors stay visible. The labeled demo needs no credentials and is not live AI validation.

Personal sessions need no Watson account. Local content is stored unencrypted in `watson.json` in the app's user-data directory. Use `WATSON_USER_DATA_DIR=/absolute/writable/path` for isolated tests. Active transcription sends audio to Deepgram; assistance sends selected conversation/reference/screen context to OpenAI. Smart has separate model/effort/token-budget settings and an independent web-search toggle. Normal assistance retains its configured model. No meeting bot joins the call.

## Desktop behavior

- Separate microphone/system streams, provisional/final transcripts, pause/resume/end, source meters, microphone selection, and an explicit pre-meeting audio/transcription test.
- Fresh screenshot context/preview, streamed Assist/What to Say/Follow-up/Recap/chat, cited Smart web research, and independent input/output languages. First-text and completion timings share a monotonic request origin on desktop and iPhone; legacy values remain labeled separately.
- Compact/expanded overlay, selected-monitor placement, global/custom shortcuts, click-through, opacity, dashboard/tray, and capture exclusion enabled by default.
- History, tags/pinning/search, people/attendees, commitments with owners/status, contextual references, notes/actions/email drafts, Gmail draft opening, edits, and Markdown/JSON export.
- Personal modes with separate notes/email templates and custom prompt/link actions. TXT/Markdown/PDF/DOCX import uses bounded portable DOCX extraction; scanned PDFs need OCR.
- ICS import/attendee mapping, reminders/join links, linked session starts and contextual briefs. Opted-in scheduled preparation researches supplied participant identities and includes traceable citations.
- Opted-in call start/end detection uses OS audio-session activity, configurable delays and visible browser ambiguity. It requires existing capture permissions and configured providers before an automatic live start.
- Coaching scorecards with exact transcript evidence, local and role-scoped organization/team/member/date analytics and CSV export. Demos are excluded by default and do not invent scores.
- Optional account sync, verification/recovery controls, revocable HTML share links, organizations/teams, scoped resources/policies, private assigned modes, and Google/Merge/approved-URL controls.
- Consent-reviewed private audio attachments, native file selection/export, transfer progress and deletion in each saved session's Audio tab. Public note links exclude audio.
- First-run and reopenable guided demo lessons, setup diagnostics, and a signed-update staging/rollback implementation that remains disabled until production signing and hosting are configured.

[Smart and meeting memory](docs/smart-and-memory.md), [scheduled preparation](docs/preparation.md), and [managed distribution](docs/managed-distribution.md) document their evidence and limits. Actual conferencing-app detection, participant matching, live accuracy/quality/latency, production signed updates and staffed support remain acceptance gates.

## Capture exclusion

**New profiles request exclusion for the dashboard and overlay before either window is shown.** The visible overlay control changes it; a saved explicit setting is retained. The user confirmed exclusion worked in their tested Google Meet setup. This does not establish every capture path's compatibility.

Modern macOS ScreenCaptureKit callers can still capture protected Electron windows. Watson's own screen filter excludes Watson from its input image; it cannot control another app's share. Verify your exact meeting app and sharing mode before relying on exclusion. [Privacy trace](docs/privacy.md) · [Electron limits](https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable-macos-windows)

Initial shortcuts include Cmd/Ctrl+B for show/hide, Cmd/Ctrl+Enter for Assist, and Cmd/Ctrl+Shift+I for click-through. Settings lists all mappings.

## Optional account service

```sh
npm --prefix server ci
npm --prefix server run build
npm --prefix server start
```

Connect Sync & sharing to `http://127.0.0.1:4319/api/v1`. The service implements accounts/devices, capability-gated verification/recovery with an encrypted email outbox, revisioned sync/conflicts/tombstones, public-link revocation, team/role scopes, knowledge/folders, assignments, encrypted streamed audio attachments, recording/sharing policy, and factual scoped analytics. Uploads are explicit. Credentials, device/capture preferences and privacy settings stay local; a connected account does not silently upload existing history. Disabling stored recordings removes existing recordings for affected members.

Private assigned prompts resolve and execute on the server with operator-configured model credentials. Members receive metadata rather than the prompt; those requests do not fall back to personal keys. Google Calendar, Merge CRM/ATS, OIDC SSO, SCIM and Stripe require operator configuration and authorized real accounts. Writeback requires exact-content preview and explicit queue approval. No external customer write was performed in development validation.

[Service setup](server/README.md) · [Cloud client](docs/cloud-client.md) · [Connectors](docs/connectors.md) · [API contract](server/openapi.json)

## iPhone and Windows

[Watson for iPhone](ios/README.md) is a SwiftUI iOS 17+ project with nearby microphone recording, assistance, notes, modes/references, calendar and account sync. Native/simulator tests and a Swift-to-Node integration test pass. Physical audio, live providers, signing and reachable HTTPS deployment remain gates. Mobile phone/video-call capture and screen-share exclusion are outside the documented mobile scope.

[Windows capture](docs/windows-capture.md) uses isolated Electron microphone/system-loopback streams and PCM worklets. Unit tests and a synthesized-audio Electron smoke pass on macOS. Windows packaging is supported; actual Windows devices/loopback/share compatibility require a Windows host.

## Validate and package

```sh
npm run typecheck
npm test
npm --prefix server test
native/bin/watson-capture --self-test
npm run package:win
```

Package a versioned Mac bundle without replacing the earlier app:

```sh
npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npm exec electron-builder -- --mac dir --config.electronDist=node_modules/electron/dist --config.mac.identity=- --config.directories.output=release/v0.4.0
node tools/verify-package.mjs release/v0.4.0/mac-arm64/Watson.app
```

These are ad-hoc development packages, without notarization or production signed update hosting. The update implementation verifies manifests, artifacts and pinned platform signers before staging; its production configuration is disabled. macOS may request Keychain access after a rebuilt app changes its signature. Rebuild the Swift helper for each target architecture. [Validation](docs/validation.json) records package/runtime evidence and gates. The [desktop smoke](evidence/run-desktop-smoke.mjs) uses a fresh profile, real Electron IPC and a mock Keychain with labeled fixture answers, without recording or paid providers. It does not verify the real OS credential vault. Raw diagnostic logs, profiles, screenshots, and generated packages remain local and are excluded from Git.

## Measure saved real sessions

Use the self-authored English [starter corpus](benchmarks/meeting-corpus-v1.json) and the procedure in [verification](docs/verification.md#measuring-the-stated-corpus). Record each authorized script with the stated source, run a contextual request, then choose **Export JSON** in its saved session. Put the six exports beside a copied corpus manifest and update its recording conditions. The scorer runs locally:

```sh
node --import tsx tools/benchmark-sessions.ts /path/to/corpus.json /path/to/new-report.json
```

The report records word substitutions/deletions/insertions, word-weighted WER, measured first-text/completion percentiles, sample counts, errors/refusals and input hashes. It omits dialogue and answer bodies. Use a new output filename; inputs and existing files are not overwritten. No provider or recording request is made by this scorer. The [controlled fixture report](evidence/performance-fixture-report-v0.4.json) tests the computation only and is not a live accuracy/latency result.
