# Watson local cloud service

A real, locally runnable HTTP service with transactional SQLite persistence. The desktop and iOS clients can use the same account, private meeting history and resource revisions. This service is not deployed or connected to live identity/payment providers by default.

```sh
cd server
npm ci
npm run build
npm start
# Development without a compilation step:
npm run dev
# Verification:
npm run typecheck
npm test
```

Requires Node 24 or later. Validated using Node **24.11.1**; `node:sqlite` prints its experimental API notice on this version. It uses prepared statements, foreign keys, WAL, a 5-second busy timeout and explicit transactions. Dependencies in this package are build-time only. The Node [SQLite documentation](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) and [scrypt documentation](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback) are the primary API references.

Configuration is through environment variables, without editing host settings:

| Variable | Default | Meaning |
| --- | --- | --- |
| `WATSON_HOST` | `127.0.0.1` | Listen interface. Default is loopback. |
| `WATSON_PORT` | `4319` | HTTP port. |
| `WATSON_DB_PATH` | `server/data/watson.sqlite` | Persistent SQLite file. |
| `WATSON_PUBLIC_ORIGIN` | Calculated listening origin | Origin used in share URLs; set to an approved HTTPS origin behind a TLS proxy when deploying. |
| `WATSON_ALLOWED_ORIGINS` | `http://127.0.0.1:5173,http://localhost:5173,watson://desktop` | Comma separated browser CORS allowlist. Native HTTP clients omit Origin. |

Base URL: `http://127.0.0.1:4319/api/v1`. JSON request bodies use `Content-Type: application/json`. Authenticated endpoints require `Authorization: Bearer <token>`. Errors are `{error:{code,message,details?}}`. The checked-in [OpenAPI contract](openapi.json) describes all implemented routes.

## Accounts and devices

`POST /auth/signup` and `POST /auth/login` accept `{email,password,name?,deviceName?}` and return `{token,expiresAt,user,device}`. Signup passwords require 12 characters. Passwords use scrypt with independent random 128-bit salts (`N=32768,r=8,p=1`) and 64-byte derived keys. Bearer sessions have random 256-bit tokens and a 30-day expiry; SQLite stores only their SHA-256 digests. Login always performs scrypt, including for unknown addresses. Auth requests are rate limited per client IP.

`GET /me` returns `{user,devices,organizations,policy}`. `PATCH /me` accepts `{name?,email?,currentPassword?}`; email changes require password reauthentication. `POST /me/password {currentPassword,newPassword,deviceName?}` revokes every prior session and returns a fresh auth result. `POST /auth/logout` revokes the current session. `DELETE /devices/:id` revokes that device and its sessions.

`DELETE /me {currentPassword}` deletes private resources, sync history, usage, devices, sessions, shares and memberships. Sole-member organizations are removed. An admin in a multi-member organization must assign another admin first. Deleted users cannot leave an organization without an admin. Auth responses and exports never include password hashes or token digests.

## Meeting history and public links

`GET /meetings?q=` returns `{meetings:[{id,revision,meeting,updatedAt}]}`. `POST /meetings {meeting,expectedRevision?:0}` creates revision 1. `GET /meetings/:id` returns its envelope. `PUT /meetings/:id {meeting,expectedRevision}` replaces it only when the current revision matches. `DELETE /meetings/:id {expectedRevision}` deletes it and emits a tombstone. Meeting objects use the desktop Session fields, with transcript, answers, notes, action items and followup drafts. `/meetings/:id/export` returns the owner's JSON.

`POST /meetings/:id/share {expiresInDays?:30}` returns `{token,url,viewerUrl,expiresAt}`. The default link lasts 30 days, with a maximum of 365. `viewerUrl` in the response opens a readable Watson meeting page; `url` remains the JSON endpoint. Creating a new link invalidates the previous one. `DELETE /meetings/:id/share` revokes immediately. `GET /public/shares/:token` needs no account and returns only title, timestamps, notes, actions, followup draft and transcript text/source/timestamp/speaker. It never returns account identifiers, answers, private document references, recordings, provider keys, internal settings or credentials. Tokens are hashed at rest. Deleted or expired meetings/shares return 404.

Small legacy audio uploads may use `meeting.recording:{contentType,base64,filename?}` with `meeting.consentConfirmed:true`. Supported types are audio/wav, webm, mp4, mpeg and ogg; base64 payload maximum is 3,000,000 characters. `GET /meetings/:id/recording` streams that owner's audio. Public links exclude audio. For larger recordings, use the raw streaming attachment routes below; audio is never part of normal sync or public shares.

## Synchronization

Use the returned `device.id`. Keep a separate cursor per account/backend in local storage and the bearer in the OS secure credential store. Canonical shared settings ID is `preferences`.

```json
{
  "deviceId": "device UUID",
  "cursor": 0,
  "changes": [
    {
      "entity": "meeting",
      "id": "local session UUID",
      "expectedRevision": 0,
      "changeId": "optional persistent mutation UUID",
      "data": {"id":"local session UUID","title":"Customer call","startedAt":"2026-10-12T10:00:00Z","transcript":[],"answers":[],"notes":""}
    }
  ]
}
```

`POST /sync` accepts at most 100 mutations and returns:

```json
{
  "cursor": 42,
  "changes": [{"sequence":42,"entity":"meeting","id":"...","revision":2,"data":{},"deleted":false,"updatedAt":"..."}],
  "applied": [{"id":"...","entity":"meeting","revision":2,"scope":"personal","data":{}}],
  "conflicts": [{"id":"...","entity":"meeting","code":"revision_conflict","current":{"revision":3,"data":{}}}],
  "shared": [],
  "policy": {"retentionDays":365,"recordingAllowed":true,"publicSharingAllowed":true}
}
```

Entities are `meeting`, `knowledge`, `mode`, `calendar`, `settings`, `folder`, `person`, `scorecard`. `expectedRevision:0` means create; edits and deletes require the observed revision. `data:null` deletes. Revision conflicts are returned visibly and preserve the server version. A replay of the same `changeId` and payload returns its original result; reusing the ID for different data fails. Invalid input rolls back the batch; revision conflicts leave independent valid mutations applied. Apply changes in sequence order, then save the response cursor. Tombstones must delete local records. Deletion erases historical change payloads and mutation-cache payloads for that resource.

Settings data merges provided allowed fields into the existing object, guarded by the same revision check. This preserves desktop fields when mobile updates common fields. Provider credentials, encrypted key blobs, access tokens, password fields and backend origins are rejected. Unknown top-level resource fields fail validation, so a desktop credential vault cannot enter a cloud export accidentally.

Private change logs belong only to that account. `shared` is an authoritative snapshot of every currently accessible shared knowledge/folder/mode resource. Replace the previous shared cache on each successful sync, so removal from a team removes access locally. Sync does not mutate organization resources; use the explicit resource endpoints below.

## Organizations, teams and shared context

`POST /organizations {name}` makes the creator an admin. `GET /organizations` lists joined organizations. `GET/PATCH/DELETE /organizations/:id` read/manage the organization. Admins add already-registered users with `POST /organizations/:id/members {email,role}`; roles are admin, manager, member. `GET /members` lists them, and `PATCH/DELETE /members/:userId` changes/removes membership. An organization must retain at least one admin.

`GET/POST /organizations/:id/teams` lists/creates teams. An organization manager may create teams and becomes that team's manager. `PATCH /teams/:teamId {name}` renames and `DELETE` removes. `GET/POST /teams/:teamId/members` lists/adds team users (`{userId,role:'manager'|'member'}`). `PATCH/DELETE /members/:userId` changes/removes team membership. A user may belong to several teams at once. Organization admins see all teams; other users see only their joined teams. Team managers can manage that team's members and shared resources. Organization managers cannot read arbitrary teams without membership.

`GET /resources?entity=knowledge|mode|folder&scope=personal|org|team&orgId=&teamId=&q=` always filters by the caller's ACL. `POST /resources/:entity {data,scope,orgId?,teamId?,expectedRevision?:0}` creates a resource; `GET/PUT/DELETE /resources/:entity/:id` reads/updates/deletes with revision checks. Sharing scope is immutable. Organization-wide knowledge/folder writes require admin/manager. Organization-wide prompt management requires an org admin. Team knowledge writes require a team manager or organization admin. Team prompt management/visibility requires that team’s manager or an organization admin; ordinary members cannot list arbitrary team prompts. Private meetings/calendar/settings/people cannot be placed in an organization scope.

Knowledge data uses `{id,title,text,addedAt?,size?,fileType?,folderId?,tags?}`. Folder data uses `{id,name,parentId?}`. Mode data uses `{id,name,instructions,noteTemplate?,documentIds?,builtIn?,assigned?,folderId?}`. Team/org prompts are scoped modes; `assigned:true` is retained as optional legacy metadata. Actual prompt assignment uses the per-user endpoints below. Person data uses `{id,name,email?,company?,role?,notes?,createdAt?,updatedAt?}`. Scorecard data uses `{id,name,instructions,criteria:[{id,name,description,maxScore,weight}]}`. People remain personal. Scorecards may be personal or scoped to an organization/team. Session attendee IDs, commitments, coaching and factual usage; Mode email templates/custom actions; and calendar attendee/source metadata roundtrip unchanged. Person/scorecard references are preserved without requiring both records to be uploaded together.

A shared resource may reference only documents/folders accessible in its shared scope; org modes cannot accidentally cite one team's private files.

`GET /context?q=&modeId=` returns accessible `documents`, `modes`, and `folders`, with `connectedDocuments` for permitted Merge facts and `people` for connector matches; selecting a mode limits documents to its assigned `documentIds`. Members cannot retrieve another team's prompt or document even by guessing its ID.

`GET /organizations/:orgId/assignments?teamId=` lists assignments for org admins, or managed-team members for team managers. `PUT /organizations/:orgId/assignments/:userId {modeId:string|null}` assigns/clears a prompt. Exactly one prompt is assigned per user across teams; a new assignment replaces the previous one transactionally. Team managers can assign only a managed-team prompt to a member of that team. Assignments from other teams appear Unassigned in their team’s view. `GET /assigned-mode` returns `{mode:metadata|null}`, and `/sync` adds `assignedMode:metadata|null` separately from its generic shared resource listing. The metadata contains `inference:"server"` and only the mode ID/name plus custom action IDs/names/types. It excludes instructions, document IDs, templates and custom action bodies. The hidden prompt executes on the server, described below; hiding an editor alone is not the ACL boundary. Removing team/org membership or deleting the prompt clears access.

## Policy, analytics and audit

`GET /policy` is the strictest effective policy across all of the user's organizations. `GET/PUT /organizations/:id/policy` reads/updates `{retentionDays,recordingAllowed,publicSharingAllowed}`; only admins write. Default retention is 365 days. A policy change sweeps immediately, and a sweep repeats once per minute and before meeting/sync reads. Expired meeting data becomes tombstones and historical payloads are erased. Disallowing recording removes retained audio and rejects new uploads. Disallowing public sharing revokes existing links and blocks new ones. Policies also apply to private records uploaded by joined members, rather than relying only on UI settings.

`POST /usage {id?,kind,amount,orgId?,metadata?}` records idempotent client-reported usage for assist, transcription_seconds, meeting_seconds, screen_capture, import, or export. Amounts and metadata size are bounded. `GET /usage?from=&to=` aggregates only that user's persisted events. `GET /organizations/:id/usage` is a legacy admin-only route with redacted metadata and requires an org admin and aggregates events explicitly associated with that org. These are client-reported facts, not provider invoices or invented costs. `GET /organizations/:id/audit` requires an admin and returns the latest 1000 persisted organization mutations. `GET /export` includes the account, accessible resources and own recorded usage.

## Scoped organization analytics

`GET /organizations/:orgId/analytics?from=&to=&teamId=&userId=&includeDemo=false` returns factual `summary`, UTC-date `series`, `byMember`, `byTeam`, `byMode`, `features`, `adoption`, separate `usageEvents`, `allowedFilters`, `dateRange`, `missingMeasurements`, and `source` provenance. Date-only filters use UTC start/end of day; ISO timestamps are supported. `GET /organizations/:orgId/analytics/export` returns `{filename,csv}` using exactly the same permissions/filters and spreadsheet formula neutralization.

Org admins may report across the org. Team managers see only members of their currently managed teams and attributable work in those teams. Ordinary members see only their own measurements. Explicit team/user filters outside the caller’s current scope fail. Personal sessions are attributed only by an explicit `meeting.organizationId` (checked against membership on upload) or a real shared/assigned mode belonging to the org. An explicit org ID takes precedence over a conflicting mode. Unrelated private meetings are excluded, rather than attributed to every organization the owner has joined.

Metrics include session/live/demo counts, actual reported capture/audio sample durations, provider request/token counts, screenshot/reference/answer counts, measured answer latency, and reported Watson coaching scores. Empty known samples have zero counts; absent legacy metrics are null, with missing-measurement counts/reasons. Uploaded session telemetry and persisted usage events remain separate to prevent double-counting. Current overlapping team memberships can contribute to more than one team row, while the overall summary counts each session/event once. Team-specific server-assistant events carry the actual assigned team and mode; old events without team provenance are excluded from team-manager reports.

Adoption means at least one attributable uploaded session or scoped usage event within the selected range. `lastSeenAt` comes from authenticated server requests; app-open time/version and calendar coverage are unknown. The service provides no invented ROI or proprietary composite usage score. Reports exclude all meeting titles/notes/transcript/answer text, coaching prose, prompt bodies and credentials.

## Email verification and password recovery

`GET /auth/capabilities` reports `{emailDeliveryConfigured,verificationRequired:false,passwordRecoveryConfigured}`. Account profiles add `emailVerified` and nullable `emailVerifiedAt`. An authenticated `POST /me/email-verification {}` returns HTTP 202 and queues a one-time link for the current account email. `POST /auth/email-verification/confirm {token}` confirms it. Verification email delivery is never automatically triggered by signup or a read-only capability request.

Public `POST /auth/password-reset/request {email}` returns the same HTTP 202 shape/message for known and unknown valid addresses. `POST /auth/password-reset/confirm {token,newPassword}` consumes the link, changes the password, verifies the email and revokes every prior session. The user must sign in again. Missing configured transport is an explicit 503 for every address. Invalid/expired/used tokens have the same error. Address/account/IP rate limits apply before issuing or consuming actions. Password changes and email changes invalidate outstanding actions; changing an address resets verification.

Links point to the operator’s configured public origin and usable browser forms. GET displays the form without consuming the token, so email scanners cannot silently complete an action. Explicit POST confirms; the browser then receives a readable completion page. The JSON confirmation API is available for API clients; the shipped account controls use the browser link flow. No token is returned in the request response, profile, sync or export.

Tokens are random 256-bit values, hashed at rest, valid for 30 minutes and one use. Durable email outbox bodies are AES-256-GCM encrypted under `WATSON_SECRET_KEY`; token text is removed after delivery/cancellation/final failure. Configure `WATSON_EMAIL_FROM` and either `WATSON_EMAIL_API_KEY`/optional `WATSON_EMAIL_API_URL` or `WATSON_SMTP_HOST`/port/user/password. The JSON transport uses the [Resend-compatible send-email contract](https://resend.com/docs/api-reference/emails/send-email). SMTP uses mandatory TLS/certificate validation in ordinary runtime, with AUTH PLAIN over TLS, a MIME base64 text body and stable Message-ID. API retries use an idempotency key; retries are bounded, and a process-interrupted uncertain send is not blindly resent. Protocol references: [SMTP RFC 5321](https://www.rfc-editor.org/rfc/rfc5321.html), [SMTP AUTH RFC 4954](https://www.rfc-editor.org/rfc/rfc4954.html).

Six integration scenarios deliver only to local HTTP/SMTP fixtures, never real email providers/recipients. Live domain/sender/provider delivery remains a separate gate.

## Large private audio attachments

`GET /recordings/capabilities` returns `{configured,maxBytes,supportedContentTypes,recordingAllowed,consentRequired:true,attachmentsPerMeeting:1}` without exposing keys, directories or tokens. There is one cloud attachment per meeting; clients explicitly choose a segment and consent to replacement while preserving all local segments. CAF MIME types audio/x-caf and audio/caf are accepted as opaque storage; the service does not transcode. An owned uploaded meeting can receive raw binary audio through `PUT /meetings/:id/recording`, with an audio MIME type, `X-Watson-Expected-Revision`, `X-Watson-Recording-Consent:true`, and optional percent-encoded `X-Watson-Filename`. Validated recording uploads have a 300-second absolute body deadline, matching native client upload limits; ordinary requests retain a 30-second body deadline and headers retain a 10-second limit. The longer window is granted only after authentication, ownership, policy, consent, revision, MIME and size checks. An actual delayed-upload/slow-JSON regression verifies the distinct deadlines. The default request limit is 128 MiB and can be configured with `WATSON_RECORDING_MAX_BYTES`. `WATSON_RECORDING_DIR` chooses private local storage; `WATSON_RECORDING_KEY` is a base64 32-byte key outside SQLite (defaults to `WATSON_SECRET_KEY`). Missing key/storage configuration is an explicit 503. Filename headers are display metadata; disk names are generated IDs.

The response is `{recording:{id,contentType,size,sha256,filename?,createdAt,ownerOnly:true,encryptedAtRest:true},revision}`. Upload increments the meeting revision; clients must refresh their revision binding. The server writes authenticated 64 KiB AES-256-GCM chunks with independently random nonces and a per-file HKDF-derived key. Ownership/meeting/chunk identity are bound as authenticated data. Each chunk is authenticated before playback bytes are sent; the entire upload is never buffered in memory. Stored files are ciphertext.

`GET /meetings/:id/recording/info` returns owner-only metadata. `GET /recording` and `HEAD /recording` support normal retrieval and one authenticated byte range (206). `DELETE /recording {expectedRevision}` removes it and increments the meeting revision. Public links and ordinary sync never expose attachment bytes, encryption keys/salt, storage paths or an unauthenticated media URL. Recording policy/retention changes and meeting/account deletion remove metadata and files. Access is rechecked during transfer; revision conflicts or failed uploads cannot replace the current attachment. Old crashed, unregistered ciphertext uploads are cleaned after a grace period.

Seven real HTTP/file scenarios transfer more than 4 MiB, prove exact full/range reads, check ciphertext/integrity, and exercise foreign access, share exclusion, revision/size guards and policy/deletion/retention cleanup. Live object-storage hosting and mobile/desktop attachment UI still have separate validation gates.

## Server execution for hidden assigned prompts

Personal BYO model keys remain desktop-local by default. Organization admins/team managers may assign hidden prompts, which require an operator-controlled server model. Set `WATSON_ASSISTANT_OPENAI_KEY` and `WATSON_ASSISTANT_MODEL` in the server process environment to enable this route. No client may provide a provider key, endpoint, model ID or system prompt. With either configuration missing, generation returns an explicit HTTP 503; a client must not fall back to a local prompt because it never receives the hidden instructions. `GET /assistant/status` returns configuration status and metadata only.

`POST /assistant` accepts `{kind,question?,transcript?,sessionId?,screen?,answers?,outputLanguage?,actionId?,scope?,calendarEventId?,scorecardId?,requestId?,sessionContext?,smart?,webResearch?,researchOnly?}`. Tasks are assist, say, followup, recap, chat, notes, email, brief, custom and coaching. Supplied session/calendar/scorecard IDs are checked against the caller’s real resource ACL. Live transcript and screen context are bounded transient inputs. The server reads the caller’s sole assigned prompt, authorized referenced knowledge, permitted connector facts and own history, and chooses its configured model. Notes/email/custom tasks read hidden templates/action prompts privately. Scorecards remain subject to their resource ACL. Input is bounded, and user language is a language tag rather than arbitrary instructions.

Managed Smart uses its own operator `WATSON_ASSISTANT_SMART_MODEL`, `WATSON_ASSISTANT_SMART_REASONING_EFFORT` (default high), and `WATSON_ASSISTANT_SMART_MAX_OUTPUT_TOKENS` (default25000). `smart:true` sends a Responses request with `reasoning.effort` and `max_output_tokens`; it never switches to the normal model or accepts member model/effort/budget/key overrides. `webResearch:false` omits all web tools and tool choices while preserving reasoning. Operator `WATSON_ASSISTANT_SMART_WEB_SEARCH=false` disables web permission. Smart with web enabled emits `event:source` citations and final sources.

Sourced calendar preparation is a separate `researchOnly:true,kind:brief,scope:calendar,webResearch:true` intent. It uses `WATSON_ASSISTANT_WEB_MODEL` with a required hosted web tool, without reasoning parameters, so a non-reasoning model such as GPT-4.1 can research. A missing web citation is an explicit error. Coaching remains transcript-only. Ordinary assistance continues using the normal configured model with no Smart parameters.

`GET /assistant/status` exposes separate normal/web/Smart configuration, operator model/effort/budget, web policy, `smartModelSupport`, `smartConfigurationError` and `smartReasoningEnabled`. Known non-reasoning Smart models and incompatible known efforts are blocked before the provider request. Unknown custom model compatibility is labeled unknown; an upstream rejection is surfaced without a fallback or raw provider error body. An operator who explicitly chooses supported effort none disables reasoning, which the status reports. These are configuration/capability declarations, not proof of a live model account. Sources: [official reasoning guidance](https://developers.openai.com/api/docs/guides/reasoning), [GPT-5.4 Mini effort support](https://developers.openai.com/api/docs/models/gpt-5.4-mini), [GPT-6.1 Sol effort support](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [web search contract](https://developers.openai.com/api/docs/guides/tools-web-search).

The server makes a streaming Chat Completions request with `store:false` and exposes its own SSE events:

```text
event: start
data: {"requestId":"...","mode":{"id":"...","name":"Assigned coach"},"sources":[]}

event: delta
data: {"text":"Answer fragment"}

event: done
data: {"text":"Full answer","sources":[],"usage":{"inputTokens":123,"outputTokens":8},"latencyMs":120,"refused":false}
```

Provider refusal events (canonical Responses `response.refusal.delta`/final refusal content and Chat `delta.refusal`/`message.refusal`) produce `done.refused:true` with display-only text. Raw refusal text is replaced by a generic decline so it cannot quote operator credentials or hidden prompt bodies. Refused coaching is not validated or returned as an assessment; refused preparation is not treated as sourced facts. Clients must preserve existing notes/email/brief/coaching content rather than overwriting it with the decline. Normal completions include `refused:false`.

An interrupted/failed stream emits `event:error` with `{code,message}`. Client disconnect aborts the provider request; membership, assignment, prompt revision and bearer validity are rechecked as chunks arrive, so revocation halts output. At most two concurrent requests and 30 requests/minute per user are allowed. Provider raw chunks, stored prompts and credentials are never proxied back. Recorded server usage uses actual returned token counts, when present.

`sessionContext` may supply transient `{id?,title,notes?,actions?,followupDraft?,attendees?:string[]}` for current unsynced context. It never changes stored resource ownership; an explicit `sessionId` still requires a stored owned meeting. `POST /assistant/action-link {actionId,question?,sessionId?,sessionContext?,transcript?}` returns `{url}` from the assigned hidden link template. Variable values are URL-encoded; substitutions cannot change the authority, and resolved links require HTTPS without credentials. This route does not need an operator model. Managed coaching uses the configured accessible scorecard, strict structured-output schema and exact finalized transcript quote validation before any coaching score reaches the client. Desktop validation independently repeats this check.

Twelve real HTTP provider-spy tests prove the API boundary: the provider receives the hidden assigned prompt and permitted context; member sync/context/export/status endpoints do not return prompt bodies/templates/document IDs; outsider IDs and member provider/model overrides fail; revocation stops an active stream; missing operator configuration is explicit. These protocol fixtures do not prove a live model cannot be induced to paraphrase/reveal its system prompt. Adversarial model-output evaluation and live-provider quality/latency remain open. Primary source: [official OpenAI streaming documentation](https://developers.openai.com/api/docs/guides/streaming-responses).

## Enterprise SSO, directory and billing adapters

`WATSON_SECRET_KEY` is a base64 encoded 32-byte encryption key kept outside SQLite. `WATSON_OIDC_PROVIDERS_JSON` is an array of operator-configured providers, for example:

```json
[{"id":"company","orgId":"existing Watson organization UUID","issuer":"https://identity.example.com","clientId":"registered client ID","clientSecretEnv":"WATSON_COMPANY_CLIENT_SECRET","domains":["example.com"],"autoProvision":false}]
```

Provider URLs require HTTPS in ordinary runtime. The provider redirect URI defaults to `<WATSON_PUBLIC_ORIGIN>/api/v1/auth/sso/callback`. A provider may supply `redirectUri` explicitly. Client secrets come from the named server environment variable and never appear in org settings/export. `GET /organizations/:id/sso` is admin-only and returns public provider metadata.

`POST /auth/sso/start {providerId,deviceName?}` returns `{authorizationUrl,requestId,requestSecret,expiresAt}`. Open authorizationUrl in the browser and poll `POST /auth/sso/poll {requestId,requestSecret}`. While pending, poll returns HTTP 202 `{pending:true}`; after a validated provider callback it returns the normal `{token,expiresAt,user,device}` once. Authenticated start may link the signed-in password account. Existing password accounts are not silently linked by matching email; SCIM provisioned users may sign in to the configured provider. New identities require the configured allowed domain, verified email and explicit `autoProvision:true`. Existing deprovisioned identities cannot regain org access by signing in.

OIDC performs discovery, authorization-code exchange, S256 PKCE, a one-use state, nonce validation, RS256/ES256 signature validation against provider JWKS, issuer/audience/azp/time/verified-email checks, and stable issuer+subject identity mapping. Optional operator-configured `roleClaim`/`roleTeams` map verified SSO user roles to default teams and prompts. The mapping acts only when the user is first added to that team, so subsequent logins preserve manual assignments. Temporary PKCE values and the final auth handoff are AES-256-GCM encrypted. State/poll secrets are hashed. The callback displays a completion page and exposes no auth token. Password-account linking is tested separately from new identity provisioning. [OpenID Connect Core ID-token validation](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation) is the primary reference.

`GET /organizations/:id/directory` shows SCIM status/base URL. Admin `POST /organizations/:id/directory/token {}` rotates a distinct scoped bearer and returns `{token,baseUrl}` once; `DELETE` revokes it. The `/scim/v2/:orgId` API implements Users and Groups create/read/list/filter/pagination/replace/PATCH/delete, ServiceProviderConfig, ResourceTypes and schema discovery. Use application/scim+json; responses use SCIM resource/list/error envelopes. Equality filters support userName, externalId, displayName and id. Bulk/sort/ETag/password provisioning are explicitly unsupported. Groups map to real Watson teams; users can join multiple groups. Deactivation removes org/team access and revokes that user's bearer sessions; it preserves private personal data. Last-admin protection remains enforced. The protocol scope follows [SCIM RFC 7644](https://www.rfc-editor.org/rfc/rfc7644).

Stripe configuration uses `WATSON_STRIPE_SECRET_KEY`, `WATSON_STRIPE_WEBHOOK_SECRET`, comma-separated `WATSON_STRIPE_PRICE_IDS`, `WATSON_BILLING_SUCCESS_URL`, and `WATSON_BILLING_CANCEL_URL`. HTTP requests pin `Stripe-Version:2026-09-30.endive` by default (`WATSON_STRIPE_API_VERSION` may override); configure the registered webhook endpoint to the same version. This version was checked against [Stripe’s versioning reference](https://docs.stripe.com/api/versioning) on 2026-10-12. Success/cancel URLs are operator configured, rather than accepting a redirect supplied by the client. `GET /billing` shows own configured prices, subscription/entitlement and received invoice facts. `POST /billing/checkout {priceId,seats?}` creates a customer and a subscription Checkout session through Stripe; `POST /billing/portal {}` creates the owner customer portal link. Requests accept only configured price IDs.

`POST /billing/webhook` verifies the HMAC of the untouched raw request body against Stripe-Signature, enforces a five minute timestamp tolerance and deduplicates event IDs transactionally. Only a known customer mapping may affect a user's subscription. Subscription created/updated/deleted events persist status, price, seats and billing period. Invoice events retain the received amount/currency, without inventing usage costs. Entitlement is derived only from verified active/trialing subscription state. Sources: [Stripe Checkout creation](https://docs.stripe.com/api/checkout/sessions/create) and [webhook signature validation](https://docs.stripe.com/webhooks/signature).

Google Calendar, live URL knowledge and Merge CRM/ATS connectors are mounted; a background worker polls only sources explicitly enabled for auto sync and drains before shutdown. Queued writebacks already require explicit confirmation and recheck the requester’s role at execution. The connectors are mounted through [the connectors module](src/connectors/README.md). AI provider API keys remain desktop-only. Connector/OIDC service credentials are separately configured server integration secrets; they never enter personal sync/export/public shares.

## Verification and remaining gates

`npm test` launches real HTTP servers on ephemeral loopback ports, real temporary SQLite files and multiple users/devices. The full server suite currently has 64 integration tests (22 core/enterprise, 12 server-assistant, 10 connector, 5 analytics, 6 email/auth, 7 private-audio, 1 body-timeout, 1 process-entrypoint). They verify hashed storage, persistence after reopening, tenant isolation, revision conflicts, tombstones, transaction rollback, key exclusion, share rotation/revocation, multiple team memberships, assigned prompt/document ACLs, policy enforcement, usage/audit scope, account deletion and session/device revocation. No request handler is mocked.

The code is usable locally. OIDC/SCIM/Stripe adapters are implemented and tested through real local protocol-provider HTTP fixtures and SQLite. Live provider operation, public hosting, TLS/domain setup, live email delivery, large-audio desktop/iPhone integration and million-token retrieval scalability remain unverified. Email verification/recovery and local encrypted large recording storage are implemented and fixture-tested. Protocol fixture validation does not prove live provider registration, real payment processing or an enterprise compliance certification. Desktop/iOS GUI integrations have their own verification gates outside this package.
