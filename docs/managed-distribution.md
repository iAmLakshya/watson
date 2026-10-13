# Watson signed updates and managed deployment

Watson has a local signed-update client and a staged installer with rollback. The distribution configuration is disabled until real signing identities, a release-verification key, and an HTTPS feed are supplied. No external feed was published, no developer signing credentials were created, and no installed Watson application was replaced during development.

Watson implements update checks, downloads, staging, and rollback. An application-pinned Ed25519 manifest signature, artifact hashes, and platform signing verification protect the update path. Production distribution remains disabled until release identities and hosting are configured.

## Verification boundaries

[The updater](../electron/updater.ts) verifies the raw signed payload before parsing its release fields. A build pins the allowed Ed25519 public keys, application ID, channel, feed origin, optional CDN origins, Developer ID team, or Windows signing-certificate thumbprint. Artifact URLs require HTTPS, reject credentials and fragments, and cannot introduce new download origins through the manifest. Redirects are rejected. The manifest is bounded, expires, has issue/release-date limits, and cannot replay a lower release than the highest verified version. SemVer comparison handles numeric and prerelease ordering.

The download is streamed into a private temporary file, bounded by its signed size, and checked against SHA-256 before being renamed to a staged archive. ZIP extraction checks central and local filenames, duplicate/case-colliding paths, traversal, reserved filename components, overlapping data ranges, entry counts, total/individual decompressed sizes, and CRC. Files are streamed with independent output limits. macOS framework symlinks are allowed only when they resolve inside the extracted bundle, and no entry may write through a symlink ancestor. The bounded `__MACOSX/Watson.app` AppleDouble records produced by ditto are admitted as metadata and never materialized into the application. Non-metadata files in that subtree are rejected. Windows update archives cannot contain symlinks. Windows ZIPs with files at archive root must be wrapped under the signed `bundlePath` directory before publication; see the wrapper script. ZIP64 and multi-disk archives are rejected explicitly.

macOS candidates must pass deep/strict `codesign` verification, match the pinned Developer ID team and bundle ID, pass a notarized Developer ID Gatekeeper assessment, and carry a valid stapled notarization ticket. Their Info.plist version and executable's Mach-O architecture must match the signed manifest. Windows candidates must have a matching PE architecture and a valid Authenticode signature whose certificate thumbprint and product version match the pinned release metadata. These checks inspect the application; they never launch it. [Apple's notarization documentation](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution), [Microsoft's Authenticode inspection documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-authenticodesignature), and [Node's signature-verification API](https://nodejs.org/api/crypto.html#cryptoverifyalgorithm-data-key-signature-callback) describe the underlying facilities.

## Desktop integration

The main-process service returns the shared [UpdateStatus](../shared/update-types.ts) contract. Commands are `updates:status`, `updates:check`, `updates:stage`, `updates:clear`, and `updates:install`; each accepts no input. Checking, staging, and restart/install are user-triggered. Installation requires a packaged application, a configured trust chain, a verified staged candidate, and no active capture/session, audio test, generation, or cloud work. Main rejects other mutations while preparing installation.

`config/update-config.json` is the development configuration. A packaged build should copy it into Resources as `update-config.json`. An enabled configuration needs a real feed and pinned public key, with platform signing pins. The bundled configuration never contains a private signing key. The service's `restore()` revalidates the signed metadata, archive SHA-256, and native candidate signature before reporting a persisted staged update as ready.

The current configuration reports the missing release-signing and feed requirements directly. Staging keeps the running installation unchanged. A verified staged package remains separate until a closed-app installer or managed deployment applies it.

## Publish a verified release

1. Build and sign Watson on the native target host. On macOS, notarize and staple the application before making its ZIP. On Windows, sign the application and helpers, then build the ZIP and NSIS installer. Keep deployment signing credentials in the release environment.
2. Generate an Ed25519 release key through the organization's existing key-management process. Embed only its public key under an explicit key ID in the build's trusted configuration. Refresh `issuedAt`/`expiresAt` and re-sign the same latest version when its manifest expires; preserve the actual `releasedAt` date. Key rotation requires a build/configuration that already pins the new key.
3. Write a release input JSON with `schemaVersion: 1`, `appId`, `version`, `channel`, `releasedAt`, `issuedAt`, `expiresAt`, and `artifacts`. Each artifact includes `localPath`, HTTPS `url`, `platform`, `architecture`, `format: "zip"`, `bundlePath`, and `signing`. The script computes `size` and `sha256`; do not rely on handwritten values. macOS uses `signing: { type: "developer-id", teamId: "YOURTEAMID" }`. Windows uses `signing: { type: "authenticode", certificateThumbprint: "PINNEDTHUMBPRINT", executable: "Watson.exe" }`.
4. Run the release producer on the native signing/verification host:

   ```sh
   node --import tsx scripts/create-update-release.ts \
     --input release-input.json --output signed-manifest.json \
     --config trusted-update-config.json \
     --key-file /secure/release-private-key.pem --key-id production-2026
   ```

   The producer verifies extracted bundle signing, notarization where applicable, identity, version, and architecture before signing the manifest. It refuses foreign-platform verification. Publish platform-specific manifests from their native CI jobs, or combine only independently verified platform jobs in a separately reviewed release workflow. The script writes a new local output file and never uploads it. The private key is not printed or embedded in the manifest.
5. Upload the exact verified ZIP and signed manifest to the configured HTTPS origins through the release system. Test download, stage, and closed-app replacement on disposable installations for each supported OS/architecture before promoting the feed.

## Apply a staged update after Watson closes

The installer re-verifies the signed stage metadata and archive SHA-256, extracts a fresh candidate beside the target on the same filesystem, and verifies its native signature again. It refuses a running parent PID, a changed base version, a current/rollback bundle whose native signer no longer matches the pinned identity, symlinked targets, mismatching bundle names, downgrades, and simultaneous installer locks. It saves a durable journal, renames the current application to a retained backup, then atomically renames the candidate into place. Each filesystem rename is atomic; the whole pair is journaled because two directory renames are not one indivisible system operation. A failed post-swap verification restores the old bundle. An interrupted old-bundle move can be recovered from its validated journal.

Review a plan without changing the installation:

```sh
node --import tsx scripts/install-watson-update.ts \
  --stage /path/to/user-data/updates/STAGE-ID \
  --target /Applications/Watson.app --current-version 0.1.0 \
  --parent-pid PREVIOUS_WATSON_PID --config trusted-update-config.json
```

After the application is closed, the deployment operator may add `--apply`. The installer preserves the old application as a sibling `.watson-rollback-*` directory and performs no relaunch. The source CLI requires the existing Node/tsx environment. The packaged desktop path instead copies the verified current application into a private helper host and uses that copy of Electron in Node mode, so the installed executable and DLLs can be replaced after Watson closes. It copies the current compiled updater/runner, validates the staged manifest/hash again, and waits for a matching nonce/PID readiness record before the main process may quit. Failed helper startup keeps Watson open. The runner waits for the original PID to exit, applies the verified swap, and relaunches the destination; a failed install restores and verifies the old application before attempting to reopen it. This packaged path is implemented but has not been run against a real signed release.

For an interrupted transaction, inspect its `.watson-update-*.json` journal and pass `--recover /path/to/journal --apply` with the same trusted target, stage, base version, and configuration. Recovery refuses live processes and unexpected journal paths. Keep a missing/invalid backup or unexpected state for manual recovery; do not guess a replacement target.

## macOS MDM package

The read-only plan command is:

```sh
node scripts/managed-release-plan.mjs --platform darwin --version 0.1.0 \
  --bundle release/mac-arm64/Watson.app --output release/Watson-0.1.0.pkg
```

It reports configuration gates and exact commands for validating the application, building a component package for `/Applications`, signing with an existing Developer ID Installer identity, submitting notarization with an existing profile, stapling the package, and checking the package signature. `--execute` is reserved for the native release host after `WATSON_DEVELOPER_ID_INSTALLER` and `WATSON_NOTARY_PROFILE` are configured. The script never creates or changes Keychain credentials. The saved plan (`evidence/update-managed-release-plan.json`, local diagnostic) is a plan, not a built/signed PKG.

An MDM deployment should validate the PKG signature and notarization, inventory the expected bundle ID/version, and schedule replacement while Watson is closed. Distribute the organization's trusted update configuration with pinned public keys through the managed build or a separately protected deployment policy. Do not allow an ordinary renderer setting or arbitrary network manifest to replace trust pins. macOS microphone and screen-recording permissions remain subject to OS/MDM policy; this updater does not change TCC, Keychain, or trust settings.

## Windows managed installer

electron-builder ZIP outputs normally have files at archive root. Wrap the exact candidate into the directory that the updater expects:

```sh
node --import tsx scripts/wrap-windows-update.ts \
  --input Windows-root.zip --output Watson-update.zip --bundle-path Watson
```

The wrapper validates bounded root ZIP structure and streams the original compressed payload bytes into prefixed entries. It never extracts or launches the application. Its output is a new unsigned manifest candidate; native Authenticode verification and signed manifest production must still run on Windows. Do not reuse the old ZIP's size or SHA-256 after wrapping. [A fixture is independently read back with Python's ZIP parser](../tests/updater.test.ts).

Run the corresponding plan on Windows with `--platform win32`; it builds signed NSIS and ZIP outputs using the already installed electron-builder CLI. `CSC_LINK` and `CSC_KEY_PASSWORD` must supply existing signing credentials. The plan does not install dependencies or publish releases. Verify Authenticode on the resulting installer and application, deploy through the organization's software-management tool during a maintenance window, and inventory `Watson.exe` product version. Windows native signing, installer execution, and update replacement have not been tested on this macOS host.

## Validation and remaining gates

[The updater tests](../tests/updater.test.ts) use disposable ZIP packages, ephemeral Ed25519 keypairs, injected HTTP responses, and a fixture verifier. They exercise signed-payload tampering, unknown keys, origins, dates, signer pins, version/architecture selection, replay, download corruption, redirects, concurrency, persisted stage tampering, ZIP traversal/types/collision/symlink/CRC cases, closed-app replacement, retained rollback, post-swap failure, and interrupted-install recovery. The fixture verifier is deliberately not a real Developer ID or Authenticode signature. No test uses the user's running bundle or real signing credentials.

Real signed/notarized releases, an external feed, Windows verification on Windows, MDM enrollment/deployment, and the real packaged quit/install/relaunch path remain unverified or unconfigured. A green fixture test does not remove these release gates.

The [published validation snapshot](validation.json) summarizes completed checks. Detailed diagnostic files named above are retained locally and excluded from Git.
