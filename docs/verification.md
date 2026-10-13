# Watson verification and remaining acceptance gates

Version 0.4 has desktop GUI/IPC/persistence validation, actual selected-default Mac microphone PCM, HTTP/SQLite cloud/connector fixtures, and native/simulator iOS checks. It includes Smart reasoning routing, structured memory, opted-in meeting detection and preparation, organization analytics, account recovery, private audio transfer, guided tutorials, and signed-update infrastructure. The [progress report](progress.md) and [validation snapshot](validation.json) describe the completed scope; live provider quality and production acceptance remain separate checks.

## Live capture and contextual response

1. Launch the packaged Watson app on a Mac with an accessible display. Configure provider credentials in Settings and grant Microphone and Screen & System Audio Recording permissions.
2. Start a live session. Confirm capture transitions from connecting to capturing; speak into the microphone and play audio from a meeting or another application. Check that the transcript identifies the two sources independently and updates provisional text before final text.
3. Pause and verify that transcription stops, then resume and verify that new text is captured without duplicating earlier text. Stop and verify that no helper or transcription connection remains active.
4. Put a distinctive fact on the chosen display that was not spoken. Ask Watson about it. Confirm a fresh screen timestamp and a grounded response; change the fact and repeat to detect stale screenshot context.
5. Import a document containing a distinctive fact. Attach it to a custom mode. Ask a relevant question and verify that the answer cites that document. Ask about a previous session and verify the history reference.
6. Trigger assistance while a question is still being spoken; inspect whether provisional transcript context helps. Measure first-text latency, complete-answer latency, and transcript delay over multiple sessions. Desktop and iPhone show first answer text and completion separately. These start at application acceptance, include context/screen preparation, and stop at publishable text or completed output. They do not measure screen paint, audio-input delay, or provider-internal first-token generation. Legacy timings are not substituted.
7. Test Smart on a complex coding request and confirm the separately configured model/effort/budget is used. Test web research on a question requiring current information; open its citations and verify support. Repeat with web research disabled. Generate notes and a follow-up draft and compare them to the actual transcript, including the beginning of a long meeting.
8. Disable individual capture inputs and screen context. Verify that disabled inputs are absent from provider requests. Test microphone-only capture without granting screen permissions.

## Receiver-side screen sharing check

1. Confirm the default-enabled exclusion control and show the overlay. Use a second device or participant to view the actual shared output. The user confirmed their current Google Meet setup works; record broader compatibility separately.
2. Test each supported conferencing app and both application-window and entire-display share modes separately. Record OS/app versions, the exact capture setting, and whether the overlay is visible at the receiver.
3. Repeat while moving, resizing, generating, showing/hiding, changing opacity, and opening settings. Check recordings separately from live sharing.
4. Repeat with protection disabled to validate the test can detect the overlay. A self-capture that excludes Watson by its own filter is insufficient evidence for another app's behavior.
5. On newer macOS ScreenCaptureKit capture paths, expect Electron's protection to be insufficient. Record the limitation and use a supported share mode or hide the overlay. Do not label unsupported paths as invisible.

## Packaging and persistence

Open the `.app`, start a labelled demo, change a mode and setting, create/edit/pin/export a session, quit, and reopen. Confirm content and settings survive; provider keys must never appear in renderer state or exported session JSON. Test malformed IPC payloads, unauthorized origins, provider disconnections, capture failures, cancellation, and stop/resume transitions. Validate signed/notarized updates on a real release identity before claiming distributable automatic updates.

## Remaining full-product work

Windows capture, the iPhone project, cloud sync/public sharing, Google OAuth, organization/team access, SSO/SCIM, scoped knowledge, CRM/ATS, coaching and analytics have source and relevant fixture evidence. Actual Windows/physical iPhone devices, real Google/Merge/identity/billing/email tenants, hosted cross-device UI and provider quality still need acceptance evidence. Opted-in conferencing start/end and scheduled participant/company research have implementation and protocol evidence; actual conferencing accuracy and real identity/source matching remain open. The Mac metadata proof samples an owned microphone fixture, and the Windows C#5/.NET4.8 compile verifies language/API shape rather than Windows COM execution. Production signer/notarization/feed/installed update and managed-device rollout remain gates. Interactive guides exist; actual staffed support channels, independent security audit and equivalent contractual service guarantees remain incomplete.

For private audio, verify explicit consent and final review before uploading, compare exported bytes, and confirm public note links omit the attachment. Policy revocation removes recordings rather than retaining inaccessible bytes. The actual GUI and native iOS service fixtures use synthetic audio and temporary encrypted storage; they do not record a real meeting.

## Measuring the stated corpus

The checked-in `benchmarks/meeting-corpus-v1.json` is a six-case, self-authored English template with microphone and system sources. It contains scripts, not recorded results. Copy it to a dedicated directory. Before recording, describe actual speaker count/accents, microphone or playback, noise, OS/app version, selected capture inputs, transcription/model/Smart settings and network conditions in its `description`. Keep microphone and system tests separate. Do not call this quiet starter corpus representative of every meeting or language.

1. After live providers and the intended capture permissions are configured, start a distinct non-demo session for each script. Read it into the selected microphone or play an authorized recording into the selected system input. Allow finalized transcription to arrive.
2. Ask one relevant contextual question in each session and wait for completion. Check the answer against the script separately: WER scores transcription rather than factual model grounding.
3. End the session and use **Export JSON**. Save each file under the relative name specified in the copied corpus. Exports must stay inside that corpus directory, including resolved symlink paths.
4. Run `node --import tsx tools/benchmark-sessions.ts /path/to/corpus.json /path/to/new-report.json`. The output must not already exist. Compare its input hashes with the exports used for review.
5. Inspect S/D/I counts, reference word counts, WER, p50/p95/p99 and sample counts. Missing timing remains null; errors/refusals are counted separately. Repeat enough times and state the conditions before publishing an accuracy or latency claim. Measure acoustic/transcription delay separately; this report cannot derive it from historical line timestamps.

Normalization uses NFKC, Unicode lowercase and normalized apostrophes; punctuation delimits tokens. Numbers are not expanded and semantic equivalents are not substituted. Alignment uses unit costs and a deterministic tie order; it does not reproduce every weighted/optional-word mode of [NIST SCTK](https://github.com/usnistgov/SCTK/blob/master/doc/sclite.htm). WER is `(substitutions + deletions + insertions) / reference words`, can exceed100%, and is not reported as a clipped “accuracy” score.

New desktop/iPhone responses use `latencyScope: application-request`. First-text timing excludes empty deltas, setup notices and hidden summary passes. Final-only validated output is timed when it becomes publishable. Standardized analytics include only usable completed, non-refused answers with that scope and report measured sample counts. Legacy `latencyMs` alone can represent different historical definitions; it remains an explicitly legacy value. [Official OpenAI latency guidance](https://developers.openai.com/api/docs/guides/latency-optimization) explains why streaming progress matters; no timing from a fixture establishes provider speed.

The CLI sends nothing to a provider and prints no raw dialogue. `measurementClass: live` rejects demo or unknown-demo inputs; `fixture` is explicit. Input origin and configuration are operator attestations, not independently proven by arbitrary JSON. The controlled six-case fixture is labeled accordingly. Live corpus recording/scoring, receiver-side capture compatibility and real contextual answer quality remain acceptance gates.
